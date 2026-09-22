//! Provider / connect 凭据存储：`~/.axiom/axiom.db` 的 `secrets` 表是唯一权威存储。
//!
//! 历史上密钥存 macOS Keychain（service = 应用 identifier），但 adhoc 签名下
//! 每次重建二进制的 cdhash 都会变化，钥匙串 ACL 按 designated requirement 匹配
//! 失败，导致每次更新后读取密钥都弹系统授权对话框。v15 改为 Rust 独占的 SQLite
//! 存储后彻底脱离 ACL；此后补充的「只读回填 legacy 钥匙串条目」通道也已整体
//! 移除——本模块不再触碰 Security.framework，pre-v15 遗留的钥匙串条目不再
//! 迁移（受影响用户在设置里重新输入 API Key 即可）。
//!
//! 并发模型：所有读写经一条后台 worker 线程串行执行（线程内自持
//! current-thread tokio runtime 与单条 SQLite 连接），对外 API 保持同步——
//! 调用方（Tauri 命令线程 / setup 主线程 / connect 长连接）阻塞等待结果即可，
//! 不要求 async 上下文，也不与任何外部锁共持（取代旧 std Mutex 的语义）。
//! 锁序约定相应简化：SecretState 不再暴露锁，connect 模块「不得同时持有
//! ConnectInner 锁与 SecretState 锁」的规则自然成立。

use crate::provider_profiles::{CURRENT_PROVIDER_SECRET_PREFIXES, LEGACY_PROVIDER_SECRET_PREFIXES};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{mpsc, OnceLock},
};

use sqlx::sqlite::SqliteConnection;
use sqlx::Connection as _;

use crate::session_schema::{create_options, SECRETS_TABLE_DDL};

const MAX_SECRET_BYTES: usize = 16 * 1024;
const MAX_PROVIDER_SECRET_CLEANUP_IDS: usize = 256;
const PROVIDER_SECRET_CLEANUP_DIRECTORY: &str = "provider-secret-migrations";
const PROVIDER_SECRET_CLEANUP_FILE: &str = "cleanup-intent-v1.json";
const DATABASE_FILE_NAME: &str = "axiom.db";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProviderSecretCleanupIntent {
    schema_version: u32,
    source_secret_ids: Vec<String>,
}

/// worker 请求：Bind 恒为首个请求（setup 在任何密钥操作前调用 bind_data_root）。
enum SecretRequest {
    Bind { data_root: PathBuf },
    Load {
        key: String,
        reply: mpsc::Sender<Result<Option<String>, String>>,
    },
    Exists {
        key: String,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    Save {
        key: String,
        value: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Delete {
        key: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
}

pub(crate) struct SecretState {
    requests: OnceLock<tokio::sync::mpsc::UnboundedSender<SecretRequest>>,
}

impl SecretState {
    pub(crate) fn new() -> Self {
        let state = Self {
            requests: OnceLock::new(),
        };
        state.spawn_worker();
        state
    }

    /// 启动 worker 线程。OnceLock 保证幂等（构造时恰好触发一次）。
    fn spawn_worker(&self) {
        let _ = self.requests.get_or_init(|| {
            let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<SecretRequest>();
            std::thread::Builder::new()
                .name("axiom-secret-store".to_string())
                .spawn(move || {
                    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    else {
                        // runtime 建不起来（句柄耗尽等极端场景）：丢弃 receiver，
                        // 后续请求方会在 recv 端得到明确错误而不是挂死。
                        return;
                    };
                    runtime.block_on(run_secret_worker(receiver));
                })
                .expect("spawning the Axiom secret store worker must not fail");
            sender
        });
    }

    /// 绑定数据根（setup 在 legacy 数据迁移完成后调用，先于任何密钥操作）。
    pub(crate) fn bind_data_root(&self, data_root: PathBuf) {
        let _ = self
            .requests
            .get()
            .expect("secret worker must be spawned at construction")
            .send(SecretRequest::Bind { data_root });
    }

    fn send(&self, request: SecretRequest) -> Result<(), String> {
        self.requests
            .get()
            .expect("secret worker must be spawned at construction")
            .send(request)
            .map_err(|_| "Axiom secret store worker 已停止".to_string())
    }

    fn load(&self, key: &str) -> Result<Option<String>, String> {
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.send(SecretRequest::Load {
            key: key.to_string(),
            reply: reply_sender,
        })
        .map_err(|error| format!("读取密钥失败：{error}"))?;
        reply_receiver
            .recv()
            .map_err(|_| "Axiom secret store worker 已停止".to_string())?
    }

    /// 存在性检查（DB 查询）：配置状态展示、切换模型等高频检查走此通道。
    fn exists(&self, key: &str) -> Result<bool, String> {
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.send(SecretRequest::Exists {
            key: key.to_string(),
            reply: reply_sender,
        })
        .map_err(|error| format!("检查密钥失败：{error}"))?;
        reply_receiver
            .recv()
            .map_err(|_| "Axiom secret store worker 已停止".to_string())?
    }

    fn save(&self, key: &str, value: &str) -> Result<(), String> {
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.send(SecretRequest::Save {
            key: key.to_string(),
            value: value.to_string(),
            reply: reply_sender,
        })
        .map_err(|error| format!("保存密钥失败：{error}"))?;
        reply_receiver
            .recv()
            .map_err(|_| "Axiom secret store worker 已停止".to_string())?
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.send(SecretRequest::Delete {
            key: key.to_string(),
            reply: reply_sender,
        })
        .map_err(|error| format!("删除密钥失败：{error}"))?;
        reply_receiver
            .recv()
            .map_err(|_| "Axiom secret store worker 已停止".to_string())?
    }
}

#[cfg(test)]
impl Default for SecretState {
    fn default() -> Self {
        // hermetic：独立临时数据根，测试绝不触碰用户数据目录。
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "axiom-secret-tests-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        let state = Self::new();
        state.bind_data_root(directory);
        state
    }
}

struct SecretWorkerState {
    connection: Option<SqliteConnection>,
    data_root: Option<PathBuf>,
}

async fn run_secret_worker(mut receiver: tokio::sync::mpsc::UnboundedReceiver<SecretRequest>) {
    let mut state = SecretWorkerState {
        connection: None,
        data_root: None,
    };
    while let Some(request) = receiver.recv().await {
        match request {
            SecretRequest::Bind { data_root } => {
                state.data_root = Some(data_root);
            }
            SecretRequest::Load { key, reply } => {
                let _ = reply.send(load_value(&mut state, &key).await);
            }
            SecretRequest::Exists { key, reply } => {
                let _ = reply.send(exists_value(&mut state, &key).await);
            }
            SecretRequest::Save { key, value, reply } => {
                let _ = reply.send(save_value(&mut state, &key, &value).await);
            }
            SecretRequest::Delete { key, reply } => {
                let _ = reply.send(delete_value(&mut state, &key).await);
            }
        }
    }
}

/// 惰性打开密钥连接：密钥操作可能先于 `initialize_session_repository` 的
/// migrate 执行（如 setup 阶段的 connect 长连接），因此建表用与 v15 迁移
/// 同一 DDL 常量幂等保证；user_version 仍由 migrate() 独占管理。
async fn ensure_connection(
    state: &mut SecretWorkerState,
) -> Result<&mut SqliteConnection, String> {
    if state.connection.is_none() {
        let data_root = state
            .data_root
            .clone()
            .ok_or_else(|| "SecretState data root is not bound".to_string())?;
        let path = data_root.join(DATABASE_FILE_NAME);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建 Axiom SQLite 目录：{error}"))?;
        }
        let mut connection = SqliteConnection::connect_with(&create_options(&path))
            .await
            .map_err(|error| format!("无法打开 Axiom SQLite 数据库：{error}"))?;
        sqlx::query(SECRETS_TABLE_DDL)
            .execute(&mut connection)
            .await
            .map_err(|error| format!("无法初始化 Axiom secrets 表：{error}"))?;
        state.connection = Some(connection);
    }
    Ok(state
        .connection
        .as_mut()
        .expect("secrets connection is ensured above"))
}

const SECRET_UPSERT_SQL: &str = "INSERT INTO secrets (secret_key, value, updated_at) \
VALUES (?, ?, CAST(strftime('%s', 'now') AS INTEGER)) \
ON CONFLICT(secret_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";

async fn save_value(
    state: &mut SecretWorkerState,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let connection = ensure_connection(state).await?;
    sqlx::query(SECRET_UPSERT_SQL)
        .bind(key)
        .bind(value)
        .execute(connection)
        .await
        .map_err(|error| format!("无法保存密钥到 Axiom SQLite：{error}"))?;
    Ok(())
}

async fn load_value(state: &mut SecretWorkerState, key: &str) -> Result<Option<String>, String> {
    let connection = ensure_connection(state).await?;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM secrets WHERE secret_key = ?")
            .bind(key)
            .fetch_optional(connection)
            .await
            .map_err(|error| format!("无法读取 Axiom secrets 表：{error}"))?;
    Ok(stored)
}

/// 存在性检查：纯 DB 查询，不解密密钥内容之外的任何系统存储。
async fn exists_value(state: &mut SecretWorkerState, key: &str) -> Result<bool, String> {
    let connection = ensure_connection(state).await?;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM secrets WHERE secret_key = ?")
            .bind(key)
            .fetch_optional(connection)
            .await
            .map_err(|error| format!("无法读取 Axiom secrets 表：{error}"))?;
    Ok(stored.is_some())
}

async fn delete_value(state: &mut SecretWorkerState, key: &str) -> Result<(), String> {
    let connection = ensure_connection(state).await?;
    sqlx::query("DELETE FROM secrets WHERE secret_key = ?")
        .bind(key)
        .execute(connection)
        .await
        .map_err(|error| format!("无法删除 Axiom secrets 行：{error}"))?;
    Ok(())
}

pub(crate) fn validate_secret_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    let valid = !key.is_empty()
        && key.len() <= 128
        && key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    if !valid {
        return Err("secret key contains unsupported characters".into());
    }
    Ok(key)
}

fn matches_secret_prefix(key: &str, prefixes: &[&str]) -> bool {
    prefixes
        .iter()
        .any(|prefix| key == *prefix || key.starts_with(&format!("{prefix}.")))
}

fn validate_current_provider_secret_key(key: &str) -> Result<&str, String> {
    let key = validate_secret_key(key)?;
    if !matches_secret_prefix(key, CURRENT_PROVIDER_SECRET_PREFIXES) {
        return Err("secret key is outside the current Provider namespace".into());
    }
    Ok(key)
}

fn validate_provider_secret_key(key: &str) -> Result<&str, String> {
    let key = validate_secret_key(key)?;
    if !matches_secret_prefix(key, CURRENT_PROVIDER_SECRET_PREFIXES)
        && !matches_secret_prefix(key, LEGACY_PROVIDER_SECRET_PREFIXES)
    {
        return Err("secret key is outside the Provider namespace".into());
    }
    Ok(key)
}

fn validate_provider_secret_cleanup_ids(
    source_secret_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    if source_secret_ids.len() > MAX_PROVIDER_SECRET_CLEANUP_IDS {
        return Err("Provider Secret cleanup intent exceeds the safe limit".into());
    }
    let mut validated = source_secret_ids
        .into_iter()
        .map(|source_secret_id| {
            let source_secret_id = validate_secret_key(&source_secret_id)?;
            if !matches_secret_prefix(source_secret_id, LEGACY_PROVIDER_SECRET_PREFIXES) {
                return Err("Provider Secret cleanup intent contains a non-legacy key".into());
            }
            Ok(source_secret_id.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    validated.sort();
    validated.dedup();
    Ok(validated)
}

fn provider_secret_cleanup_paths(app_data_dir: &Path) -> (PathBuf, PathBuf) {
    let directory = app_data_dir.join(PROVIDER_SECRET_CLEANUP_DIRECTORY);
    let intent = directory.join(PROVIDER_SECRET_CLEANUP_FILE);
    (directory, intent)
}

fn load_provider_secret_cleanup_intent_from(app_data_dir: &Path) -> Result<Vec<String>, String> {
    let (_, intent_path) = provider_secret_cleanup_paths(app_data_dir);
    let metadata = match fs::symlink_metadata(&intent_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "failed to inspect Provider Secret cleanup intent: {error}"
            ))
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Provider Secret cleanup intent is not a regular file".into());
    }
    if metadata.len() > 64 * 1024 {
        return Err("Provider Secret cleanup intent exceeds 64 KiB".into());
    }
    let bytes = fs::read(&intent_path)
        .map_err(|error| format!("failed to read Provider Secret cleanup intent: {error}"))?;
    let intent: ProviderSecretCleanupIntent = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Provider Secret cleanup intent is invalid: {error}"))?;
    if intent.schema_version != 1 {
        return Err("Provider Secret cleanup intent has an unsupported schema version".into());
    }
    validate_provider_secret_cleanup_ids(intent.source_secret_ids)
}

fn persist_provider_secret_cleanup_intent_to(
    app_data_dir: &Path,
    source_secret_ids: Vec<String>,
) -> Result<(), String> {
    let source_secret_ids = validate_provider_secret_cleanup_ids(source_secret_ids)?;
    let (directory, intent_path) = provider_secret_cleanup_paths(app_data_dir);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create Provider Secret cleanup directory: {error}"))?;
    let directory_metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("failed to inspect Provider Secret cleanup directory: {error}"))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err("Provider Secret cleanup directory is not a regular directory".into());
    }
    if source_secret_ids.is_empty() {
        match fs::remove_file(&intent_path) {
            Ok(()) => {
                crate::storage_paths::sync_directory(&directory).map_err(|error| {
                    format!("failed to sync Provider Secret cleanup directory: {error}")
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "failed to remove Provider Secret cleanup intent: {error}"
            )),
        }?;
        return Ok(());
    }
    let encoded = serde_json::to_vec(&ProviderSecretCleanupIntent {
        schema_version: 1,
        source_secret_ids,
    })
    .map_err(|error| format!("failed to encode Provider Secret cleanup intent: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|error| format!("failed to stage Provider Secret cleanup intent: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                format!("failed to secure Provider Secret cleanup intent: {error}")
            })?;
    }
    temporary
        .write_all(&encoded)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("failed to sync Provider Secret cleanup intent: {error}"))?;
    temporary.persist(&intent_path).map_err(|error| {
        format!(
            "failed to commit Provider Secret cleanup intent: {}",
            error.error
        )
    })?;
    crate::storage_paths::sync_directory(&directory)
        .map_err(|error| format!("failed to sync Provider Secret cleanup directory: {error}"))
}

fn validate_provider_secret_migration<'a>(
    source_key: &'a str,
    target_key: &'a str,
) -> Result<(&'a str, &'a str), String> {
    let source_key = validate_secret_key(source_key)?;
    let target_key = validate_current_provider_secret_key(target_key)?;
    if !matches_secret_prefix(source_key, LEGACY_PROVIDER_SECRET_PREFIXES) {
        return Err("secret migration source is outside the legacy Provider namespace".into());
    }
    if source_key == target_key {
        return Err("secret migration source and target must differ".into());
    }
    Ok((source_key, target_key))
}

fn validate_secret_value(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("secret value cannot be empty".into());
    }
    if value.len() > MAX_SECRET_BYTES {
        return Err("secret value is too large".into());
    }
    Ok(value)
}

#[cfg(feature = "e2e")]
pub(crate) fn seed_e2e_legacy_provider_secret(
    state: &SecretState,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let key = validate_secret_key(key)?;
    if !matches_secret_prefix(key, LEGACY_PROVIDER_SECRET_PREFIXES) {
        return Err("E2E Secret seed is outside the legacy Provider namespace".into());
    }
    let value = validate_secret_value(value)?;
    state.save(key, value)
}

/// connect（远程操控连接）凭证命名空间：`connect.<platform>.<name>`。
/// 与 Provider 命名空间隔离——`save_secret` 命令仍只放行 Provider 前缀，
/// 受陷渲染进程无法读写连接凭证；Rust connect 模块独占这三个 key。
const CONNECT_SECRET_PREFIX: &str = "connect.";

fn validate_connect_secret_key(key: &str) -> Result<&str, String> {
    let key = validate_secret_key(key)?;
    if !key.starts_with(CONNECT_SECRET_PREFIX) || key.len() <= CONNECT_SECRET_PREFIX.len() {
        return Err("secret key is outside the connect namespace".into());
    }
    Ok(key)
}

/// SSH 主机密码等 SSH 专属凭据的命名空间（`ssh.host.<hostId>`）。与 connect
/// 同一模式：只允许 Rust 侧专用 helper 读写，WebView 不经手明文。
const SSH_SECRET_PREFIX: &str = "ssh.";

fn validate_ssh_secret_key(key: &str) -> Result<&str, String> {
    let key = validate_secret_key(key)?;
    if !key.starts_with(SSH_SECRET_PREFIX) || key.len() <= SSH_SECRET_PREFIX.len() {
        return Err("secret key is outside the ssh namespace".into());
    }
    Ok(key)
}

pub(crate) fn save_ssh_secret(state: &SecretState, key: &str, value: &str) -> Result<(), String> {
    let key = validate_ssh_secret_key(key)?;
    let value = validate_secret_value(value)?;
    state.save(key, value)
}

pub(crate) fn load_ssh_secret(state: &SecretState, key: &str) -> Result<Option<String>, String> {
    let key = validate_ssh_secret_key(key)?;
    state.load(key)
}

pub(crate) fn delete_ssh_secret(state: &SecretState, key: &str) -> Result<(), String> {
    let key = validate_ssh_secret_key(key)?;
    state.delete(key)
}

pub(crate) fn load_secret(state: &SecretState, key: &str) -> Result<Option<String>, String> {
    let key = validate_secret_key(key)?;
    state.load(key)
}

/// connect 状态展示专用：存在性检查（纯 DB 查询）。
pub(crate) fn connect_secret_exists(
    state: &SecretState,
    key: &str,
) -> Result<bool, String> {
    let key = validate_connect_secret_key(key)?;
    state.exists(key)
}

pub(crate) fn load_connect_secret(state: &SecretState, key: &str) -> Result<Option<String>, String> {
    let key = validate_connect_secret_key(key)?;
    state.load(key)
}

pub(crate) fn save_connect_secret(state: &SecretState, key: &str, value: &str) -> Result<(), String> {
    let key = validate_connect_secret_key(key)?;
    let value = validate_secret_value(value)?;
    state.save(key, value)
}

pub(crate) fn delete_connect_secret(state: &SecretState, key: &str) -> Result<(), String> {
    let key = validate_connect_secret_key(key)?;
    state.delete(key)
}

fn secret_value_to_copy(source: Option<String>, target_exists: bool) -> Option<String> {
    if target_exists {
        None
    } else {
        source
    }
}

#[tauri::command]
pub(crate) fn save_secret(
    state: tauri::State<'_, SecretState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let key = validate_current_provider_secret_key(&key)?;
    let value = validate_secret_value(&value)?;
    state.save(key, value)
}

#[tauri::command]
pub(crate) fn has_secret(
    state: tauri::State<'_, SecretState>,
    key: String,
) -> Result<bool, String> {
    let key = validate_provider_secret_key(&key)?;
    state.exists(key)
}

#[tauri::command]
pub(crate) fn migrate_secret(
    state: tauri::State<'_, SecretState>,
    source_key: String,
    target_key: String,
) -> Result<bool, String> {
    let (source_key, target_key) = validate_provider_secret_migration(&source_key, &target_key)?;
    // 只有真正需要复制值时才读 source；目标已存在则不覆盖。
    if state.exists(target_key)? {
        return Ok(true);
    }
    let source = state.load(source_key)?;
    let Some(value) = secret_value_to_copy(source, false) else {
        return Ok(false);
    };
    let value = validate_secret_value(&value)?;
    state.save(target_key, value)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn delete_secret(
    state: tauri::State<'_, SecretState>,
    key: String,
) -> Result<(), String> {
    let key = validate_provider_secret_key(&key)?;
    state.delete(key)
}

#[tauri::command]
pub(crate) fn load_provider_secret_cleanup_intent(
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let app_data_dir = crate::storage_paths::axiom_data_root(&app)?;
    load_provider_secret_cleanup_intent_from(&app_data_dir)
}

#[tauri::command]
pub(crate) fn persist_provider_secret_cleanup_intent(
    app: tauri::AppHandle,
    source_secret_ids: Vec<String>,
) -> Result<(), String> {
    let app_data_dir = crate::storage_paths::axiom_data_root(&app)?;
    persist_provider_secret_cleanup_intent_to(&app_data_dir, source_secret_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_connect_secret_namespace() {
        assert!(validate_connect_secret_key("connect.feishu.app-secret").is_ok());
        assert!(validate_connect_secret_key("connect.weixin.bot-token").is_ok());
        // Provider / 任意其它前缀一律拒绝：连接凭证只能由 Rust connect 模块读写。
        assert!(validate_connect_secret_key("provider.minimax.api-key").is_err());
        assert!(validate_connect_secret_key("connect").is_err());
        assert!(validate_connect_secret_key("connect.").is_err());
    }

    #[test]
    fn validates_secret_keys_without_exposing_values() {
        assert_eq!(
            validate_secret_key("model.default.api-key"),
            Ok("model.default.api-key")
        );
        assert!(validate_secret_key("").is_err());
        assert!(validate_secret_key("contains whitespace").is_err());
        assert!(validate_secret_key("contains/slash").is_err());
    }

    #[test]
    fn restricts_provider_secret_namespaces_and_migration_direction() {
        assert!(
            validate_current_provider_secret_key("provider.minimax.api-key.profile-1").is_err()
        );
        assert!(
            validate_current_provider_secret_key("provider.anthropic-compatible.api-key").is_err()
        );
        assert!(
            validate_provider_secret_key("provider.anthropic-compatible.api-key.legacy").is_ok()
        );
        assert!(validate_provider_secret_key("provider.minimax.api-key").is_ok());
        assert!(validate_provider_secret_key("provider.unregistered.api-key").is_err());
        assert!(validate_provider_secret_migration(
            "provider.anthropic-compatible.api-key",
            "provider.minimax.api-key"
        )
        .is_err());
        assert!(validate_provider_secret_migration(
            "provider.minimax.api-key",
            "provider.openai-responses.api-key"
        )
        .is_ok());
    }

    #[test]
    fn persists_and_removes_provider_secret_cleanup_intent_durably() {
        let root = tempfile::tempdir().unwrap();
        let source_secret_ids = vec![
            "provider.anthropic-compatible.api-key.profile-b".to_string(),
            "provider.anthropic-compatible.api-key.profile-a".to_string(),
        ];

        persist_provider_secret_cleanup_intent_to(root.path(), source_secret_ids).unwrap();

        assert_eq!(
            load_provider_secret_cleanup_intent_from(root.path()).unwrap(),
            vec![
                "provider.anthropic-compatible.api-key.profile-a".to_string(),
                "provider.anthropic-compatible.api-key.profile-b".to_string(),
            ]
        );
        let (_, intent_path) = provider_secret_cleanup_paths(root.path());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&intent_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        persist_provider_secret_cleanup_intent_to(root.path(), Vec::new()).unwrap();

        assert!(!intent_path.exists());
        assert!(load_provider_secret_cleanup_intent_from(root.path())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_uncertain_provider_secret_cleanup_intents() {
        let root = tempfile::tempdir().unwrap();
        assert!(persist_provider_secret_cleanup_intent_to(
            root.path(),
            vec!["provider.openai-compatible.api-key".to_string()],
        )
        .is_err());

        let (directory, intent_path) = provider_secret_cleanup_paths(root.path());
        fs::create_dir_all(directory).unwrap();
        fs::write(
            intent_path,
            br#"{"schemaVersion":1,"sourceSecretIds":["invalid/key"]}"#,
        )
        .unwrap();

        assert!(load_provider_secret_cleanup_intent_from(root.path()).is_err());
    }

    #[test]
    fn rejects_empty_and_oversized_values() {
        assert!(validate_secret_value("  ").is_err());
        assert!(validate_secret_value(&"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
        assert_eq!(validate_secret_value(" token "), Ok("token"));
    }

    #[test]
    fn copies_only_when_the_source_exists_and_the_target_is_absent() {
        assert_eq!(
            secret_value_to_copy(Some("legacy-key".to_string()), false),
            Some("legacy-key".to_string())
        );
        assert_eq!(secret_value_to_copy(None, false), None);
        assert_eq!(
            secret_value_to_copy(Some("legacy-key".to_string()), true),
            None
        );
    }

    // SQLite 存储行为测试（hermetic：默认构造器绑定独立临时数据根）。
    #[tokio::test]
    async fn round_trips_secrets_through_sqlite_storage() {
        let state = SecretState::default();
        assert_eq!(state.load("provider.test.round-trip").unwrap(), None);

        state.save("provider.test.round-trip", "first").unwrap();
        assert_eq!(
            state.load("provider.test.round-trip").unwrap(),
            Some("first".to_string())
        );

        // upsert：同 key 再写覆盖
        state.save("provider.test.round-trip", "second").unwrap();
        assert_eq!(
            state.load("provider.test.round-trip").unwrap(),
            Some("second".to_string())
        );

        state.delete("provider.test.round-trip").unwrap();
        assert_eq!(state.load("provider.test.round-trip").unwrap(), None);
        // 幂等删除
        assert!(state.delete("provider.test.round-trip").is_ok());
    }

    #[tokio::test]
    async fn exists_tracks_database_state() {
        let state = SecretState::default();
        assert!(!state.exists("provider.test.exists").unwrap());
        state.save("provider.test.exists", "v").unwrap();
        assert!(state.exists("provider.test.exists").unwrap());
        state.delete("provider.test.exists").unwrap();
        assert!(!state.exists("provider.test.exists").unwrap());
    }

    #[test]
    fn refuses_secret_operations_before_data_root_binding() {
        let state = SecretState::new();
        assert!(state.load("provider.test.unbound").is_err());
    }
}
