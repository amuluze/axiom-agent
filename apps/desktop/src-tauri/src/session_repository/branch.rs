use serde_json::Value;
use sqlx::{Row, SqliteConnection};
use std::collections::HashSet;
use crate::runtime_manifest::validate_identifier;

use super::*;

pub(super) fn validate_branch_request(request: &CreateSessionBranchRequest) -> Result<(), String> {
    let encoded = serde_json::to_vec(request)
        .map_err(|error| format!("无法编码 Session 分支请求：{error}"))?;
    if encoded.len() > MAX_BRANCH_REQUEST_BYTES {
        return Err("Session 分支请求超过 32 MiB 安全上限".to_string());
    }
    validate_identifier("新 Session ID", &request.id)?;
    validate_identifier("源 Session ID", &request.source_session_id)?;
    validate_identifier("分支边界消息 ID", &request.through_message_id)?;
    if let Some(message_id) = &request.retried_message_id {
        validate_identifier("Retry 消息 ID", message_id)?;
    }
    if request.created_at < 0
        || request.activated_at < request.created_at
        || request.title.trim().is_empty()
    {
        return Err("Session 分支元数据无效".to_string());
    }
    match request.kind.as_str() {
        "branch" if request.retried_message_id.is_none() => {}
        "retry" if request.retried_message_id.is_some() => {}
        "branch" => return Err("普通 Session 分支不能包含 Retry 目标".to_string()),
        "retry" => return Err("Retry Session 分支缺少目标消息".to_string()),
        _ => return Err("Session 分支类型无效".to_string()),
    }
    if request.messages.is_empty() || request.messages.len() > MAX_BRANCH_MESSAGES {
        return Err("Session 分支消息数量无效".to_string());
    }
    for (label, json) in [
        ("活动工具", Some(request.active_tool_names_json.as_str())),
        ("Reasoning", request.reasoning_json.as_deref()),
        ("Provider 配置", request.provider_config_json.as_deref()),
        ("Runtime manifest", request.runtime_manifest_json.as_deref()),
    ] {
        if let Some(json) = json {
            serde_json::from_str::<Value>(json)
                .map_err(|error| format!("Session 分支 {label} JSON 无效：{error}"))?;
        }
    }

    let mut message_ids = HashSet::new();
    let mut source_ids = HashSet::new();
    let mut synthetic_count = 0;
    for (index, message) in request.messages.iter().enumerate() {
        validate_identifier("分支消息 ID", &message.id)?;
        if !message_ids.insert(message.id.as_str()) {
            return Err("Session 分支包含重复消息 ID".to_string());
        }
        if !matches!(
            message.role.as_str(),
            "user" | "assistant" | "tool" | "custom"
        ) || message.created_at < 0
            || message.content_json.len() > MAX_REQUEST_BYTES
        {
            return Err("Session 分支消息元数据无效".to_string());
        }
        if let Some(artifact_id) = &message.artifact_id {
            validate_identifier("Artifact ID", artifact_id)?;
        }
        match &message.source_message_id {
            Some(source_id) => {
                validate_identifier("源消息 ID", source_id)?;
                if synthetic_count > 0 || !source_ids.insert(source_id.as_str()) {
                    return Err("Session 分支源消息顺序无效".to_string());
                }
            }
            None => {
                synthetic_count += 1;
                if synthetic_count > 1
                    || index + 1 != request.messages.len()
                    || request.kind != "branch"
                    || message.role != "custom"
                    || message.artifact_id.is_some()
                {
                    return Err("Session 分支合成消息无效".to_string());
                }
            }
        }
        let content = serde_json::from_str::<Value>(&message.content_json)
            .map_err(|error| format!("Session 分支消息 JSON 无效：{error}"))?;
        if content.get("id").and_then(Value::as_str) != Some(message.id.as_str())
            || content.get("role").and_then(Value::as_str) != Some(message.role.as_str())
            || content.get("createdAt").and_then(Value::as_i64) != Some(message.created_at)
        {
            return Err("Session 分支消息 JSON 与索引元数据不一致".to_string());
        }
    }
    Ok(())
}

pub(super) async fn create_branch(
    connection: &mut SqliteConnection,
    request: &CreateSessionBranchRequest,
) -> Result<(), String> {
    validate_branch_request(request)?;
    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT/UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Session 分支事务：{error}"))?;
    let outcome = create_branch_locked(connection, request).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Session 分支事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn create_branch_locked(
    connection: &mut SqliteConnection,
    request: &CreateSessionBranchRequest,
) -> Result<(), String> {
    let source_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(&request.source_session_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验源 Session：{error}"))?;
    match source_status.as_deref() {
        None => return Err("源会话不存在或已被删除".to_string()),
        Some("idle") => {}
        Some("running") => return Err("Agent 运行期间不能创建会话分支".to_string()),
        Some(_) => return Err("源 Session 状态不允许创建分支".to_string()),
    }

    let source_messages = sqlx::query(
        "SELECT id, role, created_at, artifact_id
         FROM agent_messages WHERE session_id = ? ORDER BY sequence ASC",
    )
    .bind(&request.source_session_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法读取源 Session 消息边界：{error}"))?;
    let boundary_index = source_messages
        .iter()
        .position(|row| row.get::<String, _>("id") == request.through_message_id)
        .ok_or_else(|| "分支边界消息不存在于源会话".to_string())?;
    let copied_count = request
        .messages
        .iter()
        .take_while(|message| message.source_message_id.is_some())
        .count();
    if copied_count != boundary_index + 1 {
        return Err("Session 分支消息不是边界前的完整连续前缀".to_string());
    }
    for (message, source) in request.messages[..copied_count]
        .iter()
        .zip(source_messages[..copied_count].iter())
    {
        let source_id = source.get::<String, _>("id");
        let source_role = source.get::<String, _>("role");
        let source_created_at = source.get::<i64, _>("created_at");
        let source_artifact_id = source.get::<Option<String>, _>("artifact_id");
        if message.source_message_id.as_deref() != Some(source_id.as_str())
            || message.role != source_role
            || message.created_at != source_created_at
            || message.artifact_id != source_artifact_id
        {
            return Err("Session 分支复制消息与源历史不一致".to_string());
        }
    }
    if let Some(summary) = request.messages.get(copied_count) {
        let expected_from = source_messages
            .get(boundary_index + 1)
            .ok_or_else(|| "Branch Summary 缺少已离开历史".to_string())?
            .get::<String, _>("id");
        let expected_through = source_messages
            .last()
            .expect("branch boundary guarantees at least one source message")
            .get::<String, _>("id");
        let content = serde_json::from_str::<Value>(&summary.content_json)
            .map_err(|error| format!("Branch Summary JSON 无效：{error}"))?;
        let data = content
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| "Branch Summary 数据无效".to_string())?;
        if content.get("customType").and_then(Value::as_str) != Some("branch-summary")
            || data.get("sourceFromMessageId").and_then(Value::as_str)
                != Some(expected_from.as_str())
            || data.get("sourceThroughMessageId").and_then(Value::as_str)
                != Some(expected_through.as_str())
        {
            return Err("Branch Summary 必须覆盖分支边界后的完整已离开历史".to_string());
        }
    }
    if request.kind == "retry" {
        let retried = source_messages
            .get(boundary_index + 1)
            .ok_or_else(|| "Retry 目标不存在于源会话".to_string())?;
        if request.retried_message_id.as_deref() != Some(retried.get::<String, _>("id").as_str())
            || retried.get::<String, _>("role") != "assistant"
        {
            return Err("Retry 目标必须是分支边界后的第一条 Assistant 消息".to_string());
        }
    }

	    sqlx::query(
	        "INSERT INTO agent_sessions
	         (id, title, system_prompt, model_provider, model_id, status, created_at, updated_at,
	          parent_session_id, forked_from_message_id, branch_kind, retried_message_id,
	          reasoning_json, active_tool_names_json, provider_config_json, runtime_manifest_json,
	          workspace_path, workspace_name)
	         VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	    )
	    .bind(&request.id)
	    .bind(&request.title)
	    .bind(&request.system_prompt)
	    .bind(&request.model_provider)
	    .bind(&request.model_id)
	    .bind(request.created_at)
	    .bind(request.created_at)
	    .bind(&request.source_session_id)
	    .bind(&request.through_message_id)
	    .bind(&request.kind)
	    .bind(&request.retried_message_id)
	    .bind(&request.reasoning_json)
	    .bind(&request.active_tool_names_json)
	    .bind(&request.provider_config_json)
	    .bind(&request.runtime_manifest_json)
	    .bind(&request.workspace_path)
	    .bind(&request.workspace_name)
	    .execute(&mut *connection)
	    .await
	    .map_err(|error| format!("无法创建 Session 分支：{error}"))?;

    for (index, message) in request.messages.iter().enumerate() {
        sqlx::query(
            "INSERT INTO agent_messages
             (id, session_id, run_id, sequence, role, content_json, created_at,
              source_message_id, artifact_id)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&message.id)
        .bind(&request.id)
        .bind(i64::try_from(index + 1).expect("bounded branch message count"))
        .bind(&message.role)
        .bind(&message.content_json)
        .bind(message.created_at)
        .bind(&message.source_message_id)
        .bind(&message.artifact_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法复制 Session 分支消息：{error}"))?;
    }
    let activated = sqlx::query(
        "UPDATE agent_sessions SET status = 'idle', updated_at = ?
         WHERE id = ? AND status = 'creating'",
    )
    .bind(request.activated_at)
    .bind(&request.id)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法激活 Session 分支：{error}"))?;
    if activated.rows_affected() != 1 {
        return Err("Session 分支状态已变化，拒绝非原子激活".to_string());
    }
    Ok(())
}
