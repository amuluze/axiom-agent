//! Tauri command entry points. Each command acquires a connection from the
//! repository pool, and dispatches to the appropriate helper.
use serde_json::Value;
use sqlx::sqlite::{SqliteConnection, SqlitePoolOptions};
use sqlx::Row;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use crate::artifacts::{
    axiom_data_root, reconcile_at, storage_stats_at, verify_artifact_reference, ArtifactGcResult,
};
use crate::session_schema::{create_options, migrate};
use crate::session_state::SessionRepositoryState;
use crate::storage_paths::set_file_permissions;
use crate::workspace_access::WorkspaceAccessState;
use crate::workspace_registry;

use super::*;

/// 池上限：读快照（会话激活/列表）与写事务混合负载下的经验值——写由 SQLite
/// 单写者串行，更大的池只会堆等待中的写事务；过小则并发读会被写排队拖住。
const SESSION_REPOSITORY_POOL_MAX_CONNECTIONS: u32 = 4;

const DATABASE_FILE_NAME: &str = "axiom.db";

pub(crate) fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(axiom_data_root(app)?.join(DATABASE_FILE_NAME))
}

fn database_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

/// 启动 fail-closed 校验：主库/事务日志必须是普通文件且成对出现——孤儿 WAL
/// （主库缺失但 -wal 存在）说明上次事务未落定，带着它打开 DB 可能静默丢数据。
/// 返回主库文件是否存在（0 字节截断的判定由调用方在打开后执行）。
fn validate_database_storage(path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            for suffix in ["-wal", "-shm"] {
                match fs::symlink_metadata(database_sidecar_path(path, suffix)) {
                    Ok(_) => {
                        return Err(
                            "Axiom SQLite 主数据库缺失，但仍存在未归属的事务日志".to_string()
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(format!("检查 SQLite 事务日志失败：{error}")),
                }
            }
            return Ok(false);
        }
        Err(error) => return Err(format!("检查 SQLite 数据库失败：{error}")),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Axiom SQLite 数据库路径不是普通文件".to_string());
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = database_sidecar_path(path, suffix);
        let metadata = match fs::symlink_metadata(&sidecar) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("检查 SQLite 事务日志失败：{error}")),
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("Axiom SQLite 事务日志路径不是普通文件".to_string());
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn initialize_session_repository(
    app: AppHandle,
    state: State<'_, SessionRepositoryState>,
    workspace_state: State<'_, WorkspaceAccessState>,
) -> Result<(), String> {
    let mut guard = state.pool.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let path = database_path(&app)?;
    let database_exists = validate_database_storage(&path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Axiom SQLite 目录：{error}"))?;
    }
    if database_exists {
        // 数据根目录 0700 之下文件默认 umask 可能是 0644：主库含全部会话与
        // 密钥（secrets 表），收紧为 0600（幂等，已存在时直接覆盖模式位）。
        set_file_permissions(&path)?;
    }
    // WAL 单写多读连接池：多会话并行的持久化不再全 app 排一条队——读与读、
    // 读与写并发，写仍由 SQLite 单写者经 busy_timeout 串行（对齐 ZCode 的
    // 多连接 WAL 模型）。max 连接数取小值：读快照（会话激活）与写事务混合
    // 负载下 4 个够用，也避免过多 WAL 读者拖住 checkpoint。
    let pool = SqlitePoolOptions::new()
        .max_connections(SESSION_REPOSITORY_POOL_MAX_CONNECTIONS)
        .connect_with(create_options(&path))
        .await
        .map_err(|error| format!("无法打开 Axiom SQLite 数据库：{error}"))?;
    let init_result: Result<(), String> = async {
        let mut connection = pool
            .acquire()
            .await
            .map_err(|error| format!("无法获取 Axiom SQLite 初始化连接：{error}"))?;
        if database_exists {
            // 0 字节文件是异常截断：SQLite 视其为合法空库，quick_check 无法识别，
            // migrate 会把空文件覆盖为全新库，原数据被无提示丢弃。必须 fail-closed。
            let database_size = path.metadata().map(|meta| meta.len()).unwrap_or(0);
            if database_size == 0 {
                return Err(
                    "Axiom SQLite 数据库文件为空（可能已损坏或被截断），拒绝以全新库覆盖。请从恢复点恢复或移除该文件后重试。"
                        .to_string(),
                );
            }
            let rows = sqlx::query_scalar::<_, String>("PRAGMA quick_check(10)")
                .fetch_all(&mut *connection)
                .await
                .map_err(|error| format!("执行 SQLite 完整性检查失败：{error}"))?;
            if rows.len() != 1 || !rows[0].eq_ignore_ascii_case("ok") {
                let detail = if rows.is_empty() {
                    "未返回检查结果".to_string()
                } else {
                    rows.join("；")
                };
                return Err(format!("Axiom SQLite 数据库完整性检查失败：{detail}"));
            }
        }
        migrate(&mut connection).await?;
        // 首次升级迁移：授权注册表（workspace_registry.rs）尚不存在时，用 SQLite 中
        // 用户历史绑定过的工作区播种——DB 由 Rust 独占写入，workspace_path 均源自
        // 原生选择器，可信；否则升级后既有工作区的重启恢复会被注册表 fail-closed
        // 拒绝。播种失败仅告警不阻断：最坏影响是旧工作区需重新选择，不放大授权面。
        // （查询在锁外完成；registry_mutations 锁只罩住注册表读-改-写，与 pick/revoke 串行。）
        let historical_workspaces: Vec<PathBuf> = sqlx::query_scalar::<_, String>(
            "SELECT DISTINCT workspace_path FROM agent_sessions WHERE workspace_path IS NOT NULL",
        )
        .fetch_all(&mut *connection)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();
        {
            let _registry = workspace_state
                .registry_mutations
                .lock()
                .map_err(|_| "workspace registry mutation lock is poisoned".to_string())?;
            if let Err(error) = workspace_registry::registry_seed_if_absent(
                &workspace_registry::registry_file_path(&app)?,
                &canonicalize_existing(&historical_workspaces),
            ) {
                eprintln!("failed to seed authorized workspace registry: {error}");
            }
        }
        Ok(())
    }
    .await;
    match init_result {
        Ok(()) => {
            *guard = Some(pool);
            Ok(())
        }
        Err(error) => {
            // 初始化失败必须关池：泄漏的池连接会持有 DB 文件句柄，阻碍用户按
            // 错误指引手动移除/恢复数据库文件。
            pool.close().await;
            Err(error)
        }
    }
}

/// 只保留仍存在于磁盘、且能 canonicalize 的历史路径；已删除的目录播种进
/// 注册表没有意义（恢复授权时 resolve 阶段就会失败）。
fn canonicalize_existing(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .collect()
}

#[tauri::command]
pub async fn recover_session_repository(
    state: State<'_, SessionRepositoryState>,
    now: i64,
) -> Result<RecoverSessionRepositoryResult, String> {
    let mut connection = state.acquire().await?;
    recover_repository(&mut connection, now).await
}

#[tauri::command]
pub async fn recover_session_repository_session(
    state: State<'_, SessionRepositoryState>,
    session_id: String,
    now: i64,
) -> Result<RecoverSessionRepositoryResult, String> {
    let mut connection = state.acquire().await?;
    recover_session(&mut connection, &session_id, now).await
}

#[tauri::command]
pub async fn initialize_session_runtime_defaults(
    state: State<'_, SessionRepositoryState>,
    request: InitializeSessionRuntimeDefaultsRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    initialize_runtime_defaults(&mut connection, &request).await
}

#[tauri::command]
pub async fn query_session_repository(
    state: State<'_, SessionRepositoryState>,
    operation: SessionRepositoryQuery,
    parameters: Vec<Value>,
) -> Result<Vec<Value>, String> {
    let mut connection = state.acquire().await?;
    query_rows(&mut connection, operation, &parameters).await
}

#[tauri::command]
pub async fn load_session_repository_snapshot(
    state: State<'_, SessionRepositoryState>,
    session_id: String,
) -> Result<SessionSnapshotRows, String> {
    let mut connection = state.acquire().await?;
    load_session_snapshot(&mut connection, &session_id).await
}

#[tauri::command]
pub async fn execute_session_repository(
    state: State<'_, SessionRepositoryState>,
    operation: SessionRepositoryMutation,
    parameters: Vec<Value>,
) -> Result<SessionDatabaseExecuteResult, String> {
    let mut connection = state.acquire().await?;
    execute_mutation(&mut connection, operation, &parameters).await
}

#[tauri::command]
pub async fn clear_session_repository(
    state: State<'_, SessionRepositoryState>,
    request: ClearSessionRepositoryRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    clear_session(&mut connection, &request).await
}

#[tauri::command]
pub async fn delete_session_with_successor(
    state: State<'_, SessionRepositoryState>,
    request: DeleteSessionWithSuccessorRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    delete_with_successor(&mut connection, &request).await
}

#[tauri::command]
pub async fn create_session_branch(
    state: State<'_, SessionRepositoryState>,
    request: CreateSessionBranchRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    create_branch(&mut connection, &request).await
}

#[tauri::command]
pub async fn update_session_runtime_config(
    state: State<'_, SessionRepositoryState>,
    request: UpdateSessionRuntimeConfigRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    update_runtime_config(&mut connection, &request).await
}

#[tauri::command]
pub async fn migrate_session_provider_profiles(
    state: State<'_, SessionRepositoryState>,
    request: MigrateSessionProviderProfilesRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    migrate_provider_profiles(&mut connection, &request).await
}

#[tauri::command]
pub async fn append_session_journal_entry(
    state: State<'_, SessionRepositoryState>,
    request: AppendSessionJournalEntryRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    append_journal_entry(&mut connection, &request).await
}

#[tauri::command]
pub async fn delete_unreferenced_artifact_metadata(
    state: State<'_, SessionRepositoryState>,
    artifact_id: String,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    delete_artifact_metadata(&mut connection, &artifact_id).await
}

/// 收集全部消息引用的 artifact content_hash（跨所有会话/分支）。Artifact id 即内容寻址
/// 哈希（写入时校验），是 GC 权威引用集的组成部分——只按活动会话收集会把其它会话的
/// artifact 误回收。
pub(crate) async fn collect_message_artifact_hashes(
    connection: &mut SqliteConnection,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT DISTINCT artifact_id FROM agent_messages WHERE artifact_id IS NOT NULL",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法收集消息 Artifact 引用：{error}"))?;
    let mut hashes = Vec::new();
    for row in rows {
        let artifact_id: String = row
            .try_get("artifact_id")
            .map_err(|error| format!("无法读取 Artifact 引用：{error}"))?;
        hashes.push(artifact_id);
    }
    Ok(hashes)
}

/// 归档清理（GC）：以 Rust 权威引用集（全部消息 + 审计 diff 包）调用
/// reconcile——未引用且超过宽限期的 artifact 进入可恢复回收区，过期回收区清理。返回
/// reconcile 明细与清理前后活跃字节数，供设置页展示释放量。已由原生回收区（grace +
/// trash 保留期）提供误删恢复兜底，故可直接执行。
#[tauri::command]
pub async fn gc_artifacts(
    app: AppHandle,
    state: State<'_, SessionRepositoryState>,
) -> Result<ArtifactGcResult, String> {
    let root = axiom_data_root(&app)?;
    let referenced = {
        let mut connection = state.acquire().await?;
        collect_message_artifact_hashes(&mut connection).await?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let before = storage_stats_at(&root)?;
        let reconciled = reconcile_at(&root, referenced)?;
        let after = storage_stats_at(&root)?;
        Ok(ArtifactGcResult {
            reconciled,
            active_bytes_before: before.active_bytes,
            active_bytes_after: after.active_bytes,
        })
    })
    .await
    .map_err(|error| format!("Artifact GC 任务失败：{error}"))?
}

#[tauri::command]
pub async fn start_session_run(
    state: State<'_, SessionRepositoryState>,
    request: StartSessionRunRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    start_run(&mut connection, &request).await
}

#[tauri::command]
pub async fn start_provider_request(
    state: State<'_, SessionRepositoryState>,
    request: StartProviderRequestRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    start_provider_request_record(&mut connection, &request).await
}

#[tauri::command]
pub async fn receive_provider_response(
    state: State<'_, SessionRepositoryState>,
    request: ReceiveProviderResponseRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    receive_provider_response_record(&mut connection, &request).await
}

#[tauri::command]
pub async fn start_tool_execution(
    state: State<'_, SessionRepositoryState>,
    request: StartToolExecutionRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    start_tool_execution_record(&mut connection, &request).await
}

#[tauri::command]
pub async fn finish_session_run(
    state: State<'_, SessionRepositoryState>,
    request: FinishSessionRunRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    finish_run(&mut connection, &request).await
}

#[tauri::command]
pub async fn save_session_turn_point(
    state: State<'_, SessionRepositoryState>,
    request: SaveSessionTurnPointRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    save_turn_point(&mut connection, &request).await
}

#[tauri::command]
pub async fn persist_session_message(
    app: AppHandle,
    state: State<'_, SessionRepositoryState>,
    request: SaveSessionMessageRequest,
) -> Result<(), String> {
    if let Some(artifact) = validate_session_message_request(&request)?.0 {
        verify_artifact_reference(
            app,
            artifact.content_hash,
            artifact.size_bytes as u64,
            artifact.kind,
            artifact.media_type,
        )
        .await?;
    }
    let mut connection = state.acquire().await?;
    save_session_message(&mut connection, &request).await
}

#[tauri::command]
pub async fn save_session_checkpoint(
    state: State<'_, SessionRepositoryState>,
    request: SaveSessionCheckpointRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    save_checkpoint(&mut connection, &request).await
}

#[tauri::command]
pub async fn settle_session_run(
    state: State<'_, SessionRepositoryState>,
    request: SettleSessionRunRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    settle_run(&mut connection, &request).await
}

#[tauri::command]
pub async fn transition_session_journal_entries(
    state: State<'_, SessionRepositoryState>,
    request: JournalTransitionRequest,
) -> Result<(), String> {
    let mut connection = state.acquire().await?;
    transition_journal_entries(&mut connection, &request).await
}


