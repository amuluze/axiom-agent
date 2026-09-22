    use super::*;
    use sqlx::{Either, Statement};
    use tempfile::TempDir;

    async fn migrated_database() -> (TempDir, SqliteConnection) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("axiom.db");
        let mut connection = SqliteConnection::connect_with(&create_options(&path))
            .await
            .unwrap();
        migrate(&mut connection).await.unwrap();
        (directory, connection)
    }

    async fn seed_session_graph(connection: &mut SqliteConnection) {
        for statement in [
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('session-1', 'Original', 'system', 'test', 'model', 'running', 1, 1)",
            "INSERT INTO agent_runs (id, session_id, status, started_at)
             VALUES ('run-1', 'session-1', 'running', 1)",
            "INSERT INTO artifacts
             (id, kind, media_type, relative_path, content_hash, size_bytes, created_at)
             VALUES ('artifact-1', 'text', 'text/plain', 'artifacts/1', 'hash-1', 10, 1)",
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at, artifact_id)
             VALUES ('message-1', 'session-1', 'run-1', 1, 'tool', '{}', 1, 'artifact-1')",
            "INSERT INTO tool_executions
             (run_id, tool_call_id, tool_name, arguments_json, status, approval_state,
              started_at, artifact_id)
             VALUES ('run-1', 'tool-1', 'read', '{}', 'running', 'not_required', 1, 'artifact-1')",
            "INSERT INTO context_checkpoints
             (id, session_id, through_message_id, summary, summary_hash, reason,
              tokens_before, estimated_tokens_after, request_bytes_before, request_bytes_after,
              model_provider, model_id, prompt_version, excluded_message_ids_json, facts_json, created_at)
             VALUES ('checkpoint-1', 'session-1', 'message-1', 'summary', 'hash', 'manual',
                     10, 5, 100, 50, 'test', 'model', 1, '[]', '{}', 1)",
            "INSERT INTO runtime_mutation_batches
             (id, session_id, run_id, turn, event_count, created_at, committed_at)
             VALUES ('batch-1', 'session-1', 'run-1', 1, 1, 1, 1)",
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status, created_at)
             VALUES ('journal-1', 'session-1', 0, 'queue', 'steering', '{}', 'pending', 1)",
            "INSERT INTO provider_requests
             (id, session_id, run_id, assistant_message_id, model_provider, model_id,
              message_count, tool_count, status, started_at)
             VALUES ('provider-1', 'session-1', 'run-1', 'assistant-1', 'test', 'model',
                     1, 1, 'running', 1)",
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at,
              parent_session_id, forked_from_message_id)
             VALUES ('session-child', 'Child', 'system', 'test', 'model', 'idle', 1, 1,
                     'session-1', 'message-1')",
        ] {
            connection.execute(statement).await.unwrap();
        }
    }

    async fn session_fact_count(connection: &mut SqliteConnection, table: &str) -> i64 {
        let statement = match table {
            "agent_runs"
            | "agent_messages"
            | "context_checkpoints"
            | "runtime_mutation_batches"
            | "agent_session_journal"
            | "provider_requests" => {
                format!("SELECT COUNT(*) FROM {table} WHERE session_id = 'session-1'")
            }
            "tool_executions" => {
                "SELECT COUNT(*) FROM tool_executions WHERE run_id = 'run-1'".into()
            }
            _ => panic!("unsupported test table"),
        };
        sqlx::query_scalar(&statement)
            .fetch_one(connection)
            .await
            .unwrap()
    }

    async fn seed_branch_source(connection: &mut SqliteConnection) {
        for statement in [
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('branch-source', 'Source', 'system', 'test', 'model', 'idle', 1, 1)",
            "INSERT INTO agent_messages
             (id, session_id, sequence, role, content_json, created_at)
             VALUES ('source-1', 'branch-source', 1, 'user',
                     '{\"id\":\"source-1\",\"role\":\"user\",\"content\":\"one\",\"createdAt\":1}', 1)",
            "INSERT INTO agent_messages
             (id, session_id, sequence, role, content_json, created_at)
             VALUES ('source-2', 'branch-source', 2, 'assistant',
                     '{\"id\":\"source-2\",\"role\":\"assistant\",\"content\":\"two\",\"toolCalls\":[],\"stopReason\":\"end_turn\",\"createdAt\":2}', 2)",
        ] {
            connection.execute(statement).await.unwrap();
        }
    }

    async fn seed_settlement(connection: &mut SqliteConnection, with_checkpoint: bool) {
        for statement in [
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('settle-session', 'Settle', 'system', 'test', 'model', 'running', 1, 1)",
            "INSERT INTO agent_runs
             (id, session_id, status, end_reason, started_at, ended_at)
             VALUES ('settle-run', 'settle-session', 'completed', 'completed', 1, 2)",
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at)
             VALUES ('settle-message-1', 'settle-session', 'settle-run', 1, 'user', '{}', 1)",
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at)
             VALUES ('settle-message-2', 'settle-session', 'settle-run', 2, 'assistant', '{}', 2)",
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status, created_at)
             VALUES ('settle-pending', 'settle-session', 0, 'queue', 'steering', '{}', 'pending', 1)",
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status, created_at)
             VALUES ('settle-applied', 'settle-session', 1, 'queue', 'follow-up', '{}', 'applied', 1)",
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status, created_at)
             VALUES ('settle-discarded', 'settle-session', 2, 'queue', 'next-turn', '{}', 'discarded', 1)",
        ] {
            connection.execute(statement).await.unwrap();
        }
        if with_checkpoint {
            connection
                .execute(
                    "INSERT INTO context_checkpoints
                     (id, session_id, through_message_id, summary, summary_hash, reason,
                      tokens_before, estimated_tokens_after, request_bytes_before, request_bytes_after,
                      model_provider, model_id, prompt_version, excluded_message_ids_json, facts_json, created_at)
                     VALUES ('settle-checkpoint', 'settle-session', 'settle-message-2',
                             'summary', 'hash', 'manual', 10, 5, 100, 50,
                             'test', 'model', 1, '[]', '{}', 2)",
                )
                .await
                .unwrap();
        }
    }

    fn settlement_request(with_checkpoint: bool) -> SettleSessionRunRequest {
        SettleSessionRunRequest {
            session_id: "settle-session".into(),
            run_id: "settle-run".into(),
            message_count: 2,
            last_message_id: Some("settle-message-2".into()),
            checkpoint_id: with_checkpoint.then(|| "settle-checkpoint".into()),
            now: 42,
        }
    }

    fn turn_save_point_request() -> SaveSessionTurnPointRequest {
        SaveSessionTurnPointRequest {
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            turn: 1,
            mutation_batch_ids: vec!["batch-1".into()],
            had_pending_mutations: true,
            message_count: 1,
            last_message_id: Some("message-1".into()),
            checkpoint_id: Some("checkpoint-1".into()),
            created_at: 42,
        }
    }

    fn branch_request() -> CreateSessionBranchRequest {
        CreateSessionBranchRequest {
            id: "branch-created".into(),
            title: "Source · 分支".into(),
            system_prompt: "system".into(),
            model_provider: "test".into(),
            model_id: "model".into(),
            reasoning_json: None,
            active_tool_names_json: "[]".into(),
            provider_config_json: None,
            runtime_manifest_json: None,
            source_session_id: "branch-source".into(),
            through_message_id: "source-2".into(),
            kind: "branch".into(),
            retried_message_id: None,
            workspace_path: None,
            workspace_name: None,
            created_at: 10,
            activated_at: 11,
            messages: vec![
                SessionBranchMessageRequest {
                    id: "copy-1".into(),
                    role: "user".into(),
                    content_json:
                        "{\"id\":\"copy-1\",\"role\":\"user\",\"content\":\"one\",\"createdAt\":1}"
                            .into(),
                    created_at: 1,
                    source_message_id: Some("source-1".into()),
                    artifact_id: None,
                },
                SessionBranchMessageRequest {
                    id: "copy-2".into(),
                    role: "assistant".into(),
                    content_json: "{\"id\":\"copy-2\",\"role\":\"assistant\",\"content\":\"two\",\"toolCalls\":[],\"stopReason\":\"end_turn\",\"createdAt\":2}".into(),
                    created_at: 2,
                    source_message_id: Some("source-2".into()),
                    artifact_id: None,
                },
            ],
        }
    }

    fn summary_branch_request() -> CreateSessionBranchRequest {
        let mut request = branch_request();
        request.through_message_id = "source-1".into();
        request.messages.truncate(1);
        request.messages.push(SessionBranchMessageRequest {
            id: "summary-1".into(),
            role: "custom".into(),
            content_json: "{\"id\":\"summary-1\",\"role\":\"custom\",\"customType\":\"branch-summary\",\"content\":\"summary\",\"data\":{\"version\":1,\"sourceFromMessageId\":\"source-2\",\"sourceThroughMessageId\":\"source-2\",\"readFiles\":[],\"modifiedFiles\":[]},\"createdAt\":10}".into(),
            created_at: 10,
            source_message_id: None,
            artifact_id: None,
        });
        request
    }

    async fn seed_running_message_session(connection: &mut SqliteConnection) {
        for statement in [
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('message-session', '新会话', 'system', 'test', 'model', 'running', 1, 1)",
            "INSERT INTO agent_runs (id, session_id, status, started_at)
             VALUES ('message-run', 'message-session', 'running', 1)",
        ] {
            connection.execute(statement).await.unwrap();
        }
    }

    #[tokio::test]
    async fn collects_message_artifact_hashes_across_sessions() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;
        // 第二个会话也引用 artifact-1（去重）并新增 artifact-2（跨会话收集）
        connection
            .execute(
                "INSERT INTO agent_sessions
                 (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
                 VALUES ('session-2', 'Second', 'system', 'test', 'model', 'idle', 2, 2)",
            )
            .await
            .unwrap();
        connection
            .execute("INSERT INTO agent_runs (id, session_id, status, started_at) VALUES ('run-2', 'session-2', 'running', 2)")
            .await
            .unwrap();
        connection
            .execute(
                "INSERT INTO artifacts
                 (id, kind, media_type, relative_path, content_hash, size_bytes, created_at)
                 VALUES ('artifact-2', 'text', 'text/plain', 'artifacts/2', 'hash-2', 20, 2)",
            )
            .await
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_messages
                 (id, session_id, run_id, sequence, role, content_json, created_at, artifact_id)
                 VALUES ('message-2', 'session-2', 'run-2', 1, 'tool', '{}', 2, 'artifact-1'),
                        ('message-3', 'session-2', 'run-2', 2, 'tool', '{}', 2, 'artifact-2')",
            )
            .await
            .unwrap();
        let mut hashes = super::commands::collect_message_artifact_hashes(&mut connection)
            .await
            .unwrap();
        hashes.sort();
        assert_eq!(hashes, vec!["artifact-1".to_string(), "artifact-2".to_string()]);
    }

    fn session_message_request(
        message_id: &str,
        role: &str,
        content_json: String,
        created_at: i64,
    ) -> SaveSessionMessageRequest {
        SaveSessionMessageRequest {
            session_id: "message-session".into(),
            run_id: Some("message-run".into()),
            consumed_journal_entry_id: None,
            message_id: message_id.into(),
            role: role.into(),
            content_json,
            created_at,
            session_title: (role == "user").then(|| "hello".into()),
            tool_execution: None,
            now: 42,
        }
    }

    fn tool_completion(tool_call_id: &str, tool_name: &str) -> SessionToolExecutionCompletion {
        SessionToolExecutionCompletion {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            result_preview: "external".into(),
            details_json: None,
            is_error: false,
            approval_state: "not_required".into(),
            ended_at: 42,
        }
    }

    fn checkpoint_request(
        id: &str,
        session_id: &str,
        through_message_id: &str,
    ) -> SaveSessionCheckpointRequest {
        let summary = "durable summary".to_string();
        SaveSessionCheckpointRequest {
            id: id.into(),
            session_id: session_id.into(),
            through_message_id: through_message_id.into(),
            summary_hash: format!("{:x}", Sha256::digest(summary.as_bytes())),
            summary,
            reason: "manual".into(),
            tokens_before: 100.0,
            estimated_tokens_after: 10.0,
            request_bytes_before: 1_000.0,
            request_bytes_after: 100.0,
            model_provider: "test".into(),
            model_id: "model".into(),
            prompt_version: 2,
            excluded_message_ids: Vec::new(),
            facts: SessionCheckpointFacts {
                read_files: Vec::new(),
                modified_files: Vec::new(),
                read_progress: std::collections::BTreeMap::new(),
                tool_ledger: Vec::new(),
            },
            created_at: 42.0,
        }
    }

    async fn seed_recovery_graph(connection: &mut SqliteConnection) {
        for statement in [
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('recover-session', 'Recover', 'system', 'test', 'model', 'running', 1, 1)",
            "INSERT INTO agent_runs (id, session_id, status, started_at)
             VALUES ('recover-run', 'recover-session', 'running', 1)",
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at)
             VALUES ('recover-user', 'recover-session', 'recover-run', 1, 'user',
               '{\"id\":\"recover-user\",\"role\":\"user\",\"content\":\"inspect\",\"createdAt\":1}', 1)",
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at)
             VALUES ('recover-assistant', 'recover-session', 'recover-run', 2, 'assistant',
               '{\"id\":\"recover-assistant\",\"role\":\"assistant\",\"content\":\"\",\"toolCalls\":[{\"id\":\"call-prestart\",\"name\":\"read\",\"arguments\":{},\"rawArguments\":\"{}\"},{\"id\":\"call-executing\",\"name\":\"write\",\"arguments\":{},\"rawArguments\":\"{}\"}],\"stopReason\":\"tool_use\",\"createdAt\":2}', 2)",
            "INSERT INTO tool_executions
             (run_id, tool_call_id, tool_name, arguments_json, status, approval_state,
              recovery_policy, started_at)
             VALUES ('recover-run', 'call-executing', 'write', '{}', 'running',
                     'not_required', 'idempotent', 2)",
            "INSERT INTO provider_requests
             (id, session_id, run_id, assistant_message_id, model_provider, model_id,
              message_count, tool_count, status, response_message_json, started_at,
              response_received_at)
             VALUES ('provider-received', 'recover-session', 'recover-run', 'provider-assistant',
                     'test', 'model', 2, 0, 'response_received',
                     '{\"id\":\"provider-assistant\",\"role\":\"assistant\",\"content\":\"received\",\"toolCalls\":[],\"stopReason\":\"stop\",\"createdAt\":3}', 3, 3)",
            "INSERT INTO provider_requests
             (id, session_id, run_id, assistant_message_id, model_provider, model_id,
              message_count, tool_count, status, started_at)
             VALUES ('provider-running', 'recover-session', 'recover-run', 'provider-missing',
                     'test', 'model', 2, 0, 'running', 4)",
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status,
              consumer_run_id, created_at)
             VALUES ('journal-applied', 'recover-session', 0, 'queue', 'steering',
                     '{\"message\":{\"id\":\"recover-user\",\"role\":\"user\",\"content\":\"inspect\",\"createdAt\":1}}',
                     'consuming', 'recover-run', 1)",
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status,
              consumer_run_id, created_at)
             VALUES ('journal-pending', 'recover-session', 1, 'queue', 'follow-up',
                     '{\"message\":{\"id\":\"missing-user\",\"role\":\"user\",\"content\":\"later\",\"createdAt\":2}}',
                     'consuming', 'recover-run', 2)",
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status, created_at)
             VALUES ('journal-resolved', 'recover-session', 2, 'queue', 'next-turn',
                     '{\"message\":{\"id\":\"resolved-user\",\"role\":\"user\",\"content\":\"done\",\"createdAt\":3}}',
                     'discarded', 3)",
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('creating-session', 'Creating', 'system', 'test', 'model', 'creating', 1, 1)",
            "INSERT INTO agent_messages
             (id, session_id, sequence, role, content_json, created_at)
             VALUES ('creating-message', 'creating-session', 1, 'user',
                     '{\"id\":\"creating-message\",\"role\":\"user\",\"content\":\"partial\",\"createdAt\":1}', 1)",
        ] {
            connection.execute(statement).await.unwrap();
        }
    }

    #[tokio::test]
    async fn migrates_the_native_session_schema_to_the_current_version() {
        let (_directory, mut connection) = migrated_database().await;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(version, DATABASE_VERSION);
        let tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name IN (
               'agent_sessions', 'agent_runs', 'agent_messages', 'tool_executions',
               'context_checkpoints', 'artifacts', 'runtime_mutation_batches',
               'agent_session_journal', 'provider_requests'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(tables, 9);
        let recovery_indexes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name IN (
               'idx_agent_sessions_status', 'idx_agent_runs_status_started',
               'idx_agent_messages_run_sequence', 'idx_tool_executions_status_run',
               'idx_agent_session_journal_status_sequence'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(recovery_indexes, 5);
        let count_triggers: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'trigger' AND name IN (
               'trg_agent_messages_count_insert', 'trg_agent_messages_count_delete'
             )",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count_triggers, 2);
        migrate(&mut connection).await.unwrap();
    }

    #[tokio::test]
    async fn loads_a_consistent_session_snapshot_and_maintains_message_count() {
        let (_directory, mut connection) = migrated_database().await;
        connection
            .execute(
                "INSERT INTO agent_sessions
                 (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
                 VALUES ('snapshot-session', 'Snapshot', 'system', 'test', 'model', 'idle', 1, 1)",
            )
            .await
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_messages
                 (id, session_id, sequence, role, content_json, created_at)
                 VALUES ('snapshot-message', 'snapshot-session', 1, 'user',
                   '{\"id\":\"snapshot-message\",\"role\":\"user\",\"content\":\"hello\",\"createdAt\":2}', 2)",
            )
            .await
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_journal
                 (id, session_id, sequence, kind, payload_json, status, created_at)
                 VALUES ('snapshot-journal', 'snapshot-session', 0, 'message_append',
                   '{\"message\":{\"id\":\"pending\",\"role\":\"user\",\"content\":\"later\",\"createdAt\":3}}',
                   'pending', 3)",
            )
            .await
            .unwrap();

        let snapshot = load_session_snapshot(&mut connection, "snapshot-session")
            .await
            .unwrap();
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.pending_journal.len(), 1);
        assert_eq!(snapshot.latest_checkpoint, None);
        assert_eq!(snapshot.session.as_ref().unwrap()["message_count"], 1);

        connection
            .execute("DELETE FROM agent_messages WHERE id = 'snapshot-message'")
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT message_count FROM agent_sessions WHERE id = 'snapshot-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn resumes_every_legacy_partial_migration_without_schema_drift() {
        for version in 3..=DATABASE_VERSION {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(format!("partial-v{version}.db"));
            let mut connection = SqliteConnection::connect_with(&create_options(&path))
                .await
                .unwrap();
            migrate_to(&mut connection, version - 1).await.unwrap();
            let migration = MIGRATIONS
                .iter()
                .find(|migration| migration.version == version)
                .unwrap();
            if let Some(statement) = migration.statements.first() {
                connection.execute(*statement).await.unwrap();
            }
            if let Some(column) = migration.columns.first() {
                connection.execute(column.statement).await.unwrap();
            }
            migrate(&mut connection).await.unwrap();
            let current: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(
                current, DATABASE_VERSION,
                "failed after partial migration v{version}"
            );
        }
    }

    #[tokio::test]
    async fn prepares_every_named_statement_with_its_declared_parameter_count() {
        let (_directory, mut connection) = migrated_database().await;
        assert_eq!(ALL_QUERIES.len(), 14);
        assert_eq!(ALL_MUTATIONS.len(), 6);
        for (label, statement, expected) in ALL_QUERIES
            .iter()
            .map(|operation| {
                (
                    format!("query {operation:?}"),
                    operation.statement(),
                    operation.parameter_count(),
                )
            })
            .chain(ALL_MUTATIONS.iter().map(|operation| {
                (
                    format!("mutation {operation:?}"),
                    operation.statement(),
                    operation.parameter_count(),
                )
            }))
        {
            let prepared = connection
                .prepare(statement)
                .await
                .unwrap_or_else(|error| panic!("failed to prepare {label}: {error}"));
            let actual = match prepared.parameters() {
                Some(Either::Left(types)) => types.len(),
                Some(Either::Right(count)) => count,
                None => 0,
            };
            assert_eq!(actual, expected, "parameter count drifted for {label}");
        }
    }

    #[tokio::test]
    async fn executes_only_named_operations_with_exact_scalar_parameters() {
        let (_directory, mut connection) = migrated_database().await;
        let parameters = vec![
            Value::String("session-1".into()),
            Value::String("system".into()),
            Value::String("test".into()),
            Value::String("model".into()),
            Value::Null,
            Value::String("[]".into()),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Number(1.into()),
            Value::Number(1.into()),
        ];
        execute_mutation(
            &mut connection,
            SessionRepositoryMutation::CreateSession,
            &parameters,
        )
        .await
        .unwrap();
        let rows = query_rows(&mut connection, SessionRepositoryQuery::Sessions, &[])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(execute_mutation(
            &mut connection,
            SessionRepositoryMutation::RenameSession,
            &[],
        )
        .await
        .is_err());
        assert!(query_rows(
            &mut connection,
            SessionRepositoryQuery::Sessions,
            &[Value::Array(Vec::new())],
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn updates_runtime_config_only_for_an_idle_session_without_a_running_run() {
        let (_directory, mut connection) = migrated_database().await;
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
              status, created_at, updated_at)
             VALUES ('config-session', 'Config', 'old', 'test', 'old-model', '[]',
                     'idle', 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let request = UpdateSessionRuntimeConfigRequest {
            session_id: "config-session".into(),
            system_prompt: "new".into(),
            model_provider: "minimax".into(),
            model_id: "MiniMax-M3".into(),
            reasoning_json: None,
            active_tool_names_json: r#"["discover_agent_tools","read"]"#.into(),
            provider_config_json: Some(r#"{"schemaVersion":3,"providerId":"minimax"}"#.into()),
            runtime_manifest_json: Some(
                include_str!("../../contracts/runtime-dependency-manifest-v4.json").into(),
            ),
            now: 2,
        };
        update_runtime_config(&mut connection, &request)
            .await
            .unwrap();
        let stored: (String, String, String) = sqlx::query_as(
            "SELECT system_prompt, model_id, runtime_manifest_json
             FROM agent_sessions WHERE id = 'config-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(stored.0, "new");
        assert_eq!(stored.1, "MiniMax-M3");
        assert_eq!(
            serde_json::from_str::<Value>(&stored.2).unwrap()["schemaVersion"],
            4
        );

        sqlx::query(
            "INSERT INTO agent_runs (id, session_id, status, started_at)
             VALUES ('config-run', 'config-session', 'running', 3)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let error = update_runtime_config(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "Session Runtime 配置只能在空闲状态更新");
    }

    #[tokio::test]
    async fn migrates_provider_profiles_atomically_with_expected_raw_preconditions() {
        let (_directory, mut connection) = migrated_database().await;
        for (id, profile) in [
            ("profile-a", r#"{"schemaVersion":2,"profileId":"a"}"#),
            ("profile-b", r#"{"schemaVersion":2,"profileId":"b"}"#),
        ] {
            sqlx::query(
                "INSERT INTO agent_sessions
                 (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
                  provider_config_json, status, created_at, updated_at)
                 VALUES (?, 'Profile', 'system', 'test', 'model', '[]', ?, 'idle', 1, 1)",
            )
            .bind(id)
            .bind(profile)
            .execute(&mut connection)
            .await
            .unwrap();
        }
        let request = MigrateSessionProviderProfilesRequest {
            migrations: vec![
                ProviderProfileMigration {
                    session_id: "profile-a".into(),
                    expected_provider_config_json: r#"{"schemaVersion":2,"profileId":"a"}"#.into(),
                    provider_config_json: r#"{"schemaVersion":3,"profileId":"a"}"#.into(),
                },
                ProviderProfileMigration {
                    session_id: "profile-b".into(),
                    expected_provider_config_json: r#"{"schemaVersion":2,"profileId":"wrong"}"#
                        .into(),
                    provider_config_json: r#"{"schemaVersion":3,"profileId":"b"}"#.into(),
                },
            ],
        };

        let error = migrate_provider_profiles(&mut connection, &request)
            .await
            .unwrap_err();
        assert!(error.contains("profile-b"));
        let stored: Vec<String> =
            sqlx::query_scalar("SELECT provider_config_json FROM agent_sessions ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert!(stored
            .iter()
            .all(|profile| profile.contains(r#""schemaVersion":2"#)));

        let corrected = MigrateSessionProviderProfilesRequest {
            migrations: vec![
                request.migrations[0].clone(),
                ProviderProfileMigration {
                    session_id: "profile-b".into(),
                    expected_provider_config_json: r#"{"schemaVersion":2,"profileId":"b"}"#.into(),
                    provider_config_json: r#"{"schemaVersion":3,"profileId":"b"}"#.into(),
                },
            ],
        };
        migrate_provider_profiles(&mut connection, &corrected)
            .await
            .unwrap();
        let stored: Vec<String> =
            sqlx::query_scalar("SELECT provider_config_json FROM agent_sessions ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert!(stored
            .iter()
            .all(|profile| profile.contains(r#""schemaVersion":3"#)));
    }

    #[test]
    fn rejects_provider_profile_migration_batches_above_count_and_byte_limits() {
        let migration = ProviderProfileMigration {
            session_id: "profile-limit".into(),
            expected_provider_config_json: r#"{"schemaVersion":2}"#.into(),
            provider_config_json: r#"{"schemaVersion":3}"#.into(),
        };
        let count_limited = MigrateSessionProviderProfilesRequest {
            migrations: vec![migration.clone(); MAX_PROVIDER_PROFILE_MIGRATIONS + 1],
        };
        assert_eq!(
            validate_provider_profile_migrations(&count_limited).unwrap_err(),
            "Provider Profile 迁移为空或超过安全上限"
        );

        let byte_limited = MigrateSessionProviderProfilesRequest {
            migrations: vec![ProviderProfileMigration {
                provider_config_json: format!(r#"{{"value":"{}"}}"#, "x".repeat(MAX_REQUEST_BYTES)),
                ..migration
            }],
        };
        assert_eq!(
            validate_provider_profile_migrations(&byte_limited).unwrap_err(),
            "Provider Profile 迁移为空或超过安全上限"
        );
    }

    #[tokio::test]
    async fn initializes_legacy_runtime_defaults_in_one_transaction() {
        let (_directory, mut connection) = migrated_database().await;
        for statement in [
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
              status, created_at, updated_at)
             VALUES ('defaults-match', 'Match', 'system', 'minimax', 'MiniMax-M3', '[]', 'idle', 1, 1)",
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
              status, created_at, updated_at)
             VALUES ('defaults-other', 'Other', 'system', 'openai-compatible', 'other-model', '[]', 'idle', 1, 1)",
        ] {
            connection.execute(statement).await.unwrap();
        }
        initialize_runtime_defaults(
            &mut connection,
            &InitializeSessionRuntimeDefaultsRequest {
                model_provider: "minimax".into(),
                model_id: "MiniMax-M3".into(),
                provider_config_json: Some(r#"{"providerId":"minimax"}"#.into()),
                runtime_manifest_json: Some(
                    include_str!("../../contracts/runtime-dependency-manifest-v4.json").into(),
                ),
            },
        )
        .await
        .unwrap();

        let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
            "SELECT id, provider_config_json, runtime_manifest_json
             FROM agent_sessions ORDER BY id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert!(rows[0].1.is_some());
        assert_eq!(rows[1].1, None);
        let matching: Value = serde_json::from_str(&rows[0].2).unwrap();
        let other: Value = serde_json::from_str(&rows[1].2).unwrap();
        assert_eq!(matching["schemaVersion"], 4);
        assert_eq!(matching["provider"]["providerId"], "generic-anthropic-compatible");
        assert_eq!(other["schemaVersion"], 1);
        assert_eq!(other["provider"]["kind"], "openai-compatible");
        assert_eq!(other["provider"]["model"], "other-model");
    }

    #[tokio::test]
    async fn appends_only_one_canonical_journal_entry_through_the_dedicated_writer() {
        let (_directory, mut connection) = migrated_database().await;
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
              status, created_at, updated_at)
             VALUES ('journal-session', 'Journal', 'system', 'test', 'model', '[]',
                     'idle', 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let mut request = AppendSessionJournalEntryRequest {
            id: "journal-dedicated".into(),
            session_id: "journal-session".into(),
            sequence: 0,
            kind: "message_append".into(),
            queue_kind: None,
            payload_json: r#"{"message":{"id":"message-1"}}"#.into(),
            created_at: 1,
        };
        append_journal_entry(&mut connection, &request)
            .await
            .unwrap();
        append_journal_entry(&mut connection, &request)
            .await
            .unwrap();
        request.payload_json = r#"{"message":{"id":"message-2"}}"#.into();
        assert!(append_journal_entry(&mut connection, &request)
            .await
            .unwrap_err()
            .contains("canonical effect"));
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_session_journal WHERE id = 'journal-dedicated'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn replaces_the_final_session_atomically_or_rolls_back_both_sides() {
        let (_directory, mut connection) = migrated_database().await;
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
              status, created_at, updated_at)
             VALUES ('replace-target', 'Target', 'system', 'test', 'model', '[]',
                     'idle', 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let request = DeleteSessionWithSuccessorRequest {
            session_id: "replace-target".into(),
            successor_id: "replace-successor".into(),
            system_prompt: "system".into(),
            model_provider: "test".into(),
            model_id: "model".into(),
            reasoning_json: None,
            active_tool_names_json: "[]".into(),
            provider_config_json: None,
            runtime_manifest_json: None,
            now: 2,
        };
        connection
            .execute(
                "CREATE TRIGGER fail_replace_target_delete
                 BEFORE DELETE ON agent_sessions WHEN OLD.id = 'replace-target'
                 BEGIN SELECT RAISE(ABORT, 'injected replacement delete failure'); END",
            )
            .await
            .unwrap();
        let error = delete_with_successor(&mut connection, &request)
            .await
            .unwrap_err();
        assert!(error.contains("injected replacement delete failure"));
        let after_failure: Vec<String> =
            sqlx::query_scalar("SELECT id FROM agent_sessions ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(after_failure, vec!["replace-target"]);

        connection
            .execute("DROP TRIGGER fail_replace_target_delete")
            .await
            .unwrap();
        delete_with_successor(&mut connection, &request)
            .await
            .unwrap();
        let after_success: Vec<String> =
            sqlx::query_scalar("SELECT id FROM agent_sessions ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(after_success, vec!["replace-successor"]);
    }

    #[tokio::test]
    async fn creates_and_activates_a_complete_session_branch_atomically() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;

        create_branch(&mut connection, &branch_request())
            .await
            .unwrap();

        let branch: (String, i64, String, String) = sqlx::query_as(
            "SELECT status, updated_at, parent_session_id, forked_from_message_id
             FROM agent_sessions WHERE id = 'branch-created'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            branch,
            ("idle".into(), 11, "branch-source".into(), "source-2".into())
        );
        let messages: Vec<(String, i64, Option<String>)> = sqlx::query_as(
            "SELECT id, sequence, source_message_id FROM agent_messages
             WHERE session_id = 'branch-created' ORDER BY sequence",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            messages,
            vec![
                ("copy-1".into(), 1, Some("source-1".into())),
                ("copy-2".into(), 2, Some("source-2".into())),
            ]
        );
    }

    #[tokio::test]
    async fn starts_a_session_run_atomically_and_replays_the_same_run_idempotently() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        let mut request = StartSessionRunRequest {
            run_id: "run-start".into(),
            session_id: "branch-source".into(),
            now: 10,
        };

        start_run(&mut connection, &request).await.unwrap();
        request.now = 11;
        start_run(&mut connection, &request).await.unwrap();

        let session: (String, i64) = sqlx::query_as(
            "SELECT status, updated_at FROM agent_sessions WHERE id = 'branch-source'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(session, ("running".into(), 10));
        let runs: Vec<(String, String, i64, Option<i64>)> = sqlx::query_as(
            "SELECT session_id, status, started_at, ended_at
             FROM agent_runs WHERE id = 'run-start'",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            runs,
            vec![("branch-source".into(), "running".into(), 10, None)]
        );
    }

    #[tokio::test]
    async fn refuses_to_restart_a_terminal_session_run() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        let request = StartSessionRunRequest {
            run_id: "terminal-run".into(),
            session_id: "branch-source".into(),
            now: 10,
        };
        start_run(&mut connection, &request).await.unwrap();
        connection
            .execute(
                "UPDATE agent_runs
                 SET status = 'completed', end_reason = 'completed', ended_at = 11
                 WHERE id = 'terminal-run'",
            )
            .await
            .unwrap();
        connection
            .execute(
                "UPDATE agent_sessions SET status = 'idle', updated_at = 11
                 WHERE id = 'branch-source'",
            )
            .await
            .unwrap();

        let error = start_run(&mut connection, &request).await.unwrap_err();
        assert_eq!(error, "Agent Run 已进入终态，拒绝重新启动");
        let run: (String, i64, Option<i64>) = sqlx::query_as(
            "SELECT status, started_at, ended_at FROM agent_runs WHERE id = 'terminal-run'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(run, ("completed".into(), 10, Some(11)));
    }

    #[tokio::test]
    async fn starts_tools_idempotently_only_for_the_same_canonical_running_effect() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let request = StartToolExecutionRequest {
            session_id: "message-session".into(),
            run_id: "message-run".into(),
            tool_call_id: "canonical-tool".into(),
            tool_name: "read".into(),
            arguments_json: "{\"path\":\"a\",\"options\":{\"limit\":1}}".into(),
            approval_state: "not_required".into(),
            recovery_policy: "idempotent".into(),
            idempotency_key: Some("read:a".into()),
            started_at: 10,
        };

        start_tool_execution_record(&mut connection, &request)
            .await
            .unwrap();
        let mut replay = request.clone();
        replay.arguments_json = "{\"options\":{\"limit\":1},\"path\":\"a\"}".into();
        replay.started_at = 11;
        start_tool_execution_record(&mut connection, &replay)
            .await
            .unwrap();
        let stored: (String, String, String, String, Option<String>, i64) = sqlx::query_as(
            "SELECT tool_name, arguments_json, approval_state, recovery_policy,
                    idempotency_key, started_at
             FROM tool_executions
             WHERE run_id = 'message-run' AND tool_call_id = 'canonical-tool'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            stored,
            (
                "read".into(),
                request.arguments_json.clone(),
                "not_required".into(),
                "idempotent".into(),
                Some("read:a".into()),
                10,
            )
        );

        let changed_requests = [
            StartToolExecutionRequest {
                tool_name: "write".into(),
                ..request.clone()
            },
            StartToolExecutionRequest {
                arguments_json: "{\"path\":\"b\",\"options\":{\"limit\":1}}".into(),
                ..request.clone()
            },
            StartToolExecutionRequest {
                approval_state: "pending".into(),
                ..request.clone()
            },
            StartToolExecutionRequest {
                recovery_policy: "never".into(),
                ..request.clone()
            },
            StartToolExecutionRequest {
                idempotency_key: Some("read:changed".into()),
                ..request.clone()
            },
        ];
        for changed in changed_requests {
            let error = start_tool_execution_record(&mut connection, &changed)
                .await
                .unwrap_err();
            assert_eq!(
                error,
                "Tool execution start replay 与 canonical effect 不一致"
            );
        }

        connection
            .execute(
                "UPDATE tool_executions SET status = 'completed', ended_at = 12
                 WHERE run_id = 'message-run' AND tool_call_id = 'canonical-tool'",
            )
            .await
            .unwrap();
        let error = start_tool_execution_record(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "Tool execution 已进入终态，拒绝重新启动");
    }

    #[tokio::test]
    async fn runs_the_shared_repository_contract_against_native_sqlite() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../contracts/session-repository-contract-v1.json"
        ))
        .unwrap();
        assert_eq!(contract["schemaVersion"], 1);
        assert_eq!(contract["scenario"], "canonical-tool-replay-and-recovery");
        let session_id = contract["sessionId"].as_str().unwrap();
        let run_id = contract["runId"].as_str().unwrap();
        let tool = &contract["tool"];
        let expected = &contract["expected"];
        let (_directory, mut connection) = migrated_database().await;
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
              status, created_at, updated_at)
             VALUES (?, 'Contract', 'system', 'test', 'model', '[]', 'idle', 1, 1)",
        )
        .bind(session_id)
        .execute(&mut connection)
        .await
        .unwrap();
        start_run(
            &mut connection,
            &StartSessionRunRequest {
                run_id: run_id.into(),
                session_id: session_id.into(),
                now: 1,
            },
        )
        .await
        .unwrap();
        let request = StartToolExecutionRequest {
            session_id: session_id.into(),
            run_id: run_id.into(),
            tool_call_id: tool["toolCallId"].as_str().unwrap().into(),
            tool_name: tool["toolName"].as_str().unwrap().into(),
            arguments_json: serde_json::to_string(&tool["arguments"]).unwrap(),
            approval_state: tool["approvalState"].as_str().unwrap().into(),
            recovery_policy: tool["recoveryPolicy"].as_str().unwrap().into(),
            idempotency_key: tool["idempotencyKey"].as_str().map(str::to_string),
            started_at: 2,
        };

        start_tool_execution_record(&mut connection, &request)
            .await
            .unwrap();
        let mut replay = request.clone();
        replay.arguments_json = serde_json::to_string(&tool["canonicalReplayArguments"]).unwrap();
        replay.started_at = 3;
        start_tool_execution_record(&mut connection, &replay)
            .await
            .unwrap();
        let mut drifted = request.clone();
        drifted.arguments_json = serde_json::to_string(&tool["driftedArguments"]).unwrap();
        let error = start_tool_execution_record(&mut connection, &drifted)
            .await
            .unwrap_err();
        assert_eq!(error, expected["driftError"].as_str().unwrap());

        let recovered = recover_repository(&mut connection, 4).await.unwrap();
        assert_eq!(
            recovered.recovered_runs,
            expected["recoveredRuns"].as_u64().unwrap()
        );
        let statuses: (String, String, String) = sqlx::query_as(
            "SELECT s.status, r.status, t.status
             FROM agent_sessions s
             JOIN agent_runs r ON r.session_id = s.id
             JOIN tool_executions t ON t.run_id = r.id
             WHERE s.id = ? AND r.id = ? AND t.tool_call_id = ?",
        )
        .bind(session_id)
        .bind(run_id)
        .bind(tool["toolCallId"].as_str().unwrap())
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(statuses.0, expected["sessionStatus"].as_str().unwrap());
        assert_eq!(statuses.1, expected["runStatus"].as_str().unwrap());
        assert_eq!(statuses.2, expected["toolStatus"].as_str().unwrap());
        let counts: (i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(*) FROM agent_runs WHERE session_id = ?),
               (SELECT COUNT(*) FROM tool_executions WHERE run_id = ?)",
        )
        .bind(session_id)
        .bind(run_id)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(counts.0, expected["runCount"].as_i64().unwrap());
        assert_eq!(counts.1, expected["toolExecutionCount"].as_i64().unwrap());
    }

    #[tokio::test]
    async fn starts_tools_only_for_their_own_running_session_run() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        connection
            .execute(
                "INSERT INTO agent_sessions
                 (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
                 VALUES ('tool-other-session', 'Other', 'system', 'test', 'model', 'running', 1, 1)",
            )
            .await
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_runs (id, session_id, status, started_at)
                 VALUES ('tool-other-run', 'tool-other-session', 'running', 1)",
            )
            .await
            .unwrap();
        let mut request = StartToolExecutionRequest {
            session_id: "message-session".into(),
            run_id: "tool-other-run".into(),
            tool_call_id: "owned-tool".into(),
            tool_name: "read".into(),
            arguments_json: "{}".into(),
            approval_state: "not_required".into(),
            recovery_policy: "never".into(),
            idempotency_key: None,
            started_at: 10,
        };
        let error = start_tool_execution_record(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "Tool execution Run 不属于当前 Session");

        request.run_id = "message-run".into();
        connection
            .execute("UPDATE agent_runs SET status = 'completed' WHERE id = 'message-run'")
            .await
            .unwrap();
        let error = start_tool_execution_record(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "Tool execution 所属 Run 已进入终态");

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tool_executions WHERE tool_call_id = 'owned-tool'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn replays_only_canonical_provider_request_and_response_facts() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let request = StartProviderRequestRequest {
            request_id: "canonical-provider-request".into(),
            session_id: "message-session".into(),
            run_id: "message-run".into(),
            assistant_message_id: "canonical-provider-assistant".into(),
            model_provider: "test".into(),
            model_id: "model".into(),
            message_count: 1,
            tool_count: 0,
            started_at: 10,
        };
        start_provider_request_record(&mut connection, &request)
            .await
            .unwrap();
        let mut replay = request.clone();
        replay.started_at = 11;
        start_provider_request_record(&mut connection, &replay)
            .await
            .unwrap();
        let started_at: i64 = sqlx::query_scalar(
            "SELECT started_at FROM provider_requests WHERE id = 'canonical-provider-request'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(started_at, 10);

        let changed_start = StartProviderRequestRequest {
            model_id: "changed-model".into(),
            ..request.clone()
        };
        let error = start_provider_request_record(&mut connection, &changed_start)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Provider request start replay 与 canonical effect 不一致"
        );
        let duplicate_identity = StartProviderRequestRequest {
            request_id: "different-provider-request".into(),
            ..request.clone()
        };
        let error = start_provider_request_record(&mut connection, &duplicate_identity)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Provider request start replay 与 canonical effect 不一致"
        );

        let response = ReceiveProviderResponseRequest {
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
            assistant_message_id: request.assistant_message_id.clone(),
            response_id: Some("response-1".into()),
            response_model: Some("model".into()),
            response_message_json: r#"{"id":"canonical-provider-assistant","role":"assistant","content":"done","toolCalls":[],"stopReason":"stop","createdAt":12}"#.into(),
            response_received_at: 12,
        };
        receive_provider_response_record(&mut connection, &response)
            .await
            .unwrap();
        let mut response_replay = response.clone();
        response_replay.response_message_json = r#"{"createdAt":12,"stopReason":"stop","toolCalls":[],"content":"done","role":"assistant","id":"canonical-provider-assistant"}"#.into();
        response_replay.response_received_at = 13;
        receive_provider_response_record(&mut connection, &response_replay)
            .await
            .unwrap();
        let response_received_at: i64 = sqlx::query_scalar(
            "SELECT response_received_at FROM provider_requests
             WHERE id = 'canonical-provider-request'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(response_received_at, 12);

        let changed_response = ReceiveProviderResponseRequest {
            response_message_json: r#"{"id":"canonical-provider-assistant","role":"assistant","content":"changed","toolCalls":[],"stopReason":"stop","createdAt":12}"#.into(),
            ..response.clone()
        };
        let error = receive_provider_response_record(&mut connection, &changed_response)
            .await
            .unwrap_err();
        assert_eq!(error, "Provider response replay 与 canonical effect 不一致");

        connection
            .execute(
                "UPDATE provider_requests SET status = 'committed', committed_at = 14
                 WHERE id = 'canonical-provider-request'",
            )
            .await
            .unwrap();
        receive_provider_response_record(&mut connection, &response)
            .await
            .unwrap();
        let error = start_provider_request_record(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "Provider request 已进入终态，拒绝重新启动");
    }

    #[tokio::test]
    async fn finishes_a_running_session_run_and_replays_only_the_same_terminal_effect() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let mut request = FinishSessionRunRequest {
            session_id: "message-session".into(),
            run_id: "message-run".into(),
            end_reason: "completed".into(),
            error_message: None,
            now: 42,
        };

        finish_run(&mut connection, &request).await.unwrap();
        request.now = 43;
        finish_run(&mut connection, &request).await.unwrap();

        let run: (String, Option<String>, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT status, end_reason, error_message, ended_at
             FROM agent_runs WHERE id = 'message-run'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            run,
            ("completed".into(), Some("completed".into()), None, Some(42))
        );
        let session_status: String =
            sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = 'message-session'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(session_status, "running");

        request.end_reason = "stopped".into();
        request.error_message = Some("changed".into());
        let error = finish_run(&mut connection, &request).await.unwrap_err();
        assert_eq!(error, "Agent Run 已以不同终态结束，拒绝过期终结重放");
        let unchanged: (String, Option<String>, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT status, end_reason, error_message, ended_at
             FROM agent_runs WHERE id = 'message-run'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(unchanged, run);
    }

    #[tokio::test]
    async fn refuses_to_finish_with_pending_provider_or_tool_ledgers_without_mutating_the_run() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let request = FinishSessionRunRequest {
            session_id: "message-session".into(),
            run_id: "message-run".into(),
            end_reason: "error".into(),
            error_message: Some("failed".into()),
            now: 42,
        };
        connection
            .execute(
                "INSERT INTO provider_requests
                 (id, session_id, run_id, assistant_message_id, model_provider, model_id,
                  message_count, tool_count, status, started_at)
                 VALUES ('finish-provider', 'message-session', 'message-run', 'assistant-1',
                         'test', 'model', 1, 0, 'running', 2)",
            )
            .await
            .unwrap();

        let running_error = finish_run(&mut connection, &request).await.unwrap_err();
        assert_eq!(running_error, "Agent Run 仍有未完成的 Provider ledger");
        connection
            .execute(
                "UPDATE provider_requests SET status = 'response_received'
                 WHERE id = 'finish-provider'",
            )
            .await
            .unwrap();
        let received_error = finish_run(&mut connection, &request).await.unwrap_err();
        assert_eq!(received_error, "Agent Run 仍有未完成的 Provider ledger");
        connection
            .execute("DELETE FROM provider_requests WHERE id = 'finish-provider'")
            .await
            .unwrap();
        connection
            .execute(
                "INSERT INTO tool_executions
                 (run_id, tool_call_id, tool_name, arguments_json, status, approval_state,
                  recovery_policy, started_at)
                 VALUES ('message-run', 'finish-tool', 'read', '{}', 'running',
                         'not_required', 'never', 2)",
            )
            .await
            .unwrap();
        let tool_error = finish_run(&mut connection, &request).await.unwrap_err();
        assert_eq!(tool_error, "Agent Run 仍有未完成的 Tool ledger");

        let run: (String, Option<String>, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT status, end_reason, error_message, ended_at
             FROM agent_runs WHERE id = 'message-run'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(run, ("running".into(), None, None, None));
    }

    #[tokio::test]
    async fn rejects_run_ids_owned_by_another_session() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        connection
            .execute(
                "INSERT INTO agent_sessions
                 (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
                 VALUES ('other-session', 'Other', 'system', 'test', 'model', 'idle', 1, 1)",
            )
            .await
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_runs
                 (id, session_id, status, end_reason, error_message, started_at, ended_at)
                 VALUES ('shared-run', 'other-session', 'finished', 'completed', NULL, 1, 2)",
            )
            .await
            .unwrap();

        let error = start_run(
            &mut connection,
            &StartSessionRunRequest {
                run_id: "shared-run".into(),
                session_id: "branch-source".into(),
                now: 10,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Agent Run ID 已被其他 Session 占用");
        let session_status: String =
            sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = 'branch-source'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let run: (String, String, Option<i64>) = sqlx::query_as(
            "SELECT session_id, status, ended_at FROM agent_runs WHERE id = 'shared-run'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(session_status, "idle");
        assert_eq!(run, ("other-session".into(), "finished".into(), Some(2)));
    }

    #[tokio::test]
    async fn rejects_a_second_active_run_for_the_same_session() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        connection
            .execute(
                "INSERT INTO agent_runs (id, session_id, status, started_at)
                 VALUES ('active-run', 'branch-source', 'running', 1)",
            )
            .await
            .unwrap();

        let error = start_run(
            &mut connection,
            &StartSessionRunRequest {
                run_id: "new-run".into(),
                session_id: "branch-source".into(),
                now: 10,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Session 已存在其他活动 Agent Run");
        let new_runs: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_runs WHERE id = 'new-run'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(new_runs, 0);
    }

    #[tokio::test]
    async fn rolls_back_a_new_run_when_the_session_transition_fails() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        connection
            .execute(
                "CREATE TRIGGER fail_session_run_transition
                 BEFORE UPDATE OF status ON agent_sessions
                 WHEN NEW.id = 'branch-source' AND NEW.status = 'running'
                 BEGIN SELECT RAISE(ABORT, 'injected run transition failure'); END",
            )
            .await
            .unwrap();

        let error = start_run(
            &mut connection,
            &StartSessionRunRequest {
                run_id: "run-rollback".into(),
                session_id: "branch-source".into(),
                now: 10,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("injected run transition failure"));
        let runs: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_runs WHERE id = 'run-rollback'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let session_status: String =
            sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = 'branch-source'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(runs, 0);
        assert_eq!(session_status, "idle");
    }

    #[tokio::test]
    async fn saves_a_complete_turn_save_point_atomically() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;

        save_turn_point(&mut connection, &turn_save_point_request())
            .await
            .unwrap();

        let encoded: Option<String> = sqlx::query_scalar(
            "SELECT latest_turn_save_point_json FROM agent_runs WHERE id = 'run-1'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            encoded.as_deref(),
            Some(
                r#"{"sessionId":"session-1","runId":"run-1","turn":1,"mutationBatchIds":["batch-1"],"hadPendingMutations":true,"messageCount":1,"lastMessageId":"message-1","checkpointId":"checkpoint-1","createdAt":42}"#,
            )
        );
    }

    #[tokio::test]
    async fn accepts_exact_turn_replay_and_rejects_same_turn_drift_or_regression() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;
        let first = turn_save_point_request();
        save_turn_point(&mut connection, &first).await.unwrap();
        save_turn_point(&mut connection, &first).await.unwrap();

        let mut second = first.clone();
        second.turn = 2;
        second.mutation_batch_ids.clear();
        second.had_pending_mutations = false;
        second.created_at = 43;
        save_turn_point(&mut connection, &second).await.unwrap();

        let mut conflicting = second.clone();
        conflicting.created_at = 44;
        assert_eq!(
            save_turn_point(&mut connection, &conflicting)
                .await
                .unwrap_err(),
            "同轮 Turn Save Point replay 与 canonical effect 不一致"
        );
        assert_eq!(
            save_turn_point(&mut connection, &first).await.unwrap_err(),
            "Turn Save Point 轮次不能回退"
        );
    }

    #[tokio::test]
    async fn rejects_every_stale_turn_save_point_boundary_without_writing() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;

        let mut wrong_turn = turn_save_point_request();
        wrong_turn.turn = 2;
        let mut unknown_batch = turn_save_point_request();
        unknown_batch.mutation_batch_ids = vec!["batch-missing".into()];
        let mut omitted_batch = turn_save_point_request();
        omitted_batch.mutation_batch_ids.clear();
        omitted_batch.had_pending_mutations = false;
        let mut wrong_message_count = turn_save_point_request();
        wrong_message_count.message_count = 0;
        let mut wrong_last_message = turn_save_point_request();
        wrong_last_message.last_message_id = Some("message-missing".into());
        let mut wrong_checkpoint = turn_save_point_request();
        wrong_checkpoint.checkpoint_id = Some("checkpoint-missing".into());
        let mut missing_checkpoint = turn_save_point_request();
        missing_checkpoint.checkpoint_id = None;

        for (label, request, expected) in [
            (
                "wrong turn",
                wrong_turn,
                "Turn Save Point mutation batch 边界不完整",
            ),
            (
                "unknown batch",
                unknown_batch,
                "Turn Save Point 引用了未提交或不属于当前 Run/Turn 的 mutation batch",
            ),
            (
                "omitted batch",
                omitted_batch,
                "Turn Save Point mutation batch 边界不完整",
            ),
            (
                "wrong message count",
                wrong_message_count,
                "Turn Save Point 与已持久化消息边界不一致",
            ),
            (
                "wrong last message",
                wrong_last_message,
                "Turn Save Point 与已持久化消息边界不一致",
            ),
            (
                "wrong checkpoint",
                wrong_checkpoint,
                "Turn Save Point 与已持久化上下文检查点不一致",
            ),
            (
                "missing checkpoint",
                missing_checkpoint,
                "Turn Save Point 与已持久化上下文检查点不一致",
            ),
        ] {
            let error = save_turn_point(&mut connection, &request)
                .await
                .unwrap_err();
            assert_eq!(error, expected, "{label}");
            let stored: Option<String> = sqlx::query_scalar(
                "SELECT latest_turn_save_point_json FROM agent_runs WHERE id = 'run-1'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(stored, None, "{label}");
        }
    }

    #[tokio::test]
    async fn rejects_turn_save_points_after_the_run_or_session_stops_running() {
        for (label, transition) in [
            (
                "run stopped",
                "UPDATE agent_runs SET status = 'finished', ended_at = 2 WHERE id = 'run-1'",
            ),
            (
                "session stopped",
                "UPDATE agent_sessions SET status = 'idle' WHERE id = 'session-1'",
            ),
        ] {
            let (_directory, mut connection) = migrated_database().await;
            seed_session_graph(&mut connection).await;
            connection.execute(transition).await.unwrap();

            let error = save_turn_point(&mut connection, &turn_save_point_request())
                .await
                .unwrap_err();
            assert_eq!(error, "Turn Save Point 对应的运行不在执行中", "{label}");
            let stored: Option<String> = sqlx::query_scalar(
                "SELECT latest_turn_save_point_json FROM agent_runs WHERE id = 'run-1'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(stored, None, "{label}");
        }
    }

    #[tokio::test]
    async fn preserves_the_previous_turn_save_point_when_the_final_write_fails() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;
        connection
            .execute(
                "UPDATE agent_runs SET latest_turn_save_point_json =
                 '{\"sessionId\":\"session-1\",\"runId\":\"run-1\",\"turn\":0,\"mutationBatchIds\":[],\"hadPendingMutations\":false,\"messageCount\":0,\"createdAt\":1}'
                 WHERE id = 'run-1'",
            )
            .await
            .unwrap();
        connection
            .execute(
                "CREATE TRIGGER fail_turn_save_point_write
                 BEFORE UPDATE OF latest_turn_save_point_json ON agent_runs
                 WHEN OLD.id = 'run-1'
                 BEGIN SELECT RAISE(ABORT, 'injected turn save point failure'); END",
            )
            .await
            .unwrap();

        let error = save_turn_point(&mut connection, &turn_save_point_request())
            .await
            .unwrap_err();
        assert!(error.contains("injected turn save point failure"));
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT latest_turn_save_point_json FROM agent_runs WHERE id = 'run-1'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            stored.as_deref(),
            Some(
                r#"{"sessionId":"session-1","runId":"run-1","turn":0,"mutationBatchIds":[],"hadPendingMutations":false,"messageCount":0,"createdAt":1}"#
            )
        );
    }

    #[tokio::test]
    async fn settles_a_finished_run_and_prunes_only_resolved_journal_entries_atomically() {
        let (_directory, mut connection) = migrated_database().await;
        seed_settlement(&mut connection, true).await;

        settle_run(&mut connection, &settlement_request(true))
            .await
            .unwrap();

        let session: (String, i64) = sqlx::query_as(
            "SELECT status, updated_at FROM agent_sessions WHERE id = 'settle-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let journal: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, status FROM agent_session_journal
             WHERE session_id = 'settle-session' ORDER BY sequence",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(session, ("idle".into(), 42));
        assert_eq!(journal, vec![("settle-pending".into(), "pending".into())]);
    }

    #[tokio::test]
    async fn rolls_back_the_idle_transition_when_settlement_journal_pruning_fails() {
        let (_directory, mut connection) = migrated_database().await;
        seed_settlement(&mut connection, true).await;
        connection
            .execute(
                "CREATE TRIGGER fail_settlement_journal_delete
                 BEFORE DELETE ON agent_session_journal
                 WHEN OLD.session_id = 'settle-session'
                 BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END",
            )
            .await
            .unwrap();

        let error = settle_run(&mut connection, &settlement_request(true))
            .await
            .unwrap_err();
        assert!(error.contains("injected settlement failure"));
        let session: (String, i64) = sqlx::query_as(
            "SELECT status, updated_at FROM agent_sessions WHERE id = 'settle-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let journal: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, status FROM agent_session_journal
             WHERE session_id = 'settle-session' ORDER BY sequence",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(session, ("running".into(), 1));
        assert_eq!(
            journal,
            vec![
                ("settle-pending".into(), "pending".into()),
                ("settle-applied".into(), "applied".into()),
                ("settle-discarded".into(), "discarded".into()),
            ]
        );
    }

    #[tokio::test]
    async fn rejects_every_stale_settlement_boundary_without_modifying_session_state() {
        let (_directory, mut connection) = migrated_database().await;
        seed_settlement(&mut connection, true).await;
        let mut wrong_count = settlement_request(true);
        wrong_count.message_count = 1;
        let mut wrong_last_message = settlement_request(true);
        wrong_last_message.last_message_id = Some("settle-message-1".into());
        let mut wrong_checkpoint = settlement_request(true);
        wrong_checkpoint.checkpoint_id = None;

        for (request, expected) in [
            (wrong_count, "已持久化消息边界不一致"),
            (wrong_last_message, "已持久化消息边界不一致"),
            (wrong_checkpoint, "已持久化上下文检查点不一致"),
        ] {
            let error = settle_run(&mut connection, &request).await.unwrap_err();
            assert!(error.contains(expected));
            let session: (String, i64) = sqlx::query_as(
                "SELECT status, updated_at FROM agent_sessions WHERE id = 'settle-session'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            let journal_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM agent_session_journal WHERE session_id = 'settle-session'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(session, ("running".into(), 1));
            assert_eq!(journal_count, 3);
        }
    }

    #[tokio::test]
    async fn replays_a_settlement_idempotently_when_both_checkpoint_boundaries_are_empty() {
        let (_directory, mut connection) = migrated_database().await;
        seed_settlement(&mut connection, false).await;
        let mut request = settlement_request(false);

        settle_run(&mut connection, &request).await.unwrap();
        request.now = 43;
        settle_run(&mut connection, &request).await.unwrap();

        let session: (String, i64) = sqlx::query_as(
            "SELECT status, updated_at FROM agent_sessions WHERE id = 'settle-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let journal: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, status FROM agent_session_journal
             WHERE session_id = 'settle-session' ORDER BY sequence",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(session, ("idle".into(), 43));
        assert_eq!(journal, vec![("settle-pending".into(), "pending".into())]);
    }

    #[tokio::test]
    async fn rejects_a_stale_settlement_replay_after_another_run_starts() {
        let (_directory, mut connection) = migrated_database().await;
        seed_settlement(&mut connection, true).await;
        let settlement = settlement_request(true);
        settle_run(&mut connection, &settlement).await.unwrap();
        start_run(
            &mut connection,
            &StartSessionRunRequest {
                run_id: "new-active-run".into(),
                session_id: "settle-session".into(),
                now: 50,
            },
        )
        .await
        .unwrap();
        connection
            .execute(
                "INSERT INTO agent_session_journal
                 (id, session_id, sequence, kind, queue_kind, payload_json, status, created_at)
                 VALUES ('new-run-applied', 'settle-session', 3, 'queue', 'follow-up', '{}', 'applied', 50)",
            )
            .await
            .unwrap();

        let error = settle_run(&mut connection, &settlement).await.unwrap_err();
        assert_eq!(error, "Session 已开始其他 Agent Run，拒绝过期结算");
        let session_status: String =
            sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = 'settle-session'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let applied_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_session_journal
             WHERE id = 'new-run-applied' AND status = 'applied'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(session_status, "running");
        assert_eq!(applied_count, 1);
    }

    #[tokio::test]
    async fn creates_retry_and_summary_branch_variants_with_native_invariants() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;

        let mut retry = branch_request();
        retry.id = "retry-created".into();
        retry.title = "Source · 重试".into();
        retry.through_message_id = "source-1".into();
        retry.kind = "retry".into();
        retry.retried_message_id = Some("source-2".into());
        retry.messages.truncate(1);
        retry.messages[0].id = "retry-copy-1".into();
        retry.messages[0].content_json =
            "{\"id\":\"retry-copy-1\",\"role\":\"user\",\"content\":\"one\",\"createdAt\":1}"
                .into();
        create_branch(&mut connection, &retry).await.unwrap();

        let summary = summary_branch_request();
        create_branch(&mut connection, &summary).await.unwrap();

        let variants: Vec<(String, String, Option<String>, i64)> = sqlx::query_as(
            "SELECT s.id, s.branch_kind, s.retried_message_id, COUNT(m.id)
             FROM agent_sessions s
             LEFT JOIN agent_messages m ON m.session_id = s.id
             WHERE s.id IN ('retry-created', 'branch-created')
             GROUP BY s.id ORDER BY s.id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            variants,
            vec![
                ("branch-created".into(), "branch".into(), None, 2),
                (
                    "retry-created".into(),
                    "retry".into(),
                    Some("source-2".into()),
                    1,
                ),
            ]
        );
    }

    #[tokio::test]
    async fn rolls_back_the_session_branch_after_an_intermediate_message_failure() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        connection
            .execute(
                "CREATE TRIGGER fail_second_branch_message
                 BEFORE INSERT ON agent_messages
                 WHEN NEW.session_id = 'branch-created' AND NEW.sequence = 2
                 BEGIN SELECT RAISE(ABORT, 'injected branch failure'); END",
            )
            .await
            .unwrap();

        let error = create_branch(&mut connection, &branch_request())
            .await
            .unwrap_err();
        assert!(error.contains("injected branch failure"));
        let sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE id = 'branch-created'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let messages: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = 'branch-created'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!((sessions, messages), (0, 0));
    }

    #[tokio::test]
    async fn rejects_a_stale_branch_request_after_the_source_starts_running() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        connection
            .execute("UPDATE agent_sessions SET status = 'running' WHERE id = 'branch-source'")
            .await
            .unwrap();

        let error = create_branch(&mut connection, &branch_request())
            .await
            .unwrap_err();
        assert_eq!(error, "Agent 运行期间不能创建会话分支");
        let sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE id = 'branch-created'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(sessions, 0);
    }

    #[tokio::test]
    async fn rejects_a_stale_branch_summary_after_the_source_history_changes() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        connection
            .execute(
                "INSERT INTO agent_messages
                 (id, session_id, sequence, role, content_json, created_at)
                 VALUES ('source-3', 'branch-source', 3, 'user',
                         '{\"id\":\"source-3\",\"role\":\"user\",\"content\":\"three\",\"createdAt\":3}', 3)",
            )
            .await
            .unwrap();

        let error = create_branch(&mut connection, &summary_branch_request())
            .await
            .unwrap_err();
        assert_eq!(error, "Branch Summary 必须覆盖分支边界后的完整已离开历史");
        let sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE id = 'branch-created'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(sessions, 0);
    }

    #[tokio::test]
    async fn clears_a_complete_session_graph_in_one_native_transaction() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;

        clear_session(
            &mut connection,
            &ClearSessionRepositoryRequest {
                session_id: "session-1".into(),
                now: 42,
                delete_session: false,
            },
        )
        .await
        .unwrap();

        for table in [
            "agent_runs",
            "agent_messages",
            "tool_executions",
            "context_checkpoints",
            "runtime_mutation_batches",
            "agent_session_journal",
            "provider_requests",
        ] {
            assert_eq!(
                session_fact_count(&mut connection, table).await,
                0,
                "{table}"
            );
        }
        let session: (String, String, i64) = sqlx::query_as(
            "SELECT title, status, updated_at FROM agent_sessions WHERE id = 'session-1'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(session, ("新会话".into(), "idle".into(), 42));
        let child: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT parent_session_id, forked_from_message_id
             FROM agent_sessions WHERE id = 'session-child'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(child, (Some("session-1".into()), None));
        let artifacts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(artifacts, 1);
    }

    #[tokio::test]
    async fn deletes_the_session_and_detaches_its_branches_atomically() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;

        clear_session(
            &mut connection,
            &ClearSessionRepositoryRequest {
                session_id: "session-1".into(),
                now: 42,
                delete_session: true,
            },
        )
        .await
        .unwrap();

        let parent: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE id = 'session-1'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(parent, 0);
        let child: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT parent_session_id, forked_from_message_id
             FROM agent_sessions WHERE id = 'session-child'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(child, (None, None));
    }

    #[tokio::test]
    async fn rolls_back_every_session_fact_when_clear_fails_mid_transaction() {
        let (_directory, mut connection) = migrated_database().await;
        seed_session_graph(&mut connection).await;
        connection
            .execute(
                "CREATE TRIGGER fail_session_run_delete
                 BEFORE DELETE ON agent_runs
                 BEGIN SELECT RAISE(ABORT, 'injected clear failure'); END",
            )
            .await
            .unwrap();

        let error = clear_session(
            &mut connection,
            &ClearSessionRepositoryRequest {
                session_id: "session-1".into(),
                now: 42,
                delete_session: false,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("injected clear failure"));

        for table in [
            "agent_runs",
            "agent_messages",
            "tool_executions",
            "context_checkpoints",
            "runtime_mutation_batches",
            "agent_session_journal",
            "provider_requests",
        ] {
            assert_eq!(
                session_fact_count(&mut connection, table).await,
                1,
                "{table}"
            );
        }
        let session: (String, String, i64) = sqlx::query_as(
            "SELECT title, status, updated_at FROM agent_sessions WHERE id = 'session-1'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(session, ("Original".into(), "running".into(), 1));
        let child: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT parent_session_id, forked_from_message_id
             FROM agent_sessions WHERE id = 'session-child'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(child, (Some("session-1".into()), Some("message-1".into())));
    }

    #[tokio::test]
    async fn transitions_journal_entries_with_native_atomic_validation() {
        let (_directory, mut connection) = migrated_database().await;
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json,
              status, created_at, updated_at)
             VALUES ('session-1', 'New', 'system', 'test', 'model', '[]', 'running', 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_runs (id, session_id, status, started_at)
             VALUES ('run-1', 'session-1', 'running', 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status, created_at)
             VALUES ('journal-1', 'session-1', 0, 'queue', 'steering', '{}', 'pending', 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let missing_run = transition_journal_entries(
            &mut connection,
            &JournalTransitionRequest {
                session_id: "session-1".into(),
                entry_ids: vec!["journal-1".into()],
                transition: JournalTransition::Consuming,
                run_id: None,
                now: None,
            },
        )
        .await
        .unwrap_err();
        assert!(missing_run.contains("缺少 Run ID"));
        transition_journal_entries(
            &mut connection,
            &JournalTransitionRequest {
                session_id: "session-1".into(),
                entry_ids: vec!["journal-1".into()],
                transition: JournalTransition::Consuming,
                run_id: Some("run-1".into()),
                now: None,
            },
        )
        .await
        .unwrap();
        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_journal WHERE id = 'journal-1'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(status, "consuming");
    }

    #[tokio::test]
    async fn persists_message_provider_artifact_and_session_facts_atomically() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let user_json = r#"{"id":"message-user","role":"user","content":"hello","createdAt":2}"#;
        save_session_message(
            &mut connection,
            &session_message_request("message-user", "user", user_json.into(), 2),
        )
        .await
        .unwrap();

        let assistant_json = r#"{"id":"message-assistant","role":"assistant","content":"done","toolCalls":[],"stopReason":"stop","createdAt":3}"#;
        sqlx::query(
            "INSERT INTO provider_requests
             (id, session_id, run_id, assistant_message_id, model_provider, model_id,
              message_count, tool_count, status, response_message_json, started_at,
              response_received_at)
             VALUES ('message-provider', 'message-session', 'message-run', 'message-assistant',
                     'test', 'model', 1, 0, 'response_received', ?, 3, 3)",
        )
        .bind(assistant_json)
        .execute(&mut connection)
        .await
        .unwrap();
        let conflicting_assistant = session_message_request(
            "message-assistant",
            "assistant",
            r#"{"id":"message-assistant","role":"assistant","content":"changed","toolCalls":[],"stopReason":"stop","createdAt":3}"#.into(),
            3,
        );
        let error = save_session_message(&mut connection, &conflicting_assistant)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Assistant message 与 Provider response canonical effect 不一致"
        );
        let assistant =
            session_message_request("message-assistant", "assistant", assistant_json.into(), 3);
        save_session_message(&mut connection, &assistant)
            .await
            .unwrap();
        save_session_message(&mut connection, &assistant)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO tool_executions
             (run_id, tool_call_id, tool_name, arguments_json, status, approval_state, started_at)
             VALUES ('message-run', 'call-artifact', 'read', '{}', 'running',
                     'not_required', 4)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let hash = "a".repeat(64);
        let tool_json = format!(
            r#"{{"id":"message-tool","role":"tool","toolCallId":"call-artifact","toolName":"read","content":"external","artifact":{{"id":"sha256:{hash}","kind":"text","mediaType":"text/plain","relativePath":"artifacts/sha256/aa/{hash}","contentHash":"{hash}","sizeBytes":8,"createdAt":4}},"isError":false,"createdAt":4}}"#,
        );
        let mut tool_request = session_message_request("message-tool", "tool", tool_json, 4);
        tool_request.tool_execution = Some(tool_completion("call-artifact", "read"));
        save_session_message(&mut connection, &tool_request)
            .await
            .unwrap();
        save_session_message(&mut connection, &tool_request)
            .await
            .unwrap();

        let messages: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = 'message-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let session: (String, i64) = sqlx::query_as(
            "SELECT title, updated_at FROM agent_sessions WHERE id = 'message-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let provider_status: String = sqlx::query_scalar(
            "SELECT status FROM provider_requests WHERE id = 'message-provider'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let artifact: (String, String) = sqlx::query_as(
            "SELECT m.artifact_id, t.artifact_id
             FROM agent_messages m
             JOIN tool_executions t ON t.run_id = m.run_id AND t.tool_call_id = 'call-artifact'
             WHERE m.id = 'message-tool'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(messages, 3);
        assert_eq!(session, ("hello".into(), 42));
        assert_eq!(provider_status, "committed");
        assert_eq!(artifact.0, format!("sha256:{hash}"));
        assert_eq!(artifact.1, format!("sha256:{hash}"));
        let tool_status: (String, Option<i64>) = sqlx::query_as(
            "SELECT status, is_error FROM tool_executions
             WHERE run_id = 'message-run' AND tool_call_id = 'call-artifact'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(tool_status, ("completed".into(), Some(0)));
    }

    #[tokio::test]
    async fn replays_only_the_same_finalized_message_canonical_effect_without_touching_session() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let mut request = session_message_request(
            "canonical-message",
            "user",
            r#"{"id":"canonical-message","role":"user","content":"hello","createdAt":2}"#.into(),
            2,
        );
        request.now = 42;
        save_session_message(&mut connection, &request)
            .await
            .unwrap();

        request.content_json =
            r#"{"createdAt":2,"content":"hello","role":"user","id":"canonical-message"}"#.into();
        request.now = 99;
        save_session_message(&mut connection, &request)
            .await
            .unwrap();

        let stored: (String, i64) = sqlx::query_as(
            "SELECT content_json, created_at FROM agent_messages WHERE id = 'canonical-message'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let session_updated_at: i64 = sqlx::query_scalar(
            "SELECT updated_at FROM agent_sessions WHERE id = 'message-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            stored,
            (
                r#"{"id":"canonical-message","role":"user","content":"hello","createdAt":2}"#
                    .into(),
                2,
            )
        );
        assert_eq!(session_updated_at, 42);

        request.content_json =
            r#"{"id":"canonical-message","role":"user","content":"changed","createdAt":2}"#.into();
        let error = save_session_message(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Session message ID 已被不一致的 canonical effect 占用"
        );
        let unchanged: String = sqlx::query_scalar(
            "SELECT content_json FROM agent_messages WHERE id = 'canonical-message'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(unchanged, stored.0);
    }

    #[tokio::test]
    async fn persists_a_consumed_queue_message_and_applies_its_journal_entry_atomically() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let message_json =
            r#"{"id":"queued-message","role":"user","content":"queued","createdAt":2}"#;
        sqlx::query(
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status,
              consumer_run_id, created_at)
             VALUES ('queued-journal', 'message-session', 0, 'queue', 'steering', ?,
                     'consuming', 'message-run', 2)",
        )
        .bind(format!(r#"{{"message":{message_json}}}"#))
        .execute(&mut connection)
        .await
        .unwrap();
        let mut request = session_message_request("queued-message", "user", message_json.into(), 2);
        request.consumed_journal_entry_id = Some("queued-journal".into());

        save_session_message(&mut connection, &request)
            .await
            .unwrap();
        save_session_message(&mut connection, &request)
            .await
            .unwrap();

        let message_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE id = 'queued-message'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let journal: (String, Option<i64>) = sqlx::query_as(
            "SELECT status, applied_at FROM agent_session_journal WHERE id = 'queued-journal'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(message_count, 1);
        assert_eq!(journal, ("applied".into(), Some(42)));
    }

    #[tokio::test]
    async fn consumes_a_queue_message_whose_content_json_carries_the_codec_envelope() {
        // 回归：messageCodec 的 codecVersion 信封属于存储编解码细节，journal payload
        // 的 message 不带信封；canonical 比对若不剥除信封，队列消息每次消费落库
        // 都会被误判为「消费事实不匹配」（TS 侧 encodeAgentMessage 恒写信封）。
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let message_json =
            r#"{"id":"queued-envelope","role":"user","content":"queued","createdAt":2}"#;
        sqlx::query(
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status,
              consumer_run_id, created_at)
             VALUES ('queued-envelope-journal', 'message-session', 0, 'queue', 'steering', ?,
                     'consuming', 'message-run', 2)",
        )
        .bind(format!(r#"{{"message":{message_json}}}"#))
        .execute(&mut connection)
        .await
        .unwrap();
        let mut request = session_message_request(
            "queued-envelope",
            "user",
            r#"{"codecVersion":1,"id":"queued-envelope","role":"user","content":"queued","createdAt":2}"#.into(),
            2,
        );
        request.consumed_journal_entry_id = Some("queued-envelope-journal".into());

        save_session_message(&mut connection, &request)
            .await
            .unwrap();

        let message_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE id = 'queued-envelope'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let journal_status: String = sqlx::query_scalar(
            "SELECT status FROM agent_session_journal WHERE id = 'queued-envelope-journal'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(message_count, 1);
        assert_eq!(journal_status, "applied");
    }

    #[tokio::test]
    async fn rolls_back_a_queue_message_when_its_journal_acknowledgement_fails() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let message_json =
            r#"{"id":"queued-rollback","role":"user","content":"queued","createdAt":2}"#;
        sqlx::query(
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status,
              consumer_run_id, created_at)
             VALUES ('queued-rollback-journal', 'message-session', 0, 'queue', 'steering', ?,
                     'consuming', 'message-run', 2)",
        )
        .bind(format!(r#"{{"message":{message_json}}}"#))
        .execute(&mut connection)
        .await
        .unwrap();
        connection
            .execute(
                "CREATE TRIGGER fail_queue_message_ack
                 BEFORE UPDATE OF status ON agent_session_journal
                 WHEN OLD.id = 'queued-rollback-journal'
                 BEGIN SELECT RAISE(ABORT, 'injected queue ack failure'); END",
            )
            .await
            .unwrap();
        let mut request =
            session_message_request("queued-rollback", "user", message_json.into(), 2);
        request.consumed_journal_entry_id = Some("queued-rollback-journal".into());

        let error = save_session_message(&mut connection, &request)
            .await
            .unwrap_err();
        assert!(error.contains("injected queue ack failure"));
        let message_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE id = 'queued-rollback'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let journal_status: String = sqlx::query_scalar(
            "SELECT status FROM agent_session_journal WHERE id = 'queued-rollback-journal'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(message_count, 0);
        assert_eq!(journal_status, "consuming");
    }

    #[tokio::test]
    async fn rejects_queue_acknowledgement_and_recovery_for_a_conflicting_message_effect() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let expected_json =
            r#"{"id":"queued-conflict","role":"user","content":"expected","createdAt":2}"#;
        sqlx::query(
            "INSERT INTO agent_session_journal
             (id, session_id, sequence, kind, queue_kind, payload_json, status,
              consumer_run_id, created_at)
             VALUES ('queued-conflict-journal', 'message-session', 0, 'queue', 'steering', ?,
                     'consuming', 'message-run', 2)",
        )
        .bind(format!(r#"{{"message":{expected_json}}}"#))
        .execute(&mut connection)
        .await
        .unwrap();
        let mut request = session_message_request(
            "queued-conflict",
            "user",
            r#"{"id":"queued-conflict","role":"user","content":"changed","createdAt":2}"#.into(),
            2,
        );
        request.consumed_journal_entry_id = Some("queued-conflict-journal".into());
        let error = save_session_message(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "Session message 与 queue journal 消费事实不匹配");

        request.consumed_journal_entry_id = None;
        save_session_message(&mut connection, &request)
            .await
            .unwrap();
        let error = recover_repository(&mut connection, 42).await.unwrap_err();
        assert_eq!(
            error,
            "Consuming queue journal 与已持久化消息 canonical effect 冲突"
        );
        let run_status: String =
            sqlx::query_scalar("SELECT status FROM agent_runs WHERE id = 'message-run'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let journal_status: String = sqlx::query_scalar(
            "SELECT status FROM agent_session_journal WHERE id = 'queued-conflict-journal'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            (run_status, journal_status),
            ("running".into(), "consuming".into())
        );
    }

    #[tokio::test]
    async fn rolls_back_tool_result_when_atomic_tool_completion_is_missing() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let tool_json = r#"{"id":"message-tool-missing","role":"tool","toolCallId":"call-missing","toolName":"read","content":"external","isError":false,"createdAt":4}"#;
        let mut request =
            session_message_request("message-tool-missing", "tool", tool_json.into(), 4);
        request.tool_execution = Some(tool_completion("call-missing", "read"));

        let error = save_session_message(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "ToolResult message 缺少匹配的活动工具执行记录");
        let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(messages, 0);
    }

    #[tokio::test]
    async fn rejects_normal_assistant_messages_without_a_provider_ledger() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let request = session_message_request(
            "assistant-without-ledger",
            "assistant",
            r#"{"id":"assistant-without-ledger","role":"assistant","content":"done","toolCalls":[],"stopReason":"stop","createdAt":2}"#.into(),
            2,
        );
        let error = save_session_message(&mut connection, &request)
            .await
            .unwrap_err();
        assert_eq!(error, "Assistant message 缺少 Provider response ledger");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(count, 0);

        let failure = session_message_request(
            "assistant-orchestration-failure",
            "assistant",
            r#"{"id":"assistant-orchestration-failure","role":"assistant","content":"","toolCalls":[],"stopReason":"error","errorMessage":"failed","diagnostics":[{"type":"agent-orchestration-error","timestamp":2}],"createdAt":2}"#.into(),
            2,
        );
        save_session_message(&mut connection, &failure)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_artifact_metadata_beyond_the_native_writer_limit() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let hash = "b".repeat(64);
        let tool_json = format!(
            r#"{{"id":"oversized-artifact","role":"tool","toolCallId":"call-oversized","toolName":"read","content":"external","artifact":{{"id":"sha256:{hash}","kind":"text","mediaType":"text/plain","relativePath":"artifacts/sha256/bb/{hash}","contentHash":"{hash}","sizeBytes":{},"createdAt":2}},"isError":false,"createdAt":2}}"#,
            MAX_ARTIFACT_BYTES + 1,
        );
        let error = save_session_message(
            &mut connection,
            &session_message_request("oversized-artifact", "tool", tool_json, 2),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Session message 包含无效的 Artifact 元数据");
        let artifact_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(artifact_count, 0);
    }

    #[tokio::test]
    async fn rolls_back_message_and_provider_facts_when_the_session_touch_fails() {
        let (_directory, mut connection) = migrated_database().await;
        seed_running_message_session(&mut connection).await;
        let assistant_json = r#"{"id":"rollback-assistant","role":"assistant","content":"done","toolCalls":[],"stopReason":"stop","createdAt":2}"#;
        sqlx::query(
            "INSERT INTO provider_requests
             (id, session_id, run_id, assistant_message_id, model_provider, model_id,
              message_count, tool_count, status, response_message_json, started_at,
              response_received_at)
             VALUES ('rollback-provider', 'message-session', 'message-run', 'rollback-assistant',
                     'test', 'model', 0, 0, 'response_received', ?, 2, 2)",
        )
        .bind(assistant_json)
        .execute(&mut connection)
        .await
        .unwrap();
        connection
            .execute(
                "CREATE TRIGGER fail_message_session_touch
                 BEFORE UPDATE OF updated_at ON agent_sessions
                 WHEN OLD.id = 'message-session'
                 BEGIN SELECT RAISE(ABORT, 'injected message touch failure'); END",
            )
            .await
            .unwrap();
        let error = save_session_message(
            &mut connection,
            &session_message_request("rollback-assistant", "assistant", assistant_json.into(), 2),
        )
        .await
        .unwrap_err();
        assert!(error.contains("injected message touch failure"));
        let message_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let provider_status: String = sqlx::query_scalar(
            "SELECT status FROM provider_requests WHERE id = 'rollback-provider'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(message_count, 0);
        assert_eq!(provider_status, "response_received");
    }

    #[tokio::test]
    async fn validates_and_persists_checkpoints_idempotently_in_rust() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        let mut request = checkpoint_request("checkpoint-native", "branch-source", "source-2");
        request.excluded_message_ids = vec!["source-1".into()];
        request.facts.read_files = vec!["src/read.ts".into()];
        request.facts.modified_files = vec!["src/write.ts".into()];
        save_checkpoint(&mut connection, &request).await.unwrap();
        save_checkpoint(&mut connection, &request).await.unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM context_checkpoints WHERE id = 'checkpoint-native'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let stored: (String, String) = sqlx::query_as(
            "SELECT excluded_message_ids_json, facts_json
             FROM context_checkpoints WHERE id = 'checkpoint-native'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 1);
        assert_eq!(stored.0, r#"["source-1"]"#);
        assert_eq!(
            stored.1,
            r#"{"readFiles":["src/read.ts"],"modifiedFiles":["src/write.ts"],"readProgress":{},"toolLedger":[]}"#,
        );
    }

    #[tokio::test]
    async fn persists_checkpoint_work_ledger_and_rejects_malformed_ledger() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;

        let mut request = checkpoint_request("checkpoint-ledger", "branch-source", "source-2");
        request.facts.read_progress.insert(
            "src/read.ts".into(),
            SessionReadProgressCursor {
                next_offset: Some(201),
                total_lines: 500,
                truncated: true,
                sha256: "a".repeat(64),
            },
        );
        request.facts.tool_ledger = vec![SessionToolLedgerEntry {
            id: "call-1".into(),
            tool: "read".into(),
            path: Some("src/read.ts".into()),
            status: "done".into(),
        }];
        save_checkpoint(&mut connection, &request).await.unwrap();

        let mut conflicting = checkpoint_request("checkpoint-conflict", "branch-source", "source-2");
        conflicting.facts.read_progress.insert(
            "src/write.ts".into(),
            SessionReadProgressCursor {
                next_offset: None,
                total_lines: 10,
                truncated: false,
                sha256: "b".repeat(64),
            },
        );
        conflicting.facts.modified_files = vec!["src/write.ts".into()];
        let error = save_checkpoint(&mut connection, &conflicting)
            .await
            .unwrap_err();
        assert_eq!(error, "上下文检查点文件事实存在读写冲突");

        let mut duplicated = checkpoint_request("checkpoint-dup-ledger", "branch-source", "source-2");
        duplicated.facts.tool_ledger = vec![
            SessionToolLedgerEntry {
                id: "call-1".into(),
                tool: "read".into(),
                path: None,
                status: "done".into(),
            },
            SessionToolLedgerEntry {
                id: "call-1".into(),
                tool: "bash".into(),
                path: None,
                status: "pending".into(),
            },
        ];
        let error = save_checkpoint(&mut connection, &duplicated)
            .await
            .unwrap_err();
        assert_eq!(error, "上下文检查点工具账本 ID 无效或重复");
    }

    #[tokio::test]
    async fn validates_checkpoint_excluded_messages_in_bounded_batches() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        let mut excluded_message_ids = Vec::new();
        for index in 0..=CHECKPOINT_MESSAGE_ID_BATCH_SIZE {
            let message_id = format!("checkpoint-batch-{index}");
            sqlx::query(
                "INSERT INTO agent_messages
                 (id, session_id, sequence, role, content_json, created_at)
                 VALUES (?, 'branch-source', ?, 'user', ?, ?)",
            )
            .bind(&message_id)
            .bind(index as i64 + 3)
            .bind(format!(
                r#"{{"id":"{message_id}","role":"user","content":"batch","createdAt":{}}}"#,
                index + 3
            ))
            .bind(index as i64 + 3)
            .execute(&mut connection)
            .await
            .unwrap();
            excluded_message_ids.push(message_id);
        }

        let through_message_id = excluded_message_ids.last().unwrap().clone();
        let mut request = checkpoint_request(
            "checkpoint-batched-exclusions",
            "branch-source",
            &through_message_id,
        );
        request.excluded_message_ids = excluded_message_ids;
        save_checkpoint(&mut connection, &request).await.unwrap();

        let mut foreign = checkpoint_request(
            "checkpoint-batched-foreign",
            "branch-source",
            &through_message_id,
        );
        foreign.excluded_message_ids = request.excluded_message_ids;
        *foreign.excluded_message_ids.last_mut().unwrap() = "foreign-message".into();
        let error = save_checkpoint(&mut connection, &foreign)
            .await
            .unwrap_err();
        assert_eq!(error, "上下文检查点排除消息不属于当前会话历史");
    }

    #[tokio::test]
    async fn rejects_checkpoint_boundaries_that_split_tool_result_groups() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        for statement in [
            "INSERT INTO agent_messages
             (id, session_id, sequence, role, content_json, created_at)
             VALUES ('checkpoint-tools', 'branch-source', 3, 'assistant',
               '{\"id\":\"checkpoint-tools\",\"role\":\"assistant\",\"content\":\"\",\"toolCalls\":[{\"id\":\"checkpoint-call-1\",\"name\":\"read\",\"arguments\":{},\"rawArguments\":\"{}\"},{\"id\":\"checkpoint-call-2\",\"name\":\"write\",\"arguments\":{},\"rawArguments\":\"{}\"}],\"stopReason\":\"tool_use\",\"createdAt\":3}', 3)",
            "INSERT INTO agent_messages
             (id, session_id, sequence, role, content_json, created_at)
             VALUES ('checkpoint-tool-1', 'branch-source', 4, 'tool',
               '{\"id\":\"checkpoint-tool-1\",\"role\":\"tool\",\"toolCallId\":\"checkpoint-call-1\",\"toolName\":\"read\",\"content\":\"one\",\"isError\":false,\"createdAt\":4}', 4)",
            "INSERT INTO agent_messages
             (id, session_id, sequence, role, content_json, created_at)
             VALUES ('checkpoint-tool-2', 'branch-source', 5, 'tool',
               '{\"id\":\"checkpoint-tool-2\",\"role\":\"tool\",\"toolCallId\":\"checkpoint-call-2\",\"toolName\":\"write\",\"content\":\"two\",\"isError\":false,\"createdAt\":5}', 5)",
        ] {
            connection.execute(statement).await.unwrap();
        }
        for boundary in ["checkpoint-tools", "checkpoint-tool-1"] {
            let error = save_checkpoint(
                &mut connection,
                &checkpoint_request(&format!("checkpoint-{boundary}"), "branch-source", boundary),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error, "上下文检查点边界会拆分 ToolCall/ToolResult 消息组",
                "{boundary}",
            );
        }
        save_checkpoint(
            &mut connection,
            &checkpoint_request(
                "checkpoint-complete-tools",
                "branch-source",
                "checkpoint-tool-2",
            ),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn rejects_corrupted_checkpoint_hashes_and_foreign_message_facts() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;

        let mut bad_hash = checkpoint_request("checkpoint-bad-hash", "branch-source", "source-2");
        bad_hash.summary_hash = "0".repeat(64);
        let mut foreign_excluded =
            checkpoint_request("checkpoint-foreign-message", "branch-source", "source-2");
        foreign_excluded.excluded_message_ids = vec!["message-missing".into()];
        let mut conflicting_facts =
            checkpoint_request("checkpoint-conflicting-facts", "branch-source", "source-2");
        conflicting_facts.facts.read_files = vec!["src/shared.ts".into()];
        conflicting_facts.facts.modified_files = vec!["src/shared.ts".into()];

        for (request, expected) in [
            (bad_hash, "上下文检查点摘要哈希校验失败"),
            (foreign_excluded, "上下文检查点排除消息不属于当前会话历史"),
            (conflicting_facts, "上下文检查点文件事实存在读写冲突"),
        ] {
            let error = save_checkpoint(&mut connection, &request)
                .await
                .unwrap_err();
            assert_eq!(error, expected);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_checkpoints")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn rolls_back_checkpoint_when_the_final_insert_fails() {
        let (_directory, mut connection) = migrated_database().await;
        seed_branch_source(&mut connection).await;
        connection
            .execute(
                "CREATE TRIGGER fail_checkpoint_insert
                 BEFORE INSERT ON context_checkpoints
                 BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END",
            )
            .await
            .unwrap();
        let error = save_checkpoint(
            &mut connection,
            &checkpoint_request("checkpoint-rollback", "branch-source", "source-2"),
        )
        .await
        .unwrap_err();
        assert!(error.contains("injected checkpoint failure"));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_checkpoints")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn recovery_does_not_parse_settled_historical_interrupted_runs() {
        let (_directory, mut connection) = migrated_database().await;
        for statement in [
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('historical-session', 'Historical', 'system', 'test', 'model', 'idle', 1, 1)",
            "INSERT INTO agent_runs
             (id, session_id, status, end_reason, started_at, ended_at)
             VALUES ('historical-run', 'historical-session', 'interrupted', 'interrupted', 1, 2)",
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at)
             VALUES ('historical-corrupt', 'historical-session', 'historical-run', 1,
                     'assistant', 'not-json', 1)",
        ] {
            connection.execute(statement).await.unwrap();
        }

        let recovered = recover_repository(&mut connection, 42).await.unwrap();
        assert_eq!(recovered.recovered_runs, 0);
    }

    #[tokio::test]
    async fn recovers_run_provider_tool_and_journal_facts_in_one_idempotent_transaction() {
        let (_directory, mut connection) = migrated_database().await;
        seed_recovery_graph(&mut connection).await;
        let recovered = recover_repository(&mut connection, 42).await.unwrap();
        assert_eq!(recovered.recovered_runs, 1);
        let session_status: String =
            sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = 'recover-session'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let run_status: String =
            sqlx::query_scalar("SELECT status FROM agent_runs WHERE id = 'recover-run'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let provider_statuses: Vec<(String, String)> =
            sqlx::query_as("SELECT id, status FROM provider_requests ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        let tool_status: String = sqlx::query_scalar(
            "SELECT status FROM tool_executions
             WHERE run_id = 'recover-run' AND tool_call_id = 'call-executing'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let messages: Vec<String> = sqlx::query_scalar(
            "SELECT content_json FROM agent_messages
             WHERE session_id = 'recover-session' ORDER BY sequence",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        let journal: Vec<(String, String)> =
            sqlx::query_as("SELECT id, status FROM agent_session_journal ORDER BY sequence")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        let creating_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE id = 'creating-session'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(session_status, "idle");
        assert_eq!(run_status, "interrupted");
        assert_eq!(
            provider_statuses,
            vec![
                ("provider-received".into(), "committed".into()),
                ("provider-running".into(), "interrupted".into()),
            ],
        );
        assert_eq!(tool_status, "interrupted");
        assert_eq!(messages.len(), 5);
        assert!(messages
            .iter()
            .any(|encoded| encoded.contains("provider-assistant")));
        for (tool_call_id, recovery_policy) in
            [("call-prestart", "never"), ("call-executing", "idempotent")]
        {
            let id = format!(
                "tool-interrupted-{:x}",
                Sha256::digest(interrupted_tool_key("recover-run", tool_call_id).as_bytes()),
            );
            let encoded = messages
                .iter()
                .find(|message| message.contains(&id))
                .unwrap();
            let value: Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(value["toolCallId"], tool_call_id);
            assert_eq!(value["content"], INTERRUPTED_TOOL_RESULT_CONTENT);
            assert_eq!(value["details"]["recoveryPolicy"], recovery_policy);
            assert_eq!(value["details"]["executionState"], "interrupted");
        }
        assert_eq!(journal, vec![("journal-pending".into(), "pending".into())]);
        assert_eq!(creating_count, 0);

        let replayed = recover_repository(&mut connection, 43).await.unwrap();
        assert_eq!(replayed.recovered_runs, 0);
        let replayed_message_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = 'recover-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(replayed_message_count, 5);
    }

    #[tokio::test]
    async fn rolls_back_every_recovery_fact_when_the_idle_transition_fails() {
        let (_directory, mut connection) = migrated_database().await;
        seed_recovery_graph(&mut connection).await;
        connection
            .execute(
                "CREATE TRIGGER fail_recovery_idle_transition
                 BEFORE UPDATE OF status ON agent_sessions
                 WHEN OLD.id = 'recover-session' AND NEW.status = 'idle'
                 BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END",
            )
            .await
            .unwrap();
        let error = recover_repository(&mut connection, 42).await.unwrap_err();
        assert!(error.contains("injected recovery failure"));
        let run_status: String =
            sqlx::query_scalar("SELECT status FROM agent_runs WHERE id = 'recover-run'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let tool_status: String = sqlx::query_scalar(
            "SELECT status FROM tool_executions WHERE tool_call_id = 'call-executing'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let provider_statuses: Vec<String> =
            sqlx::query_scalar("SELECT status FROM provider_requests ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        let message_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = 'recover-session'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let creating_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE id = 'creating-session'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(run_status, "running");
        assert_eq!(tool_status, "running");
        assert_eq!(provider_statuses, vec!["response_received", "running"]);
        assert_eq!(message_count, 2);
        assert_eq!(creating_count, 1);
    }

    #[tokio::test]
    async fn pool_reads_proceed_while_a_write_transaction_is_open() {
        // WAL 单写多读：写事务持写锁未提交期间，另一池连接的读不被阻塞且看到
        // 提交前快照——单连接模型下这会被全局 connection Mutex 串行化（读必须
        // 等写整段完成）。这是多会话并行持久化的池化契约基线。
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("axiom.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(create_options(&path))
            .await
            .unwrap();
        let mut writer = pool.acquire().await.unwrap();
        migrate(&mut writer).await.unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('session-1', 'committed-title', 'system', 'test', 'model', 'idle', 1, 1)",
        )
        .execute(&mut *writer)
        .await
        .unwrap();

        // 写事务开启（BEGIN IMMEDIATE 持写锁）且修改未提交。
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *writer)
            .await
            .unwrap();
        sqlx::query("UPDATE agent_sessions SET title = 'pending-title' WHERE id = 'session-1'")
            .execute(&mut *writer)
            .await
            .unwrap();

        // 另一池连接读旧快照：不等待写事务，读到提交前的值。
        let mut reader = pool.acquire().await.unwrap();
        let title: String =
            sqlx::query_scalar("SELECT title FROM agent_sessions WHERE id = 'session-1'")
                .fetch_one(&mut *reader)
                .await
                .unwrap();
        assert_eq!(title, "committed-title");

        sqlx::query("COMMIT")
            .execute(&mut *writer)
            .await
            .unwrap();
        // 写提交后，读连接的新查询看到新值（WAL 快照按语句/事务刷新）。
        let title: String =
            sqlx::query_scalar("SELECT title FROM agent_sessions WHERE id = 'session-1'")
                .fetch_one(&mut *reader)
                .await
                .unwrap();
        assert_eq!(title, "pending-title");
        // close() 等待全部借出连接归还——守卫必须先 drop，否则池关闭与守卫
        // 存活互相等待（死锁）。
        drop(writer);
        drop(reader);
        pool.close().await;
    }

    #[tokio::test]
    async fn concurrent_same_id_journal_appends_converge_idempotently() {
        // journal 幂等契约（docs/invariants.md #1）在池化下的回归：两个连接并发
        // append 同一 ID——BEGIN IMMEDIATE 串行化写者，后到者经 SELECT 去重路径
        // 返回 Ok，不出现「双双通过存在性检查后一方 UNIQUE 失败」的竞态。
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("axiom.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(create_options(&path))
            .await
            .unwrap();
        let mut connection = pool.acquire().await.unwrap();
        migrate(&mut connection).await.unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at)
             VALUES ('session-1', 'T', 'system', 'test', 'model', 'idle', 1, 1)",
        )
        .execute(&mut *connection)
        .await
        .unwrap();
        drop(connection);

        let request = AppendSessionJournalEntryRequest {
            id: "journal-race".into(),
            session_id: "session-1".into(),
            sequence: 3,
            kind: "queue".into(),
            queue_kind: Some("steering".into()),
            payload_json: r#"{"draft":"hello"}"#.into(),
            created_at: 42,
        };
        let first = {
            let pool = pool.clone();
            let request = &request;
            async move {
                let mut connection = pool.acquire().await.unwrap();
                append_journal_entry(&mut connection, request).await
            }
        };
        let second = {
            let pool = pool.clone();
            let request = &request;
            async move {
                let mut connection = pool.acquire().await.unwrap();
                append_journal_entry(&mut connection, request).await
            }
        };
        let (first, second) = tokio::join!(first, second);
        first.unwrap();
        second.unwrap();

        let mut connection = pool.acquire().await.unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_session_journal WHERE id = 'journal-race'",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        assert_eq!(count, 1);
        drop(connection);
        pool.close().await;
    }
