//! SSH 会话引擎（P1）：按主机拉起 `ssh -tt` PTY 交互终端并托管其生命周期。
//!
//! SSH 终端与本地终端是同一信任级——用户亲手操作的交互通道：继承宿主完整
//! 环境（agent 转发、用户 ssh 配置按预期生效），不经 seatbelt、不消费审批；
//! stdin 与本地终端共用原生 keyDown 单次消费手势门（受陷渲染进程无法伪造
//! 原生按键，无法批量注入远程命令）。渲染进程只能指定已登记主机的 hostId，
//! 主机名/端口/用户名一律取自 Rust 注册表——受陷渲染进程无法对任意目标
//! 发起连接。凭据不经本层落盘：密码提示内嵌在终端交互里（用户自己的
//! known_hosts 与 ssh 配置生效，`accept-new` 只免确认首连、不放宽变更检测）。
//!
//! 会话模型：每主机至多一个活跃会话（设计稿 HostBar 按主机切换），hostId
//! 即会话键。断开 = 进程组 SIGTERM → 宽限 → SIGKILL（复用本地终端时序）；
//! 应用退出同步 reap（macOS 关窗走 Cocoa 终止路径，drop 不可靠，见 lib.rs）。

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::ssh::{validate_host_input, SshCommandResponse};
use crate::terminal::{
    consume_stdin_gesture, signal_process_group, spawn_stdin_writer, TerminalGestureState,
    USER_GESTURE_WINDOW,
};

const SSH_EVENT: &str = "axiom:ssh-event";
const READ_BUFFER_BYTES: usize = 8 * 1024;
const TERMINATION_GRACE_MS: u64 = 500;
/// 终端 stdin 单次写入上限：与本地终端同一纵深防御（手势门承担真正的输入
/// 来源校验），放宽后支持粘贴大段文本。
const MAX_SSH_STDIN_BYTES: usize = 4 * 1024 * 1024;
/// 连接超时与 keepalive：ServerAlive 三次无响应（约 45s）判定断线，进程
/// 退出 → Closed 事件 → 前端状态回落为「已断开」。
const CONNECT_TIMEOUT_SECONDS: u32 = 10;
const KEEPALIVE_INTERVAL_SECONDS: u32 = 15;
const KEEPALIVE_COUNT_MAX: u32 = 3;
/// 上传流式写入的块大小与进度事件节流间隔。
const UPLOAD_CHUNK_BYTES: usize = 256 * 1024;
const UPLOAD_PROGRESS_INTERVAL_BYTES: usize = 1024 * 1024;
/// 单文件上传大小上限：`cat >` 无断点续传，超限引导用户走 scp 等通道。
const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 远端文件名上限（常见文件系统的 NAME_MAX 语义）。
const MAX_REMOTE_NAME_BYTES: usize = 255;
const SSH_UPLOAD_EVENT: &str = "axiom:ssh-upload-event";

/// 托管中的 SSH 会话：PTY 主端 + stdin 投递口 + 杀止信号（镜像 terminal.rs 形态）。
struct SshSession {
    master: Box<dyn MasterPty + Send>,
    /// stdin 投递口（专用写线程消费，见 terminal::spawn_stdin_writer）：send
    /// 永不阻塞，tokio worker 上没有可阻塞的 write_all，signal_close 也永不被
    /// 在途写卡住。
    writer: StdMutex<std::sync::mpsc::Sender<Vec<u8>>>,
    kill: tokio::sync::watch::Sender<bool>,
    process_id: Option<u32>,
    /// 密码会话的 askpass 助手脚本：会话结束即删除（含明文传递面的最小化）。
    askpass_script: Option<PathBuf>,
}

/// 在途上传句柄：取消信号 + 传输子进程 PID（取消时强杀）。
pub(crate) struct SshUploadHandle {
    pub cancel: Arc<AtomicBool>,
    pub pid: Arc<StdMutex<Option<u32>>>,
}

/// 中断（失败/取消）上传的续传材料：本地路径留在 Rust 侧，渲染进程不可见。
/// `remote_target` 是原上传的完整远端写入目标（`~` 相对或绝对路径）——
/// 续传探测/追加必须打回原位，裸文件名会把非 `~` 目录上传续传到 `~` 根。
#[derive(Clone)]
pub(crate) struct InterruptedUpload {
    pub local_path: PathBuf,
    pub name: String,
    pub remote_target: String,
}

/// 远程目录条目（SFTP 文件浏览器，对应 `ls`/`stat` 摄取）。序列化镜像
/// `sshSession.ts` 的 `RemoteDirEntry`（serde camelCase）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDirEntry {
    pub name: String,
    pub size_bytes: u64,
    pub is_dir: bool,
    /// 符号权限模式（`drwxr-xr-x`）。
    pub perms: String,
    /// 修改时间的可读展示串（远端 `stat` 输出，未做本地时区换算）。
    pub modified_at: String,
}

#[derive(Default)]
pub(crate) struct SshSessionState {
    sessions: StdMutex<HashMap<String, SshSession>>,
    /// 进行中的上传（hostId → 句柄）：同一主机串行化，防并发 `cat >` 写坏
    /// 同一远端文件。
    uploads: StdMutex<HashMap<String, SshUploadHandle>>,
    /// 可续传的中断上传（hostId → 材料）。
    interrupted: StdMutex<HashMap<String, InterruptedUpload>>,
}

impl SshSessionState {
    fn is_alive(&self, host_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|sessions| sessions.contains_key(host_id))
            .unwrap_or(false)
    }

    fn remove(&self, host_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.remove(host_id) {
                if let Some(script) = &session.askpass_script {
                    let _ = std::fs::remove_file(script);
                }
            }
        }
    }

    /// 活跃会话清单（Hosts 面板状态列与终端 HostBar 恢复用）。
    fn alive_host_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .map(|sessions| sessions.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 登记新上传：同主机已有上传在途时拒绝（串行化）。
    fn mark_upload_started(
        &self,
        host_id: &str,
        cancel: Arc<AtomicBool>,
        pid: Arc<StdMutex<Option<u32>>>,
    ) -> Result<(), String> {
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "SSH 上传状态锁已中毒".to_string())?;
        if uploads.contains_key(host_id) {
            return Err("该主机已有上传在进行".into());
        }
        uploads.insert(host_id.to_string(), SshUploadHandle { cancel, pid });
        Ok(())
    }

    fn has_upload(&self, host_id: &str) -> bool {
        self.uploads
            .lock()
            .map(|uploads| uploads.contains_key(host_id))
            .unwrap_or(false)
    }

    fn mark_upload_finished(&self, host_id: &str) {
        if let Ok(mut uploads) = self.uploads.lock() {
            uploads.remove(host_id);
        }
    }

    /// 取消在途上传：置取消位并强杀传输子进程（线程在块间感知后收尾）。
    fn cancel_upload(&self, host_id: &str) -> bool {
        let Ok(uploads) = self.uploads.lock() else {
            return false;
        };
        let Some(handle) = uploads.get(host_id) else {
            return false;
        };
        handle.cancel.store(true, Ordering::SeqCst);
        if let Ok(pid_slot) = handle.pid.lock() {
            if let Some(pid) = *pid_slot {
                let _ = signal_process_group(pid, libc::SIGKILL);
            }
        }
        true
    }

    /// 登记可续传的中断上传（覆盖旧记录）。
    fn mark_upload_interrupted(
        &self,
        host_id: &str,
        local_path: PathBuf,
        name: &str,
        remote_target: &str,
    ) {
        if let Ok(mut interrupted) = self.interrupted.lock() {
            interrupted.insert(
                host_id.to_string(),
                InterruptedUpload {
                    local_path,
                    name: name.to_string(),
                    remote_target: remote_target.to_string(),
                },
            );
        }
    }

    /// 取出中断上传（续传成功/主机删除后清除）。
    fn take_interrupted(&self, host_id: &str) -> Option<InterruptedUpload> {
        let mut interrupted = self.interrupted.lock().ok()?;
        interrupted.remove(host_id)
    }

    /// 主机删除时清掉其上传/中断记录（连接已由 signal_close 收尾）。
    pub(crate) fn forget_host(&self, host_id: &str) {
        self.cancel_upload(host_id);
        self.mark_upload_finished(host_id);
        if let Ok(mut interrupted) = self.interrupted.lock() {
            interrupted.remove(host_id);
        }
    }

    /// 发送杀止信号（SIGTERM 路径由事件任务收尾），返回是否有活跃会话被杀。
    /// 主机删除（ssh.rs DeleteHost）与前端断开共用同一收尾链路。
    pub(crate) fn signal_close(&self, host_id: &str) -> bool {
        let sessions = self.sessions.lock();
        if let Ok(sessions) = &sessions {
            if let Some(session) = sessions.get(host_id) {
                let _ = session.kill.send(true);
                return true;
            }
        }
        false
    }

    /// 应用退出前的同步兜底回收：跳过宽限直接 SIGKILL 进程组，并删除残留
    /// 的 askpass 助手脚本。
    pub(crate) fn reap_for_exit(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for (_, session) in sessions.drain() {
            if let Some(process_id) = session.process_id {
                let _ = signal_process_group(process_id, 9);
            }
            if let Some(script) = &session.askpass_script {
                let _ = std::fs::remove_file(script);
            }
        }
    }
}

/// hostId 是本模块生成的 16 位 hex（sha256 前 8 字节），同时用作进程参数与
/// ControlPath 文件名——白名单校验杜绝路径/参数注入面。ssh_agent（Agent 通道）
/// 以此识别「注册表 hostId」形态的 exec 目标。
pub(crate) fn validate_host_id(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.len() == 16 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(value);
    }
    Err("SSH host ID 不合法".into())
}

fn control_socket_path(data_root: &Path, host_id: &str) -> PathBuf {
    data_root.join("ssh").join(format!("cm-{host_id}.sock"))
}

/// 组装 ssh 命令参数（纯函数，测试锁定语义）：
/// - `-tt` 强制远端 PTY（交互终端语义）；
/// - `ControlMaster=auto` + 无 ControlPersist：首个连接即 master，随终端退出
///   一并结束——不断开语义（P2 SFTP 复用同一 ControlPath 多路复用）；
/// - `StrictHostKeyChecking=accept-new`：首连自动信任（TOFU），已登记主机
///   密钥变更仍然拒绝——与手工 ssh 的安全语义一致，只省一次交互确认；
/// - ServerAlive 让断线在秒级体现在进程退出上，驱动状态列回落；
/// - destination 前的 `--` 终止选项解析：用户名/地址即便混入 `-` 前缀也只
///   会被当作目的地（与 validate_host_input 的 leading-dash 拒绝双保险）。
fn build_ssh_args(control_socket: &Path, host: &SshTarget) -> Vec<String> {
    let mut args = vec![
        "-tt".into(),
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={}", control_socket.display()),
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECONDS}"),
        "-o".into(),
        format!("ServerAliveInterval={KEEPALIVE_INTERVAL_SECONDS}"),
        "-o".into(),
        format!("ServerAliveCountMax={KEEPALIVE_COUNT_MAX}"),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
    ];
    // 显式私钥优先于 agent/默认密钥（ssh 对显式 -i 身份先行尝试）；不追加
    // IdentitiesOnly——保留 agent 与默认密钥兜底，行为是默认集合的纯增量。
    if let Some(key_path) = &host.private_key_path {
        args.push("-i".into());
        args.push(key_path.clone());
    }
    args.push("-p".into());
    args.push(host.port.to_string());
    // `--` 终止选项解析：用户名/地址即便混入 `-` 前缀也只
    // 会被当作目的地（与 validate_host_input 的 leading-dash 拒绝双保险）。
    args.push("--".into());
    args.push(format!("{}@{}", host.username, host.hostname));
    args
}

/// 按 PATH 逐项 X_OK 解析 `ssh` 的绝对路径，兜底系统自带 /usr/bin/ssh。
///
/// 不能把相对程序名交给 portable-pty：其 `search_path` 先把程序名与 HOME/cwd
/// 拼接且只查 `exists()`（不校验可执行）——用户主目录存在名为 `ssh` 的目录
/// （常见密钥目录 ~/ssh）时会命中目录本身，execvp 对目录返回 EACCES；又因
/// pre_exec 里的 `close_random_fds` 已把 std spawn 的 exec 错误上报管道一并
/// 关闭，子进程上报失败触发 std 的 `rtassert!(output.write(...))` abort——
/// 多线程进程 fork 出的子进程 pre-exec abort 表现为「SSH 连接导致整个 app
/// 崩溃」（崩溃报告 `*** multi-threaded process forked ***`）。显式解析出
/// X_OK 的绝对路径后两条都不再触发，失败只会是干净的 spawn 错误。
fn resolve_ssh_program() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(found) = find_ssh_on_path(std::env::split_paths(&path)) {
            return Ok(found);
        }
    }
    let system = PathBuf::from("/usr/bin/ssh");
    if is_executable_file(&system) {
        return Ok(system);
    }
    Err("未找到可执行的 ssh（PATH 与 /usr/bin/ssh 均无命中）".into())
}

/// 在给定目录序列里找第一个可执行的 `ssh`。空项（execvp 语义为 cwd）显式
/// 跳过：程序解析绝不回退到 cwd/HOME 拼接——那正是 ~/ssh 目录陷阱的来源。
fn find_ssh_on_path(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    for dir in paths {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join("ssh");
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// X_OK 语义的文件性检查：普通文件 + 任一执行位（目录/命名管道等一律不算
/// 可执行程序，与 execvp 能落地的对象一致）。
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// OpenSession 实际用于拉起连接的目标字段（自注册表条目防御性再校验后）。
struct SshTarget {
    hostname: String,
    port: u16,
    username: String,
    /// 注册表登记的私钥绝对路径（可选）：连接参数进 `-i` argv，注册表保存时
    /// 已校验，exec 前不再触碰文件内容（可用性由 ssh 自身报错呈现）。
    private_key_path: Option<String>,
}

impl From<&crate::ssh::SshHostEntry> for SshTarget {
    fn from(host: &crate::ssh::SshHostEntry) -> Self {
        Self {
            hostname: host.hostname.clone(),
            port: host.port,
            username: host.username.clone(),
            private_key_path: host.private_key_path.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshSessionEvent {
    host_id: String,
    /// PTY 输出字节（base64 编码，与本地终端 TerminalEvent 同款）：事件经
    /// JSON 序列化投递，数字数组形态每字节 ~4-5 字符，base64 约 ~1.37x。
    data: Option<String>,
    done: bool,
    exit_code: Option<i32>,
    error: Option<String>,
}

impl SshSessionEvent {
    fn data(host_id: &str, bytes: Vec<u8>) -> Self {
        Self {
            host_id: host_id.to_string(),
            data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            done: false,
            exit_code: None,
            error: None,
        }
    }

    fn done(host_id: &str, exit_code: Option<i32>) -> Self {
        Self {
            host_id: host_id.to_string(),
            data: None,
            done: true,
            exit_code,
            error: None,
        }
    }
}

/// 派发 OpenSession：校验 → 注册表解析目标 → PTY 拉起 ssh → 读线程 + 事件
/// 转发任务（时序镜像 terminal.rs spawn_terminal）。注册表读走
/// spawn_blocking（小文件 I/O 不占 tokio worker）。
async fn open_session(
    app: AppHandle,
    host_id: String,
    cols: u16,
    rows: u16,
) -> Result<SshCommandResponse, String> {
    let host_id = validate_host_id(&host_id)?.to_string();
    let cols = cols.max(1);
    let rows = rows.max(1);

    {
        let state = app.state::<SshSessionState>();
        if state.is_alive(&host_id) {
            // 幂等：HostBar 重复选择同一主机不重复拉起。
            return Ok(SshCommandResponse::Ack);
        }
    }

    let lookup_app = app.clone();
    let lookup_id = host_id.clone();
    let host = tauri::async_runtime::spawn_blocking(move || {
        crate::ssh::find_host(&lookup_app, &lookup_id)
    })
    .await
    .map_err(|error| format!("SSH 会话任务中断：{error}"))??;
    let host = host.ok_or_else(|| format!("主机不存在或已被删除（{host_id}）"))?;
    // 注册表内容在保存时已校验；此处防御性再校验一次（防注册表被手改后
    // 携带空白字符的主机名/相对路径私钥进入命令参数）。
    let _ = validate_host_input(&host.name, &host.hostname, host.port, &host.username)?;
    if let Some(key_path) = host.private_key_path.as_deref() {
        crate::ssh::validate_private_key_path(key_path)?;
    }
    let target = SshTarget::from(&host);

    let data_root = crate::storage_paths::axiom_data_root(&app)?;
    let control_socket = control_socket_path(&data_root, &host_id);

    // 已托管密码 → askpass 自动填充；脚本写失败等异常 fail-open 回退交互输入
    // （用户在终端里照常被提示输入，只是少了自动填充）。
    let mut askpass_password: Option<String> = None;
    if let Some(secret_id) = host.secret_id.as_deref() {
        let lookup_secret_app = app.clone();
        let secret_id = secret_id.to_string();
        let loaded = tauri::async_runtime::spawn_blocking(move || {
            read_ssh_password(&lookup_secret_app, &secret_id)
        })
        .await
        .map_err(|error| format!("SSH 会话任务中断：{error}"))??;
        if loaded.is_some() {
            askpass_password = loaded;
        }
    }
    let askpass_script = askpass_password
        .as_ref()
        .and_then(|_| write_askpass_script(&data_root, &host_id).ok());

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("打开 SSH 终端 PTY 失败：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("获取 SSH 终端写端失败：{error}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("获取 SSH 终端读端失败：{error}"))?;

    // 程序名显式解析为 X_OK 绝对路径（见 resolve_ssh_program）：相对名交给
    // portable-pty 会被 ~/ssh 这类与 HOME 同名的目录劫持，exec 失败叠加
    // pre_exec 关错管道会让子进程 pre-exec abort，表现为 app 崩溃。
    let mut command = CommandBuilder::new(resolve_ssh_program()?);
    command.args(build_ssh_args(&control_socket, &target));
    // 继承宿主完整环境（用户通道，与本地终端一致）：SSH_AUTH_SOCK 让 agent
    // 认证与转发按预期工作；仅补齐 PTY 必需的 TERM。
    command.env("TERM", "xterm-256color");
    if let (Some(script), Some(password)) = (&askpass_script, &askpass_password) {
        command.env("SSH_ASKPASS", script);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("DISPLAY", ":0");
        command.env("AXIOM_SSH_PASSWORD", password);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动 ssh 进程失败：{error}"))?;
    drop(pair.slave);
    let process_id = child.process_id();

    let (kill_tx, kill_rx) = tokio::sync::watch::channel(false);
    {
        let state = app.state::<SshSessionState>();
        let Ok(mut sessions) = state.sessions.lock() else {
            return Err("SSH 会话状态锁已中毒".into());
        };
        // 双检：并发 open 时后到者不覆盖既有会话（先到者已占用 hostId）。
        if sessions.contains_key(&host_id) {
            let _ = kill_tx.send(true);
            signal_process_group_or_pid(process_id);
            return Err("该主机已有活跃会话".into());
        }
        let (writer_sender, _writer_thread) = spawn_stdin_writer(writer);
        sessions.insert(
            host_id.clone(),
            SshSession {
                master: pair.master,
                writer: writer_sender,
                kill: kill_tx,
                process_id,
                askpass_script: askpass_script.clone(),
            },
        );
    }

    let (data_tx, data_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(count) => {
                    if data_tx.blocking_send(buffer[..count].to_vec()).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut kill_rx = kill_rx;
        let mut data_rx = data_rx;
        let mut child = child;
        let mut killed = false;
        loop {
            tokio::select! {
                changed = kill_rx.changed() => {
                    if changed.is_err() || *kill_rx.borrow() {
                        killed = true;
                        break;
                    }
                }
                signal = data_rx.recv() => {
                    match signal {
                        Some(bytes) => {
                            let _ = event_app.emit(SSH_EVENT, SshSessionEvent::data(&host_id, bytes));
                        }
                        None => break,
                    }
                }
            }
        }

        if killed {
            if let Some(process_id) = process_id {
                let _ = signal_process_group(process_id, libc::SIGTERM);
                tokio::time::sleep(Duration::from_millis(TERMINATION_GRACE_MS)).await;
                let _ = signal_process_group(process_id, libc::SIGKILL);
            }
        }

        let exit_code = match tauri::async_runtime::spawn_blocking(move || child.wait()).await {
            Ok(Ok(status)) if status.success() => Some(0),
            _ => None,
        };
        let _ = event_app.emit(SSH_EVENT, SshSessionEvent::done(&host_id, exit_code));
        // 注册表项移除 + ControlPath 残留 socket 清理（best effort）。
        if let Some(state) = event_app.try_state::<SshSessionState>() {
            state.remove(&host_id);
        }
        let _ = std::fs::remove_file(&control_socket);
        if let Some(script) = &askpass_script {
            let _ = std::fs::remove_file(script);
        }
    });

    Ok(SshCommandResponse::Ack)
}

/// 双检冲突时的自清理：spawn 出的 ssh 进程尚未注册，直接按 PID 杀进程组。
fn signal_process_group_or_pid(process_id: Option<u32>) {
    if let Some(process_id) = process_id {
        let _ = signal_process_group(process_id, libc::SIGKILL);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionInfo {
    pub host_id: String,
}

// ---------------------------------------------------------------------------
// 密码会话（P3）：secrets 托管密码 + SSH_ASKPASS 注入
// ---------------------------------------------------------------------------

/// askpass 助手脚本：OpenSSH 8.4+ 的 `SSH_ASKPASS_REQUIRE=force` 使密码读取
/// 固定走该脚本（即便有 TTY）。明文经环境变量交给 ssh 子进程（本机用户通道，
/// 与终端继承完整环境同一信任级），脚本文件不落明文。
const ASKPASS_SCRIPT_BODY: &str = "#!/bin/sh\nprintf '%s\\n' \"$AXIOM_SSH_PASSWORD\"\n";

fn askpass_script_path(data_root: &Path, host_id: &str) -> PathBuf {
    data_root.join("ssh").join(format!(".askpass-{host_id}.sh"))
}

fn write_askpass_script(data_root: &Path, host_id: &str) -> Result<PathBuf, String> {
    let path = askpass_script_path(data_root, host_id);
    let parent = path
        .parent()
        .ok_or_else(|| "askpass 脚本路径缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建 ssh 配置目录失败：{error}"))?;
    std::fs::write(&path, ASKPASS_SCRIPT_BODY)
        .map_err(|error| format!("写入 askpass 脚本失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("加固 askpass 脚本权限失败：{error}"))?;
    }
    Ok(path)
}

/// 读取已托管密码（keychain/DB 可能阻塞，调用方应置于 blocking 上下文）。
fn read_ssh_password(app: &AppHandle, secret_id: &str) -> Result<Option<String>, String> {
    let Some(state) = app.try_state::<crate::secrets::SecretState>() else {
        return Ok(None);
    };
    crate::secrets::load_ssh_secret(state.inner(), secret_id)
}

// ---------------------------------------------------------------------------
// 文件上传（P2）：原生选择器定路径 + ControlPath 复用流式写入
// ---------------------------------------------------------------------------

/// 远端写入命令：POSIX 单引号转义（`'` → `'\''`：闭引号 + 转义引号 + 开引号），
/// 文件名可含空格/中文/引号。不使用 sftp batch——OpenSSH sftp 的批处理对含
/// 空格路径没有可移植的引号方言；`ssh <host> "cat > 路径"` + stdin 流式写入
/// 既复用 ControlPath 已认证的主连接（密码会话免二次认证），又能拿到精确的
/// 字节进度。
/// POSIX 单引号转义路径：`'` → `'\''`（闭引号 + 转义引号 + 开引号）。返回
/// 不含外包裹单引号的内容，由调用方包进 `'...'`。
fn quote_remote_path(path: &str) -> String {
    path.replace('\'', "'\\''")
}

/// 校验远程目录路径（列目录/建目录/上传目标）：允许相对/绝对路径与 `~`，
/// 拒绝空、超长、控制字符/换行/NUL。
fn validate_remote_path(path: &str) -> Result<&str, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_REMOTE_NAME_BYTES {
        return Err("远程路径不合法".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("远程路径含非法字符".into());
    }
    Ok(trimmed)
}

/// 远端写入命令：目标为当前浏览目录。`~` 前缀不引号（保持 shell 展开），
/// 其余段落单引号转义；文件名可含空格/中文/引号（POSIX `'\''` 方言）。
fn remote_upload_command(file_name: &str, remote_dir: &str) -> String {
    let quoted = quote_remote_path(file_name);
    let dir = remote_dir.trim_end_matches('/');
    if dir == "~" {
        format!("cat > ~/'{quoted}'")
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("cat > ~/{}/'{}'", quote_remote_path(rest), quoted)
    } else {
        format!("cat > '{}/{quoted}'", quote_remote_path(dir))
    }
}

/// 远程路径渲染为单个 shell 词：`~`/`~/…` 前缀不引号（保持波浪号展开），
/// 其余整段单引号转义。波浪号一旦进引号就是字面量，任何 shell 都不展开
/// （列目录/建目录曾因 cd -- '~' 报 can't cd to ~）；与 remote_upload_command
/// / remote_write_command 对 `~` 前缀的既有约定一致。
fn remote_path_word(path: &str) -> String {
    if path == "~" {
        "~".to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("~/'{}'", quote_remote_path(rest))
    } else {
        format!("'{}'", quote_remote_path(path))
    }
}

/// 远端建目录命令（`mkdir -p`，父级不存在也成功）。
fn remote_mkdir_command(path: &str) -> String {
    format!("mkdir -p -- {}", remote_path_word(path))
}

/// 列出远程目录：`cd` 进目标路径后逐项输出
/// `name\x1fkind\x1fperms\x1fsize\x1fmtime\x1f` 每行一个。`\x1f` 以八进制
/// `\037` 交付（POSIX printf 可移植），规避文件名含空格/换行的解析歧义。
/// 权限/大小/时间优先 GNU `stat -c`，不可用（BSD/macOS 远端）回退 BSD
/// `stat -f`（mtime 以 `-t` 对齐 GNU `%y` 的可读格式）。cd 目标经
/// `remote_path_word`：`~`/`~/…` 前缀保持波浪号可展开。
///
/// 整段脚本经 `sh -c` 强制 POSIX shell 执行：sshd 用远端**登录 shell** 解释
/// 命令串，zsh（macOS 远端默认）在 glob 无匹配时直接报错退出、fish/csh
/// 连 for 语法都不兼容——不包裹则这些远端上列目录必然失败。
fn remote_list_command(path: &str) -> String {
    let script = format!(
        "cd -- {target} && \
         for e in .* *; do \
           [ \"$e\" = . ] && continue; \
           [ \"$e\" = .. ] && continue; \
           [ -e \"$e\" ] || [ -L \"$e\" ] || continue; \
           if [ -d \"$e\" ]; then t=d; else t=f; fi; \
           printf '%s\\037%s\\037%s\\037%s\\037%s\\037\\n' \
             \"$e\" \"$t\" \
             \"$(stat -c %A \"$e\" 2>/dev/null || stat -f %Sp \"$e\" 2>/dev/null)\" \
             \"$(stat -c %s \"$e\" 2>/dev/null || stat -f %z \"$e\" 2>/dev/null)\" \
             \"$(stat -c %y \"$e\" 2>/dev/null || stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' \"$e\" 2>/dev/null)\"; \
         done",
        target = remote_path_word(path),
    );
    // 内层脚本经 quote_remote_path 已含 `'\''` 序列，这里对整段再转义一层：
    // 外层 sh 解开后还原为内层脚本原文，由内层 sh 正确解析。
    format!("sh -c '{}'", quote_remote_path(&script))
}

/// 解析 `remote_list_command` 的 stdout（`\x1f` 分隔字段）成目录条目。
fn parse_ls_output(raw: &[u8]) -> Vec<RemoteDirEntry> {
    let text = String::from_utf8_lossy(raw);
    let mut entries = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\x1f');
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\x1f');
        let name = fields.next().unwrap_or("");
        let kind = fields.next().unwrap_or("");
        let perms = fields.next().unwrap_or("");
        let size = fields.next().unwrap_or("0");
        let mtime = fields.next().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        entries.push(RemoteDirEntry {
            name: name.to_string(),
            size_bytes: size.parse().unwrap_or(0),
            is_dir: kind == "d",
            perms: perms.to_string(),
            modified_at: mtime.to_string(),
        });
    }
    entries
}

/// 续传的远端探测/追加命令：先 `wc -c` 探远端实际字节数（不信任本地计数——
/// 失败瞬间管道里未落盘的字节可能已被远端接收），再以 `cat >>` 追加。
/// 入参是完整远端目标路径（原上传的 `cat >` 写入目标，`~` 相对或绝对——
/// 只收裸文件名会把非 `~` 目录与文件夹内文件的上传统统续传到 `~` 根）。
fn remote_probe_size_command(remote_target: &str) -> String {
    format!("wc -c < {}", remote_path_word(remote_target))
}

fn remote_append_command(remote_target: &str) -> String {
    format!("cat >> {}", remote_path_word(remote_target))
}

/// exec 通道（上传/探测）命令参数：与终端通道同一超时与保活约定——ControlPath
/// 指向的 master 已死时 ssh 会回退直连，无 ConnectTimeout 会挂到系统 TCP 超时
/// （分钟级），把 resumeUpload 的前端 promise 一起拖住。`--` 与终端通道同理。
fn build_exec_args(control_socket: &Path, host: &SshTarget, remote_command: &str) -> Vec<String> {
    vec![
        "-o".into(),
        format!("ControlPath={}", control_socket.display()),
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECONDS}"),
        "-o".into(),
        format!("ServerAliveInterval={KEEPALIVE_INTERVAL_SECONDS}"),
        "-o".into(),
        format!("ServerAliveCountMax={KEEPALIVE_COUNT_MAX}"),
        "-p".into(),
        host.port.to_string(),
        "--".into(),
        format!("{}@{}", host.username, host.hostname),
        remote_command.to_string(),
    ]
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum SshUploadEvent {
    Start {
        host_id: String,
        name: String,
        total_bytes: u64,
    },
    Progress {
        host_id: String,
        name: String,
        transferred_bytes: u64,
        total_bytes: u64,
    },
    Done {
        host_id: String,
        name: String,
    },
    Cancelled {
        host_id: String,
        name: String,
    },
    Failed {
        host_id: String,
        name: String,
        error: String,
    },
}

/// 校验远端文件名：来自本地 `file_name()`，防御性再限定——拒绝路径分隔符与
/// 控制字符混入远端 shell 面。
fn validate_remote_name(file_name: &str) -> Result<&str, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_REMOTE_NAME_BYTES
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err("文件名不合法".into());
    }
    Ok(trimmed)
}

/// 上传动作：原生文件选择器（路径来源不可由渲染进程指定，堵住任意本地文件
/// 读取面）→ 复用 ControlPath 主连接流式写入远端家目录 → 事件回报进度。
async fn upload_file(app: AppHandle, host_id: String, remote_dir: String) -> Result<SshCommandResponse, String> {
    use tauri_plugin_dialog::DialogExt;

    let host_id = validate_host_id(&host_id)?.to_string();
    let remote_dir = validate_remote_path(&remote_dir)?.to_string();
    let state = app.state::<SshSessionState>();
    if !state.is_alive(&host_id) {
        return Err("SSH 会话未激活，无法上传".into());
    }
    if state.has_upload(&host_id) {
        return Err("该主机已有上传在进行".into());
    }

    // 目标字段照例取自注册表（与 open_session 同一防御边界）。
    let lookup_app = app.clone();
    let lookup_id = host_id.clone();
    let host = tauri::async_runtime::spawn_blocking(move || {
        crate::ssh::find_host(&lookup_app, &lookup_id)
    })
    .await
    .map_err(|error| format!("SSH 上传任务中断：{error}"))??;
    let host = host.ok_or_else(|| format!("主机不存在或已被删除（{host_id}）"))?;
    let _ = validate_host_input(&host.name, &host.hostname, host.port, &host.username)?;
    let target = SshTarget::from(&host);

    // 非阻塞 pick_file + oneshot 等待（对齐 pick_and_authorize_workspace 的
    // macOS 范式；blocking_pick_folder 会卡主线程）。
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择要上传的文件")
        .pick_file(move |file| {
            let _ = sender.send(file);
        });
    let picked = receiver
        .await
        .map_err(|_| "文件选择器意外关闭".to_string())?;
    let Some(picked) = picked else {
        // 用户取消：静默返回，不产生任何事件（前端按钮回到空闲态）。
        return Ok(SshCommandResponse::Ack);
    };
    let local_path = picked
        .into_path()
        .map_err(|error| format!("无法解析所选文件路径：{error}"))?;

    // 选择期间会话可能已退出：写前再检一次。
    if !state.is_alive(&host_id) {
        return Err("SSH 会话未激活，无法上传".into());
    }

    let metadata = std::fs::metadata(&local_path)
        .map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是常规文件".into());
    }
    let total_bytes = metadata.len();
    if total_bytes > MAX_UPLOAD_BYTES {
        return Err(format!(
            "文件超出上传上限（{} MiB）",
            MAX_UPLOAD_BYTES / 1024 / 1024
        ));
    }
    let raw_name = local_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "无法确定文件名".to_string())?;
    let name = validate_remote_name(&raw_name)?.to_string();

    // 同主机并发守卫（对话框期间可能已有另一上传开始）。
    let cancel = Arc::new(AtomicBool::new(false));
    let pid_slot: Arc<StdMutex<Option<u32>>> = Arc::new(StdMutex::new(None));
    state.mark_upload_started(&host_id, Arc::clone(&cancel), Arc::clone(&pid_slot))?;

    let control_socket = control_socket_path(&crate::storage_paths::axiom_data_root(&app)?, &host_id);
    let remote_command = remote_upload_command(&name, &remote_dir);
    let args = build_exec_args(&control_socket, &target, &remote_command);
    // 续传材料登记完整远端目标：失败/取消后探测与追加必须打回原位。
    let remote_target = join_remote(&remote_dir, &name);
    let _ = app.emit(
        SSH_UPLOAD_EVENT,
        SshUploadEvent::Start {
            host_id: host_id.clone(),
            name: name.clone(),
            total_bytes,
        },
    );

    std::thread::spawn(move || {
        let outcome = run_upload(UploadContext {
            local_path: &local_path,
            args: &args,
            app: &app,
            host_id: &host_id,
            name: &name,
            total_bytes,
            cancel: &cancel,
            pid_slot: &pid_slot,
            start_offset: 0,
        });
        if let Some(state) = app.try_state::<SshSessionState>() {
            state.mark_upload_finished(&host_id);
            match &outcome {
                Ok(UploadOutcome::Completed) => {
                    state.take_interrupted(&host_id);
                }
                // 失败/取消都保留续传材料（本地路径 + 文件名 + 远端目标）。
                Ok(UploadOutcome::Cancelled) | Ok(UploadOutcome::Failed(_)) | Err(_) => {
                    state.mark_upload_interrupted(&host_id, local_path.clone(), &name, &remote_target);
                }
            }
        }
        let event = match outcome {
            Ok(UploadOutcome::Completed) => SshUploadEvent::Done {
                host_id,
                name,
            },
            Ok(UploadOutcome::Cancelled) => SshUploadEvent::Cancelled {
                host_id,
                name,
            },
            // run_upload 把 Failed 归一为 Err 返回，此处不可达。
            Ok(UploadOutcome::Failed(_)) => unreachable!("Failed is normalized to Err"),
            Err(error) => SshUploadEvent::Failed {
                host_id,
                name,
                error,
            },
        };
        let _ = app.emit(SSH_UPLOAD_EVENT, event);
    });

    Ok(SshCommandResponse::Ack)
}

/// 续传动作：远端实际字节数为起点（`wc -c` 探测），本地 seek 到同偏移后
/// `cat >>` 追加。本地文件比远端还小（已被替换）时拒绝，防止续传出坏文件。
async fn resume_upload(app: AppHandle, host_id: String) -> Result<SshCommandResponse, String> {
    let host_id = validate_host_id(&host_id)?.to_string();
    let state = app.state::<SshSessionState>();
    if !state.is_alive(&host_id) {
        return Err("SSH 会话未激活，无法续传".into());
    }
    let Some(interrupted) = state.take_interrupted(&host_id) else {
        return Err("没有可续传的上传".into());
    };
    // 立刻放回（后续守卫失败时材料不丢）。
    let name = interrupted.name.clone();
    let remote_target = interrupted.remote_target.clone();
    state.mark_upload_interrupted(
        &host_id,
        interrupted.local_path.clone(),
        &name,
        &remote_target,
    );

    if state.has_upload(&host_id) {
        return Err("该主机已有上传在进行".into());
    }

    let lookup_app = app.clone();
    let lookup_id = host_id.clone();
    let host = tauri::async_runtime::spawn_blocking(move || {
        crate::ssh::find_host(&lookup_app, &lookup_id)
    })
    .await
    .map_err(|error| format!("SSH 续传任务中断：{error}"))??;
    let host = host.ok_or_else(|| format!("主机不存在或已被删除（{host_id}）"))?;
    let _ = validate_host_input(&host.name, &host.hostname, host.port, &host.username)?;
    let target = SshTarget::from(&host);

    let local_metadata = std::fs::metadata(&interrupted.local_path)
        .map_err(|error| format!("本地文件已不可读：{error}"))?;

    let control_socket = control_socket_path(&crate::storage_paths::axiom_data_root(&app)?, &host_id);
    // 探测远端实际字节数。同步子进程等待必须离开 tokio worker（master 半死时
    // 回退直连要等满 ConnectTimeout），与注册表读同一 spawn_blocking 范式。
    let probe_args = build_exec_args(
        &control_socket,
        &target,
        &remote_probe_size_command(&remote_target),
    );
    let remote_offset = {
        let output = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("ssh")
                .args(&probe_args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
        })
        .await
        .map_err(|error| format!("SSH 续传任务中断：{error}"))?
        .map_err(|error| format!("探测远端文件大小失败：{error}"))?;
        if !output.status.success() {
            return Err("探测远端文件大小失败（连接可能已断开）".into());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout
            .trim()
            .parse::<u64>()
            .map_err(|_| "远端文件大小响应无法解析".to_string())?
    };
    if remote_offset > local_metadata.len() {
        return Err("本地文件与远端不一致，无法续传".into());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let pid_slot: Arc<StdMutex<Option<u32>>> = Arc::new(StdMutex::new(None));
    state.mark_upload_started(&host_id, Arc::clone(&cancel), Arc::clone(&pid_slot))?;

    let append_args = build_exec_args(&control_socket, &target, &remote_append_command(&remote_target));
    let _ = app.emit(
        SSH_UPLOAD_EVENT,
        SshUploadEvent::Start {
            host_id: host_id.clone(),
            name: name.clone(),
            total_bytes: local_metadata.len(),
        },
    );
    if remote_offset > 0 {
        let _ = app.emit(
            SSH_UPLOAD_EVENT,
            SshUploadEvent::Progress {
                host_id: host_id.clone(),
                name: name.clone(),
                transferred_bytes: remote_offset,
                total_bytes: local_metadata.len(),
            },
        );
    }

    std::thread::spawn(move || {
        let outcome = run_upload(UploadContext {
            local_path: &interrupted.local_path,
            args: &append_args,
            app: &app,
            host_id: &host_id,
            name: &name,
            total_bytes: local_metadata.len(),
            cancel: &cancel,
            pid_slot: &pid_slot,
            start_offset: remote_offset,
        });
        if let Some(state) = app.try_state::<SshSessionState>() {
            state.mark_upload_finished(&host_id);
            match &outcome {
                Ok(UploadOutcome::Completed) => {
                    state.take_interrupted(&host_id);
                }
                // 失败/取消都保留续传材料（沿用原上传的远端目标，打回原位）。
                Ok(UploadOutcome::Cancelled) | Ok(UploadOutcome::Failed(_)) | Err(_) => {
                    state.mark_upload_interrupted(&host_id, interrupted.local_path.clone(), &name, &interrupted.remote_target);
                }
            }
        }
        let event = match outcome {
            Ok(UploadOutcome::Completed) => SshUploadEvent::Done {
                host_id,
                name,
            },
            Ok(UploadOutcome::Cancelled) => SshUploadEvent::Cancelled {
                host_id,
                name,
            },
            // run_upload 把 Failed 归一为 Err 返回，此处不可达。
            Ok(UploadOutcome::Failed(_)) => unreachable!("Failed is normalized to Err"),
            Err(error) => SshUploadEvent::Failed {
                host_id,
                name,
                error,
            },
        };
        let _ = app.emit(SSH_UPLOAD_EVENT, event);
    });

    Ok(SshCommandResponse::Ack)
}

/// 上传结果：完成 / 用户取消 / 失败（含原因）。
enum UploadOutcome {
    Completed,
    Cancelled,
    Failed(String),
}

/// 流式上传执行体（独立线程；写端按块推进并在每 1 MiB 边界发进度事件）。
/// `start_offset > 0` 时本地先 seek 到该偏移（配合远端 `cat >>` 续传）；块间
/// 检查取消位，置位即杀子进程收尾。
/// 上传执行上下文（聚合参数，避免 9 参函数）。
struct UploadContext<'a> {
    local_path: &'a Path,
    args: &'a [String],
    app: &'a AppHandle,
    host_id: &'a str,
    name: &'a str,
    total_bytes: u64,
    cancel: &'a AtomicBool,
    pid_slot: &'a StdMutex<Option<u32>>,
    start_offset: u64,
}

fn run_upload(context: UploadContext<'_>) -> Result<UploadOutcome, String> {
    let UploadContext {
        local_path,
        args,
        app,
        host_id,
        name,
        total_bytes,
        cancel,
        pid_slot,
        start_offset,
    } = context;
    use std::process::{Command, Stdio};

    let mut command = Command::new("ssh");
    // 继承宿主环境（用户通道）；数据面无 shell 参与，remote_command 作为
    // 单个参数交付远端默认 shell。
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 ssh 传输进程失败：{error}"))?;
    if let Ok(mut slot) = pid_slot.lock() {
        *slot = Some(child.id());
    }
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法接通上传写端".to_string())?;

    let mut file = std::fs::File::open(local_path)
        .map_err(|error| format!("打开本地文件失败：{error}"))?;
    if start_offset > 0 {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(start_offset))
            .map_err(|error| format!("定位续传偏移失败：{error}"))?;
    }
    let mut buffer = vec![0_u8; UPLOAD_CHUNK_BYTES];
    let mut transferred: u64 = start_offset;
    let mut last_reported: u64 = start_offset;
    let outcome = loop {
        if cancel.load(Ordering::SeqCst) {
            break UploadOutcome::Cancelled;
        }
        let read = match file.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => break UploadOutcome::Failed(format!("读取本地文件失败：{error}")),
        };
        if read == 0 {
            break UploadOutcome::Completed;
        }
        if let Err(error) = stdin.write_all(&buffer[..read]) {
            if cancel.load(Ordering::SeqCst) {
                break UploadOutcome::Cancelled;
            }
            break UploadOutcome::Failed(format!(
                "写入远端失败（连接可能已断开）：{error}"
            ));
        }
        transferred += read as u64;
        if transferred - last_reported >= UPLOAD_PROGRESS_INTERVAL_BYTES as u64 {
            last_reported = transferred;
            let _ = app.emit(
                SSH_UPLOAD_EVENT,
                SshUploadEvent::Progress {
                    host_id: host_id.to_string(),
                    name: name.to_string(),
                    transferred_bytes: transferred,
                    total_bytes,
                },
            );
        }
    };

    drop(stdin);
    // 子进程收尾：正常/取消都要回收；取消时上面已由 cancel_upload 强杀过，
    // wait 依旧幂等安全。
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return if matches!(outcome, UploadOutcome::Cancelled) {
                Ok(UploadOutcome::Cancelled)
            } else {
                Err(format!("等待远端写入完成失败：{error}"))
            }
        }
    };

    match outcome {
        UploadOutcome::Completed if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            Err(format!(
                "远端写入失败（退出码 {:?}）{}",
                output.status.code(),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("：{detail}")
                }
            ))
        }
        UploadOutcome::Completed => Ok(UploadOutcome::Completed),
        UploadOutcome::Cancelled => Ok(UploadOutcome::Cancelled),
        UploadOutcome::Failed(error) => Err(error),
    }
}

/// 会话动作统一入口（由 ssh.rs 的 ssh_command 分发调用）。
pub(crate) async fn dispatch_session_action(
    app: AppHandle,
    action: SshSessionAction,
) -> Result<SshCommandResponse, String> {
    match action {
        SshSessionAction::Open { host_id, cols, rows } => {
            open_session(app, host_id, cols, rows).await
        }
        SshSessionAction::Write { host_id, data } => {
            let host_id = validate_host_id(&host_id)?;
            if data.len() > MAX_SSH_STDIN_BYTES {
                return Err("SSH 终端写入超出安全上限".into());
            }
            // 与本地终端同一手势门：每次写入消费一个「终端聚焦时的原生
            // keyDown」配额（单次消费、2s 时效），写入总量被真实按键所限。
            let gesture = app.state::<std::sync::Arc<TerminalGestureState>>();
            consume_stdin_gesture(gesture.inner(), USER_GESTURE_WINDOW)?;
            let state = app.state::<SshSessionState>();
            let sessions = state
                .sessions
                .lock()
                .map_err(|_| "SSH 会话状态锁已中毒".to_string())?;
            let session = sessions
                .get(host_id)
                .ok_or_else(|| "SSH 会话未激活".to_string())?;
            let writer = session
                .writer
                .lock()
                .map_err(|_| "SSH 终端写端锁已中毒".to_string())?;
            // 投递而非直写（无界通道 send 永不阻塞）：阻塞面隔离在专用写线程，
            // tokio worker 与 signal_close 收尾链路不被停滞的 PTY 写卡住。
            writer
                .send(data.into_bytes())
                .map_err(|error| format!("投递 SSH 终端输入失败：{error}"))?;
            Ok(SshCommandResponse::Ack)
        }
        SshSessionAction::Resize { host_id, cols, rows } => {
            let host_id = validate_host_id(&host_id)?;
            let state = app.state::<SshSessionState>();
            let sessions = state
                .sessions
                .lock()
                .map_err(|_| "SSH 会话状态锁已中毒".to_string())?;
            let session = sessions
                .get(host_id)
                .ok_or_else(|| "SSH 会话未激活".to_string())?;
            session
                .master
                .resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("调整 SSH 终端尺寸失败：{error}"))?;
            Ok(SshCommandResponse::Ack)
        }
        SshSessionAction::Close { host_id } => {
            let host_id = validate_host_id(&host_id)?;
            let state = app.state::<SshSessionState>();
            // 有会话则发起杀止（收尾在事件任务：宽限 → SIGKILL → Closed 事件
            // → 移除注册项）；无会话幂等成功。
            state.signal_close(host_id);
            Ok(SshCommandResponse::Ack)
        }
        SshSessionAction::Upload { host_id, remote_dir } => {
            upload_file(app, host_id, remote_dir).await
        }
        SshSessionAction::Resume { host_id } => resume_upload(app, host_id).await,
        SshSessionAction::Cancel { host_id } => {
            let host_id = validate_host_id(&host_id)?;
            let state = app.state::<SshSessionState>();
            state.cancel_upload(host_id);
            Ok(SshCommandResponse::Ack)
        }
        SshSessionAction::ListFiles { host_id, path } => list_files(app, host_id, path).await,
        SshSessionAction::MakeDir { host_id, path } => make_dir(app, host_id, path).await,
        SshSessionAction::UploadFolder { host_id, remote_dir } => {
            upload_folder(app, host_id, remote_dir).await
        }
        SshSessionAction::List => {
            let state = app.state::<SshSessionState>();
            Ok(SshCommandResponse::Sessions {
                sessions: state
                    .alive_host_ids()
                    .into_iter()
                    .map(|host_id| SshSessionInfo { host_id })
                    .collect(),
            })
        }
    }
}

/// 列出远程目录（SFTP 文件浏览器）。复用 ControlPath 主连接 + `ssh <host> <cmd>`
/// 一次性质 exec（与上传探测同模板 L884-904），同步回传目录条目，无需新事件通道。
async fn list_files(
    app: AppHandle,
    host_id: String,
    path: String,
) -> Result<SshCommandResponse, String> {
    let host_id = validate_host_id(&host_id)?.to_string();
    let path_checked = validate_remote_path(&path)?.to_string();

    let lookup_app = app.clone();
    let lookup_id = host_id.clone();
    let host = tauri::async_runtime::spawn_blocking(move || {
        crate::ssh::find_host(&lookup_app, &lookup_id)
    })
    .await
    .map_err(|error| format!("SSH 列目录任务中断：{error}"))??;
    let host = host.ok_or_else(|| format!("主机不存在或已被删除（{host_id}）"))?;
    let _ = validate_host_input(&host.name, &host.hostname, host.port, &host.username)?;
    let target = SshTarget::from(&host);

    let control_socket =
        control_socket_path(&crate::storage_paths::axiom_data_root(&app)?, &host_id);
    let list_args = build_exec_args(&control_socket, &target, &remote_list_command(&path_checked));
    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("ssh")
            .args(&list_args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
    })
    .await
    .map_err(|error| format!("SSH 列目录任务中断：{error}"))?
    .map_err(|error| format!("列出远程目录失败：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "列出远程目录失败".to_string()
        } else {
            format!("列出远程目录失败：{detail}")
        });
    }
    Ok(SshCommandResponse::Files {
        host_id,
        path: path_checked,
        entries: parse_ls_output(&output.stdout),
        truncated: false,
    })
}

/// 创建远程目录（`mkdir -p`，父级不存在也成功）。
async fn make_dir(
    app: AppHandle,
    host_id: String,
    path: String,
) -> Result<SshCommandResponse, String> {
    let host_id = validate_host_id(&host_id)?.to_string();
    let path_checked = validate_remote_path(&path)?.to_string();

    let lookup_app = app.clone();
    let lookup_id = host_id.clone();
    let host = tauri::async_runtime::spawn_blocking(move || {
        crate::ssh::find_host(&lookup_app, &lookup_id)
    })
    .await
    .map_err(|error| format!("SSH 建目录任务中断：{error}"))??;
    let host = host.ok_or_else(|| format!("主机不存在或已被删除（{host_id}）"))?;
    let _ = validate_host_input(&host.name, &host.hostname, host.port, &host.username)?;
    let target = SshTarget::from(&host);

    let control_socket =
        control_socket_path(&crate::storage_paths::axiom_data_root(&app)?, &host_id);
    let mkdir_args = build_exec_args(&control_socket, &target, &remote_mkdir_command(&path_checked));
    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("ssh")
            .args(&mkdir_args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
    })
    .await
    .map_err(|error| format!("SSH 建目录任务中断：{error}"))?
    .map_err(|error| format!("创建远程目录失败：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "创建远程目录失败".to_string()
        } else {
            format!("创建远程目录失败：{detail}")
        });
    }
    Ok(SshCommandResponse::Ack)
}

/// 拼接远程目标路径（保留 `~` 前缀，保持 shell 展开）。
fn join_remote(dir: &str, rel: &str) -> String {
    let dir = dir.trim_end_matches('/');
    if dir == "~" {
        format!("~/{rel}")
    } else {
        format!("{dir}/{rel}")
    }
}

/// 远端写命令（给定完整目标路径，含父子目录）：`~` 前缀不引号（保持展开），
/// 其余段落单引号转义。
fn remote_write_command(full_target: &str) -> String {
    let target = full_target.trim_end_matches('/');
    if target == "~" {
        "cat > ~".to_string()
    } else if let Some(rest) = target.strip_prefix("~/") {
        format!("cat > ~/{}", quote_remote_path(rest))
    } else {
        format!("cat > '{}'", quote_remote_path(target))
    }
}

/// 递归收集本地目录条目为（相对路径, 绝对路径, 大小）——目录另存相对路径队列。
/// 相对路径用 `/` 分隔（远端 shell 侧一致），绕过 Windows 分隔符差异。
fn collect_folder_entries(
    root: &std::path::Path,
    current: &std::path::Path,
    dirs: &mut Vec<String>,
    files: &mut Vec<(String, std::path::PathBuf, u64)>,
) -> Result<(), String> {
    let reader = std::fs::read_dir(current).map_err(|error| format!("读取本地目录失败：{error}"))?;
    for entry in reader {
        let entry = entry.map_err(|error| format!("读取本地目录条目失败：{error}"))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "路径规范化失败".to_string())?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let file_type = entry.file_type().map_err(|error| format!("读取条目类型失败：{error}"))?;
        if file_type.is_dir() {
            dirs.push(rel.clone());
            collect_folder_entries(root, &path, dirs, files)?;
        } else if file_type.is_file() {
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            files.push((rel, path, size));
        }
    }
    Ok(())
}

/// 在收集结果上包上所选文件夹名（整包上传 = 远端出现同名文件夹 + 内容全部
/// 落在其内）。只做路径拼接不做 shell 转义——mkdir/cat 命令构造时统一经
/// `remote_path_word` 转义。
fn scope_folder_entries(
    folder_name: &str,
    dirs: &mut [String],
    files: &mut [(String, std::path::PathBuf, u64)],
) {
    for rel in dirs.iter_mut() {
        *rel = format!("{folder_name}/{rel}");
    }
    for (rel, _, _) in files.iter_mut() {
        *rel = format!("{folder_name}/{rel}");
    }
}

/// 上传本地文件夹到远程目录（递归，整包语义）：远端创建同名文件夹并保留
/// 目录结构——先对每个子目录 `mkdir -p`（根文件夹由 mkdir -p 连带创建），再
/// 对每个文件复用 run_upload 流式写入（ControlPath 复用握手）。进度按文件
/// 回传（逐文件 Start/Progress，属于对现有单文件投影模型的近似——前端显示
/// 文件夹内相对路径）。中断的文件登记完整远端目标，续传打回原位。
async fn upload_folder(
    app: AppHandle,
    host_id: String,
    remote_dir: String,
) -> Result<SshCommandResponse, String> {
    use tauri_plugin_dialog::DialogExt;

    let host_id = validate_host_id(&host_id)?.to_string();
    let remote_dir_checked = validate_remote_path(&remote_dir)?.to_string();
    let state = app.state::<SshSessionState>();
    if !state.is_alive(&host_id) {
        return Err("SSH 会话未激活，无法上传".into());
    }
    if state.has_upload(&host_id) {
        return Err("该主机已有上传在进行".into());
    }

    let lookup_app = app.clone();
    let lookup_id = host_id.clone();
    let host = tauri::async_runtime::spawn_blocking(move || {
        crate::ssh::find_host(&lookup_app, &lookup_id)
    })
    .await
    .map_err(|error| format!("SSH 上传任务中断：{error}"))??;
    let host = host.ok_or_else(|| format!("主机不存在或已被删除（{host_id}）"))?;
    let _ = validate_host_input(&host.name, &host.hostname, host.port, &host.username)?;
    let target = SshTarget::from(&host);

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择要上传的文件夹")
        .pick_folder(move |dir| {
            let _ = sender.send(dir);
        });
    let picked = receiver
        .await
        .map_err(|_| "文件夹选择器意外关闭".to_string())?;
    let Some(picked) = picked else {
        return Ok(SshCommandResponse::Ack);
    };
    let root = picked
        .into_path()
        .map_err(|error| format!("无法解析所选文件夹路径：{error}"))?;

    if !state.is_alive(&host_id) {
        return Err("SSH 会话未激活，无法上传".into());
    }

    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<(String, std::path::PathBuf, u64)> = Vec::new();
    collect_folder_entries(&root, &root, &mut dirs, &mut files)?;
    let folder_name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "folder".to_string());
    // 整包语义：远端先出现同名文件夹，内容全部落在其内——否则所选文件夹的
    // 内容会散落在目标目录顶层。只有「无任何子目录且无文件」的真空目录才
    // 拒绝；仅含空子目录时仍创建目录结构后完成。
    if dirs.is_empty() && files.is_empty() {
        return Err("所选文件夹是空目录，没有可上传的内容".into());
    }
    scope_folder_entries(&folder_name, &mut dirs, &mut files);
    // 根文件夹显式入列：`cat >` 不创建父目录，扁平文件夹（无子目录）没有
    // 可连带创建根的 mkdir -p，不补这条首个文件写入必失败（mkdir -p 幂等，
    // 非扁平时重复创建无副作用）。
    dirs.insert(0, folder_name.clone());
    // 单文件上传有 2 GiB 上限，文件夹路径此前绕过了该守卫：超限文件在上传
    // 开始前整体拒绝（远端未写、续传材料未动）。
    if let Some((rel, _, _)) = files.iter().find(|(_, _, size)| *size > MAX_UPLOAD_BYTES) {
        return Err(format!(
            "文件超出上传上限（{} MiB）：{rel}",
            MAX_UPLOAD_BYTES / 1024 / 1024
        ));
    }
    let total_bytes: u64 = files.iter().map(|(_, _, size)| *size).sum();

    let cancel = Arc::new(AtomicBool::new(false));
    let pid_slot: Arc<StdMutex<Option<u32>>> = Arc::new(StdMutex::new(None));
    state.mark_upload_started(&host_id, Arc::clone(&cancel), Arc::clone(&pid_slot))?;

    let control_socket =
        control_socket_path(&crate::storage_paths::axiom_data_root(&app)?, &host_id);
    let _ = app.emit(
        SSH_UPLOAD_EVENT,
        SshUploadEvent::Start {
            host_id: host_id.clone(),
            name: folder_name.clone(),
            total_bytes,
        },
    );

    let app_thread = app.clone();
    let host_id_thread = host_id.clone();
    let folder_name_thread = folder_name.clone();
    let remote_dir_thread = remote_dir_checked.clone();
    std::thread::spawn(move || {
        // 先建所有远程子目录。
        for rel in &dirs {
            let mkdir_cmd = remote_mkdir_command(&join_remote(&remote_dir_thread, rel));
            let mkdir_args = build_exec_args(&control_socket, &target, &mkdir_cmd);
            let ok = std::process::Command::new("ssh")
                .args(&mkdir_args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if !ok {
                let _ = app_thread.emit(
                    SSH_UPLOAD_EVENT,
                    SshUploadEvent::Failed {
                        host_id: host_id_thread.clone(),
                        name: folder_name_thread.clone(),
                        error: format!("创建远程目录失败：{rel}"),
                    },
                );
                if let Some(state) = app_thread.try_state::<SshSessionState>() {
                    state.mark_upload_finished(&host_id_thread);
                }
                return;
            }
        }

        // 逐文件流式上传。
        for (rel, abs, size) in &files {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let full_target = join_remote(&remote_dir_thread, rel);
            let remote_cmd = remote_write_command(&full_target);
            let args = build_exec_args(&control_socket, &target, &remote_cmd);
            let outcome = run_upload(UploadContext {
                local_path: abs.as_path(),
                args: &args,
                app: &app_thread,
                host_id: &host_id_thread,
                name: rel,
                total_bytes: *size,
                cancel: &cancel,
                pid_slot: &pid_slot,
                start_offset: 0,
            });
            match &outcome {
                Ok(UploadOutcome::Completed) => {}
                Ok(UploadOutcome::Cancelled) | Ok(UploadOutcome::Failed(_)) | Err(_) => {
                    let error = match &outcome {
                        Ok(UploadOutcome::Cancelled) => "上传已取消".to_string(),
                        Ok(UploadOutcome::Failed(msg)) | Err(msg) => msg.clone(),
                        _ => "上传失败".to_string(),
                    };
                    let _ = app_thread.emit(
                        SSH_UPLOAD_EVENT,
                        SshUploadEvent::Failed {
                            host_id: host_id_thread.clone(),
                            name: folder_name_thread.clone(),
                            error: format!("{error}（{rel}）"),
                        },
                    );
                    if let Some(state) = app_thread.try_state::<SshSessionState>() {
                        state.mark_upload_finished(&host_id_thread);
                        state.mark_upload_interrupted(
                            &host_id_thread,
                            abs.clone(),
                            &folder_name_thread,
                            &full_target,
                        );
                    }
                    return;
                }
            }
        }

        if let Some(state) = app_thread.try_state::<SshSessionState>() {
            state.mark_upload_finished(&host_id_thread);
            state.take_interrupted(&host_id_thread);
        }
        let _ = app_thread.emit(
            SSH_UPLOAD_EVENT,
            SshUploadEvent::Done {
                host_id: host_id_thread.clone(),
                name: folder_name_thread.clone(),
            },
        );
    });

    Ok(SshCommandResponse::Ack)
}

/// 应用退出回收（lib.rs handle_run_event 与 browser reap 同点调用）。
pub(crate) fn reap_ssh_sessions_for_exit(state: &tauri::State<'_, SshSessionState>) {
    state.reap_for_exit();
}

/// 会话类动作（ssh_command 顶部 match 构造后委派，避免 ssh.rs 依赖会话内部
/// 状态与 PTY 细节）。
#[derive(Debug)]
pub(crate) enum SshSessionAction {
    Open {
        host_id: String,
        cols: u16,
        rows: u16,
    },
    Write {
        host_id: String,
        data: String,
    },
    Resize {
        host_id: String,
        cols: u16,
        rows: u16,
    },
    Close {
        host_id: String,
    },
    Upload {
        host_id: String,
        remote_dir: String,
    },
    Resume {
        host_id: String,
    },
    Cancel {
        host_id: String,
    },
    ListFiles {
        host_id: String,
        path: String,
    },
    MakeDir {
        host_id: String,
        path: String,
    },
    UploadFolder {
        host_id: String,
        remote_dir: String,
    },
    List,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    /// 测试专用计数器（与生产 id 计数器无关）。
    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    /// 每个用例独立的临时目录（对齐 ssh.rs 测试形态）。
    fn temporary_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "axiom-ssh-session-test-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn rejects_invalid_host_ids() {
        assert!(validate_host_id("").is_err());
        assert!(validate_host_id("short").is_err());
        assert!(validate_host_id("gggggggggggggggg").is_err()); // 非 hex
        assert!(validate_host_id("0123456789abcdef extra").is_err());
        assert!(validate_host_id("0123456789abcdef").is_ok());
        assert!(validate_host_id("ABCDEF0123456789").is_ok());
    }

    #[test]
    fn builds_ssh_args_with_expected_semantics() {
        let target = SshTarget {
            hostname: "server.example.com".into(),
            port: 2222,
            username: "amu".into(),
            private_key_path: None,
        };
        let socket = Path::new("/home/.axiom/ssh/cm-0123456789abcdef.sock");
        let args = build_ssh_args(socket, &target);
        assert_eq!(args[0], "-tt");
        let joined = args.join(" ");
        assert!(joined.contains("ControlMaster=auto"));
        assert!(joined.contains("ControlPath=/home/.axiom/ssh/cm-0123456789abcdef.sock"));
        assert!(joined.contains("ConnectTimeout=10"));
        assert!(joined.contains("ServerAliveInterval=15"));
        assert!(joined.contains("StrictHostKeyChecking=accept-new"));
        assert!(args.contains(&"-p".to_string()));
        let index = args.iter().position(|arg| arg == "-p").unwrap();
        assert_eq!(args[index + 1], "2222");
        // `--` 紧邻登录目标之前：终止选项解析，user@host 即便携带 `-` 前缀也
        // 只会被当作目的地。
        let last = args.len() - 1;
        assert_eq!(args[last - 1], "--");
        assert_eq!(args.last().unwrap(), "amu@server.example.com");
        // 未登记私钥：不出现 -i。
        assert!(!args.contains(&"-i".to_string()));
    }

    #[test]
    fn builds_ssh_args_with_explicit_private_key() {
        let target = SshTarget {
            hostname: "server.example.com".into(),
            port: 22,
            username: "amu".into(),
            private_key_path: Some("/Users/amu/.ssh/id_ed25519".into()),
        };
        let socket = Path::new("/home/.axiom/ssh/cm-0123456789abcdef.sock");
        let args = build_ssh_args(socket, &target);
        let index = args.iter().position(|arg| arg == "-i").unwrap();
        assert_eq!(args[index + 1], "/Users/amu/.ssh/id_ed25519");
        // 私钥在 `-p`/`--`/destination 之前，且 destination 仍是最后一个参数。
        let port_index = args.iter().position(|arg| arg == "-p").unwrap();
        assert!(index < port_index);
        let last = args.len() - 1;
        assert_eq!(args[last - 1], "--");
        assert_eq!(args.last().unwrap(), "amu@server.example.com");
    }

    #[test]
    fn control_socket_path_scoped_to_data_root() {
        let path = control_socket_path(Path::new("/home/.axiom"), "0123456789abcdef");
        assert_eq!(
            path,
            PathBuf::from("/home/.axiom/ssh/cm-0123456789abcdef.sock")
        );
    }

    #[test]
    fn session_event_data_is_base64_encoded() {
        let event = SshSessionEvent::data("0123456789abcdef", b"hi".to_vec());
        let encoded = event.data.as_deref().expect("data payload");
        assert_eq!(encoded, "aGk=");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("valid base64");
        assert_eq!(decoded, b"hi".to_vec());
        // done 事件不带数据载荷。
        let done = SshSessionEvent::done("0123456789abcdef", None);
        assert!(done.data.is_none());
    }

    #[test]
    fn session_state_aliveness_tracks_registration() {
        let state = SshSessionState::default();
        assert!(!state.is_alive("0123456789abcdef"));
        assert!(state.alive_host_ids().is_empty());
        assert!(!state.signal_close("0123456789abcdef"));
    }

    #[test]
    fn quotes_remote_file_names_for_shell() {
        assert_eq!(
            remote_upload_command("server.log", "~"),
            "cat > ~/'server.log'"
        );
        // 空格与中文原样保留（单引号包裹内安全）。
        assert_eq!(
            remote_upload_command("my 报告 file.txt", "~"),
            "cat > ~/'my 报告 file.txt'"
        );
        // 单引号按 POSIX 方言转义：' → '\''（闭引号+转义引号+开引号）。
        assert_eq!(
            remote_upload_command("it's.txt", "~"),
            "cat > ~/'it'\\''s.txt'"
        );
        // 上传到子目录：`~/` 前缀不引号（保持展开），文件名片段单独引用。
        assert_eq!(
            remote_upload_command("app.log", "~/logs"),
            "cat > ~/logs/'app.log'"
        );
        // 绝对路径目录：整段引用。
        assert_eq!(
            remote_upload_command("app.log", "/var/log"),
            "cat > '/var/log/app.log'"
        );
    }

    /// 列目录命令必须以 `sh -c` 包裹：sshd 用远端登录 shell 解释命令串，
    /// zsh（macOS 远端默认）glob 无匹配即报错退出、fish/csh 连 for 语法都
    /// 不兼容。包裹后语义与登录 shell 无关。
    #[test]
    fn remote_list_command_wraps_script_in_posix_sh() {
        let command = remote_list_command("/var/log");
        assert!(
            command.starts_with("sh -c '") && command.ends_with('\''),
            "必须以 sh -c 包裹：{command}"
        );
        // 无 2>/dev/null 吞错：cd 失败原因必须透到 ssh stderr。
        // （路径经两层单引号转义，cd 段非字面量形态，只断言无引号片段。）
        assert!(
            command.contains("cd -- ") && command.contains(" && for e in .* *; do"),
            "{command}"
        );
    }

    /// `~`/`~/…` 目标必须保持波浪号可展开：单引号内的 `~` 是字面量，任何
    /// shell（含内层 POSIX sh）都不展开——列目录/建目录两个入口回归锁死。
    /// 列目录命令经 `sh -c` 外层再转义（' → '\''），cd 段断言只看引号形态；
    /// mkdir 无外层包裹，直接全等。
    #[test]
    fn tilde_targets_stay_unquoted_for_cd_and_mkdir() {
        let home_list = remote_list_command("~");
        assert!(
            home_list.contains("cd -- ~ &&"),
            "裸 ~ 必须不引号（保持展开）：{home_list}"
        );
        assert!(!home_list.contains("cd -- '"), "裸 ~ 不得被引号包裹");
        let sub_list = remote_list_command("~/my logs");
        assert!(
            sub_list.contains("cd -- ~/") && sub_list.contains("my logs"),
            "~ 前缀目录展开、余段引号：{sub_list}"
        );
        assert!(!sub_list.contains("cd -- '"), "~ 前缀不得整段引号包裹");
        let abs_list = remote_list_command("/var/log");
        assert!(abs_list.contains("cd -- '"), "绝对路径照旧整段引号：{abs_list}");
        assert_eq!(remote_mkdir_command("~"), "mkdir -p -- ~");
        assert_eq!(remote_mkdir_command("~/a b"), "mkdir -p -- ~/'a b'");
        assert_eq!(remote_mkdir_command("/tmp/x"), "mkdir -p -- '/tmp/x'");
    }

    /// 端到端：模拟 sshd 行为（登录 shell -c "命令串"）真实执行列目录命令，
    /// 覆盖 zsh（glob 无匹配即失败的原始 bug 场景）与 sh 两种登录 shell，
    /// 以及空格/中文/单引号/隐藏文件/子目录/空目录/HOME 重定向下
    /// `~`/`~/…` 波浪号展开各类形态。
    #[test]
    fn remote_list_command_executes_under_hostile_login_shells_and_parses() {
        fn run_login_shell(shell: &str, command: &str) -> (bool, Vec<u8>, String) {
            let output = std::process::Command::new(shell)
                .arg("-c")
                .arg(command)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .expect("启动 shell 失败");
            (
                output.status.success(),
                output.stdout,
                String::from_utf8_lossy(&output.stderr).into_owned(),
            )
        }

        fn run_login_shell_with_home(
            shell: &str,
            home: &std::path::Path,
            command: &str,
        ) -> (bool, Vec<u8>, String) {
            let output = std::process::Command::new(shell)
                .env("HOME", home)
                .arg("-c")
                .arg(command)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .expect("启动 shell 失败");
            (
                output.status.success(),
                output.stdout,
                String::from_utf8_lossy(&output.stderr).into_owned(),
            )
        }

        fn assert_listing_matches(stdout: &[u8]) {
            let entries = parse_ls_output(stdout);
            let by_name = |name: &str| {
                entries
                    .iter()
                    .find(|entry| entry.name == name)
                    .unwrap_or_else(|| panic!("缺少条目 {name}，实际：{entries:?}"))
            };
            assert_eq!(by_name("a file.txt").size_bytes, 5);
            assert!(!by_name("a file.txt").is_dir);
            assert_eq!(by_name("中文名.md").size_bytes, 6); // "你好" = 6 UTF-8 字节
            assert!(!by_name("it's.txt").is_dir);
            assert!(by_name("subdir").is_dir);
            assert_eq!(by_name(".hidden").size_bytes, 1);
            // stat 失败不应静默丢字段（GNU/BSD 至少一路有值）。
            for name in ["a file.txt", "中文名.md", "subdir"] {
                assert!(!by_name(name).perms.is_empty(), "{name} perms 为空");
                assert!(
                    !by_name(name).modified_at.is_empty(),
                    "{name} mtime 为空"
                );
            }
        }

        let dir = temporary_directory();
        std::fs::write(dir.join("a file.txt"), "hello").unwrap();
        std::fs::write(dir.join("中文名.md"), "你好").unwrap();
        std::fs::write(dir.join("it's.txt"), "q").unwrap();
        std::fs::write(dir.join(".hidden"), "h").unwrap();
        std::fs::create_dir_all(dir.join("subdir")).unwrap();

        // macOS 必有 zsh（原始 bug 的重灾区）；zsh 缺失的环境退回 sh，
        // 仍验证 sh -c 包裹本身。
        let mut login_shells = vec!["sh"];
        if std::process::Command::new("zsh")
            .arg("-c")
            .arg("true")
            .output()
            .is_ok_and(|output| output.status.success())
        {
            login_shells.push("zsh");
        }
        for shell in &login_shells {
            let (ok, stdout, stderr) =
                run_login_shell(shell, &remote_list_command(&dir.to_string_lossy()));
            assert!(ok, "{shell} 执行列目录失败：{stderr}");
            assert_listing_matches(&stdout);
        }

        // 空目录：zsh 原始 bug 的另一形态（`.*` 与 `*` 均无匹配）。
        let empty = temporary_directory();
        for shell in &login_shells {
            let (ok, stdout, stderr) =
                run_login_shell(shell, &remote_list_command(&empty.to_string_lossy()));
            assert!(ok, "{shell} 空目录列目录失败：{stderr}");
            assert!(parse_ls_output(&stdout).is_empty());
        }

        // 不存在的路径：非零退出且 stderr 带真实原因（不再被 2>/dev/null 吞掉）。
        let missing = dir.join("does-not-exist");
        let (ok, _, stderr) = run_login_shell("sh", &remote_list_command(&missing.to_string_lossy()));
        assert!(!ok);
        assert!(stderr.contains("cd"), "stderr 应包含 cd 失败原因：{stderr}");

        // `~`/`~/…` 前缀必须保持波浪号展开（回归：整段引号曾让内层 sh 收到
        // 字面量 '~'，报 can't cd to ~）。HOME 重定向到临时目录模拟远端 home。
        let home = temporary_directory();
        std::fs::write(home.join(".hidden"), "h").unwrap();
        std::fs::create_dir_all(home.join("subdir")).unwrap();
        for shell in &login_shells {
            let (ok, stdout, stderr) =
                run_login_shell_with_home(shell, &home, &remote_list_command("~"));
            assert!(ok, "{shell} 列 ~ 失败：{stderr}");
            let entries = parse_ls_output(&stdout);
            assert!(
                entries.iter().any(|entry| entry.name == ".hidden"),
                "{shell} 列 ~ 未返回 home 内容：{entries:?}"
            );
            let (ok, stdout, stderr) =
                run_login_shell_with_home(shell, &home, &remote_list_command("~/subdir"));
            assert!(ok, "{shell} 列 ~/subdir 失败：{stderr}");
            assert!(parse_ls_output(&stdout).is_empty());
        }

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn builds_upload_args_over_control_path() {
        let target = SshTarget {
            hostname: "server.example.com".into(),
            port: 2200,
            username: "deploy".into(),
            private_key_path: None,
        };
        let args = build_exec_args(
            Path::new("/home/.axiom/ssh/cm-0123456789abcdef.sock"),
            &target,
            "cat > ~/'a.bin'",
        );
        assert!(args[0].starts_with("-o"));
        let joined = args.join(" ");
        assert!(joined.contains("ControlPath=/home/.axiom/ssh/cm-0123456789abcdef.sock"));
        // exec 通道与终端通道同一超时/保活约定：mux 失效回退直连时快速失败。
        assert!(joined.contains("ConnectTimeout=10"));
        assert!(joined.contains("ServerAliveInterval=15"));
        assert!(args.contains(&"-p".to_string()));
        // `--` 在登录目标之前、远端命令在最后。
        let destination_index = args
            .iter()
            .position(|arg| arg == "deploy@server.example.com")
            .unwrap();
        assert_eq!(args[destination_index - 1], "--");
        assert_eq!(args.last().unwrap(), "cat > ~/'a.bin'");
    }

    #[test]
    fn validates_remote_names() {
        assert!(validate_remote_name("ok.bin").is_ok());
        assert!(validate_remote_name("空格 名称.txt").is_ok());
        assert!(validate_remote_name("").is_err());
        assert!(validate_remote_name("  ").is_err());
        assert!(validate_remote_name("a/b").is_err());
        assert!(validate_remote_name("a\\b").is_err());
        assert!(validate_remote_name("a\nb").is_err());
        let oversized = "x".repeat(MAX_REMOTE_NAME_BYTES + 1);
        assert!(validate_remote_name(&oversized).is_err());
    }

    #[test]
    fn quotes_append_and_probe_commands() {
        // 输入是登记的完整远端目标：`~` 前缀展开、其余整段转义——续传探测与
        // 追加必须打回原位，裸文件名会把非 `~` 目标注销到 `~` 根。
        assert_eq!(
            remote_probe_size_command("~/a.bin"),
            "wc -c < ~/'a.bin'"
        );
        assert_eq!(
            remote_append_command("~/logs/a.bin"),
            "cat >> ~/'logs/a.bin'"
        );
        assert_eq!(
            remote_append_command("~/it's"),
            "cat >> ~/'it'\\''s'"
        );
        assert_eq!(
            remote_append_command("/var/data/a.bin"),
            "cat >> '/var/data/a.bin'"
        );
    }

    #[test]
    fn writes_and_removes_askpass_script_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = temporary_directory();
        // write_askpass_script 会创建 <dir>/ssh 子目录并加固为 0700。
        let script = write_askpass_script(&directory, "0123456789abcdef").unwrap();
        assert!(script.to_string_lossy().contains(".askpass-0123456789abcdef.sh"));
        let mode = std::fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let body = std::fs::read_to_string(&script).unwrap();
        assert!(body.starts_with("#!/bin/sh"));
        assert!(body.contains("AXIOM_SSH_PASSWORD"));
        std::fs::remove_file(&script).unwrap();
        assert!(!script.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn upload_registration_serializes_per_host() {
        let state = SshSessionState::default();
        assert!(!state.has_upload("0123456789abcdef"));
        state
            .mark_upload_started(
                "0123456789abcdef",
                Arc::new(AtomicBool::new(false)),
                Arc::new(StdMutex::new(None)),
            )
            .unwrap();
        assert!(state.has_upload("0123456789abcdef"));
        // 同主机第二个上传被拒绝；其他主机不受影响。
        assert!(state
            .mark_upload_started(
                "0123456789abcdef",
                Arc::new(AtomicBool::new(false)),
                Arc::new(StdMutex::new(None)),
            )
            .is_err());
        state
            .mark_upload_started(
                "fedcba9876543210",
                Arc::new(AtomicBool::new(false)),
                Arc::new(StdMutex::new(None)),
            )
            .unwrap();
        state.mark_upload_finished("0123456789abcdef");
        assert!(!state.has_upload("0123456789abcdef"));
        assert!(state.has_upload("fedcba9876543210"));
        // 取消位对无上传主机返回 false；对在途上传置位后可查询。
        assert!(!state.cancel_upload("0123456789abcdef"));
        state
            .mark_upload_started(
                "0123456789abcdef",
                Arc::new(AtomicBool::new(true)),
                Arc::new(StdMutex::new(None)),
            )
            .unwrap();
        assert!(state.cancel_upload("0123456789abcdef"));
    }

    #[test]
    fn interrupted_uploads_track_registration() {
        let state = SshSessionState::default();
        assert!(state.take_interrupted("0123456789abcdef").is_none());
        state.mark_upload_interrupted(
            "0123456789abcdef",
            PathBuf::from("/tmp/a.bin"),
            "a.bin",
            "~/logs/a.bin",
        );
        let taken = state.take_interrupted("0123456789abcdef");
        let taken = taken.unwrap();
        assert_eq!(taken.name, "a.bin");
        assert_eq!(taken.remote_target, "~/logs/a.bin");
        // 取出即清除：二次取出为空。
        assert!(state.take_interrupted("0123456789abcdef").is_none());
    }

    #[test]
    fn collects_and_scopes_folder_entries_as_a_whole() {
        // 整包语义：收集结果（相对所选文件夹）包上文件夹名后，目录与文件都
        // 落在 remote_dir/<文件夹名>/ 内——空子目录也保留在目录清单里。
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("空 目录")).unwrap();
        std::fs::write(root.join("README.md"), "hi").unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("src/deep/a b.txt"), "x").unwrap();

        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<(String, std::path::PathBuf, u64)> = Vec::new();
        collect_folder_entries(&root, &root, &mut dirs, &mut files).unwrap();
        let folder = root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        scope_folder_entries(&folder, &mut dirs, &mut files);

        assert!(
            dirs.iter().any(|rel| rel.as_str() == format!("{folder}/src"))
                && dirs
                    .iter()
                    .any(|rel| rel.as_str() == format!("{folder}/src/deep"))
                && dirs
                    .iter()
                    .any(|rel| rel.as_str() == format!("{folder}/空 目录")),
            "子目录（含空目录）应全部带文件夹前缀：{dirs:?}"
        );
        let size_of = |rel: &str| {
            files
                .iter()
                .find(|(candidate, _, _)| candidate == rel)
                .map(|(_, _, size)| *size)
        };
        assert_eq!(size_of(&format!("{folder}/README.md")), Some(2));
        assert_eq!(size_of(&format!("{folder}/src/main.rs")), Some(12));
        assert_eq!(size_of(&format!("{folder}/src/deep/a b.txt")), Some(1));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 在 dir 下造一个 ssh 文件（mode 控制是否可执行）。
    fn make_fake_ssh(dir: &Path, executable: bool) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let program = dir.join("ssh");
        std::fs::write(&program, "#!/bin/sh\n").unwrap();
        if executable {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
        }
        program
    }

    #[test]
    fn resolves_ssh_preferring_first_executable_on_path() {
        let root = temporary_directory();
        let bin = root.join("bin");
        let first = make_fake_ssh(&bin, true);
        let second = make_fake_ssh(&root.join("bin2"), true);
        // 首目录命中即停，不继续扫后续目录。
        let found = find_ssh_on_path([bin, root.join("bin2")]).unwrap();
        assert_eq!(found, first);
        assert_ne!(found, second);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn path_lookup_skips_non_executables_and_directories() {
        let root = temporary_directory();
        // 主目录同名目录陷阱：名为 ssh 的目录（如 ~/ssh）只查 exists 会被
        // portable-pty 命中并拿去 exec——这里目录与不可执行文件都必须跳过。
        let trap = root.join("ssh");
        std::fs::create_dir_all(&trap).unwrap();
        let non_executable = make_fake_ssh(&root.join("bin"), false);
        let real = make_fake_ssh(&root.join("bin2"), true);
        let found = find_ssh_on_path([trap, root.join("bin"), root.join("bin2")]).unwrap();
        assert_eq!(found, real);
        assert_ne!(found, non_executable);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn path_lookup_skips_empty_entries_and_missing_dirs() {
        let root = temporary_directory();
        let real = make_fake_ssh(&root.join("bin"), true);
        // 空项语义为 cwd（execvp 约定）——解析显式跳过，绝不回退到 cwd/HOME
        // 拼接；不存在的目录同样跳过。
        let found = find_ssh_on_path([
            PathBuf::from(""),
            root.join("no-such-dir"),
            root.join("bin"),
        ])
        .unwrap();
        assert_eq!(found, real);
        assert!(find_ssh_on_path([PathBuf::from(""), root.join("no-such-dir")]).is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
