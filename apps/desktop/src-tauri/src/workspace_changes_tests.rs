use super::*;
use tempfile::TempDir;

fn hash(path: &Path) -> String {
    sha256_bytes(&std::fs::read(path).unwrap())
}

fn root(directory: &TempDir) -> PathBuf {
    std::fs::canonicalize(directory.path()).unwrap()
}

fn incomplete_transaction(
    recovery_base: &Path,
    root: &Path,
    request_id: &str,
    actions: Vec<JournalAction>,
) -> PathBuf {
    let transaction = recovery_base
        .join(workspace_fingerprint(root))
        .join(request_id);
    std::fs::create_dir_all(transaction.join("backups")).unwrap();
    std::fs::create_dir(transaction.join("trash")).unwrap();
    write_transaction_journal(
        &transaction.join("transaction.json"),
        &TransactionJournal {
            version: TRANSACTION_VERSION,
            request_id: request_id.into(),
            unconfined: false,
            workspace: root.to_string_lossy().into_owned(),
            status: TransactionStatus::Applying,
            actions,
        },
        true,
    )
    .unwrap();
    transaction
}

#[test]
fn deserializes_the_camel_case_frontend_change_protocol() {
    let expected_sha256 = "a".repeat(64);
    let request: WorkspaceChangeRequest = serde_json::from_value(serde_json::json!({
        "requestId": "frontend-request",
        "operations": [
            {
                "type": "patch-file",
                "path": "existing.txt",
                "expectedSha256": expected_sha256,
                "oldText": "before",
                "newText": "after"
            },
            {
                "type": "trash",
                "path": "trash.txt",
                "expectedSha256": "b".repeat(64)
            }
        ]
    }))
    .unwrap();

    assert_eq!(request.request_id, "frontend-request");
    assert_eq!(request.operations.len(), 2);
    match &request.operations[0] {
        WorkspaceChangeOperation::PatchFile {
            expected_sha256,
            old_text,
            new_text,
            ..
        } => {
            assert_eq!(expected_sha256, &"a".repeat(64));
            assert_eq!(old_text, "before");
            assert_eq!(new_text, "after");
        }
        operation => panic!("expected patch-file, got {operation:?}"),
    }
    match &request.operations[1] {
        WorkspaceChangeOperation::Trash {
            expected_sha256, ..
        } => assert_eq!(expected_sha256.as_deref(), Some("b".repeat(64).as_str())),
        operation => panic!("expected trash, got {operation:?}"),
    }
}

#[test]
fn applies_multi_file_patch_and_creates_a_receipt() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    std::fs::write(root.join("one.txt"), "before one\n").unwrap();
    std::fs::write(root.join("two.txt"), "before two\n").unwrap();
    let result = apply_impl(
        MutationScope::workspace(&root),
        &recovery_base,
        recovery.path(),
        WorkspaceChangeRequest {
            request_id: "batch-1".into(),
            operations: vec![
                WorkspaceChangeOperation::PatchFile {
                    path: "one.txt".into(),
                    expected_sha256: hash(&root.join("one.txt")),
                    old_text: "before".into(),
                    new_text: "after".into(),
                },
                WorkspaceChangeOperation::PatchFile {
                    path: "two.txt".into(),
                    expected_sha256: hash(&root.join("two.txt")),
                    old_text: "before".into(),
                    new_text: "after".into(),
                },
            ],
        },
    )
    .unwrap();

    assert_eq!(result.changes.len(), 2);
    assert_eq!(
        std::fs::read_to_string(root.join("one.txt")).unwrap(),
        "after one\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("two.txt")).unwrap(),
        "after two\n"
    );
    assert!(recovery
        .path()
        .join("workspace-changes")
        .join(workspace_fingerprint(&root))
        .join("batch-1/receipt.json")
        .is_file());
    assert!(!recovery
        .path()
        .join("workspace-changes")
        .join(workspace_fingerprint(&root))
        .join("batch-1/transaction.json")
        .exists());
    let artifact = result.audit_artifact.unwrap();
    let audit =
        String::from_utf8(std::fs::read(recovery.path().join(&artifact.relative_path)).unwrap())
            .unwrap();
    assert!(audit.contains("# Axiom workspace change audit"));
    assert!(audit.contains("- before"));
    assert!(audit.contains("+ after"));
    assert!(!audit.contains("auditArtifact"));
    crate::artifacts::reconcile_at_time(
        recovery.path(),
        Vec::new(),
        SystemTime::now() + std::time::Duration::from_secs(6 * 60),
    )
    .unwrap();
    assert!(recovery.path().join(&artifact.relative_path).is_file());
}

#[test]
fn refuses_workspace_changes_when_the_audit_cannot_be_persisted() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let unavailable_app_data = recovery.path().join("not-a-directory");
    std::fs::write(&unavailable_app_data, "blocked").unwrap();

    let error = apply_impl(
        MutationScope::workspace(&root),
        recovery.path(),
        &unavailable_app_data,
        WorkspaceChangeRequest {
            request_id: "audit-failure".into(),
            operations: vec![WorkspaceChangeOperation::CreateFile {
                path: "created.txt".into(),
                content: "must not commit\n".into(),
            }],
        },
    )
    .unwrap_err();

    assert!(error.contains("failed to persist workspace audit before applying changes"));
    assert!(!root.join("created.txt").exists());
    assert!(!recovery
        .path()
        .join(workspace_fingerprint(&root))
        .join("audit-failure")
        .exists());
}

#[test]
fn rolls_back_earlier_changes_when_a_conflict_appears_after_preflight() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    std::fs::write(root.join("existing.txt"), "before\n").unwrap();
    let operations = vec![
        WorkspaceChangeOperation::CreateFile {
            path: "created.txt".into(),
            content: "created\n".into(),
        },
        WorkspaceChangeOperation::PatchFile {
            path: "existing.txt".into(),
            expected_sha256: hash(&root.join("existing.txt")),
            old_text: "before".into(),
            new_text: "after".into(),
        },
    ];
    let prepared = prepare_changes(MutationScope::workspace(&root), &operations).unwrap();
    std::fs::write(root.join("existing.txt"), "concurrent\n").unwrap();

    let error = execute_prepared(
        MutationScope::workspace(&root),
        recovery.path(),
        recovery.path(),
        "rollback-1",
        &operations,
        prepared,
    )
    .unwrap_err();
    assert!(error.contains("rolled back"));
    assert!(!root.join("created.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("existing.txt")).unwrap(),
        "concurrent\n"
    );
}

#[test]
fn rolls_back_prior_steps_without_removing_a_concurrent_create_destination() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let operations = vec![
        WorkspaceChangeOperation::CreateFile {
            path: "first.txt".into(),
            content: "first\n".into(),
        },
        WorkspaceChangeOperation::CreateFile {
            path: "second.txt".into(),
            content: "transaction\n".into(),
        },
    ];
    let prepared = prepare_changes(MutationScope::workspace(&root), &operations).unwrap();
    std::fs::write(root.join("second.txt"), "concurrent\n").unwrap();

    let error = execute_prepared(
        MutationScope::workspace(&root),
        recovery.path(),
        recovery.path(),
        "concurrent-create",
        &operations,
        prepared,
    )
    .unwrap_err();

    assert!(error.contains("rolled back"));
    assert!(!root.join("first.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("second.txt")).unwrap(),
        "concurrent\n"
    );
}

#[test]
fn trashes_and_restores_files_with_conflict_protection() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    std::fs::write(root.join("trash.txt"), "recover me\n").unwrap();
    let result = apply_impl(
        MutationScope::workspace(&root),
        recovery.path(),
        recovery.path(),
        WorkspaceChangeRequest {
            request_id: "trash-1".into(),
            operations: vec![WorkspaceChangeOperation::Trash {
                path: "trash.txt".into(),
                expected_sha256: Some(hash(&root.join("trash.txt"))),
            }],
        },
    )
    .unwrap();
    assert_eq!(result.recovery_id.as_deref(), Some("trash-1"));
    assert!(!root.join("trash.txt").exists());

    std::fs::write(root.join("trash.txt"), "conflict\n").unwrap();
    assert!(restore_impl(MutationScope::workspace(&root), recovery.path(), "trash-1").is_err());
    std::fs::remove_file(root.join("trash.txt")).unwrap();
    restore_impl(MutationScope::workspace(&root), recovery.path(), "trash-1").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("trash.txt")).unwrap(),
        "recover me\n"
    );
    assert!(restore_impl(MutationScope::workspace(&root), recovery.path(), "trash-1").is_err());
}

#[test]
fn standard_scope_cannot_restore_a_full_access_outside_workspace_batch() {
    let workspace = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let workspace_root = root(&workspace);
    let outside_root = root(&outside);
    let target = outside_root.join("outside.txt");
    std::fs::write(&target, "recover me\n").unwrap();

    let result = apply_impl(
        MutationScope::unrestricted(&workspace_root),
        recovery.path(),
        recovery.path(),
        WorkspaceChangeRequest {
            request_id: "outside-trash".into(),
            operations: vec![WorkspaceChangeOperation::Trash {
                path: target.to_string_lossy().into_owned(),
                expected_sha256: Some(hash(&target)),
            }],
        },
    )
    .unwrap();
    assert!(!target.exists());

    let error = restore_impl(
        MutationScope::workspace(&workspace_root),
        recovery.path(),
        result.recovery_id.as_deref().unwrap(),
    )
    .unwrap_err();
    assert!(error.contains("requires full access"));
    assert!(!target.exists());

    restore_impl(
        MutationScope::unrestricted(&workspace_root),
        recovery.path(),
        result.recovery_id.as_deref().unwrap(),
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(target).unwrap(), "recover me\n");
}

#[test]
fn trashes_and_restores_pen_documents_beyond_text_whitelist() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    // .pen 不在 TEXT_EXTENSIONS 白名单，但按 design_document_write_limit
    // 与写路径同口径放行 move/trash。
    let body = format!(
        "{{\"pages\":[{{\"name\":\"page\"}}]}}\n{}\n",
        "x".repeat(1024)
    );
    std::fs::create_dir_all(root.join(".pen")).unwrap();
    std::fs::write(root.join(".pen/axiom.pen"), &body).unwrap();
    // 任意大小都不受白名单限制；这里 1KiB 足以验证判定逻辑本身。
    let result = apply_impl(
        MutationScope::workspace(&root),
        recovery.path(),
        recovery.path(),
        WorkspaceChangeRequest {
            request_id: "trash-pen".into(),
            operations: vec![WorkspaceChangeOperation::Trash {
                path: ".pen/axiom.pen".into(),
                expected_sha256: Some(hash(&root.join(".pen/axiom.pen"))),
            }],
        },
    )
    .unwrap();
    assert!(!root.join(".pen/axiom.pen").exists());
    std::fs::write(root.join(".pen/axiom.pen"), "conflict\n").unwrap();
    std::fs::remove_file(root.join(".pen/axiom.pen")).unwrap();
    restore_impl(
        MutationScope::workspace(&root),
        recovery.path(),
        result.recovery_id.as_deref().unwrap(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join(".pen/axiom.pen")).unwrap(),
        body
    );
}

#[test]
fn pen_is_import_only_across_batch_writes_and_moves() {
    let workspace = TempDir::new().unwrap();
    let root = root(&workspace);
    std::fs::write(root.join("legacy.pen"), r#"{"children":[]}"#).unwrap();
    std::fs::write(root.join("notes.txt"), "notes").unwrap();
    std::fs::write(root.join("design.ax"), r#"{"ax":"1.0","pages":[]}"#).unwrap();

    for operation in [
        WorkspaceChangeOperation::CreateFile {
            path: "created.pen".into(),
            content: "{}".into(),
        },
        WorkspaceChangeOperation::PatchFile {
            path: "legacy.pen".into(),
            expected_sha256: hash(&root.join("legacy.pen")),
            old_text: "children".into(),
            new_text: "pages".into(),
        },
        WorkspaceChangeOperation::Move {
            from: "notes.txt".into(),
            to: "renamed.pen".into(),
            expected_sha256: Some(hash(&root.join("notes.txt"))),
        },
        WorkspaceChangeOperation::Move {
            from: "legacy.pen".into(),
            to: "renamed.ax".into(),
            expected_sha256: Some(hash(&root.join("legacy.pen"))),
        },
        WorkspaceChangeOperation::Move {
            from: "design.ax".into(),
            to: "downgraded.pen".into(),
            expected_sha256: Some(hash(&root.join("design.ax"))),
        },
    ] {
        assert!(prepare_changes(MutationScope::workspace(&root), &[operation]).is_err());
    }

    assert!(prepare_changes(
        MutationScope::workspace(&root),
        &[WorkspaceChangeOperation::Move {
            from: "legacy.pen".into(),
            to: "archive.pen".into(),
            expected_sha256: Some(hash(&root.join("legacy.pen"))),
        }],
    )
    .is_ok());
}

#[test]
fn startup_rolls_back_an_interrupted_multi_path_trash_restore() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    std::fs::write(root.join("first.txt"), "first\n").unwrap();
    std::fs::write(root.join("second.txt"), "second\n").unwrap();
    let first_hash = hash(&root.join("first.txt"));
    let second_hash = hash(&root.join("second.txt"));
    apply_impl(
        MutationScope::workspace(&root),
        &recovery_base,
        recovery.path(),
        WorkspaceChangeRequest {
            request_id: "restore-interrupted".into(),
            operations: vec![
                WorkspaceChangeOperation::Trash {
                    path: "first.txt".into(),
                    expected_sha256: Some(first_hash.clone()),
                },
                WorkspaceChangeOperation::Trash {
                    path: "second.txt".into(),
                    expected_sha256: Some(second_hash),
                },
            ],
        },
    )
    .unwrap();
    let transaction = recovery_base
        .join(workspace_fingerprint(&root))
        .join("restore-interrupted");
    write_restore_journal(
        &transaction.join("restore.json"),
        &RestoreJournal {
            version: RESTORE_VERSION,
            request_id: "restore-interrupted".into(),
            unconfined: false,
            workspace: root.to_string_lossy().into_owned(),
            status: RestoreStatus::Restoring,
            actions: vec![RestoreAction {
                original_path: "first.txt".into(),
                stored_name: "0".into(),
                identity: SourceIdentity::TextFile(first_hash),
            }],
        },
        true,
    )
    .unwrap();
    rename_noclobber(&transaction.join("trash/0"), &root.join("first.txt")).unwrap();

    recover_workspace_change_transactions_at(&recovery_base).unwrap();

    assert!(!root.join("first.txt").exists());
    assert!(!root.join("second.txt").exists());
    assert_eq!(
        std::fs::read_to_string(transaction.join("trash/0")).unwrap(),
        "first\n"
    );
    assert_eq!(
        std::fs::read_to_string(transaction.join("trash/1")).unwrap(),
        "second\n"
    );
    assert!(!transaction.join("restore.json").exists());

    restore_impl(
        MutationScope::workspace(&root),
        &recovery_base,
        "restore-interrupted",
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("first.txt")).unwrap(),
        "first\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("second.txt")).unwrap(),
        "second\n"
    );
}

#[test]
fn restored_receipt_wins_over_an_unremoved_restore_journal() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    std::fs::write(root.join("restored.txt"), "restored\n").unwrap();
    let restored_hash = hash(&root.join("restored.txt"));
    apply_impl(
        MutationScope::workspace(&root),
        &recovery_base,
        recovery.path(),
        WorkspaceChangeRequest {
            request_id: "restore-committed".into(),
            operations: vec![WorkspaceChangeOperation::Trash {
                path: "restored.txt".into(),
                expected_sha256: Some(restored_hash.clone()),
            }],
        },
    )
    .unwrap();
    let transaction = recovery_base
        .join(workspace_fingerprint(&root))
        .join("restore-committed");
    write_restore_journal(
        &transaction.join("restore.json"),
        &RestoreJournal {
            version: RESTORE_VERSION,
            request_id: "restore-committed".into(),
            unconfined: false,
            workspace: root.to_string_lossy().into_owned(),
            status: RestoreStatus::Restoring,
            actions: vec![RestoreAction {
                original_path: "restored.txt".into(),
                stored_name: "0".into(),
                identity: SourceIdentity::TextFile(restored_hash),
            }],
        },
        true,
    )
    .unwrap();
    rename_noclobber(&transaction.join("trash/0"), &root.join("restored.txt")).unwrap();
    let receipt_path = transaction.join("receipt.json");
    let mut receipt = read_receipt(&receipt_path).unwrap();
    receipt.restored = true;
    let replacement = serde_json::to_vec_pretty(&receipt).unwrap();
    write_atomic(&receipt_path, &replacement, None, false).unwrap();
    sync_parent(&receipt_path).unwrap();

    recover_workspace_change_transactions_at(&recovery_base).unwrap();

    assert_eq!(
        std::fs::read_to_string(root.join("restored.txt")).unwrap(),
        "restored\n"
    );
    assert!(!transaction.join("restore.json").exists());
    assert!(!transaction.join("trash").exists());
}

#[test]
fn rejects_overlaps_symlinks_and_stale_hashes() {
    let workspace = TempDir::new().unwrap();
    let root = root(&workspace);
    std::fs::create_dir(root.join("dir")).unwrap();
    std::fs::write(root.join("dir/file.txt"), "text\n").unwrap();
    let overlaps = vec![
        WorkspaceChangeOperation::Trash {
            path: "dir".into(),
            expected_sha256: None,
        },
        WorkspaceChangeOperation::PatchFile {
            path: "dir/file.txt".into(),
            expected_sha256: hash(&root.join("dir/file.txt")),
            old_text: "text".into(),
            new_text: "updated".into(),
        },
    ];
    assert!(prepare_changes(MutationScope::workspace(&root), &overlaps).is_err());

    let stale = vec![WorkspaceChangeOperation::PatchFile {
        path: "dir/file.txt".into(),
        expected_sha256: "0".repeat(64),
        old_text: "text".into(),
        new_text: "updated".into(),
    }];
    assert!(prepare_changes(MutationScope::workspace(&root), &stale).is_err());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(root.join("dir/file.txt"), root.join("link.txt")).unwrap();
        let linked = vec![WorkspaceChangeOperation::Trash {
            path: "link.txt".into(),
            expected_sha256: Some(hash(&root.join("dir/file.txt"))),
        }];
        assert!(prepare_changes(MutationScope::workspace(&root), &linked).is_err());
    }
}

#[test]
fn recovers_every_incomplete_workspace_action_in_reverse_order() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    let original = b"original\n";
    let updated = b"updated\n";
    let moved = b"moved\n";
    let trashed = b"trashed\n";
    std::fs::write(root.join("created.txt"), "created\n").unwrap();
    std::fs::write(root.join("patched.txt"), updated).unwrap();
    std::fs::create_dir(root.join("created-directory")).unwrap();
    std::fs::write(root.join("moved-to.txt"), moved).unwrap();
    let transaction = incomplete_transaction(
        &recovery_base,
        &root,
        "incomplete-all",
        vec![
            JournalAction::RemoveFile {
                path: "created.txt".into(),
                created_sha256: sha256_bytes(b"created\n"),
            },
            JournalAction::RestoreFile {
                path: "patched.txt".into(),
                backup_name: "1.original".into(),
                original_sha256: sha256_bytes(original),
                updated_sha256: sha256_bytes(updated),
            },
            JournalAction::RemoveDirectory {
                path: "created-directory".into(),
            },
            JournalAction::Move {
                source: "moved-from.txt".into(),
                destination: "moved-to.txt".into(),
                identity: SourceIdentity::TextFile(sha256_bytes(moved)),
            },
            JournalAction::Trash {
                source: "trashed.txt".into(),
                stored_name: "4".into(),
                identity: SourceIdentity::TextFile(sha256_bytes(trashed)),
            },
        ],
    );
    std::fs::write(transaction.join("backups/1.original"), original).unwrap();
    std::fs::write(transaction.join("trash/4"), trashed).unwrap();

    recover_workspace_change_transactions_at(&recovery_base).unwrap();

    assert!(!root.join("created.txt").exists());
    assert_eq!(std::fs::read(root.join("patched.txt")).unwrap(), original);
    assert!(!root.join("created-directory").exists());
    assert_eq!(std::fs::read(root.join("moved-from.txt")).unwrap(), moved);
    assert!(!root.join("moved-to.txt").exists());
    assert_eq!(std::fs::read(root.join("trashed.txt")).unwrap(), trashed);
    assert!(!transaction.exists());
}

#[test]
fn incomplete_workspace_recovery_refuses_to_overwrite_later_changes() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    std::fs::write(root.join("created.txt"), "later user change\n").unwrap();
    let transaction = incomplete_transaction(
        &recovery_base,
        &root,
        "incomplete-conflict",
        vec![JournalAction::RemoveFile {
            path: "created.txt".into(),
            created_sha256: sha256_bytes(b"transaction content\n"),
        }],
    );

    let error = recover_workspace_change_transactions_at(&recovery_base).unwrap_err();

    assert!(error.message.contains("created file changed"));
    assert_eq!(error.workspace.as_deref(), Some(root.to_str().unwrap()));
    assert_eq!(error.recovery_id.as_deref(), Some("incomplete-conflict"));
    assert_eq!(
        error.recovery_path.as_deref(),
        Some(transaction.to_str().unwrap())
    );
    assert_eq!(
        std::fs::read_to_string(root.join("created.txt")).unwrap(),
        "later user change\n"
    );
    assert!(transaction.join("transaction.json").is_file());

    std::fs::rename(root.join("created.txt"), root.join("preserved.txt")).unwrap();
    recover_workspace_change_transactions_at(&recovery_base).unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("preserved.txt")).unwrap(),
        "later user change\n"
    );
    assert!(!transaction.exists());
}

#[test]
fn incomplete_recovery_rolls_back_independent_steps_before_reporting_conflicts() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    std::fs::write(root.join("earlier.txt"), "earlier\n").unwrap();
    std::fs::write(root.join("conflict.txt"), "later user change\n").unwrap();
    let transaction = incomplete_transaction(
        &recovery_base,
        &root,
        "incomplete-partial-conflict",
        vec![
            JournalAction::RemoveFile {
                path: "earlier.txt".into(),
                created_sha256: sha256_bytes(b"earlier\n"),
            },
            JournalAction::RemoveFile {
                path: "conflict.txt".into(),
                created_sha256: sha256_bytes(b"transaction content\n"),
            },
        ],
    );

    let error = recover_workspace_change_transactions_at(&recovery_base).unwrap_err();

    assert!(error.message.contains("created file changed"));
    assert!(!root.join("earlier.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("conflict.txt")).unwrap(),
        "later user change\n"
    );
    assert!(transaction.join("transaction.json").is_file());
}

#[test]
fn committed_receipt_wins_over_an_unremoved_transaction_journal() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    std::fs::write(root.join("committed.txt"), "committed\n").unwrap();
    let transaction = incomplete_transaction(
        &recovery_base,
        &root,
        "committed-request",
        vec![JournalAction::RemoveFile {
            path: "committed.txt".into(),
            created_sha256: sha256_bytes(b"committed\n"),
        }],
    );
    write_receipt(
        &transaction.join("receipt.json"),
        &ChangeReceipt {
            version: RECEIPT_VERSION,
            request_id: "committed-request".into(),
            unconfined: false,
            workspace: root.to_string_lossy().into_owned(),
            restored: false,
            changes: Vec::new(),
            trash: Vec::new(),
            audit_artifact: None,
            history_moves: Vec::new(),
        },
    )
    .unwrap();

    recover_workspace_change_transactions_at(&recovery_base).unwrap();

    assert_eq!(
        std::fs::read_to_string(root.join("committed.txt")).unwrap(),
        "committed\n"
    );
    assert!(transaction.join("receipt.json").is_file());
    assert!(!transaction.join("transaction.json").exists());
    assert!(!transaction.join("backups").exists());
}

#[test]
fn startup_cleans_only_known_initializers_and_rejects_markerless_transactions() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    let workspace_group = recovery_base.join(workspace_fingerprint(&root));
    let initializing = workspace_group.join(".initializing-stale");
    std::fs::create_dir_all(initializing.join("backups")).unwrap();
    std::fs::create_dir(initializing.join("trash")).unwrap();

    recover_workspace_change_transactions_at(&recovery_base).unwrap();
    assert!(!initializing.exists());

    let markerless = workspace_group.join("markerless-request");
    std::fs::create_dir_all(markerless.join("backups")).unwrap();
    std::fs::create_dir(markerless.join("trash")).unwrap();
    let error = recover_workspace_change_transactions_at(&recovery_base).unwrap_err();
    assert!(error.message.contains("missing its receipt"));
    assert!(markerless.exists());
}

#[test]
fn validate_trash_name_accepts_only_canonical_indices() {
    assert!(validate_trash_name("0").is_ok());
    assert!(validate_trash_name("31").is_ok());
    for invalid in ["", "007", "-1", "1/2", "..", "1 ", "1.txt"] {
        assert!(
            validate_trash_name(invalid).is_err(),
            "expected {invalid:?} to be rejected"
        );
    }
}

#[test]
fn restore_rejects_a_non_canonical_trash_material_name() {
    let workspace = TempDir::new().unwrap();
    let recovery = TempDir::new().unwrap();
    let root = root(&workspace);
    let recovery_base = recovery.path().join("workspace-changes");
    std::fs::write(root.join("trash.txt"), "recover me\n").unwrap();
    apply_impl(
        MutationScope::workspace(&root),
        &recovery_base,
        recovery.path(),
        WorkspaceChangeRequest {
            request_id: "forged-restore".into(),
            operations: vec![WorkspaceChangeOperation::Trash {
                path: "trash.txt".into(),
                expected_sha256: Some(hash(&root.join("trash.txt"))),
            }],
        },
    )
    .unwrap();
    let transaction = recovery_base
        .join(workspace_fingerprint(&root))
        .join("forged-restore");
    std::fs::rename(transaction.join("trash/0"), transaction.join("trash/007")).unwrap();
    let receipt_path = transaction.join("receipt.json");
    let mut receipt = read_receipt(&receipt_path).unwrap();
    receipt.trash[0].stored_name = "007".into();
    std::fs::remove_file(&receipt_path).unwrap();
    write_receipt(&receipt_path, &receipt).unwrap();

    assert!(restore_impl(
        MutationScope::workspace(&root),
        &recovery_base,
        "forged-restore"
    )
    .is_err());

    assert_eq!(
        std::fs::read_to_string(transaction.join("trash/007")).unwrap(),
        "recover me\n"
    );
    assert!(!root.join("trash.txt").exists());
}

#[test]
fn design_batch_patch_saves_previous_version() {
    let workspace = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let root = root(&workspace);
    let file = root.join("draft.ax");
    let before = r#"{"ax":"1.0","pages":[{"id":"before"}]}"#;
    std::fs::write(&file, before).unwrap();
    apply_impl(
        MutationScope::workspace(&root),
        &data.path().join("workspace-changes"),
        data.path(),
        WorkspaceChangeRequest {
            request_id: "design-history".into(),
            operations: vec![WorkspaceChangeOperation::PatchFile {
                path: "draft.ax".into(),
                expected_sha256: hash(&file),
                old_text: "before".into(),
                new_text: "after".into(),
            }],
        },
    )
    .unwrap();
    let history = crate::design_history::directory(data.path(), &root, &file);
    let versions = crate::design_history::list(&history).unwrap();
    assert_eq!(
        crate::design_history::read(&history, &versions[0].sha256).unwrap(),
        before.as_bytes()
    );
}

#[test]
fn design_file_and_directory_moves_preserve_previous_versions() {
    for is_directory in [false, true] {
        let workspace = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        let root = root(&workspace);
        std::fs::create_dir_all(root.join("draft/nested")).unwrap();
        let (from, to, source, destination) = if is_directory {
            (
                "draft",
                "published",
                root.join("draft/nested/design.ax"),
                root.join("published/nested/design.ax"),
            )
        } else {
            (
                "draft.ax",
                "published.ax",
                root.join("draft.ax"),
                root.join("published.ax"),
            )
        };
        let before = br#"{"ax":"1.0","pages":[{"id":"before"}]}"#;
        let current = br#"{"ax":"1.0","pages":[{"id":"current"}]}"#;
        std::fs::write(&source, current).unwrap();
        crate::design_history::backup(data.path(), &root, &source, before).unwrap();
        let result = apply_impl(
            MutationScope::workspace(&root),
            &data.path().join("workspace-changes"),
            data.path(),
            WorkspaceChangeRequest {
                request_id: "design-move".into(),
                operations: vec![WorkspaceChangeOperation::Move {
                    from: from.into(),
                    to: to.into(),
                    expected_sha256: if is_directory {
                        None
                    } else {
                        Some(hash(&source))
                    },
                }],
            },
        )
        .unwrap();
        assert!(result.history_warning.is_none());
        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), current);
        let versions = crate::design_history::list(&crate::design_history::directory(
            data.path(),
            &root,
            &destination,
        ))
        .unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].sha256, sha256_bytes(current));
        assert_eq!(versions[1].sha256, sha256_bytes(before));
    }
}

#[test]
fn rolled_back_design_moves_do_not_transfer_history_to_destination() {
    let workspace = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let root = root(&workspace);
    std::fs::write(root.join("draft.ax"), br#"{"ax":"1.0","pages":[]}"#).unwrap();
    std::fs::write(root.join("existing.txt"), "before").unwrap();
    let operations = vec![
        WorkspaceChangeOperation::Move {
            from: "draft.ax".into(),
            to: "published.ax".into(),
            expected_sha256: Some(hash(&root.join("draft.ax"))),
        },
        WorkspaceChangeOperation::PatchFile {
            path: "existing.txt".into(),
            expected_sha256: hash(&root.join("existing.txt")),
            old_text: "before".into(),
            new_text: "after".into(),
        },
    ];
    let prepared = prepare_changes(MutationScope::workspace(&root), &operations).unwrap();
    std::fs::write(root.join("existing.txt"), "concurrent").unwrap();
    let error = execute_prepared(
        MutationScope::workspace(&root),
        &data.path().join("workspace-changes"),
        data.path(),
        "design-rollback",
        &operations,
        prepared,
    )
    .unwrap_err();
    assert!(error.contains("rolled back"));
    assert!(root.join("draft.ax").exists());
    assert!(!root.join("published.ax").exists());
    assert!(
        crate::design_history::list(&crate::design_history::directory(
            data.path(),
            &root,
            &root.join("published.ax")
        ))
        .unwrap()
        .is_empty()
    );
}

#[test]
fn committed_design_moves_retry_history_transfer_after_restart() {
    let workspace = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let root = root(&workspace);
    let source = root.join("draft.ax");
    let destination = root.join("published.ax");
    let current = br#"{"ax":"1.0","pages":[]}"#;
    std::fs::write(&source, current).unwrap();
    let destination_history = crate::design_history::directory(data.path(), &root, &destination);
    std::fs::create_dir_all(destination_history.parent().unwrap()).unwrap();
    std::fs::write(&destination_history, "blocked").unwrap();
    let recovery_base = data.path().join("workspace-changes");
    let result = apply_impl(
        MutationScope::workspace(&root),
        &recovery_base,
        data.path(),
        WorkspaceChangeRequest {
            request_id: "design-retry".into(),
            operations: vec![WorkspaceChangeOperation::Move {
                from: "draft.ax".into(),
                to: "published.ax".into(),
                expected_sha256: Some(hash(&root.join("draft.ax"))),
            }],
        },
    )
    .unwrap();
    assert!(result.history_warning.unwrap().contains("committed"));
    assert_eq!(std::fs::read(&destination).unwrap(), current);
    std::fs::remove_file(&destination_history).unwrap();
    std::fs::remove_dir_all(crate::design_history::directory(
        data.path(),
        &root,
        &source,
    ))
    .unwrap();
    recover_workspace_change_transactions_at(&recovery_base).unwrap();
    assert_eq!(
        crate::design_history::list(&destination_history).unwrap()[0].sha256,
        sha256_bytes(current)
    );
    recover_workspace_change_transactions_at(&recovery_base).unwrap();
    let receipt = read_receipt(
        &recovery_base
            .join(workspace_fingerprint(&root))
            .join("design-retry/receipt.json"),
    )
    .unwrap();
    assert!(receipt.history_moves.is_empty());
}

#[test]
fn protected_sources_destinations_and_recovery_paths_are_rejected_before_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::create_dir_all(home.join(".config/git")).unwrap();
    std::fs::write(home.join(".ssh/key.txt"), "credential-stub").unwrap();
    std::fs::write(home.join(".config/git/credentials"), "git-stub").unwrap();
    std::fs::write(home.join("main.txt"), "normal").unwrap();
    let root = std::fs::canonicalize(home).unwrap();
    let policy = crate::sandbox::SensitivePathPolicy::new(&root, std::slice::from_ref(&root));
    for path in [".ssh/key.txt", ".config", ".config/git"] {
        assert!(
            resolve_existing_path_with_policy(MutationScope::workspace(&root), path, &policy)
                .is_err()
        );
        assert!(
            resolve_recovery_path_with_policy(MutationScope::workspace(&root), path, &policy)
                .is_err()
        );
    }
    assert!(resolve_new_path_with_policy(
        MutationScope::workspace(&root),
        ".ssh/exposed.txt",
        &policy
    )
    .is_err());
    assert!(resolve_recovery_path_with_policy(
        MutationScope::workspace(&root),
        ".ssh/exposed.txt",
        &policy
    )
    .is_err());
    assert!(resolve_existing_path_with_policy(
        MutationScope::workspace(&root),
        "main.txt",
        &policy
    )
    .is_ok());
    assert!(
        resolve_new_path_with_policy(MutationScope::workspace(&root), "renamed.txt", &policy)
            .is_ok()
    );
    assert!(resolve_recovery_path_with_policy(
        MutationScope::workspace(&root),
        "renamed.txt",
        &policy
    )
    .is_ok());
    assert_eq!(
        std::fs::read(root.join(".ssh/key.txt")).unwrap(),
        b"credential-stub"
    );
    assert!(!root.join("renamed.txt").exists());
}

#[test]
fn unrestricted_scope_allows_outside_paths_but_still_refuses_protected_ones() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(home.join(".ssh/key.txt"), "credential-stub").unwrap();
    let root = std::fs::canonicalize(&home).unwrap();
    let outside = std::fs::canonicalize(&outside).unwrap();
    let policy = crate::sandbox::SensitivePathPolicy::new(&root, std::slice::from_ref(&root));
    let scope = MutationScope::unrestricted(&root);
    let created = outside.join("created.txt");

    // 完全访问：工作区外的绝对路径不再受包含限制。
    let (target, _, display) =
        resolve_new_path_with_policy(scope, created.to_str().unwrap(), &policy).unwrap();
    assert_eq!(target, created);
    assert_eq!(display, created.to_string_lossy());

    // 标准模式仍拒绝同一路径。
    assert!(resolve_new_path_with_policy(
        MutationScope::workspace(&root),
        created.to_str().unwrap(),
        &policy
    )
    .is_err());

    // 保护路径（凭据载体）在完全访问下同样被拒，且拒绝的是祖先与自身。
    assert!(resolve_existing_path_with_policy(
        scope,
        home.join(".ssh/key.txt").to_str().unwrap(),
        &policy
    )
    .is_err());
    assert!(resolve_new_path_with_policy(
        scope,
        home.join(".ssh/added.txt").to_str().unwrap(),
        &policy
    )
    .is_err());
    assert!(
        resolve_new_path_with_policy(scope, home.join(".ssh").to_str().unwrap(), &policy).is_err()
    );

    // 事务记录的作用域重建：缺省（旧事务）为工作区作用域。
    assert!(MutationScope::from_record(&root, false).confined);
    assert!(!MutationScope::from_record(&root, true).confined);
}
