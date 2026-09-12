use serde_json::Value;
use sqlx::SqliteConnection;
use crate::runtime_manifest::validate_identifier;

use super::*;

pub(super) async fn start_run(
    connection: &mut SqliteConnection,
    request: &StartSessionRunRequest,
) -> Result<(), String> {
    validate_identifier("Run ID", &request.run_id)?;
    validate_identifier("Session ID", &request.session_id)?;
    if request.now < 0 {
        return Err("Agent Run 启动时间无效".to_string());
    }

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT/UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Agent Run 事务：{error}"))?;
    let outcome = start_run_locked(connection, request).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Agent Run 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn start_run_locked(
    connection: &mut SqliteConnection,
    request: &StartSessionRunRequest,
) -> Result<(), String> {
    let session_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(&request.session_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Agent Run 所属 Session：{error}"))?;
    let session_status = session_status.ok_or_else(|| "会话不存在或已被删除".to_string())?;
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT session_id, status FROM agent_runs WHERE id = ?")
            .bind(&request.run_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Agent Run ID：{error}"))?;
    if let Some((existing_session_id, existing_status)) = existing {
        if existing_session_id != request.session_id {
            return Err("Agent Run ID 已被其他 Session 占用".to_string());
        }
        if existing_status != "running" {
            return Err("Agent Run 已进入终态，拒绝重新启动".to_string());
        }
        if session_status != "running" {
            return Err("Agent Run 幂等重放与 Session 状态不一致".to_string());
        }
        let other_running_runs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_runs
             WHERE session_id = ? AND id != ? AND status = 'running'",
        )
        .bind(&request.session_id)
        .bind(&request.run_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("无法校验 Session 活动 Agent Run：{error}"))?;
        if other_running_runs != 0 {
            return Err("Session 已存在其他活动 Agent Run".to_string());
        }
        // 幂等重放路径：此前仅 SELECT，无写入；外层 COMMIT 空事务等价且无害。
        return Ok(());
    }
    let other_running_runs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_runs
         WHERE session_id = ? AND id != ? AND status = 'running'",
    )
    .bind(&request.session_id)
    .bind(&request.run_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Session 活动 Run：{error}"))?;
    if other_running_runs != 0 {
        return Err("Session 已存在其他活动 Agent Run".to_string());
    }
    if session_status != "idle" {
        return Err("Session 不在空闲状态，拒绝启动新的 Agent Run".to_string());
    }

    let run = sqlx::query(
        "INSERT INTO agent_runs (id, session_id, status, started_at)
         VALUES (?, ?, 'running', ?)",
    )
    .bind(&request.run_id)
    .bind(&request.session_id)
    .bind(request.now)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法启动 Agent Run：{error}"))?;
    if run.rows_affected() != 1 {
        return Err("Agent Run 状态已变化，拒绝非原子启动".to_string());
    }
    let session = sqlx::query(
        "UPDATE agent_sessions SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'idle'",
    )
    .bind(request.now)
    .bind(&request.session_id)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法标记 Session 运行状态：{error}"))?;
    if session.rows_affected() != 1 {
        return Err("Session 状态已变化，拒绝非原子启动 Agent Run".to_string());
    }
    Ok(())
}

pub(super) fn validate_provider_label(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(format!("{label}无效"));
    }
    Ok(())
}

pub(super) async fn start_provider_request_record(
    connection: &mut SqliteConnection,
    request: &StartProviderRequestRequest,
) -> Result<(), String> {
    validate_identifier("Provider Request ID", &request.request_id)?;
    validate_identifier("Session ID", &request.session_id)?;
    validate_identifier("Run ID", &request.run_id)?;
    validate_identifier("Assistant Message ID", &request.assistant_message_id)?;
    validate_provider_label("Provider 类型", &request.model_provider)?;
    validate_provider_label("Provider 模型", &request.model_id)?;
    if request.message_count < 0 || request.tool_count < 0 || request.started_at < 0 {
        return Err("Provider request start fact 无效".to_string());
    }

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Provider request 事务：{error}"))?;
    let outcome = start_provider_request_record_locked(connection, request).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Provider request 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn start_provider_request_record_locked(
    connection: &mut SqliteConnection,
    request: &StartProviderRequestRequest,
) -> Result<(), String> {
    let run: Option<(String, String)> =
        sqlx::query_as("SELECT session_id, status FROM agent_runs WHERE id = ?")
            .bind(&request.run_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Provider request 所属 Run：{error}"))?;
    if run != Some((request.session_id.clone(), "running".to_string())) {
        return Err("Provider request 无法关联到活动运行".to_string());
    }

    let existing: Option<ProviderRequestStartRecord> = sqlx::query_as(
        "SELECT id, session_id, run_id, assistant_message_id, model_provider, model_id,
                message_count, tool_count, status
         FROM provider_requests
         WHERE id = ? OR (run_id = ? AND assistant_message_id = ?)",
    )
    .bind(&request.request_id)
    .bind(&request.run_id)
    .bind(&request.assistant_message_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Provider request start replay：{error}"))?;
    if let Some(existing) = existing {
        if existing.0 != request.request_id
            || existing.1 != request.session_id
            || existing.2 != request.run_id
            || existing.3 != request.assistant_message_id
            || existing.4 != request.model_provider
            || existing.5 != request.model_id
            || existing.6 != request.message_count
            || existing.7 != request.tool_count
        {
            return Err("Provider request start replay 与 canonical effect 不一致".to_string());
        }
        if existing.8 != "running" {
            return Err("Provider request 已进入终态，拒绝重新启动".to_string());
        }
        // 幂等重放路径：此前仅 SELECT，无写入；外层 COMMIT 空事务等价且无害。
        return Ok(());
    }

    let inserted = sqlx::query(
        "INSERT INTO provider_requests
         (id, session_id, run_id, assistant_message_id, model_provider, model_id,
          message_count, tool_count, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)",
    )
    .bind(&request.request_id)
    .bind(&request.session_id)
    .bind(&request.run_id)
    .bind(&request.assistant_message_id)
    .bind(&request.model_provider)
    .bind(&request.model_id)
    .bind(request.message_count)
    .bind(request.tool_count)
    .bind(request.started_at)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法启动 Provider request：{error}"))?;
    if inserted.rows_affected() != 1 {
        return Err("Provider request 状态已变化，拒绝非原子启动".to_string());
    }
    Ok(())
}

pub(super) async fn receive_provider_response_record(
    connection: &mut SqliteConnection,
    request: &ReceiveProviderResponseRequest,
) -> Result<(), String> {
    validate_identifier("Provider Request ID", &request.request_id)?;
    validate_identifier("Session ID", &request.session_id)?;
    validate_identifier("Run ID", &request.run_id)?;
    validate_identifier("Assistant Message ID", &request.assistant_message_id)?;
    if request.response_message_json.len() > MAX_MESSAGE_BYTES
        || request.response_received_at < 0
        || request
            .response_id
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 512 || value.contains('\0'))
        || request
            .response_model
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 256 || value.contains('\0'))
    {
        return Err("Provider response fact 无效".to_string());
    }
    let requested_message: Value = serde_json::from_str(&request.response_message_json)
        .map_err(|error| format!("Provider response message JSON 无效：{error}"))?;
    if json_string(&requested_message, "id", "Provider response message")?
        != request.assistant_message_id
        || json_string(&requested_message, "role", "Provider response message")? != "assistant"
        || !requested_message
            .get("content")
            .is_some_and(Value::is_string)
        || !requested_message
            .get("toolCalls")
            .is_some_and(Value::is_array)
    {
        return Err("Provider response 的 Assistant message 无效".to_string());
    }

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Provider response 事务：{error}"))?;
    let outcome =
        receive_provider_response_record_locked(connection, request, &requested_message).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Provider response 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn receive_provider_response_record_locked(
    connection: &mut SqliteConnection,
    request: &ReceiveProviderResponseRequest,
    requested_message: &Value,
) -> Result<(), String> {
    let existing: Option<ProviderResponseRecord> = sqlx::query_as(
        "SELECT session_id, run_id, assistant_message_id, status,
                response_id, response_model, response_message_json
         FROM provider_requests WHERE id = ?",
    )
    .bind(&request.request_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Provider response replay：{error}"))?;
    let Some(existing) = existing else {
        return Err("Provider response 没有对应的活动请求".to_string());
    };
    if existing.0 != request.session_id
        || existing.1 != request.run_id
        || existing.2 != request.assistant_message_id
    {
        return Err("Provider response 与 request ownership 不一致".to_string());
    }
    if matches!(existing.3.as_str(), "response_received" | "committed") {
        let stored_json = existing
            .6
            .as_ref()
            .ok_or_else(|| "Provider response ledger 缺少 canonical message".to_string())?;
        let stored_message: Value = serde_json::from_str(stored_json)
            .map_err(|error| format!("已存储 Provider response message JSON 无效：{error}"))?;
        if existing.4 != request.response_id
            || existing.5 != request.response_model
            || stored_message != *requested_message
        {
            return Err("Provider response replay 与 canonical effect 不一致".to_string());
        }
        // 幂等重放路径：此前仅 SELECT，无写入；外层 COMMIT 空事务等价且无害。
        return Ok(());
    }
    if existing.3 != "running" {
        return Err("Provider request 已中断，拒绝接收过期 response".to_string());
    }
    let run: Option<(String, String)> =
        sqlx::query_as("SELECT session_id, status FROM agent_runs WHERE id = ?")
            .bind(&request.run_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Provider response 所属 Run：{error}"))?;
    if run != Some((request.session_id.clone(), "running".to_string())) {
        return Err("Provider response 无法关联到活动运行".to_string());
    }
    let updated = sqlx::query(
        "UPDATE provider_requests
         SET status = 'response_received', response_id = ?, response_model = ?,
             response_message_json = ?, response_received_at = ?
         WHERE id = ? AND session_id = ? AND run_id = ?
           AND assistant_message_id = ? AND status = 'running'",
    )
    .bind(&request.response_id)
    .bind(&request.response_model)
    .bind(&request.response_message_json)
    .bind(request.response_received_at)
    .bind(&request.request_id)
    .bind(&request.session_id)
    .bind(&request.run_id)
    .bind(&request.assistant_message_id)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法持久化 Provider response：{error}"))?;
    if updated.rows_affected() != 1 {
        return Err("Provider response 状态已变化，拒绝非原子接收".to_string());
    }
    Ok(())
}

pub(super) async fn start_tool_execution_record(
    connection: &mut SqliteConnection,
    request: &StartToolExecutionRequest,
) -> Result<(), String> {
    validate_identifier("Session ID", &request.session_id)?;
    validate_identifier("Run ID", &request.run_id)?;
    validate_identifier("Tool Call ID", &request.tool_call_id)?;
    if request.tool_name.trim().is_empty()
        || request.tool_name.len() > 128
        || request.tool_name.contains('\0')
        || request.arguments_json.len() > MAX_MESSAGE_BYTES
        || serde_json::from_str::<Value>(&request.arguments_json).is_err()
        || !matches!(request.approval_state.as_str(), "not_required" | "pending")
        || !matches!(request.recovery_policy.as_str(), "never" | "idempotent")
        || request.started_at < 0
        || request
            .idempotency_key
            .as_ref()
            .is_some_and(|key| key.is_empty() || key.len() > 512 || key.contains('\0'))
    {
        return Err("Tool execution start fact 无效".to_string());
    }
    let requested_arguments: Value = serde_json::from_str(&request.arguments_json)
        .map_err(|error| format!("Tool execution arguments JSON 无效：{error}"))?;
    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Tool execution start 事务：{error}"))?;
    let outcome =
        start_tool_execution_record_locked(connection, request, &requested_arguments).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Tool execution start 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn start_tool_execution_record_locked(
    connection: &mut SqliteConnection,
    request: &StartToolExecutionRequest,
    requested_arguments: &Value,
) -> Result<(), String> {
    let run: Option<(String, String)> =
        sqlx::query_as("SELECT session_id, status FROM agent_runs WHERE id = ?")
            .bind(&request.run_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Tool execution 所属 Run：{error}"))?;
    let Some((run_session_id, run_status)) = run else {
        return Err("Tool execution 无法关联到活动 Run".to_string());
    };
    if run_session_id != request.session_id {
        return Err("Tool execution Run 不属于当前 Session".to_string());
    }
    if run_status != "running" {
        return Err("Tool execution 所属 Run 已进入终态".to_string());
    }

    let existing: Option<(String, String, String, String, String, Option<String>)> =
        sqlx::query_as(
            "SELECT tool_name, arguments_json, status, approval_state,
                    recovery_policy, idempotency_key
             FROM tool_executions WHERE run_id = ? AND tool_call_id = ?",
        )
        .bind(&request.run_id)
        .bind(&request.tool_call_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("无法校验 Tool execution start replay：{error}"))?;
    if let Some((
        tool_name,
        arguments_json,
        status,
        approval_state,
        recovery_policy,
        idempotency_key,
    )) = existing
    {
        let stored_arguments: Value = serde_json::from_str(&arguments_json)
            .map_err(|error| format!("已存储 Tool execution arguments JSON 无效：{error}"))?;
        if status != "running" {
            return Err("Tool execution 已进入终态，拒绝重新启动".to_string());
        }
        if tool_name != request.tool_name
            || stored_arguments != *requested_arguments
            || approval_state != request.approval_state
            || recovery_policy != request.recovery_policy
            || idempotency_key != request.idempotency_key
        {
            return Err("Tool execution start replay 与 canonical effect 不一致".to_string());
        }
        // 幂等重放路径：此前仅 SELECT，无写入；外层 COMMIT 空事务等价且无害。
        return Ok(());
    }

    let inserted = sqlx::query(
        "INSERT INTO tool_executions
         (run_id, tool_call_id, tool_name, arguments_json, status, approval_state,
          recovery_policy, idempotency_key, started_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
    )
    .bind(&request.run_id)
    .bind(&request.tool_call_id)
    .bind(&request.tool_name)
    .bind(&request.arguments_json)
    .bind(&request.approval_state)
    .bind(&request.recovery_policy)
    .bind(&request.idempotency_key)
    .bind(request.started_at)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法启动 Tool execution：{error}"))?;
    if inserted.rows_affected() != 1 {
        return Err("Tool execution 状态已变化，拒绝非原子启动".to_string());
    }
    Ok(())
}

pub(super) async fn finish_run(
    connection: &mut SqliteConnection,
    request: &FinishSessionRunRequest,
) -> Result<(), String> {
    validate_identifier("Session ID", &request.session_id)?;
    validate_identifier("Run ID", &request.run_id)?;
    if request.now < 0 {
        return Err("Agent Run 结束时间无效".to_string());
    }
    if !matches!(
        request.end_reason.as_str(),
        "completed" | "stopped" | "aborted" | "error" | "time_limit" | "turn_limit" | "tool_limit"
    ) {
        return Err("Agent Run 结束原因无效".to_string());
    }
    let terminal_status = if request.end_reason == "completed" {
        "completed"
    } else {
        "stopped"
    };

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Agent Run 终结事务：{error}"))?;
    let outcome = finish_run_locked(connection, request, terminal_status).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Agent Run 终结事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn finish_run_locked(
    connection: &mut SqliteConnection,
    request: &FinishSessionRunRequest,
    terminal_status: &str,
) -> Result<(), String> {
    let stored: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT session_id, status, end_reason, error_message
         FROM agent_runs WHERE id = ?",
    )
    .bind(&request.run_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验待终结 Agent Run：{error}"))?;
    let Some((session_id, status, end_reason, error_message)) = stored else {
        return Err("Agent Run 不存在或尚未启动".to_string());
    };
    if session_id != request.session_id {
        return Err("Agent Run 不属于当前 Session".to_string());
    }
    if status != "running" {
        if status == terminal_status
            && end_reason.as_deref() == Some(request.end_reason.as_str())
            && error_message == request.error_message
        {
            // 幂等重放路径：此前仅 SELECT，无写入；外层 COMMIT 空事务等价且无害。
            return Ok(());
        }
        return Err("Agent Run 已以不同终态结束，拒绝过期终结重放".to_string());
    }

    let session_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(&request.session_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Agent Run 所属 Session：{error}"))?;
    if session_status.as_deref() != Some("running") {
        return Err("Agent Run 所属 Session 不在运行中".to_string());
    }

    let pending_provider_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_requests
         WHERE session_id = ? AND run_id = ? AND status IN ('running', 'response_received')",
    )
    .bind(&request.session_id)
    .bind(&request.run_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Agent Run Provider ledger：{error}"))?;
    if pending_provider_count != 0 {
        return Err("Agent Run 仍有未完成的 Provider ledger".to_string());
    }
    let pending_tool_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tool_executions t
         JOIN agent_runs r ON r.id = t.run_id
         WHERE r.session_id = ? AND t.run_id = ? AND t.status = 'running'",
    )
    .bind(&request.session_id)
    .bind(&request.run_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Agent Run Tool ledger：{error}"))?;
    if pending_tool_count != 0 {
        return Err("Agent Run 仍有未完成的 Tool ledger".to_string());
    }

    let finished = sqlx::query(
        "UPDATE agent_runs
         SET status = ?, end_reason = ?, error_message = ?, ended_at = ?
         WHERE id = ? AND session_id = ? AND status = 'running'",
    )
    .bind(terminal_status)
    .bind(&request.end_reason)
    .bind(&request.error_message)
    .bind(request.now)
    .bind(&request.run_id)
    .bind(&request.session_id)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法终结 Agent Run：{error}"))?;
    if finished.rows_affected() != 1 {
        return Err("Agent Run 状态已变化，拒绝非原子终结".to_string());
    }
    Ok(())
}
