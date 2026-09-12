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
            &root,
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
        let audit = String::from_utf8(
            std::fs::read(recovery.path().join(&artifact.relative_path)).unwrap(),
        )
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
            &root,
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
        let prepared = prepare_changes(&root, &operations).unwrap();
        std::fs::write(root.join("existing.txt"), "concurrent\n").unwrap();

        let error = execute_prepared(
            &root,
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
        let prepared = prepare_changes(&root, &operations).unwrap();
        std::fs::write(root.join("second.txt"), "concurrent\n").unwrap();

        let error = execute_prepared(
            &root,
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
            &root,
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
        assert!(restore_impl(&root, recovery.path(), "trash-1").is_err());
        std::fs::remove_file(root.join("trash.txt")).unwrap();
        restore_impl(&root, recovery.path(), "trash-1").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("trash.txt")).unwrap(),
            "recover me\n"
        );
        assert!(restore_impl(&root, recovery.path(), "trash-1").is_err());
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
            &root,
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

        restore_impl(&root, &recovery_base, "restore-interrupted").unwrap();
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
            &root,
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
        assert!(prepare_changes(&root, &overlaps).is_err());

        let stale = vec![WorkspaceChangeOperation::PatchFile {
            path: "dir/file.txt".into(),
            expected_sha256: "0".repeat(64),
            old_text: "text".into(),
            new_text: "updated".into(),
        }];
        assert!(prepare_changes(&root, &stale).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(root.join("dir/file.txt"), root.join("link.txt")).unwrap();
            let linked = vec![WorkspaceChangeOperation::Trash {
                path: "link.txt".into(),
                expected_sha256: Some(hash(&root.join("dir/file.txt"))),
            }];
            assert!(prepare_changes(&root, &linked).is_err());
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
                workspace: root.to_string_lossy().into_owned(),
                restored: false,
                changes: Vec::new(),
                trash: Vec::new(),
                audit_artifact: None,
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
            &root,
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

        assert!(restore_impl(&root, &recovery_base, "forged-restore").is_err());

        assert_eq!(
            std::fs::read_to_string(transaction.join("trash/007")).unwrap(),
            "recover me\n"
        );
        assert!(!root.join("trash.txt").exists());
    }
