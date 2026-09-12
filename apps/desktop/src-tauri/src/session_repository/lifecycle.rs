use sqlx::SqliteConnection;
use crate::runtime_manifest::validate_identifier;

use super::*;

pub(super) async fn clear_session(
    connection: &mut SqliteConnection,
    request: &ClearSessionRepositoryRequest,
) -> Result<(), String> {
    validate_identifier("Session ID", &request.session_id)?;
    if request.now < 0 {
        return Err("Session 清理时间无效".to_string());
    }

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + DELETE/UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Session 清理事务：{error}"))?;
    let outcome = clear_session_locked(connection, request).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Session 清理事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn clear_session_locked(
    connection: &mut SqliteConnection,
    request: &ClearSessionRepositoryRequest,
) -> Result<(), String> {
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE id = ?")
        .bind(&request.session_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("无法校验待清理 Session：{error}"))?;
    if exists != 1 {
        return Err("会话不存在或已被删除".to_string());
    }

    delete_session_graph(&mut *connection, &request.session_id).await?;

    let result = if request.delete_session {
        sqlx::query("DELETE FROM agent_sessions WHERE id = ?")
            .bind(&request.session_id)
            .execute(&mut *connection)
            .await
    } else {
        sqlx::query(
            "UPDATE agent_sessions
             SET title = '新会话', status = 'idle', updated_at = ? WHERE id = ?",
        )
        .bind(request.now)
        .bind(&request.session_id)
        .execute(&mut *connection)
        .await
    }
    .map_err(|error| format!("无法结算 Session 清理事务：{error}"))?;
    if result.rows_affected() != 1 {
        return Err("会话不存在或已被删除".to_string());
    }

    Ok(())
}

pub(super) async fn delete_session_graph(
    connection: &mut SqliteConnection,
    session_id: &str,
) -> Result<(), String> {
    for statement in [
        "DELETE FROM agent_session_journal WHERE session_id = ?",
        "DELETE FROM context_checkpoints WHERE session_id = ?",
        "DELETE FROM runtime_mutation_batches WHERE session_id = ?",
        "DELETE FROM provider_requests WHERE session_id = ?",
        "DELETE FROM tool_executions
         WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ?)",
        "DELETE FROM agent_messages WHERE session_id = ?",
        "DELETE FROM agent_runs WHERE session_id = ?",
    ] {
        sqlx::query(statement)
            .bind(session_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法清理 Session 持久化事实：{error}"))?;
    }
    Ok(())
}

pub(super) async fn delete_with_successor(
    connection: &mut SqliteConnection,
    request: &DeleteSessionWithSuccessorRequest,
) -> Result<(), String> {
    validate_identifier("待删除 Session ID", &request.session_id)?;
    validate_identifier("Successor Session ID", &request.successor_id)?;
    if request.session_id == request.successor_id {
        return Err("Successor Session 不能复用待删除 Session ID".to_string());
    }
    validate_runtime_config_request(&UpdateSessionRuntimeConfigRequest {
        session_id: request.successor_id.clone(),
        system_prompt: request.system_prompt.clone(),
        model_provider: request.model_provider.clone(),
        model_id: request.model_id.clone(),
        reasoning_json: request.reasoning_json.clone(),
        active_tool_names_json: request.active_tool_names_json.clone(),
        provider_config_json: request.provider_config_json.clone(),
        runtime_manifest_json: request.runtime_manifest_json.clone(),
        now: request.now,
    })?;

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + INSERT/DELETE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Session successor 事务：{error}"))?;
    let outcome = delete_with_successor_locked(connection, request).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Session successor 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn delete_with_successor_locked(
    connection: &mut SqliteConnection,
    request: &DeleteSessionWithSuccessorRequest,
) -> Result<(), String> {
    let target: Option<(String, i64, i64)> = sqlx::query_as(
        "SELECT status,
                (SELECT COUNT(*) FROM agent_sessions),
                (SELECT COUNT(*) FROM agent_runs
                 WHERE session_id = agent_sessions.id AND status = 'running')
         FROM agent_sessions WHERE id = ?",
    )
    .bind(&request.session_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验待替换 Session：{error}"))?;
    let Some((status, session_count, active_run_count)) = target else {
        return Err("会话不存在或已被删除".to_string());
    };
    if status != "idle" || session_count != 1 || active_run_count != 0 {
        return Err("只有最后一个空闲 Session 可以原子替换".to_string());
    }

	    let inserted = sqlx::query(
	        "INSERT INTO agent_sessions
	         (id, title, system_prompt, model_provider, model_id, reasoning_json,
	          active_tool_names_json, provider_config_json, runtime_manifest_json,
	          workspace_path, workspace_name,
	          status, created_at, updated_at)
	         VALUES (?, '新会话', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'idle', ?, ?)",
	    )
	    .bind(&request.successor_id)
	    .bind(&request.system_prompt)
	    .bind(&request.model_provider)
	    .bind(&request.model_id)
	    .bind(&request.reasoning_json)
	    .bind(&request.active_tool_names_json)
	    .bind(&request.provider_config_json)
	    .bind(&request.runtime_manifest_json)
	    .bind(request.now)
	    .bind(request.now)
	    .execute(&mut *connection)
	    .await
	    .map_err(|error| format!("无法创建 Successor Session：{error}"))?;
    if inserted.rows_affected() != 1 {
        return Err("无法创建 Successor Session".to_string());
    }

    delete_session_graph(&mut *connection, &request.session_id).await?;
    let deleted = sqlx::query("DELETE FROM agent_sessions WHERE id = ? AND status = 'idle'")
        .bind(&request.session_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法删除已替换 Session：{error}"))?;
    if deleted.rows_affected() != 1 {
        return Err("待替换 Session 状态已变化，拒绝非原子删除".to_string());
    }
    Ok(())
}
