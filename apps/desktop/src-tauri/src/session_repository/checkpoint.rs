use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::HashSet;
use crate::runtime_manifest::validate_identifier;

use super::*;

pub(super) fn validate_checkpoint_paths(paths: &[String], label: &str) -> Result<(), String> {
    let mut unique = HashSet::new();
    if paths
        .iter()
        .any(|path| path.trim().is_empty() || !unique.insert(path))
    {
        return Err(format!("上下文检查点{label}文件事实无效"));
    }
    Ok(())
}

/// 校验确定性读取游标：条数上限、路径非空、与已修改文件冲突、字段形状。
pub(super) fn validate_checkpoint_read_progress(
    read_progress: &std::collections::BTreeMap<String, SessionReadProgressCursor>,
    modified: &HashSet<&str>,
) -> Result<(), String> {
    if read_progress.len() > MAX_READ_PROGRESS_ENTRIES {
        return Err("上下文检查点读取游标超过上限".to_string());
    }
    for (path, cursor) in read_progress {
        if path.trim().is_empty() {
            return Err("上下文检查点读取游标路径无效".to_string());
        }
        if modified.contains(path.as_str()) {
            return Err("上下文检查点文件事实存在读写冲突".to_string());
        }
        if cursor.next_offset.is_some_and(|value| value < 0) {
            return Err("上下文检查点读取游标 nextOffset 无效".to_string());
        }
        if cursor.total_lines < 0 {
            return Err("上下文检查点读取游标 totalLines 无效".to_string());
        }
        if cursor.sha256.trim().is_empty() {
            return Err("上下文检查点读取游标 sha256 无效".to_string());
        }
    }
    Ok(())
}

/// 校验确定性执行账本：条数上限、ID 非空且唯一、工具名非空、状态枚举、路径非空。
pub(super) fn validate_checkpoint_tool_ledger(
    tool_ledger: &[SessionToolLedgerEntry],
) -> Result<(), String> {
    if tool_ledger.len() > MAX_TOOL_LEDGER_ENTRIES {
        return Err("上下文检查点工具账本超过上限".to_string());
    }
    let mut unique = HashSet::new();
    for entry in tool_ledger {
        if entry.id.trim().is_empty() || entry.id.len() > 512 || !unique.insert(entry.id.as_str()) {
            return Err("上下文检查点工具账本 ID 无效或重复".to_string());
        }
        if entry.tool.trim().is_empty() {
            return Err("上下文检查点工具账本工具名无效".to_string());
        }
        if entry.status != "done" && entry.status != "pending" {
            return Err("上下文检查点工具账本状态无效".to_string());
        }
        if entry.path.as_ref().is_some_and(|path| path.trim().is_empty()) {
            return Err("上下文检查点工具账本路径无效".to_string());
        }
    }
    Ok(())
}

pub(super) fn validate_session_checkpoint_request(
    request: &SaveSessionCheckpointRequest,
) -> Result<(String, String), String> {
    let encoded = serde_json::to_vec(request)
        .map_err(|error| format!("无法编码上下文检查点请求：{error}"))?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("上下文检查点请求超过 2 MiB 安全上限".to_string());
    }
    validate_identifier("Checkpoint ID", &request.id)?;
    validate_identifier("Session ID", &request.session_id)?;
    validate_identifier(
        "Checkpoint boundary message ID",
        &request.through_message_id,
    )?;
    if request.summary.trim().is_empty() {
        return Err("上下文检查点摘要不能为空".to_string());
    }
    if request.summary.len() > MAX_CHECKPOINT_SUMMARY_BYTES {
        return Err("上下文检查点摘要超过 256 KiB 持久化上限".to_string());
    }
    let valid_hash = request.summary_hash.len() == 64
        && request
            .summary_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    let expected_hash = format!("{:x}", Sha256::digest(request.summary.as_bytes()));
    if !valid_hash || request.summary_hash != expected_hash {
        return Err("上下文检查点摘要哈希校验失败".to_string());
    }
    if !matches!(
        request.reason.as_str(),
        "token_threshold" | "byte_threshold" | "overflow" | "manual"
    ) {
        return Err("上下文检查点原因无效".to_string());
    }
    if request.model_provider.trim().is_empty() || request.model_id.trim().is_empty() {
        return Err("上下文检查点模型标识无效".to_string());
    }
    if request.prompt_version < 1 {
        return Err("上下文检查点 Prompt 版本无效".to_string());
    }
    for (value, label) in [
        (request.tokens_before, "压缩前 token 数"),
        (request.estimated_tokens_after, "压缩后 token 数"),
        (request.request_bytes_before, "压缩前字节数"),
        (request.request_bytes_after, "压缩后字节数"),
        (request.created_at, "创建时间"),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(format!("上下文检查点 {label} 无效"));
        }
    }
    let mut excluded = HashSet::new();
    for message_id in &request.excluded_message_ids {
        validate_identifier("Checkpoint excluded message ID", message_id)?;
        if !excluded.insert(message_id) {
            return Err("上下文检查点排除消息列表无效".to_string());
        }
    }
    validate_checkpoint_paths(&request.facts.read_files, "已读")?;
    validate_checkpoint_paths(&request.facts.modified_files, "已修改")?;
    let modified: HashSet<&str> = request
        .facts
        .modified_files
        .iter()
        .map(String::as_str)
        .collect();
    if request
        .facts
        .read_files
        .iter()
        .any(|path| modified.contains(path.as_str()))
    {
        return Err("上下文检查点文件事实存在读写冲突".to_string());
    }
    validate_checkpoint_read_progress(&request.facts.read_progress, &modified)?;
    validate_checkpoint_tool_ledger(&request.facts.tool_ledger)?;
    let excluded_json = serde_json::to_string(&request.excluded_message_ids)
        .map_err(|error| format!("无法编码上下文检查点排除消息：{error}"))?;
    let facts_json = serde_json::to_string(&request.facts)
        .map_err(|error| format!("无法编码上下文检查点文件事实：{error}"))?;
    Ok((excluded_json, facts_json))
}

pub(super) fn assistant_tool_call_ids(message: &Value) -> Result<Vec<String>, String> {
    let calls = message
        .get("toolCalls")
        .and_then(Value::as_array)
        .ok_or_else(|| "持久化 Assistant message 缺少有效 ToolCall 列表".to_string())?;
    calls
        .iter()
        .map(|call| {
            let id = json_string(call, "id", "持久化 Assistant ToolCall")?.to_string();
            validate_identifier("Tool Call ID", &id)?;
            Ok(id)
        })
        .collect()
}

pub(super) fn assert_checkpoint_boundary(messages: &[PersistedCheckpointMessage]) -> Result<(), String> {
    let boundary_index = messages
        .len()
        .checked_sub(1)
        .ok_or_else(|| "上下文检查点边界消息尚未持久化到当前会话".to_string())?;
    let boundary = &messages[boundary_index];
    if boundary.role == "assistant" && !assistant_tool_call_ids(&boundary.value)?.is_empty() {
        return Err("上下文检查点边界会拆分 ToolCall/ToolResult 消息组".to_string());
    }
    if boundary.role != "tool" {
        return Ok(());
    }
    let mut first_result_index = boundary_index;
    while first_result_index > 0 && messages[first_result_index - 1].role == "tool" {
        first_result_index -= 1;
    }
    let Some(assistant_index) = first_result_index.checked_sub(1) else {
        return Err("上下文检查点边界会拆分 ToolCall/ToolResult 消息组".to_string());
    };
    let assistant = &messages[assistant_index];
    if assistant.role != "assistant" {
        return Err("上下文检查点边界会拆分 ToolCall/ToolResult 消息组".to_string());
    }
    let expected = assistant_tool_call_ids(&assistant.value)?;
    let expected_set: HashSet<&str> = expected.iter().map(String::as_str).collect();
    let actual: Result<Vec<&str>, String> = messages[first_result_index..=boundary_index]
        .iter()
        .map(|message| json_string(&message.value, "toolCallId", "持久化 ToolResult message"))
        .collect();
    let actual = actual?;
    let actual_set: HashSet<&str> = actual.iter().copied().collect();
    if expected.is_empty()
        || expected_set.len() != expected.len()
        || actual.len() != expected.len()
        || actual_set.len() != expected.len()
        || expected_set != actual_set
    {
        return Err("上下文检查点边界会拆分 ToolCall/ToolResult 消息组".to_string());
    }
    Ok(())
}

pub(super) async fn save_checkpoint(
    connection: &mut SqliteConnection,
    request: &SaveSessionCheckpointRequest,
) -> Result<(), String> {
    let (excluded_json, facts_json) = validate_session_checkpoint_request(request)?;
    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始上下文检查点事务：{error}"))?;
    let outcome = save_checkpoint_locked(connection, request, &excluded_json, &facts_json).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交上下文检查点事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn save_checkpoint_locked(
    connection: &mut SqliteConnection,
    request: &SaveSessionCheckpointRequest,
    excluded_json: &str,
    facts_json: &str,
) -> Result<(), String> {
    let boundary: Option<(String, i64)> = sqlx::query_as(
        "SELECT role, sequence FROM agent_messages
         WHERE id = ? AND session_id = ?",
    )
    .bind(&request.through_message_id)
    .bind(&request.session_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法读取上下文检查点消息边界：{error}"))?;
    let (boundary_role, boundary_sequence) =
        boundary.ok_or_else(|| "上下文检查点边界消息尚未持久化到当前会话".to_string())?;
    let boundary_group_start = if boundary_role == "tool" {
        let group_start: Option<(String, i64)> = sqlx::query_as(
            "SELECT role, sequence FROM agent_messages
             WHERE session_id = ? AND sequence < ? AND role <> 'tool'
             ORDER BY sequence DESC LIMIT 1",
        )
        .bind(&request.session_id)
        .bind(boundary_sequence)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("无法定位上下文检查点原子消息组：{error}"))?;
        match group_start {
            Some((role, sequence)) if role == "assistant" => sequence,
            _ => {
                return Err("上下文检查点边界会拆分 ToolCall/ToolResult 消息组".to_string());
            }
        }
    } else {
        boundary_sequence
    };
    if matches!(boundary_role.as_str(), "assistant" | "tool") {
        let boundary_rows = sqlx::query(
            "SELECT id, role, content_json FROM agent_messages
             WHERE session_id = ? AND sequence BETWEEN ? AND ? ORDER BY sequence ASC",
        )
        .bind(&request.session_id)
        .bind(boundary_group_start)
        .bind(boundary_sequence)
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| format!("无法读取上下文检查点原子消息组：{error}"))?;
        let mut boundary_messages = Vec::with_capacity(boundary_rows.len());
        let mut last_message_id = None;
        for row in boundary_rows {
            let id: String = row
                .try_get("id")
                .map_err(|error| format!("无法读取原子消息组 ID：{error}"))?;
            let role: String = row
                .try_get("role")
                .map_err(|error| format!("无法读取原子消息组角色：{error}"))?;
            let content_json: String = row
                .try_get("content_json")
                .map_err(|error| format!("无法读取原子消息组 JSON：{error}"))?;
            let value: Value = serde_json::from_str(&content_json)
                .map_err(|error| format!("持久化原子消息组 JSON 无效：{error}"))?;
            if json_string(&value, "id", "持久化原子消息组")? != id
                || json_string(&value, "role", "持久化原子消息组")? != role
            {
                return Err("持久化原子消息组索引与 JSON 不一致".to_string());
            }
            last_message_id = Some(id);
            boundary_messages.push(PersistedCheckpointMessage { role, value });
        }
        if last_message_id.as_deref() != Some(request.through_message_id.as_str()) {
            return Err("上下文检查点消息边界在事务内发生变化".to_string());
        }
        assert_checkpoint_boundary(&boundary_messages)?;
    }
    for message_ids in request
        .excluded_message_ids
        .chunks(CHECKPOINT_MESSAGE_ID_BATCH_SIZE)
    {
        let mut builder =
            QueryBuilder::<Sqlite>::new("SELECT COUNT(*) FROM agent_messages WHERE session_id = ");
        builder.push_bind(request.session_id.clone());
        builder.push(" AND id IN (");
        {
            let mut separated = builder.separated(", ");
            for message_id in message_ids {
                separated.push_bind(message_id.clone());
            }
        }
        builder.push(")");
        let matched_message_count: i64 = builder
            .build_query_scalar()
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| format!("无法校验上下文检查点排除消息：{error}"))?;
        if matched_message_count != message_ids.len() as i64 {
            return Err("上下文检查点排除消息不属于当前会话历史".to_string());
        }
    }

    let existing = sqlx::query(
        "SELECT session_id, through_message_id, summary, summary_hash, reason,
                CAST(tokens_before AS REAL) AS tokens_before,
                CAST(estimated_tokens_after AS REAL) AS estimated_tokens_after,
                CAST(request_bytes_before AS REAL) AS request_bytes_before,
                CAST(request_bytes_after AS REAL) AS request_bytes_after,
                model_provider, model_id, prompt_version,
                excluded_message_ids_json, facts_json,
                CAST(created_at AS REAL) AS created_at
         FROM context_checkpoints WHERE id = ?",
    )
    .bind(&request.id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验上下文检查点 ID：{error}"))?;
    if let Some(row) = existing {
        let matches = row
            .try_get::<String, _>("session_id")
            .is_ok_and(|value| value == request.session_id)
            && row
                .try_get::<String, _>("through_message_id")
                .is_ok_and(|value| value == request.through_message_id)
            && row
                .try_get::<String, _>("summary")
                .is_ok_and(|value| value == request.summary)
            && row
                .try_get::<String, _>("summary_hash")
                .is_ok_and(|value| value == request.summary_hash)
            && row
                .try_get::<String, _>("reason")
                .is_ok_and(|value| value == request.reason)
            && row
                .try_get::<f64, _>("tokens_before")
                .is_ok_and(|value| value == request.tokens_before)
            && row
                .try_get::<f64, _>("estimated_tokens_after")
                .is_ok_and(|value| value == request.estimated_tokens_after)
            && row
                .try_get::<f64, _>("request_bytes_before")
                .is_ok_and(|value| value == request.request_bytes_before)
            && row
                .try_get::<f64, _>("request_bytes_after")
                .is_ok_and(|value| value == request.request_bytes_after)
            && row
                .try_get::<String, _>("model_provider")
                .is_ok_and(|value| value == request.model_provider)
            && row
                .try_get::<String, _>("model_id")
                .is_ok_and(|value| value == request.model_id)
            && row
                .try_get::<i64, _>("prompt_version")
                .is_ok_and(|value| value == request.prompt_version)
            && row
                .try_get::<String, _>("excluded_message_ids_json")
                .is_ok_and(|value| value == excluded_json)
            && row
                .try_get::<String, _>("facts_json")
                .is_ok_and(|value| value == facts_json)
            && row
                .try_get::<f64, _>("created_at")
                .is_ok_and(|value| value == request.created_at);
        if !matches {
            return Err("上下文检查点 ID 已被不一致的检查点占用".to_string());
        }
    } else {
        let inserted = sqlx::query(
            "INSERT INTO context_checkpoints
             (id, session_id, through_message_id, summary, summary_hash, reason,
              tokens_before, estimated_tokens_after, request_bytes_before, request_bytes_after,
              model_provider, model_id, prompt_version, excluded_message_ids_json, facts_json,
              created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&request.id)
        .bind(&request.session_id)
        .bind(&request.through_message_id)
        .bind(&request.summary)
        .bind(&request.summary_hash)
        .bind(&request.reason)
        .bind(request.tokens_before)
        .bind(request.estimated_tokens_after)
        .bind(request.request_bytes_before)
        .bind(request.request_bytes_after)
        .bind(&request.model_provider)
        .bind(&request.model_id)
        .bind(request.prompt_version)
        .bind(excluded_json)
        .bind(facts_json)
        .bind(request.created_at)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法持久化上下文检查点：{error}"))?;
        if inserted.rows_affected() != 1 {
            return Err("上下文检查点状态已变化，拒绝非原子写入".to_string());
        }
    }
    Ok(())
}
