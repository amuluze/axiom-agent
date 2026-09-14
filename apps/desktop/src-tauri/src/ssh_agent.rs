//! Agent 侧 SSH 远程执行通道（P0：读取 SSH 配置 + 远程 exec）。
//!
//! 与 `ssh.rs`/`ssh_session.rs`（用户亲手操作的终端通道）是两个信任档：本模块
//! 是 **Agent 工具**——模型经 `ssh_agent_command` 结构化动作读取 `~/.ssh/config`
//! 主机清单、对已登记目标执行一次性远程命令。安全边界全部由本层 Rust 权威强制：
//!
//! - **主机门禁 fail-closed**：exec 的目标只接受「`~/.ssh/config` 里的别名」或
//!   「Axiom 主机注册表 hostId」，渲染进程/模型无法传入任意 IP/URL/未登记目标。
//!   实际连接时别名作 destination 直传，User/Port/IdentityFile/ProxyJump/Include
//!   等由 ssh 自行按用户配置解析——解析器只产出门禁白名单与展示字段。
//! - **凭据不进模型上下文**：私钥/密码由 Rust 拉起的 ssh 子进程使用（继承宿主
//!   环境，agent 转发可用），输出经凭据脱敏后交付；WebView 只见结构化结果。
//! - **逐次审批 + 会话授权**：lease 消费绑定 `{host, command}`（workspace_approval
//!   的 `run_ssh_command` 规范输入）；首连原生对话框三选一（仅此一次 / 本会话内
//!   允许该主机 / 拒绝）——「本会话允许」只由不可伪造的原生手势写入授权表，
//!   TS 侧镜像仅用于免卡片，签发时 Rust 仍校验自己的授权表。
//! - **资源边界**：wall-clock 超时（默认 60s、上限 10min）SIGTERM→宽限→SIGKILL
//!   收尾本地 ssh；输出合用 2 MiB 预算 + 截断标记；ControlPersist 复用连接随
//!   应用退出统一收口。
//!
//! 子 Agent 不共享（`scopedReadEnvironment` 结构性封死）：远程主机是主 Agent
//! 专用的有状态特权通道。

use globset::Glob;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::ssh::find_host;
use crate::terminal::signal_process_group;

const SSH_AGENT_GRANT_EVENT: &str = "axiom:ssh-agent-grant";
/// 远程命令默认/最长执行时长（wall-clock；到期杀本地 ssh 进程组）。
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 60_000;
const MAX_EXEC_TIMEOUT_MS: u64 = 600_000;
/// stdout+stderr 合用输出预算（对齐 bash 工具的 2 MiB）；超出置 truncated。
const MAX_EXEC_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
/// 远程命令字符串上限（作为单个 argv 元素交付远端 shell）。
const MAX_EXEC_COMMAND_CHARS: usize = 64 * 1024;
const MAX_HOST_REF_CHARS: usize = 255;
/// 连接复用：ControlPersist 让 master 在命令间存活，重复 exec 免重复认证。
const CONTROL_PERSIST: &str = "10m";
const CONNECT_TIMEOUT_SECONDS: u32 = 10;
const KEEPALIVE_INTERVAL_SECONDS: u32 = 15;
const KEEPALIVE_COUNT_MAX: u32 = 3;
/// 与终端通道同一 TOFU 语义：首连自动信任，已登记主机密钥变更仍拒绝。
const STRICT_HOST_KEY: &str = "accept-new";
const TERMINATION_GRACE_MS: u64 = 500;

// ---------------------------------------------------------------------------
// ~/.ssh/config 解析（门禁白名单 + 展示；实际解析交给 ssh 本身）
// ---------------------------------------------------------------------------

/// 解析出的 config 主机条目：alias 是 exec 的 `host` 入参；其余字段仅展示
/// （用户配置里未声明时为 None，由 ssh 连接时自行解析）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SshConfigAlias {
    pub alias: String,
    pub hostname: Option<String>,
    pub username: Option<String>,
    pub port: Option<u16>,
}

/// Include 递归护栏：深度与文件数上限（防 include 环与配置目录爆炸）。
const MAX_INCLUDE_DEPTH: usize = 3;
const MAX_CONFIG_FILES: usize = 32;
const MAX_CONFIG_FILE_BYTES: u64 = 256 * 1024;

fn parse_config_file(
    path: &Path,
    home: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    aliases: &mut HashMap<String, SshConfigAlias>,
    file_budget: &mut usize,
) {
    if depth > MAX_INCLUDE_DEPTH || *file_budget == 0 {
        return;
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        return;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return; // 单文件缺失/不可读 fail-soft：不影响其余条目
    };
    if raw.len() as u64 > MAX_CONFIG_FILE_BYTES {
        return;
    }
    *file_budget -= 1;

    let ssh_dir = home.join(".ssh");
    // 当前 Host 行声明具体别名（跳过通配/否定模式）；后续参数行对仍缺该字段的
    // 别名赋值——OpenSSH 语义为「每个参数首次取得的值生效」。
    let mut current: Vec<String> = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let key = raw_key.to_ascii_lowercase();
        let value = raw_value.trim();
        if value.is_empty() {
            continue;
        }
        match key.as_str() {
            "host" => {
                current = value
                    .split_whitespace()
                    .filter(|token| !token.contains('*') && !token.contains('?') && !token.contains('!'))
                    .map(str::to_string)
                    .collect();
                for alias in &current {
                    aliases.entry(alias.clone()).or_insert_with(|| SshConfigAlias {
                        alias: alias.clone(),
                        hostname: None,
                        username: None,
                        port: None,
                    });
                }
            }
            "hostname" => {
                for alias in &current {
                    if let Some(entry) = aliases.get_mut(alias) {
                        entry.hostname.get_or_insert_with(|| value.to_string());
                    }
                }
            }
            "user" => {
                for alias in &current {
                    if let Some(entry) = aliases.get_mut(alias) {
                        entry.username.get_or_insert_with(|| value.to_string());
                    }
                }
            }
            "port" => {
                if let Ok(port) = value.parse::<u16>() {
                    for alias in &current {
                        if let Some(entry) = aliases.get_mut(alias) {
                            entry.port.get_or_insert(port);
                        }
                    }
                }
            }
            "include" => {
                for token in value.split_whitespace() {
                    for included in expand_include_paths(token, &ssh_dir) {
                        parse_config_file(
                            &included,
                            home,
                            depth + 1,
                            visited,
                            aliases,
                            file_budget,
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

/// 展开 Include 路径 token：`~` 展开；相对路径相对 `~/.ssh`；仅末段按 shell glob
/// 匹配（OpenSSH 常见形态是 `config.d/*`），不存在的条目静默跳过。
fn expand_include_paths(token: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let expanded = if let Some(rest) = token.strip_prefix("~/") {
        if let Some(home) = ssh_dir.parent() {
            home.join(rest)
        } else {
            return Vec::new()
        }
    } else if token.starts_with('/') {
        PathBuf::from(token)
    } else {
        ssh_dir.join(token)
    };
    let has_glob = token.contains('*') || token.contains('?');
    if !has_glob {
        return vec![expanded];
    }
    let parent = expanded
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"));
    let pattern = expanded
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Ok(matcher) = Glob::new(&pattern).map(|glob| glob.compile_matcher()) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&parent) else {
        return Vec::new();
    };
    let mut matches: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| matcher.is_match(name))
                .unwrap_or(false)
        })
        .collect();
    matches.sort();
    matches
}

/// 解析 `~/.ssh/config`（含 Include）：产出按首见顺序排列的别名清单。
pub(crate) fn parse_ssh_config(home: &Path) -> Vec<SshConfigAlias> {
    let mut aliases = HashMap::new();
    let mut visited = HashSet::new();
    let mut file_budget = MAX_CONFIG_FILES;
    parse_config_file(
        &home.join(".ssh").join("config"),
        home,
        0,
        &mut visited,
        &mut aliases,
        &mut file_budget,
    );
    let mut list: Vec<SshConfigAlias> = aliases.into_values().collect();
    list.sort_by(|a, b| a.alias.cmp(&b.alias));
    list
}

// ---------------------------------------------------------------------------
// exec 目标解析与参数构建（纯函数，测试锁定语义）
// ---------------------------------------------------------------------------

/// exec 实际使用的连接目标。
#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentSshTarget {
    /// config 别名（ssh 自行解析全部参数）或 `user@host`（注册表主机）。
    destination: String,
    /// 仅注册表主机显式指定端口；config 主机由用户配置决定。
    port: Option<u16>,
    /// 密钥/agent 认证走 BatchMode（非交互、无任何提示）；注册表密码主机
    /// 关闭 BatchMode、改由 askpass 注入（无 TTY 时 OpenSSH 自动走 askpass）。
    batch_mode: bool,
    /// 注册表主机的已托管密码（经 env 交给 askpass 助手；不落任何日志）。
    password: Option<String>,
    /// 注册表主机登记的私钥绝对路径（`-i` 显式优先）；config 主机恒为 None
    /// （IdentityFile 由用户 ssh 配置自行决定）。
    private_key_path: Option<String>,
}

/// exec 的 host 入参格式校验（第二道防线；主防线是门禁白名单）。
fn validate_host_reference(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_HOST_REF_CHARS {
        return Err("SSH 主机标识不能为空且需在 255 字符内".into());
    }
    if trimmed.starts_with('-') {
        return Err("SSH 主机标识不能以 - 开头".into());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("SSH 主机标识不能包含空白字符".into());
    }
    Ok(trimmed.to_string())
}

/// agent 通道的 ControlPath socket 名键：同目标复用同一 master。
fn agent_socket_key(destination: &str, port: Option<u16>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(destination.as_bytes());
    hasher.update([0]);
    hasher.update(port.unwrap_or(0).to_be_bytes());
    let digest = hasher.finalize();
    digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn agent_socket_path(data_root: &Path, socket_key: &str) -> PathBuf {
    data_root
        .join("ssh")
        .join(format!("cm-agent-{socket_key}.sock"))
}

/// agent askpass 助手脚本（内容常量，与终端通道同款；app 生命周期内复用一份，
/// 退出回收时删除）。密码经 `AXIOM_SSH_PASSWORD` 环境变量按进程注入。
const AGENT_ASKPASS_BODY: &str = "#!/bin/sh\nprintf '%s\\n' \"$AXIOM_SSH_PASSWORD\"\n";

fn agent_askpass_path(data_root: &Path) -> PathBuf {
    data_root.join("ssh").join(".askpass-agent.sh")
}

fn ensure_agent_askpass_script(data_root: &Path) -> Result<PathBuf, String> {
    let path = agent_askpass_path(data_root);
    if path.exists() {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建 ssh 配置目录失败：{error}"))?;
    }
    std::fs::write(&path, AGENT_ASKPASS_BODY)
        .map_err(|error| format!("写入 askpass 脚本失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("加固 askpass 脚本权限失败：{error}"))?;
    }
    Ok(path)
}

fn build_agent_exec_args(socket: &Path, target: &AgentSshTarget, command: &str) -> Vec<String> {
    let mut args = vec![
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}", socket.display()),
        "-o".into(),
        format!("ControlPersist={CONTROL_PERSIST}"),
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECONDS}"),
        "-o".into(),
        format!("ServerAliveInterval={KEEPALIVE_INTERVAL_SECONDS}"),
        "-o".into(),
        format!("ServerAliveCountMax={KEEPALIVE_COUNT_MAX}"),
        "-o".into(),
        format!("StrictHostKeyChecking={STRICT_HOST_KEY}"),
    ];
    if target.batch_mode {
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }
    // 注册表登记的私钥显式优先（对齐终端通道 build_ssh_args 的纯增量语义）。
    if let Some(key_path) = &target.private_key_path {
        args.push("-i".into());
        args.push(key_path.clone());
    }
    if let Some(port) = target.port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    // `--` 终止选项解析：destination 即便携带 `-` 前缀也只被当作目的地。
    args.push("--".into());
    args.push(target.destination.clone());
    // 命令作为最后一个 argv 元素交付远端默认 shell。
    args.push(command.to_string());
    args
}

/// 解析 exec 目标：注册表 hostId（16 hex）优先，其次 config 别名白名单。
/// 未登记目标 fail-closed（模型/渲染进程不能对任意地址发起连接）。
async fn resolve_exec_target(app: &AppHandle, host: &str) -> Result<AgentSshTarget, String> {
    let lookup_app = app.clone();
    let lookup_host = host.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<AgentSshTarget, String> {
        let home = app_home(&lookup_app)?;
        // 注册表主机：连接字段一律取自注册表（既有范式），密码经 secrets 托管。
        if crate::ssh_session::validate_host_id(&lookup_host).is_ok() {
            if let Some(entry) = find_host(&lookup_app, &lookup_host)? {
                let _ = crate::ssh::validate_host_input(
                    &entry.name, &entry.hostname, entry.port, &entry.username,
                )?;
                if let Some(key_path) = entry.private_key_path.as_deref() {
                    crate::ssh::validate_private_key_path(key_path)?;
                }
                let password = match entry.secret_id.as_deref() {
                    // secrets 读取（SQLite）可能阻塞：当前已在 blocking 池。
                    Some(secret_id) => load_ssh_password(&lookup_app, secret_id)?,
                    None => None,
                };
                return Ok(AgentSshTarget {
                    destination: format!("{}@{}", entry.username, entry.hostname),
                    port: Some(entry.port),
                    // 有托管密码 → 关闭 BatchMode 走 askpass；纯密钥/agent 主机
                    // 保持 BatchMode 非交互。
                    batch_mode: password.is_none(),
                    password,
                    private_key_path: entry.private_key_path,
                });
            }
        }
        // config 别名：destination 直传，User/Port/Identity/ProxyJump 由 ssh 解析。
        let aliases = parse_ssh_config(&home);
        if aliases.iter().any(|alias| alias.alias == lookup_host) {
            return Ok(AgentSshTarget {
                destination: lookup_host.clone(),
                port: None,
                batch_mode: true,
                password: None,
                private_key_path: None,
            });
        }
        Err(format!(
            "主机「{lookup_host}」未在 SSH 配置（~/.ssh/config）或 Axiom 主机注册表中登记；\
             请先在配置中添加 Host 条目或在「SSH」视图（侧栏导航）登记后重试"
        ))
    })
    .await
    .map_err(|error| format!("SSH 执行任务中断：{error}"))?
}

fn app_home(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|_| "无法解析用户主目录".to_string())
}

/// 读取注册表主机的托管密码（调用方须已在 blocking 上下文）。
fn load_ssh_password(app: &AppHandle, secret_id: &str) -> Result<Option<String>, String> {
    let Some(state) = app.try_state::<crate::secrets::SecretState>() else {
        return Ok(None);
    };
    crate::secrets::load_ssh_secret(state.inner(), secret_id)
}

// ---------------------------------------------------------------------------
// 会话授权（原生对话框三选一锚定；TS 镜像只用于免卡片）
// ---------------------------------------------------------------------------

enum SshExecDialogChoice {
    AllowOnce,
    AllowSession,
    Denied,
}

/// 首连三选一 sheet（挂主窗口，形态对齐 computer_control 的会话门）：仅此一次 /
/// 本会话内允许该主机 / 拒绝。「本会话允许」是唯一的授权写入来源——原生手势
/// 不可伪造，受陷渲染进程无法凭空制造授权。
async fn show_ssh_exec_dialog(
    app: &AppHandle,
    host: &str,
    command: &str,
) -> Result<SshExecDialogChoice, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSAlert, NSWindow};
        use objc2_foundation::{MainThreadMarker, NSString};

        let preview: String = command.chars().take(240).collect();
        let title = format!("允许 Axiom 在远程主机「{host}」上执行命令？");
        let message = format!(
            "命令预览：{preview}{}\n\n使用你的 SSH 配置与凭据连接该主机；输出经脱敏后交付给 Agent。",
            if command.chars().count() > 240 { "…[已截断]" } else { "" }
        );
        let app_handle = app.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel::<i64>();
        let sender_cell = Arc::new(StdMutex::new(Some(sender)));
        let sender_for_block = Arc::clone(&sender_cell);
        app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                if let Some(tx) = sender_cell.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(-1);
                }
                return;
            };
            let alert = NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str(&title));
            alert.setInformativeText(&NSString::from_str(&message));
            alert.setAlertStyle(objc2_app_kit::NSAlertStyle::Warning);
            alert.addButtonWithTitle(&NSString::from_str("仅此一次"));
            alert.addButtonWithTitle(&NSString::from_str("本会话内允许该主机"));
            alert.addButtonWithTitle(&NSString::from_str("拒绝"));
            let block = block2::RcBlock::new(move |response: isize| {
                if let Some(tx) = sender_for_block.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(response as i64);
                }
            });
            let parent = app_handle
                .get_webview_window("main")
                .and_then(|window| window.ns_window().ok());
            match parent {
                Some(raw) if !raw.is_null() => {
                    let ns_window: &NSWindow = unsafe { &*(raw.cast::<NSWindow>()) };
                    alert.beginSheetModalForWindow_completionHandler(
                        ns_window,
                        Some(&*block),
                    );
                    // sheet 模态会话由 AppKit 持有；forget 避免提前释放打断会话。
                    std::mem::forget(alert);
                }
                _ => {
                    let response = alert.runModal() as i64;
                    if let Some(tx) = sender_cell.lock().ok().and_then(|mut slot| slot.take()) {
                        let _ = tx.send(response);
                    }
                }
            }
        })
        .map_err(|_| "SSH 审批对话框调度失败".to_string())?;
        let response = receiver
            .await
            .map_err(|_| "SSH 审批对话框意外关闭".to_string())?;
        if response < 0 {
            return Err("SSH 审批对话框无法展示".into());
        }
        // NSAlertFirstButtonReturn = 1000 起。
        Ok(match response {
            1000 => SshExecDialogChoice::AllowOnce,
            1001 => SshExecDialogChoice::AllowSession,
            _ => SshExecDialogChoice::Denied,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, host, command);
        Err("仅 macOS 支持 SSH 远程执行审批".into())
    }
}

/// Interactive 首连确认入口（由 workspace_approval 的 lease 签发调用）：
/// 已有会话授权 → 静默放行（TS 镜像丢失事件的兜底路径）；否则三选一。
pub(crate) async fn confirm_ssh_exec_interactive(
    app: &AppHandle,
    session_id: &str,
    host: &str,
    command: &str,
) -> Result<(), String> {
    let state = app.state::<SshAgentState>();
    if state.grant_exists(session_id, host) {
        return Ok(());
    }
    match show_ssh_exec_dialog(app, host, command).await? {
        SshExecDialogChoice::AllowOnce => Ok(()),
        SshExecDialogChoice::AllowSession => {
            state.insert_grant(session_id, host);
            let _ = app.emit(
                SSH_AGENT_GRANT_EVENT,
                serde_json::json!({ "sessionId": session_id, "host": host }),
            );
            Ok(())
        }
        SshExecDialogChoice::Denied => Err(format!(
            "用户拒绝了在远程主机「{host}」上执行命令：停止在该主机上的操作，向用户说明后再继续"
        )),
    }
}

/// `SshSessionGranted` 签发模式的权威校验（渲染进程自报无效）。
pub(crate) fn ssh_session_grant_valid(app: &AppHandle, session_id: &str, host: &str) -> bool {
    app.state::<SshAgentState>().grant_exists(session_id, host)
}

// ---------------------------------------------------------------------------
// 托管状态：会话授权表 + ControlPersist socket 登记
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct SshAgentSocketRecord {
    path: PathBuf,
    destination: String,
}

#[derive(Default)]
pub(crate) struct SshAgentState {
    /// (sessionId → 已授权主机集合)。仅由原生对话框「本会话内允许」写入，
    /// 进程内存、重启清空（对齐 computer 会话授权的生命周期语义）。
    session_host_grants: StdMutex<HashMap<String, HashSet<String>>>,
    /// agent 通道的复用 master socket 登记（应用退出统一收口）。
    sockets: StdMutex<HashMap<String, SshAgentSocketRecord>>,
}

impl SshAgentState {
    fn grant_exists(&self, session_id: &str, host: &str) -> bool {
        self.session_host_grants
            .lock()
            .map(|grants| {
                grants
                    .get(session_id)
                    .map(|hosts| hosts.contains(host))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn insert_grant(&self, session_id: &str, host: &str) {
        if let Ok(mut grants) = self.session_host_grants.lock() {
            grants
                .entry(session_id.to_string())
                .or_default()
                .insert(host.to_string());
        }
    }

    fn grants_for_session(&self, session_id: &str) -> Vec<String> {
        self.session_host_grants
            .lock()
            .map(|grants| {
                grants
                    .get(session_id)
                    .map(|hosts| hosts.iter().cloned().collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    fn revoke_session(&self, session_id: &str) {
        if let Ok(mut grants) = self.session_host_grants.lock() {
            grants.remove(session_id);
        }
    }

    fn register_socket(&self, socket_key: &str, path: PathBuf, destination: &str) {
        if let Ok(mut sockets) = self.sockets.lock() {
            sockets.insert(
                socket_key.to_string(),
                SshAgentSocketRecord {
                    path,
                    destination: destination.to_string(),
                },
            );
        }
    }

    /// 应用退出回收：`ssh -O exit` 优雅关闭残留 master、删除 socket 与 askpass
    /// 脚本（best-effort，失败不阻断退出）。
    pub(crate) fn reap_for_exit(&self, data_root: &Path) {
        let records: Vec<SshAgentSocketRecord> = match self.sockets.lock() {
            Ok(mut sockets) => sockets.drain().map(|(_, record)| record).collect(),
            Err(_) => return,
        };
        for record in records {
            let _ = std::process::Command::new("ssh")
                .arg("-o")
                .arg(format!("ControlPath={}", record.path.display()))
                .arg("-O")
                .arg("exit")
                .arg("--")
                .arg(&record.destination)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output();
            let _ = std::fs::remove_file(&record.path);
        }
        let _ = std::fs::remove_file(agent_askpass_path(data_root));
    }
}

// ---------------------------------------------------------------------------
// exec 执行体（tokio 子进程 + wall-clock 超时 + 输出预算 + 脱敏）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshAgentExecOutcome {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    duration_ms: u64,
    timed_out: bool,
}

/// 单流读取任务：按块过输出预算（合用 2 MiB）并脱敏后累积。
async fn read_pipe_capped<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    budget: Arc<ExecOutputBudget>,
) -> String {
    use tokio::io::AsyncReadExt;
    let mut buffer = vec![0_u8; 16 * 1024];
    let mut collected: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if let Some(chunk) = budget.capture(&buffer[..count]) {
                    collected.extend_from_slice(&crate::workspace_command::redact_credentials(
                        &chunk,
                    ));
                }
            }
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

/// 输出预算（形态对齐 workspace_command::OutputBudget：stdout+stderr 合用、
/// 超出置 truncated；此处的 chunk 已包含脱敏前的原始字节计数）。
struct ExecOutputBudget {
    remaining: std::sync::atomic::AtomicUsize,
    truncated: std::sync::atomic::AtomicBool,
}

impl ExecOutputBudget {
    fn new() -> Self {
        Self {
            remaining: std::sync::atomic::AtomicUsize::new(MAX_EXEC_OUTPUT_BYTES),
            truncated: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn capture(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        use std::sync::atomic::Ordering;
        let mut available = self.remaining.load(Ordering::Relaxed);
        loop {
            if available == 0 {
                self.truncated.store(true, Ordering::Relaxed);
                return None;
            }
            let captured = available.min(bytes.len());
            match self.remaining.compare_exchange_weak(
                available,
                available - captured,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => {
                    if captured < bytes.len() {
                        self.truncated.store(true, Ordering::Relaxed);
                    }
                    return Some(bytes[..captured].to_vec());
                }
                Err(current) => available = current,
            }
        }
    }
}

async fn exec_remote_command(
    app: &AppHandle,
    target: &AgentSshTarget,
    command: &str,
    timeout_ms: Option<u64>,
) -> Result<SshAgentExecOutcome, String> {
    let data_root = crate::storage_paths::axiom_data_root(app)?;
    let socket_key = agent_socket_key(&target.destination, target.port);
    let socket = agent_socket_path(&data_root, &socket_key);
    let args = build_agent_exec_args(&socket, target, command);

    let started = Instant::now();
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_EXEC_TIMEOUT_MS)
            .min(MAX_EXEC_TIMEOUT_MS),
    );
    let deadline = tokio::time::Instant::now() + timeout;

    let mut process = tokio::process::Command::new("ssh");
    process
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // 继承宿主完整环境（用户通道语义：agent 转发与用户 ssh 配置生效）。
    if let Some(password) = target.password.as_deref() {
        let script = ensure_agent_askpass_script(&data_root)?;
        process.env("SSH_ASKPASS", script);
        process.env("SSH_ASKPASS_REQUIRE", "force");
        process.env("DISPLAY", ":0");
        process.env("AXIOM_SSH_PASSWORD", password);
    }
    {
        use std::os::unix::process::CommandExt;
        process.as_std_mut().process_group(0);
    }
    let mut child = process
        .spawn()
        .map_err(|error| format!("启动 ssh 进程失败：{error}"))?;
    let process_id = child.id();
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "无法接通 ssh 输出管道".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "无法接通 ssh 错误管道".to_string())?;
    let budget = Arc::new(ExecOutputBudget::new());
    let stdout_budget = Arc::clone(&budget);
    let stderr_budget = Arc::clone(&budget);
    let stdout_task = tokio::spawn(async move { read_pipe_capped(stdout_pipe, stdout_budget).await });
    let stderr_task = tokio::spawn(async move { read_pipe_capped(stderr_pipe, stderr_budget).await });

    let mut timed_out = false;
    let status = tokio::select! {
        status = child.wait() => status,
        _ = tokio::time::sleep_until(deadline) => {
            timed_out = true;
            if let Some(process_id) = process_id {
                let _ = signal_process_group(process_id, libc::SIGTERM);
                tokio::time::sleep(Duration::from_millis(TERMINATION_GRACE_MS)).await;
                let _ = signal_process_group(process_id, libc::SIGKILL);
            }
            child.wait().await
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();

    let state = app.state::<SshAgentState>();
    state.register_socket(&socket_key, socket, &target.destination);

    // 非零退出码常见于远端命令自身失败：stderr 原样交付模型自愈，不算执行错误。
    Ok(SshAgentExecOutcome {
        exit_code: status.ok().filter(|_| !timed_out).and_then(|status| status.code()),
        stdout,
        stderr,
        truncated: budget.truncated.load(std::sync::atomic::Ordering::Relaxed),
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
    })
}

// ---------------------------------------------------------------------------
// 命令契约与分发
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SshAgentCommandRequest {
    /// 列出可连接主机（config 别名 + 注册表条目）。只读、无副作用、不消费审批。
    ListHosts,
    /// 对已登记主机执行一次性远程命令（lease 消费 + 超时/输出边界）。
    Exec {
        session_id: String,
        host: String,
        command: String,
        timeout_ms: Option<u64>,
    },
    /// 查询会话已授权主机（TS 授权镜像重建用）。
    SessionGrants { session_id: String },
    /// 会话删除时回收授权。
    RevokeSessionGrants { session_id: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentHost {
    /// exec 的 `host` 入参：config 别名或注册表 hostId。
    pub host: String,
    /// "config" | "registry"。
    pub source: String,
    pub name: Option<String>,
    pub hostname: Option<String>,
    pub username: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SshAgentCommandResponse {
    Hosts { hosts: Vec<SshAgentHost> },
    Exec {
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
        truncated: bool,
        duration_ms: u64,
        timed_out: bool,
    },
    Grants { hosts: Vec<String> },
    Ack,
}

fn validate_agent_session_id(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 160
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':'))
    {
        return Err("SSH 会话标识不合法".into());
    }
    Ok(trimmed)
}

#[tauri::command]
pub(crate) async fn ssh_agent_command(
    app: AppHandle,
    request: SshAgentCommandRequest,
    approval_lease: Option<String>,
    workspace_path: Option<String>,
) -> Result<SshAgentCommandResponse, String> {
    match request {
        SshAgentCommandRequest::ListHosts => {
            let lookup_app = app.clone();
            let hosts = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SshAgentHost>, String> {
                let home = app_home(&lookup_app)?;
                let mut hosts: Vec<SshAgentHost> = Vec::new();
                // 注册表主机优先（用户显式登记），config 别名随后（按字母序）。
                for entry in crate::ssh::list_hosts(&lookup_app)? {
                    hosts.push(SshAgentHost {
                        host: entry.id.clone(),
                        source: "registry".into(),
                        name: Some(entry.name.clone()),
                        hostname: Some(entry.hostname.clone()),
                        username: Some(entry.username.clone()),
                        port: Some(entry.port),
                    });
                }
                for alias in parse_ssh_config(&home) {
                    hosts.push(SshAgentHost {
                        host: alias.alias,
                        source: "config".into(),
                        name: None,
                        hostname: alias.hostname,
                        username: alias.username,
                        port: alias.port,
                    });
                }
                Ok(hosts)
            })
            .await
            .map_err(|error| format!("SSH 主机清单任务中断：{error}"))??;
            Ok(SshAgentCommandResponse::Hosts { hosts })
        }
        SshAgentCommandRequest::Exec {
            session_id,
            host,
            command,
            timeout_ms,
        } => {
            // 会话标识只做格式校验（授权判定在 lease 签发侧按 Rust 授权表完成）。
            validate_agent_session_id(&session_id)?;
            let host = validate_host_reference(&host)?;
            let command = command.trim().to_string();
            if command.is_empty() {
                return Err("远程命令不能为空".into());
            }
            if command.chars().count() > MAX_EXEC_COMMAND_CHARS {
                return Err(format!("远程命令超出长度上限（{MAX_EXEC_COMMAND_CHARS} 字符）"));
            }
            if let Some(timeout) = timeout_ms {
                if timeout == 0 || timeout > MAX_EXEC_TIMEOUT_MS {
                    return Err(format!("超时需在 1..={MAX_EXEC_TIMEOUT_MS} 毫秒内"));
                }
            }
            // lease 消费：绑定 {host, command}（规范输入见 workspace_approval 的
            // run_ssh_command 分支）；消费失败 = 未审批/复用/篡改，fail-closed。
            let workspace_state = app.state::<crate::workspace_access::WorkspaceAccessState>();
            let root = crate::workspace_access::authorized_root_for(
                &workspace_state,
                workspace_path.as_deref(),
            )?;
            let lease = approval_lease
                .ok_or_else(|| "缺少审批租赁：远程执行必须逐次授权".to_string())?;
            app.state::<crate::workspace_approval::WorkspaceApprovalState>()
                .consume(
                    &lease,
                    "run_ssh_command",
                    serde_json::json!({
                        "host": &host,
                        "command": &command,
                    }),
                    workspace_state.generation_for(&root),
                    workspace_path.as_deref(),
                )?;

            let target = resolve_exec_target(&app, &host).await?;
            let outcome = exec_remote_command(&app, &target, &command, timeout_ms).await?;
            Ok(SshAgentCommandResponse::Exec {
                exit_code: outcome.exit_code,
                stdout: outcome.stdout,
                stderr: outcome.stderr,
                truncated: outcome.truncated,
                duration_ms: outcome.duration_ms,
                timed_out: outcome.timed_out,
            })
        }
        SshAgentCommandRequest::SessionGrants { session_id } => {
            let session_id = validate_agent_session_id(&session_id)?;
            let state = app.state::<SshAgentState>();
            Ok(SshAgentCommandResponse::Grants {
                hosts: state.grants_for_session(session_id),
            })
        }
        SshAgentCommandRequest::RevokeSessionGrants { session_id } => {
            let session_id = validate_agent_session_id(&session_id)?;
            app.state::<SshAgentState>().revoke_session(session_id);
            Ok(SshAgentCommandResponse::Ack)
        }
    }
}

/// 应用退出回收（lib.rs handle_run_event 与既有 ssh/browser reap 同点调用）。
pub(crate) fn reap_ssh_agent_for_exit(app: &AppHandle) {
    let Ok(data_root) = crate::storage_paths::axiom_data_root(app) else {
        return;
    };
    if let Some(state) = app.try_state::<SshAgentState>() {
        state.reap_for_exit(&data_root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> PathBuf {
        static TEST_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "axiom-ssh-agent-test-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn parses_aliases_with_first_value_wins_and_wildcards_skipped() {
        let home = temporary_directory();
        let ssh_dir = home.join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        std::fs::write(
            ssh_dir.join("config"),
            "Host prod\n  HostName 10.0.0.1\n  User amu\n  Port 2222\n  HostName ignored.example.com\n\n\
             Host * jump-*\n  User fallback\n\n\
             Host build\n  User builder\n",
        )
        .unwrap();

        let aliases = parse_ssh_config(&home);
        let names: Vec<&str> = aliases.iter().map(|alias| alias.alias.as_str()).collect();
        assert_eq!(names, vec!["build", "prod"]); // 通配模式不产出别名
        let prod = aliases.iter().find(|alias| alias.alias == "prod").unwrap();
        assert_eq!(prod.hostname.as_deref(), Some("10.0.0.1")); // 首值生效
        assert_eq!(prod.username.as_deref(), Some("amu"));
        assert_eq!(prod.port, Some(2222));
        // Host 块内未声明字段的别名保持 None（由 ssh 连接时解析）。
        let build = aliases.iter().find(|alias| alias.alias == "build").unwrap();
        assert_eq!(build.hostname, None);
        assert_eq!(build.username.as_deref(), Some("builder"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn parses_case_insensitive_keys_and_comments() {
        let home = temporary_directory();
        let ssh_dir = home.join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        std::fs::write(
            ssh_dir.join("config"),
            "# comment\nhost PROD\n  hostname h.example.com\n  user u\n  port 22\n",
        )
        .unwrap();
        let aliases = parse_ssh_config(&home);
        assert_eq!(aliases.len(), 1);
        assert_eq!(aliases[0].alias, "PROD");
        assert_eq!(aliases[0].hostname.as_deref(), Some("h.example.com"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn follows_includes_with_glob_and_caps() {
        let home = temporary_directory();
        let ssh_dir = home.join(".ssh");
        let confd = ssh_dir.join("config.d");
        std::fs::create_dir_all(&confd).unwrap();
        std::fs::write(
            ssh_dir.join("config"),
            "Host local\n  User me\nInclude config.d/*.conf\n",
        )
        .unwrap();
        std::fs::write(confd.join("10-a.conf"), "Host alpha\n  HostName a.example.com\n").unwrap();
        std::fs::write(confd.join("20-b.conf"), "Host beta\n").unwrap();
        std::fs::write(confd.join("ignored.txt"), "Host ghost\n").unwrap();

        let aliases = parse_ssh_config(&home);
        let names: Vec<&str> = aliases.iter().map(|alias| alias.alias.as_str()).collect();
        assert!(names.contains(&"local"));
        assert!(names.contains(&"alpha"));
        assert!(names.contains(&"beta"));
        // glob 模式之外（.txt）不参与解析——Include 只按用户声明的模式展开。
        assert!(!names.contains(&"ghost"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn missing_config_yields_empty_list() {
        let home = temporary_directory();
        assert!(parse_ssh_config(&home).is_empty());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn validates_host_references() {
        assert!(validate_host_reference("prod").is_ok());
        // 首尾空白被规整，内部空白拒绝（destination 是单个 argv 元素）。
        assert!(validate_host_reference("  prod ").is_ok());
        assert_eq!(validate_host_reference("  prod ").unwrap(), "prod");
        assert!(validate_host_reference("has space").is_err());
        assert!(validate_host_reference("-oProxyCommand=x").is_err());
        assert!(validate_host_reference("").is_err());
        assert!(validate_host_reference(&"x".repeat(MAX_HOST_REF_CHARS + 1)).is_err());
    }

    #[test]
    fn socket_keys_stable_per_target() {
        assert_eq!(
            agent_socket_key("amu@10.0.0.1", Some(2222)),
            agent_socket_key("amu@10.0.0.1", Some(2222))
        );
        assert_ne!(
            agent_socket_key("amu@10.0.0.1", Some(2222)),
            agent_socket_key("amu@10.0.0.1", Some(22))
        );
        assert_eq!(agent_socket_key("prod", None).len(), 16);
    }

    #[test]
    fn builds_exec_args_with_batchmode_controlpersist_and_guard() {
        let socket = Path::new("/home/.axiom/ssh/cm-agent-0123456789abcdef.sock");
        let key_target = AgentSshTarget {
            destination: "prod".into(),
            port: None,
            batch_mode: true,
            password: None,
            private_key_path: None,
        };
        let args = build_agent_exec_args(socket, &key_target, "ls -la");
        let joined = args.join(" ");
        assert!(joined.contains("ControlMaster=auto"));
        assert!(joined.contains("ControlPersist=10m"));
        assert!(joined.contains("ConnectTimeout=10"));
        assert!(joined.contains("StrictHostKeyChecking=accept-new"));
        assert!(joined.contains("BatchMode=yes"));
        assert!(!args.contains(&"-p".to_string())); // config 主机端口由 ssh 解析
        let destination_index = args.iter().position(|arg| arg == "prod").unwrap();
        assert_eq!(args[destination_index - 1], "--");
        assert_eq!(args.last().unwrap(), "ls -la");

        let password_target = AgentSshTarget {
            destination: "amu@10.0.0.1".into(),
            port: Some(2222),
            batch_mode: false,
            password: Some("pw".into()),
            private_key_path: None,
        };
        let args = build_agent_exec_args(socket, &password_target, "uptime");
        assert!(!args.join(" ").contains("BatchMode"));
        let port_index = args.iter().position(|arg| arg == "-p").unwrap();
        assert_eq!(args[port_index + 1], "2222");
        assert!(args.contains(&"amu@10.0.0.1".to_string()));
    }

    #[test]
    fn session_grants_track_and_revoke() {
        let state = SshAgentState::default();
        assert!(!state.grant_exists("s1", "prod"));
        state.insert_grant("s1", "prod");
        assert!(state.grant_exists("s1", "prod"));
        // 授权按会话隔离。
        assert!(!state.grant_exists("s2", "prod"));
        assert_eq!(state.grants_for_session("s1"), vec!["prod".to_string()]);
        state.revoke_session("s1");
        assert!(!state.grant_exists("s1", "prod"));
        assert!(state.grants_for_session("s1").is_empty());
    }

    #[test]
    fn validates_agent_session_ids() {
        assert!(validate_agent_session_id("sess-123").is_ok());
        assert!(validate_agent_session_id("").is_err());
        assert!(validate_agent_session_id("has space").is_err());
        assert!(validate_agent_session_id(&"x".repeat(161)).is_err());
    }

    #[test]
    fn askpass_script_written_owner_only_and_idempotent() {
        use std::os::unix::fs::PermissionsExt;
        let home = temporary_directory();
        let script = ensure_agent_askpass_script(&home).unwrap();
        let mode = std::fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let body = std::fs::read_to_string(&script).unwrap();
        assert!(body.contains("AXIOM_SSH_PASSWORD"));
        // 二次调用复用同一份。
        assert_eq!(ensure_agent_askpass_script(&home).unwrap(), script);
        std::fs::remove_dir_all(&home).unwrap();
    }
}
