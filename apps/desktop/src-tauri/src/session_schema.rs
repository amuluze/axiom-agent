//! Session Repository SQLite schema 迁移定义与执行。
//!
//! 从 `session_repository` 拆出的纯 schema 层:版本常量、各版本
//! DDL/COLUMN 迁移声明,以及 `migrate` 执行器。事务入口仍由
//! `session_repository` 持有,本模块不接触业务逻辑。

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{ConnectOptions as _, Connection, Executor, Row, SqliteConnection};
use std::path::Path;
use std::time::Duration;

pub(crate) const DATABASE_VERSION: i64 = 15;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(10);

/// Provider / connect 凭据表（v15 起密钥由 macOS Keychain 迁入 SQLite，Rust 独占读写）。
/// v15 迁移与 secrets 惰性建表共用同一 DDL（幂等）：密钥操作可能先于
/// `initialize_session_repository` 的 migrate 执行（如 setup 阶段的 connect 长连接）。
pub(crate) const SECRETS_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS secrets (\
secret_key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)";

#[derive(Clone, Copy)]
pub(crate) struct ColumnMigration {
    pub(crate) table: &'static str,
    pub(crate) column: &'static str,
    pub(crate) statement: &'static str,
}

pub(crate) struct Migration {
    pub(crate) version: i64,
    pub(crate) statements: &'static [&'static str],
    pub(crate) columns: &'static [ColumnMigration],
    pub(crate) post_statements: &'static [&'static str],
}

const V1_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS agent_sessions (
       id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, system_prompt TEXT NOT NULL,
       model_provider TEXT NOT NULL, model_id TEXT NOT NULL, status TEXT NOT NULL,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS agent_runs (
       id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL,
       end_reason TEXT, error_message TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
       FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
     )",
    "CREATE TABLE IF NOT EXISTS agent_messages (
       id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, run_id TEXT,
       sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL,
       created_at INTEGER NOT NULL, UNIQUE (session_id, sequence),
       FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
       FOREIGN KEY (run_id) REFERENCES agent_runs(id)
     )",
    "CREATE TABLE IF NOT EXISTS tool_executions (
       run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
       arguments_json TEXT NOT NULL, result_preview TEXT, details_json TEXT,
       status TEXT NOT NULL, is_error INTEGER, approval_state TEXT NOT NULL,
       started_at INTEGER NOT NULL, ended_at INTEGER,
       PRIMARY KEY (run_id, tool_call_id),
       FOREIGN KEY (run_id) REFERENCES agent_runs(id)
     )",
    "CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_sequence ON agent_messages(session_id, sequence)",
    "CREATE INDEX IF NOT EXISTS idx_agent_runs_session_started ON agent_runs(session_id, started_at DESC)",
];

const V2_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS context_checkpoints (
       id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
       through_message_id TEXT NOT NULL, summary TEXT NOT NULL, summary_hash TEXT NOT NULL,
       reason TEXT NOT NULL, tokens_before INTEGER NOT NULL,
       estimated_tokens_after INTEGER NOT NULL, request_bytes_before INTEGER NOT NULL,
       request_bytes_after INTEGER NOT NULL, model_provider TEXT NOT NULL,
       model_id TEXT NOT NULL, prompt_version INTEGER NOT NULL,
       excluded_message_ids_json TEXT NOT NULL, facts_json TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
       FOREIGN KEY (through_message_id) REFERENCES agent_messages(id)
     )",
    "CREATE INDEX IF NOT EXISTS idx_context_checkpoints_session_created ON context_checkpoints(session_id, created_at DESC)",
];

const V3_COLUMNS: &[ColumnMigration] = &[
    ColumnMigration { table: "agent_sessions", column: "parent_session_id", statement: "ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL" },
    ColumnMigration { table: "agent_sessions", column: "forked_from_message_id", statement: "ALTER TABLE agent_sessions ADD COLUMN forked_from_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL" },
    ColumnMigration { table: "agent_sessions", column: "branch_kind", statement: "ALTER TABLE agent_sessions ADD COLUMN branch_kind TEXT CHECK (branch_kind IS NULL OR branch_kind IN ('branch', 'retry'))" },
    ColumnMigration { table: "agent_sessions", column: "retried_message_id", statement: "ALTER TABLE agent_sessions ADD COLUMN retried_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL" },
    ColumnMigration { table: "agent_messages", column: "source_message_id", statement: "ALTER TABLE agent_messages ADD COLUMN source_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL" },
];
const V3_POST_STATEMENTS: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions(parent_session_id)",
    "CREATE INDEX IF NOT EXISTS idx_agent_messages_source ON agent_messages(source_message_id)",
];

const V4_COLUMNS: &[ColumnMigration] = &[
    ColumnMigration { table: "agent_messages", column: "artifact_id", statement: "ALTER TABLE agent_messages ADD COLUMN artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL" },
    ColumnMigration { table: "tool_executions", column: "artifact_id", statement: "ALTER TABLE tool_executions ADD COLUMN artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL" },
];
const V4_STATEMENTS: &[&str] = &["CREATE TABLE IF NOT EXISTS artifacts (
       id TEXT PRIMARY KEY NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('text', 'json', 'image')),
       media_type TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
       content_hash TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
       created_at INTEGER NOT NULL
     )"];
const V4_POST_STATEMENTS: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_agent_messages_artifact ON agent_messages(artifact_id)",
    "CREATE INDEX IF NOT EXISTS idx_tool_executions_artifact ON tool_executions(artifact_id)",
];

const V5_COLUMNS: &[ColumnMigration] = &[
    ColumnMigration { table: "agent_sessions", column: "reasoning_json", statement: "ALTER TABLE agent_sessions ADD COLUMN reasoning_json TEXT" },
    ColumnMigration { table: "agent_sessions", column: "active_tool_names_json", statement: "ALTER TABLE agent_sessions ADD COLUMN active_tool_names_json TEXT NOT NULL DEFAULT '[]'" },
];

const V6_COLUMNS: &[ColumnMigration] = &[
    ColumnMigration {
        table: "agent_sessions",
        column: "provider_config_json",
        statement: "ALTER TABLE agent_sessions ADD COLUMN provider_config_json TEXT",
    },
    ColumnMigration {
        table: "agent_runs",
        column: "latest_turn_save_point_json",
        statement: "ALTER TABLE agent_runs ADD COLUMN latest_turn_save_point_json TEXT",
    },
];
const V6_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS runtime_mutation_batches (
       id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, run_id TEXT, turn INTEGER,
       event_count INTEGER NOT NULL CHECK (event_count > 0), created_at INTEGER NOT NULL,
       committed_at INTEGER NOT NULL,
       FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
       FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
     )",
    "CREATE INDEX IF NOT EXISTS idx_runtime_mutation_batches_session ON runtime_mutation_batches(session_id, committed_at DESC)",
];

const V7_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS agent_session_journal (
       id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
       sequence INTEGER NOT NULL CHECK (sequence >= 0),
       kind TEXT NOT NULL CHECK (kind IN ('queue', 'message_append', 'runtime_update')),
       queue_kind TEXT CHECK (queue_kind IS NULL OR queue_kind IN ('steering', 'follow-up', 'next-turn')),
       payload_json TEXT NOT NULL,
       status TEXT NOT NULL CHECK (status IN ('pending', 'consuming', 'applied', 'discarded')),
       consumer_run_id TEXT, created_at INTEGER NOT NULL, applied_at INTEGER,
       UNIQUE (session_id, sequence),
       FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
       FOREIGN KEY (consumer_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL,
       CHECK ((kind = 'queue' AND queue_kind IS NOT NULL) OR (kind <> 'queue' AND queue_kind IS NULL))
     )",
    "CREATE INDEX IF NOT EXISTS idx_agent_session_journal_pending ON agent_session_journal(session_id, status, sequence)",
];

const V8_COLUMNS: &[ColumnMigration] = &[ColumnMigration {
    table: "agent_session_journal",
    column: "recovered_at",
    statement: "ALTER TABLE agent_session_journal ADD COLUMN recovered_at INTEGER
      CHECK (recovered_at IS NULL OR
        (recovered_at >= 0 AND kind = 'queue' AND status = 'pending' AND consumer_run_id IS NULL))",
}];

const V9_COLUMNS: &[ColumnMigration] = &[
    ColumnMigration { table: "agent_sessions", column: "runtime_manifest_json", statement: "ALTER TABLE agent_sessions ADD COLUMN runtime_manifest_json TEXT" },
    ColumnMigration { table: "tool_executions", column: "recovery_policy", statement: "ALTER TABLE tool_executions ADD COLUMN recovery_policy TEXT NOT NULL DEFAULT 'never' CHECK (recovery_policy IN ('never', 'idempotent'))" },
    ColumnMigration { table: "tool_executions", column: "idempotency_key", statement: "ALTER TABLE tool_executions ADD COLUMN idempotency_key TEXT" },
];
const V9_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS provider_requests (
       id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
       assistant_message_id TEXT NOT NULL, model_provider TEXT NOT NULL, model_id TEXT NOT NULL,
       message_count INTEGER NOT NULL CHECK (message_count >= 0),
       tool_count INTEGER NOT NULL CHECK (tool_count >= 0),
       status TEXT NOT NULL CHECK (status IN ('running', 'response_received', 'committed', 'interrupted')),
       response_id TEXT, response_model TEXT, response_message_json TEXT,
       started_at INTEGER NOT NULL, response_received_at INTEGER, committed_at INTEGER,
       FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
       FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
       UNIQUE (run_id, assistant_message_id)
     )",
    "CREATE INDEX IF NOT EXISTS idx_provider_requests_session_started ON provider_requests(session_id, started_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_provider_requests_recovery ON provider_requests(status, started_at)",
];
const V10_STATEMENTS: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status)",
    "CREATE INDEX IF NOT EXISTS idx_agent_runs_status_started ON agent_runs(status, started_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_agent_messages_run_sequence ON agent_messages(run_id, sequence)",
    "CREATE INDEX IF NOT EXISTS idx_tool_executions_status_run ON tool_executions(status, run_id)",
    "CREATE INDEX IF NOT EXISTS idx_agent_session_journal_status_sequence ON agent_session_journal(status, session_id, sequence)",
];
const V11_COLUMNS: &[ColumnMigration] = &[ColumnMigration {
    table: "runtime_mutation_batches",
    column: "effect_hash",
    statement: "ALTER TABLE runtime_mutation_batches ADD COLUMN effect_hash TEXT",
}];
const V12_COLUMNS: &[ColumnMigration] = &[ColumnMigration {
    table: "agent_sessions",
    column: "message_count",
    statement: "ALTER TABLE agent_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
}];
const V12_POST_STATEMENTS: &[&str] = &[
    "UPDATE agent_sessions
     SET message_count = (SELECT COUNT(*) FROM agent_messages WHERE session_id = agent_sessions.id)",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_messages_count_insert
     AFTER INSERT ON agent_messages
     BEGIN
       UPDATE agent_sessions SET message_count = message_count + 1 WHERE id = NEW.session_id;
     END",
    "CREATE TRIGGER IF NOT EXISTS trg_agent_messages_count_delete
     AFTER DELETE ON agent_messages
     BEGIN
       UPDATE agent_sessions SET message_count = message_count - 1 WHERE id = OLD.session_id;
     END",
];

const V13_COLUMNS: &[ColumnMigration] = &[
    ColumnMigration {
        table: "agent_sessions",
        column: "workspace_path",
        statement: "ALTER TABLE agent_sessions ADD COLUMN workspace_path TEXT",
    },
    ColumnMigration {
        table: "agent_sessions",
        column: "workspace_name",
        statement: "ALTER TABLE agent_sessions ADD COLUMN workspace_name TEXT",
    },
];

const V14_COLUMNS: &[ColumnMigration] = &[ColumnMigration {
    table: "agent_sessions",
    column: "archived_at",
    statement: "ALTER TABLE agent_sessions ADD COLUMN archived_at INTEGER",
}];

const V15_STATEMENTS: &[&str] = &[SECRETS_TABLE_DDL];

pub(crate) const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        statements: V1_STATEMENTS,
        columns: &[],
        post_statements: &[],
    },
    Migration {
        version: 2,
        statements: V2_STATEMENTS,
        columns: &[],
        post_statements: &[],
    },
    Migration {
        version: 3,
        statements: &[],
        columns: V3_COLUMNS,
        post_statements: V3_POST_STATEMENTS,
    },
    Migration {
        version: 4,
        statements: V4_STATEMENTS,
        columns: V4_COLUMNS,
        post_statements: V4_POST_STATEMENTS,
    },
    Migration {
        version: 5,
        statements: &[],
        columns: V5_COLUMNS,
        post_statements: &[],
    },
    Migration {
        version: 6,
        statements: V6_STATEMENTS,
        columns: V6_COLUMNS,
        post_statements: &[],
    },
    Migration {
        version: 7,
        statements: V7_STATEMENTS,
        columns: &[],
        post_statements: &[],
    },
    Migration {
        version: 8,
        statements: &[],
        columns: V8_COLUMNS,
        post_statements: &[],
    },
    Migration {
        version: 9,
        statements: V9_STATEMENTS,
        columns: V9_COLUMNS,
        post_statements: &[],
    },
    Migration {
        version: 10,
        statements: V10_STATEMENTS,
        columns: &[],
        post_statements: &[],
    },
    Migration {
        version: 11,
        statements: &[],
        columns: V11_COLUMNS,
        post_statements: &[],
    },
    Migration {
        version: 12,
        statements: &[],
        columns: V12_COLUMNS,
        post_statements: V12_POST_STATEMENTS,
    },
    Migration {
        version: 13,
        statements: &[],
        columns: V13_COLUMNS,
        post_statements: &[],
    },
    Migration {
        version: 14,
        statements: &[],
        columns: V14_COLUMNS,
        post_statements: &[],
    },
    Migration {
        version: 15,
        statements: V15_STATEMENTS,
        columns: &[],
        post_statements: &[],
    },
];
pub(crate) fn create_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        // WAL 持久于 DB 文件，选项兜底全新库；foreign_keys 是 per-connection
        // 开关——池化后每个连接都要显式开启（此前靠 init 时 migrate_to 的
        // 一次性 PRAGMA，单连接下恰好覆盖全程，池连接不会继承）。
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .disable_statement_logging()
}

/// 只读/普通打开既有 SQLite 文件（不建库、无 WAL/foreign_keys 预设）：
/// 供测试直接检查落盘文件，以及完整性校验等场景。
#[cfg(test)]
pub(crate) fn sqlite_options(path: &Path, read_only: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(read_only)
        .immutable(read_only)
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .disable_statement_logging()
}

async fn has_column(
    connection: &mut SqliteConnection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    let statement = format!("PRAGMA table_info({table})");
    let rows = sqlx::query(&statement)
        .fetch_all(connection)
        .await
        .map_err(|error| format!("无法读取 SQLite 表结构：{error}"))?;
    Ok(rows.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == column)
    }))
}

pub(crate) async fn migrate_to(
    connection: &mut SqliteConnection,
    target_version: i64,
) -> Result<(), String> {
    if !(0..=DATABASE_VERSION).contains(&target_version) {
        return Err("目标 SQLite schema 版本无效".to_string());
    }
    connection
        .execute("PRAGMA foreign_keys = ON")
        .await
        .map_err(|error| format!("无法启用 SQLite 外键：{error}"))?;
    connection
        .execute("PRAGMA journal_mode = WAL")
        .await
        .map_err(|error| format!("无法启用 SQLite WAL：{error}"))?;
    let current: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("无法读取 SQLite schema 版本：{error}"))?;
    if current > target_version {
        return Err("Axiom SQLite 数据库版本高于当前应用支持版本".to_string());
    }
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current && migration.version <= target_version)
    {
        let mut missing_columns = Vec::new();
        for column in migration.columns {
            if !has_column(connection, column.table, column.column).await? {
                missing_columns.push(*column);
            }
        }
        let mut transaction = connection.begin().await.map_err(|error| {
            format!("无法开始 SQLite migration v{}：{error}", migration.version)
        })?;
        for statement in migration.statements {
            transaction.execute(*statement).await.map_err(|error| {
                format!("无法执行 SQLite migration v{}：{error}", migration.version)
            })?;
        }
        for column in missing_columns {
            transaction
                .execute(column.statement)
                .await
                .map_err(|error| {
                    format!("无法执行 SQLite migration v{}：{error}", migration.version)
                })?;
        }
        for statement in migration.post_statements {
            transaction.execute(*statement).await.map_err(|error| {
                format!("无法执行 SQLite migration v{}：{error}", migration.version)
            })?;
        }
        transaction
            .execute(format!("PRAGMA user_version = {}", migration.version).as_str())
            .await
            .map_err(|error| format!("无法更新 SQLite schema 版本：{error}"))?;
        transaction.commit().await.map_err(|error| {
            format!("无法提交 SQLite migration v{}：{error}", migration.version)
        })?;
    }
    Ok(())
}

pub(crate) async fn migrate(connection: &mut SqliteConnection) -> Result<(), String> {
    migrate_to(connection, DATABASE_VERSION).await
}
