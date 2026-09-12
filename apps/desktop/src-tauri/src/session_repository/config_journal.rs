use serde_json::Value;
use sqlx::{Connection, QueryBuilder, Sqlite, SqliteConnection};
use std::collections::HashSet;
use crate::runtime_manifest::{validate_identifier, validate_runtime_manifest};

use super::*;

pub(super) fn validate_runtime_config_request(
    request: &UpdateSessionRuntimeConfigRequest,
) -> Result<(), String> {
    validate_identifier("Session ID", &request.session_id)?;
    let encoded = serde_json::to_vec(request)
        .map_err(|error| format!("无法编码 Session Runtime 配置：{error}"))?;
    if encoded.len() > MAX_REQUEST_BYTES
        || request.now < 0
        || request.system_prompt.len() > MAX_CHECKPOINT_SUMMARY_BYTES
        || request.system_prompt.contains('\0')
        || request.model_provider.trim().is_empty()
        || request.model_provider.len() > 128
        || request.model_provider.contains('\0')
        || request.model_id.trim().is_empty()
        || request.model_id.len() > 256
        || request.model_id.contains('\0')
    {
        return Err("Session Runtime 配置无效或超过安全上限".to_string());
    }
    let active_tools: Vec<String> = serde_json::from_str(&request.active_tool_names_json)
        .map_err(|error| format!("Session Runtime 活动工具 JSON 无效：{error}"))?;
    if active_tools.len() > 256
        || active_tools
            .iter()
            .any(|name| name.trim().is_empty() || name.len() > 128 || name.contains('\0'))
        || active_tools.iter().collect::<HashSet<_>>().len() != active_tools.len()
    {
        return Err("Session Runtime 活动工具状态无效".to_string());
    }
    for (label, json) in [
        ("Reasoning", request.reasoning_json.as_deref()),
        ("Provider 配置", request.provider_config_json.as_deref()),
    ] {
        if let Some(json) = json {
            serde_json::from_str::<Value>(json)
                .map_err(|error| format!("Session Runtime {label} JSON 无效：{error}"))?;
        }
    }
    if let Some(runtime_manifest) = request.runtime_manifest_json.as_deref() {
        validate_runtime_manifest(runtime_manifest, &active_tools)
            .map_err(|error| format!("Session Runtime manifest 无效：{error}"))?;
    }
    Ok(())
}

pub(super) async fn initialize_runtime_defaults(
    connection: &mut SqliteConnection,
    request: &InitializeSessionRuntimeDefaultsRequest,
) -> Result<(), String> {
    if request.model_provider.trim().is_empty()
        || request.model_provider.len() > 128
        || request.model_provider.contains('\0')
        || request.model_id.trim().is_empty()
        || request.model_id.len() > 256
        || request.model_id.contains('\0')
    {
        return Err("Session Runtime 默认模型无效".to_string());
    }
    let provider_config = request
        .provider_config_json
        .as_deref()
        .map(|json| {
            serde_json::from_str::<Value>(json)
                .map_err(|error| format!("Session 默认 Provider 配置 JSON 无效：{error}"))
        })
        .transpose()?;
    let runtime_manifest = request
        .runtime_manifest_json
        .as_deref()
        .map(|json| {
            validate_runtime_manifest(json, &[])
                .map_err(|error| format!("Session 默认 Runtime manifest 无效：{error}"))
        })
        .transpose()?;
    if provider_config
        .as_ref()
        .is_some_and(|value| !value.is_object())
        || runtime_manifest
            .as_ref()
            .is_some_and(|value| !value.is_object() || value.get("provider").is_none())
    {
        return Err("Session Runtime 默认配置结构无效".to_string());
    }

    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| format!("无法开始 Session Runtime 默认配置事务：{error}"))?;
    if let Some(provider_config_json) = &request.provider_config_json {
        sqlx::query(
            "UPDATE agent_sessions SET provider_config_json = ?
             WHERE provider_config_json IS NULL AND model_provider = ? AND model_id = ?",
        )
        .bind(provider_config_json)
        .bind(&request.model_provider)
        .bind(&request.model_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("无法初始化 Session Provider 配置：{error}"))?;
    }
    if let Some(base_manifest) = runtime_manifest {
        let legacy: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT id, model_provider, model_id FROM agent_sessions
             WHERE runtime_manifest_json IS NULL",
        )
        .fetch_all(&mut *transaction)
        .await
        .map_err(|error| format!("无法读取旧 Session Runtime manifest：{error}"))?;
        for (session_id, model_provider, model_id) in legacy {
            let manifest = if model_provider == request.model_provider
                && model_id == request.model_id
            {
                base_manifest.clone()
            } else {
                let api_format = match model_provider.as_str() {
                    "axiom" | "demo" => "demo",
                    "generic-openai-compatible" | "openai-compatible" => "openai-compatible",
                    "openai" | "openai-responses" => "openai-responses",
                    "generic-anthropic-compatible" | "minimax" | "anthropic-compatible" => {
                        "anthropic-compatible"
                    }
                    // 未知/自定义 provider：用 anthropic-compatible 兜底合成 manifest 并告警。
                    // 单条脏数据不得阻断整批回填——该函数在每次启动时执行，
                    // 整批失败会让应用无法启动且无旁路恢复路径。
                    _ => {
                        eprintln!(
                            "Axiom: 旧 Session {} 的 provider {} 不在已知列表，已用 anthropic-compatible 兜底回填 manifest",
                            session_id, model_provider
                        );
                        "anthropic-compatible"
                    }
                };
                serde_json::json!({
                    "schemaVersion": 1,
                    "provider": { "kind": api_format, "model": model_id },
                    "tools": base_manifest.get("tools").cloned().unwrap_or(Value::Array(vec![])),
                    "hooks": base_manifest.get("hooks").cloned().unwrap_or(Value::Array(vec![])),
                })
            };
            let encoded = serde_json::to_string(&manifest)
                .map_err(|error| format!("无法编码 Session Runtime manifest：{error}"))?;
            let updated = sqlx::query(
                "UPDATE agent_sessions SET runtime_manifest_json = ?
                 WHERE id = ? AND runtime_manifest_json IS NULL",
            )
            .bind(encoded)
            .bind(session_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("无法初始化 Session Runtime manifest：{error}"))?;
            if updated.rows_affected() != 1 {
                return Err("Session Runtime manifest 状态已变化".to_string());
            }
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("无法提交 Session Runtime 默认配置事务：{error}"))
}

pub(super) async fn append_journal_entry(
    connection: &mut SqliteConnection,
    request: &AppendSessionJournalEntryRequest,
) -> Result<(), String> {
    validate_identifier("Journal entry ID", &request.id)?;
    validate_identifier("Session ID", &request.session_id)?;
    let payload: Value = serde_json::from_str(&request.payload_json)
        .map_err(|error| format!("Agent journal payload JSON 无效：{error}"))?;
    if request.sequence < 0
        || request.created_at < 0
        || request.payload_json.len() > MAX_MESSAGE_BYTES
        || !payload.is_object()
        || match request.kind.as_str() {
            "queue" => !request
                .queue_kind
                .as_deref()
                .is_some_and(|kind| matches!(kind, "steering" | "follow-up" | "next-turn")),
            "message_append" | "runtime_update" => request.queue_kind.is_some(),
            _ => true,
        }
    {
        return Err("Agent journal entry 元数据无效".to_string());
    }
    // BEGIN IMMEDIATE（写锁先行）：「SELECT 去重 + INSERT」必须对其他写者原子。
    // 此前单连接模型靠外层 connection Mutex 串行化，池化后 DEFERRED 事务在
    // SELECT（读快照）→ INSERT（升级写锁）间若他人提交会得到 BUSY_SNAPSHOT
    // 且 busy_timeout 不重试；IMMEDIATE 让并发写者经 busy_timeout 排队，
    // 同 ID 重试（journal 幂等契约，见 docs/invariants.md #1）收敛到 Ok。
    // 手工管理 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED 模式。
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法开始 Agent journal 事务：{error}"))?;
    let outcome = append_journal_entry_locked(connection, request, &payload).await;
    match outcome {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法提交 Agent journal 事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn append_journal_entry_locked(
    connection: &mut SqliteConnection,
    request: &AppendSessionJournalEntryRequest,
    payload: &Value,
) -> Result<(), String> {
    type StoredJournalEntry = (String, i64, String, Option<String>, String, String, i64);
    let existing: Option<StoredJournalEntry> = sqlx::query_as(
        "SELECT session_id, sequence, kind, queue_kind, payload_json, status, created_at
         FROM agent_session_journal WHERE id = ?",
    )
    .bind(&request.id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法校验 Agent journal entry ID：{error}"))?;
    if let Some(existing) = existing {
        let existing_payload: Value = serde_json::from_str(&existing.4)
            .map_err(|error| format!("已存储 Agent journal payload 无效：{error}"))?;
        if existing.0 == request.session_id
            && existing.1 == request.sequence
            && existing.2 == request.kind
            && existing.3 == request.queue_kind
            && existing_payload == *payload
            && existing.5 == "pending"
            && existing.6 == request.created_at
        {
            return Ok(());
        }
        return Err("Agent journal entry ID 已被不一致的 canonical effect 占用".to_string());
    }
    let inserted = sqlx::query(
        "INSERT INTO agent_session_journal
         (id, session_id, sequence, kind, queue_kind, payload_json, status,
          consumer_run_id, created_at, applied_at, recovered_at)
         SELECT ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL
         WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE id = ?)",
    )
    .bind(&request.id)
    .bind(&request.session_id)
    .bind(request.sequence)
    .bind(&request.kind)
    .bind(&request.queue_kind)
    .bind(&request.payload_json)
    .bind(request.created_at)
    .bind(&request.session_id)
    .execute(connection)
    .await
    .map_err(|error| format!("无法写入 Agent journal entry：{error}"))?;
    if inserted.rows_affected() != 1 {
        return Err("会话不存在，无法写入 Agent journal".to_string());
    }
    Ok(())
}

pub(super) async fn delete_artifact_metadata(
    connection: &mut SqliteConnection,
    artifact_id: &str,
) -> Result<(), String> {
    validate_identifier("Artifact ID", artifact_id)?;
    sqlx::query(
        "DELETE FROM artifacts
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM agent_messages m WHERE m.artifact_id = artifacts.id)
           AND NOT EXISTS (SELECT 1 FROM tool_executions t WHERE t.artifact_id = artifacts.id)",
    )
    .bind(artifact_id)
    .execute(connection)
    .await
    .map_err(|error| format!("无法删除未引用 Artifact 元数据：{error}"))?;
    Ok(())
}

pub(super) async fn update_runtime_config(
    connection: &mut SqliteConnection,
    request: &UpdateSessionRuntimeConfigRequest,
) -> Result<(), String> {
    validate_runtime_config_request(request)?;
    let updated = sqlx::query(
        "UPDATE agent_sessions
         SET system_prompt = ?, model_provider = ?, model_id = ?, reasoning_json = ?,
             active_tool_names_json = ?, provider_config_json = ?, runtime_manifest_json = ?,
             updated_at = ?
         WHERE id = ? AND status = 'idle'
           AND NOT EXISTS (
             SELECT 1 FROM agent_runs
             WHERE session_id = agent_sessions.id AND status = 'running'
           )",
    )
    .bind(&request.system_prompt)
    .bind(&request.model_provider)
    .bind(&request.model_id)
    .bind(&request.reasoning_json)
    .bind(&request.active_tool_names_json)
    .bind(&request.provider_config_json)
    .bind(&request.runtime_manifest_json)
    .bind(request.now)
    .bind(&request.session_id)
    .execute(connection)
    .await
    .map_err(|error| format!("无法更新 Session Runtime 配置：{error}"))?;
    if updated.rows_affected() != 1 {
        return Err("Session Runtime 配置只能在空闲状态更新".to_string());
    }
    Ok(())
}

pub(super) fn validate_provider_profile_migrations(
    request: &MigrateSessionProviderProfilesRequest,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(request)
        .map_err(|error| format!("无法编码 Provider Profile 迁移：{error}"))?;
    if request.migrations.is_empty()
        || request.migrations.len() > MAX_PROVIDER_PROFILE_MIGRATIONS
        || encoded.len() > MAX_REQUEST_BYTES
    {
        return Err("Provider Profile 迁移为空或超过安全上限".to_string());
    }
    let mut session_ids = HashSet::new();
    for migration in &request.migrations {
        validate_identifier("Session ID", &migration.session_id)?;
        if !session_ids.insert(&migration.session_id) {
            return Err("Provider Profile 迁移包含重复 Session".to_string());
        }
        for (label, json) in [
            ("expected", &migration.expected_provider_config_json),
            ("target", &migration.provider_config_json),
        ] {
            serde_json::from_str::<Value>(json)
                .map_err(|error| format!("Provider Profile {label} JSON 无效：{error}"))?;
        }
    }
    Ok(())
}

pub(super) async fn migrate_provider_profiles(
    connection: &mut SqliteConnection,
    request: &MigrateSessionProviderProfilesRequest,
) -> Result<(), String> {
    validate_provider_profile_migrations(request)?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| format!("无法开始 Provider Profile 迁移事务：{error}"))?;
    for migration in &request.migrations {
        let updated = sqlx::query(
            "UPDATE agent_sessions
             SET provider_config_json = ?
             WHERE id = ? AND provider_config_json = ? AND status = 'idle'
               AND NOT EXISTS (
                 SELECT 1 FROM agent_runs
                 WHERE session_id = agent_sessions.id AND status = 'running'
               )",
        )
        .bind(&migration.provider_config_json)
        .bind(&migration.session_id)
        .bind(&migration.expected_provider_config_json)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("无法迁移 Session Provider Profile：{error}"))?;
        if updated.rows_affected() != 1 {
            transaction
                .rollback()
                .await
                .map_err(|error| format!("Provider Profile 迁移冲突且回滚失败：{error}"))?;
            return Err(format!(
                "Session Provider Profile 迁移前状态已变化：{}",
                migration.session_id
            ));
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("无法提交 Provider Profile 迁移事务：{error}"))
}

pub(super) async fn transition_journal_entries(
    connection: &mut SqliteConnection,
    request: &JournalTransitionRequest,
) -> Result<(), String> {
    validate_identifier("Session ID", &request.session_id)?;
    if request.entry_ids.len() > MAX_JOURNAL_ENTRIES {
        return Err("Agent journal entry 数量超过安全上限".to_string());
    }
    if request.entry_ids.is_empty() {
        return Ok(());
    }
    let mut unique = HashSet::new();
    for entry_id in &request.entry_ids {
        validate_identifier("Journal entry ID", entry_id)?;
        if !unique.insert(entry_id) {
            return Err("Agent journal entry ID 重复".to_string());
        }
    }
    if let Some(run_id) = &request.run_id {
        validate_identifier("Run ID", run_id)?;
    }

    if matches!(request.transition, JournalTransition::Consuming) {
        if request.now.is_some() {
            return Err("Agent journal consuming transition 不接受时间参数".to_string());
        }
        let run_id = request
            .run_id
            .as_ref()
            .ok_or_else(|| "Agent journal consuming transition 缺少 Run ID".to_string())?;
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_runs
             WHERE id = ? AND session_id = ? AND status = 'running'",
        )
        .bind(run_id)
        .bind(&request.session_id)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| format!("无法校验 Agent journal consumer run：{error}"))?;
        if count != 1 {
            return Err("Agent journal queue consumer run 无效".to_string());
        }
    } else if request.run_id.is_some() {
        return Err("Agent journal transition 不接受 run ID".to_string());
    }

    let (condition, require_all) = match request.transition {
        JournalTransition::Consuming => (
            "kind = 'queue' AND status = 'pending' AND recovered_at IS NULL",
            true,
        ),
        JournalTransition::RestorePending => ("kind = 'queue' AND status = 'consuming'", false),
        JournalTransition::Recovered => (
            "kind = 'queue' AND status IN ('pending', 'consuming') AND recovered_at IS NULL",
            true,
        ),
        JournalTransition::Applied => ("status IN ('pending', 'consuming', 'applied')", true),
        JournalTransition::Discarded => ("status IN ('pending', 'consuming', 'discarded')", false),
    };
    let transition_time = match request.transition {
        JournalTransition::Recovered
        | JournalTransition::Applied
        | JournalTransition::Discarded => Some(
            request
                .now
                .filter(|value| *value >= 0)
                .ok_or_else(|| "Agent journal transition 缺少有效时间".to_string())?,
        ),
        JournalTransition::Consuming | JournalTransition::RestorePending => {
            if request.now.is_some() {
                return Err("Agent journal transition 不接受时间参数".to_string());
            }
            None
        }
    };

    if require_all {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT COUNT(*) FROM agent_session_journal WHERE session_id = ",
        );
        builder.push_bind(request.session_id.clone());
        builder.push(" AND id IN (");
        {
            let mut separated = builder.separated(", ");
            for entry_id in &request.entry_ids {
                separated.push_bind(entry_id.clone());
            }
        }
        builder.push(") AND ");
        builder.push(condition);
        let count: i64 = builder
            .build_query_scalar()
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| format!("无法校验 Agent journal transition：{error}"))?;
        if count != request.entry_ids.len() as i64 {
            return Err("Agent journal entry 状态已变化，拒绝非原子转换".to_string());
        }
    }

    let mut builder = QueryBuilder::<Sqlite>::new("UPDATE agent_session_journal SET ");
    match request.transition {
        JournalTransition::Consuming => {
            builder.push("status = 'consuming', consumer_run_id = ");
            builder.push_bind(request.run_id.clone());
            builder.push(", applied_at = NULL");
        }
        JournalTransition::RestorePending => {
            builder.push("status = 'pending', consumer_run_id = NULL, applied_at = NULL");
        }
        JournalTransition::Recovered => {
            builder.push(
                "status = 'pending', consumer_run_id = NULL, applied_at = NULL, recovered_at = ",
            );
            builder.push_bind(transition_time.expect("validated transition time"));
        }
        JournalTransition::Applied => {
            builder.push("status = 'applied', applied_at = ");
            builder.push_bind(transition_time.expect("validated transition time"));
            builder.push(", recovered_at = NULL");
        }
        JournalTransition::Discarded => {
            builder.push("status = 'discarded', consumer_run_id = NULL, applied_at = ");
            builder.push_bind(transition_time.expect("validated transition time"));
            builder.push(", recovered_at = NULL");
        }
    }
    builder.push(" WHERE session_id = ");
    builder.push_bind(request.session_id.clone());
    builder.push(" AND id IN (");
    {
        let mut separated = builder.separated(", ");
        for entry_id in &request.entry_ids {
            separated.push_bind(entry_id.clone());
        }
    }
    builder.push(") AND ");
    builder.push(condition);
    let result = builder
        .build()
        .execute(connection)
        .await
        .map_err(|error| format!("无法更新 Agent journal entry：{error}"))?;
    if require_all && result.rows_affected() != request.entry_ids.len() as u64 {
        return Err("Agent journal entry 状态已变化，拒绝非原子转换".to_string());
    }
    Ok(())
}
