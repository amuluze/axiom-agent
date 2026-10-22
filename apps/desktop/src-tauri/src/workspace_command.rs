#[cfg(unix)]
use crate::bash_policy_generated::DEFAULT_SHELL;
use crate::{
    bash_policy_generated::{
        MAX_COMMAND_BYTES, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, OUTSIDE_WORKSPACE_REDIRECT_PATTERN,
        SUDO_COMMAND_PREFIX_PATTERN,
    },
    platform_process::{signal_process_group, TreeSignal},
    sandbox::{self, CommandTier},
    workspace_access::{authorized_root_for, WorkspaceAccessState},
    workspace_approval::WorkspaceApprovalState,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
    process::ExitStatus,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::{mpsc, watch},
    time::{sleep, sleep_until, timeout},
};

const WORKSPACE_COMMAND_EVENT: &str = "axiom:workspace-command";
const PIPE_BUFFER_BYTES: usize = 8 * 1024;
const TERMINATION_GRACE_MS: u64 = 500;
/// 子进程环境透传白名单（浏览器会话等其它子进程通道同样复用：env_clear 后仅
/// 保留这些与用户身份/语言相关的无敏感变量，API Key 一律不进入子进程）。
pub(crate) const PASSTHROUGH_ENVIRONMENT: &[&str] = &[
    "CONTAINER_HOST",
    "DOCKER_HOST",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
];
/// 自由命令模型的尽力拦截（策略常量由 `contracts/bash-policy.json` 生成）：
/// 拒绝常见 sudo 提升与输出重定向到工作区外。定位为"减速带"而非安全边界，
/// 标准模式的沙箱才是执行边界，完全访问没有可靠的命令级隔离。
/// 行为语料与 TS 侧一致性由 `scripts/bash-policy-audit.mjs` 强制。
fn compiled_pattern(pattern: &'static str) -> &'static Regex {
    static SUDO_RE: OnceLock<Regex> = OnceLock::new();
    static REDIRECT_RE: OnceLock<Regex> = OnceLock::new();
    match pattern {
        SUDO_COMMAND_PREFIX_PATTERN => {
            SUDO_RE.get_or_init(|| Regex::new(pattern).expect("compile-time sudo pattern"))
        }
        _ => {
            REDIRECT_RE.get_or_init(|| Regex::new(pattern).expect("compile-time redirect pattern"))
        }
    }
}

/// 自由命令模型的权威拒绝规则。当前只拒绝两类明确不安全模式：
/// sudo 提升为超级用户权限，以及把输出重定向到工作区之外。
/// 其余命令仍按自由命令模型执行，逐次审批是主要安全阀。
fn reject_unsafe_free_command(command: &str) -> Result<(), String> {
    if compiled_pattern(SUDO_COMMAND_PREFIX_PATTERN).is_match(command) {
        return Err("sudo 命令被拒绝：Axiom 不允许以超级用户权限执行命令".into());
    }
    if compiled_pattern(OUTSIDE_WORKSPACE_REDIRECT_PATTERN).is_match(command) {
        return Err("重定向到工作区外被拒绝：命令输出目标必须是工作区内的相对路径".into());
    }
    Ok(())
}

/// 运行中命令的取消句柄及其所属工作区根目录。工作区归属用于撤销授权时的
/// 作用域收窄：撤销 A 只取消挂载在 A 下的命令，不误杀 B 的并行会话命令。
struct TrackedWorkspaceCommand {
    cancel: watch::Sender<bool>,
    workspace_root: PathBuf,
}

#[derive(Default)]
pub(crate) struct WorkspaceCommandState {
    commands: Mutex<HashMap<String, TrackedWorkspaceCommand>>,
}

impl WorkspaceCommandState {
    /// pub(crate)：并发回归测试需要直接登记一个「在途命令」来验证撤销的取消
    /// 时序（revoke_workspace_core 的写锁临界区）。
    pub(crate) fn register(
        &self,
        request_id: &str,
        workspace_root: &Path,
    ) -> Result<watch::Receiver<bool>, String> {
        let mut commands = self
            .commands
            .lock()
            .map_err(|_| "workspace command state lock is poisoned".to_string())?;
        if commands.contains_key(request_id) {
            return Err("workspace command request ID is already active".into());
        }
        let (sender, receiver) = watch::channel(false);
        commands.insert(
            request_id.to_string(),
            TrackedWorkspaceCommand {
                cancel: sender,
                workspace_root: workspace_root.to_path_buf(),
            },
        );
        Ok(receiver)
    }

    fn unregister(&self, request_id: &str) {
        if let Ok(mut commands) = self.commands.lock() {
            commands.remove(request_id);
        }
    }

    /// 只取消挂载在指定工作区下的运行中命令（撤销授权的作用域收窄），
    /// 返回取消数量。其他工作区的命令不受影响。
    pub(crate) fn cancel_for_workspace(&self, workspace_root: &Path) -> Result<usize, String> {
        let commands = self
            .commands
            .lock()
            .map_err(|_| "workspace command state lock is poisoned".to_string())?;
        let mut cancelled = 0;
        for command in commands.values() {
            if command.workspace_root == workspace_root {
                let _ = command.cancel.send(true);
                cancelled += 1;
            }
        }
        Ok(cancelled)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCommandRequest {
    request_id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    #[serde(default)]
    vcs_credentials: bool,
    #[serde(default)]
    container_control: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum CommandStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCommandEvent {
    request_id: String,
    stream: Option<CommandStream>,
    chunk: Option<Vec<u8>>,
    done: bool,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    stdout_bytes: Option<u64>,
    stderr_bytes: Option<u64>,
    truncated: Option<bool>,
    cancelled: Option<bool>,
    timed_out: Option<bool>,
    /// seatbelt deny 条目（仅沙箱执行且非空时携带）。
    sandbox_denials: Option<Vec<String>>,
    /// 本命令是否在 seatbelt 沙箱内执行（done 事件携带；chunk 事件为 None）。
    sandboxed: Option<bool>,
    error: Option<String>,
}

#[derive(Clone, Debug)]
struct ValidatedCommand {
    request_id: String,
    command: String,
    cwd: PathBuf,
    workspace_root: PathBuf,
    timeout: Option<Duration>,
    tier: CommandTier,
    privileges: sandbox::SandboxPrivileges,
}

#[derive(Clone, Debug)]
struct CommandOutcome {
    exit_code: Option<i32>,
    duration_ms: u64,
    stdout_bytes: u64,
    stderr_bytes: u64,
    truncated: bool,
    cancelled: bool,
    timed_out: bool,
    /// 本命令进程组内的 seatbelt deny 条目（去重后，可为空）。诊断辅助：
    /// 让模型/用户看到「命令到底被沙箱拒了什么操作」，而非裸 EPERM。
    sandbox_denials: Vec<String>,
    sandboxed: bool,
}

impl WorkspaceCommandEvent {
    fn chunk(request_id: &str, stream: CommandStream, chunk: Vec<u8>) -> Self {
        Self {
            request_id: request_id.to_string(),
            stream: Some(stream),
            chunk: Some(chunk),
            done: false,
            exit_code: None,
            duration_ms: None,
            stdout_bytes: None,
            stderr_bytes: None,
            truncated: None,
            cancelled: None,
            timed_out: None,
            sandbox_denials: None,
            sandboxed: None,
            error: None,
        }
    }

    fn done(request_id: &str, outcome: &CommandOutcome) -> Self {
        Self {
            request_id: request_id.to_string(),
            stream: None,
            chunk: None,
            done: true,
            exit_code: outcome.exit_code,
            duration_ms: Some(outcome.duration_ms),
            stdout_bytes: Some(outcome.stdout_bytes),
            stderr_bytes: Some(outcome.stderr_bytes),
            truncated: Some(outcome.truncated),
            cancelled: Some(outcome.cancelled),
            timed_out: Some(outcome.timed_out),
            sandbox_denials: (!outcome.sandbox_denials.is_empty())
                .then(|| outcome.sandbox_denials.clone()),
            sandboxed: Some(outcome.sandboxed),
            error: None,
        }
    }
}

struct OutputBudget {
    remaining: AtomicUsize,
    truncated: AtomicBool,
    stdout_bytes: AtomicU64,
    stderr_bytes: AtomicU64,
}

impl OutputBudget {
    fn new() -> Self {
        Self {
            remaining: AtomicUsize::new(MAX_OUTPUT_BYTES),
            truncated: AtomicBool::new(false),
            stdout_bytes: AtomicU64::new(0),
            stderr_bytes: AtomicU64::new(0),
        }
    }

    fn capture(&self, stream: CommandStream, bytes: &[u8]) -> Option<Vec<u8>> {
        match stream {
            CommandStream::Stdout => {
                self.stdout_bytes
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
            }
            CommandStream::Stderr => {
                self.stderr_bytes
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
            }
        }

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

enum PipeEvent {
    Chunk(CommandStream, Vec<u8>),
    Error(CommandStream, String),
}

fn resolve_command_cwd(root: &Path, raw_cwd: Option<&str>) -> Result<PathBuf, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("failed to resolve authorized workspace: {error}"))?;
    let raw_cwd = raw_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(".");
    if raw_cwd.len() > 16 * 1024 {
        return Err("workspace command cwd is too long".into());
    }
    let relative = Path::new(raw_cwd);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("workspace command cwd must be a relative path without '..'".into());
    }
    let canonical = std::fs::canonicalize(canonical_root.join(relative))
        .map_err(|error| format!("failed to resolve workspace command cwd: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("workspace command cwd resolves outside the authorized root".into());
    }
    if !std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect workspace command cwd: {error}"))?
        .is_dir()
    {
        return Err("workspace command cwd must be a directory".into());
    }
    Ok(canonical)
}

fn validate_request(
    root: &Path,
    request: WorkspaceCommandRequest,
) -> Result<ValidatedCommand, String> {
    let request_id =
        crate::request_id::validate_request_id("workspace command", &request.request_id)?
            .to_string();
    let workspace_root = std::fs::canonicalize(root)
        .map_err(|error| format!("failed to resolve authorized workspace: {error}"))?;
    let command = request.command.trim().to_string();
    if command.is_empty() {
        return Err("workspace command must be a non-empty string".into());
    }
    if command.len() > MAX_COMMAND_BYTES {
        return Err("workspace command is too long".into());
    }
    reject_unsafe_free_command(&command)?;
    let cwd = resolve_command_cwd(root, request.cwd.as_deref())?;
    let timeout = match request.timeout_ms {
        Some(ms) if ms > 0 => {
            if ms > MAX_TIMEOUT_MS {
                return Err(format!(
                    "workspace command timeout must not exceed {} ms",
                    MAX_TIMEOUT_MS
                ));
            }
            Some(Duration::from_millis(ms))
        }
        Some(_) => {
            return Err("workspace command timeout must be positive".into());
        }
        None => None,
    };
    let tier = sandbox::classify_command(&command, false);
    Ok(ValidatedCommand {
        request_id,
        command,
        cwd,
        workspace_root,
        timeout,
        tier,
        privileges: sandbox::SandboxPrivileges {
            vcs_credentials: request.vcs_credentials,
            container_control: request.container_control,
        },
    })
}

/// 剔除解析到授权工作区内的 PATH 条目，防止恶意仓库把 git/node shim 注入命令查找
/// 路径（terminal.rs 同语义复用本函数）。同时把常见用户工具链目录**追加**到末尾：
/// GUI 启动（Finder/Dock）时进程只继承 launchd 最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
/// node/cargo/mise 等完全不可见，命令直接 command not found。追加不改变用户 shell
/// 已注入条目的优先级（继承条目在前），候选均为用户主目录约定安装位——与用户终端
/// 里的工具链同源同信任级。
pub(crate) fn sanitized_path_with_toolchain_fallback(
    workspace_root: &Path,
    inherited_path: Option<&OsStr>,
    home: Option<&Path>,
) -> Option<OsString> {
    let inherited = inherited_path?;
    let canonical_root =
        std::fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
    let mut entries: Vec<PathBuf> = std::env::split_paths(inherited)
        .filter(|path| {
            path.is_absolute()
                && std::fs::canonicalize(path)
                    .map(|canonical| !canonical.starts_with(&canonical_root))
                    .unwrap_or(false)
        })
        .collect();
    if let Some(home) = home {
        append_toolchain_dirs(&mut entries, home);
    }
    std::env::join_paths(entries).ok()
}

/// 工具链兜底目录追加：存在才追加、按 canonical 路径去重（用户 shell 已注入的目录
/// 天然跳过）。顺序为版本管理器 → 语言/包管理器 bin → 系统约定前缀。
fn append_toolchain_dirs(entries: &mut Vec<PathBuf>, home: &Path) {
    let mut candidates: Vec<PathBuf> = vec![
        home.join(".local/share/mise/shims"),
        home.join(".volta/bin"),
        home.join(".asdf/shims"),
        home.join(".cargo/bin"),
        home.join(".bun/bin"),
        home.join(".deno/bin"),
        home.join("Library/pnpm"),
        home.join("go/bin"),
        home.join(".local/bin"),
    ];
    if let Some(nvm) = latest_nvm_node_bin(home) {
        candidates.insert(1, nvm);
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/usr/local/go/bin"),
    ]);
    let mut seen: std::collections::HashSet<PathBuf> = entries
        .iter()
        .filter_map(|entry| std::fs::canonicalize(entry).ok())
        .collect();
    for dir in candidates {
        // 不存在（用户未装该工具链）即跳过；canonicalize 同时给去重提供真实路径。
        let Ok(canonical) = std::fs::canonicalize(&dir) else {
            continue;
        };
        if seen.insert(canonical) {
            entries.push(dir);
        }
    }
}

/// nvm 版本目录枚举：只取最高版本的 bin（语义化数字比较，`v10.1.0` > `v9.11.2`，
/// 字典序会判错）。目录名形如 `v22.11.0`，非版本目录（io.js 残留等）跳过。
fn latest_nvm_node_bin(home: &Path) -> Option<PathBuf> {
    let versions_root = home.join(".nvm/versions/node");
    let mut latest: Option<(Vec<u64>, PathBuf)> = None;
    for entry in std::fs::read_dir(&versions_root).ok()?.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let stripped = name.strip_prefix('v').unwrap_or(&name);
        let parts = stripped
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>();
        let Ok(parts) = parts else {
            continue;
        };
        if parts.is_empty() {
            continue;
        }
        let bin = entry.path().join("bin");
        if !bin.is_dir() {
            continue;
        }
        if latest.as_ref().is_none_or(|(best, _)| parts > *best) {
            latest = Some((parts, bin));
        }
    }
    latest.map(|(_, bin)| bin)
}

/// 凭据输出遮盖：向模型回传 stdout/stderr 前对常见凭据模式脱敏。
/// 定位是纵深防御的最终闸门而非完整防线（base64 / 编码可绕过）——第一道闸是 §5 凭据
/// deny，第二道闸是这里（docs/os-sandbox-plan.md §8.2）。对不可解码为 UTF-8 的
/// 二进制输出原样透传（凭据几乎总是文本）。
pub(crate) fn redact_credentials(bytes: &[u8]) -> Vec<u8> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return bytes.to_vec(),
    };
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        // 键名形态三类：裸键值(token=…)、JSON 引号键("apiKey": "…")、复合环境
        // 变量名(AWS_SECRET_ACCESS_KEY=…，显式枚举——`\b` 会被前导 `_` 破坏)。
        // `authorization` 单列：值是「scheme + 空格 + 凭据」，进通用键值分支只会
        // 遮掉 scheme 本身、留下凭据。AWS 键原文（AKIA/ASIA + 16 位大写）大小写
        // 敏感匹配，避免 (?i) 把任意 20 字母单词误伤。
        Regex::new(
            r#"(?i)(?:(?:https?|ftp)://[^@\s/]+:[^@\s/]+@)|(?:(?:https?|ftp)://[^@\s/]+@)|\b(?:token|password|secret|access_key|secret_key|auth_token|api[_-]?key|aws_secret_access_key|aws_access_key_id|aws_session_token|github_token|gitlab_token|private_token|client_secret)["']?\s*[:=]\s*["']?[^\s"']+|\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+[^\s"',]+|\bbearer\s+[A-Za-z0-9_\-.=+/]{16,}|(?-i:\b(?:AKIA|ASIA)[0-9A-Z]{16}\b)|\bmachine\s+\S+\s+login\s+\S+\s+password\s+\S+"#,
        )
        .expect("compile-time credential redaction pattern")
    });
    pattern
        .replace_all(text, "[REDACTED]")
        .into_owned()
        .into_bytes()
}

fn configure_environment(
    command: &mut Command,
    workspace_root: &Path,
    sandbox_tmpdir: Option<&Path>,
) {
    command.env_clear();
    for name in PASSTHROUGH_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            // 沙箱会话内 TMPDIR 由 sandbox_tmpdir 覆盖（profile 参数与进程环境必须一致，
            // 见 docs/os-sandbox-plan.md §3.2），跳过宿主 TMPDIR 透传。
            if *name == "TMPDIR" && sandbox_tmpdir.is_some() {
                continue;
            }
            command.env(name, value);
        }
    }
    if let Some(tmpdir) = sandbox_tmpdir {
        command.env("TMPDIR", tmpdir);
    }
    if let Some(path) = sanitized_path_with_toolchain_fallback(
        workspace_root,
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").as_deref().map(Path::new),
    ) {
        command.env("PATH", path);
    }
    command.env("NO_COLOR", "1");
    command.env("CI", "1");
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_PAGER", "cat");
    command.env("PAGER", "cat");
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    // 强制覆盖仓库级 git 配置的执行面（见 git_config.rs）：GIT_CONFIG_COUNT 环境变量
    // 优先级高于仓库 .git/config，恶意仓库把可执行程序挂到驱动类配置键上时被压制。
    command.env(
        "GIT_CONFIG_COUNT",
        crate::git_config::git_config_neutralization()
            .len()
            .to_string(),
    );
    for (index, (key, value)) in crate::git_config::git_config_neutralization()
        .iter()
        .enumerate()
    {
        command.env(format!("GIT_CONFIG_KEY_{index}"), *key);
        command.env(format!("GIT_CONFIG_VALUE_{index}"), *value);
    }
}

/// 沙箱宿主 HOME（seatbelt profile 参数与工具链配置洞的基准）。
/// （仅沙箱路径消费；Windows 无沙箱后端，保留编译。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn host_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME environment variable is unavailable for sandboxing".into())
}

/// 创建会话级沙箱 tmpdir（`$TMPDIR/axiom-<request_id>/`），返回 canonical 化路径。
/// canonicalize 必要：seatbelt 按解析后的 vnode 判定，`/tmp` 是 `/private/tmp` 的符号链接，
/// 非 canonical 路径会导致文件操作被拒（冒烟实证）。
/// （仅沙箱路径消费；Windows 无沙箱后端，保留编译。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn prepare_sandbox_tmpdir(request_id: &str) -> Result<PathBuf, String> {
    let base = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let dir = base.join(format!("axiom-{request_id}"));
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create sandbox tmpdir {}: {error}", dir.display()))?;
    std::fs::canonicalize(&dir)
        .map_err(|error| format!("failed to canonicalize sandbox tmpdir: {error}"))
}

/// profile 文件目录：数据根下的应用私有路径（`~/.axiom/sandbox/`，0700）。
/// 放共享 /tmp 存在被篡改为宽松规则的攻击面（docs/os-sandbox-plan.md §7.1）。
/// 仅 seatbelt 后端需要（bwrap 参数即声明，无 profile 文件落盘，同时消除了
/// 临时 .sb 文件的 TOCTOU 面）。
#[cfg(target_os = "macos")]
fn sandbox_profile_dir(home: &Path) -> Result<PathBuf, String> {
    let dir = crate::storage_paths::ensure_data_root_at(home)?.join("sandbox");
    std::fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "failed to create sandbox profile dir {}: {error}",
            dir.display()
        )
    })?;
    Ok(dir)
}

/// 沙箱会话序号：保证同进程内并发命令的 profile 文件 / 会话 tmpdir 命名唯一。
/// （仅沙箱路径消费；Windows 无沙箱后端，保留编译。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
static SANDBOX_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 命令结束后清理 profile 文件与会话 tmpdir。spawn 后 crash/SIGKILL 的残留由
/// 下次初始化时的 mtime 清理兜底（docs/os-sandbox-plan.md §7.1）。
struct SandboxArtifacts {
    /// seatbelt profile 文件；bwrap 后端无 profile 文件（None，无需清理）。
    profile_path: Option<PathBuf>,
    tmpdir: Option<PathBuf>,
}

impl Drop for SandboxArtifacts {
    fn drop(&mut self) {
        if let Some(profile_path) = &self.profile_path {
            let _ = std::fs::remove_file(profile_path);
        }
        if let Some(tmpdir) = &self.tmpdir {
            let _ = std::fs::remove_dir_all(tmpdir);
        }
    }
}

async fn read_pipe<R>(
    mut reader: R,
    stream: CommandStream,
    sender: mpsc::UnboundedSender<PipeEvent>,
    budget: Arc<OutputBudget>,
) where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0_u8; PIPE_BUFFER_BYTES];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => return,
            Ok(count) => {
                if let Some(captured) = budget.capture(stream, &buffer[..count]) {
                    let _ = sender.send(PipeEvent::Chunk(stream, captured));
                }
            }
            Err(error) => {
                let _ = sender.send(PipeEvent::Error(stream, error.to_string()));
                return;
            }
        }
    }
}

async fn wait_after_termination(
    process_id: u32,
    wait: &mut std::pin::Pin<Box<impl std::future::Future<Output = std::io::Result<ExitStatus>>>>,
) -> Result<ExitStatus, String> {
    let _ = signal_process_group(process_id, TreeSignal::Graceful)?;
    match timeout(Duration::from_millis(TERMINATION_GRACE_MS), wait.as_mut()).await {
        Ok(status) => status.map_err(|error| error.to_string()),
        Err(_) => {
            let _ = signal_process_group(process_id, TreeSignal::Force)?;
            wait.as_mut().await.map_err(|error| error.to_string())
        }
    }
}

async fn terminate_remaining_process_group(process_id: u32) -> Result<(), String> {
    if !signal_process_group(process_id, TreeSignal::Graceful)? {
        return Ok(());
    }
    sleep(Duration::from_millis(50)).await;
    let _ = signal_process_group(process_id, TreeSignal::Force)?;
    Ok(())
}

fn command_exit_code(status: &ExitStatus) -> Option<i32> {
    status.code()
}

fn sandbox_command(
    command: &ValidatedCommand,
    network_policy: sandbox::NetworkPolicy,
) -> Result<
    (
        Command,
        SandboxArtifacts,
        Option<sandbox::SandboxDenialCapture>,
    ),
    String,
> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let denial_capture = sandbox::SandboxDenialCapture::start();
        let home = host_home()?;
        sandbox::workspace_sensitive_scope(&home, &command.workspace_root)?;
        sandbox::validate_privileged_paths(&home, command.privileges)?;
        // 沙箱会话 id：request_id + 进程内原子序号，保证并发命令（即使 request_id
        // 相同，如测试并行 / retry）不共用 profile 文件 / tmpdir / 会话命名空间。
        let sequence = SANDBOX_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let sandbox_id = format!("{}-{sequence}", command.request_id);
        let sandbox_tmpdir = prepare_sandbox_tmpdir(&sandbox_id)?;
        #[cfg(target_os = "macos")]
        let (process, artifacts) = {
            let sandbox_dir = sandbox_profile_dir(&home)?;
            let profile = sandbox::generate_sandbox_profile(
                &command.workspace_root,
                &home,
                &sandbox_tmpdir,
                &sandbox_dir,
                &sandbox_id,
                network_policy,
                command.privileges,
            )?;
            let mut wrapped = Command::new("/usr/bin/sandbox-exec");
            wrapped
                .arg("-D")
                .arg(format!("WORKSPACE={}", command.workspace_root.display()))
                .arg("-D")
                .arg(format!("HOME={}", home.display()))
                .arg("-D")
                .arg(format!("TMPDIR={}", sandbox_tmpdir.display()))
                .arg("-f")
                .arg(&profile.path)
                .arg(DEFAULT_SHELL)
                .arg("-c")
                .arg(&command.command);
            let artifacts = SandboxArtifacts {
                profile_path: Some(profile.path),
                tmpdir: Some(sandbox_tmpdir),
            };
            (wrapped, artifacts)
        };
        #[cfg(target_os = "linux")]
        let (process, artifacts) = {
            // bwrap 参数生成是纯函数（macOS 构建同样单测其语义）；容器 socket 与
            // resolv.conf 重绑目标在此读取宿主状态后传入。
            if command.privileges.container_control {
                std::fs::create_dir_all(home.join(".docker")).map_err(|error| {
                    format!("failed to prepare authorized Docker configuration directory: {error}")
                })?;
            }
            let args = sandbox::generate_bwrap_args(&sandbox::BwrapSandboxSpec {
                workspace_root: &command.workspace_root,
                home: &home,
                tmpdir: &sandbox_tmpdir,
                network: network_policy,
                allow_vcs_credentials: command.privileges.vcs_credentials,
                allow_container_control: command.privileges.container_control,
                var_run_is_symlink: std::path::Path::new("/var/run")
                    .symlink_metadata()
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false),
                resolv_conf_rebind: sandbox::resolv_conf_rebind_path().as_deref(),
                container_sockets: &sandbox::container_sockets_for_command(&home),
            });
            let mut wrapped = Command::new(sandbox::sandbox_program());
            wrapped
                .args(args)
                .arg(DEFAULT_SHELL)
                .arg("-c")
                .arg(&command.command);
            let artifacts = SandboxArtifacts {
                profile_path: None,
                tmpdir: Some(sandbox_tmpdir),
            };
            (wrapped, artifacts)
        };
        Ok((process, artifacts, denial_capture))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (command.privileges, network_policy);
        Err(sandbox::sandbox_unavailable_error(
            "command execution is unsupported",
        ))
    }
}

async fn execute_command<F>(
    command: ValidatedCommand,
    cancellation: watch::Receiver<bool>,
    emit: F,
) -> Result<CommandOutcome, String>
where
    F: FnMut(WorkspaceCommandEvent) -> Result<(), String>,
{
    execute_command_with_availability(command, cancellation, emit, sandbox::sandbox_available())
        .await
}

/// `available` 由调用方注入：沙箱探测要 fork+exec，且测试进程自身可能跑在嵌套
/// 沙箱内（探测结果不可控），故保留注入口以便固定该前置条件。
async fn execute_command_with_availability<F>(
    command: ValidatedCommand,
    cancellation: watch::Receiver<bool>,
    emit: F,
    available: bool,
) -> Result<CommandOutcome, String>
where
    F: FnMut(WorkspaceCommandEvent) -> Result<(), String>,
{
    // 无沙箱档（会话完全访问，对齐 ChatGPT Full Access）直跑：不生成 profile、
    // 不探测沙箱可用性、不采集 deny。tier 由审批租约绑定，渲染进程无法自行
    // 升级到本档。其余档位仍在 OS 沙箱内执行，沙箱不可用即 fail-closed。
    let (process, sandbox_artifacts, denial_capture, sandboxed) =
        if command.tier == CommandTier::Unrestricted {
            (
                plain_command(&command),
                SandboxArtifacts {
                    profile_path: None,
                    tmpdir: None,
                },
                None,
                false,
            )
        } else {
            let network_policy = sandbox::command_network_policy(command.tier, available)?;
            let (process, artifacts, capture) = sandbox_command(&command, network_policy)?;
            (process, artifacts, capture, true)
        };
    execute_command_streaming(
        command,
        cancellation,
        emit,
        process,
        sandbox_artifacts,
        denial_capture,
        sandboxed,
    )
    .await
}

/// 无沙箱直跑命令：/bin/bash -c，以宿主用户权限执行。
///
/// 环境处理仍与沙箱路径一致（`env_clear` + 白名单透传）——环境净化防的是
/// 「宿主凭据经环境变量泄进命令」，与沙箱是否启用无关，保留它不削弱完全访问
/// 的期望（用户仍可读文件系统上的凭据）。
fn plain_command(command: &ValidatedCommand) -> Command {
    let mut process = Command::new(DEFAULT_SHELL);
    process.arg("-c").arg(&command.command);
    process
}

async fn execute_command_streaming<F>(
    command: ValidatedCommand,
    mut cancellation: watch::Receiver<bool>,
    mut emit: F,
    mut process: Command,
    sandbox_artifacts: SandboxArtifacts,
    mut denial_capture: Option<sandbox::SandboxDenialCapture>,
    sandboxed: bool,
) -> Result<CommandOutcome, String>
where
    F: FnMut(WorkspaceCommandEvent) -> Result<(), String>,
{
    process
        .current_dir(&command.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    configure_environment(
        &mut process,
        &command.workspace_root,
        sandbox_artifacts.tmpdir.as_deref(),
    );
    // 独立进程组（unix）：取消/超时按组终止；Windows 无进程组可设（树终止走
    // spawn 后挂载的 Job Object，见 platform_process::attach_process_job）。
    crate::platform_process::spawn_in_new_process_group(process.as_std_mut());

    let started_at = Instant::now();
    let mut child: Child = process
        .spawn()
        .map_err(|error| format!("failed to start workspace command: {error}"))?;
    let process_id = child
        .id()
        .ok_or_else(|| "workspace command process ID is unavailable".to_string())?;
    // Windows：挂入 KILL_ON_JOB_CLOSE 的 Job（取消/超时整树终止；收尾清残留
    // 后台子进程）。unix：进程组已在 spawn 前设置，无需处理。
    crate::platform_process::attach_process_job(process_id);
    // 沙箱命令的进程组 id == sandbox-exec 根进程 pid（process_group(0)），deny
    // 归属从这一刻起生效。
    if let Some(capture) = denial_capture.as_ref() {
        capture.bind_process_group(process_id);
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "workspace command stdout pipe is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "workspace command stderr pipe is unavailable".to_string())?;
    let budget = Arc::new(OutputBudget::new());
    let (pipe_sender, mut pipe_receiver) = mpsc::unbounded_channel();
    let stdout_task = tokio::spawn(read_pipe(
        stdout,
        CommandStream::Stdout,
        pipe_sender.clone(),
        budget.clone(),
    ));
    let stderr_task = tokio::spawn(read_pipe(
        stderr,
        CommandStream::Stderr,
        pipe_sender,
        budget.clone(),
    ));

    let mut wait = Box::pin(child.wait());
    let mut cancelled = false;
    let mut timed_out = false;
    let mut termination_requested = false;
    let mut pipe_error: Option<String> = None;
    let mut pipe_open = true;

    // 墙钟超时：deadline 在循环外一次性创建，避免每次输出 chunk 到达都重置计时
    // （旧实现把 sleep 放进 select! 迭代里，活跃输出的命令永不超时）。
    let timeout_deadline = command
        .timeout
        .map(|duration| tokio::time::Instant::now() + duration);
    let mut timeout_future = Box::pin(async move {
        if let Some(deadline) = timeout_deadline {
            sleep_until(deadline).await;
        } else {
            // No timeout — never fires.
            std::future::pending::<()>().await;
        }
    });

    let status = loop {
        tokio::select! {
            status = wait.as_mut() => {
                break status.map_err(|error| error.to_string())?;
            }
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    cancelled = true;
                    termination_requested = true;
                    break wait_after_termination(process_id, &mut wait).await?;
                }
            }
            _ = timeout_future.as_mut() => {
                timed_out = true;
                termination_requested = true;
                break wait_after_termination(process_id, &mut wait).await?;
            }
            event = pipe_receiver.recv(), if pipe_open => {
                match event {
                    Some(PipeEvent::Chunk(stream, bytes)) => {
                        emit(WorkspaceCommandEvent::chunk(
                            &command.request_id,
                            stream,
                            redact_credentials(&bytes),
                        ))?;
                    }
                    Some(PipeEvent::Error(stream, error)) => {
                        pipe_error.get_or_insert_with(|| format!("failed to read {stream:?}: {error}"));
                    }
                    None => pipe_open = false,
                }
            }
        }
    };

    if !termination_requested {
        terminate_remaining_process_group(process_id).await?;
    }
    stdout_task
        .await
        .map_err(|error| format!("workspace command stdout task failed: {error}"))?;
    stderr_task
        .await
        .map_err(|error| format!("workspace command stderr task failed: {error}"))?;
    // 命令收尾：摘除 Job（KILL_ON_JOB_CLOSE 清掉仍存活的残留后台子进程，
    // 对齐 unix 组杀语义）。此后所有路径都已终止命令进程树。
    crate::platform_process::detach_process_job(process_id);
    while let Ok(event) = pipe_receiver.try_recv() {
        match event {
            PipeEvent::Chunk(stream, bytes) => {
                emit(WorkspaceCommandEvent::chunk(
                    &command.request_id,
                    stream,
                    redact_credentials(&bytes),
                ))?;
            }
            PipeEvent::Error(stream, error) => {
                pipe_error.get_or_insert_with(|| format!("failed to read {stream:?}: {error}"));
            }
        }
    }
    if let Some(error) = pipe_error {
        return Err(error);
    }

    // 收集 deny 条目：失败命令给 1.2s 日志投递宽限（内核 duplicate-report 聚合
    // 实测有 ~1s 延迟，200ms 会漏），成功路径零等待——诊断价值只体现在失败场景，
    // 为失败命令多等 1.2s 换取准确的「沙箱拒了什么」摘要。
    let sandbox_denials = match denial_capture.take() {
        Some(capture) => {
            let failed = command_exit_code(&status) != Some(0) || cancelled || timed_out;
            let grace = if failed {
                Duration::from_millis(1_200)
            } else {
                Duration::ZERO
            };
            capture.stop(grace)
        }
        None => Vec::new(),
    };

    Ok(CommandOutcome {
        exit_code: command_exit_code(&status),
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        stdout_bytes: budget.stdout_bytes.load(Ordering::Relaxed),
        stderr_bytes: budget.stderr_bytes.load(Ordering::Relaxed),
        truncated: budget.truncated.load(Ordering::Relaxed),
        cancelled,
        timed_out,
        sandbox_denials,
        sandboxed,
    })
}

#[tauri::command]
pub(crate) async fn run_workspace_command(
    app: tauri::AppHandle,
    request: WorkspaceCommandRequest,
    workspace_state: State<'_, WorkspaceAccessState>,
    approval_state: State<'_, WorkspaceApprovalState>,
    approval_lease: String,
    approval_scope: crate::workspace_approval::ApprovalScope,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let root = authorized_root_for(&workspace_state, workspace_path.as_deref())?;
    // consume→register 与撤销全序化：撤销核心（revoke_workspace_core）在
    // per-workspace 写锁临界区内 cancel_for_workspace + generation bump，这里把
    // 「读当代际 + consume 租约 + 校验 + 登记」放进同一把锁。两种交错都被封死：
    // 撤销先完成 → 锁内读到的已是新代际，consume 的租约代际校验拒绝；本侧先
    // 完成 → 撤销的 cancel_for_workspace 必能看到已登记的命令。锁内只做快速
    // 检查与登记（毫秒级，generation/consume/validate/register 均不涉长 I/O），
    // 命令执行不持锁——在途执行由撤销经 cancel_for_workspace 取消。锁序与写
    // 路径一致（写锁 → 审批锁/命令表锁），与撤销链（registry → 写锁）不反向。
    let write_lock = workspace_state.workspace_write_lock(&root);
    let write_guard = write_lock
        .lock()
        .map_err(|_| "workspace write lock is poisoned".to_string())?;
    let lease_tier = approval_state.consume_scoped(
        &approval_lease,
        "run_workspace_command",
        serde_json::json!({
            "command": &request.command,
            "cwd": request.cwd.as_deref(),
            "timeoutMs": request.timeout_ms,
            "vcsCredentials": request.vcs_credentials,
            "containerControl": request.container_control,
        }),
        workspace_state.generation_for(&root),
        workspace_path.as_deref(),
        (
            &approval_scope,
            &app.state::<crate::session_authorization::SessionAuthorizationState>(),
        ),
    )?;
    let mut command = validate_request(&root, request)?;
    // Phase B：执行路径采用 lease 绑定的 tier（签发时权威分类，含模型声明的 network），
    // 覆盖 validate 的关键字分类——避免执行侧 declared_network 缺失导致口径漂移（§6.1）。
    if let Some(tier) = lease_tier {
        command.tier = tier;
    }
    let request_id = command.request_id.clone();
    let command_state = app.state::<WorkspaceCommandState>();
    let cancellation = command_state.register(&request_id, &root)?;
    drop(write_guard);
    let result = execute_command(command, cancellation, |event| {
        app.emit(WORKSPACE_COMMAND_EVENT, event)
            .map_err(|error| error.to_string())
    })
    .await;
    command_state.unregister(&request_id);
    let outcome = result?;
    app.emit(
        WORKSPACE_COMMAND_EVENT,
        WorkspaceCommandEvent::done(&request_id, &outcome),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn cancel_workspace_command(
    request_id: String,
    state: State<'_, WorkspaceCommandState>,
) -> Result<bool, String> {
    let request_id = crate::request_id::validate_request_id("workspace command", &request_id)?;
    let commands = state
        .commands
        .lock()
        .map_err(|_| "workspace command state lock is poisoned".to_string())?;
    if let Some(command) = commands.get(request_id) {
        let _ = command.cancel.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    /// 断言辅助：净化后的 PATH 应包含/不包含指定条目（按 canonical 比较）。
    fn path_entries(
        workspace_root: &Path,
        inherited: &std::ffi::OsStr,
        home: &Path,
    ) -> Vec<PathBuf> {
        let filtered =
            sanitized_path_with_toolchain_fallback(workspace_root, Some(inherited), Some(home))
                .expect("sanitized PATH must resolve");
        std::env::split_paths(&filtered)
            .map(|entry| std::fs::canonicalize(&entry).unwrap_or_else(|_| entry.to_path_buf()))
            .collect()
    }

    // /usr/bin、/bin 是 unix 系统路径约定（Linux usrmerge/macOS 形态断言）。
    #[test]
    #[cfg(unix)]
    fn appends_existing_toolchain_dirs_after_inherited_entries() {
        // GUI 启动形态：继承 launchd 最小 PATH，用户工具链目录全部缺失。
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        for dir in [
            home.path().join(".local/share/mise/shims"),
            home.path().join(".cargo/bin"),
            home.path().join(".local/bin"),
        ] {
            std::fs::create_dir_all(&dir).unwrap();
        }
        let inherited = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        let entries = path_entries(workspace.path(), inherited.as_os_str(), home.path());

        // 顺序：继承条目在前（不覆盖用户 shell 已注入的优先级），工具链在后。
        // 不断言总数——系统约定目录（/opt/homebrew 等）按机器是否安装追加，属预期。
        // 断言用 canonical 形态：Linux usrmerge 下 /bin 是 /usr/bin 的符号链接，
        // canonicalize 后与 /usr/bin 合并（macOS 上 /bin 是真实目录，两种形态各自成立）。
        assert_eq!(entries[0], std::fs::canonicalize("/usr/bin").unwrap());
        assert_eq!(entries[1], std::fs::canonicalize("/bin").unwrap());
        for dir in [".local/share/mise/shims", ".cargo/bin", ".local/bin"] {
            let canonical = std::fs::canonicalize(home.path().join(dir)).unwrap();
            assert!(entries.contains(&canonical), "工具链目录应被追加: {dir}");
        }
    }

    #[test]
    fn toolchain_dirs_skip_missing_and_dedupe_against_inherited() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        // 只创建 mise：其余候选（cargo/bun/…）不存在，不应出现。
        std::fs::create_dir_all(home.path().join(".local/share/mise/shims")).unwrap();
        // cargo 已在继承 PATH 中（用户 shell 已注入）：不得重复追加。
        let cargo_bin = home.path().join(".cargo/bin");
        std::fs::create_dir_all(&cargo_bin).unwrap();
        let inherited = std::env::join_paths([Path::new("/usr/bin"), cargo_bin.as_path()]).unwrap();
        let entries = path_entries(workspace.path(), inherited.as_os_str(), home.path());

        let cargo_canonical = std::fs::canonicalize(&cargo_bin).unwrap();
        assert_eq!(
            entries
                .iter()
                .filter(|entry| **entry == cargo_canonical)
                .count(),
            1,
            "继承条目中的 cargo/bin 不得被重复追加"
        );
        assert!(entries.contains(
            &std::fs::canonicalize(home.path().join(".local/share/mise/shims")).unwrap()
        ));
        assert!(
            !entries.iter().any(|entry| entry.ends_with(".bun/bin")),
            "不存在的候选不应追加"
        );
    }

    #[test]
    fn latest_nvm_version_wins_over_lexicographic_order() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        // 字典序陷阱：v10.1.0 < v9.11.2（字典序），语义化数字序 v10 > v9。
        for version in ["v9.11.2", "v10.1.0"] {
            std::fs::create_dir_all(
                home.path()
                    .join(".nvm/versions/node")
                    .join(version)
                    .join("bin"),
            )
            .unwrap();
        }
        // 非版本目录（残留/自定义命名）应被忽略。
        std::fs::create_dir_all(home.path().join(".nvm/versions/node/custom")).unwrap();
        let inherited = std::env::join_paths(["/usr/bin"]).unwrap();
        let entries = path_entries(workspace.path(), inherited.as_os_str(), home.path());

        let expected =
            std::fs::canonicalize(home.path().join(".nvm/versions/node/v10.1.0/bin")).unwrap();
        assert!(entries.contains(&expected), "只追加最高版本: {entries:?}");
        let old =
            std::fs::canonicalize(home.path().join(".nvm/versions/node/v9.11.2/bin")).unwrap();
        assert!(!entries.contains(&old), "旧版本不应追加: {entries:?}");
    }

    #[test]
    fn workspace_entries_still_filtered_before_toolchain_append() {
        // 工作区注入的 shim 目录必须先被剔除，工具链追加不得把它带回来。
        let workspace = TempDir::new().unwrap();
        let shim_dir = workspace.path().join("bin");
        std::fs::create_dir_all(&shim_dir).unwrap();
        let home = TempDir::new().unwrap();
        std::fs::create_dir_all(home.path().join(".cargo/bin")).unwrap();
        let inherited = std::env::join_paths([shim_dir.as_path(), Path::new("/usr/bin")]).unwrap();
        let entries = path_entries(workspace.path(), inherited.as_os_str(), home.path());

        let shim_canonical = std::fs::canonicalize(&shim_dir).unwrap();
        assert!(
            entries.iter().all(|entry| *entry != shim_canonical),
            "工作区内条目不得出现在最终 PATH: {entries:?}"
        );
    }

    fn request(command: &str) -> WorkspaceCommandRequest {
        WorkspaceCommandRequest {
            request_id: "command-1".into(),
            command: command.into(),
            cwd: None,
            timeout_ms: Some(5_000),
            vcs_credentials: false,
            container_control: false,
        }
    }

    #[test]
    fn allows_free_form_shell_commands() {
        let workspace = TempDir::new().unwrap();
        assert!(validate_request(workspace.path(), request("echo hello"),).is_ok());
        assert!(validate_request(workspace.path(), request("git status --short"),).is_ok());
        assert!(validate_request(workspace.path(), request("npm test"),).is_ok());
        assert!(validate_request(workspace.path(), request("cargo check --locked"),).is_ok());
        assert!(validate_request(workspace.path(), request("ls -la && echo done"),).is_ok());
    }

    #[test]
    fn rejects_empty_command() {
        let workspace = TempDir::new().unwrap();
        assert!(validate_request(workspace.path(), request("")).is_err());
        assert!(validate_request(workspace.path(), request("   ")).is_err());
    }

    #[test]
    fn rejects_sudo_and_outside_workspace_redirects() {
        let workspace = TempDir::new().unwrap();
        assert!(validate_request(workspace.path(), request("sudo rm -rf .")).is_err());
        assert!(validate_request(workspace.path(), request("  sudo -u root whoami")).is_err());
        assert!(validate_request(workspace.path(), request("/usr/bin/sudo id")).is_err());
        assert!(validate_request(workspace.path(), request("command sudo id")).is_err());
        assert!(validate_request(workspace.path(), request("env sudo id")).is_err());
        assert!(validate_request(
            workspace.path(),
            request("/usr/bin/env AXIOM_TEST=1 /usr/bin/sudo id")
        )
        .is_err());
        assert!(validate_request(workspace.path(), request("echo x > /tmp/out.log")).is_err());
        assert!(validate_request(workspace.path(), request("echo x >> /var/log/axiom")).is_err());
        assert!(validate_request(workspace.path(), request("make build 2> ~/notes")).is_err());
        assert!(validate_request(workspace.path(), request("cat a > ../outside.txt")).is_err());
        assert!(validate_request(workspace.path(), request("echo x > /dev/nulla")).is_err());
        // bash `>&` 文件复制形式（目标非数字即文件写）与 `exec {fd}>` 绝对路径
        assert!(validate_request(workspace.path(), request("echo x >& /tmp/out.log")).is_err());
        assert!(validate_request(workspace.path(), request("echo x >&/tmp/out.log")).is_err());
        assert!(validate_request(workspace.path(), request("echo x >& ~/notes")).is_err());
        assert!(validate_request(workspace.path(), request("echo x 2>& /tmp/out.log")).is_err());
        assert!(validate_request(workspace.path(), request("exec {fd}> /tmp/out.log")).is_err());
        assert!(validate_request(workspace.path(), request("exec {fd}>/tmp/out.log")).is_err());
    }

    #[test]
    fn allows_redirects_into_the_workspace_and_non_redirecting_pipes() {
        let workspace = TempDir::new().unwrap();
        // 工作区内相对路径重定向与管道/引号内的 > 应放行。
        assert!(validate_request(workspace.path(), request("npm test > coverage.log")).is_ok());
        assert!(validate_request(workspace.path(), request("echo x > src/out.txt")).is_ok());
        assert!(validate_request(workspace.path(), request("printf 'a > b'")).is_ok());
        assert!(validate_request(workspace.path(), request("git status --short")).is_ok());
        // `2>&1` / `>&1` 是 fd 复制而非文件写，`>& out.txt` 写工作区内相对路径，均应放行
        assert!(validate_request(workspace.path(), request("echo x 2>&1")).is_ok());
        assert!(validate_request(workspace.path(), request("echo x >&1")).is_ok());
        assert!(validate_request(workspace.path(), request("echo x >& out.txt")).is_ok());
        // `/dev/null` 例外：空设备无文件写入，seatbelt 沙箱显式允许；标准 bash 惯用法
        assert!(validate_request(workspace.path(), request("echo x 2>/dev/null")).is_ok());
        assert!(validate_request(workspace.path(), request("echo x > /dev/null")).is_ok());
        assert!(validate_request(workspace.path(), request("git push &> /dev/null")).is_ok());
    }

    #[test]
    fn rejects_sudo_after_a_newline_separator() {
        let workspace = TempDir::new().unwrap();
        // 换行分隔符绕过：命令经 /bin/bash -c 执行，`echo hi\nsudo whoami`
        // 中的换行是合法分隔符，不能只靠 `^` 行首匹配（无 multiline 标志）拦截。
        assert!(validate_request(workspace.path(), request("echo hi\nsudo whoami")).is_err());
        assert!(validate_request(workspace.path(), request("printf x\n  sudo id")).is_err());
    }

    #[test]
    fn allows_optional_timeout() {
        let workspace = TempDir::new().unwrap();
        let req = WorkspaceCommandRequest {
            request_id: "no-timeout".into(),
            command: "echo hello".into(),
            cwd: None,
            timeout_ms: None,
            vcs_credentials: false,
            container_control: false,
        };
        assert!(validate_request(workspace.path(), req).is_ok());
    }

    #[test]
    fn cancellation_registry_rejects_duplicates_and_cancels_commands_by_workspace() {
        let state = WorkspaceCommandState::default();
        let root = PathBuf::from("/tmp/axiom-test-workspace");
        let mut receiver = state.register("command-1", &root).unwrap();
        assert!(state.register("command-1", &root).is_err());
        assert_eq!(state.cancel_for_workspace(&root).unwrap(), 1);
        assert!(receiver.has_changed().unwrap());
        assert!(*receiver.borrow_and_update());
        state.unregister("command-1");
    }

    #[test]
    fn cancelling_a_workspace_does_not_touch_commands_of_other_workspaces() {
        let state = WorkspaceCommandState::default();
        let first = PathBuf::from("/tmp/axiom-test-workspace-a");
        let second = PathBuf::from("/tmp/axiom-test-workspace-b");
        let mut first_receiver = state.register("command-a", &first).unwrap();
        let second_receiver = state.register("command-b", &second).unwrap();

        // 撤销 first 只取消挂载在 first 下的命令，second 的命令保持运行。
        assert_eq!(state.cancel_for_workspace(&first).unwrap(), 1);
        assert!(first_receiver.has_changed().unwrap());
        assert!(*first_receiver.borrow_and_update());
        assert!(!second_receiver.has_changed().unwrap());

        state.unregister("command-a");
        state.unregister("command-b");
    }

    #[test]
    fn output_budget_counts_full_output_but_captures_only_the_bounded_prefix() {
        let budget = OutputBudget::new();
        let bytes = vec![b'x'; MAX_OUTPUT_BYTES + 1];
        assert_eq!(
            budget.capture(CommandStream::Stdout, &bytes).unwrap().len(),
            MAX_OUTPUT_BYTES
        );
        assert_eq!(
            budget.stdout_bytes.load(Ordering::Relaxed),
            (MAX_OUTPUT_BYTES + 1) as u64
        );
        assert!(budget.truncated.load(Ordering::Relaxed));
        assert!(budget
            .capture(CommandStream::Stderr, b"discarded")
            .is_none());
        assert_eq!(budget.stderr_bytes.load(Ordering::Relaxed), 9);
    }

    #[test]
    fn sensitive_environment_names_are_not_passthrough_values() {
        for name in PASSTHROUGH_ENVIRONMENT {
            let upper = name.to_ascii_uppercase();
            assert!(!upper.contains("KEY"));
            assert!(!upper.contains("TOKEN"));
            assert!(!upper.contains("SECRET"));
            assert!(!upper.contains("PASSWORD"));
        }
    }

    #[test]
    fn resolves_only_real_directories_inside_the_authorized_workspace() {
        let workspace = TempDir::new().unwrap();
        #[cfg_attr(target_os = "windows", allow(unused_variables))]
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(workspace.path().join("nested")).unwrap();
        #[cfg(unix)]
        {
            symlink(outside.path(), workspace.path().join("outside-link")).unwrap();
            assert!(resolve_command_cwd(workspace.path(), Some("outside-link")).is_err());
        }
        assert_eq!(
            resolve_command_cwd(workspace.path(), Some("nested")).unwrap(),
            std::fs::canonicalize(workspace.path().join("nested")).unwrap()
        );
        assert!(resolve_command_cwd(workspace.path(), Some("../outside")).is_err());
    }

    #[tokio::test]
    async fn unavailable_sandbox_never_spawns_commands_or_emits_events() {
        for tier in [CommandTier::SandboxSafe, CommandTier::NetworkRequired] {
            let workspace = TempDir::new().unwrap();
            let command = ValidatedCommand {
                request_id: "sandbox-unavailable".into(),
                command: "printf escaped > escaped.txt".into(),
                cwd: workspace.path().to_path_buf(),
                workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
                timeout: None,
                tier,
                privileges: sandbox::SandboxPrivileges {
                    vcs_credentials: true,
                    container_control: true,
                },
            };
            let (_sender, receiver) = watch::channel(false);
            let mut events = Vec::new();
            let result = execute_command_with_availability(
                command,
                receiver,
                |event| {
                    events.push(event);
                    Ok(())
                },
                false,
            )
            .await;
            assert!(result.is_err());
            assert!(!workspace.path().join("escaped.txt").exists());
            assert!(events.is_empty());
        }
    }

    #[tokio::test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn unrestricted_command_runs_without_sandbox_and_executes_side_effect_once() {
        let workspace = TempDir::new().unwrap();
        let marker = workspace.path().join("runs.txt");
        let command = ValidatedCommand {
            request_id: "unrestricted-command".into(),
            // 追加一行：真执行两次会留下两行——这是「副作用只执行一次」的可观测断言。
            command: format!("printf 'run\\n' >> {}", marker.display()),
            cwd: workspace.path().to_path_buf(),
            workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
            timeout: None,
            tier: CommandTier::Unrestricted,
            privileges: sandbox::SandboxPrivileges::default(),
        };
        let (_sender, receiver) = watch::channel(false);
        // 沙箱可用性显式注入 false：无沙箱档不依赖探测结果，也不得因此拒绝执行。
        let events = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        let outcome = execute_command_with_availability(
            command,
            receiver,
            move |event| {
                collected.lock().unwrap().push(event);
                Ok(())
            },
            false,
        )
        .await
        .unwrap();

        assert!(!outcome.sandboxed);
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "run\n");
        let events = events.lock().unwrap();
        // 执行层只产生输出 chunk，不留终止事件（done 由命令处理器统一派生）；chunk
        // 事件不携带 sandboxed 字段，避免把「未知」误读成「无沙箱」。
        assert!(events.iter().all(|event| !event.done));
        assert!(events.iter().all(|event| event.sandboxed.is_none()));
    }

    #[tokio::test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn executes_a_shell_command_and_streams_output() {
        let workspace = TempDir::new().unwrap();
        let command = ValidatedCommand {
            request_id: "echo-command".into(),
            command: "echo hello world".into(),
            cwd: workspace.path().to_path_buf(),
            workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
            timeout: None,
            tier: CommandTier::NetworkRequired,
            privileges: sandbox::SandboxPrivileges::default(),
        };
        let (_sender, receiver) = watch::channel(false);
        let mut output = Vec::new();
        let outcome = execute_command(command, receiver, |event| {
            if let Some(chunk) = event.chunk {
                output.extend(chunk);
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            outcome.exit_code,
            Some(0),
            "sandbox stderr: {}",
            String::from_utf8_lossy(&output)
        );
        assert!(!outcome.cancelled);
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("hello world"));
    }

    #[tokio::test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn cancellation_terminates_the_process_group() {
        let workspace = TempDir::new().unwrap();
        let command = ValidatedCommand {
            request_id: "cancel-command".into(),
            command: "sleep 30 & wait".into(),
            cwd: workspace.path().to_path_buf(),
            workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
            timeout: None,
            tier: CommandTier::NetworkRequired,
            privileges: sandbox::SandboxPrivileges::default(),
        };
        let (sender, receiver) = watch::channel(false);
        let cancel = tokio::spawn(async move {
            sleep(Duration::from_millis(50)).await;
            sender.send(true).unwrap();
        });
        let started = Instant::now();
        let outcome = execute_command(command, receiver, |_| Ok(()))
            .await
            .unwrap();
        cancel.await.unwrap();
        assert!(outcome.cancelled);
        // Windows 树终止经 taskkill 两跳（宽档对控制台程序无效后强档兜底），
        // 单次调用本身可到秒级，预算放宽到 10s；unix 组信号保持 3s。
        #[cfg(unix)]
        let budget = Duration::from_secs(3);
        #[cfg(windows)]
        let budget = Duration::from_secs(10);
        assert!(started.elapsed() < budget);
    }

    #[tokio::test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn times_out_active_commands_with_continuous_output() {
        let workspace = TempDir::new().unwrap();
        // 持续输出（每 100ms 一次）会不断触发输出事件；墙钟超时必须仍然生效，
        // 而不能被输出事件不断重置成「事件间活跃超时」（旧实现永不超时）。
        let command = ValidatedCommand {
            request_id: "timeout-active-command".into(),
            command: "for i in $(seq 1 50); do echo ping; sleep 0.1; done".into(),
            cwd: workspace.path().to_path_buf(),
            workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
            timeout: Some(Duration::from_millis(600)),
            tier: CommandTier::NetworkRequired,
            privileges: sandbox::SandboxPrivileges::default(),
        };
        let (_sender, receiver) = watch::channel(false);
        let started = Instant::now();
        let outcome = execute_command(command, receiver, |_| Ok(()))
            .await
            .unwrap();
        assert!(outcome.timed_out, "持续输出命令必须在墙钟超时内被终止");
        // 旧实现下命令会跑满 ~5s 且不超时；新实现应在 ~1s 内终止进程组。
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[tokio::test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn normal_exit_cleans_up_background_processes() {
        let workspace = TempDir::new().unwrap();
        let command = ValidatedCommand {
            request_id: "background-command".into(),
            command: "sleep 30 & echo $!".into(),
            cwd: workspace.path().to_path_buf(),
            workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
            timeout: None,
            tier: CommandTier::NetworkRequired,
            privileges: sandbox::SandboxPrivileges::default(),
        };
        let (_sender, receiver) = watch::channel(false);
        let mut output = Vec::new();
        // started 仅用于 Windows 分支的回收时序断言（unix 分支按 pid 精确探测），
        // 绑定本身随分支门控，避免非 Windows 构建的未使用告警。
        #[cfg(target_os = "windows")]
        let started = Instant::now();
        let outcome = execute_command(command, receiver, |event| {
            if let Some(chunk) = event.chunk {
                output.extend(chunk);
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        #[cfg(unix)]
        {
            // 后台 sleep 必须随进程组回收（unix 组信号）。清理是异步落地的
            // （信号后内核回收），给一段重试窗口再断言 pid 已死（ESRCH 精确）。
            let process_id = String::from_utf8(output)
                .unwrap()
                .trim()
                .parse::<i32>()
                .unwrap();
            let mut reaped = false;
            for _ in 0..100 {
                if !crate::platform_process::process_alive(process_id as u32) {
                    reaped = true;
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
            assert!(
                reaped,
                "background process must be reaped after command exit"
            );
        }
        #[cfg(windows)]
        {
            // msys2 的 `$!` 是合成 pid（与 Windows pid 无关），无法按 pid 探测；
            // 以时序断言回收语义：bash 正常退出后，若 Job 未回收持有管道写端的
            // 后台 sleep，stdout_task 会阻塞到 sleep 自然超时（实测 30s）。
            // 回收正常时管道 EOF 即刻到达（实测 <1s），预算放宽容忍并行满载。
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "后台进程必须随 Job 回收，而不是阻塞到其自然退出: {:?}",
                started.elapsed()
            );
        }
    }

    #[test]
    fn validate_request_assigns_command_tier() {
        let workspace = TempDir::new().unwrap();
        let safe = validate_request(workspace.path(), request("npm test")).unwrap();
        assert_eq!(safe.tier, CommandTier::SandboxSafe);
        let network = validate_request(workspace.path(), request("npm install")).unwrap();
        assert_eq!(network.tier, CommandTier::NetworkRequired);
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn sandbox_tier_runs_under_seatbelt_and_blocks_network() {
        assert!(
            sandbox::sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let workspace = TempDir::new().unwrap();
        // 本地命令：TMPDIR 被覆盖为会话级目录，证明 sandbox-exec 包装生效
        let command = validate_request(workspace.path(), request("echo $TMPDIR")).unwrap();
        assert_eq!(command.tier, CommandTier::SandboxSafe);
        let (_sender, receiver) = watch::channel(false);
        let mut output = Vec::new();
        let outcome = execute_command(command, receiver, |event| {
            if let Some(chunk) = event.chunk {
                output.extend(chunk);
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        let text = String::from_utf8_lossy(&output);
        assert!(
            text.contains("axiom-"),
            "沙箱会话 TMPDIR 应含 axiom- 前缀: {text}"
        );

        // 网络尝试：无关键字的 socket 连接在沙箱内被 DENY（fail-closed）。
        // 注意用**外网 IP**：回环（127.0.0.1）已按 LoopbackOnly 档放行（dev server
        // 依赖），只有非回环地址才能证明外网阻断；EPERM 在 socket 操作层即发生，
        // 不依赖实际网络连通性。
        let command = validate_request(
            workspace.path(),
            request(
                "python3 -c \"import socket; s=socket.socket(); s.settimeout(3); \
                 s.connect(('93.184.216.34',80))\" 2>&1; echo EXIT=$?",
            ),
        )
        .unwrap();
        assert_eq!(command.tier, CommandTier::SandboxSafe);
        let (_sender, receiver) = watch::channel(false);
        let mut output = Vec::new();
        let _outcome = execute_command(command, receiver, |event| {
            if let Some(chunk) = event.chunk {
                output.extend(chunk);
            }
            Ok(())
        })
        .await
        .unwrap();
        let text = String::from_utf8_lossy(&output);
        assert!(
            text.contains("Operation not permitted"),
            "沙箱内外网应被 DENY: {text}"
        );
    }

    /// 网络档回归：NetworkRequired 命令也必须在 seatbelt 沙箱内执行（TMPDIR 被覆盖
    /// 为会话级 axiom- 目录即证明走了 sandbox-exec 包装），而非旧的裸执行路径。
    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn network_tier_runs_under_seatbelt_with_network_profile() {
        assert!(
            sandbox::sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let workspace = TempDir::new().unwrap();
        // 命令含 https:// 关键字 → NetworkRequired 分类；curl -V 只打印版本不走网络。
        let command =
            validate_request(workspace.path(), request("curl -V; echo NET$TMPDIR")).unwrap();
        assert_eq!(command.tier, CommandTier::NetworkRequired);
        let (_sender, receiver) = watch::channel(false);
        let mut output = Vec::new();
        let outcome = execute_command(command, receiver, |event| {
            if let Some(chunk) = event.chunk {
                output.extend(chunk);
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        let text = String::from_utf8_lossy(&output);
        assert!(
            text.contains("axiom-"),
            "网络档命令也应在沙箱内执行（会话 TMPDIR）: {text}"
        );
    }

    /// 遮盖后转字符串（绑定临时 Vec，避免 from_utf8_lossy 借用悬垂）。
    fn redacted_text(bytes: &[u8]) -> String {
        let redacted = redact_credentials(bytes);
        String::from_utf8_lossy(&redacted).into_owned()
    }

    #[test]
    fn redacts_url_and_key_value_credentials() {
        let text = redacted_text(b"git clone https://user:ghp_token@github.com/x.git\n");
        assert!(!text.contains("ghp_token"), "URL 凭据应被遮盖: {text}");
        assert!(text.contains("github.com"), "URL 其余部分保留: {text}");

        let text = redacted_text(b"token = \"sk-proj-abc123\"\nAPI_KEY=xyz789\n");
        assert!(
            !text.contains("sk-proj-abc123"),
            "token 键值应被遮盖: {text}"
        );
        assert!(!text.contains("xyz789"), "API_KEY 键值应被遮盖: {text}");
        assert!(text.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_netrc_and_keeps_plain_output() {
        let text = redacted_text(b"machine github.com\nlogin user\npassword ghp_xxx\n");
        assert!(!text.contains("ghp_xxx"), "netrc password 应被遮盖: {text}");

        let plain = redacted_text(b"npm test\nok\n");
        assert!(plain.contains("npm test") && plain.contains("ok"));
    }

    #[test]
    fn redacts_json_quoted_keys() {
        // JSON 引号键：键与冒号之间的闭引号、值侧开引号都要穿过
        let text = redacted_text(b"{\"apiKey\": \"sk-proj-9f3k2\", \"scope\": \"read\"}\n");
        assert!(
            !text.contains("sk-proj-9f3k2"),
            "JSON 引号键的凭据值应被遮盖: {text}"
        );
        assert!(text.contains("read"), "非凭据 JSON 值不应误伤: {text}");

        let text = redacted_text(b"'token': 'ghp_abc123def456'");
        assert!(
            !text.contains("ghp_abc123def456"),
            "单引号键值形态应被遮盖: {text}"
        );
    }

    #[test]
    fn redacts_compound_environment_variable_credentials() {
        // 复合名的前导 `_` 会破坏 `\b` 边界——按显式枚举名覆盖
        let text = redacted_text(b"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY\n");
        assert!(
            !text.contains("wJalrXUtnFEMI"),
            "AWS_SECRET_ACCESS_KEY 复合环境变量名应被遮盖: {text}"
        );

        // AWS 官方文档示例键运行时拼接：源码不出现「AKIA+16 位」完整键形字面量
        // （读源码的会话会被出口护栏 model_egress.rs 拦截）。
        let aws_key = format!("AKIA{}", "IOSFODNN7EXAMPLE");
        let text = redacted_text(format!("aws_access_key_id: {aws_key}").as_bytes());
        assert!(
            !text.contains(aws_key.as_str()),
            "复合名键值形态应被遮盖: {text}"
        );
    }

    #[test]
    fn redacts_authorization_header_and_bearer_tokens() {
        let text = redacted_text(b"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload\n");
        assert!(
            !text.contains("eyJhbGciOiJIUzI1NiJ9"),
            "Authorization: Bearer 应遮盖 scheme 后的令牌本体: {text}"
        );
        assert!(
            !text.contains("Bearer eyJ"),
            "不应只遮掉 scheme 留下令牌: {text}"
        );

        let text = redacted_text(b"\"Authorization\": \"Bearer abcDEF1234567890xyz\"");
        assert!(
            !text.contains("abcDEF1234567890xyz"),
            "JSON 形态的 Authorization 头应被遮盖: {text}"
        );

        // 裸 bearer 长令牌（日志/CLI 常见形态）；短词不误伤
        let text = redacted_text(b"bearer YSk3NUFQK9LmGxV4Qz2wEr5\nok bearer of the crown\n");
        assert!(
            !text.contains("YSk3NUFQK9LmGxV4Qz2wEr5"),
            "裸 bearer 长令牌应被遮盖: {text}"
        );
        assert!(
            text.contains("bearer of the crown"),
            "普通英语短语不应误伤: {text}"
        );
    }

    #[test]
    fn redacts_aws_access_key_literals() {
        let aws_key = format!("AKIA{}", "IOSFODNN7EXAMPLE");
        let text = redacted_text(format!("configured key {aws_key} for deploy\n").as_bytes());
        assert!(
            !text.contains(aws_key.as_str()),
            "AWS 访问键原文应被遮盖: {text}"
        );
        // 大小写敏感：普通小写词不受影响
        let plain = redacted_text(b"akiawhatever1234567890 is not a key id\n");
        assert!(
            plain.contains("akiawhatever1234567890"),
            "小写形态不应按 AWS 键误伤: {plain}"
        );
    }

    #[test]
    fn leaves_non_utf8_bytes_untouched() {
        let binary = [0xffu8, 0xfe, 0x00, 0x01];
        assert_eq!(redact_credentials(&binary), binary.to_vec());
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn command_output_redacts_credentials() {
        assert!(
            sandbox::sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let workspace = TempDir::new().unwrap();
        let command = validate_request(
            workspace.path(),
            request(r#"printf 'url=https://user:supersecret@example.com\n'"#),
        )
        .unwrap();
        let (_sender, receiver) = watch::channel(false);
        let mut output = Vec::new();
        let outcome = execute_command(command, receiver, |event| {
            if let Some(chunk) = event.chunk {
                output.extend(chunk);
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        let text = String::from_utf8_lossy(&output);
        assert!(!text.contains("supersecret"), "凭据应被遮盖: {text}");
        assert!(text.contains("[REDACTED]"), "应含遮盖标记: {text}");
    }
}
