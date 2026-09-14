use crate::runtime_manifest::{
    validate_bounded_text, validate_identifier, validate_reasoning, validate_runtime_manifest,
};
use crate::session_state::SessionRepositoryState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::HashSet;
use tauri::State;

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 256;
const MAX_MESSAGES: usize = 128;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_SYSTEM_PROMPT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMutationMessage {
    id: String,
    role: String,
    content_json: String,
    created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitSessionMutationBatchRequest {
    batch_id: String,
    session_id: String,
    run_id: Option<String>,
    turn: Option<u32>,
    event_count: usize,
    messages: Vec<SessionMutationMessage>,
    system_prompt: Option<String>,
    model_provider: Option<String>,
    model_id: Option<String>,
    reasoning_updated: bool,
    reasoning_json: Option<String>,
    active_tool_names: Option<Vec<String>>,
    runtime_manifest_json: Option<String>,
    #[serde(default)]
    runtime_dependencies_updated: bool,
    #[serde(default)]
    journal_entry_ids: Vec<String>,
    created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMutationReceipt {
    batch_id: String,
    session_id: String,
    // TS receipt 契约是 optional（undefined 语义），ownership 校验做严格比较；
    // None 必须缺省而非 null，否则每次空闲 mutation 都会被误判不一致。
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn: Option<u32>,
    committed_at: i64,
    replayed: bool,
}

struct ValidatedMessage<'a> {
    request: &'a SessionMutationMessage,
    content: String,
}

fn json_i64(value: &Value, field: &str) -> Result<i64, String> {
    value
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Runtime mutation 消息缺少有效的 {field}"))
}

fn json_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Runtime mutation 消息缺少有效的 {field}"))
}

fn validate_message(message: &SessionMutationMessage) -> Result<ValidatedMessage<'_>, String> {
    validate_identifier("Message ID", &message.id)?;
    if message.created_at < 0 || message.content_json.len() > MAX_MESSAGE_BYTES {
        return Err("Runtime mutation 消息时间或大小无效".to_string());
    }
    if !matches!(message.role.as_str(), "user" | "custom") {
        return Err("Runtime mutation 只允许追加 User 或 Custom 消息".to_string());
    }
    let value: Value = serde_json::from_str(&message.content_json)
        .map_err(|error| format!("Runtime mutation 消息 JSON 无效：{error}"))?;
    if json_string(&value, "id")? != message.id
        || json_string(&value, "role")? != message.role
        || json_i64(&value, "createdAt")? != message.created_at
    {
        return Err("Runtime mutation 消息 DTO 与 content JSON 不一致".to_string());
    }
    let content = json_string(&value, "content")?.to_string();
    Ok(ValidatedMessage {
        request: message,
        content,
    })
}

fn validate_request(
    request: &CommitSessionMutationBatchRequest,
) -> Result<Vec<ValidatedMessage<'_>>, String> {
    let bytes = serde_json::to_vec(request)
        .map_err(|error| format!("无法编码 Runtime mutation batch：{error}"))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("Runtime mutation batch 超过 2 MiB 安全上限".to_string());
    }
    validate_identifier("Mutation batch ID", &request.batch_id)?;
    validate_identifier("Session ID", &request.session_id)?;
    if let Some(run_id) = &request.run_id {
        validate_identifier("Run ID", run_id)?;
    }
    if request.turn == Some(0) || (request.turn.is_some() && request.run_id.is_none()) {
        return Err("Runtime mutation batch 轮次无效".to_string());
    }
    if request.created_at < 0
        || request.event_count == 0
        || request.event_count > MAX_EVENTS
        || request.messages.len() > MAX_MESSAGES
    {
        return Err("Runtime mutation batch 数量或时间无效".to_string());
    }
    if request.model_provider.is_some() != request.model_id.is_some() {
        return Err("Runtime mutation 模型 Provider 与 ID 必须同时更新".to_string());
    }
    if let Some(prompt) = &request.system_prompt {
        validate_bounded_text("System Prompt", prompt, MAX_SYSTEM_PROMPT_BYTES, true)?;
    }
    if let Some(provider) = &request.model_provider {
        validate_bounded_text("模型 Provider", provider, 128, false)?;
    }
    if let Some(model) = &request.model_id {
        validate_bounded_text("模型 ID", model, 256, false)?;
    }
    if request.reasoning_updated {
        if let Some(reasoning) = &request.reasoning_json {
            validate_reasoning(reasoning)?;
        }
    } else if request.reasoning_json.is_some() {
        return Err("Runtime mutation Reasoning 更新标志不一致".to_string());
    }
    if let Some(tool_names) = &request.active_tool_names {
        if tool_names.len() > 256 {
            return Err("Runtime mutation 活动工具数量超过安全上限".to_string());
        }
        let mut unique = HashSet::new();
        for name in tool_names {
            validate_bounded_text("活动工具名称", name, 128, false)?;
            if !unique.insert(name) {
                return Err("Runtime mutation 包含重复活动工具".to_string());
            }
        }
    }
    if request.active_tool_names.is_some() != request.runtime_manifest_json.is_some() {
        return Err("Runtime 工具更新必须原子携带 dependency manifest".to_string());
    }
    if request.runtime_dependencies_updated {
        // runtime_dependencies_update：原子替换 dependencies + 删除 checkpoint，
        // 不能与 model/reasoning 等其它 Runtime mutation 混用；systemPrompt 必填。
        if request.system_prompt.is_none()
            || request.active_tool_names.is_none()
            || request.model_provider.is_some()
            || request.reasoning_updated
        {
            return Err("runtime_dependencies_update 必须独占并携带 systemPrompt/tools/manifest".to_string());
        }
    }
    if let (Some(tool_names), Some(manifest)) =
        (&request.active_tool_names, &request.runtime_manifest_json)
    {
        validate_runtime_manifest(manifest, tool_names)?;
    }
    if request.journal_entry_ids.len() > MAX_EVENTS {
        return Err("Runtime mutation journal entry 数量超过安全上限".to_string());
    }
    let mut journal_ids = HashSet::new();
    for entry_id in &request.journal_entry_ids {
        validate_identifier("Journal entry ID", entry_id)?;
        if !journal_ids.insert(entry_id) {
            return Err("Runtime mutation 包含重复 journal entry ID".to_string());
        }
    }
    let operation_count = request.messages.len()
        + usize::from(request.system_prompt.is_some())
        + usize::from(request.model_provider.is_some())
        + usize::from(request.reasoning_updated)
        + usize::from(request.active_tool_names.is_some())
        + usize::from(request.runtime_dependencies_updated);
    if operation_count == 0 || operation_count > request.event_count {
        return Err("Runtime mutation batch 事件计数与内容不一致".to_string());
    }
    request.messages.iter().map(validate_message).collect()
}

fn canonical_effect_hash(request: &CommitSessionMutationBatchRequest) -> Result<String, String> {
    let messages = request
        .messages
        .iter()
        .map(|message| {
            serde_json::from_str::<Value>(&message.content_json)
                .map_err(|error| format!("无法规范化 Runtime mutation 消息：{error}"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let reasoning = request
        .reasoning_json
        .as_deref()
        .map(|value| {
            serde_json::from_str::<Value>(value)
                .map_err(|error| format!("无法规范化 Runtime mutation Reasoning：{error}"))
        })
        .transpose()?;
    let runtime_manifest = request
        .runtime_manifest_json
        .as_deref()
        .map(|value| {
            validate_runtime_manifest(value, request.active_tool_names.as_deref().unwrap_or(&[]))
        })
        .transpose()?;
    let mut journal_entry_ids = request.journal_entry_ids.clone();
    journal_entry_ids.sort_unstable();
    let effect = serde_json::json!({
        "sessionId": request.session_id,
        "messages": messages,
        "systemPrompt": request.system_prompt,
        "modelProvider": request.model_provider,
        "modelId": request.model_id,
        "reasoningUpdated": request.reasoning_updated,
        "reasoning": reasoning,
        "activeToolNames": request.active_tool_names,
        "runtimeManifest": runtime_manifest,
        "runtimeDependenciesUpdated": request.runtime_dependencies_updated,
        "journalEntryIds": journal_entry_ids,
    });
    let encoded = serde_json::to_vec(&effect)
        .map_err(|error| format!("无法编码 Runtime mutation canonical effect：{error}"))?;
    let digest = Sha256::digest(encoded);
    Ok(digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(""))
}

fn prompt_title(content: &str) -> String {
    let sanitized: String = content
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect();
    let normalized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = normalized.chars().take(80).collect();
    if title.is_empty() {
        "新会话".to_string()
    } else {
        title
    }
}

async fn commit_mutation_batch(
    connection: &mut SqliteConnection,
    request: &CommitSessionMutationBatchRequest,
) -> Result<SessionMutationReceipt, String> {
    let messages = validate_request(request)?;
    let effect_hash = canonical_effect_hash(request)?;
    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT/UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Runtime mutation transaction：{error}"))?;
    let outcome = commit_mutation_batch_locked(connection, request, &messages, &effect_hash).await;
    match outcome {
        Ok(receipt) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| receipt)
            .map_err(|error| format!("无法提交 Runtime mutation transaction：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn commit_mutation_batch_locked(
    connection: &mut SqliteConnection,
    request: &CommitSessionMutationBatchRequest,
    messages: &[ValidatedMessage<'_>],
    effect_hash: &str,
) -> Result<SessionMutationReceipt, String> {
    let existing = sqlx::query(
        "SELECT session_id, run_id, turn, committed_at, effect_hash
         FROM runtime_mutation_batches WHERE id = ?",
    )
    .bind(&request.batch_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法检查 Runtime mutation 幂等状态：{error}"))?;
    if let Some(existing) = existing {
        let session_id: String = existing.get("session_id");
        if session_id != request.session_id {
            return Err("Runtime mutation batch ID 已被其他会话占用".to_string());
        }
        let run_id: Option<String> = existing.get("run_id");
        let turn = existing
            .get::<Option<i64>, _>("turn")
            .map(u32::try_from)
            .transpose()
            .map_err(|_| "Runtime mutation receipt 轮次无效".to_string())?;
        if run_id != request.run_id || turn != request.turn {
            return Err("Runtime mutation batch ID 已被其他 Run/Turn ownership 占用".to_string());
        }
        let stored_hash: Option<String> = existing.get("effect_hash");
        if stored_hash.as_deref() != Some(effect_hash) {
            return Err("Runtime mutation batch ID 已被不一致的 canonical effect 占用".to_string());
        }
        let committed_at: i64 = existing.get("committed_at");
        // 幂等重放路径：此前仅 SELECT，无写入；外层 COMMIT 空事务等价且无害。
        return Ok(SessionMutationReceipt {
            batch_id: request.batch_id.clone(),
            session_id,
            run_id,
            turn,
            committed_at,
            replayed: true,
        });
    }

    let session_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(&request.session_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Runtime mutation 会话：{error}"))?;
    let session_status = session_status.ok_or_else(|| "会话不存在或已被删除".to_string())?;
    if let Some(run_id) = &request.run_id {
        let run_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_runs WHERE id = ? AND session_id = ? AND status = 'running'",
        )
        .bind(run_id)
        .bind(&request.session_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("无法校验 Runtime mutation 运行：{error}"))?;
        if run_count != 1 || session_status != "running" {
            return Err("Runtime mutation batch 对应的运行不可提交".to_string());
        }
    } else {
        let active_run_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_runs WHERE session_id = ? AND status = 'running'",
        )
        .bind(&request.session_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("无法校验 Runtime mutation 活动运行：{error}"))?;
        if session_status != "idle" || active_run_count != 0 {
            return Err("Runless Runtime mutation 只能提交到空闲会话".to_string());
        }
    }

    sqlx::query(
        "INSERT INTO runtime_mutation_batches
         (id, session_id, run_id, turn, event_count, created_at, committed_at, effect_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&request.batch_id)
    .bind(&request.session_id)
    .bind(&request.run_id)
    .bind(request.turn.map(i64::from))
    .bind(i64::try_from(request.event_count).map_err(|_| "事件数量溢出".to_string())?)
    .bind(request.created_at)
    .bind(request.created_at)
    .bind(effect_hash)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法登记 Runtime mutation batch：{error}"))?;

    let mut sequence: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) FROM agent_messages WHERE session_id = ?",
    )
    .bind(&request.session_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法读取 Runtime mutation 消息边界：{error}"))?;

    for message in messages {
        sequence += 1;
        sqlx::query(
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at, artifact_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .bind(&message.request.id)
        .bind(&request.session_id)
        .bind(&request.run_id)
        .bind(sequence)
        .bind(&message.request.role)
        .bind(&message.request.content_json)
        .bind(message.request.created_at)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法写入 Runtime mutation 消息：{error}"))?;
        if message.request.role == "user" {
            sqlx::query(
                "UPDATE agent_sessions
                 SET title = CASE WHEN title = '新会话' THEN ? ELSE title END
                 WHERE id = ?",
            )
            .bind(prompt_title(&message.content))
            .bind(&request.session_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法更新 Runtime mutation 会话标题：{error}"))?;
        }
    }

    if let Some(prompt) = &request.system_prompt {
        sqlx::query("UPDATE agent_sessions SET system_prompt = ? WHERE id = ?")
            .bind(prompt)
            .bind(&request.session_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法更新 Runtime System Prompt：{error}"))?;
    }
    if let (Some(provider), Some(model)) = (&request.model_provider, &request.model_id) {
        sqlx::query("UPDATE agent_sessions SET model_provider = ?, model_id = ? WHERE id = ?")
            .bind(provider)
            .bind(model)
            .bind(&request.session_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法更新 Runtime 模型：{error}"))?;
    }
    if request.reasoning_updated {
        sqlx::query("UPDATE agent_sessions SET reasoning_json = ? WHERE id = ?")
            .bind(&request.reasoning_json)
            .bind(&request.session_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法更新 Runtime Reasoning：{error}"))?;
    }
    if let Some(tool_names) = &request.active_tool_names {
        let encoded = serde_json::to_string(tool_names)
            .map_err(|error| format!("无法编码 Runtime 活动工具：{error}"))?;
        sqlx::query(
            "UPDATE agent_sessions
             SET active_tool_names_json = ?, runtime_manifest_json = ?
             WHERE id = ?",
        )
        .bind(encoded)
        .bind(&request.runtime_manifest_json)
        .bind(&request.session_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法更新 Runtime 活动工具：{error}"))?;
    }
    if request.runtime_dependencies_updated {
        // runtime_dependencies_update：同一事务删除该会话的 context checkpoint，
        // 使旧摘要投影不会在 reload 后继续复用。
        sqlx::query("DELETE FROM context_checkpoints WHERE session_id = ?")
            .bind(&request.session_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法删除 Runtime mutation 上下文检查点：{error}"))?;
    }
    for entry_id in &request.journal_entry_ids {
        let updated = sqlx::query(
            "UPDATE agent_session_journal
             SET status = 'applied', applied_at = ?
             WHERE id = ? AND session_id = ?
               AND kind <> 'queue' AND status IN ('pending', 'consuming')",
        )
        .bind(request.created_at)
        .bind(entry_id)
        .bind(&request.session_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法确认 Runtime mutation journal entry：{error}"))?;
        if updated.rows_affected() != 1 {
            return Err("Runtime mutation journal entry 不存在或状态无效".to_string());
        }
    }
    sqlx::query("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
        .bind(request.created_at)
        .bind(&request.session_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法更新 Runtime mutation 会话时间：{error}"))?;

    Ok(SessionMutationReceipt {
        batch_id: request.batch_id.clone(),
        session_id: request.session_id.clone(),
        run_id: request.run_id.clone(),
        turn: request.turn,
        committed_at: request.created_at,
        replayed: false,
    })
}

#[tauri::command]
pub async fn commit_session_mutation_batch(
    state: State<'_, SessionRepositoryState>,
    request: CommitSessionMutationBatchRequest,
) -> Result<SessionMutationReceipt, String> {
    let mut connection = state.acquire().await?;
    commit_mutation_batch(&mut connection, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_schema::sqlite_options;
    use sqlx::{Connection, Executor};
    use std::path::Path;
    use tempfile::TempDir;

    async fn test_database() -> (TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("axiom.db");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        connection
            .execute(
                "CREATE TABLE agent_sessions (
                   id TEXT PRIMARY KEY, title TEXT NOT NULL, system_prompt TEXT NOT NULL,
                   model_provider TEXT NOT NULL, model_id TEXT NOT NULL, reasoning_json TEXT,
                   active_tool_names_json TEXT NOT NULL, runtime_manifest_json TEXT,
                   status TEXT NOT NULL, updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE agent_runs (
                   id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL
                 );
                 CREATE TABLE artifacts (
                   id TEXT PRIMARY KEY, kind TEXT NOT NULL, media_type TEXT NOT NULL,
                   relative_path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL UNIQUE,
                   size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
                 );
                 CREATE TABLE agent_messages (
                   id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, sequence INTEGER NOT NULL,
                   role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
                   artifact_id TEXT, UNIQUE(session_id, sequence)
                 );
                 CREATE TABLE tool_executions (
                   run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, artifact_id TEXT,
                   PRIMARY KEY(run_id, tool_call_id)
                 );
                 CREATE TABLE runtime_mutation_batches (
                   id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, turn INTEGER,
                   event_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
                   committed_at INTEGER NOT NULL, effect_hash TEXT
                 );
                 CREATE TABLE agent_session_journal (
                   id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
                   status TEXT NOT NULL, applied_at INTEGER
                 );",
            )
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions
             (id, title, system_prompt, model_provider, model_id, active_tool_names_json, status, updated_at)
             VALUES ('session-1', '新会话', 'system', 'test', 'model', '[]', 'idle', 0)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();
        (directory, path)
    }

    fn message(id: &str) -> SessionMutationMessage {
        SessionMutationMessage {
            id: id.to_string(),
            role: "user".to_string(),
            content_json: format!(
                r#"{{"id":"{id}","role":"user","content":"hello","createdAt":1}}"#
            ),
            created_at: 1,
        }
    }

    fn message_with_role(id: &str, role: &str) -> SessionMutationMessage {
        SessionMutationMessage {
            id: id.to_string(),
            role: role.to_string(),
            content_json: format!(
                r#"{{"id":"{id}","role":"{role}","content":"hello","createdAt":1}}"#
            ),
            created_at: 1,
        }
    }

    fn request(
        batch_id: &str,
        messages: Vec<SessionMutationMessage>,
    ) -> CommitSessionMutationBatchRequest {
        CommitSessionMutationBatchRequest {
            batch_id: batch_id.to_string(),
            session_id: "session-1".to_string(),
            run_id: None,
            turn: None,
            event_count: messages.len(),
            messages,
            system_prompt: None,
            model_provider: None,
            model_id: None,
            reasoning_updated: false,
            reasoning_json: None,
            active_tool_names: None,
            runtime_manifest_json: None,
            runtime_dependencies_updated: false,
            journal_entry_ids: Vec::new(),
            created_at: 2,
        }
    }

    async fn count(path: &Path, table: &str) -> i64 {
        let mut connection = SqliteConnection::connect_with(&sqlite_options(path, true))
            .await
            .unwrap();
        let query = format!("SELECT COUNT(*) FROM {table}");
        let count = sqlx::query_scalar(&query)
            .fetch_one(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        count
    }

    async fn commit_at(
        path: &Path,
        request: &CommitSessionMutationBatchRequest,
    ) -> Result<SessionMutationReceipt, String> {
        let mut connection = SqliteConnection::connect_with(&sqlite_options(path, false))
            .await
            .unwrap();
        connection
            .execute("PRAGMA foreign_keys = ON")
            .await
            .unwrap();
        let result = commit_mutation_batch(&mut connection, request).await;
        connection.close().await.unwrap();
        result
    }

    async fn insert_journal(path: &Path, id: &str) {
        let mut connection = SqliteConnection::connect_with(&sqlite_options(path, false))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_session_journal (id, session_id, kind, status)
             VALUES (?, 'session-1', 'message_append', 'pending')",
        )
        .bind(id)
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();
    }

    async fn journal_status(path: &Path, id: &str) -> String {
        let mut connection = SqliteConnection::connect_with(&sqlite_options(path, true))
            .await
            .unwrap();
        let status = sqlx::query_scalar("SELECT status FROM agent_session_journal WHERE id = ?")
            .bind(id)
            .fetch_one(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        status
    }

    fn runtime_manifest(version: &str) -> String {
        let mut manifest: Value = serde_json::from_str(include_str!(
            "../../contracts/runtime-dependency-manifest-v4.json"
        ))
        .unwrap();
        manifest["tools"][1]["version"] = Value::String(version.to_string());
        manifest.to_string()
    }

    #[test]
    fn validates_the_shared_runtime_manifest_v4_contract() {
        let manifest = include_str!("../../contracts/runtime-dependency-manifest-v4.json");
        validate_runtime_manifest(
            manifest,
            &["discover_agent_tools".to_string(), "read".to_string()],
        )
        .unwrap();
    }

    #[test]
    fn rejects_unknown_fields_from_the_shared_runtime_manifest_contract() {
        let manifest =
            include_str!("../../contracts/runtime-dependency-manifest-v4.invalid-extra.json");
        assert!(validate_runtime_manifest(manifest, &[])
            .unwrap_err()
            .contains("未知字段"));
    }

    #[tokio::test]
    async fn rolls_back_the_whole_batch_after_an_intermediate_failure() {
        let (_directory, path) = test_database().await;
        let failed = request(
            "mutation-rollback",
            vec![message("message-1"), message("message-1")],
        );
        assert!(commit_at(&path, &failed).await.is_err());
        assert_eq!(count(&path, "agent_messages").await, 0);
        assert_eq!(count(&path, "runtime_mutation_batches").await, 0);
    }

    #[tokio::test]
    async fn gates_runless_and_run_owned_mutations_by_session_state() {
        let (_directory, path) = test_database().await;
        let mut connection = SqliteConnection::connect_with(&sqlite_options(&path, false))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_runs (id, session_id, status) VALUES ('run-gate', 'session-1', 'running')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("UPDATE agent_sessions SET status = 'running' WHERE id = 'session-1'")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();

        let runless = request(
            "mutation-runless-gate",
            vec![message("message-runless-gate")],
        );
        let error = commit_at(&path, &runless).await.unwrap_err();
        assert_eq!(error, "Runless Runtime mutation 只能提交到空闲会话");

        let mut owned = request("mutation-owned-gate", vec![message("message-owned-gate")]);
        owned.run_id = Some("run-gate".into());
        owned.turn = Some(1);
        commit_at(&path, &owned).await.unwrap();
        assert_eq!(count(&path, "agent_messages").await, 1);
    }

    #[tokio::test]
    async fn rejects_assistant_and_tool_messages_from_the_mutation_writer() {
        let (_directory, path) = test_database().await;
        for role in ["assistant", "tool"] {
            let failed = request(
                &format!("mutation-reject-{role}"),
                vec![message_with_role(&format!("message-{role}"), role)],
            );
            let error = commit_at(&path, &failed).await.unwrap_err();
            assert!(error.contains("只允许追加 User 或 Custom"));
        }
        assert_eq!(count(&path, "agent_messages").await, 0);
        assert_eq!(count(&path, "runtime_mutation_batches").await, 0);
    }

    #[tokio::test]
    async fn retries_only_the_same_owned_canonical_effect() {
        let (_directory, path) = test_database().await;
        insert_journal(&path, "journal-stable").await;
        let mut stable = request("mutation-stable", vec![message("message-stable")]);
        stable.journal_entry_ids = vec!["journal-stable".to_string()];
        let committed = commit_at(&path, &stable).await.unwrap();
        assert!(!committed.replayed);
        assert_eq!(committed.committed_at, 2);

        stable.event_count = 256;
        stable.created_at = 99;
        let replayed = commit_at(&path, &stable).await.unwrap();
        assert!(replayed.replayed);
        assert_eq!(replayed.run_id, None);
        assert_eq!(replayed.turn, None);
        assert_eq!(replayed.committed_at, 2);
        assert_eq!(count(&path, "agent_messages").await, 1);
        assert_eq!(count(&path, "runtime_mutation_batches").await, 1);
        assert_eq!(journal_status(&path, "journal-stable").await, "applied");

        stable.run_id = Some("run-retry".to_string());
        stable.turn = Some(7);
        let ownership_error = commit_at(&path, &stable).await.unwrap_err();
        assert!(ownership_error.contains("Run/Turn ownership"));

        let changed = request("mutation-stable", vec![message("message-changed")]);
        assert!(commit_at(&path, &changed).await.is_err());
        assert_eq!(count(&path, "agent_messages").await, 1);
    }

    #[test]
    fn runless_receipt_omits_ownership_fields_on_the_wire() {
        // TS receipt 契约是 optional（undefined 语义）；None 序列化成 null 会被
        // ownership 严格比较误判为不一致，wire 上必须缺省。
        let runless = SessionMutationReceipt {
            batch_id: "mutation-wire".to_string(),
            session_id: "session-wire".to_string(),
            run_id: None,
            turn: None,
            committed_at: 1,
            replayed: false,
        };
        let value = serde_json::to_value(&runless).unwrap();
        assert!(value.get("runId").is_none());
        assert!(value.get("turn").is_none());
        assert_eq!(value["batchId"], "mutation-wire");

        let owned = SessionMutationReceipt {
            run_id: Some("run-wire".to_string()),
            turn: Some(3),
            ..runless
        };
        let value = serde_json::to_value(&owned).unwrap();
        assert_eq!(value["runId"], "run-wire");
        assert_eq!(value["turn"], 3);
    }

    #[tokio::test]
    async fn rolls_back_messages_and_journal_acknowledgements_when_any_journal_id_is_invalid() {
        let (_directory, path) = test_database().await;
        insert_journal(&path, "journal-valid").await;
        let mut failed = request(
            "mutation-journal-rollback",
            vec![message("message-journal")],
        );
        failed.journal_entry_ids = vec!["journal-valid".to_string(), "journal-missing".to_string()];

        assert!(commit_at(&path, &failed).await.is_err());
        assert_eq!(count(&path, "agent_messages").await, 0);
        assert_eq!(count(&path, "runtime_mutation_batches").await, 0);
        assert_eq!(journal_status(&path, "journal-valid").await, "pending");
    }

    #[tokio::test]
    async fn commits_active_tools_and_runtime_manifest_atomically() {
        let (_directory, path) = test_database().await;
        let mut update = request("mutation-runtime-tools", Vec::new());
        update.event_count = 1;
        update.active_tool_names =
            Some(vec!["discover_agent_tools".to_string(), "read".to_string()]);

        let error = commit_at(&path, &update).await.unwrap_err();
        assert_eq!(error, "Runtime 工具更新必须原子携带 dependency manifest");

        update.runtime_manifest_json = Some(runtime_manifest("2"));
        commit_at(&path, &update).await.unwrap();

        let mut connection = SqliteConnection::connect_with(&sqlite_options(&path, true))
            .await
            .unwrap();
        let row = sqlx::query(
            "SELECT active_tool_names_json, runtime_manifest_json
             FROM agent_sessions WHERE id = 'session-1'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        let active: String = row.get("active_tool_names_json");
        let manifest: String = row.get("runtime_manifest_json");
        connection.close().await.unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&active).unwrap(),
            serde_json::json!(["discover_agent_tools", "read"])
        );
        assert_eq!(
            serde_json::from_str::<Value>(&manifest).unwrap()["tools"][1]["version"],
            "2"
        );
    }
}
