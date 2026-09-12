use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::{HashMap, HashSet};
use crate::runtime_manifest::validate_identifier;

use super::*;

pub(super) fn interrupted_tool_key(run_id: &str, tool_call_id: &str) -> String {
    format!("{run_id}\0{tool_call_id}")
}

pub(super) fn add_interrupted_tool_candidate(
    candidates: &mut Vec<InterruptedToolCandidate>,
    candidate_indexes: &mut HashMap<String, usize>,
    candidate: InterruptedToolCandidate,
) -> Result<(), String> {
    let key = interrupted_tool_key(&candidate.run_id, &candidate.tool_call_id);
    if let Some(index) = candidate_indexes.get(&key).copied() {
        let existing = &mut candidates[index];
        if existing.session_id != candidate.session_id || existing.tool_name != candidate.tool_name
        {
            return Err("中断 ToolResult 候选记录互相冲突".to_string());
        }
        existing.recovery_policy = candidate.recovery_policy;
        return Ok(());
    }
    candidate_indexes.insert(key, candidates.len());
    candidates.push(candidate);
    Ok(())
}

pub(super) async fn recover_repository(
    connection: &mut SqliteConnection,
    now: i64,
) -> Result<RecoverSessionRepositoryResult, String> {
    if now < 0 {
        return Err("SessionRepository 恢复时间无效".to_string());
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| format!("无法开始 SessionRepository 恢复事务：{error}"))?;
    sqlx::query(
        "DELETE FROM agent_messages
         WHERE session_id IN (SELECT id FROM agent_sessions WHERE status = 'creating')",
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法清理未完成 Session 分支消息：{error}"))?;
    sqlx::query("DELETE FROM agent_sessions WHERE status = 'creating'")
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("无法清理未完成 Session 分支：{error}"))?;

    let running_run_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM agent_runs WHERE status = 'running' ORDER BY started_at ASC, id ASC",
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("无法读取未完成 Agent Run：{error}"))?;
    let interrupted_runs = sqlx::query(
        "UPDATE agent_runs
         SET status = 'interrupted', end_reason = 'interrupted',
             error_message = COALESCE(error_message, '应用在运行期间退出'), ended_at = ?
         WHERE status = 'running'",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法中断未完成 Agent Run：{error}"))?;
    if interrupted_runs.rows_affected() != running_run_ids.len() as u64 {
        return Err("未完成 Agent Run 状态已变化，拒绝非原子恢复".to_string());
    }
    let mut recovery_run_ids: HashSet<String> = running_run_ids.into_iter().collect();
    let mut touched_sessions = HashSet::new();

    let provider_rows = sqlx::query(
        "SELECT id, session_id, run_id, assistant_message_id, response_message_json
         FROM provider_requests WHERE status = 'response_received'
         ORDER BY started_at ASC, id ASC",
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("无法读取待恢复 Provider response：{error}"))?;
    for row in provider_rows {
        let request_id: String = row
            .try_get("id")
            .map_err(|error| format!("无法读取 Provider request ID：{error}"))?;
        let session_id: String = row
            .try_get("session_id")
            .map_err(|error| format!("无法读取 Provider request Session：{error}"))?;
        let run_id: String = row
            .try_get("run_id")
            .map_err(|error| format!("无法读取 Provider request Run：{error}"))?;
        let assistant_message_id: String = row
            .try_get("assistant_message_id")
            .map_err(|error| format!("无法读取 Provider request message ID：{error}"))?;
        let response_message_json: Option<String> = row
            .try_get("response_message_json")
            .map_err(|error| format!("无法读取 Provider response message：{error}"))?;
        let response_message_json = response_message_json
            .ok_or_else(|| "Provider response ledger 缺少可恢复 Assistant 消息".to_string())?;
        if response_message_json.len() > MAX_MESSAGE_BYTES {
            return Err("Provider response 恢复消息超过 1 MiB 安全上限".to_string());
        }
        let message: Value = serde_json::from_str(&response_message_json)
            .map_err(|error| format!("Provider response 恢复消息 JSON 无效：{error}"))?;
        let message_id = json_string(&message, "id", "Provider response 恢复消息")?;
        let role = json_string(&message, "role", "Provider response 恢复消息")?;
        let created_at = json_i64(&message, "createdAt", "Provider response 恢复消息")?;
        if message_id != assistant_message_id
            || role != "assistant"
            || !message.get("content").is_some_and(Value::is_string)
            || !message.get("toolCalls").is_some_and(Value::is_array)
        {
            return Err("Provider response ledger 的 Assistant 消息无效".to_string());
        }
        let existing: Option<(String, Option<String>, String, String, i64)> = sqlx::query_as(
            "SELECT session_id, run_id, role, content_json, created_at
             FROM agent_messages WHERE id = ?",
        )
        .bind(&assistant_message_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("无法校验 Provider response 恢复消息 ID：{error}"))?;
        if let Some(existing) = existing {
            let existing_message: Value = serde_json::from_str(&existing.3)
                .map_err(|error| format!("已存储 Provider response 恢复消息 JSON 无效：{error}"))?;
            if existing.0 != session_id
                || existing.1.as_deref() != Some(run_id.as_str())
                || existing.2 != "assistant"
                || existing_message != message
                || existing.4 != created_at
            {
                return Err("Provider response 恢复消息 ID 与现有消息冲突".to_string());
            }
        } else {
            let inserted = sqlx::query(
                "INSERT INTO agent_messages
                 (id, session_id, run_id, sequence, role, content_json, created_at, artifact_id)
                 VALUES (?, ?, ?,
                   COALESCE((SELECT MAX(sequence) + 1 FROM agent_messages WHERE session_id = ?), 1),
                   'assistant', ?, ?, NULL)",
            )
            .bind(&assistant_message_id)
            .bind(&session_id)
            .bind(&run_id)
            .bind(&session_id)
            .bind(&response_message_json)
            .bind(created_at)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("无法恢复已接收的 Provider response：{error}"))?;
            if inserted.rows_affected() != 1 {
                return Err("无法恢复已接收的 Provider response".to_string());
            }
        }
        let committed = sqlx::query(
            "UPDATE provider_requests
             SET status = 'committed', committed_at = COALESCE(committed_at, ?)
             WHERE id = ? AND status = 'response_received'",
        )
        .bind(now)
        .bind(&request_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("无法结算 Provider response 恢复状态：{error}"))?;
        if committed.rows_affected() != 1 {
            return Err("无法结算 Provider response 恢复状态".to_string());
        }
        recovery_run_ids.insert(run_id);
        touched_sessions.insert(session_id);
    }
    let running_provider_run_ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT run_id FROM provider_requests WHERE status = 'running'",
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("无法读取未完成 Provider request Run：{error}"))?;
    recovery_run_ids.extend(running_provider_run_ids);
    sqlx::query(
        "UPDATE provider_requests
         SET status = 'interrupted', committed_at = COALESCE(committed_at, ?)
         WHERE status = 'running'",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法中断未完成 Provider request：{error}"))?;

    let running_tool_run_ids: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT run_id FROM tool_executions WHERE status = 'running'")
            .fetch_all(&mut *transaction)
            .await
            .map_err(|error| format!("无法读取未完成工具执行 Run：{error}"))?;
    recovery_run_ids.extend(running_tool_run_ids);
    sqlx::query(
        "UPDATE tool_executions
         SET status = 'interrupted', is_error = 1,
             result_preview = COALESCE(result_preview, ?),
             details_json = COALESCE(details_json, ?), ended_at = COALESCE(ended_at, ?)
         WHERE status = 'running'",
    )
    .bind(INTERRUPTED_TOOL_RESULT_CONTENT)
    .bind(r#"{"reason":"application_exit"}"#)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法中断未完成工具执行：{error}"))?;

    let mut recovery_run_ids: Vec<String> = recovery_run_ids.into_iter().collect();
    recovery_run_ids.sort_unstable();
    let mut message_rows = Vec::new();
    for run_ids in recovery_run_ids.chunks(RECOVERY_RUN_ID_BATCH_SIZE) {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT m.session_id, m.run_id, m.id, m.role, m.content_json
             FROM agent_messages m
             JOIN agent_runs r ON r.id = m.run_id AND r.session_id = m.session_id
             WHERE r.id IN (",
        );
        {
            let mut separated = builder.separated(", ");
            for run_id in run_ids {
                separated.push_bind(run_id.clone());
            }
        }
        builder.push(") AND r.status = 'interrupted'");
        builder.push(" AND m.role IN ('assistant', 'tool')");
        builder.push(" ORDER BY r.started_at ASC, r.id ASC, m.sequence ASC");
        let rows = builder
            .build()
            .fetch_all(&mut *transaction)
            .await
            .map_err(|error| format!("无法读取中断 Run 消息：{error}"))?;
        message_rows.extend(rows);
    }
    let mut tool_calls = HashMap::<String, (String, String)>::new();
    let mut completed_tool_calls = HashSet::new();
    let mut candidates = Vec::new();
    let mut candidate_indexes = HashMap::new();
    for row in message_rows {
        let session_id: String = row
            .try_get("session_id")
            .map_err(|error| format!("无法读取中断消息 Session：{error}"))?;
        let run_id: String = row
            .try_get("run_id")
            .map_err(|error| format!("无法读取中断消息 Run：{error}"))?;
        let stored_id: String = row
            .try_get("id")
            .map_err(|error| format!("无法读取中断消息 ID：{error}"))?;
        let stored_role: String = row
            .try_get("role")
            .map_err(|error| format!("无法读取中断消息角色：{error}"))?;
        let content_json: String = row
            .try_get("content_json")
            .map_err(|error| format!("无法读取中断消息 JSON：{error}"))?;
        let message: Value = serde_json::from_str(&content_json)
            .map_err(|error| format!("中断 Run 消息 JSON 无效：{error}"))?;
        if json_string(&message, "id", "中断 Run 消息")? != stored_id
            || json_string(&message, "role", "中断 Run 消息")? != stored_role
        {
            return Err("中断 Run 消息索引与 JSON 不一致".to_string());
        }
        if stored_role == "tool" {
            let tool_call_id = json_string(&message, "toolCallId", "中断 ToolResult message")?;
            completed_tool_calls.insert(interrupted_tool_key(&run_id, tool_call_id));
            continue;
        }
        if stored_role != "assistant" {
            continue;
        }
        let calls = message
            .get("toolCalls")
            .and_then(Value::as_array)
            .ok_or_else(|| "中断 Assistant message 缺少有效 ToolCall 列表".to_string())?;
        let recover_from_message = message
            .get("stopReason")
            .and_then(Value::as_str)
            .is_some_and(|reason| matches!(reason, "tool_use" | "length"));
        for call in calls {
            let tool_call_id = json_string(call, "id", "中断 Assistant ToolCall")?.to_string();
            let tool_name = json_string(call, "name", "中断 Assistant ToolCall")?.to_string();
            validate_identifier("Tool Call ID", &tool_call_id)?;
            if tool_name.trim().is_empty() || tool_name.len() > 128 || tool_name.contains('\0') {
                return Err("中断 Assistant ToolCall 工具名称无效".to_string());
            }
            let key = interrupted_tool_key(&run_id, &tool_call_id);
            if let Some((existing_session, existing_name)) = tool_calls.get(&key) {
                if existing_session != &session_id || existing_name != &tool_name {
                    return Err("中断 Assistant ToolCall ID 冲突".to_string());
                }
            } else {
                tool_calls.insert(key, (session_id.clone(), tool_name.clone()));
            }
            if recover_from_message {
                add_interrupted_tool_candidate(
                    &mut candidates,
                    &mut candidate_indexes,
                    InterruptedToolCandidate {
                        session_id: session_id.clone(),
                        run_id: run_id.clone(),
                        tool_call_id,
                        tool_name,
                        recovery_policy: "never".to_string(),
                        // 仅来自 assistant ToolCall 无对应执行记录：工具可能从未执行。
                        execution_state: "interrupted".to_string(),
                    },
                )?;
            }
        }
    }
    let mut execution_rows = Vec::new();
    for run_ids in recovery_run_ids.chunks(RECOVERY_RUN_ID_BATCH_SIZE) {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT r.session_id, t.run_id, t.tool_call_id, t.recovery_policy, t.status
             FROM tool_executions t
             JOIN agent_runs r ON r.id = t.run_id
             WHERE r.id IN (",
        );
        {
            let mut separated = builder.separated(", ");
            for run_id in run_ids {
                separated.push_bind(run_id.clone());
            }
        }
        builder.push(") AND r.status = 'interrupted'");
        builder.push(" AND t.status IN ('interrupted', 'completed', 'error')");
        builder.push(" ORDER BY t.started_at ASC, t.run_id ASC, t.tool_call_id ASC");
        let rows = builder
            .build()
            .fetch_all(&mut *transaction)
            .await
            .map_err(|error| format!("无法读取中断工具执行记录：{error}"))?;
        execution_rows.extend(rows);
    }
    for row in execution_rows {
        let session_id: String = row
            .try_get("session_id")
            .map_err(|error| format!("无法读取中断工具 Session：{error}"))?;
        let run_id: String = row
            .try_get("run_id")
            .map_err(|error| format!("无法读取中断工具 Run：{error}"))?;
        let tool_call_id: String = row
            .try_get("tool_call_id")
            .map_err(|error| format!("无法读取中断工具 ToolCall：{error}"))?;
        let recovery_policy: String = row
            .try_get("recovery_policy")
            .map_err(|error| format!("无法读取中断工具恢复策略：{error}"))?;
        let status: String = row
            .try_get("status")
            .map_err(|error| format!("无法读取中断工具执行状态：{error}"))?;
        let key = interrupted_tool_key(&run_id, &tool_call_id);
        let Some((assistant_session_id, tool_name)) = tool_calls.get(&key) else {
            continue;
        };
        if assistant_session_id != &session_id {
            return Err("中断工具执行与 Assistant ToolCall Session 冲突".to_string());
        }
        add_interrupted_tool_candidate(
            &mut candidates,
            &mut candidate_indexes,
            InterruptedToolCandidate {
                session_id,
                run_id,
                tool_call_id,
                tool_name: tool_name.clone(),
                recovery_policy,
                // completed/error 均视为"已尝试执行、结果未保存"；interrupted 为可能未执行。
                execution_state: if status == "interrupted" {
                    "interrupted".to_string()
                } else {
                    "completed".to_string()
                },
            },
        )?;
    }
    for candidate in candidates {
        let key = interrupted_tool_key(&candidate.run_id, &candidate.tool_call_id);
        if completed_tool_calls.contains(&key) {
            continue;
        }
        let digest = Sha256::digest(key.as_bytes());
        let message_id = format!("tool-interrupted-{digest:x}");
        let existing: Option<(String, Option<String>, String, String)> = sqlx::query_as(
            "SELECT session_id, run_id, role, content_json FROM agent_messages WHERE id = ?",
        )
        .bind(&message_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("无法校验中断 ToolResult 消息 ID：{error}"))?;
        if let Some((session_id, run_id, role, content_json)) = existing {
            let value: Value = serde_json::from_str(&content_json)
                .map_err(|error| format!("中断 ToolResult 消息 JSON 无效：{error}"))?;
            if session_id == candidate.session_id
                && run_id.as_deref() == Some(candidate.run_id.as_str())
                && role == "tool"
                && value.get("toolCallId").and_then(Value::as_str)
                    == Some(candidate.tool_call_id.as_str())
            {
                continue;
            }
            return Err("中断 ToolResult 确定性消息 ID 与现有消息冲突".to_string());
        }
        let content = if candidate.execution_state == "completed" {
            COMPLETED_TOOL_RESULT_CONTENT
        } else {
            INTERRUPTED_TOOL_RESULT_CONTENT
        };
        let message = serde_json::json!({
            "id": message_id,
            "role": "tool",
            "toolCallId": candidate.tool_call_id,
            "toolName": candidate.tool_name,
            "content": content,
            "details": {
                "reason": "application_exit",
                "executionState": candidate.execution_state,
                "runId": candidate.run_id,
                "recoveryPolicy": candidate.recovery_policy,
                "replayed": false,
                "eligibleForReplay": candidate.recovery_policy == "idempotent",
            },
            "isError": true,
            "createdAt": now,
        });
        let content_json = serde_json::to_string(&message)
            .map_err(|error| format!("无法编码中断 ToolResult：{error}"))?;
        let inserted = sqlx::query(
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at, artifact_id)
             VALUES (?, ?, ?,
               COALESCE((SELECT MAX(sequence) + 1 FROM agent_messages WHERE session_id = ?), 1),
               'tool', ?, ?, NULL)",
        )
        .bind(&message_id)
        .bind(&candidate.session_id)
        .bind(&candidate.run_id)
        .bind(&candidate.session_id)
        .bind(&content_json)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("无法持久化中断 ToolResult：{error}"))?;
        if inserted.rows_affected() != 1 {
            return Err("无法持久化中断 ToolResult".to_string());
        }
        touched_sessions.insert(candidate.session_id);
    }

    sqlx::query(
        "UPDATE agent_sessions SET status = 'idle', updated_at = ? WHERE status = 'running'",
    )
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法恢复运行中 Session：{error}"))?;
    for session_id in touched_sessions {
        let updated = sqlx::query("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(&session_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("无法更新时间恢复 Session：{error}"))?;
        if updated.rows_affected() != 1 {
            return Err("恢复事实所属 Session 不存在".to_string());
        }
    }

    let journal_rows = sqlx::query(
        "SELECT id, session_id, kind, payload_json, consumer_run_id
         FROM agent_session_journal WHERE status = 'consuming'
         ORDER BY session_id, sequence",
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("无法读取 consuming journal entries：{error}"))?;
    for row in journal_rows {
        let id: String = row
            .try_get("id")
            .map_err(|error| format!("无法读取 journal entry ID：{error}"))?;
        let session_id: String = row
            .try_get("session_id")
            .map_err(|error| format!("无法读取 journal entry Session：{error}"))?;
        let kind: String = row
            .try_get("kind")
            .map_err(|error| format!("无法读取 journal entry 类型：{error}"))?;
        if kind != "queue" {
            return Err("SQLite 中存在非法 consuming 非队列 journal entry".to_string());
        }
        let payload_json: String = row
            .try_get("payload_json")
            .map_err(|error| format!("无法读取 journal payload：{error}"))?;
        let consumer_run_id: Option<String> = row
            .try_get("consumer_run_id")
            .map_err(|error| format!("无法读取 journal consumer Run：{error}"))?;
        let consumer_run_id = consumer_run_id
            .ok_or_else(|| "Consuming queue journal 缺少 consumer Run".to_string())?;
        let payload: Value = serde_json::from_str(&payload_json)
            .map_err(|error| format!("SQLite journal payload 无法解析：{error}"))?;
        let message = payload
            .get("message")
            .ok_or_else(|| "SQLite queue journal 缺少 message payload".to_string())?;
        let message_id = json_string(message, "id", "SQLite queue journal message")?;
        validate_identifier("Journal message ID", message_id)?;
        let stored_message: Option<(String, Option<String>, String, i64, String)> = sqlx::query_as(
            "SELECT session_id, run_id, role, created_at, content_json
             FROM agent_messages WHERE id = ?",
        )
        .bind(message_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("无法校验 journal message 恢复状态：{error}"))?;
        let message_applied = if let Some(stored) = stored_message {
            let stored_content: Value = serde_json::from_str(&stored.4)
                .map_err(|error| format!("已存储 queue message JSON 无效：{error}"))?;
            let message_role = json_string(message, "role", "SQLite queue journal message")?;
            let message_created_at =
                json_i64(message, "createdAt", "SQLite queue journal message")?;
            if stored.0 != session_id
                || stored.1.as_deref() != Some(consumer_run_id.as_str())
                || stored.2 != message_role
                || stored.3 != message_created_at
                || &stored_content != message
            {
                return Err(
                    "Consuming queue journal 与已持久化消息 canonical effect 冲突".to_string(),
                );
            }
            true
        } else {
            false
        };
        let updated = if message_applied {
            sqlx::query(
                "UPDATE agent_session_journal
                 SET status = 'applied', applied_at = ?, recovered_at = NULL
                 WHERE id = ? AND session_id = ? AND status = 'consuming'",
            )
            .bind(now)
            .bind(&id)
            .bind(&session_id)
            .execute(&mut *transaction)
            .await
        } else {
            sqlx::query(
                "UPDATE agent_session_journal
                 SET status = 'pending', consumer_run_id = NULL,
                     applied_at = NULL, recovered_at = NULL
                 WHERE id = ? AND session_id = ? AND status = 'consuming'",
            )
            .bind(&id)
            .bind(&session_id)
            .execute(&mut *transaction)
            .await
        }
        .map_err(|error| format!("无法恢复 consuming journal entry：{error}"))?;
        if updated.rows_affected() != 1 {
            return Err("Journal entry 状态已变化，拒绝非原子恢复".to_string());
        }
    }
    sqlx::query("DELETE FROM agent_session_journal WHERE status IN ('applied', 'discarded')")
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("无法清理已结算 journal entries：{error}"))?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("无法提交 SessionRepository 恢复事务：{error}"))?;
    Ok(RecoverSessionRepositoryResult {
        recovered_runs: interrupted_runs.rows_affected(),
    })
}

/// 会话级最小恢复：只把指定会话的 running run / provider request / tool execution
/// 标为 interrupted、session 复位 idle，不影响其他会话。用于 send 失败恢复路径
/// （其他会话仍在运行时避免全局恢复干扰它们）。不复位 response_received ledger、
/// 不合成 interrupted tool results——这些职责保留给应用启动的全局恢复。
pub(super) async fn recover_session(
    connection: &mut SqliteConnection,
    session_id: &str,
    now: i64,
) -> Result<RecoverSessionRepositoryResult, String> {
    validate_identifier("Session ID", session_id)?;
    if now < 0 {
        return Err("SessionRepository 恢复时间无效".to_string());
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| format!("无法开始 Session 恢复事务：{error}"))?;
    let interrupted_runs = sqlx::query(
        "UPDATE agent_runs
         SET status = 'interrupted', end_reason = 'interrupted',
             error_message = COALESCE(error_message, '应用在运行期间退出'), ended_at = ?
         WHERE session_id = ? AND status = 'running'",
    )
    .bind(now)
    .bind(session_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法中断指定 Session 的未完成 Agent Run：{error}"))?;
    sqlx::query(
        "UPDATE provider_requests
         SET status = 'interrupted', committed_at = COALESCE(committed_at, ?)
         WHERE session_id = ? AND status = 'running'",
    )
    .bind(now)
    .bind(session_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法中断指定 Session 的未完成 Provider request：{error}"))?;
    sqlx::query(
        "UPDATE tool_executions
         SET status = 'interrupted', is_error = 1,
             result_preview = COALESCE(result_preview, ?),
             details_json = COALESCE(details_json, ?), ended_at = COALESCE(ended_at, ?)
         WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ?)
           AND status = 'running'",
    )
    .bind(INTERRUPTED_TOOL_RESULT_CONTENT)
    .bind(r#"{"reason":"application_exit"}"#)
    .bind(now)
    .bind(session_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法中断指定 Session 的未完成工具执行：{error}"))?;
    let updated_sessions = sqlx::query(
        "UPDATE agent_sessions SET status = 'idle', updated_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(session_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("无法复位指定 Session 状态：{error}"))?;
    if updated_sessions.rows_affected() != 1 {
        return Err("会话不存在或已被删除".to_string());
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("无法提交 Session 恢复事务：{error}"))?;
    Ok(RecoverSessionRepositoryResult {
        recovered_runs: interrupted_runs.rows_affected(),
    })
}
