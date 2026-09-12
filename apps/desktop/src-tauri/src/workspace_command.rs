use crate::{
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
use tauri::{Emitter, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::{mpsc, watch},
    time::{sleep, sleep_until, timeout},
};

const WORKSPACE_COMMAND_EVENT: &str = "axiom:workspace-command";
const MAX_TIMEOUT_MS: u64 = 2_147_483_647;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const PIPE_BUFFER_BYTES: usize = 8 * 1024;
const TERMINATION_GRACE_MS: u64 = 500;
/// 子进程环境透传白名单（浏览器会话等其它子进程通道同样复用：env_clear 后仅
/// 保留这些与用户身份/语言相关的无敏感变量，API Key 一律不进入子进程）。
pub(crate) const PASSTHROUGH_ENVIRONMENT: &[&str] = &[
    "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "SHELL", "TERM", "TMPDIR", "USER",
];
/// Shell used to execute workspace commands.
const DEFAULT_SHELL: &str = "/bin/bash";
/// 自由命令模型的最小安全基线：拒绝 sudo 提升权限。定位为"减速带"而非安全边界，
/// 逐次审批才是主要安全阀。匹配命令上下文边界（行首/换行/分号/&&/|/子shell/$()），
/// 不匹配 `grep sudo` 这类把 sudo 当普通参数的合法命令。
/// 换行显式纳入分隔符字符类：命令经 /bin/bash -c 执行，`echo hi\nsudo whoami`
/// 中的换行是合法分隔符，若漏掉可绕过行首匹配（`^` 无 multiline 标志）。
/// 必须与 TS bashTool.ts 的 SUDO_COMMAND_PREFIX_PATTERN 逐字一致（bash-policy-audit 强制）。
const SUDO_COMMAND_PREFIX_PATTERN: &str = r"(?:^\s*|(?:\s*[;&|(\n]\s*))\\?sudo(?:\s|$)";
/// 拒绝把命令输出重定向到工作区外：`> /abs`、`> ~`、`> ..`、引号包裹的绝对路径
/// （`> "$HOME/x"`）、noclobber `>|`、变量/命令替换目标（`$VAR`、`$()`、反引号）、
/// bash 的 `>&` 文件复制形式（`echo hi >& /tmp/out`，目标非数字即文件写）与
/// `exec {fd}> /abs`（左上下文 `}`）。
/// 例外：目标恰为 `/dev/null`（含引号与 `2>/dev/null` 形式，后跟分隔符边界）一律放行——
/// 空设备不产生文件写入，且 seatbelt 沙箱已显式允许。因 regex crate 不支持 lookaround，
/// 用 RE2 兼容的子串排除交替式实现；`/dev/nullfoo`、`/dev/nulldir`、`/dev` 等仍拒绝。
/// 必须与 TS bashTool.ts 的 OUTSIDE_WORKSPACE_REDIRECT_PATTERN 逐字一致（bash-policy-audit 强制）。
const OUTSIDE_WORKSPACE_REDIRECT_PATTERN: &str =
    r"(?:^|[;&|}]|\s|\d)>\s*(?:\|?\s*(?:>|&)?)?\s*[\x22']?(?:\/(?:[^d]|$|d(?:[^e]|e(?:[^v]|v(?:[^\/]|$|\/(?:[^n]|$|n(?:[^u]|u(?:[^l]|l(?:[^l]|l[^\s;&|>\x22']))))))))|~|\$|\x60|\.\.(?:[/\s]|$))";

fn compiled_pattern(pattern: &'static str) -> &'static Regex {
    static SUDO_RE: OnceLock<Regex> = OnceLock::new();
    static REDIRECT_RE: OnceLock<Regex> = OnceLock::new();
    match pattern {
        SUDO_COMMAND_PREFIX_PATTERN => SUDO_RE
            .get_or_init(|| Regex::new(pattern).expect("compile-time sudo pattern")),
        _ => REDIRECT_RE
            .get_or_init(|| Regex::new(pattern).expect("compile-time redirect pattern")),
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
    fn register(
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
    /// false 表示沙箱不可用、NetworkRequired 回退常规用户权限执行——写限工作区与
    /// 凭据读取保护未生效，供模型/用户显式感知降级（而非静默裸跑）。
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
    /// 命令安全分级（Phase A：仅关键字分类，declared_network 固定 false）。
    /// SandboxSafe → 沙箱内执行（仅回环网络）；NetworkRequired → 沙箱内执行且网络
    /// 启用（沙箱不可用时才回退常规用户权限执行）。
    tier: CommandTier,
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
    /// 本命令是否在 seatbelt 沙箱内执行。false 仅发生在 NetworkRequired 且沙箱
    /// 不可用的回退路径（SandboxSafe 沙箱不可用会提前 fail-closed 拒绝）。
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

fn validate_request_id(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("workspace command request ID contains unsupported characters".into());
    }
    Ok(value)
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
    let request_id = validate_request_id(&request.request_id)?.to_string();
    let workspace_root = std::fs::canonicalize(root)
        .map_err(|error| format!("failed to resolve authorized workspace: {error}"))?;
    let command = request.command.trim().to_string();
    if command.is_empty() {
        return Err("workspace command must be a non-empty string".into());
    }
    if command.len() > 64 * 1024 {
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
    let canonical_root = std::fs::canonicalize(workspace_root)
        .unwrap_or_else(|_| workspace_root.to_path_buf());
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
        Regex::new(
            r#"(?i)(?:(?:https?|ftp)://[^@\s/]+:[^@\s/]+@)|(?:(?:https?|ftp)://[^@\s/]+@)|\b(?:token|password|secret|access_key|secret_key|auth_token|api[_-]?key)\s*[:=]\s*["']?[^\s"']+|\bmachine\s+\S+\s+login\s+\S+\s+password\s+\S+"#,
        )
        .expect("compile-time credential redaction pattern")
    });
    pattern.replace_all(text, "[REDACTED]").into_owned().into_bytes()
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
        crate::git_config::git_config_neutralization().len().to_string(),
    );
    for (index, (key, value)) in crate::git_config::git_config_neutralization().iter().enumerate() {
        command.env(format!("GIT_CONFIG_KEY_{index}"), *key);
        command.env(format!("GIT_CONFIG_VALUE_{index}"), *value);
    }
}

/// 沙箱宿主 HOME（seatbelt profile 参数与工具链配置洞的基准）。
fn host_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME environment variable is unavailable for sandboxing".into())
}

/// 创建会话级沙箱 tmpdir（`$TMPDIR/axiom-<request_id>/`），返回 canonical 化路径。
/// canonicalize 必要：seatbelt 按解析后的 vnode 判定，`/tmp` 是 `/private/tmp` 的符号链接，
/// 非 canonical 路径会导致文件操作被拒（冒烟实证）。
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
fn sandbox_profile_dir(home: &Path) -> Result<PathBuf, String> {
    let dir = crate::storage_paths::ensure_data_root_at(home)?.join("sandbox");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create sandbox profile dir {}: {error}", dir.display()))?;
    Ok(dir)
}

/// 沙箱会话序号：保证同进程内并发命令的 profile 文件 / 会话 tmpdir 命名唯一。
static SANDBOX_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 命令结束后清理 profile 文件与会话 tmpdir。spawn 后 crash/SIGKILL 的残留由
/// 下次初始化时的 mtime 清理兜底（docs/os-sandbox-plan.md §7.1）。
struct SandboxArtifacts {
    profile_path: PathBuf,
    tmpdir: Option<PathBuf>,
}

impl Drop for SandboxArtifacts {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.profile_path);
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

fn signal_process_group(process_id: u32, signal: i32) -> Result<bool, String> {
    let result = unsafe { libc::kill(-(process_id as i32), signal) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(format!(
            "failed to signal workspace command process group: {error}"
        ))
    }
}

async fn wait_after_termination(
    process_id: u32,
    wait: &mut std::pin::Pin<Box<impl std::future::Future<Output = std::io::Result<ExitStatus>>>>,
) -> Result<ExitStatus, String> {
    let _ = signal_process_group(process_id, libc::SIGTERM)?;
    match timeout(Duration::from_millis(TERMINATION_GRACE_MS), wait.as_mut()).await {
        Ok(status) => status.map_err(|error| error.to_string()),
        Err(_) => {
            let _ = signal_process_group(process_id, libc::SIGKILL)?;
            wait.as_mut().await.map_err(|error| error.to_string())
        }
    }
}

async fn terminate_remaining_process_group(process_id: u32) -> Result<(), String> {
    if !signal_process_group(process_id, libc::SIGTERM)? {
        return Ok(());
    }
    sleep(Duration::from_millis(50)).await;
    let _ = signal_process_group(process_id, libc::SIGKILL)?;
    Ok(())
}

fn command_exit_code(status: &ExitStatus) -> Option<i32> {
    status.code()
}

async fn execute_command<F>(
    command: ValidatedCommand,
    mut cancellation: watch::Receiver<bool>,
    mut emit: F,
) -> Result<CommandOutcome, String>
where
    F: FnMut(WorkspaceCommandEvent) -> Result<(), String>,
{
    let mut sandbox_artifacts: Option<SandboxArtifacts> = None;
    // 两级分类都优先在沙箱内执行（对齐 codex：网络命令 = 沙箱 + 网络启用，而非
    // 脱离沙箱裸跑）——写边界与凭据 deny 对网络命令同样生效，修复审批后的
    // `npm install` 可写全盘/读凭据的缺口。SandboxSafe 沙箱不可用时 fail-closed；
    // NetworkRequired 回退常规用户权限执行（该分级从不以沙箱为先决条件，审批闸
    // 已比 SandboxSafe 重一层——原生对话框/automatic 模式）。
    let network_policy = match command.tier {        CommandTier::SandboxSafe => {
            if !sandbox::sandbox_available() {
                return Err(
                    "OS sandbox (sandbox-exec) is unavailable; refusing to run a sandbox-tier \
                     command without sandboxing"
                        .into(),
                );
            }
            Some(sandbox::NetworkPolicy::LoopbackOnly)
        }
        CommandTier::NetworkRequired if sandbox::sandbox_available() => {
            Some(sandbox::NetworkPolicy::OutboundEnabled)
        }
        CommandTier::NetworkRequired => None,
    };
    // 记录「是否沙箱化」供 done 事件透传：NetworkRequired 且沙箱不可用时回退常规
    // 用户权限执行（network_policy 为 None），模型/用户需显式感知这一降级。
    let sandboxed = network_policy.is_some();
    // seatbelt deny 捕获器（沙箱路径才有；可观测性降级为 None 不阻断命令）。
    let mut denial_capture: Option<sandbox::SandboxDenialCapture> = None;
    let mut process = if let Some(network_policy) = network_policy {
        // seatbelt 沙箱包装路径：sandbox-exec -D WORKSPACE=... -f profile.sb /bin/bash -c cmd。
        // deny 捕获器先于命令派生启动（订阅建立需要时间；失败静默降级为无捕获）。
        denial_capture = sandbox::SandboxDenialCapture::start();
        let home = host_home()?;
        // 沙箱会话 id：request_id + 进程内原子序号，保证并发命令（即使 request_id
        // 相同，如测试并行 / retry）不共用 profile 文件与会话 tmpdir。
        let sequence = SANDBOX_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let sandbox_id = format!("{}-{sequence}", command.request_id);
        let sandbox_tmpdir = prepare_sandbox_tmpdir(&sandbox_id)?;
        let sandbox_dir = sandbox_profile_dir(&home)?;
        let profile = sandbox::generate_sandbox_profile(
            &command.workspace_root,
            &home,
            &sandbox_tmpdir,
            &sandbox_dir,
            &sandbox_id,
            network_policy,
            sandbox::command_requires_vcs_credentials(&command.command),
        )?;
        let mut sandboxed = Command::new("/usr/bin/sandbox-exec");
        sandboxed
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
        sandbox_artifacts = Some(SandboxArtifacts {
            profile_path: profile.path,
            tmpdir: Some(sandbox_tmpdir),
        });
        sandboxed
    } else {
        let mut plain = Command::new(DEFAULT_SHELL);
        plain.arg("-c").arg(&command.command);
        plain
    };
    process
        .current_dir(&command.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    configure_environment(
        &mut process,
        &command.workspace_root,
        sandbox_artifacts
            .as_ref()
            .and_then(|artifacts| artifacts.tmpdir.as_deref()),
    );
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.as_std_mut().process_group(0);
    }

    let started_at = Instant::now();
    let mut child: Child = process
        .spawn()
        .map_err(|error| format!("failed to start workspace command: {error}"))?;
    let process_id = child
        .id()
        .ok_or_else(|| "workspace command process ID is unavailable".to_string())?;
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
    command_state: State<'_, WorkspaceCommandState>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let root = authorized_root_for(&workspace_state, workspace_path.as_deref())?;
    let lease_tier = approval_state.consume(
        &approval_lease,
        "run_workspace_command",
        serde_json::json!({
            "command": &request.command,
            "cwd": request.cwd.as_deref(),
            "timeoutMs": request.timeout_ms,
        }),
        workspace_state.generation_for(&root),
        workspace_path.as_deref(),
    )?;
    let mut command = validate_request(&root, request)?;
    // Phase B：执行路径采用 lease 绑定的 tier（签发时权威分类，含模型声明的 network），
    // 覆盖 validate 的关键字分类——避免执行侧 declared_network 缺失导致口径漂移（§6.1）。
    if let Some(tier) = lease_tier {
        command.tier = tier;
    }
    let request_id = command.request_id.clone();
    let cancellation = command_state.register(&request_id, &root)?;
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
    let request_id = validate_request_id(&request_id)?;
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
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    /// 断言辅助：净化后的 PATH 应包含/不包含指定条目（按 canonical 比较）。
    fn path_entries(
        workspace_root: &Path,
        inherited: &std::ffi::OsStr,
        home: &Path,
    ) -> Vec<PathBuf> {
        let filtered = sanitized_path_with_toolchain_fallback(
            workspace_root,
            Some(inherited),
            Some(home),
        )
        .expect("sanitized PATH must resolve");
        std::env::split_paths(&filtered)
            .map(|entry| {
                std::fs::canonicalize(&entry).unwrap_or_else(|_| entry.to_path_buf())
            })
            .collect()
    }

    #[test]
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
        assert_eq!(entries[0], PathBuf::from("/usr/bin"));
        assert_eq!(entries[1], PathBuf::from("/bin"));
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
        let inherited =
            std::env::join_paths([Path::new("/usr/bin"), cargo_bin.as_path()]).unwrap();
        let entries = path_entries(workspace.path(), inherited.as_os_str(), home.path());

        let cargo_canonical = std::fs::canonicalize(&cargo_bin).unwrap();
        assert_eq!(
            entries.iter().filter(|entry| **entry == cargo_canonical).count(),
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
            std::fs::create_dir_all(home.path().join(".nvm/versions/node").join(version).join("bin"))
                .unwrap();
        }
        // 非版本目录（残留/自定义命名）应被忽略。
        std::fs::create_dir_all(home.path().join(".nvm/versions/node/custom")).unwrap();
        let inherited = std::env::join_paths(["/usr/bin"]).unwrap();
        let entries = path_entries(workspace.path(), inherited.as_os_str(), home.path());

        let expected = std::fs::canonicalize(
            home.path().join(".nvm/versions/node/v10.1.0/bin"),
        )
        .unwrap();
        assert!(entries.contains(&expected), "只追加最高版本: {entries:?}");
        let old = std::fs::canonicalize(home.path().join(".nvm/versions/node/v9.11.2/bin"))
            .unwrap();
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
        let inherited =
            std::env::join_paths([shim_dir.as_path(), Path::new("/usr/bin")]).unwrap();
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
        }
    }

    #[test]
    fn allows_free_form_shell_commands() {
        let workspace = TempDir::new().unwrap();
        assert!(validate_request(
            workspace.path(),
            request("echo hello"),
        )
        .is_ok());
        assert!(validate_request(
            workspace.path(),
            request("git status --short"),
        )
        .is_ok());
        assert!(validate_request(
            workspace.path(),
            request("npm test"),
        )
        .is_ok());
        assert!(validate_request(
            workspace.path(),
            request("cargo check --locked"),
        )
        .is_ok());
        assert!(validate_request(
            workspace.path(),
            request("ls -la && echo done"),
        )
        .is_ok());
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
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(workspace.path().join("nested")).unwrap();
        symlink(outside.path(), workspace.path().join("outside-link")).unwrap();
        assert_eq!(
            resolve_command_cwd(workspace.path(), Some("nested")).unwrap(),
            std::fs::canonicalize(workspace.path().join("nested")).unwrap()
        );
        assert!(resolve_command_cwd(workspace.path(), Some("../outside")).is_err());
        assert!(resolve_command_cwd(workspace.path(), Some("outside-link")).is_err());
    }

    #[tokio::test]
    async fn executes_a_shell_command_and_streams_output() {
        let workspace = TempDir::new().unwrap();
        let command = validate_request(
            workspace.path(),
            request("echo hello world"),
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
    async fn cancellation_terminates_the_process_group() {
        let workspace = TempDir::new().unwrap();
        let command = ValidatedCommand {
            request_id: "cancel-command".into(),
            command: "sleep 30 & wait".into(),
            cwd: workspace.path().to_path_buf(),
            workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
            timeout: None,
            tier: CommandTier::SandboxSafe,
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
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
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
    async fn normal_exit_cleans_up_background_processes() {
        let workspace = TempDir::new().unwrap();
        let command = ValidatedCommand {
            request_id: "background-command".into(),
            command: "sleep 30 & echo $!".into(),
            cwd: workspace.path().to_path_buf(),
            workspace_root: std::fs::canonicalize(workspace.path()).unwrap(),
            timeout: None,
            tier: CommandTier::NetworkRequired,
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
        let process_id = String::from_utf8(output)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(unsafe { libc::kill(process_id, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
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
        let command = validate_request(
            workspace.path(),
            request("curl -V; echo NET$TMPDIR"),
        )
        .unwrap();
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
        assert!(!text.contains("sk-proj-abc123"), "token 键值应被遮盖: {text}");
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
