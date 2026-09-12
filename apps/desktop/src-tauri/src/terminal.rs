use crate::workspace_access::{authorized_root_for, WorkspaceAccessState};
use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, watch};

const TERMINAL_EVENT: &str = "axiom:terminal-event";
const READ_BUFFER_BYTES: usize = 8 * 1024;
const TERMINATION_GRACE_MS: u64 = 500;
/// 终端 stdin 单次写入上限：终端是用户亲手操作的交互通道，不消费审批 lease。
/// 上限仅为纵深防御（配合手势门），放宽后支持粘贴大段文本（日志/代码），与普通终端一致。
const MAX_TERMINAL_STDIN_BYTES: usize = 4 * 1024 * 1024;
/// stdin 写入配额距最近一次授予（终端聚焦时的原生 keyDown）超过该窗口即整体失效。
/// 终端面板与会话同窗渲染（主窗口为本 app 唯一窗口）；受陷渲染进程即使拿到 stdin
/// 权限，也无法在没有真实用户按键时注入命令——每次写入都必须消费一个由真实 keyDown
/// 授予的配额。
pub(crate) const USER_GESTURE_WINDOW: Duration = Duration::from_secs(2);

/// 终端 stdin 手势门状态（以 `Arc<TerminalGestureState>` 托管，供原生 monitor 与
/// 命令共享同一实例）：
/// - `terminal_focused` 由前端 `set_terminal_focus` 报告（纵深防御；受陷渲染进程可伪造，
///   但真正的安全边界仍是原生 keyDown 的不可伪造性）；
/// - 写入配额由「终端聚焦时的原生 keyDown」授予，`write_terminal_stdin` 每次写入消费
///   一个配额（单次消费）。
#[derive(Default)]
pub(crate) struct TerminalGestureState {
    /// 终端面板是否持有键盘焦点。
    terminal_focused: Mutex<bool>,
    #[cfg(target_os = "macos")]
    /// 未消费的 stdin 写入配额：每个「终端聚焦时的原生 keyDown」+1，每次写入消费 -1。
    /// 受陷渲染进程无法伪造原生 keyDown，因此总写入量被真实按键数量所限（单次消费），
    /// 同时不会像「单一令牌」那样在快速连续输入时覆盖丢失未消费按键。
    pending_stdin_writes: Mutex<u32>,
    #[cfg(target_os = "macos")]
    /// 最近一次授予配额的原生 keyDown 时间：作为配额 TTL 依据，陈旧配额整体失效。
    last_granted_at: Mutex<Option<Instant>>,
}

#[cfg(target_os = "macos")]
/// 终端聚焦时，由原生 keyDown 授予一个 stdin 写入配额。
/// 受陷渲染进程无法伪造原生事件；未聚焦时不授予。
fn grant_stdin_gesture(state: &TerminalGestureState) {
    let focused = state
        .terminal_focused
        .lock()
        .map(|guard| *guard)
        .unwrap_or(false);
    if !focused {
        return;
    }
    if let Ok(mut pending) = state.pending_stdin_writes.lock() {
        *pending = pending.saturating_add(1);
    }
    if let Ok(mut last) = state.last_granted_at.lock() {
        *last = Some(Instant::now());
    }
}

/// 更新终端焦点状态（`set_terminal_focus` 命令与测试共用）。
/// 失焦时清空未消费配额：防止配额在焦点离开终端后残留，被渲染进程在非终端交互
/// 场景下利用。
pub(crate) fn set_terminal_focus_state(state: &TerminalGestureState, focused: bool) {
    if let Ok(mut current) = state.terminal_focused.lock() {
        *current = focused;
    }
    #[cfg(target_os = "macos")]
    if !focused {
        if let Ok(mut pending) = state.pending_stdin_writes.lock() {
            *pending = 0;
        }
        if let Ok(mut last) = state.last_granted_at.lock() {
            *last = None;
        }
    }
}

#[cfg(target_os = "macos")]
/// 校验并消费一个 stdin 写入配额：必须存在未消费配额（来自终端聚焦时的原生 keyDown），
/// 且最近一次授予距现在不超过 `window`。每次写入消费一个配额（单次消费）；配额
/// 陈旧则整体失效。返回 Err 表示本次写入未被任何真实用户按键授权。
pub(crate) fn consume_stdin_gesture(state: &TerminalGestureState, window: Duration) -> Result<(), String> {
    let mut pending = state
        .pending_stdin_writes
        .lock()
        .map_err(|_| "terminal gesture state lock is poisoned".to_string())?;
    if *pending == 0 {
        return Err("terminal input was not preceded by a native user key press".into());
    }
    let granted_at = match *state
        .last_granted_at
        .lock()
        .map_err(|_| "terminal gesture state lock is poisoned".to_string())?
    {
        Some(at) => at,
        // 有配额却无授予时间（不应出现的中间态）：fail-closed 拒绝。
        None => {
            *pending = 0;
            return Err("terminal input gesture is not tracked".into());
        }
    };
    if granted_at.elapsed() > window {
        *pending = 0;
        return Err("terminal input gesture has expired".into());
    }
    *pending -= 1;
    Ok(())
}

/// 安装 NSEvent local monitor：捕获本 app 窗口上的原生 keyDown 作为用户手势。
/// 无需辅助功能权限（local monitor 只观察本 app 的事件流，事件在 NSApplication 分发前）。
/// 必须在主线程调用（NSApplication 事件循环）。
#[cfg(target_os = "macos")]
fn install_terminal_gesture_monitor(state: &Arc<TerminalGestureState>) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use objc2_foundation::MainThreadMarker;

    if MainThreadMarker::new().is_none() {
        return Err("terminal gesture monitor requires the main thread".into());
    }
    let state = Arc::clone(state);
    // AppKit 的 addLocalMonitor 会 copy 传入的 block，但为稳妥仍用 RcBlock 并在
    // app 生命周期内 leak 保活，避免 handler 悬垂。
    let block: RcBlock<dyn Fn(std::ptr::NonNull<NSEvent>) -> *mut NSEvent> =
        RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
            // 手势记录不读取事件内容；NSEvent 指针由 AppKit 持有，仅在此传递。
            // 仅当终端聚焦时授予单次消费令牌（受陷渲染进程无法伪造原生事件）。
            grant_stdin_gesture(&state);
            // 返回原事件继续传递（不吞按键）。
            event.as_ptr()
        });
    let block: &'static RcBlock<dyn Fn(std::ptr::NonNull<NSEvent>) -> *mut NSEvent> =
        Box::leak(Box::new(block));
    // 返回值由 NSApplication 持有；drop 不会自动移除 monitor。
    let _monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, block)
    };
    Ok(())
}

/// 终端 stdin 的专用写线程：把「可无限阻塞的 PTY write_all」（远端 Ctrl-S
/// 停止读取 / 链路停滞时缓冲写会长时间不返回）从命令路径隔离到独立线程。
/// 命令侧只经 `Sender::send` 投递（无界通道，永不阻塞），会话 map 锁因此
/// 只被持有微秒级——kill/close/list 永不被在途写卡住，本地终端的同步命令
///（主线程执行）也不再存在可阻塞点。mpsc FIFO + 锁内 send 保证字节序与
/// 用户键入顺序严格一致。写失败（PTY 已关）即退出；会话移除后 Sender drop，
/// recv 返回 Err，线程排空队列后自然收尾。
pub(crate) fn spawn_stdin_writer(
    mut writer: Box<dyn Write + Send>,
) -> (
    Mutex<std::sync::mpsc::Sender<Vec<u8>>>,
    std::thread::JoinHandle<()>,
) {
    let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
    let handle = thread::spawn(move || {
        while let Ok(bytes) = receiver.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    (Mutex::new(sender), handle)
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    /// stdin 投递口（专用写线程消费，见 `spawn_stdin_writer`）。
    writer: Mutex<std::sync::mpsc::Sender<Vec<u8>>>,
    kill: watch::Sender<bool>,
    /// 终端挂载的授权工作区根（spawn 时解析）：撤销该工作区时按此归集杀死，
    /// 不再误杀其他工作区的终端。
    workspace_root: PathBuf,
}

#[derive(Default)]
pub(crate) struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalState {
    fn register(
        &self,
        terminal_id: &str,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        workspace_root: PathBuf,
    ) -> watch::Receiver<bool> {
        let (kill_tx, kill_rx) = watch::channel(false);
        let (writer_sender, _writer_thread) = spawn_stdin_writer(writer);
        let session = TerminalSession {
            master,
            writer: writer_sender,
            kill: kill_tx,
            workspace_root,
        };
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(terminal_id.to_string(), session);
        }
        kill_rx
    }

    fn remove(&self, terminal_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(terminal_id);
        }
    }

    /// 只杀挂载在指定工作区下的终端（撤销授权的作用域收窄），返回杀死数量。
    pub(crate) fn kill_for_workspace(&self, workspace_root: &Path) -> Result<usize, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal state lock is poisoned".to_string())?;
        let mut killed = 0;
        for session in sessions.values() {
            if session.workspace_root == workspace_root {
                let _ = session.kill.send(true);
                killed += 1;
            }
        }
        Ok(killed)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpawnTerminalRequest {
    terminal_id: String,
    /// 绑定工作区（canonical）。必填：归属必须在启动时显式确定，不回退到进程级
    /// 「当前激活工作区」（那会与用户切换竞争而错绑，破坏撤销作用域）。
    workspace_path: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

/// 校验绑定工作区路径的字面形态（是否已授权由 authorized_root_for 承担）。
fn validate_terminal_workspace_path(raw: &str) -> Result<&str, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("terminal workspace path must not be empty".into());
    }
    if value.len() > 16 * 1024 {
        return Err("terminal workspace path is too long".into());
    }
    Ok(value)
}

#[cfg(test)]
mod workspace_path_tests {
    use super::*;

    #[test]
    fn rejects_empty_or_oversized_terminal_workspace_paths() {
        assert!(validate_terminal_workspace_path("").is_err());
        assert!(validate_terminal_workspace_path("   ").is_err());
        assert!(validate_terminal_workspace_path(&"a".repeat(16 * 1024 + 1)).is_err());
        assert_eq!(validate_terminal_workspace_path(" /tmp ").unwrap(), "/tmp");
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalEvent {
    terminal_id: String,
    /// PTY 输出字节（base64 编码）：事件经 JSON 序列化投递，`Vec<u8>` 会展开
    /// 为数字数组（每字节 ~4-5 字符），base64（~1.37x）把高吞吐输出（cat 大
    /// 文件）的 IPC 体积与解析开销降 ~3.5x。与 browser 截图载荷同一编码。
    data: Option<String>,
    done: bool,
    exit_code: Option<i32>,
    error: Option<String>,
}

impl TerminalEvent {
    fn data(terminal_id: &str, bytes: Vec<u8>) -> Self {
        Self {
            terminal_id: terminal_id.to_string(),
            data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            done: false,
            exit_code: None,
            error: None,
        }
    }

    fn done(terminal_id: &str, exit_code: Option<i32>) -> Self {
        Self {
            terminal_id: terminal_id.to_string(),
            data: None,
            done: true,
            exit_code,
            error: None,
        }
    }
}

fn validate_terminal_id(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("terminal ID contains unsupported characters".into());
    }
    Ok(value)
}

fn resolve_terminal_cwd(root: &Path, raw_cwd: Option<&str>) -> Result<PathBuf, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("failed to resolve authorized workspace: {error}"))?;
    let raw_cwd = raw_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(".");
    if raw_cwd.len() > 16 * 1024 {
        return Err("terminal cwd is too long".into());
    }
    let relative = Path::new(raw_cwd);
    let candidate = if relative.is_absolute() {
        relative.to_path_buf()
    } else {
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("terminal cwd must be a relative path without '..'".into());
        }
        canonical_root.join(relative)
    };
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("failed to resolve terminal cwd: {error}"))?;
    if !std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect terminal cwd: {error}"))?
        .is_dir()
    {
        return Err("terminal cwd must be a directory".into());
    }
    ensure_cwd_readable(&canonical)?;
    Ok(canonical)
}

/// spawn 前探测目录可读：canonicalize/metadata 只做路径查找与 stat，不触发 macOS
/// TCC 的文件夹访问门控——工作区在「桌面/文稿/下载」等受保护位置且 app 未获授权时
/// （典型：updater 换上 adhoc 新二进制导致既有 TCC 授权按代码身份失效），shell 仍会
/// 正常启动，但 getcwd 需要读父目录内容会被 EPERM 拒绝，用户只看到 shell 初始化
/// 链（brew/mise 等子进程）刷出的连环报错。这里改用 opendir 语义的 read_dir 提前
/// 探测，fail-closed 并给出可操作指引，而不是把不可访问的 cwd 交给 shell。
fn ensure_cwd_readable(dir: &Path) -> Result<(), String> {
    match std::fs::read_dir(dir) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Err(format!(
            "终端目录不可访问（系统拒绝读取）：{}。macOS 已拒绝 Axiom 访问该文件夹——\
             工作区位于「桌面/文稿/下载」等受保护位置时，需在 系统设置 → 隐私与安全性 → \
             文件与文件夹 中允许 Axiom 访问对应文件夹（或开启「完全磁盘访问」）后重启 Axiom；\
             也可以重新用工作区选择器选择该目录以恢复授权。",
            dir.display()
        )),
        Err(error) => Err(format!(
            "failed to read terminal cwd {}: {error}",
            dir.display()
        )),
    }
}

pub(crate) fn signal_process_group(process_id: u32, signal: i32) -> bool {
    unsafe { libc::kill(-(process_id as i32), signal) == 0 }
}

#[tauri::command]
pub(crate) async fn spawn_terminal(
    app: tauri::AppHandle,
    request: SpawnTerminalRequest,
    workspace_state: State<'_, WorkspaceAccessState>,
    terminal_state: State<'_, TerminalState>,
) -> Result<String, String> {
    let workspace_path = validate_terminal_workspace_path(&request.workspace_path)?;
    // 归属必须来自显式绑定：未授权/缺失一律 fail-closed，不存在「当前激活工作区」
    // 回退路径（见 .specs/domain/terminal-user-channel.md 不变量 4/8）。
    let root = authorized_root_for(&workspace_state, Some(workspace_path))?;
    let terminal_id = validate_terminal_id(&request.terminal_id)?.to_string();
    let cwd = resolve_terminal_cwd(&root, request.cwd.as_deref())?;
    let cols = request.cols.unwrap_or(80).max(1);
    let rows = request.rows.unwrap_or(24).max(1);

    {
        let sessions = terminal_state
            .sessions
            .lock()
            .map_err(|_| "terminal state lock is poisoned".to_string())?;
        if sessions.contains_key(&terminal_id) {
            return Err("terminal ID is already active".into());
        }
    }

    // stdin 权限按需运行时授予（fail-closed）：默认 capability 不再开放 stdin
    // （见 capabilities/default.json 与 scripts/tauri-capability-audit.mjs），
    // 仅当尝试启动终端会话时，为 main 窗口授予写 stdin 的权限；授予失败则拒绝启动。
    // Tauri 运行时 capability 无 remove 接口，授予后持续到 app 生命周期结束；真正的
    // 输入来源校验由下方 `consume_stdin_gesture` 单次消费手势门承担，权限存在本身
    // 不足以注入命令（受陷渲染进程无法伪造原生 keyDown）。
    if let Err(error) = app.add_capability(
        tauri::ipc::CapabilityBuilder::new("terminal-stdin")
            .window("main")
            .permission("allow-write-terminal-stdin"),
    ) {
        return Err(format!("failed to grant terminal stdin capability: {error}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open terminal pty: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to acquire terminal writer: {error}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to clone terminal reader: {error}"))?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut command = CommandBuilder::new(&shell);
    // 以 login shell 启动，与 Terminal.app 一致：加载用户 .zprofile/.zlogin
    //（brew shellenv / nvm / pyenv 等初始化常在 login 启动文件里，非 login 模式会缺失）。
    command.arg("-l");
    command.cwd(&cwd);
    // 继承宿主完整环境：终端是用户亲手操作的交互通道，与普通终端一致——不做
    // env_clear、PATH 过滤或 git 配置中和（这些是针对 Agent 执行面的防护，见
    // AGENTS.md「bash」节；终端输入已由原生 keyDown 手势门兜底「只由用户键入」）。
    // 仅补齐 pty 必需的 TERM。
    command.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to spawn terminal shell: {error}"))?;
    drop(pair.slave);
    let process_id = child.process_id();
    let kill_rx = terminal_state.register(&terminal_id, pair.master, writer, root.clone());

    let (data_tx, data_rx) = mpsc::channel::<Vec<u8>>(64);
    thread::spawn(move || {
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

    let app_handle = app.clone();
    let task_terminal_id = terminal_id.clone();
    tauri::async_runtime::spawn(async move {
        let terminal_id = task_terminal_id;
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
                            let _ = app_handle
                                .emit(TERMINAL_EVENT, TerminalEvent::data(&terminal_id, bytes));
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
        let _ = app_handle.emit(TERMINAL_EVENT, TerminalEvent::done(&terminal_id, exit_code));
        if let Some(state) = app_handle.try_state::<TerminalState>() {
            state.remove(&terminal_id);
        }
    });

    Ok(terminal_id)
}

#[tauri::command]
pub(crate) fn write_terminal_stdin(
    terminal_id: String,
    data: String,
    state: State<'_, TerminalState>,
    gesture_state: State<'_, Arc<TerminalGestureState>>,
) -> Result<(), String> {
    let terminal_id = validate_terminal_id(&terminal_id)?;
    if data.len() > MAX_TERMINAL_STDIN_BYTES {
        return Err("terminal stdin write exceeds the safe limit".into());
    }
    // 输入来源手势门（单次消费）：每次写入必须消费一个「终端聚焦时的原生 keyDown」
    // 授予的写入配额。每次写入消费一个配额——写入总量被真实按键数量所限，杜绝
    // 2 秒窗口内的重复/批量注入；配额距最近授予过久则整体失效。受陷渲染进程可伪造
    // focus 报告，但无法伪造原生 keyDown，因此写入仍须以真实用户按键为前提
    // （AGENTS.md「终端只由用户键入」）。
    #[cfg(target_os = "macos")]
    consume_stdin_gesture(&gesture_state, USER_GESTURE_WINDOW)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state lock is poisoned".to_string())?;
    let session = sessions
        .get(terminal_id)
        .ok_or_else(|| "terminal session is not active".to_string())?;
    let writer = session
        .writer
        .lock()
        .map_err(|_| "terminal writer lock is poisoned".to_string())?;
    // 投递而非直写：无界通道上的 send 永不阻塞，write_all 的阻塞面隔离在
    // 专用写线程（见 spawn_stdin_writer）。PTY 停滞时主线程命令依旧 µs 级
    // 完成；真正的写失败随后由读侧 EOF → done 事件体现。
    writer
        .send(data.into_bytes())
        .map_err(|error| format!("failed to queue terminal stdin: {error}"))
}

/// 报告终端面板的键盘焦点状态（前端 xterm onFocus/onBlur 驱动）。
/// 仅作纵深防御：受陷渲染进程可伪造本报告，但手势门仍要求真实原生 keyDown
/// 授予单次消费令牌，因此伪造焦点无法凭空注入命令。
#[tauri::command]
pub(crate) fn set_terminal_focus(
    focused: bool,
    gesture_state: State<'_, Arc<TerminalGestureState>>,
) -> Result<(), String> {
    set_terminal_focus_state(&gesture_state, focused);
    Ok(())
}

#[tauri::command]
pub(crate) fn resize_terminal(
    terminal_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    let terminal_id = validate_terminal_id(&terminal_id)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state lock is poisoned".to_string())?;
    let session = sessions
        .get(terminal_id)
        .ok_or_else(|| "terminal session is not active".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to resize terminal: {error}"))
}

#[tauri::command]
pub(crate) fn kill_terminal(
    terminal_id: String,
    state: State<'_, TerminalState>,
) -> Result<bool, String> {
    let terminal_id = validate_terminal_id(&terminal_id)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state lock is poisoned".to_string())?;
    if let Some(session) = sessions.get(terminal_id) {
        let _ = session.kill.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 在应用 setup 阶段安装原生手势 monitor（必须在主线程）。
/// 手势门状态（`Arc<TerminalGestureState>`）已在 builder 阶段托管（见 lib.rs）。
pub(crate) fn install_gesture_monitor(app: &tauri::App) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<Arc<TerminalGestureState>>();
        install_terminal_gesture_monitor(state.inner())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn rejects_invalid_terminal_ids() {
        assert!(validate_terminal_id("").is_err());
        assert!(validate_terminal_id("with space").is_err());
        assert!(validate_terminal_id("with/slash").is_err());
        assert!(validate_terminal_id("ok_id-1").is_ok());
    }

    #[test]
    fn resolves_cwd_with_workspace_default_and_arbitrary_directories() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(workspace.path().join("nested")).unwrap();
        // 未传 cwd：默认授权工作区根
        assert_eq!(
            resolve_terminal_cwd(workspace.path(), None).unwrap(),
            std::fs::canonicalize(workspace.path()).unwrap()
        );
        // 相对路径：相对授权工作区根解析
        assert_eq!(
            resolve_terminal_cwd(workspace.path(), Some("nested")).unwrap(),
            std::fs::canonicalize(workspace.path().join("nested")).unwrap()
        );
        // 绝对路径：允许任意目录（与普通终端一致）
        assert_eq!(
            resolve_terminal_cwd(workspace.path(), Some(outside.path().to_str().unwrap())).unwrap(),
            std::fs::canonicalize(outside.path()).unwrap()
        );
        // 相对路径含 '..' 仍拒绝（避免歧义）
        assert!(resolve_terminal_cwd(workspace.path(), Some("../outside")).is_err());
        // 不存在的路径拒绝
        assert!(resolve_terminal_cwd(workspace.path(), Some("does-not-exist")).is_err());
        // 非目录路径拒绝
        let file = workspace.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(resolve_terminal_cwd(workspace.path(), Some("file.txt")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_cwd_that_shell_cannot_read() {
        // root 绕过 DAC 权限，chmod 000 拦不住 read_dir，该场景无法在本测试构造。
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        // canonicalize/metadata 均通过、但读目录被拒（如 macOS TCC 拒绝桌面文件夹）：
        // 必须 fail-closed 并给出指引，而不是把不可访问的 cwd 交给 shell 刷连环报错。
        let workspace = TempDir::new().unwrap();
        let locked = workspace.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        let mut permissions = std::fs::metadata(&locked).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o000);
        }
        std::fs::set_permissions(&locked, permissions).unwrap();
        let result = resolve_terminal_cwd(workspace.path(), Some("locked"));
        // 还原权限，保证 TempDir drop 清理成功。
        let mut permissions = std::fs::metadata(&locked).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o755);
        }
        std::fs::set_permissions(&locked, permissions).unwrap();
        let message = result.unwrap_err();
        assert!(
            message.contains("终端目录不可访问"),
            "unexpected: {message}"
        );
        assert!(message.contains("locked"), "error should name the path");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stdin_gesture_requires_terminal_focus_and_is_single_consumption() {
        let state = TerminalGestureState::default();
        // 未聚焦：原生 keyDown 不授予配额，写入被拒
        grant_stdin_gesture(&state);
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_err());
        // 聚焦：keyDown 授予一个配额，写入成功
        set_terminal_focus_state(&state, true);
        grant_stdin_gesture(&state);
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_ok());
        // 单次消费：同一按键不能驱动第二次写入
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fast_sequential_keystrokes_each_grant_one_write() {
        // 快速连续输入：每个 keyDown 一个配额，写入可逐个消费（不被覆盖丢失）
        let state = TerminalGestureState::default();
        set_terminal_focus_state(&state, true);
        for _ in 0..5 {
            grant_stdin_gesture(&state);
        }
        for _ in 0..5 {
            assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_ok());
        }
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stdin_gesture_expires_after_the_window() {
        let state = TerminalGestureState::default();
        set_terminal_focus_state(&state, true);
        grant_stdin_gesture(&state);
        // 把授予时间拨到窗口之外：陈旧配额必须整体失效并被拒绝
        *state.last_granted_at.lock().unwrap() =
            Some(Instant::now() - USER_GESTURE_WINDOW - Duration::from_secs(1));
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_err());
        // 失效后配额被清空，后续写入仍被拒
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn blur_clears_pending_stdin_gesture() {
        let state = TerminalGestureState::default();
        set_terminal_focus_state(&state, true);
        grant_stdin_gesture(&state);
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_ok());
        // 失焦：清空未消费配额，且后续按键不再授予配额
        set_terminal_focus_state(&state, false);
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_err());
        grant_stdin_gesture(&state);
        assert!(consume_stdin_gesture(&state, USER_GESTURE_WINDOW).is_err());
    }

    #[test]
    fn terminal_event_data_is_base64_encoded() {
        let event = TerminalEvent::data("term-1", b"hi".to_vec());
        let encoded = event.data.as_deref().expect("data payload");
        assert_eq!(encoded, "aGk=");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("valid base64");
        assert_eq!(decoded, b"hi".to_vec());
        // done 事件不带数据载荷。
        let done = TerminalEvent::done("term-1", Some(0));
        assert!(done.data.is_none());
    }

    /// 记录全部写入字节的假 PTY 写端：验证专用写线程的顺序与退出语义。
    #[derive(Clone)]
    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);
    impl Write for RecordingWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn stdin_writer_preserves_fifo_order_and_exits_when_channel_closes() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let (sender, writer_thread) =
            spawn_stdin_writer(Box::new(RecordingWriter(Arc::clone(&recorded))));
        {
            let sender = sender.lock().unwrap();
            sender.send(b"ax".to_vec()).unwrap();
            sender.send(b"iom".to_vec()).unwrap();
        }
        // 投递口 drop → 通道关闭 → 线程排空后退出（join 确定性收尾）。
        drop(sender);
        writer_thread.join().unwrap();
        assert_eq!(*recorded.lock().unwrap(), b"axiom".to_vec());
    }
}
