use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use crate::runtime_manifest::validate_identifier;

use super::*;
use super::db_io::*;

pub(super) async fn load_session_snapshot(
    connection: &mut SqliteConnection,
    session_id: &str,
) -> Result<SessionSnapshotRows, String> {
    validate_identifier("Session ID", session_id)?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| format!("无法开始 Session snapshot 事务：{error}"))?;
    let session = sqlx::query("SELECT * FROM agent_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("无法读取 Session snapshot 元数据：{error}"))?
        .as_ref()
        .map(serialize_row)
        .transpose()?;
    let messages = sqlx::query(
        "SELECT content_json FROM agent_messages WHERE session_id = ? ORDER BY sequence ASC",
    )
    .bind(session_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("无法读取 Session snapshot 消息：{error}"))?
    .iter()
    .map(serialize_row)
    .collect::<Result<Vec<_>, _>>()?;
    let latest_checkpoint = sqlx::query(
        "SELECT * FROM context_checkpoints WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| format!("无法读取 Session snapshot 检查点：{error}"))?
    .as_ref()
    .map(serialize_row)
    .transpose()?;
    let pending_journal = sqlx::query(
        "SELECT id, session_id, sequence, kind, queue_kind, payload_json, status,
                consumer_run_id, created_at, recovered_at
         FROM agent_session_journal
         WHERE session_id = ? AND status = 'pending'
         ORDER BY sequence ASC",
    )
    .bind(session_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("无法读取 Session snapshot journal：{error}"))?
    .iter()
    .map(serialize_row)
    .collect::<Result<Vec<_>, _>>()?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("无法结束 Session snapshot 事务：{error}"))?;
    Ok(SessionSnapshotRows {
        session,
        messages,
        latest_checkpoint,
        pending_journal,
    })
}

pub(super) async fn query_rows(
    connection: &mut SqliteConnection,
    operation: SessionRepositoryQuery,
    parameters: &[Value],
) -> Result<Vec<Value>, String> {
    validate_parameter_payload(parameters, operation.parameter_count())?;
    let query = bind_parameters(sqlx::query(operation.statement()), parameters)?;
    let rows = query
        .fetch_all(connection)
        .await
        .map_err(|error| format!("SessionRepository 查询失败：{error}"))?;
    rows.iter().map(serialize_row).collect()
}

pub(super) async fn execute_mutation(
    connection: &mut SqliteConnection,
    operation: SessionRepositoryMutation,
    parameters: &[Value],
) -> Result<SessionDatabaseExecuteResult, String> {
    validate_parameter_payload(parameters, operation.parameter_count())?;
    let query = bind_parameters(sqlx::query(operation.statement()), parameters)?;
    let result = query
        .execute(connection)
        .await
        .map_err(|error| format!("SessionRepository 写入失败：{error}"))?;
    Ok(SessionDatabaseExecuteResult {
        rows_affected: result.rows_affected(),
        last_insert_id: result.last_insert_rowid(),
    })
}
