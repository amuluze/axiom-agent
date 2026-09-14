//! SSH 主机注册表（P0）与 `ssh_command` 分发。
//!
//! SSH 是用户亲手操作的远程交互通道（与本地终端同一信任级），不是 Agent
//! 工具：本模块只承载主机 CRUD 的 Rust 权威持久层，连接引擎（ControlMaster
//! 加 PTY 终端）属后续阶段。主机配置（非密）存 `~/.axiom/ssh/hosts.json`
//! （0600，Rust 独占）；凭据不由本层落盘——密码认证提示发生在终端内。
//!
//! 损坏策略 fail-closed（对齐 workspace_registry 而非 computer allowlist）：
//! 主机是用户逐条积累的数据，损坏时若回退空集，下一次 host_save 会以空列表
//! 覆盖整份文件、静默清掉全部主机条目；拒绝读写、引导用户手动处置才安全。
//!
//! 并发约定：所有读-改-写都持 `SshState::registry_mutations` 短锁串行化
//! （只罩「读文件 → 改 → 写回」临界区，不覆盖文件 I/O 本身）；命令整体走
//! spawn_blocking，锁等待与小文件 I/O 不占主线程/tokio worker。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::{fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};
use tempfile::NamedTempFile;

use crate::artifacts::axiom_data_root;
use crate::storage_paths::set_directory_permissions;
use crate::workspace_registry::reject_symlink;

const HOSTS_DIRECTORY_NAME: &str = "ssh";
const HOSTS_FILE_NAME: &str = "hosts.json";
const HOSTS_SCHEMA_VERSION: u32 = 1;
/// 主机条目上限：与授权注册表同量级，防止注册表无界膨胀。
const MAX_HOSTS: usize = 64;
/// 注册表文件读取上限：64 条 × 元数据，超限视为损坏（fail-closed）。
const MAX_HOSTS_FILE_BYTES: u64 = 256 * 1024;

const MAX_NAME_BYTES: usize = 64;
const MAX_HOSTNAME_BYTES: usize = 255;
const MAX_USERNAME_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostEntry {
    pub id: String,
    pub name: String,
    /// 远端地址：主机名 / IPv4 / IPv6 字面量，不含端口与用户名。
    pub hostname: String,
    pub port: u16,
    pub username: String,
    /// 创建时间（epoch 秒）；更新时保留原值。
    pub created_at: u64,
    /// 已托管密码的 secret 引用（axiom.db secrets 表 `ssh.host.<id>`）。WebView
    /// 只见引用不见明文；`default` 兼容旧版注册表文件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_id: Option<String>,
    /// 本地私钥文件绝对路径（可选，非密——路径本身不含敏感材料）。设置后
    /// 终端/Agent 连接经 ssh `-i` 优先使用该密钥；`default` 兼容旧版注册表。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostsDocument {
    schema_version: u32,
    hosts: Vec<SshHostEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostsDocumentRef<'a> {
    schema_version: u32,
    hosts: &'a [SshHostEntry],
}

/// 主机注册表文件路径：`~/.axiom/ssh/hosts.json`，由 Rust 独占管理。
fn hosts_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(axiom_data_root(app)?
        .join(HOSTS_DIRECTORY_NAME)
        .join(HOSTS_FILE_NAME))
}

/// 读取全部主机。文件不存在视为空集（全新安装）；存在但损坏/超限/版本不
/// 识别则 fail-closed 返回 Err——见模块级「损坏策略」说明。
fn hosts_read(file: &Path) -> Result<Vec<SshHostEntry>, String> {
    reject_symlink(file)?;
    let metadata = match fs::metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 SSH 主机注册表失败：{error}")),
    };
    if !metadata.is_file() {
        return Err(format!("SSH 主机注册表不是常规文件：{}", file.display()));
    }
    if metadata.len() > MAX_HOSTS_FILE_BYTES {
        return Err("SSH 主机注册表超出安全大小上限".into());
    }
    let raw = fs::read_to_string(file).map_err(|error| format!("读取 SSH 主机注册表失败：{error}"))?;
    let document: HostsDocument = serde_json::from_str(&raw)
        .map_err(|error| format!("SSH 主机注册表已损坏，请手动检查 {}：{error}", file.display()))?;
    if document.schema_version != HOSTS_SCHEMA_VERSION {
        return Err(format!(
            "SSH 主机注册表 schema 版本 {} 不受支持（期望 {HOSTS_SCHEMA_VERSION}）",
            document.schema_version
        ));
    }
    if document.hosts.len() > MAX_HOSTS {
        return Err("SSH 主机注册表条目数超出安全上限".into());
    }
    Ok(document.hosts)
}

/// 原子写回：同目录临时文件 + persist，目录 0700、文件 0600（对齐授权注册表）。
fn hosts_write(file: &Path, hosts: &[SshHostEntry]) -> Result<(), String> {
    let Some(parent) = file.parent() else {
        return Err("SSH 主机注册表没有父目录".into());
    };
    fs::create_dir_all(parent).map_err(|error| format!("创建 SSH 配置目录失败：{error}"))?;
    set_directory_permissions(parent)?;
    reject_symlink(file)?;
    let encoded = serde_json::to_vec_pretty(&HostsDocumentRef {
        schema_version: HOSTS_SCHEMA_VERSION,
        hosts,
    })
    .map_err(|error| format!("编码 SSH 主机注册表失败：{error}"))?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("暂存 SSH 主机注册表失败：{error}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("加固 SSH 主机注册表权限失败：{error}"))?;
    }
    temporary
        .write_all(&encoded)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("写入 SSH 主机注册表失败：{error}"))?;
    temporary.persist(file).map(|_| ()).map_err(|error| {
        format!("提交 SSH 主机注册表失败：{}", error.error)
    })
}

/// 新增/更新的已校验输入（校验与落盘分离，便于对校验规则单独测试）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostInput {
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
}

fn reject_blank_or_oversized(field: &str, value: &str, max_bytes: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field}不能为空"));
    }
    if trimmed.len() > max_bytes {
        return Err(format!("{field}超出长度上限（{max_bytes} 字节）"));
    }
    Ok(trimmed.to_string())
}

fn reject_whitespace(field: &str, value: &str) -> Result<String, String> {
    if value.chars().any(char::is_whitespace) {
        return Err(format!("{field}不能包含空白字符"));
    }
    Ok(value.to_string())
}

/// 拒绝以 `-` 开头的值：地址/用户名拼成 `user@host` 作为 ssh 的 destination
/// 参数——受陷渲染进程可经 saveHost 写入 `-oProxyCommand=…` 之类的「用户名」
/// （不含空白、可过空白校验），在 exec 通道里会被 ssh 解析成选项、把
/// remote_command 顶替成 destination，形成本地任意命令执行。配合 destination
/// 前的 `--`（build_ssh_args）构成双保险。
fn reject_leading_dash(field: &str, value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!("{field}不能以 - 开头"));
    }
    Ok(())
}

/// 私钥路径最大长度：macOS PATH_MAX 1024 已覆盖一切合法路径。
const MAX_PRIVATE_KEY_PATH_BYTES: usize = 1024;

/// 校验私钥路径（可选字段）。要求绝对路径——相对路径会按 app 进程 cwd 解析，
/// 对用户而言是歧义来源；路径内部允许空白（argv 直传不经 shell，含空格的
/// 合法路径如 `/Users/a b/id_rsa` 可用），首尾空白一律 trim。
pub(crate) fn validate_private_key_path(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("私钥路径不能为空".into());
    }
    if trimmed.len() > MAX_PRIVATE_KEY_PATH_BYTES {
        return Err(format!("私钥路径超出长度上限（{MAX_PRIVATE_KEY_PATH_BYTES} 字节）"));
    }
    if !trimmed.starts_with('/') {
        return Err("私钥路径必须是绝对路径（以 / 开头）".into());
    }
    Ok(trimmed.to_string())
}

/// 字段校验：名称非空；地址/用户名非空且不含空白、不以 `-` 开头（地址后续要
/// 拼进 `ssh user@host -p port` 命令面，空白与选项前缀都是参数注入面）；端口 ≥ 1。
pub(crate) fn validate_host_input(
    name: &str,
    hostname: &str,
    port: u16,
    username: &str,
) -> Result<HostInput, String> {
    let name = reject_blank_or_oversized("主机名称", name, MAX_NAME_BYTES)?;
    let hostname = reject_blank_or_oversized("主机地址", hostname, MAX_HOSTNAME_BYTES)?;
    let hostname = reject_whitespace("主机地址", &hostname)?;
    let username = reject_blank_or_oversized("用户名", username, MAX_USERNAME_BYTES)?;
    let username = reject_whitespace("用户名", &username)?;
    reject_leading_dash("主机地址", &hostname)?;
    reject_leading_dash("用户名", &username)?;
    if port == 0 {
        return Err("端口必须为正整数".into());
    }
    Ok(HostInput {
        name,
        hostname,
        port,
        username,
    })
}

/// 主机 id：sha256(字段 + 单调计数 + 纳秒时间) 取前 16 hex——同纳秒的两次
/// 创建也被计数器分开，无需引入 uuid/rand 依赖。
fn generate_host_id(input: &HostInput, sequence: u64, nanos: u128) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.name.as_bytes());
    hasher.update([0]);
    hasher.update(input.hostname.as_bytes());
    hasher.update([0]);
    hasher.update(input.username.as_bytes());
    hasher.update([0]);
    hasher.update(input.port.to_be_bytes());
    hasher.update([0]);
    hasher.update(sequence.to_be_bytes());
    hasher.update(nanos.to_be_bytes());
    let digest = hasher.finalize();
    digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

static HOST_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 密码保存决策（纯函数，便于对语义单独测试）：
/// - None：表单未触碰密码 → 保持现状；
/// - Some("")：显式清除已托管密码；
/// - Some(pw)：保存/替换。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PasswordAction {
    Keep,
    Clear { key: String },
    Set { key: String, value: String },
}

pub(crate) const SSH_HOST_SECRET_PREFIX: &str = "ssh.host.";

/// 私钥路径落盘归一：空串视为清除（None），非空原样保留（上游已校验）。
fn normalize_private_key_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

pub(crate) fn password_action_for(
    host_id: &str,
    password: Option<&str>,
) -> PasswordAction {
    let key = format!("{SSH_HOST_SECRET_PREFIX}{host_id}");
    match password {
        None => PasswordAction::Keep,
        Some("") => PasswordAction::Clear { key },
        Some(value) => PasswordAction::Set { key, value: value.to_string() },
    }
}

/// 新增或更新（`id` 命中既有条目则原位更新、保留 createdAt 与位置），并按
/// `password` / `private_key_path` 决策托管/清除（明文只进 secrets 表，注册表
/// 只留引用；私钥路径非密直接落注册表，语义与 password 同：None 保留 /
/// Some("") 清除 / Some(v) 设置）。返回写回后的完整列表，调用方直接回传前端
/// 替换 store 状态。
pub(crate) fn hosts_upsert(
    file: &Path,
    id: Option<String>,
    input: &HostInput,
    password: Option<&str>,
    private_key_path: Option<&str>,
    secrets: Option<&crate::secrets::SecretState>,
) -> Result<Vec<SshHostEntry>, String> {
    let mut hosts = hosts_read(file)?;
    let mut target_id = id.clone();
    if let Some(id) = id.as_deref() {
        let existing = hosts
            .iter_mut()
            .find(|host| host.id == id)
            .ok_or_else(|| format!("要编辑的主机不存在（{id}）"))?;
        existing.name = input.name.clone();
        existing.hostname = input.hostname.clone();
        existing.port = input.port;
        existing.username = input.username.clone();
        if let Some(key_path) = private_key_path {
            existing.private_key_path = normalize_private_key_path(key_path);
        }
    } else {
        if hosts.len() >= MAX_HOSTS {
            return Err(format!("主机数量已达上限（{MAX_HOSTS}），请先删除不需要的主机"));
        }
        let sequence = HOST_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let created = SshHostEntry {
            id: generate_host_id(input, sequence, nanos),
            name: input.name.clone(),
            hostname: input.hostname.clone(),
            port: input.port,
            username: input.username.clone(),
            created_at: now_epoch_seconds(),
            secret_id: None,
            private_key_path: private_key_path.and_then(normalize_private_key_path),
        };
        target_id = Some(created.id.clone());
        hosts.push(created);
    }

    if let Some(action_target) = target_id.as_deref() {
        if password.is_some() {
            let secrets = secrets.ok_or_else(|| "secrets 存储不可用，无法托管密码".to_string())?;
            match password_action_for(action_target, password) {
                PasswordAction::Keep => {}
                PasswordAction::Clear { key } => {
                    // 清除失败不阻断保存（旧条目可能本就没有密码）。
                    let _ = crate::secrets::delete_ssh_secret(secrets, &key);
                    if let Some(entry) = hosts.iter_mut().find(|host| host.id == action_target) {
                        entry.secret_id = None;
                    }
                }
                PasswordAction::Set { key, value } => {
                    crate::secrets::save_ssh_secret(secrets, &key, &value)?;
                    if let Some(entry) = hosts.iter_mut().find(|host| host.id == action_target) {
                        entry.secret_id = Some(key);
                    }
                }
            }
        }
    }

    hosts_write(file, &hosts)?;
    Ok(hosts)
}

/// 删除主机；id 不存在视为已删除（幂等），同样返回删后全量列表。已托管的
/// 密码随主机删除清理（best-effort：密钥库删除失败不阻断主机删除，避免
/// 用户被卡在「删不掉」；残留引用已是孤儿、无任何读取方）。
pub(crate) fn hosts_remove(
    file: &Path,
    id: &str,
    secrets: Option<&crate::secrets::SecretState>,
) -> Result<Vec<SshHostEntry>, String> {
    let mut hosts = hosts_read(file)?;
    let removed_secret_id = hosts
        .iter()
        .find(|host| host.id == id)
        .and_then(|host| host.secret_id.clone());
    hosts.retain(|host| host.id != id);
    hosts_write(file, &hosts)?;
    if let (Some(secret_id), Some(secrets)) = (removed_secret_id, secrets) {
        let _ = crate::secrets::delete_ssh_secret(secrets, &secret_id);
    }
    Ok(hosts)
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

/// `ssh_command` 分发的托管状态：注册表读-改-写串行化短锁。
#[derive(Default)]
pub struct SshState {
    pub registry_mutations: StdMutex<()>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SshCommandRequest {
    ListHosts,
    SaveHost {
        /// None = 新增；Some = 更新既有条目。
        id: Option<String>,
        name: String,
        hostname: String,
        port: u16,
        username: String,
        /// None = 不改动已托管密码；Some("") = 清除；Some(pw) = 保存/替换。
        password: Option<String>,
        /// None = 不改动私钥路径；Some("") = 清除；Some(path) = 设置（绝对路径）。
        private_key_path: Option<String>,
    },
    DeleteHost { id: String },
    // ---- 会话类动作（P1，委托 ssh_session::dispatch_session_action）----
    OpenSession {
        host_id: String,
        cols: u16,
        rows: u16,
    },
    WriteSession { host_id: String, data: String },
    ResizeSession {
        host_id: String,
        cols: u16,
        rows: u16,
    },
    CloseSession { host_id: String },
    /// 触发上传：路径由 Rust 原生文件选择器决定（渲染进程不可指定本地路径）；
    /// remote_dir 为本次上传的目标远程目录（SFTP 面板当前浏览目录）。
    UploadFile {
        host_id: String,
        remote_dir: String,
    },
    /// 续传最近一次失败/取消的上传（材料在 Rust 侧留存）。
    ResumeUpload { host_id: String },
    /// 取消在途上传（保留续传材料）。
    CancelUpload { host_id: String },
    /// 列出远程目录（SFTP 文件浏览器：名称/权限/大小/修改时间）。
    ListFiles {
        host_id: String,
        path: String,
    },
    /// 创建远程目录（SFTP 文件浏览器 + 目录上传 mkdir -p）。
    MakeDir {
        host_id: String,
        path: String,
    },
    /// 上传本地文件夹到 remote_dir（递归：先建目录，再逐文件流式上传）。
    UploadFolder {
        host_id: String,
        remote_dir: String,
    },
    ListSessions,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SshCommandResponse {
    /// 主机全量列表（CRUD 后统一回传，前端整体替换 store 状态）。
    Hosts { hosts: Vec<SshHostEntry> },
    /// 无载荷确认（会话打开/写入/调整/关闭成功）。
    Ack,
    /// 活跃会话清单（hostId 列表，驱动主机列表状态列）。
    Sessions {
        sessions: Vec<crate::ssh_session::SshSessionInfo>,
    },
    /// 远程目录列表（SFTP 文件浏览器）。
    Files {
        host_id: String,
        path: String,
        entries: Vec<crate::ssh_session::RemoteDirEntry>,
        /// 目录条目数超出上限时截断（前端提示继续）。
        truncated: bool,
    },
}

/// SSH 命令统一入口。主机 CRUD 走注册表锁 + spawn_blocking；会话类动作
/// 委托 ssh_session（不取注册表锁）。写路径整体入 blocking 线程池：State 在
/// 闭包内经 `app.state` 解析（非 'static 借用不能捕获进闭包），锁等待与文件
/// I/O 不占 tokio worker。
#[tauri::command]
pub async fn ssh_command(
    app: AppHandle,
    request: SshCommandRequest,
) -> Result<SshCommandResponse, String> {
    use crate::ssh_session::{dispatch_session_action, SshSessionAction};
    match request {
        // 会话类动作先行分流：不触碰注册表，锁与 I/O 归 ssh_session 自治。
        SshCommandRequest::OpenSession { host_id, cols, rows } => {
            dispatch_session_action(app, SshSessionAction::Open { host_id, cols, rows }).await
        }
        SshCommandRequest::WriteSession { host_id, data } => {
            dispatch_session_action(app, SshSessionAction::Write { host_id, data }).await
        }
        SshCommandRequest::ResizeSession { host_id, cols, rows } => {
            dispatch_session_action(app, SshSessionAction::Resize { host_id, cols, rows }).await
        }
        SshCommandRequest::CloseSession { host_id } => {
            dispatch_session_action(app, SshSessionAction::Close { host_id }).await
        }
        SshCommandRequest::UploadFile { host_id, remote_dir } => {
            dispatch_session_action(app, SshSessionAction::Upload { host_id, remote_dir }).await
        }
        SshCommandRequest::ResumeUpload { host_id } => {
            dispatch_session_action(app, SshSessionAction::Resume { host_id }).await
        }
        SshCommandRequest::CancelUpload { host_id } => {
            dispatch_session_action(app, SshSessionAction::Cancel { host_id }).await
        }
        SshCommandRequest::ListFiles { host_id, path } => {
            dispatch_session_action(app, SshSessionAction::ListFiles { host_id, path }).await
        }
        SshCommandRequest::MakeDir { host_id, path } => {
            dispatch_session_action(app, SshSessionAction::MakeDir { host_id, path }).await
        }
        SshCommandRequest::UploadFolder { host_id, remote_dir } => {
            dispatch_session_action(app, SshSessionAction::UploadFolder { host_id, remote_dir }).await
        }
        SshCommandRequest::ListSessions => {
            dispatch_session_action(app, SshSessionAction::List).await
        }
        host_action => {
            let file = hosts_file_path(&app)?;
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<SshState>();
                let _guard = state
                    .registry_mutations
                    .lock()
                    .map_err(|_| "SSH 主机注册表锁已中毒".to_string())?;
                match host_action {
                    SshCommandRequest::ListHosts => Ok(SshCommandResponse::Hosts {
                        hosts: hosts_read(&file)?,
                    }),
                    SshCommandRequest::SaveHost {
                        id,
                        name,
                        hostname,
                        port,
                        username,
                        password,
                        private_key_path,
                    } => {
                        let input = validate_host_input(&name, &hostname, port, &username)?;
                        // 非空路径在写入前校验（绝对路径/长度）；Some("") = 清除，
                        // 无需校验。路径会拼进 ssh `-i` argv，规则与 destination
                        // 同源地保守。
                        let validated_key_path = match private_key_path.as_deref() {
                            None => None,
                            Some("") => Some(String::new()),
                            Some(path) => Some(validate_private_key_path(path)?),
                        };
                        let secrets = app.try_state::<crate::secrets::SecretState>();
                        Ok(SshCommandResponse::Hosts {
                            hosts: hosts_upsert(
                                &file,
                                id,
                                &input,
                                password.as_deref(),
                                validated_key_path.as_deref(),
                                secrets.as_deref(),
                            )?,
                        })
                    }
                    SshCommandRequest::DeleteHost { id } => {
                        // 删除主机前先关停其活跃会话（若在）：注册表条目删除后前端
                        // 投影即清、不再有入口触发 Close，不先杀的话 ssh 进程只能
                        // 等应用退出 reap 兜底——连接与 PTY 全程残留。signal_close
                        // 走事件任务收尾（SIGTERM → 宽限 → SIGKILL → remove）。
                        if let Some(session_state) = app.try_state::<crate::ssh_session::SshSessionState>()
                        {
                            session_state.signal_close(&id);
                            session_state.forget_host(&id);
                        }
                        let secrets = app.try_state::<crate::secrets::SecretState>();
                        Ok(SshCommandResponse::Hosts {
                            hosts: hosts_remove(&file, &id, secrets.as_deref())?,
                        })
                    }
                    // 会话类动作已在 match 顶部分流，此处不可达。
                    SshCommandRequest::OpenSession { .. }
                    | SshCommandRequest::WriteSession { .. }
                    | SshCommandRequest::ResizeSession { .. }
                    | SshCommandRequest::CloseSession { .. }
                    | SshCommandRequest::UploadFile { .. }
                    | SshCommandRequest::ResumeUpload { .. }
                    | SshCommandRequest::CancelUpload { .. }
                    | SshCommandRequest::ListFiles { .. }
                    | SshCommandRequest::MakeDir { .. }
                    | SshCommandRequest::UploadFolder { .. }
                    | SshCommandRequest::ListSessions => {
                        unreachable!("session actions are dispatched above")
                    }
                }
            })
            .await
            .map_err(|error| format!("SSH 命令任务中断：{error}"))?
        }
    }
}

/// 按 id 查找主机（OpenSession 前置校验：渲染进程只能连接已登记主机，
/// 连接目标字段一律取自注册表而非请求参数）。
pub(crate) fn find_host(
    app: &AppHandle,
    host_id: &str,
) -> Result<Option<SshHostEntry>, String> {
    let file = hosts_file_path(app)?;
    Ok(hosts_read(&file)?.into_iter().find(|host| host.id == host_id))
}

/// 读取全部主机（ssh_agent 的 ListHosts 消费：注册表条目并入 Agent 可连清单）。
/// 文件缺失视为空集；损坏 fail-closed 与 CRUD 同源。
pub(crate) fn list_hosts(app: &AppHandle) -> Result<Vec<SshHostEntry>, String> {
    let file = hosts_file_path(app)?;
    hosts_read(&file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 每个用例独立的临时目录（对齐 workspace_registry 测试形态）。
    fn temporary_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "axiom-ssh-test-{}-{}",
            std::process::id(),
            HOST_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// 与生产布局一致的注册表路径：`<dir>/ssh/hosts.json`（父目录由
    /// hosts_write 创建并加固为 0700）。
    fn hosts_file_in(directory: &Path) -> PathBuf {
        directory.join(HOSTS_DIRECTORY_NAME).join(HOSTS_FILE_NAME)
    }

    fn sample_input(name: &str) -> HostInput {
        HostInput {
            name: name.to_string(),
            hostname: "server.example.com".to_string(),
            port: 22,
            username: "amu".to_string(),
        }
    }

    #[test]
    fn save_list_delete_roundtrip() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);

        assert!(hosts_read(&file).unwrap().is_empty());
        let hosts = hosts_upsert(&file, None, &sample_input("生产机"), None, None, None).unwrap();
        assert_eq!(hosts.len(), 1);

        let hosts = hosts_remove(&file, &hosts[0].id, None).unwrap();
        assert!(hosts.is_empty());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn update_keeps_created_at_and_position() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);

        let hosts = hosts_upsert(&file, None, &sample_input("第一台"), None, None, None).unwrap();
        let second = hosts_upsert(&file, None, &sample_input("第二台"), None, None, None).unwrap();
        let original_created_at = hosts[0].created_at;
        let original_id = hosts[0].id.clone();

        let updated = hosts_upsert(
            &file,
            Some(original_id.clone()),
            &HostInput {
                name: "第一台（改名）".into(),
                hostname: "10.0.0.2".into(),
                port: 2222,
                username: "admin".into(),
            },
            None,
            None,
            None,
        )
        .unwrap();

        assert_eq!(updated.len(), 2);
        assert_eq!(updated[0].id, original_id);
        assert_eq!(updated[0].name, "第一台（改名）");
        assert_eq!(updated[0].hostname, "10.0.0.2");
        assert_eq!(updated[0].port, 2222);
        assert_eq!(updated[0].created_at, original_created_at);
        assert_eq!(updated[1].id, second[1].id);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unknown_host_on_update() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);
        assert!(hosts_upsert(&file, Some("missing".into()), &sample_input("x"), None, None, None).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn fails_closed_on_corrupted_or_unsupported_documents() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);
        fs::create_dir_all(file.parent().unwrap()).unwrap();

        // 全新安装：文件不存在 = 空集。
        assert!(hosts_read(&file).unwrap().is_empty());

        fs::write(&file, "not json").unwrap();
        assert!(hosts_read(&file).is_err());

        fs::write(&file, r#"{"schemaVersion":99,"hosts":[]}"#).unwrap();
        assert!(hosts_read(&file).is_err());

        fs::write(&file, r#"{"schemaVersion":1,"hosts":[],"unexpected":true}"#).unwrap();
        assert!(hosts_read(&file).is_err());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn save_refuses_to_clobber_corrupted_registry() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        const CORRUPTED: &str = "corrupted{";
        fs::write(&file, CORRUPTED).unwrap();

        // 损坏时读与写都必须 fail-closed：回退空集会让下一次保存清掉整份文件。
        assert!(hosts_read(&file).is_err());
        assert!(hosts_upsert(&file, None, &sample_input("x"), None, None, None).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), CORRUPTED);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn validates_host_fields() {
        assert!(validate_host_input("", "host", 22, "amu").is_err());
        assert!(validate_host_input("  ", "host", 22, "amu").is_err());
        assert!(validate_host_input("名称", "host with space", 22, "amu").is_err());
        assert!(validate_host_input("名称", "host", 0, "amu").is_err());
        assert!(validate_host_input("名称", "host", 22, "a m u").is_err());
        let oversized = "x".repeat(MAX_NAME_BYTES + 1);
        assert!(validate_host_input(&oversized, "host", 22, "amu").is_err());

        // leading `-` 会把 user@host 顶替成 ssh 选项（选项注入面），fail-closed。
        assert!(validate_host_input("名称", "-oProxyCommand=x", 22, "amu").is_err());
        assert!(validate_host_input("名称", "host", 22, "-oProxyCommand=x").is_err());
        assert!(validate_host_input("名称", "-host", 22, "-user").is_err());

        let valid = validate_host_input(" 名称 ", "host", 22, "amu").unwrap();
        assert_eq!(valid.name, "名称");
        assert_eq!(valid.hostname, "host");
    }

    #[test]
    fn enforces_host_limit() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);
        for index in 0..MAX_HOSTS {
            hosts_upsert(&file, None, &sample_input(&format!("主机{index}")), None, None, None).unwrap();
        }
        assert!(hosts_upsert(&file, None, &sample_input("超限"), None, None, None).is_err());
        assert_eq!(hosts_read(&file).unwrap().len(), MAX_HOSTS);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn password_action_semantics() {
        use super::{password_action_for, PasswordAction};
        // None = 不改动；Some("") = 清除；Some(pw) = 保存/替换。
        assert_eq!(
            password_action_for("host-1", None),
            PasswordAction::Keep
        );
        assert_eq!(
            password_action_for("host-1", Some("")),
            PasswordAction::Clear { key: "ssh.host.host-1".into() }
        );
        assert_eq!(
            password_action_for("host-1", Some("s3cret")),
            PasswordAction::Set { key: "ssh.host.host-1".into(), value: "s3cret".into() }
        );
    }

    #[test]
    fn generated_ids_are_unique_for_identical_inputs() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);
        let first = hosts_upsert(&file, None, &sample_input("同名同址"), None, None, None).unwrap();
        let second = hosts_upsert(&file, None, &sample_input("同名同址"), None, None, None).unwrap();
        assert_ne!(first[0].id, second[1].id);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn writes_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);
        hosts_upsert(&file, None, &sample_input("x"), None, None, None).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // 配置子目录继承数据根的私有权限（0700）。
        let ssh_directory = file.parent().unwrap();
        let directory_mode = fs::metadata(ssh_directory).unwrap().permissions().mode();
        assert_eq!(directory_mode & 0o777, 0o700);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_symlinked_hosts_file() {
        let directory = temporary_directory();
        let real = directory.join("real.json");
        fs::write(&real, r#"{"schemaVersion":1,"hosts":[]}"#).unwrap();
        let link = directory.join(HOSTS_FILE_NAME);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(hosts_read(&link).is_err());
        assert!(hosts_upsert(&link, None, &sample_input("x"), None, None, None).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn validates_private_key_path() {
        // 合法绝对路径：trim 首尾空白后接受。
        assert_eq!(
            validate_private_key_path(" /Users/amu/.ssh/id_ed25519 ").unwrap(),
            "/Users/amu/.ssh/id_ed25519"
        );
        // 相对路径拒绝（按 app cwd 解析是歧义来源）。
        assert!(validate_private_key_path("id_rsa").is_err());
        assert!(validate_private_key_path("./id_rsa").is_err());
        assert!(validate_private_key_path("~/id_rsa").is_err());
        // 空 / 纯空白拒绝（清除走 SaveHost 的 Some("") 语义，不进此函数）。
        assert!(validate_private_key_path("").is_err());
        assert!(validate_private_key_path("   ").is_err());
        // 超长拒绝。
        let long = format!("/{}", "a".repeat(MAX_PRIVATE_KEY_PATH_BYTES));
        assert!(validate_private_key_path(&long).is_err());
    }

    #[test]
    fn upsert_sets_clears_and_keeps_private_key_path() {
        let directory = temporary_directory();
        let file = hosts_file_in(&directory);

        // 新增时直接带私钥路径。
        let hosts = hosts_upsert(
            &file,
            None,
            &sample_input("带密钥"),
            None,
            Some("/Users/amu/.ssh/id_ed25519"),
            None,
        )
        .unwrap();
        assert_eq!(
            hosts[0].private_key_path.as_deref(),
            Some("/Users/amu/.ssh/id_ed25519")
        );
        let host_id = hosts[0].id.clone();

        // 更新：None = 保留既有路径。
        let hosts = hosts_upsert(&file, Some(host_id.clone()), &sample_input("带密钥"), None, None, None)
            .unwrap();
        assert_eq!(
            hosts[0].private_key_path.as_deref(),
            Some("/Users/amu/.ssh/id_ed25519")
        );

        // 更新：Some("") = 清除。
        let hosts =
            hosts_upsert(&file, Some(host_id.clone()), &sample_input("带密钥"), None, Some(""), None)
                .unwrap();
        assert_eq!(hosts[0].private_key_path, None);

        // 更新：Some(新路径) = 替换。
        let hosts = hosts_upsert(
            &file,
            Some(host_id),
            &sample_input("带密钥"),
            None,
            Some("/Users/amu/.ssh/id_rsa"),
            None,
        )
        .unwrap();
        assert_eq!(
            hosts[0].private_key_path.as_deref(),
            Some("/Users/amu/.ssh/id_rsa")
        );

        fs::remove_dir_all(directory).unwrap();
    }
}
