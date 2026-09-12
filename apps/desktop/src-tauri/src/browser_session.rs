//! browser 工具宿主会话：管理系统 Chromium 系浏览器子进程并经 CDP
//! （Chrome DevTools Protocol）驱动。对齐 Codex/ZCode 的 Browser Use 形态：
//! 宿主进程持有浏览器，模型只发受限的 JSON 动作，观测面以结构化
//! Accessibility 树文本快照为主、截图为辅。
//!
//! 安全边界（全部 Rust 权威强制，schema 层校验只是前置过滤）：
//! - 可执行文件 allowlist：显式路径必须落在 `/Applications` 或 `~/Applications`
//!   下已知 Chromium 系 bundle 的标准布局内——受陷渲染进程无法借 localStorage
//!   注入任意二进制执行（spawn 面等价一条命令通道，必须收口）；
//! - 独立隔离 profile（`~/.axiom/browser/profile`，0700）：不含用户登录态，
//!   爆炸半径限「无凭据的匿名会话」，这也是 MVP 不消费审批租赁的依据；
//! - CDP 端口仅回环 + 不加 `--remote-allow-origins` 且 WS 客户端不发 Origin
//!   头：页面 JS 的 WebSocket 请求必带 Origin，无法反向连接 DevTools 端口
//!   接管浏览器（`--remote-allow-origins=*` 会打开这个面，明确不加）；
//! - 子进程 `env_clear` + 最小 PATH：API Key 不进入浏览器进程；
//! - navigate/newTab 仅 http/https（含 localhost——与 web_fetch 的公网 only
//!   是两个信任档：浏览器是模型可见的导航通道，dev server 验证是主要用例）；
//! - 输出上限：快照 200 KiB 字符、截图 4 MiB（超限自动降采样）、文本输入
//!   20000 字符。
//!
//! 面板实时同步（对齐 Codex/ZCode 的共享视图形态）：
//! - 实时画面走 CDP screencast 增量 JPEG 帧事件（`axiom:browser-frame`），
//!   替代整帧截图轮询；帧只经事件推送，模型截图仍走 captureScreenshot；
//! - tab 列表 / 导航 / 对话框 / 进程状态经事件总线（`axiom:browser-*`）推送，
//!   面板无需手动刷新；
//! - console 输出与运行时异常按 tab 环形缓冲（`Runtime`/`Log` 域被动观测，
//!   不执行页面代码），模型经 `console` 动作读取——dev server 验证的主要观测面。
//!
//! 与 web_access 的关系：web_search/web_fetch 是无人值守的只读公网通道
//! （PublicOnly），browser 是可见导航通道（允许 localhost/私网目标），二者
//! 信任档与校验策略刻意分离，不共用校验函数。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Cursor;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

const MAX_URL_CHARS: usize = 2048;
const MAX_SNAPSHOT_CHARS: usize = 200 * 1024;
const MAX_SCREENSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_INPUT_CHARS: usize = 20_000;
const MAX_TABS: usize = 16;
/// console 环形缓冲容量（每 tab 独立，只保留最近条目）。
const MAX_CONSOLE_ENTRIES: usize = 200;
/// 单条 console 文本截断上限（字符）。
const MAX_CONSOLE_ENTRY_CHARS: usize = 500;
/// console 动作默认返回条数。
const DEFAULT_CONSOLE_LIMIT: usize = 50;

/// 首启就绪超时：默认 10s 在高负载机器（负载 10+）上会被瞬时波动打穿——
/// 模型/IDE/系统服务共跑时 Chrome 首次初始化可达 20s+。25s 覆盖后重试成本
/// 可接受（复用运行时返回零等待，失败路径只多等）。
const SPAWN_READY_TIMEOUT: Duration = Duration::from_secs(25);
const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const NAVIGATE_LOAD_TIMEOUT: Duration = Duration::from_secs(15);
const TERMINATION_GRACE_MS: u64 = 500;
/// 残留实例清理宽限：SIGTERM 后给 Chrome 落盘 profile 的时间（秒退自愈路径）。
const STALE_HOLDER_GRACE_MS: u64 = 1500;
const MINIMAL_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
/// screencast 帧节流最小间隔：滚动/视频时 Chrome 可能高频产帧，超频的中间
/// 帧直接丢弃（ack 已发不影响流），控制事件 IPC 开销。
const SCREENCAST_MIN_FRAME_INTERVAL: Duration = Duration::from_millis(100);
/// screencast JPEG 质量（0-100）：面板预览档位，模型观测仍走 PNG 截图。
const SCREENCAST_JPEG_QUALITY: u8 = 70;
/// 面板 tab 列表轮询间隔（/json/list 是本机回环 HTTP，开销可忽略）。
const TABS_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// 进程存活监视间隔：意外退出（崩溃/被手动关闭）秒级通知面板。
const STATUS_WATCH_INTERVAL: Duration = Duration::from_secs(1);

/// Chromium 系浏览器 bundle 名（macOS 可执行文件名与 bundle 名一致的约定）。
const BROWSER_EXECUTABLE_NAMES: &[&str] = &["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"];

// ---------------------------------------------------------------------------
// 请求 / 响应契约（TS 侧 platform/browserSession.ts 逐字镜像）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSpawnConfig {
    #[serde(default)]
    pub enabled: bool,
    /// 空串 = 自动探测（auto 档按固定候选序取第一个已安装引擎）。
    #[serde(default)]
    pub executable_path: String,
    #[serde(default = "default_headless")]
    pub headless: bool,
}

fn default_headless() -> bool {
    true
}

#[derive(Debug, Deserialize)]
// rename_all 重命名变体名（action 判别值），rename_all_fields 重命名变体字段
// （tabId/imageBase64 等）——枚举级 rename_all 不会作用于字段，漏掉会让 TS 侧
// camelCase 载荷反序列化直接失败。
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BrowserCommandRequest {
    Detect,
    ValidateExecutable { path: String },
    Status,
    EnsureRunning { config: BrowserSpawnConfig },
    Shutdown,
    Tabs,
    NewTab {
        #[serde(default)]
        url: Option<String>,
    },
    CloseTab { tab_id: String },
    ActivateTab { tab_id: String },
    Navigate { tab_id: String, url: String },
    Snapshot { tab_id: String },
    Click { tab_id: String, r#ref: i64 },
    Fill { tab_id: String, r#ref: i64, text: String },
    TypeText {
        tab_id: String,
        #[serde(default)]
        r#ref: Option<i64>,
        text: String,
    },
    Press {
        tab_id: String,
        key: String,
        #[serde(default)]
        r#ref: Option<i64>,
    },
    Scroll {
        tab_id: String,
        #[serde(default)]
        r#ref: Option<i64>,
        #[serde(default)]
        delta_x: Option<f64>,
        #[serde(default)]
        delta_y: Option<f64>,
    },
    Screenshot { tab_id: String },
    Back { tab_id: String },
    Forward { tab_id: String },
    NavigationHistory { tab_id: String },
    Reload { tab_id: String },
    Dialog { tab_id: String },
    RespondDialog {
        tab_id: String,
        accept: bool,
        #[serde(default)]
        prompt_text: Option<String>,
    },
    /// 开启面板实时画面（CDP screencast）。maxWidth/maxHeight 由面板按显示
    /// 尺寸传入，Chrome 等比缩放控制帧体积；不传则按视口原始尺寸。
    StartScreencast {
        tab_id: String,
        #[serde(default)]
        max_width: Option<u32>,
        #[serde(default)]
        max_height: Option<u32>,
    },
    StopScreencast { tab_id: String },
    /// 读取页面 console 输出与运行时错误（dev server 验证的主要观测面）。
    Console {
        tab_id: String,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// 面板预览上的用户手势点击（视口坐标）。与 click（ref 锚点）是两个入口：
    /// 坐标来自用户在预览上的真实点击，不进 Agent 工具 schema——用户亲手操作
    /// 通道，类比终端 stdin 不属于逐次审批命令面。
    ClickAt { tab_id: String, x: f64, y: f64 },
    ScrollAt {
        tab_id: String,
        x: f64,
        y: f64,
        #[serde(default)]
        delta_x: Option<f64>,
        #[serde(default)]
        delta_y: Option<f64>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineInfo {
    pub engine: String,
    pub path: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub active: bool,
    pub has_dialog: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsDialogInfo {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BrowserCommandResponse {
    Detected { engines: Vec<BrowserEngineInfo> },
    ExecutableValid { path: String, engine: String },
    Status {
        running: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        engine: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        headless: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tabs: Option<usize>,
    },
    Tabs { tabs: Vec<BrowserTabInfo> },
    TabOpened { tab: BrowserTabInfo },
    Navigated { url: String, title: String },
    Snapshot {
        url: String,
        title: String,
        text: String,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        dialog: Option<JsDialogInfo>,
    },
    Screenshot {
        image_base64: String,
        mime_type: String,
        width: u32,
        height: u32,
        resized: bool,
    },
    DialogState {
        #[serde(skip_serializing_if = "Option::is_none")]
        dialog: Option<JsDialogInfo>,
    },
    NavigationState {
        can_go_back: bool,
        can_go_forward: bool,
    },
    ScreencastStarted,
    ConsoleLog { entries: Vec<ConsoleEntry> },
    Done,
}

// ---------------------------------------------------------------------------
// WebView 事件载荷（TS 侧 platform/browserSession.ts 逐字镜像）
// ---------------------------------------------------------------------------

const BROWSER_FRAME_EVENT: &str = "axiom:browser-frame";
const BROWSER_TABS_EVENT: &str = "axiom:browser-tabs";
const BROWSER_STATUS_EVENT: &str = "axiom:browser-status";
const BROWSER_DIALOG_EVENT: &str = "axiom:browser-dialog";
const BROWSER_NAVIGATED_EVENT: &str = "axiom:browser-navigated";
const BROWSER_CONSOLE_EVENT: &str = "axiom:browser-console";

/// screencast 增量帧（JPEG base64）。宽度/高度来自帧 metadata（设备像素，
/// 含 DPR 缩放后的实际捕获尺寸）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFrameEvent {
    pub tab_id: String,
    pub image_base64: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

/// console/运行时错误条目。level：error/warning/info/log/debug；source：
/// console（console.* 调用）/ exception（未捕获异常）/ network 等日志来源。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
    pub source: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleEvent {
    pub tab_id: String,
    pub entry: ConsoleEntry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabsEvent {
    pub tabs: Vec<BrowserTabInfo>,
}

/// 进程状态变化：running=true 仅在成功启动后发一次；false 附带原因（意外
/// 退出时非空，显式关闭为空）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatusEvent {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDialogEvent {
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dialog: Option<JsDialogInfo>,
}

/// 主 frame 导航：地址栏即时同步（标题由 tabs 轮询补齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigatedEvent {
    pub tab_id: String,
    pub url: String,
}

// ---------------------------------------------------------------------------
// 校验与探测（纯函数，单测锁定）
// ---------------------------------------------------------------------------

fn home_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn expand_tilde(raw: &str, home: Option<&Path>) -> PathBuf {
    if let Some(home) = home {
        if let Some(rest) = raw.strip_prefix("~/") {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

/// 已知 bundle 的标准安装路径候选（/Applications 优先于 ~/Applications）。
fn engine_candidate_paths(home: Option<&Path>, name: &str) -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("/Applications")
        .join(format!("{name}.app"))
        .join("Contents/MacOS")
        .join(name)];
    if let Some(home) = home {
        candidates.push(
            home.join("Applications")
                .join(format!("{name}.app"))
                .join("Contents/MacOS")
                .join(name),
        );
    }
    candidates
}

fn detect_engines(home: Option<&Path>) -> Vec<BrowserEngineInfo> {
    BROWSER_EXECUTABLE_NAMES
        .iter()
        .map(|name| {
            let candidates = engine_candidate_paths(home, name);
            let found = candidates.iter().find(|path| path.is_file());
            BrowserEngineInfo {
                engine: (*name).to_string(),
                path: found
                    .or(candidates.first())
                    .map(|path| path.display().to_string())
                    .unwrap_or_default(),
                available: found.is_some(),
            }
        })
        .collect()
}

/// 校验显式可执行路径：必须命中 `/Applications` 或 `~/Applications` 下已知
/// Chromium 系 bundle 的标准布局（`<Bundle>.app/Contents/MacOS/<Bundle>`）。
/// allowlist 而非签名校验：spawn 面等价命令执行通道，收口到「用户可见安装的
/// 浏览器」即可阻断受陷渲染进程注入任意二进制。
fn validate_browser_executable(raw: &str, home: Option<&Path>) -> Result<(PathBuf, String), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("浏览器可执行文件路径为空".into());
    }
    let path = expand_tilde(raw, home);
    let bundle = validate_browser_executable_layout(&path, home)?;
    if !path.is_file() {
        return Err(format!("浏览器可执行文件不存在：{}", path.display()));
    }
    Ok((path, bundle))
}

/// 仅校验路径布局（bundle 名/目录结构/安装位置），不触文件系统——单测用
/// 纯函数形态锁定 allowlist 矩阵，不依赖机器上是否真的装了浏览器。
fn validate_browser_executable_layout(
    path: &Path,
    home: Option<&Path>,
) -> Result<String, String> {
    let path_str = path.to_string_lossy();
    let parts: Vec<&str> = path_str.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 5 {
        return Err(format!(
            "浏览器路径必须是 /Applications 或 ~/Applications 下 .app bundle 内的可执行文件：{path_str}"
        ));
    }
    let n = parts.len();
    let (exe, macos, contents, bundle) = (parts[n - 1], parts[n - 2], parts[n - 3], parts[n - 4]);
    let bundle_name = bundle.strip_suffix(".app").unwrap_or(bundle);
    if !BROWSER_EXECUTABLE_NAMES.contains(&bundle_name) {
        return Err(format!(
            "不支持的浏览器 bundle：{bundle}（支持：{}）",
            BROWSER_EXECUTABLE_NAMES.join(" / ")
        ));
    }
    if exe != bundle_name || macos != "MacOS" || contents != "Contents" {
        return Err("浏览器路径不是标准的 .app bundle 可执行文件布局".into());
    }
    let in_root_applications = path.starts_with("/Applications/");
    let in_home_applications = home
        .map(|home| path.starts_with(home.join("Applications")))
        .unwrap_or(false);
    if !in_root_applications && !in_home_applications {
        return Err("浏览器必须安装在 /Applications 或 ~/Applications 下".into());
    }
    Ok(bundle_name.to_string())
}

/// 解析最终可执行文件：空串走 auto 探测，否则走 allowlist 校验。
fn resolve_executable(explicit: &str, home: Option<&Path>) -> Result<(PathBuf, String), String> {
    if explicit.trim().is_empty() {
        for name in BROWSER_EXECUTABLE_NAMES {
            if let Some(candidate) = engine_candidate_paths(home, name)
                .into_iter()
                .find(|path| path.is_file())
            {
                return Ok((candidate, (*name).to_string()));
            }
        }
        return Err(
            "未检测到 Chromium 系浏览器（Google Chrome / Chromium / Microsoft Edge / Brave），请在 设置 → 浏览器 选择或填写可执行文件路径".into(),
        );
    }
    validate_browser_executable(explicit, home)
}

/// 导航 URL 校验：仅 http/https（浏览器是可见导航通道，localhost/私网放行，
/// 与 web_fetch 的 PublicOnly 刻意不同档）；长度与 userinfo 约束对齐 web_access。
fn validate_navigation_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("URL 不能为空".into());
    }
    if url.chars().count() > MAX_URL_CHARS {
        return Err(format!("URL 长度不得超过 {MAX_URL_CHARS} 字符"));
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("URL 无法解析：{url}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("仅支持 http/https URL（收到 {other}）")),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL 不得携带 userinfo 凭据".into());
    }
    Ok(url.to_string())
}

/// Chrome 启动参数（纯函数供单测锁定）。安全要点：不加 `--remote-allow-origins`
/// （页面 JS 带 Origin 的 WS 无法连 DevTools）；user-data-dir 由调用方注入。
fn chrome_args(port: u16, user_data_dir: &Path, headless: bool) -> Vec<String> {
    let mut args = Vec::new();
    if headless {
        args.push("--headless=new".into());
    }
    args.extend([
        format!("--remote-debugging-port={port}"),
        format!("--user-data-dir={}", user_data_dir.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--window-size=1280,800".into(),
        "--disable-sync".into(),
        "--disable-background-networking".into(),
        "--disable-client-side-phishing-detection".into(),
        "--disable-component-update".into(),
        // 弹窗拦截会静默吞掉新开窗口，破坏「动作后观测受控/用户 tab」的闭环，
        // 关闭以保证模型可见的行为确定性。
        "--disable-popup-blocking".into(),
        "about:blank".into(),
    ]);
    args
}

/// 子进程环境：env_clear + 白名单透传 + 最小 PATH。浏览器不需要工作区工具链，
/// PATH 收到系统四目录即可（Chrome 的辅助进程都在 bundle 内解析）。
fn configure_browser_environment(command: &mut Command) {
    command.env_clear();
    for name in crate::workspace_command::PASSTHROUGH_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("PATH", MINIMAL_PATH);
}

fn pick_loopback_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("分配回环端口失败：{error}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| format!("读取回环端口失败：{error}"))
}

fn browser_profile_dir(data_root: &Path) -> Result<PathBuf, String> {
    let dir = data_root.join("browser").join("profile");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建浏览器 profile 目录失败：{error}"))?;
    crate::storage_paths::set_directory_permissions(&dir)?;
    Ok(dir)
}

/// spawn 浏览器子进程（端口/headless 由调用方决定，供首航与自愈重试复用）。
fn spawn_browser_process(
    executable: &Path,
    port: u16,
    profile_dir: &Path,
    headless: bool,
) -> Result<Child, String> {
    let mut command = Command::new(executable);
    command
        .args(chrome_args(port, profile_dir, headless))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    configure_browser_environment(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 独立进程组：shutdown 时可以整组发信号，覆盖 Chrome 派生的辅助进程。
        // tokio Command 未镜像该选项，落到内部 std Command 上设置。
        command.as_std_mut().process_group(0);
    }
    command
        .spawn()
        .map_err(|error| format!("启动浏览器失败（{}）：{error}", executable.display()))
}

fn process_alive(pid: i32) -> bool {
    unsafe {
        match libc::kill(pid, 0) {
            0 => true,
            // EPERM 也说明进程还在（无权限发信号）；只有 ESRCH 是已死。
            _ => std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH),
        }
    }
}

/// 组信号优先（覆盖 Chrome 派生的辅助进程）；pid 不是组长（历史版本 spawn
/// 未设进程组）时回退单进程信号。
fn signal_process(pid: i32, signal: i32) {
    unsafe {
        if libc::kill(-pid, signal) != 0 {
            libc::kill(pid, signal);
        }
    }
}

/// 扫描命令行携带本 profile `--user-data-dir` 的进程。profile 目录 Axiom
/// 独占，能命中的只会是 Axiom 自己 spawn 的浏览器实例（含上次应用异常
/// 退出遗留的孤儿），不会误伤用户自己的浏览器。
fn find_stale_profile_holders(profile_dir: &Path) -> Vec<i32> {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .arg("axww")
        .arg("-o")
        .arg("pid=,command=")
        .output()
    else {
        return Vec::new();
    };
    let needle = format!("--user-data-dir={}", profile_dir.display());
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim_start().splitn(2, char::is_whitespace);
            let pid = fields.next()?.parse::<i32>().ok()?;
            let command = fields.next().unwrap_or("");
            command.contains(needle.as_str()).then_some(pid)
        })
        .collect()
}

/// 无活体持有者时清理残留单实例锁（SingletonLock/Socket/Cookie）。
/// Axiom 崩溃/强杀不走 reap 路径，Chrome 退出后锁文件会原地残留——新实例
/// 每次都要先博弈死锁再接管（实测接管耗时波动）。仅当扫描不到持有进程才
/// 清理：有活体时删锁会给新实例开并发写同一 profile 的口子。
fn cleanup_stale_locks_if_unheld(profile_dir: &Path) {
    if find_stale_profile_holders(profile_dir).is_empty() {
        for marker in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
            let _ = std::fs::remove_file(profile_dir.join(marker));
        }
    }
}

/// 终止持有 profile 的残留浏览器实例并清理单实例标记，返回是否真的终止了
/// 存活进程。SIGTERM 进程组让 Chrome 落盘 profile，宽限后 SIGKILL 兜底；
/// 单实例标记（symlink/socket）必须在持锁进程死后才清理，顺序颠倒会给
/// 「标记已不在」的新实例开并发写同一 profile 的口子。
async fn terminate_stale_profile_holders(profile_dir: &Path) -> bool {
    let pids = find_stale_profile_holders(profile_dir);
    if pids.is_empty() {
        return false;
    }
    for pid in &pids {
        signal_process(*pid, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(STALE_HOLDER_GRACE_MS);
    while pids.iter().any(|pid| process_alive(*pid)) {
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    for pid in &pids {
        signal_process(*pid, libc::SIGKILL);
    }
    for marker in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
        let _ = std::fs::remove_file(profile_dir.join(marker));
    }
    true
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct JsDialogState {
    kind: String,
    message: String,
}

/// CDP 响应等待表：命令 id → oneshot 回传通道。
type CdpPending = Arc<StdMutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// per-tab 事件出口：socket 读路径产生的帧/console/对话框事件经此 emit 到
/// WebView。AppHandle 可廉价克隆，每个 socket 任务持有独立副本。
#[derive(Clone)]
struct TabEventSink {
    app: AppHandle,
    tab_id: String,
}

#[derive(Default)]
struct ScreencastState {
    active: bool,
    last_emit: Option<std::time::Instant>,
}

/// 单个 tab 的 CDP 会话：一条 WebSocket 连接 + 派发任务。命令经 mpsc 送入
/// socket 任务写出，响应按 id 匹配 oneshot 回传；事件消费 loadEventFired
/// （导航等待）、javascriptDialogOpening/Closed（对话框）、frameNavigated
/// （地址同步）、screencastFrame（实时画面）、Runtime/Log（console 观测）。
struct CdpTab {
    outgoing: mpsc::Sender<String>,
    pending: CdpPending,
    next_id: AtomicI64,
    /// loadEventFired 计数：导航前取基线，等待计数增长即「下一次 load 完成」。
    load_tx: watch::Sender<u64>,
    dialog: Arc<StdMutex<Option<JsDialogState>>>,
    /// console/运行时错误环形缓冲（Runtime/Log 域被动观测）。
    console: Arc<StdMutex<VecDeque<ConsoleEntry>>>,
    screencast: Arc<StdMutex<ScreencastState>>,
    /// 事件出口；None（单元测试路径）时所有 emit 静默丢弃。
    events: Option<TabEventSink>,
}

impl CdpTab {
    fn load_generation(&self) -> u64 {
        *self.load_tx.borrow()
    }

    /// 等待 load 计数超过基线。超时不报错：SPA 路由可能不再触发整页 load，
    /// 导航成败以最终 URL/快照为准（对齐 Codex 的「按效果判定」纪律）。
    async fn wait_load(&self, after: u64, timeout: Duration) {
        let mut receiver = self.load_tx.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        while *receiver.borrow_and_update() <= after {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() || tokio::time::timeout(remaining, receiver.changed()).await.is_err() {
                return;
            }
        }
    }

    async fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "CDP pending 锁中毒".to_string())?;
            pending.insert(id, tx);
        }
        let payload = json!({"id": id, "method": method, "params": params});
        if self.outgoing.send(payload.to_string()).await.is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err("CDP 连接已关闭".into());
        }
        match tokio::time::timeout(CDP_COMMAND_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("CDP 响应通道已关闭".into()),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("CDP 命令超时：{method}"))
            }
        }
    }

    fn dialog_info(&self) -> Option<JsDialogInfo> {
        self.dialog
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|state| JsDialogInfo {
                kind: state.kind.clone(),
                message: state.message.clone(),
            }))
    }
}

fn handle_cdp_frame(tab: &CdpTab, text: &str) {
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return,
    };
    if let Some(id) = value.get("id").and_then(Value::as_i64) {
        if let Ok(mut pending) = tab.pending.lock() {
            if let Some(sender) = pending.remove(&id) {
                let error = value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str);
                let outcome = match error {
                    Some(message) => Err(message.to_string()),
                    None => match value.get("result") {
                        Some(result) => Ok(result.clone()),
                        None => Err("CDP 响应缺少 result".into()),
                    },
                };
                let _ = sender.send(outcome);
            }
        }
        return;
    }
    match value.get("method").and_then(Value::as_str) {
        Some("Page.loadEventFired") => tab.load_tx.send_modify(|count| *count += 1),
        Some("Page.javascriptDialogOpening") => {
            if let Ok(mut slot) = tab.dialog.lock() {
                *slot = Some(JsDialogState {
                    kind: value
                        .pointer("/params/type")
                        .and_then(Value::as_str)
                        .unwrap_or("alert")
                        .to_string(),
                    message: value
                        .pointer("/params/message")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                });
            }
            emit_dialog_event(tab);
        }
        Some("Page.javascriptDialogClosed") => {
            if let Ok(mut slot) = tab.dialog.lock() {
                *slot = None;
            }
            emit_dialog_event(tab);
        }
        Some("Page.frameNavigated") => {
            // 主 frame 导航才同步地址栏；子 frame（iframe）导航不算页面跳转。
            let parent = value.pointer("/params/frame/parentId");
            let is_main = matches!(parent, None | Some(Value::Null));
            if is_main {
                if let Some(url) = value.pointer("/params/frame/url").and_then(Value::as_str) {
                    if let Some(sink) = &tab.events {
                        let _ = sink.app.emit(
                            BROWSER_NAVIGATED_EVENT,
                            &BrowserNavigatedEvent {
                                tab_id: sink.tab_id.clone(),
                                url: url.to_string(),
                            },
                        );
                    }
                }
            }
        }
        Some("Page.screencastFrame") => handle_screencast_frame(tab, &value),
        Some("Runtime.consoleAPICalled") => handle_console_called(tab, &value),
        Some("Runtime.exceptionThrown") => handle_exception_thrown(tab, &value),
        Some("Log.entryAdded") => handle_log_entry(tab, &value),
        _ => {}
    }
}

fn emit_dialog_event(tab: &CdpTab) {
    if let Some(sink) = &tab.events {
        let _ = sink.app.emit(
            BROWSER_DIALOG_EVENT,
            &BrowserDialogEvent {
                tab_id: sink.tab_id.clone(),
                dialog: tab.dialog_info(),
            },
        );
    }
}

/// screencast 帧处理：先 ack（Chrome 只维持少量在途帧，ack 积压会整流暂停，
/// 不能等 UI 渲染完再回），再按节流窗口决定是否把帧 emit 给面板——被丢弃的
/// 中间帧不影响流连续性（下一帧仍是最新状态）。
fn handle_screencast_frame(tab: &CdpTab, value: &Value) {
    if let Some(session_id) = value.pointer("/params/sessionId").and_then(Value::as_i64) {
        enqueue_screencast_ack(tab, session_id);
    }
    let Some(data) = value.pointer("/params/data").and_then(Value::as_str) else {
        return;
    };
    let metadata = value.pointer("/params/metadata");
    let width = metadata
        .and_then(|meta| meta.get("deviceWidth"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let height = metadata
        .and_then(|meta| meta.get("deviceHeight"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let should_emit = tab
        .screencast
        .lock()
        .map(|mut state| {
            if !state.active {
                return false;
            }
            let now = std::time::Instant::now();
            if state
                .last_emit
                .map(|last| now.duration_since(last) < SCREENCAST_MIN_FRAME_INTERVAL)
                .unwrap_or(false)
            {
                return false;
            }
            state.last_emit = Some(now);
            true
        })
        .unwrap_or(false);
    if !should_emit {
        return;
    }
    if let Some(sink) = &tab.events {
        let _ = sink.app.emit(
            BROWSER_FRAME_EVENT,
            &BrowserFrameEvent {
                tab_id: sink.tab_id.clone(),
                image_base64: data.to_string(),
                mime_type: "image/jpeg".into(),
                width,
                height,
            },
        );
    }
}

/// ack 是带 id 的常规命令：注册 pending 后经 outgoing 通道送出，响应到达时
/// 由 id 匹配路径自然回收（rx 端无人等待，结果被丢弃）。try_send 失败（通道
/// 满，意味着命令积压已异常）时放弃本帧 ack——Chrome 会暂停 screencast，
/// 面板表现为画面暂停而非错误。
fn enqueue_screencast_ack(tab: &CdpTab, session_id: i64) {
    let id = tab.next_id.fetch_add(1, Ordering::Relaxed);
    {
        let Ok(mut pending) = tab.pending.lock() else { return };
        let (tx, _rx) = oneshot::channel();
        pending.insert(id, tx);
    }
    let payload = json!({
        "id": id,
        "method": "Page.screencastFrameAck",
        "params": {"sessionId": session_id},
    });
    if tab.outgoing.try_send(payload.to_string()).is_err() {
        if let Ok(mut pending) = tab.pending.lock() {
            pending.remove(&id);
        }
    }
}

fn handle_console_called(tab: &CdpTab, value: &Value) {
    let level = match value
        .pointer("/params/type")
        .and_then(Value::as_str)
        .unwrap_or("log")
    {
        "error" => "error",
        "warning" | "warn" => "warning",
        "info" => "info",
        "debug" | "verbose" => "debug",
        _ => "log",
    };
    let text = value
        .pointer("/params/args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .map(remote_object_text)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    push_console_entry(tab, level, "console", &text);
}

fn handle_exception_thrown(tab: &CdpTab, value: &Value) {
    let Some(details) = value.pointer("/params/exceptionDetails") else {
        return;
    };
    let mut text = details
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("未捕获异常")
        .to_string();
    if let Some(description) = details
        .pointer("/exception/description")
        .and_then(Value::as_str)
    {
        text.push('：');
        text.push_str(description);
    }
    push_console_entry(tab, "error", "exception", &text);
}

fn handle_log_entry(tab: &CdpTab, value: &Value) {
    let Some(entry) = value.pointer("/params/entry") else {
        return;
    };
    let level = match entry.get("level").and_then(Value::as_str).unwrap_or("") {
        "error" => "error",
        "warning" => "warning",
        _ => "info",
    };
    let source = entry
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("network")
        .to_string();
    let text = entry.get("text").and_then(Value::as_str).unwrap_or("");
    push_console_entry(tab, level, &source, text);
}

/// RemoteObject → 文本：原始值优先（string/number/bool），对象/函数取
/// description（Chrome 自带的摘要，含构造信息），再退回类型名。
fn remote_object_text(value: &Value) -> String {
    match value.get("value") {
        Some(Value::String(text)) => return text.clone(),
        Some(Value::Number(number)) => return number.to_string(),
        Some(Value::Bool(flag)) => return flag.to_string(),
        _ => {}
    }
    value
        .get("description")
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

/// console 条目入缓冲 + emit 给面板。缓冲只保留最近 MAX_CONSOLE_ENTRIES 条
/// （环形），单条文本截断到 MAX_CONSOLE_ENTRY_CHARS 字符。
fn push_console_entry(tab: &CdpTab, level: &str, source: &str, raw: &str) {
    let text = truncate_chars(raw, MAX_CONSOLE_ENTRY_CHARS);
    if text.is_empty() {
        return;
    }
    let entry = ConsoleEntry {
        level: level.to_string(),
        text,
        source: source.to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    };
    if let Ok(mut buffer) = tab.console.lock() {
        buffer.push_back(entry.clone());
        while buffer.len() > MAX_CONSOLE_ENTRIES {
            buffer.pop_front();
        }
    }
    if let Some(sink) = &tab.events {
        let _ = sink.app.emit(
            BROWSER_CONSOLE_EVENT,
            &BrowserConsoleEvent {
                tab_id: sink.tab_id.clone(),
                entry,
            },
        );
    }
}

/// 按字符数截断（UTF-8 边界安全），超限追加省略标记。
fn truncate_chars(raw: &str, max_chars: usize) -> String {
    if raw.chars().count() <= max_chars {
        return raw.to_string();
    }
    let truncated: String = raw.chars().take(max_chars).collect();
    format!("{truncated}…")
}

async fn run_cdp_socket(
    mut ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    mut outgoing: mpsc::Receiver<String>,
    tab: Arc<CdpTab>,
) {
    loop {
        tokio::select! {
            message = outgoing.recv() => {
                match message {
                    Some(text) => {
                        if ws.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            message = ws.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        handle_cdp_frame(&tab, &text);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
        }
    }
    // 连接关闭：唤醒所有等待者，避免悬挂到命令超时。
    if let Ok(mut pending) = tab.pending.lock() {
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err("CDP 连接已关闭".into()));
        }
    }
}

/// 连接 tab 的 DevTools WebSocket。tokio-tungstenite 客户端默认不携带 Origin
/// 头——配合服务端不加 `--remote-allow-origins`，页面 JS 无法连接同端口。
/// app 提供 per-tab 事件出口（帧/console/对话框 emit），None 时静默。
async fn connect_tab(
    ws_url: &str,
    app: Option<&AppHandle>,
    tab_id: &str,
) -> Result<Arc<CdpTab>, String> {
    let (stream, _response) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|error| format!("连接浏览器调试通道失败：{error}"))?;
    let (outgoing_tx, outgoing_rx) = mpsc::channel(32);
    let (load_tx, _) = watch::channel(0u64);
    let tab = Arc::new(CdpTab {
        outgoing: outgoing_tx,
        pending: Arc::new(StdMutex::new(HashMap::new())),
        next_id: AtomicI64::new(1),
        load_tx,
        dialog: Arc::new(StdMutex::new(None)),
        console: Arc::new(StdMutex::new(VecDeque::new())),
        screencast: Arc::new(StdMutex::new(ScreencastState::default())),
        events: app.map(|app| TabEventSink {
            app: app.clone(),
            tab_id: tab_id.to_string(),
        }),
    });
    tokio::spawn(run_cdp_socket(stream, outgoing_rx, Arc::clone(&tab)));
    tab.send("Page.enable", json!({}))
        .await
        .map_err(|error| format!("启用 Page 域失败：{error}"))?;
    // Runtime/Log 域是被动观测（console 输出 / 运行时异常 / 网络错误日志），
    // 启用失败不阻断连接——console 观测是增强面，个别引擎缺支持时动作返回空。
    let _ = tab.send("Runtime.enable", json!({})).await;
    let _ = tab.send("Log.enable", json!({})).await;
    Ok(tab)
}

// ---------------------------------------------------------------------------
// DevTools HTTP 端点（tab 注册表）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevtoolsTarget {
    id: String,
    #[serde(rename = "type")]
    target_type: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    web_socket_debugger_url: Option<String>,
}

fn loopback_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("构造 DevTools HTTP 客户端失败：{error}"))
}

async fn list_targets(port: u16) -> Result<Vec<DevtoolsTarget>, String> {
    let client = loopback_client()?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .map_err(|error| format!("列出浏览器 tab 失败：{error}"))?;
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取浏览器 tab 列表失败：{error}"))?;
    let targets: Vec<DevtoolsTarget> = serde_json::from_str(&text)
        .map_err(|error| format!("解析浏览器 tab 列表失败：{error}"))?;
    Ok(targets
        .into_iter()
        .filter(|target| {
            target.target_type == "page" && !target.url.starts_with("devtools://")
        })
        .collect())
}

async fn new_target(port: u16) -> Result<DevtoolsTarget, String> {
    let client = loopback_client()?;
    let url = format!("http://127.0.0.1:{port}/json/new?about:blank");
    // 新版 Chrome 要求 PUT（GET 返回 405）；对旧版做一次回退。
    let mut response = client.put(&url).send().await.map_err(|error| format!("新建 tab 失败：{error}"))?;
    if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        response = client.get(&url).send().await.map_err(|error| format!("新建 tab 失败：{error}"))?;
    }
    if !response.status().is_success() {
        return Err(format!("新建 tab 失败：HTTP {}", response.status()));
    }
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取新建 tab 响应失败：{error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析新建 tab 响应失败：{error}"))
}

async fn close_target(port: u16, target_id: &str) -> Result<(), String> {
    let client = loopback_client()?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/close/{target_id}"))
        .send()
        .await
        .map_err(|error| format!("关闭 tab 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("关闭 tab 失败：HTTP {}", response.status()));
    }
    Ok(())
}

/// spawn 后的就绪等待结果。秒退与「真的卡在启动」必须可区分：秒退几乎总是
/// profile 被残留实例占用（Chrome 单实例机制把命令转交旧实例后退出），可
/// 自愈；卡住是环境问题，只能报错。
enum SpawnWaitOutcome {
    Ready(String),
    ExitedImmediately,
    TimedOut,
}

/// 等待 DevTools 就绪，同时轮询子进程存活。只等 HTTP 端点的话，转交秒退
/// 要空耗满整个就绪超时才能被 try_wait 事后识别；边等边查存活让秒退在
/// 百毫秒级进入自愈路径。
async fn wait_ready_or_exit(port: u16, child: &mut Child) -> SpawnWaitOutcome {
    let Ok(client) = loopback_client() else {
        return SpawnWaitOutcome::TimedOut;
    };
    let deadline = tokio::time::Instant::now() + SPAWN_READY_TIMEOUT;
    loop {
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{port}/json/version"))
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(text) = response.text().await {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        return SpawnWaitOutcome::Ready(
                            value
                                .get("Browser")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                                .to_string(),
                        );
                    }
                }
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => return SpawnWaitOutcome::ExitedImmediately,
            Ok(None) => {}
            // 状态读取失败按「未知」处理：等到超时走既有的超时报错路径。
            Err(_) => return SpawnWaitOutcome::TimedOut,
        }
        if tokio::time::Instant::now() >= deadline {
            return SpawnWaitOutcome::TimedOut;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

// ---------------------------------------------------------------------------
// 运行时状态与会话操作
// ---------------------------------------------------------------------------

struct BrowserRuntime {
    child: Child,
    port: u16,
    engine: String,
    headless: bool,
    version: String,
    tabs: HashMap<String, Arc<CdpTab>>,
    /// 当前激活 tab：open_new_tab/activate_tab 更新，close_tab 命中时清除。
    /// /json/list 不暴露 active 标记，靠自身记录（无记录时以首位近似）。
    active_tab_id: Option<String>,
}

/// 浏览器会话状态。显式 shutdown 走 SIGTERM 优雅退出；应用退出路径由
/// `reap_browser_for_exit` 兜底——kill_on_drop 只覆盖 Rust drop，而 macOS
/// 关窗退出走 Cocoa 终止路径不执行 drop，不兜底会留下孤儿 Chrome 锁死
/// profile。Axiom 自身被强杀仍会遗留孤儿：ensure_running 首航秒退时自动
/// 终止持有 profile 的残留实例并重试（秒退自愈），用户无需手动清理。
#[derive(Default)]
pub struct BrowserSessionState(StdMutex<Option<BrowserRuntime>>);

struct RuntimeInfoSnapshot {
    port: u16,
    engine: String,
    headless: bool,
    version: String,
    tabs: usize,
}

fn runtime_info(runtime: &BrowserRuntime) -> RuntimeInfoSnapshot {
    RuntimeInfoSnapshot {
        port: runtime.port,
        engine: runtime.engine.clone(),
        headless: runtime.headless,
        version: runtime.version.clone(),
        tabs: runtime.tabs.len(),
    }
}

/// 启动（或复用）浏览器。子进程已死时清状态重建（崩溃自愈）。app 提供事件
/// 出口与面板同步轮询器的拉起（None = 测试路径）。
async fn ensure_running(
    app: Option<&AppHandle>,
    data_root: &Path,
    state: &BrowserSessionState,
    config: &BrowserSpawnConfig,
) -> Result<BrowserCommandResponse, String> {
    if !config.enabled {
        return Err("浏览器能力未启用：请在 设置 → 浏览器 打开开关并保存".into());
    }
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "browser state lock poisoned".to_string())?;
        if let Some(runtime) = guard.as_mut() {
            if runtime.child.try_wait().map_err(|error| error.to_string())?.is_none() {
                let info = runtime_info(runtime);
                return Ok(status_response(true, Some(info)));
            }
        }
    }
    let home = home_path();
    let (executable, engine) = resolve_executable(&config.executable_path, home.as_deref())?;
    let profile_dir = browser_profile_dir(data_root)?;
    // 无活体时清掉崩溃残留的单实例锁：省掉 Chrome 新实例的接管博弈
    // （崩溃/强杀不走 reap_browser_for_exit，锁会原地残留）。
    cleanup_stale_locks_if_unheld(&profile_dir);
    // 秒退自愈：Chrome 单实例机制会把命令转交给持有同一 profile 的存活实例
    // （上次应用异常退出遗留的孤儿）后立即退出。首航秒退时终止残留实例、
    // 清单实例标记并重试一次；重试仍秒退才把手动修复指引交给用户。
    let mut cleanup_attempted = false;
    let mut killed_stale = false;
    let (child, port, version) = loop {
        let port = pick_loopback_port()?;
        let mut child = spawn_browser_process(&executable, port, &profile_dir, config.headless)?;
        match wait_ready_or_exit(port, &mut child).await {
            SpawnWaitOutcome::Ready(version) => break (child, port, version),
            SpawnWaitOutcome::TimedOut => {
                // 高负载（IDE/系统服务共跑）或首次初始化慢都会打穿 10s 档；
                // 直接重试是首选动作，反复超时才需要排查系统策略/杀软。
                return Err(format!(
                    "浏览器调试端口就绪超时（{}s）：窗口期负载过高或首次启动较慢，可直接重试；若多次重试仍超时，请检查系统安全策略是否阻止了浏览器启动",
                    SPAWN_READY_TIMEOUT.as_secs()
                ));
            }
            SpawnWaitOutcome::ExitedImmediately => {
                if cleanup_attempted {
                    return Err(if killed_stale {
                        "已自动终止残留浏览器实例后重试，浏览器进程仍立即退出。请手动退出所有占用 Axiom 浏览器 profile（~/.axiom/browser）的浏览器进程后重试。".into()
                    } else {
                        "浏览器进程启动后立即退出，且未发现占用配置目录的残留实例。请确认浏览器可执行文件可用（设置 → 浏览器 → 测试连接），或检查系统安全策略是否阻止其启动。".into()
                    });
                }
                cleanup_attempted = true;
                drop(child);
                killed_stale = terminate_stale_profile_holders(&profile_dir).await;
                // 未发现残留实例时仍清理一次单实例标记再重试：标记指向死
                // 进程时 Chrome 通常能自行接管，但部分版本会直接退出。
            }
        }
    };
    let info = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "browser state lock poisoned".to_string())?;
        // 覆盖旧运行时（崩溃残留）：旧 child 由 drop 的 kill_on_drop 回收。
        let tabs = HashMap::new();
        let runtime = BrowserRuntime {
            child,
            port,
            engine: engine.clone(),
            headless: config.headless,
            version: version.clone(),
            tabs,
            active_tab_id: None,
        };
        let info = runtime_info(&runtime);
        *guard = Some(runtime);
        info
    };
    if let Some(app) = app {
        // 面板同步：tabs 轮询器 + 进程存活监视 + 启动成功事件。端口是本次
        // 运行时的身份，被替换/关闭后这两个任务自行退出。
        spawn_tabs_poller(app.clone(), port);
        spawn_status_watcher(app.clone(), port);
        let _ = app.emit(
            BROWSER_STATUS_EVENT,
            &BrowserStatusEvent {
                running: true,
                reason: None,
            },
        );
    }
    Ok(status_response(true, Some(info)))
}

fn status_response(running: bool, info: Option<RuntimeInfoSnapshot>) -> BrowserCommandResponse {
    BrowserCommandResponse::Status {
        running,
        port: info.as_ref().map(|info| info.port),
        engine: info.as_ref().map(|info| info.engine.clone()),
        headless: info.as_ref().map(|info| info.headless),
        version: info.as_ref().map(|info| info.version.clone()),
        tabs: info.as_ref().map(|info| info.tabs),
    }
}

// ---------------------------------------------------------------------------
// 面板事件总线：运行时被替换/关闭即自愈退出的后台任务
// ---------------------------------------------------------------------------

/// tabs 轮询器：运行期间每 2s 拉一次 /json/list（本机回环，开销可忽略），
/// 结构签名变化（tab 增删 / url / title / active / 对话框）才 emit 完整列表。
/// Agent 或用户驱动的导航/开关 tab 由这里与 frameNavigated 事件兜底同步，
/// 面板无需手动刷新。
fn spawn_tabs_poller(app: AppHandle, port: u16) {
    tokio::spawn(async move {
        let mut last_signature: Option<String> = None;
        loop {
            tokio::time::sleep(TABS_POLL_INTERVAL).await;
            let state = app.state::<BrowserSessionState>();
            {
                let guard = match state.0.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                match guard.as_ref() {
                    None => break,
                    Some(runtime) if runtime.port != port => break,
                    Some(_) => {}
                }
            }
            if let Ok(tabs) = collect_tab_infos(&state, port).await {
                let signature = tabs_signature(&tabs);
                if last_signature.as_deref() != Some(signature.as_str()) {
                    last_signature = Some(signature);
                    let _ = app.emit(BROWSER_TABS_EVENT, &BrowserTabsEvent { tabs });
                }
            }
            // HTTP 失败：浏览器可能正在退出，交给 status watcher 收口。
        }
    });
}

/// 进程存活监视：意外退出（崩溃/被用户手动关闭）时清运行时并通知面板，
/// 让下一次 spawn 类动作经 ensure_running 自愈重建。
fn spawn_status_watcher(app: AppHandle, port: u16) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(STATUS_WATCH_INTERVAL).await;
            let state = app.state::<BrowserSessionState>();
            let mut guard = match state.0.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };
            let exited = match guard.as_mut() {
                None => break,
                Some(runtime) if runtime.port != port => break,
                Some(runtime) => matches!(runtime.child.try_wait(), Ok(Some(_))),
            };
            if exited {
                *guard = None;
                drop(guard);
                let _ = app.emit(
                    BROWSER_STATUS_EVENT,
                    &BrowserStatusEvent {
                        running: false,
                        reason: Some("浏览器进程已退出".into()),
                    },
                );
                break;
            }
        }
    });
}

fn tabs_signature(tabs: &[BrowserTabInfo]) -> String {
    tabs.iter()
        .map(|tab| {
            format!(
                "{}|{}|{}|{}|{}",
                tab.tab_id, tab.url, tab.title, tab.active, tab.has_dialog
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// 应用退出路径（RunEvent::Exit 的同步上下文）回收 spawn 的浏览器。
/// SIGTERM 进程组让 Chrome 落盘 profile，宽限内自旋等待，超时 SIGKILL 兜底。
pub fn reap_browser_for_exit(state: &BrowserSessionState) {
    let runtime = match state.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    let Some(mut runtime) = runtime else {
        return;
    };
    let Some(pid) = runtime.child.id() else {
        return;
    };
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(TERMINATION_GRACE_MS);
    loop {
        match runtime.child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = runtime.child.start_kill();
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

async fn shutdown_browser(
    app: Option<&AppHandle>,
    state: &BrowserSessionState,
) -> Result<BrowserCommandResponse, String> {
    let runtime = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "browser state lock poisoned".to_string())?;
        guard.take()
    };
    if let Some(mut runtime) = runtime {
        if let Some(pid) = runtime.child.id() {
            // 优雅退出优先：SIGTERM 让 Chrome 落盘 profile；宽限后 SIGKILL 兜底。
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            let _ = tokio::time::timeout(
                Duration::from_millis(TERMINATION_GRACE_MS),
                runtime.child.wait(),
            )
            .await;
        }
        let _ = runtime.child.start_kill();
    }
    // 显式关闭的 status 事件不带 reason（是预期行为，面板正常复位）。
    if let Some(app) = app {
        let _ = app.emit(
            BROWSER_STATUS_EVENT,
            &BrowserStatusEvent {
                running: false,
                reason: None,
            },
        );
    }
    Ok(BrowserCommandResponse::Done)
}

/// 锁内提取已连接 tab（克隆 Arc 后立刻放锁，避免跨 await 持锁）。
fn take_connected_tab(
    state: &BrowserSessionState,
    tab_id: &str,
) -> Result<(Arc<CdpTab>, u16), String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "browser state lock poisoned".to_string())?;
    let runtime = guard
        .as_ref()
        .ok_or("浏览器未运行：请先在 设置 → 浏览器 启用并通过 newTab 打开页面")?;
    let tab = runtime
        .tabs
        .get(tab_id)
        .ok_or_else(|| format!("tab 不存在：{tab_id}（请先 browser {{action: \"tabs\"}} 查看当前 tab）"))?
        .clone();
    Ok((tab, runtime.port))
}

/// 页面级动作的 tab 解析：优先复用已连接会话；对「外创建」的 tab（Chrome
/// 冷启动默认页、用户在浏览器窗口手动打开/导航的页面）按需补建 CDP 连接。
/// 这些 tab 出现在 /json/list 里但从未被 Axiom 打开过，不补连接的话截图、
/// 快照、历史、导航等动作会全部误报「tab 不存在」。
async fn take_tab(
    app: Option<&AppHandle>,
    state: &BrowserSessionState,
    tab_id: &str,
) -> Result<(Arc<CdpTab>, u16), String> {
    if let Ok(found) = take_connected_tab(state, tab_id) {
        return Ok(found);
    }
    let port = require_runtime_port(state)?;
    let targets = list_targets(port).await?;
    let target = targets
        .iter()
        .find(|target| target.id == tab_id)
        .ok_or_else(|| format!("tab 不存在：{tab_id}（请先 browser {{action: \"tabs\"}} 查看当前 tab）"))?;
    let ws_url = target
        .web_socket_debugger_url
        .clone()
        .ok_or("tab 未返回调试通道地址")?;
    let tab = connect_tab(&ws_url, app, tab_id).await?;
    register_tab(state, tab_id, tab)?;
    take_connected_tab(state, tab_id)
}

fn require_runtime_port(state: &BrowserSessionState) -> Result<u16, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "browser state lock poisoned".to_string())?;
    guard
        .as_ref()
        .map(|runtime| runtime.port)
        .ok_or("浏览器未运行：请先在 设置 → 浏览器 启用并通过 newTab 打开页面".into())
}

fn register_tab(state: &BrowserSessionState, target_id: &str, tab: Arc<CdpTab>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "browser state lock poisoned".to_string())?;
    let Some(runtime) = guard.as_mut() else {
        return Err("浏览器未运行".into());
    };
    if !runtime.tabs.contains_key(target_id) && runtime.tabs.len() >= MAX_TABS {
        return Err(format!("浏览器 tab 数已达上限（{MAX_TABS}），请先关闭不再使用的 tab"));
    }
    runtime.tabs.insert(target_id.to_string(), tab);
    Ok(())
}

/// 记录激活 tab（active 判定的权威来源，无记录时以 /json/list 首位近似）。
fn set_active_tab(state: &BrowserSessionState, tab_id: &str) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(runtime) = guard.as_mut() {
            runtime.active_tab_id = Some(tab_id.to_string());
        }
    }
}

async fn tab_info(
    state: &BrowserSessionState,
    runtime_port: u16,
    target_id: &str,
) -> Result<BrowserTabInfo, String> {
    let targets = list_targets(runtime_port).await?;
    let target = targets
        .iter()
        .find(|target| target.id == target_id)
        .ok_or_else(|| format!("tab 已不存在：{target_id}"))?;
    // active/has_dialog 都取自运行时记录：/json/list 不暴露 active 标记，
    // 对话框状态只存在于已建立的 CDP 连接里。
    let (active, has_dialog) = {
        let guard = state.0.lock().ok();
        guard
            .as_deref()
            .and_then(|runtime| runtime.as_ref())
            .map(|runtime| {
                (
                    match runtime.active_tab_id.as_deref() {
                        Some(active) => active == target_id,
                        None => true,
                    },
                    runtime
                        .tabs
                        .get(target_id)
                        .and_then(|tab| tab.dialog.lock().ok())
                        .map(|slot| slot.is_some())
                        .unwrap_or(false),
                )
            })
            .unwrap_or((true, false))
    };
    Ok(BrowserTabInfo {
        tab_id: target.id.clone(),
        url: target.url.clone(),
        title: target.title.clone(),
        active,
        has_dialog,
    })
}

async fn open_new_tab(
    app: Option<&AppHandle>,
    state: &BrowserSessionState,
    url: Option<String>,
) -> Result<BrowserCommandResponse, String> {
    let port = require_runtime_port(state)?;
    let target = new_target(port).await?;
    let ws_url = target
        .web_socket_debugger_url
        .clone()
        .ok_or("新建 tab 未返回调试通道地址")?;
    let tab = connect_tab(&ws_url, app, &target.id).await?;
    register_tab(state, &target.id, tab)?;
    // 新建即激活：后续 list/preview 都以它为 active。
    set_active_tab(state, &target.id);
    if let Some(raw_url) = url {
        let url = validate_navigation_url(&raw_url)?;
        let tab = take_tab(app, state, &target.id).await?.0;
        navigate_tab(state, &tab, port, &target.id, &url).await?;
    }
    let info = tab_info(state, port, &target.id).await?;
    Ok(BrowserCommandResponse::TabOpened { tab: info })
}

/// 把 tab 调到前台：Page.bringToFront 同时聚焦浏览器窗口并让 /json/list
/// 把该目标排到首位。无头模式下该命令是无害空操作，返回 Done 保持幂等语义。
async fn activate_tab(
    app: Option<&AppHandle>,
    state: &BrowserSessionState,
    tab_id: &str,
) -> Result<BrowserCommandResponse, String> {
    let (tab, _port) = take_tab(app, state, tab_id).await?;
    tab.send("Page.bringToFront", json!({}))
        .await
        .map_err(|error| format!("激活 tab 失败：{error}"))?;
    set_active_tab(state, tab_id);
    Ok(BrowserCommandResponse::Done)
}

/// 读取导航历史边界，供面板禁用后退/前进按钮；历史数据异常时按「不可移动」
/// 处理（与 history_navigate 的边界拒绝语义一致），不作为错误上抛。
async fn navigation_bounds(
    app: Option<&AppHandle>,
    state: &BrowserSessionState,
    tab_id: &str,
) -> Result<BrowserCommandResponse, String> {
    let (tab, _port) = take_tab(app, state, tab_id).await?;
    let history = tab
        .send("Page.getNavigationHistory", json!({}))
        .await
        .map_err(|error| format!("读取导航历史失败：{error}"))?;
    let index = history
        .get("currentIndex")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let total = history
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| entries.len() as i64)
        .unwrap_or(0);
    Ok(BrowserCommandResponse::NavigationState {
        can_go_back: index > 0,
        can_go_forward: index + 1 < total,
    })
}

/// 汇总 tab 列表：结构来自 /json/list，对话框状态来自已连接 tab 的 CDP
/// 会话，active 按运行时记录（无记录时以首位近似）。tabs 轮询器与 Tabs
/// 动作共用，保证事件与响应的口径一致。
async fn collect_tab_infos(
    state: &BrowserSessionState,
    port: u16,
) -> Result<Vec<BrowserTabInfo>, String> {
    let targets = list_targets(port).await?;
    let (dialog_flags, active_tab_id) = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "browser state lock poisoned".to_string())?;
        match guard.as_ref() {
            Some(runtime) => (
                runtime
                    .tabs
                    .iter()
                    .map(|(id, tab)| {
                        (
                            id.clone(),
                            tab.dialog.lock().map(|slot| slot.is_some()).unwrap_or(false),
                        )
                    })
                    .collect::<HashMap<String, bool>>(),
                runtime.active_tab_id.clone(),
            ),
            None => (HashMap::new(), None),
        }
    };
    Ok(targets
        .iter()
        .enumerate()
        .map(|(index, target)| BrowserTabInfo {
            tab_id: target.id.clone(),
            url: target.url.clone(),
            title: target.title.clone(),
            active: match active_tab_id.as_deref() {
                Some(active) => active == target.id,
                // Chrome 返回最近交互目标在前，无记录时以首位近似。
                None => index == 0,
            },
            has_dialog: dialog_flags.get(&target.id).copied().unwrap_or(false),
        })
        .collect())
}

async fn list_browser_tabs(state: &BrowserSessionState) -> Result<BrowserCommandResponse, String> {
    let port = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "browser state lock poisoned".to_string())?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(BrowserCommandResponse::Tabs { tabs: Vec::new() });
        };
        runtime.port
    };
    let tabs = collect_tab_infos(state, port).await?;
    Ok(BrowserCommandResponse::Tabs { tabs })
}

async fn navigate_tab(
    state: &BrowserSessionState,
    tab: &Arc<CdpTab>,
    port: u16,
    target_id: &str,
    url: &str,
) -> Result<BrowserCommandResponse, String> {
    let base = tab.load_generation();
    let result = tab
        .send("Page.navigate", json!({"url": url}))
        .await
        .map_err(|error| format!("导航失败：{error}"))?;
    if let Some(error_text) = result.get("errorText").and_then(Value::as_str) {
        if !error_text.is_empty() {
            return Err(format!("导航失败：{error_text}"));
        }
    }
    tab.wait_load(base, NAVIGATE_LOAD_TIMEOUT).await;
    let info = tab_info(state, port, target_id).await?;
    Ok(BrowserCommandResponse::Navigated {
        url: info.url,
        title: info.title,
    })
}

// ---------------------------------------------------------------------------
// Accessibility 树 → 文本快照（纯函数）
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct AxValue {
    #[serde(default)]
    value: Value,
}

#[derive(Debug, Deserialize)]
struct AxProperty {
    name: String,
    #[serde(default)]
    value: AxValue,
}

#[derive(Debug, Default, Deserialize)]
// CDP JSON 字段是 camelCase（nodeId/parentId）；例外：backendDOMNodeId 的
// DOM 是全大写，serde 的 camelCase 会转成 backendDomNodeId，必须显式 rename。
#[serde(rename_all = "camelCase")]
struct AxNode {
    #[serde(default)]
    node_id: String,
    #[serde(default, rename = "backendDOMNodeId")]
    backend_dom_node_id: Option<i64>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    ignored: bool,
    #[serde(default)]
    role: AxValue,
    #[serde(default)]
    name: AxValue,
    #[serde(default)]
    value: AxValue,
    #[serde(default)]
    properties: Vec<AxProperty>,
}

#[derive(Debug, Deserialize)]
struct AxTreeResponse {
    #[serde(default)]
    nodes: Vec<AxNode>,
}

fn ax_value_str(value: &AxValue) -> String {
    match &value.value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

/// 角色归一 + 剪枝判定：无语义的泛型容器（无名称）与被忽略节点整棵剪掉，
/// 文本角色合并为裸文本行。返回 None 表示该节点不进入快照。
///
/// CDP 的角色值大小写不稳定（internalRole 类是 PascalCase：`WebArea`/
/// `StaticText`/`InlineTextBox`；标准 role 是 camelCase：`button`/`textField`），
/// 匹配一律先小写化，未命中特判的角色保留原始大小写输出。
fn ax_role_display(node: &AxNode) -> Option<String> {
    if node.ignored {
        return None;
    }
    let role = ax_value_str(&node.role);
    let name = ax_value_str(&node.name);
    let canonical = role.to_ascii_lowercase();
    match canonical.as_str() {
        "ignored" | "inlinetextbox" => None,
        "generic" | "genericcontainer" => {
            if name.is_empty() {
                None
            } else {
                Some("group".into())
            }
        }
        "textfield" | "searchbox" => Some("textbox".into()),
        "statictext" => {
            if name.is_empty() && ax_value_str(&node.value).is_empty() {
                None
            } else {
                Some("text".into())
            }
        }
        "webarea" => Some("page".into()),
        _ => Some(role),
    }
}

fn ax_heading_level(node: &AxNode) -> Option<i64> {
    node.properties
        .iter()
        .find(|property| property.name == "level")
        .and_then(|property| property.value.value.as_i64())
}

/// 节点状态注记：focused/checked/selected/disabled/expanded/collapsed 等布尔
/// 状态进入快照行，模型无需截图即可判断控件状态（对齐 zcode domSnapshot
/// 的状态可见性；只注记真值，false 是缺省态不值得占预算）。
fn ax_state_markers(node: &AxNode) -> Vec<String> {
    let mut markers = Vec::new();
    for property in &node.properties {
        if property.value.value.as_bool() != Some(true) {
            continue;
        }
        let marker = match property.name.as_str() {
            "focused" => Some("焦点中"),
            "checked" => Some("已勾选"),
            "selected" => Some("已选中"),
            "disabled" => Some("已禁用"),
            "expanded" => Some("已展开"),
            "collapsed" => Some("已折叠"),
            _ => None,
        };
        if let Some(marker) = marker {
            markers.push(format!("[{marker}]"));
        }
    }
    markers
}

/// 渲染单个节点行。文本角色输出裸文本；可交互节点带 `[ref=N]`（backendDOMNodeId，
/// click/fill 的定位锚）；textbox/comboBox 附加当前值；heading 附加层级；
/// 布尔状态以 `[已禁用]` 形式注记。
fn render_ax_node(node: &AxNode, role: &str, depth: usize, output: &mut String) {
    let indent = "  ".repeat(depth);
    let name = ax_value_str(&node.name);
    if role == "text" {
        let text = if name.is_empty() {
            ax_value_str(&node.value)
        } else {
            name
        };
        output.push_str(&format!("{indent}- \"{text}\"\n"));
        return;
    }
    let role_display = match (role, ax_heading_level(node)) {
        ("heading", Some(level)) => format!("heading(level {level})"),
        _ => role.to_string(),
    };
    let ref_prefix = node
        .backend_dom_node_id
        .map(|id| format!("[ref={id}] "))
        .unwrap_or_default();
    let mut line = format!("{indent}- {ref_prefix}{role_display}");
    if !name.is_empty() {
        line.push_str(&format!(" \"{name}\""));
    }
    let markers = ax_state_markers(node);
    if !markers.is_empty() {
        line.push(' ');
        line.push_str(&markers.join(" "));
    }
    let current = ax_value_str(&node.value);
    if !current.is_empty()
        && ["textbox", "combobox", "searchbox", "spinbutton"]
            .iter()
            .any(|candidate| role.eq_ignore_ascii_case(candidate))
    {
        line.push_str(&format!(" = \"{current}\""));
    }
    output.push_str(&line);
    output.push('\n');
}

/// Accessibility 全树 → 缩进文本快照。被剪节点的子树提升为当前层级的根
/// （保留语义内容，压缩无意义层级），输出超过 MAX_SNAPSHOT_CHARS 时截断并置 truncated。
fn format_ax_tree(nodes: &[AxNode]) -> (String, bool) {
    let kept: HashMap<&str, &AxNode> = nodes
        .iter()
        .filter(|node| ax_role_display(node).is_some())
        .map(|node| (node.node_id.as_str(), node))
        .collect();
    let kept_ids: HashSet<&str> = kept.keys().copied().collect();
    // 根 = 保留节点中父节点缺失或父节点被剪的（父被剪时子树向上提一级）。
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut roots: Vec<&str> = Vec::new();
    for (id, node) in &kept {
        match node.parent_id.as_deref() {
            Some(parent) if kept_ids.contains(parent) => {
                children.entry(parent).or_default().push(id);
            }
            _ => roots.push(id),
        }
    }
    // 渲染顺序稳定：按输入顺序而非 HashMap 迭代序（可复现快照）。
    let order: Vec<&str> = nodes.iter().map(|node| node.node_id.as_str()).collect();
    let sort_children = |ids: &mut Vec<&str>| ids.sort_by_key(|id| order.iter().position(|x| x == id));
    let mut roots_sorted = roots;
    sort_children(&mut roots_sorted);

    let mut output = String::new();
    let mut truncated = false;
    let mut stack: Vec<(&str, usize)> = roots_sorted.into_iter().rev().map(|id| (id, 0)).collect();
    while let Some((id, depth)) = stack.pop() {
        let node = kept[id];
        let role = ax_role_display(node).unwrap_or_default();
        render_ax_node(node, &role, depth, &mut output);
        if output.len() > MAX_SNAPSHOT_CHARS {
            truncated = true;
            output.push_str("\n[快照已截断：页面可访问性树超过 200 KiB 上限，请缩小范围（滚动后重新快照）或改用定向读取]\n");
            break;
        }
        if let Some(child_ids) = children.get(id) {
            let mut sorted = child_ids.clone();
            sort_children(&mut sorted);
            // 反序压栈保证出栈顺序与输入顺序一致。
            for child in sorted.into_iter().rev() {
                stack.push((child, depth + 1));
            }
        }
    }
    (output, truncated)
}

// ---------------------------------------------------------------------------
// 交互原语
// ---------------------------------------------------------------------------

/// CDP Input modifiers 位掩码（Chromium 语义）：Alt=1, Ctrl=2, Meta=4, Shift=8。
/// 全选修饰键：macOS 是 Cmd+A（Meta=4），其余平台 Ctrl+A（2）。写死 Ctrl 在
/// mac 的 Chrome 上清不掉 fill 的既有内容。
#[cfg(target_os = "macos")]
const MODIFIER_SELECT_ALL: u8 = 4;
#[cfg(not(target_os = "macos"))]
const MODIFIER_SELECT_ALL: u8 = 2;

struct KeyDef {
    key: String,
    code: String,
    virtual_key_code: u32,
    text: Option<String>,
}

/// 按键名 → CDP keyDown/keyUp 参数。命名键走白名单，单字符原样放行；
/// 其余一律拒绝（不猜键码，对齐「禁止猜测」纪律）。
fn key_definition(name: &str) -> Option<KeyDef> {
    let named = |key: &str, code: &str, vk: u32, text: Option<&str>| KeyDef {
        key: key.to_string(),
        code: code.to_string(),
        virtual_key_code: vk,
        text: text.map(str::to_string),
    };
    match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some(named("Enter", "Enter", 13, Some("\r"))),
        "tab" => Some(named("Tab", "Tab", 9, None)),
        "escape" | "esc" => Some(named("Escape", "Escape", 27, None)),
        "backspace" => Some(named("Backspace", "Backspace", 8, None)),
        "delete" => Some(named("Delete", "Delete", 46, None)),
        "arrowup" => Some(named("ArrowUp", "ArrowUp", 38, None)),
        "arrowdown" => Some(named("ArrowDown", "ArrowDown", 40, None)),
        "arrowleft" => Some(named("ArrowLeft", "ArrowLeft", 37, None)),
        "arrowright" => Some(named("ArrowRight", "ArrowRight", 39, None)),
        "home" => Some(named("Home", "Home", 36, None)),
        "end" => Some(named("End", "End", 35, None)),
        "pageup" => Some(named("PageUp", "PageUp", 33, None)),
        "pagedown" => Some(named("PageDown", "PageDown", 34, None)),
        "space" => Some(named(" ", "Space", 32, Some(" "))),
        single => {
            let mut chars = single.chars();
            let (first, second) = (chars.next(), chars.next());
            match (first, second) {
                (Some(ch), None) => Some(KeyDef {
                    key: ch.to_string(),
                    code: String::new(),
                    virtual_key_code: ch.to_ascii_uppercase() as u32,
                    text: Some(ch.to_string()),
                }),
                _ => None,
            }
        }
    }
}

async fn dispatch_key(tab: &Arc<CdpTab>, def: &KeyDef, modifiers: u8) -> Result<(), String> {
    let mut down = json!({
        "type": "keyDown",
        "key": def.key,
        "windowsVirtualKeyCode": def.virtual_key_code,
        "nativeVirtualKeyCode": def.virtual_key_code,
        "modifiers": modifiers,
    });
    if !def.code.is_empty() {
        down["code"] = Value::String(def.code.clone());
    }
    if let Some(text) = &def.text {
        down["text"] = Value::String(text.clone());
    }
    tab.send("Input.dispatchKeyEvent", down).await.map(|_| ())?;
    let mut up = json!({
        "type": "keyUp",
        "key": def.key,
        "windowsVirtualKeyCode": def.virtual_key_code,
        "nativeVirtualKeyCode": def.virtual_key_code,
        "modifiers": modifiers,
    });
    if !def.code.is_empty() {
        up["code"] = Value::String(def.code.clone());
    }
    tab.send("Input.dispatchKeyEvent", up).await.map(|_| ())
}

async fn dispatch_mouse(
    tab: &Arc<CdpTab>,
    event_type: &str,
    x: f64,
    y: f64,
) -> Result<(), String> {
    tab.send(
        "Input.dispatchMouseEvent",
        json!({
            "type": event_type,
            "x": x,
            "y": y,
            "button": "left",
            "buttons": 1,
            "clickCount": 1,
        }),
    )
    .await
    .map(|_| ())
}

/// ref（backendDOMNodeId）→ 视口坐标盒中心。走 DOM 域而非 Runtime evaluate：
/// 坐标是注入输入的必要条件，DOM 域不执行页面代码；getBoxModel 原生接受
/// backendNodeId（免去 describeNode 的 nodeId 会话上下文问题），border quad
/// 即 viewport 相对坐标（Input.dispatchMouseEvent 的坐标系）。
async fn ref_box_center(tab: &Arc<CdpTab>, backend_node_id: i64) -> Result<(f64, f64), String> {
    let box_result = tab
        .send("DOM.getBoxModel", json!({"backendNodeId": backend_node_id}))
        .await
        .map_err(|error| format!("获取节点区域失败：{error}（ref 可能已过期，请重新 snapshot）"))?;
    let numbers: Vec<f64> = box_result
        .pointer("/model/border")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    if numbers.len() != 8 {
        return Err("该节点没有可见区域（可能不可见或已移除），请重新 snapshot 确认目标".into());
    }
    let xs: f64 = numbers.iter().step_by(2).sum();
    let ys: f64 = numbers.iter().skip(1).step_by(2).sum();
    let center = (xs / 4.0, ys / 4.0);
    let zero_sized = numbers.iter().step_by(2).all(|x| *x == numbers[0])
        && numbers.iter().skip(1).step_by(2).all(|y| *y == numbers[1]);
    if zero_sized {
        return Err("该节点没有可见区域（可能不可见或已移除），请重新 snapshot 确认目标".into());
    }
    Ok(center)
}

async fn focus_ref(tab: &Arc<CdpTab>, backend_node_id: i64) -> Result<(), String> {
    tab.send("DOM.focus", json!({"backendNodeId": backend_node_id}))
        .await
        .map(|_| ())
        .map_err(|error| format!("聚焦目标节点失败：{error}（ref 可能已过期，请重新 snapshot）"))
}

/// 视口盒子（cssVisualViewport 的 x/y/width/height，CSS 像素，与 Input 域
/// 坐标系一致）。读取失败时退回启动参数的窗口尺寸。
async fn viewport_box(tab: &Arc<CdpTab>) -> (f64, f64, f64, f64) {
    if let Ok(metrics) = tab.send("Page.getLayoutMetrics", json!({})).await {
        if let Some(viewport) = metrics.pointer("/cssVisualViewport") {
            let width = viewport.get("width").and_then(Value::as_f64).unwrap_or(1280.0);
            let height = viewport.get("height").and_then(Value::as_f64).unwrap_or(800.0);
            let x = viewport.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = viewport.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            return (x, y, width, height);
        }
    }
    (0.0, 0.0, 1280.0, 800.0)
}

async fn viewport_center(tab: &Arc<CdpTab>) -> (f64, f64) {
    let (x, y, width, height) = viewport_box(tab).await;
    (x + width / 2.0, y + height / 2.0)
}

/// 面板预览的用户手势坐标 clamp 进视口：越界坐标注入无意义，还可能命中
/// 视口外元素的点击热区。
async fn clamp_to_viewport(tab: &Arc<CdpTab>, x: f64, y: f64) -> (f64, f64) {
    let (vx, vy, width, height) = viewport_box(tab).await;
    (x.clamp(vx, vx + width - 1.0), y.clamp(vy, vy + height - 1.0))
}

/// 截图体积守卫：超过 4 MiB 时降采样重编码（最多 3 轮），返回最终 PNG 与尺寸。
/// computer_control 的屏幕捕获复用同一守卫（同为模型可见图像输出）。
pub(crate) fn ensure_screenshot_within_cap(
    bytes: Vec<u8>,
) -> Result<(Vec<u8>, u32, u32, bool), String> {
    let mut current = bytes;
    let mut resized = false;
    for _ in 0..3 {
        let image = image::load_from_memory(&current)
            .map_err(|error| format!("截图解码失败：{error}"))?;
        let (width, height) = (image.width(), image.height());
        if current.len() <= MAX_SCREENSHOT_BYTES && width > 0 && height > 0 {
            return Ok((current, width, height, resized));
        }
        let scaled = image.resize_exact(
            (width / 2).max(1),
            (height / 2).max(1),
            image::imageops::FilterType::Triangle,
        );
        let mut buffer = Cursor::new(Vec::new());
        scaled
            .write_to(&mut buffer, image::ImageFormat::Png)
            .map_err(|error| format!("截图重编码失败：{error}"))?;
        current = buffer.into_inner();
        resized = true;
    }
    Err("截图超出大小上限且降采样失败".into())
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn browser_command(
    app: AppHandle,
    state: State<'_, BrowserSessionState>,
    request: BrowserCommandRequest,
) -> Result<BrowserCommandResponse, String> {
    let data_root = crate::storage_paths::axiom_data_root(&app)?;
    let home = home_path();
    match request {
        BrowserCommandRequest::Detect => Ok(BrowserCommandResponse::Detected {
            engines: detect_engines(home.as_deref()),
        }),
        BrowserCommandRequest::ValidateExecutable { path } => {
            let (resolved, engine) = validate_browser_executable(&path, home.as_deref())?;
            Ok(BrowserCommandResponse::ExecutableValid {
                path: resolved.display().to_string(),
                engine,
            })
        }
        BrowserCommandRequest::Status => {
            let mut guard = state
                .0
                .lock()
                .map_err(|_| "browser state lock poisoned".to_string())?;
            // 模式守卫里不能取可变借用：先判定存活，再读信息。
            let alive = match guard.as_mut() {
                Some(runtime) => {
                    runtime.child.try_wait().map_err(|e| e.to_string())?.is_none()
                }
                None => false,
            };
            if alive {
                let info = guard.as_ref().map(runtime_info);
                Ok(status_response(true, Some(info.expect("alive implies runtime"))))
            } else {
                Ok(status_response(false, None))
            }
        }
        BrowserCommandRequest::EnsureRunning { config } => {
            ensure_running(Some(&app), &data_root, &state, &config).await
        }
        BrowserCommandRequest::Shutdown => shutdown_browser(Some(&app), &state).await,
        BrowserCommandRequest::Tabs => list_browser_tabs(&state).await,
        BrowserCommandRequest::NewTab { url } => {
            let validated = match url {
                Some(raw) => Some(validate_navigation_url(&raw)?),
                None => None,
            };
            open_new_tab(Some(&app), &state, validated).await
        }
        BrowserCommandRequest::CloseTab { tab_id } => {
            let port = require_runtime_port(&state)?;
            close_target(port, &tab_id).await?;
            if let Ok(mut guard) = state.0.lock() {
                if let Some(runtime) = guard.as_mut() {
                    runtime.tabs.remove(&tab_id);
                    if runtime.active_tab_id.as_deref() == Some(tab_id.as_str()) {
                        runtime.active_tab_id = None;
                    }
                }
            }
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::ActivateTab { tab_id } => activate_tab(Some(&app), &state, &tab_id).await,
        BrowserCommandRequest::Navigate { tab_id, url } => {
            let url = validate_navigation_url(&url)?;
            let (tab, port) = take_tab(Some(&app), &state, &tab_id).await?;
            navigate_tab(&state, &tab, port, &tab_id, &url).await
        }
        BrowserCommandRequest::Snapshot { tab_id } => {
            let (tab, port) = take_tab(Some(&app), &state, &tab_id).await?;
            let result = tab
                .send("Accessibility.getFullAXTree", json!({}))
                .await
                .map_err(|error| format!("获取页面快照失败：{error}"))?;
            let tree: AxTreeResponse =
                serde_json::from_value(result).map_err(|error| format!("解析页面快照失败：{error}"))?;
            let (text, truncated) = format_ax_tree(&tree.nodes);
            let info = tab_info(&state, port, &tab_id).await?;
            Ok(BrowserCommandResponse::Snapshot {
                url: info.url,
                title: info.title,
                text,
                truncated,
                dialog: tab.dialog_info(),
            })
        }
        BrowserCommandRequest::Click { tab_id, r#ref } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            let (x, y) = ref_box_center(&tab, r#ref).await?;
            dispatch_mouse(&tab, "mousePressed", x, y).await?;
            dispatch_mouse(&tab, "mouseReleased", x, y).await?;
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::Fill { tab_id, r#ref, text } => {
            if text.chars().count() > MAX_TEXT_INPUT_CHARS {
                return Err(format!("输入文本不得超过 {MAX_TEXT_INPUT_CHARS} 字符"));
            }
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            focus_ref(&tab, r#ref).await?;
            // 清空既有内容：全选 → Backspace（Input 域原语，不执行页面 JS）。
            if let Some(select_all) = key_definition("a") {
                dispatch_key(&tab, &select_all, MODIFIER_SELECT_ALL).await?;
            }
            if let Some(backspace) = key_definition("Backspace") {
                dispatch_key(&tab, &backspace, 0).await?;
            }
            tab.send("Input.insertText", json!({"text": text}))
                .await
                .map_err(|error| format!("输入文本失败：{error}"))?;
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::TypeText { tab_id, r#ref, text } => {
            if text.chars().count() > MAX_TEXT_INPUT_CHARS {
                return Err(format!("输入文本不得超过 {MAX_TEXT_INPUT_CHARS} 字符"));
            }
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            if let Some(r#ref) = r#ref {
                focus_ref(&tab, r#ref).await?;
            }
            tab.send("Input.insertText", json!({"text": text}))
                .await
                .map_err(|error| format!("输入文本失败：{error}"))?;
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::Press { tab_id, key, r#ref } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            if let Some(r#ref) = r#ref {
                focus_ref(&tab, r#ref).await?;
            }
            let def = key_definition(&key).ok_or_else(|| {
                format!(
                    "不支持的按键：{key}（支持 Enter/Tab/Escape/Backspace/Delete/ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Home/End/PageUp/PageDown/Space 或单个字符）"
                )
            })?;
            dispatch_key(&tab, &def, 0).await?;
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::Scroll { tab_id, r#ref, delta_x, delta_y } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            let (x, y) = match r#ref {
                Some(r#ref) => ref_box_center(&tab, r#ref).await?,
                None => viewport_center(&tab).await,
            };
            tab.send(
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": x,
                    "y": y,
                    "deltaX": delta_x.unwrap_or(0.0),
                    "deltaY": delta_y.unwrap_or(300.0),
                }),
            )
            .await
            .map_err(|error| format!("滚动失败：{error}"))?;
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::Screenshot { tab_id } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            let result = tab
                .send("Page.captureScreenshot", json!({"format": "png"}))
                .await
                .map_err(|error| format!("截图失败：{error}"))?;
            let data = result
                .get("data")
                .and_then(Value::as_str)
                .ok_or("截图响应缺少 data")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|error| format!("截图 base64 解码失败：{error}"))?;
            let (png, width, height, resized) = ensure_screenshot_within_cap(bytes)?;
            Ok(BrowserCommandResponse::Screenshot {
                image_base64: base64::engine::general_purpose::STANDARD.encode(png),
                mime_type: "image/png".into(),
                width,
                height,
                resized,
            })
        }
        BrowserCommandRequest::Back { tab_id } => history_navigate(Some(&app), &state, &tab_id, -1).await,
        BrowserCommandRequest::Forward { tab_id } => history_navigate(Some(&app), &state, &tab_id, 1).await,
        BrowserCommandRequest::NavigationHistory { tab_id } => {
            navigation_bounds(Some(&app), &state, &tab_id).await
        }
        BrowserCommandRequest::Reload { tab_id } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            let base = tab.load_generation();
            tab.send("Page.reload", json!({}))
                .await
                .map_err(|error| format!("刷新失败：{error}"))?;
            tab.wait_load(base, NAVIGATE_LOAD_TIMEOUT).await;
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::Dialog { tab_id } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            Ok(BrowserCommandResponse::DialogState {
                dialog: tab.dialog_info(),
            })
        }
        BrowserCommandRequest::RespondDialog { tab_id, accept, prompt_text } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            let mut params = json!({"accept": accept});
            if let Some(prompt_text) = prompt_text {
                if prompt_text.chars().count() > MAX_TEXT_INPUT_CHARS {
                    return Err(format!("对话框输入不得超过 {MAX_TEXT_INPUT_CHARS} 字符"));
                }
                params["promptText"] = Value::String(prompt_text);
            }
            tab.send("Page.handleJavaScriptDialog", params)
                .await
                .map_err(|error| format!("处理对话框失败：{error}"))?;
            // javascriptDialogClosed 事件正常会清状态；乐观清一次防事件丢失。
            if let Ok(mut slot) = tab.dialog.lock() {
                *slot = None;
            }
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::StartScreencast { tab_id, max_width, max_height } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            start_screencast(&tab, max_width, max_height).await
        }
        BrowserCommandRequest::StopScreencast { tab_id } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            stop_screencast(&tab).await
        }
        BrowserCommandRequest::Console { tab_id, limit } => {
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            Ok(read_console(&tab, limit))
        }
        BrowserCommandRequest::ClickAt { tab_id, x, y } => {
            if !x.is_finite() || !y.is_finite() {
                return Err("点击坐标必须是有限数值".into());
            }
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            let (x, y) = clamp_to_viewport(&tab, x, y).await;
            dispatch_mouse(&tab, "mousePressed", x, y).await?;
            dispatch_mouse(&tab, "mouseReleased", x, y).await?;
            Ok(BrowserCommandResponse::Done)
        }
        BrowserCommandRequest::ScrollAt { tab_id, x, y, delta_x, delta_y } => {
            if !x.is_finite() || !y.is_finite() {
                return Err("滚动坐标必须是有限数值".into());
            }
            let (tab, _) = take_tab(Some(&app), &state, &tab_id).await?;
            let (x, y) = clamp_to_viewport(&tab, x, y).await;
            tab.send(
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": x,
                    "y": y,
                    "deltaX": delta_x.unwrap_or(0.0),
                    "deltaY": delta_y.unwrap_or(0.0),
                }),
            )
            .await
            .map_err(|error| format!("滚动失败：{error}"))?;
            Ok(BrowserCommandResponse::Done)
        }
    }
}

/// 开启面板实时画面（CDP screencast 增量 JPEG 帧）：帧经 `axiom:browser-frame`
/// 事件推送，与模型截图（captureScreenshot，全帧 PNG 走 invoke 响应）是两条
/// 独立通道。max_width/max_height 由面板按显示尺寸传入，Chrome 等比缩放
/// 控制帧体积；不传则按视口原始尺寸。
async fn start_screencast(
    tab: &Arc<CdpTab>,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> Result<BrowserCommandResponse, String> {
    let mut params = json!({
        "format": "jpeg",
        "quality": SCREENCAST_JPEG_QUALITY,
        "everyNthFrame": 1,
    });
    if let Some(width) = max_width {
        params["maxWidth"] = json!(width);
    }
    if let Some(height) = max_height {
        params["maxHeight"] = json!(height);
    }
    tab.send("Page.startScreencast", params)
        .await
        .map_err(|error| format!("开启实时画面失败：{error}"))?;
    if let Ok(mut state) = tab.screencast.lock() {
        *state = ScreencastState {
            active: true,
            last_emit: None,
        };
    }
    Ok(BrowserCommandResponse::ScreencastStarted)
}

async fn stop_screencast(tab: &Arc<CdpTab>) -> Result<BrowserCommandResponse, String> {
    // 停流失败不作为错误上抛：连接即将关闭时 stop 无意义，UI 侧也无需感知。
    let _ = tab.send("Page.stopScreencast", json!({})).await;
    if let Ok(mut state) = tab.screencast.lock() {
        state.active = false;
    }
    Ok(BrowserCommandResponse::Done)
}

/// 读取 console 环形缓冲的最近条目（时间正序）。仅连接过的 tab 有缓冲；
/// 未连接的冷 tab 会先经 take_tab 补建连接，从连接时刻起开始收集。
fn read_console(tab: &Arc<CdpTab>, limit: Option<usize>) -> BrowserCommandResponse {
    let limit = limit.unwrap_or(DEFAULT_CONSOLE_LIMIT).clamp(1, MAX_CONSOLE_ENTRIES);
    let mut entries = tab
        .console
        .lock()
        .map(|buffer| {
            buffer
                .iter()
                .rev()
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    entries.reverse();
    BrowserCommandResponse::ConsoleLog { entries }
}

async fn history_navigate(
    app: Option<&AppHandle>,
    state: &BrowserSessionState,
    tab_id: &str,
    delta: i64,
) -> Result<BrowserCommandResponse, String> {
    let (tab, _) = take_tab(app, state, tab_id).await?;
    let history = tab
        .send("Page.getNavigationHistory", json!({}))
        .await
        .map_err(|error| format!("读取导航历史失败：{error}"))?;
    let index = history.get("currentIndex").and_then(Value::as_i64).unwrap_or(0);
    let entries = history
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("导航历史数据异常")?;
    let target_index = index + delta;
    if target_index < 0 || target_index >= entries.len() as i64 {
        return Err(if delta < 0 { "没有上一页可返回".into() } else { "没有下一页可前进".into() });
    }
    let entry_id = entries[target_index as usize]
        .get("id")
        .and_then(Value::as_i64)
        .ok_or("导航历史条目缺少 id")?;
    let base = tab.load_generation();
    tab.send("Page.navigateToHistoryEntry", json!({"entryId": entry_id}))
        .await
        .map_err(|error| format!("历史导航失败：{error}"))?;
    tab.wait_load(base, NAVIGATE_LOAD_TIMEOUT).await;
    Ok(BrowserCommandResponse::Done)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> Option<PathBuf> {
        home_path()
    }

    #[test]
    fn navigation_url_validation_matrix() {
        assert!(validate_navigation_url("https://example.com/path?q=1").is_ok());
        assert!(validate_navigation_url("http://localhost:5173/").is_ok());
        assert!(validate_navigation_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_navigation_url("ftp://example.com/").is_err());
        assert!(validate_navigation_url("file:///etc/passwd").is_err());
        assert!(validate_navigation_url("javascript:alert(1)").is_err());
        assert!(validate_navigation_url("chrome://settings").is_err());
        assert!(validate_navigation_url("https://user:pass@example.com/").is_err());
        assert!(validate_navigation_url("").is_err());
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_CHARS));
        assert!(validate_navigation_url(&long).is_err());
    }

    #[test]
    fn executable_allowlist_matrix() {
        let layout = |raw: &str, home: Option<&Path>| {
            validate_browser_executable_layout(&expand_tilde(raw, home), home)
        };
        // 标准布局通过（只查结构，不依赖机器是否真的安装）。
        assert_eq!(
            layout("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", None)
                .expect("standard chrome layout"),
            "Google Chrome"
        );
        assert_eq!(
            layout(
                "/Users/test/Applications/Chromium.app/Contents/MacOS/Chromium",
                Some(Path::new("/Users/test")),
            )
            .expect("user applications layout"),
            "Chromium"
        );
        // 结构性拒绝：任意二进制 / 非 Chromium bundle / 非标准布局 / 他人 home。
        assert!(layout("/usr/bin/curl", None).is_err());
        assert!(layout("/bin/sh", None).is_err());
        assert!(layout("/Applications/Safari.app/Contents/MacOS/Safari", None).is_err());
        assert!(layout("/Applications/Google Chrome.app/Contents/MacOS/helper", None).is_err());
        assert!(layout("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", None).is_ok());
        let stranger = "/Users/other/Applications/Chromium.app/Contents/MacOS/Chromium";
        assert!(
            layout(stranger, Some(Path::new("/Users/test"))).is_err(),
            "他人 home 下的 Applications 不放行"
        );
        // 显式路径为空。
        assert!(validate_browser_executable("", None).is_err());
    }

    #[test]
    fn chrome_args_shape() {
        let dir = Path::new("/Users/x/.axiom/browser/profile");
        let headless = chrome_args(9222, dir, true);
        assert_eq!(headless[0], "--headless=new");
        assert!(headless.contains(&"--remote-debugging-port=9222".to_string()));
        assert!(headless.contains(&format!("--user-data-dir={}", dir.display())));
        assert!(!headless.iter().any(|arg| arg.starts_with("--remote-allow-origins")));
        let headed = chrome_args(9223, dir, false);
        assert!(!headed.iter().any(|arg| arg.starts_with("--headless")));
    }

    const AX_FIXTURE: &str = r#"{
      "nodes": [
        {"nodeId":"1","backendDOMNodeId":1,"childIds":["2","5"],"role":{"type":"role","value":"WebArea"},"name":{"type":"computedString","value":"Test Page"}},
        {"nodeId":"2","backendDOMNodeId":10,"parentId":"1","childIds":["3"],"role":{"type":"role","value":"generic"}},
        {"nodeId":"3","backendDOMNodeId":12,"parentId":"2","childIds":[],"role":{"type":"role","value":"heading"},"name":{"type":"computedString","value":"Welcome"},"properties":[{"name":"level","value":{"type":"integer","value":2}}]},
        {"nodeId":"4","backendDOMNodeId":30,"parentId":"1","childIds":[],"role":{"type":"internalRole","value":"Ignored"}},
        {"nodeId":"5","backendDOMNodeId":40,"parentId":"1","childIds":["6"],"role":{"type":"role","value":"button"},"name":{"type":"computedString","value":"Sign in"}},
        {"nodeId":"6","backendDOMNodeId":41,"parentId":"5","childIds":[],"role":{"type":"internalRole","value":"StaticText"},"name":{"type":"computedString","value":"Sign in"}},
        {"nodeId":"7","backendDOMNodeId":50,"parentId":"1","childIds":[],"role":{"type":"role","value":"textField"},"name":{"type":"computedString","value":"Search"},"value":{"type":"string","value":"current query"}},
        {"nodeId":"8","backendDOMNodeId":60,"parentId":"1","childIds":[],"role":{"type":"internalRole","value":"InlineTextBox"},"name":{"type":"computedString","value":""}},
        {"nodeId":"9","backendDOMNodeId":70,"parentId":"1","childIds":[],"role":{"type":"role","value":"button"},"name":{"type":"computedString","value":"Submit"},"properties":[{"name":"disabled","value":{"type":"boolean","value":true}},{"name":"focused","value":{"type":"boolean","value":false}}]}
      ]
    }"#;

    #[test]
    fn formats_ax_tree_with_refs_and_pruning() {
        let tree: AxTreeResponse = serde_json::from_str(AX_FIXTURE).expect("fixture parses");
        let (text, truncated) = format_ax_tree(&tree.nodes);
        assert!(!truncated);
        // 泛型容器被剪，heading 上提一级；Ignored/InlineTextBox 不出现。
        assert!(text.contains("[ref=12] heading(level 2) \"Welcome\""), "{text}");
        assert!(text.contains("[ref=40] button \"Sign in\""), "{text}");
        assert!(text.contains("[ref=50] textbox \"Search\" = \"current query\""), "{text}");
        // 状态注记：真值布尔属性进入快照行，false 不注记（缺省态不占预算）。
        assert!(text.contains("[ref=70] button \"Submit\" [已禁用]"), "{text}");
        assert!(!text.contains("[焦点中]"), "{text}");
        assert!(text.contains("page \"Test Page\""), "{text}");
        assert!(!text.contains("generic"));
        assert!(!text.contains("Ignored"));
        // 缩进体现层级：泛型容器被剪后 heading 提升为根层（无缩进），
        // button 仍是 page 的直接子级（两级缩进）。
        let heading_line = text.lines().find(|line| line.contains("heading")).unwrap();
        assert!(heading_line.starts_with("- "), "{heading_line}");
        let button_line = text.lines().find(|line| line.contains("button")).unwrap();
        assert!(button_line.starts_with("  - "), "{button_line}");
    }

    #[test]
    fn snapshot_truncates_over_cap() {
        let mut nodes = Vec::new();
        nodes.push(AxNode {
            node_id: "root".into(),
            backend_dom_node_id: Some(1),
            parent_id: None,
            ignored: false,
            role: AxValue { value: Value::String("WebArea".into()) },
            name: AxValue { value: Value::String("Big".into()) },
            value: AxValue::default(),
            properties: Vec::new(),
        });
        for i in 0..5000 {
            nodes.push(AxNode {
                node_id: format!("n{i}"),
                backend_dom_node_id: Some(i + 2),
                parent_id: Some("root".into()),
                ignored: false,
                role: AxValue { value: Value::String("staticText".into()) },
                name: AxValue { value: Value::String(format!("段落文本第{i}行，包含足够长的内容以触发截断保护逻辑")) },
                value: AxValue::default(),
                properties: Vec::new(),
            });
        }
        let (text, truncated) = format_ax_tree(&nodes);
        assert!(truncated);
        assert!(text.len() <= MAX_SNAPSHOT_CHARS + 200, "len={}", text.len());
        assert!(text.contains("快照已截断"));
    }

    #[test]
    fn key_definition_matrix() {
        let enter = key_definition("Enter").unwrap();
        assert_eq!(enter.virtual_key_code, 13);
        assert_eq!(enter.text.as_deref(), Some("\r"));
        let lower = key_definition("enter").unwrap();
        assert_eq!(lower.virtual_key_code, 13);
        let arrow = key_definition("ArrowDown").unwrap();
        assert_eq!(arrow.virtual_key_code, 40);
        let ch = key_definition("a").unwrap();
        assert_eq!(ch.virtual_key_code, 65);
        assert_eq!(ch.text.as_deref(), Some("a"));
        assert!(key_definition("ctrl+alt+del").is_none());
        assert!(key_definition("").is_none());
    }

    #[test]
    fn request_response_serde_round_trip() {
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"navigate","tabId":"t1","url":"https://example.com"}"#)
                .expect("deserialize navigate");
        match request {
            BrowserCommandRequest::Navigate { tab_id, url } => {
                assert_eq!(tab_id, "t1");
                assert_eq!(url, "https://example.com");
            }
            _ => panic!("wrong variant"),
        }
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"activateTab","tabId":"t1"}"#)
                .expect("deserialize activateTab");
        match request {
            BrowserCommandRequest::ActivateTab { tab_id } => {
                assert_eq!(tab_id, "t1");
            }
            _ => panic!("wrong variant"),
        }
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"navigationHistory","tabId":"t1"}"#)
                .expect("deserialize navigationHistory");
        match request {
            BrowserCommandRequest::NavigationHistory { tab_id } => {
                assert_eq!(tab_id, "t1");
            }
            _ => panic!("wrong variant"),
        }
        let response = BrowserCommandResponse::NavigationState {
            can_go_back: true,
            can_go_forward: false,
        };
        let encoded = serde_json::to_value(&response).expect("serialize navigationState");
        assert_eq!(encoded.get("type").and_then(Value::as_str), Some("navigationState"));
        assert_eq!(encoded.get("canGoBack"), Some(&Value::Bool(true)));
        assert_eq!(encoded.get("canGoForward"), Some(&Value::Bool(false)));
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"click","tabId":"t1","ref":42}"#)
                .expect("deserialize click");
        match request {
            BrowserCommandRequest::Click { tab_id, r#ref } => {
                assert_eq!(tab_id, "t1");
                assert_eq!(r#ref, 42);
            }
            _ => panic!("wrong variant"),
        }
        let response = BrowserCommandResponse::Snapshot {
            url: "https://example.com".into(),
            title: "Example".into(),
            text: "- text".into(),
            truncated: false,
            dialog: None,
        };
        let encoded = serde_json::to_value(&response).expect("serialize snapshot");
        assert_eq!(encoded.get("type").and_then(Value::as_str), Some("snapshot"));
        assert_eq!(
            encoded.get("image_base64"),
            None,
            "不同 variant 的字段不得互相泄漏"
        );
        let status = serde_json::to_value(BrowserCommandResponse::Status {
            running: false,
            port: None,
            engine: None,
            headless: None,
            version: None,
            tabs: None,
        })
        .expect("serialize status");
        assert_eq!(status.get("type").and_then(Value::as_str), Some("status"));
        assert!(status.get("port").is_none());
    }

    #[test]
    fn detect_engines_reports_known_bundles_only() {
        let engines = detect_engines(home().as_deref());
        let names: Vec<&str> = engines.iter().map(|engine| engine.engine.as_str()).collect();
        assert_eq!(names, BROWSER_EXECUTABLE_NAMES.to_vec());
    }

    /// 无 WS 连接的 CdpTab 测试替身：返回 outgoing 接收端以便检查 ack 出队。
    fn test_cdp_tab() -> (Arc<CdpTab>, mpsc::Receiver<String>) {
        let (outgoing_tx, outgoing_rx) = mpsc::channel(32);
        let (load_tx, _) = watch::channel(0u64);
        (
            Arc::new(CdpTab {
                outgoing: outgoing_tx,
                pending: Arc::new(StdMutex::new(HashMap::new())),
                next_id: AtomicI64::new(1),
                load_tx,
                dialog: Arc::new(StdMutex::new(None)),
                console: Arc::new(StdMutex::new(VecDeque::new())),
                screencast: Arc::new(StdMutex::new(ScreencastState::default())),
                events: None,
            }),
            outgoing_rx,
        )
    }

    #[test]
    fn new_request_variants_serde_round_trip() {
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"startScreencast","tabId":"t1","maxWidth":640,"maxHeight":480}"#)
                .expect("deserialize startScreencast");
        match request {
            BrowserCommandRequest::StartScreencast { tab_id, max_width, max_height } => {
                assert_eq!(tab_id, "t1");
                assert_eq!(max_width, Some(640));
                assert_eq!(max_height, Some(480));
            }
            _ => panic!("wrong variant"),
        }
        // maxWidth/maxHeight 可省略（面板未测量尺寸时按视口原始尺寸推流）。
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"startScreencast","tabId":"t1"}"#)
                .expect("deserialize startScreencast without size");
        assert!(matches!(request, BrowserCommandRequest::StartScreencast { max_width: None, max_height: None, .. }));
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"console","tabId":"t1"}"#)
                .expect("deserialize console");
        assert!(matches!(request, BrowserCommandRequest::Console { limit: None, .. }));
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"clickAt","tabId":"t1","x":10.5,"y":20.0}"#)
                .expect("deserialize clickAt");
        match request {
            BrowserCommandRequest::ClickAt { x, y, .. } => {
                assert_eq!(x, 10.5);
                assert_eq!(y, 20.0);
            }
            _ => panic!("wrong variant"),
        }
        let request: BrowserCommandRequest =
            serde_json::from_str(r#"{"action":"scrollAt","tabId":"t1","x":1,"y":2,"deltaY":-240}"#)
                .expect("deserialize scrollAt");
        match request {
            BrowserCommandRequest::ScrollAt { delta_x, delta_y, .. } => {
                assert_eq!(delta_x, None);
                assert_eq!(delta_y, Some(-240.0));
            }
            _ => panic!("wrong variant"),
        }
        let response = serde_json::to_value(BrowserCommandResponse::ScreencastStarted)
            .expect("serialize screencastStarted");
        assert_eq!(
            response.get("type").and_then(Value::as_str),
            Some("screencastStarted")
        );
        let response = serde_json::to_value(BrowserCommandResponse::ConsoleLog {
            entries: vec![ConsoleEntry {
                level: "error".into(),
                text: "boom".into(),
                source: "console".into(),
                timestamp: 1700000000,
            }],
        })
        .expect("serialize consoleLog");
        assert_eq!(response.get("type").and_then(Value::as_str), Some("consoleLog"));
        assert_eq!(response.pointer("/entries/0/level").and_then(Value::as_str), Some("error"));
        assert_eq!(response.pointer("/entries/0/timestamp").and_then(Value::as_i64), Some(1700000000));
    }

    #[test]
    fn console_event_parsers_and_read() {
        let (tab, _rx) = test_cdp_tab();
        handle_console_called(
            &tab,
            &json!({
                "method": "Runtime.consoleAPICalled",
                "params": {
                    "type": "error",
                    "args": [
                        {"type": "string", "value": "boom"},
                        {"type": "object", "description": "Error: x"},
                        {"type": "undefined"}
                    ]
                }
            }),
        );
        handle_exception_thrown(
            &tab,
            &json!({
                "method": "Runtime.exceptionThrown",
                "params": {"exceptionDetails": {"text": "Uncaught", "exception": {"description": "TypeError: null"}}}
            }),
        );
        handle_log_entry(
            &tab,
            &json!({
                "method": "Log.entryAdded",
                "params": {"entry": {"level": "error", "source": "network", "text": "Failed to load resource"}}
            }),
        );
        // 空文本条目不入缓冲。
        handle_log_entry(&tab, &json!({"method": "Log.entryAdded", "params": {"entry": {"level": "info", "source": "network", "text": ""}}}));
        match read_console(&tab, None) {
            BrowserCommandResponse::ConsoleLog { entries } => {
                assert_eq!(entries.len(), 3);
                assert_eq!(entries[0].level, "error");
                assert_eq!(entries[0].source, "console");
                assert_eq!(entries[0].text, "boom Error: x undefined");
                assert_eq!(entries[1].source, "exception");
                assert!(entries[1].text.contains("Uncaught：TypeError: null"), "{}", entries[1].text);
                assert_eq!(entries[2].source, "network");
                assert_eq!(entries[2].text, "Failed to load resource");
            }
            _ => panic!("expected consoleLog"),
        }
    }

    #[test]
    fn console_buffer_is_capped_and_truncated() {
        let (tab, _rx) = test_cdp_tab();
        for i in 0..(MAX_CONSOLE_ENTRIES + 20) {
            push_console_entry(&tab, "log", "console", &format!("line {i}"));
        }
        match read_console(&tab, Some(10_000)) {
            BrowserCommandResponse::ConsoleLog { entries } => {
                // 超限 limit clamp 到缓冲容量；环形淘汰后只剩最近 200 条。
                assert_eq!(entries.len(), MAX_CONSOLE_ENTRIES);
                assert_eq!(entries.first().unwrap().text, "line 20");
                assert_eq!(entries.last().unwrap().text, format!("line {}", MAX_CONSOLE_ENTRIES + 19));
            }
            _ => panic!("expected consoleLog"),
        }
        push_console_entry(&tab, "log", "console", &"x".repeat(MAX_CONSOLE_ENTRY_CHARS + 10));
        match read_console(&tab, Some(1)) {
            BrowserCommandResponse::ConsoleLog { entries } => {
                // 截断 = 上限字符 + 省略标记。
                assert_eq!(entries[0].text.chars().count(), MAX_CONSOLE_ENTRY_CHARS + 1);
                assert!(entries[0].text.ends_with('…'));
            }
            _ => panic!("expected consoleLog"),
        }
    }

    #[tokio::test]
    async fn screencast_frame_immediate_ack_and_throttle() {
        let (tab, mut outgoing_rx) = test_cdp_tab();
        let frame = json!({
            "method": "Page.screencastFrame",
            "params": {
                "data": "aGVsbG8=",
                "sessionId": 7,
                "metadata": {"deviceWidth": 800, "deviceHeight": 600}
            }
        });
        // 未激活时：ack 仍然立即发出（防停流），帧被丢弃。
        handle_screencast_frame(&tab, &frame);
        let ack = tokio::time::timeout(Duration::from_millis(100), outgoing_rx.recv())
            .await
            .expect("ack queued")
            .expect("ack present");
        assert!(ack.contains("Page.screencastFrameAck"), "{ack}");
        assert!(ack.contains("\"sessionId\":7"), "{ack}");
        assert!(tab.screencast.lock().unwrap().last_emit.is_none());

        // 激活后：第一帧记录节流锚点，节流窗口内的第二帧被丢弃但 ack 照发。
        tab.screencast.lock().unwrap().active = true;
        handle_screencast_frame(&tab, &frame);
        let first_emit = tab.screencast.lock().unwrap().last_emit;
        assert!(first_emit.is_some());
        let ack = tokio::time::timeout(Duration::from_millis(100), outgoing_rx.recv())
            .await
            .expect("second ack queued")
            .expect("second ack present");
        assert!(ack.contains("Page.screencastFrameAck"));
        handle_screencast_frame(&tab, &frame);
        assert_eq!(
            tab.screencast.lock().unwrap().last_emit, first_emit,
            "节流窗口内的帧不得刷新锚点"
        );
    }

    #[test]
    fn cleans_stale_locks_only_when_no_live_holder() {
        let dir = std::env::temp_dir().join(format!("axiom-lock-cleanup-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let marker_exists = |name: &str| dir.join(name).exists();
        for marker in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
            let _ = std::fs::write(dir.join(marker), b"x");
        }
        // 已有一个假 profile 目录作为子集：锁文件都就位。
        assert!(marker_exists("SingletonLock"));
        cleanup_stale_locks_if_unheld(&dir);
        assert!(!marker_exists("SingletonLock"), "无活体持有者时锁应被清理");
        assert!(!marker_exists("SingletonSocket"));
        assert!(!marker_exists("SingletonCookie"));
        // 有活体持有者（sleep 伪造浏览器命令行）：锁必须保留。
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("30").process_group(0);
        command.arg0(format!("AxiomTestBrowser --user-data-dir={}", dir.display()));
        let mut holder = command.spawn().expect("spawn fake holder");
        for marker in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
            let _ = std::fs::write(dir.join(marker), b"x");
        }
        cleanup_stale_locks_if_unheld(&dir);
        assert!(marker_exists("SingletonLock"), "有活体持有者时锁不得清理（防并发写口）");
        let _ = holder.kill();
        let _ = holder.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn terminates_stale_profile_holder_process() {
        use std::os::unix::process::CommandExt;
        let dir = std::env::temp_dir().join(format!("axiom-stale-holder-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        // arg0 伪装浏览器命令行（ps 扫描按 --user-data-dir=<profile> 匹配），
        // process_group(0) 对齐真实浏览器 spawn 形态，让组信号精确命中。
        let spawn_fake = |carry_marker: bool| {
            let mut command = std::process::Command::new("/bin/sleep");
            command.arg("30").process_group(0);
            if carry_marker {
                command.arg0(format!("AxiomTestBrowser --user-data-dir={}", dir.display()));
            }
            command.spawn().expect("spawn fake holder")
        };
        let mut unrelated = spawn_fake(false);
        let mut fake = spawn_fake(true);
        let pid = fake.id() as i32;
        assert!(
            find_stale_profile_holders(&dir).contains(&pid),
            "扫描必须发现持有 profile 的进程"
        );
        assert!(
            !find_stale_profile_holders(&dir).contains(&(unrelated.id() as i32)),
            "不携带 --user-data-dir 的进程不得命中"
        );
        assert!(terminate_stale_profile_holders(&dir).await, "应报告已清理");
        let _ = fake.wait();
        assert!(
            !find_stale_profile_holders(&dir).contains(&pid),
            "清理后残留进程应已退出"
        );
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------
    // 真链路集成测试：本机存在 Chromium 系浏览器时跑完整 spawn→navigate→
    // snapshot→click→screenshot→shutdown；无浏览器时显式跳过（CI 无 Chrome
    // 不红，本机开发可跑）。
    // -----------------------------------------------------------------

    fn spawn_fixture_http_server() -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
        let addr = listener.local_addr().expect("fixture addr");
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buffer);
                let body = concat!(
                    "<!doctype html><html><head><title>Browser Test</title></head><body>",
                    "<h1>Fixture Heading</h1>",
                    "<button id=\"b\" onclick=\"document.getElementById('out').textContent='clicked-mark'\">Click Source</button>",
                    "<div id=\"out\"></div></body></html>"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
            }
        });
        (format!("http://{addr}/"), handle)
    }

    #[tokio::test]
    async fn browser_session_end_to_end_when_chromium_available() {
        let engines = detect_engines(home().as_deref());
        let Some(engine) = engines.iter().find(|engine| engine.available) else {
            eprintln!("skipping browser E2E: no Chromium-family browser installed");
            return;
        };
        let data_root = tempfile::tempdir().expect("temp data root");
        let state = BrowserSessionState::default();
        let config = BrowserSpawnConfig {
            enabled: false,
            executable_path: String::new(),
            headless: true,
        };
        // 未启用的配置必须 fail-closed。
        assert!(ensure_running(None, data_root.path(), &state, &config).await.is_err());

        let config = BrowserSpawnConfig {
            enabled: true,
            executable_path: engine.path.clone(),
            headless: true,
        };
        let response = ensure_running(None, data_root.path(), &state, &config).await.expect("browser starts");
        let BrowserCommandResponse::Status { running, version, .. } = response else {
            panic!("expected status response");
        };
        assert!(running);
        assert!(version.unwrap_or_default().starts_with("Chrome/"));

        let (base_url, _server) = spawn_fixture_http_server();
        let opened = open_new_tab(None, &state, Some(base_url.clone())).await.expect("new tab + navigate");
        let BrowserCommandResponse::TabOpened { tab } = opened else {
            panic!("expected tab opened");
        };
        let tab_id = tab.tab_id.clone();
        assert_eq!(tab.title, "Browser Test");

        let (tab_handle, _port) = take_connected_tab(&state, &tab_id).expect("tab registered");
        // 等待点击效果可见需要先有稳定快照；直接取快照。
        let result = tab_handle
            .send("Accessibility.getFullAXTree", json!({}))
            .await
            .expect("ax tree");
        let tree: AxTreeResponse = serde_json::from_value(result).expect("ax parse");
        let (text, truncated) = format_ax_tree(&tree.nodes);
        assert!(!truncated);
        assert!(text.contains("Click Source"), "{text}");
        // 提取按钮 ref（快照行格式 `- [ref=N] button "Click Source"`）。
        let button_ref = text
            .lines()
            .find(|line| line.contains("button") && line.contains("Click Source"))
            .and_then(|line| line.split("[ref=").nth(1))
            .and_then(|rest| rest.split(']').next())
            .and_then(|value| value.parse::<i64>().ok())
            .expect("button ref in snapshot");
        let (x, y) = ref_box_center(&tab_handle, button_ref).await.expect("box center");
        dispatch_mouse(&tab_handle, "mousePressed", x, y).await.expect("press");
        dispatch_mouse(&tab_handle, "mouseReleased", x, y).await.expect("release");

        // 点击效果轮询（JS 执行是异步的）。
        let mut clicked = false;
        for _ in 0..20 {
            let result = tab_handle
                .send("Accessibility.getFullAXTree", json!({}))
                .await
                .expect("ax tree poll");
            let tree: AxTreeResponse = serde_json::from_value(result).expect("ax parse poll");
            let (text, _) = format_ax_tree(&tree.nodes);
            if text.contains("clicked-mark") {
                clicked = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        assert!(clicked, "click effect should appear in snapshot");

        let screenshot = tab_handle
            .send("Page.captureScreenshot", json!({"format": "png"}))
            .await
            .expect("screenshot");
        let data = screenshot.get("data").and_then(Value::as_str).expect("screenshot data");
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).expect("decode png");
        assert_eq!(&bytes[0..8], b"\x89PNG\r\n\x1a\n", "PNG magic");

        let tabs = list_browser_tabs(&state).await.expect("list tabs");
        let BrowserCommandResponse::Tabs { tabs } = tabs else {
            panic!("expected tabs response");
        };
        assert!(tabs.iter().any(|info| info.tab_id == tab_id));

        shutdown_browser(None, &state).await.expect("shutdown");
        let guard = state.0.lock().expect("state cleared");
        assert!(guard.is_none());
    }

    #[tokio::test]
    async fn ensure_running_recovers_from_stale_profile_holder() {
        let engines = detect_engines(home().as_deref());
        let Some(engine) = engines.iter().find(|engine| engine.available) else {
            eprintln!("skipping stale-holder E2E: no Chromium-family browser installed");
            return;
        };
        let data_root = tempfile::tempdir().expect("temp data root");
        let profile_dir = browser_profile_dir(data_root.path()).expect("profile dir");
        // 模拟上次应用异常退出遗留的孤儿实例：直接 spawn 同 profile 浏览器
        // 且不登记到会话状态——ensure_running 首航会被单实例机制转交秒退，
        // 自愈路径应终止孤儿并重试成功。
        let stale_port = pick_loopback_port().expect("stale port");
        let mut stale_command = Command::new(&engine.path);
        stale_command
            .args(chrome_args(stale_port, &profile_dir, true))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut stale = stale_command.spawn().expect("spawn stale browser");
        assert!(
            matches!(
                wait_ready_or_exit(stale_port, &mut stale).await,
                SpawnWaitOutcome::Ready(_)
            ),
            "模拟的残留实例应先完整启动并持有 profile"
        );
        let state = BrowserSessionState::default();
        let config = BrowserSpawnConfig {
            enabled: true,
            executable_path: engine.path.clone(),
            headless: true,
        };
        let response = ensure_running(None, data_root.path(), &state, &config)
            .await
            .expect("秒退自愈后应启动成功");
        let BrowserCommandResponse::Status { running, .. } = response else {
            panic!("expected status response");
        };
        assert!(running);
        shutdown_browser(None, &state).await.expect("shutdown");
        let _ = stale.start_kill();
        let _ = stale.wait().await;
    }
}
