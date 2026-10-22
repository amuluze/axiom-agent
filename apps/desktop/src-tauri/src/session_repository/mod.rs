//! Session repository: SQLite-backed persistence for agent sessions,
//! messages, runs, checkpoints, and journals.
//!
//! Split from a single ~4200-line file into focused submodules. The public
//! surface (Tauri commands re-exported from `commands`, and the `pub`
//! request/response types defined here) is unchanged. Internal helpers are
//! `pub(super)` and glob-imported here so the white-box test module
//! (`session_repository_tests.rs` via `use super::*`) sees the same items.

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod branch;
mod checkpoint;
mod commands;
mod config_journal;
mod db_io;
mod lifecycle;
mod messages;
mod query_mutation;
mod recovery;
mod run;
mod turn;

// Re-export all Tauri commands at the module root so lib.rs's
// `use session_repository::{...}` keeps working unchanged.
pub use commands::*;

// Pull every submodule helper into this scope so (a) the request/response
// type impls below can call them, and (b) the `mod tests` white-box tests,
// which do `use super::*`, retain access to the same helpers as before.
#[allow(unused_imports)]
use branch::*;
#[allow(unused_imports)]
use checkpoint::*;
#[allow(unused_imports)]
use config_journal::*;
#[allow(unused_imports)]
use db_io::*;
#[allow(unused_imports)]
use lifecycle::*;
#[allow(unused_imports)]
use messages::*;
#[allow(unused_imports)]
use query_mutation::*;
#[allow(unused_imports)]
use recovery::*;
#[allow(unused_imports)]
use run::*;
#[allow(unused_imports)]
use turn::*;

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_BRANCH_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_BRANCH_MESSAGES: usize = 4096;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_CHECKPOINT_SUMMARY_BYTES: usize = 256 * 1024;
const MAX_READ_PROGRESS_ENTRIES: usize = 32;
const MAX_TOOL_LEDGER_ENTRIES: usize = 64;
const MAX_LOADED_SKILL_ENTRIES: usize = 16;
const MAX_SDD_REVIEW_ENTRIES: usize = 8;
const CHECKPOINT_MESSAGE_ID_BATCH_SIZE: usize = 500;
const RECOVERY_RUN_ID_BATCH_SIZE: usize = 500;
const MAX_TURN_MUTATION_BATCHES: usize = 100;
const MAX_PARAMETERS: usize = 32;
const MAX_JOURNAL_ENTRIES: usize = 256;
const MAX_PROVIDER_PROFILE_MIGRATIONS: usize = 4096;
const INTERRUPTED_TOOL_RESULT_CONTENT: &str =
    "工具调用未形成完整的持久化结果，应用可能在收尾阶段退出。为避免重复副作用，Axiom 未自动重放此工具调用；请确认当前状态后再决定是否重试。";
/// 工具执行已完成、但结果因应用退出未保存的占位文案：副作用很可能已生效，
/// 模型必须先确认状态，切勿盲目重放。
const COMPLETED_TOOL_RESULT_CONTENT: &str =
    "此工具调用已执行完成，但结果因应用退出未保存。请先确认该副作用是否已生效，再决定是否重试，切勿盲目重放。";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionRepositoryQuery {
    Sessions,
    SettledRunCount,
    SessionCount,
    MessageCount,
    RunCount,
    ToolExecutionCount,
    ProviderRequestCount,
    CheckpointCount,
    ArtifactCount,
    ArtifactBytes,
    PageCount,
    PageSize,
    UnreferencedArtifacts,
    Artifacts,
}

impl SessionRepositoryQuery {
    fn statement(self) -> &'static str {
        match self {
            Self::Sessions => "SELECT * FROM agent_sessions ORDER BY updated_at DESC",
            Self::SettledRunCount => {
                "SELECT COUNT(*) AS count FROM agent_runs
                 WHERE id = ? AND session_id = ? AND status != 'running'"
            }
            Self::SessionCount => "SELECT COUNT(*) AS count FROM agent_sessions",
            Self::MessageCount => "SELECT COUNT(*) AS count FROM agent_messages",
            Self::RunCount => "SELECT COUNT(*) AS count FROM agent_runs",
            Self::ToolExecutionCount => "SELECT COUNT(*) AS count FROM tool_executions",
            Self::ProviderRequestCount => "SELECT COUNT(*) AS count FROM provider_requests",
            Self::CheckpointCount => "SELECT COUNT(*) AS count FROM context_checkpoints",
            Self::ArtifactCount => "SELECT COUNT(*) AS count FROM artifacts",
            Self::ArtifactBytes => "SELECT SUM(size_bytes) AS total FROM artifacts",
            Self::PageCount => "PRAGMA page_count",
            Self::PageSize => "PRAGMA page_size",
            Self::UnreferencedArtifacts => {
                // R1-4：自动清理路径必须与手动 `gc_artifacts` 命令同一权威引用集——测试运行的
                // 计划快照（test_runs.plan_content_hash）与步骤证据（test_step_runs.evidence_content_hash）
                // 同样是报告的一部分，漏掉会在下一步清理里把被引用的 artifact 移入回收区并删行，
                // 留下「test_runs 指向已消失的 artifact」的悬空引用（H1-4 故障窗口实测到）。
                "SELECT a.id, a.content_hash, a.size_bytes
                 FROM artifacts a
                 WHERE NOT EXISTS (SELECT 1 FROM agent_messages m WHERE m.artifact_id = a.id)
                   AND NOT EXISTS (SELECT 1 FROM tool_executions t WHERE t.artifact_id = a.id)
                   AND NOT EXISTS (SELECT 1 FROM test_runs r WHERE r.plan_content_hash = a.content_hash)
                   AND NOT EXISTS (SELECT 1 FROM test_step_runs s WHERE s.evidence_content_hash = a.content_hash)"
            }
            Self::Artifacts => "SELECT id, content_hash, size_bytes FROM artifacts",
        }
    }

    fn parameter_count(self) -> usize {
        match self {
            Self::Sessions
            | Self::SessionCount
            | Self::MessageCount
            | Self::RunCount
            | Self::ToolExecutionCount
            | Self::ProviderRequestCount
            | Self::CheckpointCount
            | Self::ArtifactCount
            | Self::ArtifactBytes
            | Self::PageCount
            | Self::PageSize
            | Self::UnreferencedArtifacts
            | Self::Artifacts => 0,
            Self::SettledRunCount => 2,
        }
    }
}

#[cfg(test)]
const ALL_QUERIES: &[SessionRepositoryQuery] = &[
    SessionRepositoryQuery::Sessions,
    SessionRepositoryQuery::SettledRunCount,
    SessionRepositoryQuery::SessionCount,
    SessionRepositoryQuery::MessageCount,
    SessionRepositoryQuery::RunCount,
    SessionRepositoryQuery::ToolExecutionCount,
    SessionRepositoryQuery::ProviderRequestCount,
    SessionRepositoryQuery::CheckpointCount,
    SessionRepositoryQuery::ArtifactCount,
    SessionRepositoryQuery::ArtifactBytes,
    SessionRepositoryQuery::PageCount,
    SessionRepositoryQuery::PageSize,
    SessionRepositoryQuery::UnreferencedArtifacts,
    SessionRepositoryQuery::Artifacts,
];

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionRepositoryMutation {
    CreateSession,
    RenameSession,
    RenameSessionIfTitle,
    ArchiveSession,
    RestoreSession,
    UpdateSessionAccessMode,
    ClearWorkspaceForPath,
}

impl SessionRepositoryMutation {
    fn statement(self) -> &'static str {
        match self {
            Self::CreateSession => {
                "INSERT INTO agent_sessions
                 (id, title, system_prompt, model_provider, model_id, reasoning_json,
                  active_tool_names_json, provider_config_json, runtime_manifest_json,
                  workspace_path, workspace_name,
                  status, created_at, updated_at)
                 VALUES (?, '新会话', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)"
            }
            Self::RenameSession => {
                "UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?"
            }
            Self::RenameSessionIfTitle => {
                "UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ?"
            }
            Self::ArchiveSession => {
                "UPDATE agent_sessions
                 SET archived_at = ?, access_mode = 'standard', updated_at = ? WHERE id = ?"
            }
            Self::RestoreSession => {
                "UPDATE agent_sessions SET archived_at = NULL, updated_at = ? WHERE id = ?"
            }
            Self::UpdateSessionAccessMode => {
                "UPDATE agent_sessions SET access_mode = ?, updated_at = ? WHERE id = ?"
            }
            Self::ClearWorkspaceForPath => {
                "UPDATE agent_sessions SET workspace_path = NULL, workspace_name = NULL, updated_at = ? WHERE workspace_path = ?"
            }
        }
    }

    fn parameter_count(self) -> usize {
        match self {
            Self::RenameSession | Self::UpdateSessionAccessMode => 3,
            Self::RenameSessionIfTitle => 4,
            Self::CreateSession => 12,
            Self::ArchiveSession => 3,
            Self::RestoreSession => 2,
            Self::ClearWorkspaceForPath => 2,
        }
    }
}

#[cfg(test)]
const ALL_MUTATIONS: &[SessionRepositoryMutation] = &[
    SessionRepositoryMutation::CreateSession,
    SessionRepositoryMutation::RenameSession,
    SessionRepositoryMutation::RenameSessionIfTitle,
    SessionRepositoryMutation::ArchiveSession,
    SessionRepositoryMutation::RestoreSession,
    SessionRepositoryMutation::UpdateSessionAccessMode,
    SessionRepositoryMutation::ClearWorkspaceForPath,
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalTransition {
    Consuming,
    RestorePending,
    Recovered,
    Applied,
    Discarded,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalTransitionRequest {
    session_id: String,
    entry_ids: Vec<String>,
    transition: JournalTransition,
    run_id: Option<String>,
    now: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearSessionRepositoryRequest {
    session_id: String,
    now: i64,
    delete_session: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSessionRuntimeConfigRequest {
    session_id: String,
    system_prompt: String,
    model_provider: String,
    model_id: String,
    reasoning_json: Option<String>,
    active_tool_names_json: String,
    provider_config_json: Option<String>,
    runtime_manifest_json: Option<String>,
    now: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfileMigration {
    session_id: String,
    expected_provider_config_json: String,
    provider_config_json: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrateSessionProviderProfilesRequest {
    migrations: Vec<ProviderProfileMigration>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteSessionWithSuccessorRequest {
    session_id: String,
    successor_id: String,
    system_prompt: String,
    model_provider: String,
    model_id: String,
    reasoning_json: Option<String>,
    active_tool_names_json: String,
    provider_config_json: Option<String>,
    runtime_manifest_json: Option<String>,
    now: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeSessionRuntimeDefaultsRequest {
    model_provider: String,
    model_id: String,
    provider_config_json: Option<String>,
    runtime_manifest_json: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendSessionJournalEntryRequest {
    id: String,
    session_id: String,
    sequence: i64,
    kind: String,
    queue_kind: Option<String>,
    payload_json: String,
    created_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSessionRunRequest {
    run_id: String,
    session_id: String,
    now: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartProviderRequestRequest {
    request_id: String,
    session_id: String,
    run_id: String,
    assistant_message_id: String,
    model_provider: String,
    model_id: String,
    message_count: i64,
    tool_count: i64,
    started_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiveProviderResponseRequest {
    request_id: String,
    session_id: String,
    run_id: String,
    assistant_message_id: String,
    response_id: Option<String>,
    response_model: Option<String>,
    response_message_json: String,
    response_received_at: i64,
}

type ProviderRequestStartRecord = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    String,
);
type ProviderResponseRecord = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type StoredMessageRecord = (String, Option<String>, String, i64, String, Option<String>);
type CompletedToolRecord = (
    String,
    Option<String>,
    Option<String>,
    String,
    Option<i64>,
    String,
    Option<i64>,
    Option<String>,
    String,
);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartToolExecutionRequest {
    session_id: String,
    run_id: String,
    tool_call_id: String,
    tool_name: String,
    arguments_json: String,
    approval_state: String,
    recovery_policy: String,
    idempotency_key: Option<String>,
    started_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishSessionRunRequest {
    session_id: String,
    run_id: String,
    end_reason: String,
    error_message: Option<String>,
    now: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettleSessionRunRequest {
    session_id: String,
    run_id: String,
    message_count: i64,
    last_message_id: Option<String>,
    checkpoint_id: Option<String>,
    now: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSessionTurnPointRequest {
    session_id: String,
    run_id: String,
    turn: i64,
    mutation_batch_ids: Vec<String>,
    had_pending_mutations: bool,
    message_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint_id: Option<String>,
    created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSessionMessageRequest {
    session_id: String,
    run_id: Option<String>,
    consumed_journal_entry_id: Option<String>,
    message_id: String,
    role: String,
    content_json: String,
    created_at: i64,
    session_title: Option<String>,
    tool_execution: Option<SessionToolExecutionCompletion>,
    now: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionToolExecutionCompletion {
    tool_call_id: String,
    tool_name: String,
    result_preview: String,
    details_json: Option<String>,
    is_error: bool,
    approval_state: String,
    approval_source: String,
    ended_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionMessageArtifact {
    id: String,
    kind: String,
    media_type: String,
    relative_path: String,
    content_hash: String,
    size_bytes: i64,
    created_at: i64,
}

/// 单文件确定性读取游标（nextOffset 为 null 表示已读完整）。与 TS 侧
/// ReadProgressCursor 一一对应；read_progress 用 BTreeMap 保证序列化确定性，
/// 因为 save_checkpoint 幂等比对按 facts_json 字符串精确比较。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionReadProgressCursor {
    #[specta(type = Option<specta_typescript::Number>)]
    next_offset: Option<i64>,
    #[specta(type = specta_typescript::Number)]
    total_lines: i64,
    truncated: bool,
    sha256: String,
}

/// 确定性执行账本条目的 Rust 镜像（id = toolCallId）。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionToolLedgerEntry {
    id: String,
    tool: String,
    #[serde(default)]
    path: Option<String>,
    status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionLoadedSkillEntry {
    name: String,
    source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSddReviewEntry {
    reviewer: String,
    verdict: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionCheckpointFacts {
    read_files: Vec<String>,
    modified_files: Vec<String>,
    /// 旧 checkpoint 无此字段；反序列化缺失时默认为空（向后兼容）。
    #[serde(default)]
    read_progress: std::collections::BTreeMap<String, SessionReadProgressCursor>,
    /// 旧 checkpoint 无此字段；反序列化缺失时默认为空（向后兼容）。
    #[serde(default)]
    tool_ledger: Vec<SessionToolLedgerEntry>,
    /// 旧 checkpoint 无此字段；反序列化缺失时默认为空（向后兼容）。
    #[serde(default)]
    loaded_skills: Vec<SessionLoadedSkillEntry>,
    /// 旧 checkpoint 无此字段；反序列化缺失时默认为空（向后兼容）。
    #[serde(default)]
    sdd_reviews: Vec<SessionSddReviewEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSessionCheckpointRequest {
    id: String,
    session_id: String,
    through_message_id: String,
    summary: String,
    summary_hash: String,
    reason: String,
    #[specta(type = specta_typescript::Number)]
    tokens_before: f64,
    #[specta(type = specta_typescript::Number)]
    estimated_tokens_after: f64,
    #[specta(type = specta_typescript::Number)]
    request_bytes_before: f64,
    #[specta(type = specta_typescript::Number)]
    request_bytes_after: f64,
    model_provider: String,
    model_id: String,
    #[specta(type = specta_typescript::Number)]
    prompt_version: i64,
    excluded_message_ids: Vec<String>,
    facts: SessionCheckpointFacts,
    #[specta(type = specta_typescript::Number)]
    created_at: f64,
}

struct PersistedCheckpointMessage {
    role: String,
    value: Value,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverSessionRepositoryResult {
    recovered_runs: u64,
    /// 已收到 Provider response（成果会由恢复结算）的中断 run 数。
    completed_runs: u64,
    /// 最后一次持久化信号为工具失败的中断 run 数。
    failed_runs: u64,
    /// 在途、无持久化结果可判定的中断 run 数。
    unknown_runs: u64,
    /// 被中断、可能从未执行的工具调用数。
    interrupted_tool_executions: u64,
    /// 已执行（完成或失败）但结果未保存、可能已产生落地副作用的工具调用数。
    possibly_executed_tool_executions: u64,
    /// 受影响会话（含中断 run）的 id，按字典序。
    recovered_sessions: Vec<String>,
}

struct InterruptedToolCandidate {
    session_id: String,
    run_id: String,
    tool_call_id: String,
    tool_name: String,
    recovery_policy: String,
    /// 'completed'：工具已执行完成但结果未保存；'interrupted'：工具可能未执行。
    execution_state: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBranchMessageRequest {
    id: String,
    role: String,
    content_json: String,
    created_at: i64,
    source_message_id: Option<String>,
    artifact_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSessionBranchRequest {
    id: String,
    title: String,
    system_prompt: String,
    model_provider: String,
    model_id: String,
    reasoning_json: Option<String>,
    active_tool_names_json: String,
    provider_config_json: Option<String>,
    runtime_manifest_json: Option<String>,
    workspace_path: Option<String>,
    workspace_name: Option<String>,
    source_session_id: String,
    through_message_id: String,
    kind: String,
    retried_message_id: Option<String>,
    created_at: i64,
    activated_at: i64,
    messages: Vec<SessionBranchMessageRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDatabaseExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshotRows {
    session: Option<Value>,
    messages: Vec<Value>,
    latest_checkpoint: Option<Value>,
    pending_journal: Vec<Value>,
}

#[cfg(test)]
#[path = "../session_repository_tests.rs"]
mod tests;

// Re-export foreign crate items used by the white-box test module so that its
// `use super::*` continues to resolve them (in the original single-file layout
// these `use`s lived at the top of the same file the tests inherited from).
#[cfg(test)]
pub(crate) use crate::artifacts::MAX_ARTIFACT_BYTES;
#[cfg(test)]
pub(crate) use crate::session_schema::{
    create_options, migrate, migrate_to, DATABASE_VERSION, MIGRATIONS,
};
#[cfg(test)]
pub(crate) use sha2::{Digest, Sha256};
#[cfg(test)]
pub(crate) use sqlx::sqlite::SqliteConnection;
#[cfg(test)]
pub(crate) use sqlx::{Connection, Executor};
