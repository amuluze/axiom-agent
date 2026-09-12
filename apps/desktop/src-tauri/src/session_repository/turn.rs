use sqlx::{QueryBuilder, Sqlite, SqliteConnection};
use std::collections::HashSet;
use crate::runtime_manifest::validate_identifier;

use super::*;

pub(super) async fn save_turn_point(
    connection: &mut SqliteConnection,
    request: &SaveSessionTurnPointRequest,
) -> Result<(), String> {
    let encoded = serde_json::to_string(request)
        .map_err(|error| format!("无法编码 Turn Save Point：{error}"))?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("Turn Save Point 超过 2 MiB 安全上限".to_string());
    }
    validate_identifier("Session ID", &request.session_id)?;
    validate_identifier("Run ID", &request.run_id)?;
    if let Some(message_id) = &request.last_message_id {
        validate_identifier("最后消息 ID", message_id)?;
    }
    if let Some(checkpoint_id) = &request.checkpoint_id {
        validate_identifier("Checkpoint ID", checkpoint_id)?;
    }
    if request.turn < 1 || request.message_count < 0 || request.created_at < 0 {
        return Err("Turn Save Point 边界无效".to_string());
    }
    if request.mutation_batch_ids.len() > MAX_TURN_MUTATION_BATCHES {
        return Err("Turn Save Point mutation batch 数量超过安全上限".to_string());
    }
    if request.had_pending_mutations == request.mutation_batch_ids.is_empty() {
        return Err("Turn Save Point mutation batch 边界无效".to_string());
    }
    let mut batch_ids: HashSet<&str> = HashSet::new();
    for batch_id in &request.mutation_batch_ids {
        validate_identifier("Runtime mutation batch ID", batch_id)?;
        if !batch_ids.insert(batch_id.as_str()) {
            return Err("Turn Save Point 包含重复 mutation batch ID".to_string());
        }
    }

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + UPDATE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Turn Save Point 事务：{error}"))?;
    let outcome = save_turn_point_locked(connection, request, &encoded).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Turn Save Point 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn save_turn_point_locked(
    connection: &mut SqliteConnection,
    request: &SaveSessionTurnPointRequest,
    encoded: &str,
) -> Result<(), String> {
    let statuses: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT r.status, s.status, r.latest_turn_save_point_json
         FROM agent_runs r
         JOIN agent_sessions s ON s.id = r.session_id
         WHERE r.id = ? AND r.session_id = ?",
    )
    .bind(&request.run_id)
    .bind(&request.session_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Turn Save Point 活动运行：{error}"))?;
    let Some((run_status, session_status, latest_json)) = statuses else {
        return Err("Turn Save Point 对应的运行不在执行中".to_string());
    };
    if run_status != "running" || session_status != "running" {
        return Err("Turn Save Point 对应的运行不在执行中".to_string());
    }
    if let Some(latest_json) = latest_json {
        let latest: SaveSessionTurnPointRequest = serde_json::from_str(&latest_json)
            .map_err(|error| format!("已存储 Turn Save Point 无效：{error}"))?;
        if request.turn < latest.turn {
            return Err("Turn Save Point 轮次不能回退".to_string());
        }
        if request.turn == latest.turn {
            if request == &latest {
                // 幂等重放路径：此前仅 SELECT，无写入；外层 COMMIT 空事务等价且无害。
                return Ok(());
            }
            return Err("同轮 Turn Save Point replay 与 canonical effect 不一致".to_string());
        }
    }

    let committed_batch_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM runtime_mutation_batches
         WHERE session_id = ? AND run_id = ? AND turn = ?",
    )
    .bind(&request.session_id)
    .bind(&request.run_id)
    .bind(request.turn)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Turn Save Point mutation batch 边界：{error}"))?;
    if committed_batch_count != request.mutation_batch_ids.len() as i64 {
        return Err("Turn Save Point mutation batch 边界不完整".to_string());
    }
    if !request.mutation_batch_ids.is_empty() {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT COUNT(*) FROM runtime_mutation_batches WHERE session_id = ",
        );
        builder.push_bind(request.session_id.clone());
        builder.push(" AND run_id = ");
        builder.push_bind(request.run_id.clone());
        builder.push(" AND turn = ");
        builder.push_bind(request.turn);
        builder.push(" AND id IN (");
        {
            let mut separated = builder.separated(", ");
            for batch_id in &request.mutation_batch_ids {
                separated.push_bind(batch_id.clone());
            }
        }
        builder.push(")");
        let matched_batch_count: i64 = builder
            .build_query_scalar()
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Turn Save Point mutation batch 身份：{error}"))?;
        if matched_batch_count != request.mutation_batch_ids.len() as i64 {
            return Err(
                "Turn Save Point 引用了未提交或不属于当前 Run/Turn 的 mutation batch".to_string(),
            );
        }
    }

    let boundary: (i64, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*),
                (SELECT id FROM agent_messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1)
         FROM agent_messages WHERE session_id = ?",
    )
    .bind(&request.session_id)
    .bind(&request.session_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Turn Save Point 消息边界：{error}"))?;
    if boundary.0 != request.message_count || boundary.1 != request.last_message_id {
        return Err("Turn Save Point 与已持久化消息边界不一致".to_string());
    }

    let latest_checkpoint_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM context_checkpoints WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(&request.session_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Turn Save Point 上下文检查点：{error}"))?;
    if latest_checkpoint_id != request.checkpoint_id {
        return Err("Turn Save Point 与已持久化上下文检查点不一致".to_string());
    }

    let result = sqlx::query(
        "UPDATE agent_runs SET latest_turn_save_point_json = ?
         WHERE id = ? AND session_id = ? AND status = 'running'",
    )
    .bind(encoded)
    .bind(&request.run_id)
    .bind(&request.session_id)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法写入 Turn Save Point：{error}"))?;
    if result.rows_affected() != 1 {
        return Err("Turn Save Point 写入时运行状态已变化".to_string());
    }

    Ok(())
}

pub(super) async fn settle_run(
    connection: &mut SqliteConnection,
    request: &SettleSessionRunRequest,
) -> Result<(), String> {
    validate_identifier("Session ID", &request.session_id)?;
    validate_identifier("Run ID", &request.run_id)?;
    if let Some(message_id) = &request.last_message_id {
        validate_identifier("最后消息 ID", message_id)?;
    }
    if let Some(checkpoint_id) = &request.checkpoint_id {
        validate_identifier("Checkpoint ID", checkpoint_id)?;
    }
    if request.now < 0 || request.message_count < 0 {
        return Err("Agent Save Point 边界无效".to_string());
    }

    // BEGIN IMMEDIATE（写锁先行）：「SELECT 校验 + UPDATE/DELETE」必须对其他写者原子。
    // 池化后 DEFERRED 事务在 SELECT（读快照）→ 写（升级写锁）间若他人提交会得到
    // BUSY_SNAPSHOT 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Agent Run 结算事务：{error}"))?;
    let outcome = settle_run_locked(connection, request).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Agent Run 结算事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn settle_run_locked(
    connection: &mut SqliteConnection,
    request: &SettleSessionRunRequest,
) -> Result<(), String> {
    let session_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(&request.session_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Agent Save Point 所属 Session：{error}"))?;
    match session_status.as_deref() {
        None => return Err("会话不存在或已被删除".to_string()),
        Some("running" | "idle") => {}
        Some(_) => return Err("Session 状态不允许结算 Agent Run".to_string()),
    }

    let run_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_runs WHERE id = ? AND session_id = ?")
            .bind(&request.run_id)
            .bind(&request.session_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Agent Save Point 对应 Run：{error}"))?;
    if run_status
        .as_deref()
        .is_none_or(|status| status == "running")
    {
        return Err("Agent Save Point 对应的运行尚未完成".to_string());
    }
    let active_run_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_runs WHERE session_id = ? AND status = 'running'",
    )
    .bind(&request.session_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Session 活动 Run：{error}"))?;
    if active_run_count != 0 {
        return Err("Session 已开始其他 Agent Run，拒绝过期结算".to_string());
    }

    let boundary: (i64, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*),
                (SELECT id FROM agent_messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1)
         FROM agent_messages WHERE session_id = ?",
    )
    .bind(&request.session_id)
    .bind(&request.session_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Agent Save Point 消息边界：{error}"))?;
    if boundary.0 != request.message_count || boundary.1 != request.last_message_id {
        return Err("Agent Save Point 与已持久化消息边界不一致".to_string());
    }

    let latest_checkpoint_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM context_checkpoints WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(&request.session_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Agent Save Point 上下文检查点：{error}"))?;
    if latest_checkpoint_id != request.checkpoint_id {
        return Err("Agent Save Point 与已持久化上下文检查点不一致".to_string());
    }

    let session = sqlx::query(
        "UPDATE agent_sessions SET status = 'idle', updated_at = ?
         WHERE id = ? AND status IN ('running', 'idle')",
    )
    .bind(request.now)
    .bind(&request.session_id)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法标记 Session 空闲状态：{error}"))?;
    if session.rows_affected() != 1 {
        return Err("Session 状态已变化，拒绝非原子结算 Agent Run".to_string());
    }
    sqlx::query(
        "DELETE FROM agent_session_journal
         WHERE session_id = ? AND status IN ('applied', 'discarded')",
    )
    .bind(&request.session_id)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法清理已结算 Session Journal：{error}"))?;

    Ok(())
}
