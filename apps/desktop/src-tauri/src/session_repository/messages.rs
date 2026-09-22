use serde_json::Value;
use sqlx::SqliteConnection;
use std::collections::HashSet;
use crate::artifacts::MAX_ARTIFACT_BYTES;
use crate::runtime_manifest::validate_identifier;

use super::*;

pub(super) fn json_string<'a>(value: &'a Value, field: &str, label: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} 缺少有效的 {field}"))
}

pub(super) fn json_i64(value: &Value, field: &str, label: &str) -> Result<i64, String> {
    value
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{label} 缺少有效的 {field}"))
}

pub(super) fn validate_session_message_artifact(artifact: &SessionMessageArtifact) -> Result<(), String> {
    let valid_hash = artifact.content_hash.len() == 64
        && artifact
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !valid_hash
        || artifact.id != format!("sha256:{}", artifact.content_hash)
        || artifact.relative_path
            != format!(
                "artifacts/sha256/{}/{}",
                &artifact.content_hash[..2],
                artifact.content_hash
            )
        || !matches!(artifact.kind.as_str(), "text" | "json" | "image")
        || artifact.media_type.is_empty()
        || artifact.media_type.len() > 256
        || artifact.media_type.contains(['\0', '\r', '\n'])
        || !(0..=MAX_ARTIFACT_BYTES as i64).contains(&artifact.size_bytes)
        || artifact.created_at < 0
    {
        return Err("Session message 包含无效的 Artifact 元数据".to_string());
    }
    Ok(())
}

pub(super) fn validate_session_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty()
        || title.chars().count() > 80
        || title.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{202a}'
                        | '\u{202b}'
                        | '\u{202c}'
                        | '\u{202d}'
                        | '\u{202e}'
                        | '\u{2066}'
                        | '\u{2067}'
                        | '\u{2068}'
                        | '\u{2069}'
                )
        })
    {
        return Err("Session message 标题无效".to_string());
    }
    Ok(())
}

pub(super) fn validate_session_message_request(
    request: &SaveSessionMessageRequest,
) -> Result<(Option<SessionMessageArtifact>, Option<String>, bool), String> {
    let encoded = serde_json::to_vec(request)
        .map_err(|error| format!("无法编码 Session message 请求：{error}"))?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("Session message 请求超过 2 MiB 安全上限".to_string());
    }
    validate_identifier("Session ID", &request.session_id)?;
    if let Some(run_id) = &request.run_id {
        validate_identifier("Run ID", run_id)?;
    }
    if let Some(entry_id) = &request.consumed_journal_entry_id {
        validate_identifier("Consumed journal entry ID", entry_id)?;
        if request.role != "user" || request.run_id.is_none() {
            return Err(
                "只有 Run 中的 User message 可以确认已消费 queue journal entry".to_string(),
            );
        }
    }
    validate_identifier("Message ID", &request.message_id)?;
    if request.created_at < 0 || request.now < 0 || request.content_json.len() > MAX_MESSAGE_BYTES {
        return Err("Session message 时间或大小无效".to_string());
    }
    if !matches!(
        request.role.as_str(),
        "user" | "assistant" | "tool" | "custom"
    ) {
        return Err("Session message 角色无效".to_string());
    }
    let value: Value = serde_json::from_str(&request.content_json)
        .map_err(|error| format!("Session message JSON 无效：{error}"))?;
    if json_string(&value, "id", "Session message")? != request.message_id
        || json_string(&value, "role", "Session message")? != request.role
        || json_i64(&value, "createdAt", "Session message")? != request.created_at
        || !value.get("content").is_some_and(Value::is_string)
    {
        return Err("Session message DTO 与 content JSON 不一致".to_string());
    }
    match (&request.session_title, request.role.as_str()) {
        (Some(title), "user") => validate_session_title(title)?,
        (None, "user") => return Err("User message 缺少 Session 标题".to_string()),
        (Some(_), _) => return Err("只有 User message 可以更新 Session 标题".to_string()),
        (None, _) => {}
    }
    let artifact = value
        .get("artifact")
        .map(|candidate| {
            serde_json::from_value::<SessionMessageArtifact>(candidate.clone())
                .map_err(|error| format!("Session message Artifact JSON 无效：{error}"))
        })
        .transpose()?;
    if request.role != "tool" && artifact.is_some() {
        return Err("只有 ToolResult message 可以关联 Artifact".to_string());
    }
    if let Some(artifact) = &artifact {
        validate_session_message_artifact(artifact)?;
    }
    if request.role == "assistant" {
        if !value
            .get("stopReason")
            .and_then(Value::as_str)
            .is_some_and(|reason| {
                matches!(reason, "stop" | "tool_use" | "length" | "error" | "aborted")
            })
        {
            return Err("Assistant message stop reason 无效".to_string());
        }
        let tool_calls = value
            .get("toolCalls")
            .and_then(Value::as_array)
            .ok_or_else(|| "Assistant message 缺少有效 ToolCall 列表".to_string())?;
        let mut tool_call_ids = HashSet::new();
        for call in tool_calls {
            let id = json_string(call, "id", "Assistant ToolCall")?;
            validate_identifier("Tool Call ID", id)?;
            if !tool_call_ids.insert(id) {
                return Err("Assistant message 包含重复 ToolCall ID".to_string());
            }
            let name = json_string(call, "name", "Assistant ToolCall")?;
            if name.trim().is_empty() || name.len() > 128 || name.contains('\0') {
                return Err("Assistant ToolCall 工具名称无效".to_string());
            }
            if !call.get("rawArguments").is_some_and(Value::is_string)
                || call.get("arguments").is_none()
            {
                return Err("Assistant ToolCall 参数无效".to_string());
            }
        }
    } else if request.role == "custom" {
        let custom_type = json_string(&value, "customType", "Custom message")?;
        if custom_type.trim().is_empty() || custom_type.len() > 160 || custom_type.contains('\0') {
            return Err("Custom message 类型无效".to_string());
        }
    }
    let tool_call_id = if request.role == "tool" {
        if !value.get("isError").is_some_and(Value::is_boolean) {
            return Err("ToolResult message 缺少 isError".to_string());
        }
        let id = json_string(&value, "toolCallId", "ToolResult message")?.to_string();
        validate_identifier("Tool Call ID", &id)?;
        let tool_name = json_string(&value, "toolName", "ToolResult message")?;
        if tool_name.trim().is_empty() || tool_name.len() > 128 || tool_name.contains('\0') {
            return Err("ToolResult message 工具名称无效".to_string());
        }
        let completion = request
            .tool_execution
            .as_ref()
            .ok_or_else(|| "ToolResult message 缺少原子工具完成事实".to_string())?;
        validate_identifier("Tool completion Call ID", &completion.tool_call_id)?;
        if completion.tool_call_id != id
            || completion.tool_name != tool_name
            || completion.is_error
                != value
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            || completion.tool_name.trim().is_empty()
            || completion.tool_name.len() > 128
            || completion.tool_name.contains('\0')
            || completion.result_preview.len() > 8 * 1024
            || completion.result_preview.contains('\0')
            || completion.ended_at < 0
            || !matches!(
                completion.approval_state.as_str(),
                "not_required" | "approved" | "denied"
            )
        {
            return Err("ToolResult message 与工具完成事实不一致".to_string());
        }
        if let Some(details) = &completion.details_json {
            if details.len() > MAX_MESSAGE_BYTES || serde_json::from_str::<Value>(details).is_err()
            {
                return Err("Tool completion details JSON 无效".to_string());
            }
        }
        if request.run_id.is_none() {
            return Err("ToolResult message 缺少所属 Run".to_string());
        }
        Some(id)
    } else {
        if request.tool_execution.is_some() {
            return Err("只有 ToolResult message 可以完成工具执行".to_string());
        }
        None
    };
    let is_orchestration_failure = request.role == "assistant"
        && value
            .get("stopReason")
            .and_then(Value::as_str)
            .is_some_and(|reason| matches!(reason, "error" | "aborted"))
        && value
            .get("diagnostics")
            .and_then(Value::as_array)
            .is_some_and(|diagnostics| {
                diagnostics.iter().any(|diagnostic| {
                    diagnostic.get("type").and_then(Value::as_str)
                        == Some("agent-orchestration-error")
                })
            });
    Ok((artifact, tool_call_id, is_orchestration_failure))
}

pub(super) async fn save_session_message(
    connection: &mut SqliteConnection,
    request: &SaveSessionMessageRequest,
) -> Result<(), String> {
    let (artifact, tool_call_id, is_orchestration_failure) =
        validate_session_message_request(request)?;
    let requested_content: Value = serde_json::from_str(&request.content_json)
        .map_err(|error| format!("Session message JSON 无效：{error}"))?;
    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT/UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Session message 事务：{error}"))?;
    let outcome = save_session_message_locked(
        connection,
        request,
        &artifact,
        &requested_content,
        tool_call_id,
        is_orchestration_failure,
    )
    .await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Session message 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn save_session_message_locked(
    connection: &mut SqliteConnection,
    request: &SaveSessionMessageRequest,
    artifact: &Option<SessionMessageArtifact>,
    requested_content: &Value,
    tool_call_id: Option<String>,
    is_orchestration_failure: bool,
) -> Result<(), String> {
    let artifact_id = artifact.as_ref().map(|value| value.id.as_str());

    let session_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(&request.session_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Session message 所属 Session：{error}"))?;
    let session_status = session_status.ok_or_else(|| "会话不存在或已被删除".to_string())?;
    if let Some(run_id) = &request.run_id {
        let run_status: Option<String> =
            sqlx::query_scalar("SELECT status FROM agent_runs WHERE id = ? AND session_id = ?")
                .bind(run_id)
                .bind(&request.session_id)
                .fetch_optional(&mut *connection)
                .await
                .map_err(|error| format!("无法校验 Session message 所属 Run：{error}"))?;
        if run_status.as_deref() != Some("running") || session_status != "running" {
            return Err("Session message 对应的运行不在执行中".to_string());
        }
    }

    let existing: Option<StoredMessageRecord> = sqlx::query_as(
        "SELECT session_id, run_id, role, created_at, content_json, artifact_id
         FROM agent_messages WHERE id = ?",
    )
    .bind(&request.message_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Session message ID：{error}"))?;
    let message_replayed = if let Some(identity) = &existing {
        let stored_content: Value = serde_json::from_str(&identity.4)
            .map_err(|error| format!("已存储 Session message JSON 无效：{error}"))?;
        if identity.0 != request.session_id
            || identity.1 != request.run_id
            || identity.2 != request.role
            || identity.3 != request.created_at
            || stored_content != *requested_content
            || identity.5.as_deref() != artifact_id
        {
            return Err("Session message ID 已被不一致的 canonical effect 占用".to_string());
        }
        true
    } else {
        false
    };

    let journal_already_applied = if let Some(entry_id) = &request.consumed_journal_entry_id {
        let journal: Option<(String, String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT session_id, kind, status, consumer_run_id, payload_json
             FROM agent_session_journal WHERE id = ?",
        )
        .bind(entry_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("无法校验 Session message queue journal entry：{error}"))?;
        let Some((journal_session_id, kind, status, consumer_run_id, payload_json)) = journal
        else {
            return Err("Session message 引用了不存在的 queue journal entry".to_string());
        };
        let payload: Value = serde_json::from_str(&payload_json)
            .map_err(|error| format!("Session message queue journal payload 无效：{error}"))?;
        let journal_message = payload
            .get("message")
            .ok_or_else(|| "Session message queue journal 缺少 message payload".to_string())?;
        // codecVersion 是存储 codec 的信封字段（messageCodec.ts），不属于消息身份；
        // journal payload 的 message 不带信封，canonical 比对前必须剥除，
        // 否则每次队列消息消费落库都会被误判为「消费事实不匹配」。
        let mut canonical_content = requested_content.clone();
        if let Some(fields) = canonical_content.as_object_mut() {
            fields.remove("codecVersion");
        }
        if journal_session_id != request.session_id
            || kind != "queue"
            || consumer_run_id != request.run_id
            || journal_message.get("id").and_then(Value::as_str)
                != Some(request.message_id.as_str())
            || journal_message != &canonical_content
        {
            return Err("Session message 与 queue journal 消费事实不匹配".to_string());
        }
        match status.as_str() {
            "consuming" => false,
            "applied" if message_replayed => true,
            _ => return Err("Session message queue journal entry 不在 consuming 状态".to_string()),
        }
    } else {
        false
    };

    if let Some(artifact) = artifact {
        sqlx::query(
            "INSERT INTO artifacts
             (id, kind, media_type, relative_path, content_hash, size_bytes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(&artifact.id)
        .bind(&artifact.kind)
        .bind(&artifact.media_type)
        .bind(&artifact.relative_path)
        .bind(&artifact.content_hash)
        .bind(artifact.size_bytes)
        .bind(artifact.created_at)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法写入 Session message Artifact 元数据：{error}"))?;
        let stored: Option<(String, String, String, String, i64, i64)> = sqlx::query_as(
            "SELECT kind, media_type, relative_path, content_hash, size_bytes, created_at
             FROM artifacts WHERE id = ?",
        )
        .bind(&artifact.id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("无法校验 Session message Artifact 元数据：{error}"))?;
        if stored
            != Some((
                artifact.kind.clone(),
                artifact.media_type.clone(),
                artifact.relative_path.clone(),
                artifact.content_hash.clone(),
                artifact.size_bytes,
                artifact.created_at,
            ))
        {
            return Err("Session message Artifact 元数据冲突".to_string());
        }
    }

    if !message_replayed {
        let message_result = sqlx::query(
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at, artifact_id)
             VALUES (?, ?, ?,
               COALESCE((SELECT MAX(sequence) + 1 FROM agent_messages WHERE session_id = ?), 1),
               ?, ?, ?, ?)",
        )
        .bind(&request.message_id)
        .bind(&request.session_id)
        .bind(&request.run_id)
        .bind(&request.session_id)
        .bind(&request.role)
        .bind(&request.content_json)
        .bind(request.created_at)
        .bind(artifact_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法持久化 Session message：{error}"))?;
        if message_result.rows_affected() != 1 {
            return Err("Session message 状态已变化，拒绝非原子写入".to_string());
        }
    }

    if request.role == "assistant" {
        if let Some(run_id) = &request.run_id {
            let provider_record: Option<(String, Option<String>)> = sqlx::query_as(
                "SELECT status, response_message_json FROM provider_requests
                 WHERE session_id = ? AND run_id = ? AND assistant_message_id = ?",
            )
            .bind(&request.session_id)
            .bind(run_id)
            .bind(&request.message_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Session message Provider response：{error}"))?;
            if provider_record.is_none() && !is_orchestration_failure {
                return Err("Assistant message 缺少 Provider response ledger".to_string());
            }
            if let Some((status, response_message_json)) = &provider_record {
                let response_message = response_message_json
                    .as_deref()
                    .ok_or_else(|| {
                        "Assistant message 与 Provider response canonical effect 不一致".to_string()
                    })
                    .and_then(|value| {
                        serde_json::from_str::<Value>(value).map_err(|error| {
                            format!("Provider response canonical message JSON 无效：{error}")
                        })
                    })?;
                if response_message != *requested_content
                    || if message_replayed {
                        status != "committed"
                    } else {
                        status != "response_received"
                    }
                {
                    return Err(
                        "Assistant message 与 Provider response canonical effect 不一致"
                            .to_string(),
                    );
                }
            }
            if provider_record.is_some() && !message_replayed {
                let provider = sqlx::query(
                    "UPDATE provider_requests SET status = 'committed', committed_at = ?
                     WHERE session_id = ? AND run_id = ? AND assistant_message_id = ?
                       AND status = 'response_received'",
                )
                .bind(request.now)
                .bind(&request.session_id)
                .bind(run_id)
                .bind(&request.message_id)
                .execute(&mut *connection)
                .await
                .map_err(|error| format!("无法结算 Session message Provider response：{error}"))?;
                if provider.rows_affected() != 1 {
                    return Err("Assistant message 缺少已接收的 Provider response".to_string());
                }
            }
        }
    }
    if let (Some(run_id), Some(tool_call_id), Some(completion)) = (
        &request.run_id,
        tool_call_id.as_deref(),
        request.tool_execution.as_ref(),
    ) {
        let status = if completion.is_error {
            "error"
        } else {
            "completed"
        };
        if message_replayed {
            let stored: Option<CompletedToolRecord> = sqlx::query_as(
                "SELECT tool_name, result_preview, details_json, status, is_error,
                        approval_state, ended_at, artifact_id
                 FROM tool_executions WHERE run_id = ? AND tool_call_id = ?",
            )
            .bind(run_id)
            .bind(tool_call_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Session message 工具完成重放：{error}"))?;
            let expected = Some((
                completion.tool_name.clone(),
                Some(completion.result_preview.clone()),
                completion.details_json.clone(),
                status.to_string(),
                Some(i64::from(completion.is_error)),
                completion.approval_state.clone(),
                Some(completion.ended_at),
                artifact_id.map(str::to_string),
            ));
            if stored != expected {
                return Err("ToolResult message 与已完成工具 canonical effect 不一致".to_string());
            }
        } else {
            let tool = sqlx::query(
                "UPDATE tool_executions
                 SET result_preview = ?, details_json = ?, status = ?, is_error = ?,
                     approval_state = ?, ended_at = ?, artifact_id = ?
                 WHERE run_id = ? AND tool_call_id = ? AND tool_name = ? AND status = 'running'",
            )
            .bind(&completion.result_preview)
            .bind(&completion.details_json)
            .bind(status)
            .bind(i64::from(completion.is_error))
            .bind(&completion.approval_state)
            .bind(completion.ended_at)
            .bind(artifact_id)
            .bind(run_id)
            .bind(tool_call_id)
            .bind(&completion.tool_name)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法原子完成 Session message 工具执行：{error}"))?;
            if tool.rows_affected() != 1 {
                return Err("ToolResult message 缺少匹配的活动工具执行记录".to_string());
            }
        }
    }

    let session = if message_replayed {
        Ok(None)
    } else if let Some(title) = &request.session_title {
        sqlx::query(
            "UPDATE agent_sessions
             SET title = CASE WHEN title = '新会话' THEN ? ELSE title END, updated_at = ?
             WHERE id = ?",
        )
        .bind(title)
        .bind(request.now)
        .bind(&request.session_id)
        .execute(&mut *connection)
        .await
        .map(Some)
    } else {
        sqlx::query("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
            .bind(request.now)
            .bind(&request.session_id)
            .execute(&mut *connection)
            .await
            .map(Some)
    }
    .map_err(|error| format!("无法更新 Session message 会话状态：{error}"))?;
    if session.is_some_and(|result| result.rows_affected() != 1) {
        return Err("Session message 所属 Session 状态已变化".to_string());
    }

    if let Some(entry_id) = &request.consumed_journal_entry_id {
        if !journal_already_applied {
            let journal = sqlx::query(
                "UPDATE agent_session_journal
                 SET status = 'applied', applied_at = ?, recovered_at = NULL
                 WHERE id = ? AND session_id = ? AND kind = 'queue'
                   AND status = 'consuming' AND consumer_run_id = ?",
            )
            .bind(request.now)
            .bind(entry_id)
            .bind(&request.session_id)
            .bind(&request.run_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法确认 Session message queue journal entry：{error}"))?;
            if journal.rows_affected() != 1 {
                return Err("Session message queue journal 状态已变化，拒绝非原子确认".to_string());
            }
        }
    }

    Ok(())
}
