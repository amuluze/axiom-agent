//! Seatbelt 沙箱：profile 生成、路径校验、命令安全分级。
//!
//! 设计依据：`docs/os-sandbox-plan.md` §3/§4/§5。
//! 沙箱作为额外安全层叠加，不改审批链路；命令分级用模型声明的 `declared_network`
//! 与网络关键字交叉验证（TS 侧 bashTool 的 `network` 声明经 workspace_approval 传入，
//! Rust 权威分类，不信任前端自报）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

/// 命令安全分级。S3（sudo / 重定向到工作区外）由 `reject_unsafe_free_command`
/// 在 `validate_request` 中先行拦截，分类器只产生两级。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandTier {
    /// 纯工作区操作，无外网需求——沙箱内执行（仅回环网络），单层 UI 审批
    /// （tier 由 Rust 权威分类并绑定审批租约；沙箱不可用时 fail-closed 拒绝，
    /// 不降级无沙箱）。
    SandboxSafe,
    /// 需要出站网络——**仍在沙箱内**执行（网络启用的 profile：写仍限工作区、
    /// 凭据仍 deny），保留双层审批（原生对话框）。沙箱不可用时回退常规用户权限
    /// 执行（该分级从不依赖沙箱作为先决条件，审批闸已比 SandboxSafe 重一层）。
    NetworkRequired,
}

/// 网络关键字列表。必须与 TS 侧 bashTool.ts 逐字一致（`bash-policy-audit` 强制）。
/// 定位是"减速带"而非安全边界：解释器内联网络调用（`python3 -c "import socket..."`）
/// 与脚本包装可绕过，真正的网络阻断在 OS 沙箱层（`deny network*`），漏报 fail-closed。
/// 关键词用前缀/整词形式（如 `"npx "`、`"http://"`、`"ftp://"`），避免裸 `"http"`/`"ftp"`
/// 误匹配 httpHandler、ftp_server.py 等普通字符串。包管理器用 install/add 级粒度：
/// `yarn test` / `pnpm build` 是纯本地命令，不得误升级为 NetworkRequired。
pub(crate) const NETWORK_KEYWORDS: &[&str] = &[
    "curl",
    "wget",
    "nc ",
    "ncat",
    "netcat",
    "/usr/bin/nc",
    "ssh",
    "scp",
    "rsync",
    "npm install",
    "npm i ",
    "npm ci",
    "npm publish",
    "npx ",
    "yarn add",
    "yarn install",
    "yarn upgrade",
    "yarn publish",
    "pnpm add",
    "pnpm install",
    "pnpm update",
    "pnpm publish",
    "pip install",
    "pip3 install",
    "uv pip",
    "cargo add",
    "cargo update",
    "cargo publish",
    "cargo install",
    "go get ",
    "go install",
    "go mod download",
    "go mod tidy",
    "git clone",
    "git fetch",
    "git pull",
    "git push",
    "git ls-remote",
    "git submodule update",
    "gem install",
    "bundle install",
    "dotnet restore",
    "brew install",
    "docker",
    "telnet",
    "socat",
    "http://",
    "https://",
    "ftp://",
];

/// 需要读取 VCS 身份凭据（SSH 私钥 / git 文件型凭据）才能正常工作的网络命令。
/// 这些命令命中 NETWORK_KEYWORDS 后分级为 NetworkRequired，但在沙箱内执行时
/// 必须额外放行 `~/.ssh` 与 `~/.config/git/credentials` 的读取，否则 `git push`
/// 等合法工作流会因无法认证而失败。该放行由 Rust 根据命令字符串权威判定，
/// 不依赖前端自报；审批文案同步提示用户。
/// （仅沙箱路径消费；Windows 无沙箱后端，保留编译维持跨平台类型检查。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) const VCS_CREDENTIAL_KEYWORDS: &[&str] = &[
    "git clone",
    "git fetch",
    "git pull",
    "git push",
    "git ls-remote",
    "git submodule update",
];

/// 判定命令是否需要读取 VCS 凭据。注意：此函数只关心命令字面量是否含 git 网络
/// 关键字；实际安全分级仍由 `classify_command` 负责。
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) fn command_requires_vcs_credentials(command: &str) -> bool {
    VCS_CREDENTIAL_KEYWORDS
        .iter()
        .any(|keyword| command.contains(keyword))
}

/// 声明式分类：模型声明 `network` + Rust 关键字交叉验证。
/// Phase A 中调用方固定传 `declared_network = false`（TS 侧尚无该字段）；
/// 模型声明为真、或命令含网络关键字，一律升级为 NetworkRequired（fail-safe）。
pub(crate) fn classify_command(command: &str, declared_network: bool) -> CommandTier {
    let has_network_keyword = NETWORK_KEYWORDS
        .iter()
        .any(|keyword| command.contains(keyword));
    match (declared_network, has_network_keyword) {
        (true, _) | (false, true) => CommandTier::NetworkRequired,
        (false, false) => CommandTier::SandboxSafe,
    }
}

/// 沙箱可用性探测：不止检查文件存在，而是**功能性探测**——用最小包装实际跑一次
/// `/usr/bin/true`。两平台同构：macOS 上 sandbox-exec 处于弃用状态（Apple 标记
/// deprecated，Chrome/codex 仍在用），Linux 上 bwrap 依赖非特权用户命名空间（Ubuntu
/// 24.04+ 的 AppArmor 限制会使其实跑失败）——文件存在性检查都会漏报，实跑探测让
/// 能力缺失提前暴露为明确失败（fail-closed）。结果按进程缓存——探测要 fork+exec，
/// 不能每条命令都跑。
pub(crate) fn sandbox_available() -> bool {
    static OPERATIONAL: OnceLock<bool> = OnceLock::new();
    *OPERATIONAL.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .arg("-p")
                .arg("(version 1)(allow default)")
                .arg("/usr/bin/true")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
        #[cfg(target_os = "linux")]
        {
            // 最小 bwrap 形态实跑：与生产参数同构（root 只读绑 + /dev /proc /tmp +
            // 网络命名空间），任一环节缺失（二进制不存在/unprivileged userns 被
            // AppArmor 关闭）都会以非零退出暴露。
            std::process::Command::new(sandbox_program())
                .args([
                    "--ro-bind", "/", "/",
                    "--dev", "/dev",
                    "--proc", "/proc",
                    "--tmpfs", "/tmp",
                    "--unshare-net",
                    "--",
                    "/usr/bin/true",
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            false
        }
    })
}

/// 沙箱包装程序的候选路径：merged-usr 发行版 /bin 是 /usr/bin 的符号链接，两个
/// 候选覆盖全部布局；按存在性取第一个，默认回落标准路径（错误文案引用固定名）。
#[cfg(target_os = "linux")]
const BWRAP_CANDIDATE_PROGRAMS: &[&str] = &["/usr/bin/bwrap", "/bin/bwrap"];

/// Linux 沙箱包装程序路径（仅在 `sandbox_available()` 为真后的执行路径调用）。
#[cfg(target_os = "linux")]
pub(crate) fn sandbox_program() -> &'static str {
    BWRAP_CANDIDATE_PROGRAMS
        .iter()
        .find(|candidate| {
            std::path::Path::new(candidate)
                .symlink_metadata()
                .map(|meta| meta.is_file())
                .unwrap_or(false)
        })
        .copied()
        .unwrap_or("/usr/bin/bwrap")
}

/// 沙箱不可用时的 fail-closed 错误文案（lease 签发前置检查与执行路径共用）。
/// 文案必须给出可行动的替代路径——声明 `network: true` 走 NetworkRequired 分级
/// （该分级从不以沙箱为先决条件，沙箱不可用时回退双层审批 + 常规用户权限执行），
/// 否则模型会陷入「每条命令都被拒绝且无出路」的死锁。
pub(crate) fn sandbox_unavailable_error(context: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        format!("OS sandbox (sandbox-exec) is unavailable; {context}")
    }
    #[cfg(target_os = "linux")]
    {
        format!(
            "OS sandbox (bubblewrap) is unavailable — install the `bubblewrap` package and \
             ensure unprivileged user namespaces are enabled (see docs/linux-support.md); \
             {context}. Workaround: re-run the command with `network: true` to use the \
             double-approval execution path"
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        // Windows（及其它平台）：尚无 OS 沙箱实现（Restricted token / AppContainer
        // 方案见 docs/windows-support.md）。文案与 Linux 同一结构：给出 network: true
        // 双层审批出路，避免「每条命令都被拒绝且无出路」的死锁。
        format!(
            "OS sandbox is not yet available on this platform (see docs/windows-support.md); \
             {context}. Workaround: re-run the command with `network: true` to use the \
             double-approval execution path"
        )
    }
}

/// 查询进程的进程组 ID（POSIX getpgid）。denial 归属用：deny 日志行只带 pid，
/// 而命令树内所有进程共享 sandbox-exec 的进程组；deny 行到达时目标进程刚被拒、
/// 几乎必然仍存活，实时比对 pgid 即可过滤系统其它沙箱进程（logd_helper /
/// mdworker 等）的噪声。进程已退出（或非同 uid）返回 None。
#[cfg(target_os = "macos")]
fn process_group_of(pid: i32) -> Option<i32> {
    let pgid = unsafe { libc::getpgid(pid) };
    if pgid < 0 {
        return None;
    }
    Some(pgid)
}

/// seatbelt deny 日志行条目（内核 sender == "Sandbox" 的 Error 级消息）。
/// 实测格式（darwin 25，`log show/stream --predicate 'sender == "Sandbox"'`）：
/// `kernel: (Sandbox) Sandbox: bash(71136) deny(1) file-read-metadata /Users/x/.ssh`
/// 与计形式 `Sandbox: 1 duplicate report for Sandbox: ls(71137) deny(1) ...`。
// 条目的构造/解析位于 macOS 专属的归属过滤块（cfg 门控）；Linux 上 deny 捕获
// 静默降级为无捕获（spawn /usr/bin/log 失败），条目类型不可达但保持编译。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone)]
struct SandboxDenialEntry {
    pid: i32,
    operation: String,
    path: String,
}

/// 从日志行提取 `name(pid) deny(n) op path` 尾部。正则从行内任意位置起匹配，
/// 兼容 duplicate-report 前缀与不同 --style 的行首格式；不匹配（无 deny 或
/// 非目标消息）返回 None。（仅 macOS 沙箱路径消费；Windows 保留编译。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn parse_denial_line(line: &str) -> Option<SandboxDenialEntry> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"([A-Za-z0-9_.@/-]+)\((\d+)\)\s+deny\(\d+\)\s+(\S+)\s+(.+)$")
            .expect("compile-time sandbox denial line pattern")
    });
    let captures = pattern.captures(line)?;
    Some(SandboxDenialEntry {
        pid: captures.get(2)?.as_str().parse().ok()?,
        operation: captures.get(3)?.as_str().to_string(),
        path: captures.get(4)?.as_str().trim().to_string(),
    })
}

/// 沙箱拒绝可观测性捕获器（对齐 codex 的 log_denials，产品化到命令执行路径）。
///
/// 在 sandbox-exec 派生**之前**启动 `log stream`（denial 以 Error 级上报统一日志，
/// 实测谓词 `sender == "Sandbox"`；`(with log)` profile 过滤器在当前 seatbelt
/// 版本报 unbound variable，不可用），命令结束后停止并返回**归属到本命令进程组**
/// 的 deny 条目（op+path 去重合并计数，上限 16 条）。归属在读线程实时做——
/// deny 行到达时进程刚被拒仍存活，事后过滤会因进程退出而全部丢失。
/// 定位是诊断辅助而非安全机制：捕获器任何失败一律静默降级为「无捕获」，
/// 绝不阻断命令执行。
pub(crate) struct SandboxDenialCapture {
    child: std::process::Child,
    reader: Option<std::thread::JoinHandle<()>>,
    target_pgid: std::sync::Arc<std::sync::atomic::AtomicU32>,
    receiver: std::sync::mpsc::Receiver<SandboxDenialEntry>,
}

impl SandboxDenialCapture {
    /// 启动捕获。失败返回 None（可观测性降级，不影响命令执行）。
    ///
    /// 订阅就绪同步：`log stream` 派生后并不立即开始推送事件（订阅建立实测
    /// 需要数百毫秒），此前立即派生命令会整段错过 denial。`log stream` 启动时
    /// 先打印 `Filtering the log data using ...` 头行——读到它再返回，命令才
    /// 开始派生。等待带 600ms 看门狗：超时/失败 kill 子进程并降级为无捕获。
    /// （仅 macOS 沙箱路径消费；Windows 上 spawn 必败，保留编译。）
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    pub(crate) fn start() -> Option<Self> {
        let mut child = std::process::Command::new("/usr/bin/log")
            .arg("stream")
            .arg("--predicate")
            .arg("sender == \"Sandbox\" AND eventMessage CONTAINS[c] \"deny\"")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let target_pgid = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let reader_pgid = std::sync::Arc::clone(&target_pgid);
        let (sender, receiver) = std::sync::mpsc::channel::<SandboxDenialEntry>();
        // 头行读取线程：读出一行（Blocking）后把 BufReader 交还主线程。
        let (ready_tx, ready_rx) =
            std::sync::mpsc::channel::<std::io::BufReader<std::process::ChildStdout>>();
        let ready_handle =
            std::thread::spawn(move || {
                use std::io::BufRead;
                let mut reader = std::io::BufReader::new(stdout);
                let mut first = String::new();
                match reader.read_line(&mut first) {
                    Ok(0) | Err(_) => {} // EOF / 失败：不交还，主线程看门狗超时
                    Ok(_) => {
                        let _ = ready_tx.send(reader);
                    }
                }
            });
        let reader = match ready_rx.recv_timeout(std::time::Duration::from_millis(600)) {
            Ok(reader) => reader,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = ready_handle.join();
                return None;
            }
        };
        let reader = std::thread::spawn(move || {
            use std::io::BufRead;
            for line in reader.lines().map_while(Result::ok) {
                let Some(entry) = parse_denial_line(&line) else {
                    continue;
                };
                // 0 = 尚未绑定命令进程组（sandbox-exec 未派生）：此期间的 deny 属于
                // 系统其它进程，直接丢弃。
                let target = reader_pgid.load(std::sync::atomic::Ordering::Acquire);
                if target == 0 {
                    continue;
                }
                #[cfg(target_os = "macos")]
                {
                    match process_group_of(entry.pid) {
                        Some(p) if p == target as i32 => {}
                        // 存活但异组：系统其它沙箱进程（logd_helper / mdworker 等），丢弃。
                        Some(_) => continue,
                        // 已退出：deny 行送达（实测 ~20ms）通常晚于短命子进程的存活期，
                        // 窗口内的死进程按本命令归属——外部噪声（长驻进程的 deny）
                        // 在 getpgid 成功路径上已被排除，此分支的残余噪声是外部进程
                        // 恰好在我们窗口内退出的 deny，实测概率可忽略。
                        None => {}
                    }
                }
                if sender.send(entry).is_err() {
                    break;
                }
            }
        });
        Some(Self {
            child,
            reader: Some(reader),
            target_pgid,
            receiver,
        })
    }

    /// 绑定命令进程组（sandbox-exec 派生后调用，pgid == 其 pid）。
    pub(crate) fn bind_process_group(&self, process_group_id: u32) {
        self.target_pgid
            .store(process_group_id, std::sync::atomic::Ordering::Release);
    }

    /// 停止捕获并返回去重条目（`op path`，重复 ≥2 次带 `×N` 后缀）。
    /// `grace` 为停止前等待日志投递的宽限——仅命令疑似因 deny 失败时由调用侧
    /// 传入非零值，成功路径零等待。终止用 SIGTERM 让 `log` 有机会 flush 尾部
    /// 行（实测 SIGKILL 会丢未 flush 的行），SIGKILL 兜底。
    pub(crate) fn stop(mut self, grace: std::time::Duration) -> Vec<String> {
        if !grace.is_zero() {
            std::thread::sleep(grace);
        }
        self.terminate();
        let mut order: Vec<String> = Vec::new();
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for entry in self.receiver.try_iter() {
            let key = format!("{} {}", entry.operation, entry.path);
            let count = counts.entry(key.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                order.push(key);
            }
        }
        order
            .into_iter()
            .take(16)
            .map(|key| match counts[&key] {
                1 => key,
                count => format!("{key} (×{count})"),
            })
            .collect()
    }

    /// 终止 log stream 子进程并等待读线程退出（SIGTERM → 150ms → SIGKILL）。
    /// 捕获器仅在 seatbelt 路径存活（非 macOS start 返回 None，本方法不可达），
    /// 信号调用按 unix 门控仅为维持跨平台编译。
    fn terminate(&mut self) {
        #[cfg(unix)]
        {
            let process_id = self.child.id() as i32;
            unsafe {
                libc::kill(process_id, libc::SIGTERM);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for SandboxDenialCapture {
    fn drop(&mut self) {
        // stop() 之外的提前退出路径（spawn 后命令启动失败等）也必须收掉 log stream。
        self.terminate();
    }
}

/// 路径字符白名单：`[a-zA-Z0-9/._-]` 与空格，且必须为绝对路径。
/// seatbelt profile 参数经 `-D NAME=VALUE` 以值传递、profile 内用 `(param ...)` 引用，
/// 值不嵌入 profile 源码，天然免疫源码注入；此处白名单是纵深防御（canonicalize 后再校验）。
const SAFE_PATH_PATTERN: &str = r"^[a-zA-Z0-9/._\- ]+$";

fn validate_profile_path(value: &Path, label: &str) -> Result<PathBuf, String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN
        .get_or_init(|| Regex::new(SAFE_PATH_PATTERN).expect("compile-time seatbelt path pattern"));
    if !value.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }
    if !pattern.is_match(&value.to_string_lossy()) {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(value.to_path_buf())
}

/// 生成的 sandbox profile 产物。
/// （仅 macOS 沙箱路径消费；Windows/Linux 保留编译维持跨平台类型检查。）
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug)]
pub(crate) struct SandboxProfile {
    /// profile 文件路径（`-f` 参数）。
    pub(crate) path: PathBuf,
}

/// 网络策略档位（对齐 codex 的两档设计）：
/// - `LoopbackOnly`：默认档。外网全禁，但放行本机回环（bind/inbound/outbound）——
///   dev server（vite/next dev）、本地端口测试（vitest+browser、playwright）是
///   SandboxSafe 分类命令的最常见形态，一刀切禁网络导致它们全部失败。回环放行的
///   残余风险：若本机存在联网代理进程，沙箱内命令可经其转发出网——接受（codex
///   网络档同样放行 localhost；逐次审批仍是第一道闸）。
/// - `OutboundEnabled`：`network: true` 声明命令的执行档。命令**仍在沙箱内**（写仍限
///   工作区、凭据仍 deny、输出仍遮盖），只是放开网络——取代旧的「网络命令完全脱离
///   沙箱裸跑」路径，修复 `npm install` 审批后可写全盘/读凭据的缺口。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NetworkPolicy {
    LoopbackOnly,
    OutboundEnabled,
}

/// 生成 seatbelt profile 并写入沙箱私有目录，返回 profile 路径。
///
/// `workspace_root` / `home` / `tmpdir` 必须是 canonical 化后的绝对路径
/// （seatbelt 按解析后的 vnode 判定，`/tmp` 符号链接到 `/private/tmp`，非 canonical 路径
/// 会导致文件操作被拒——冒烟实证）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn generate_sandbox_profile(
    workspace_root: &Path,
    home: &Path,
    tmpdir: &Path,
    sandbox_dir: &Path,
    request_id: &str,
    network: NetworkPolicy,
    allow_vcs_credentials: bool,
) -> Result<SandboxProfile, String> {
    let _ = validate_profile_path(workspace_root, "workspace root")?;
    let _ = validate_profile_path(home, "home")?;
    let _ = validate_profile_path(tmpdir, "tmpdir")?;

    let mut profile = String::new();
    profile.push_str("(version 1)\n(deny default)\n\n");
    profile.push_str(
        ";; Axiom seatbelt profile（docs/os-sandbox-plan.md §3.1/§5）\n\
         ;; last-match-wins：deny default 在前，具体 allow 在后；针对性 deny 在 allow 之后。\n\n",
    );
    profile.push_str(
        ";; 执行策略：无条件允许 process-exec。\n\
         ;; exec 目录白名单不是安全边界——沙箱约束在写/网络/Mach/敏感读（§8.3：工作区\n\
         ;; 二进制 exec 本就是已接受的逃逸面，敏感目录 deny file-read* 后不可读即不可\n\
         ;; exec）。此前按 PATH 目录 + 符号链接目标吸收推导白名单，仍漏掉工具链\n\
         ;; 「入口 → 真实二进制」的两跳派发（实测沙箱内 errno=Operation not permitted）：\n\
         ;; - Apple shim：/usr/bin/git 是真实 shim 二进制（非符号链接），第二跳 exec\n\
         ;;   /Library/Developer/CommandLineTools/usr/bin/git；\n\
         ;; - rustup 代理：~/.cargo/bin/cargo → ~/.rustup/toolchains/<tc>/bin/cargo；\n\
         ;; - git 子命令助手：$(git --exec-path) 在 CLT libexec/git-core；\n\
         ;; - mise shims：shim 再派发到 ~/.local/share/mise/installs/…。\n\
         ;; 逐工具链枚举派发目标是打地鼠（这已是第三轮修复），放行 exec 不扩大爆炸半径。\n\
         ;; 子进程创建必需：(deny default) 会拒绝 process-fork，不加则 bash 无法启动子进程\n",
    );
    profile.push_str("(allow process-exec)\n");
    profile.push_str("(allow process-fork)\n\n");

    profile.push_str(";; 文件系统：工作区完全读写；读采用全局 + 凭据黑名单（见下）\n");
    profile.push_str("(allow file-write* (subpath (param \"WORKSPACE\")))\n");
    profile.push_str("(allow file-read* (subpath (param \"WORKSPACE\")))\n");
    profile.push_str("(allow file-write* (literal \"/dev/null\"))\n");
    profile.push_str("(allow file-read* (literal \"/dev/null\"))\n");
    profile.push_str(
        ";; sysctl-read：Go runtime 启动时取页大小（HW_PAGESIZE），被 deny 会崩溃\n\
         (allow sysctl-read)\n",
    );
    profile.push_str(
        ";; 读取策略：全局读 + 凭据黑名单 deny。实测（macOS 15 / arm64）发现 seatbelt\n\
         ;; 的 allow-subpath 白名单无法让 bash 启动（进程启动需读系统库/工具链，白名单\n\
         ;; 覆盖不全，allow-subpath 在 sealed 系统卷上不可靠），而全局读 + 针对性 deny\n\
         ;; 有效（deny 与 file-write subpath 均正常）。威胁模型相应调整：读开放，但\n\
         ;; 写限工作区 + 网络全禁 + 凭据 deny（§8.1/§8.2）。\n\
         (allow file-read*)\n",
    );

    profile.push_str(";; 临时目录（与进程环境 TMPDIR 一致，见 §3.2）\n");
    profile.push_str("(allow file-write* (subpath (param \"TMPDIR\")))\n");
    profile.push_str("(allow file-read* (subpath (param \"TMPDIR\")))\n");
    profile.push_str(
        ";; 系统临时目录 /private/tmp：seatbelt 内 confstr(DARWIN_USER_TEMP_DIR) 失败\n\
         ;; （seatbelt 无 confstr 关键字，无法 allow），Apple git 等工具回退写\n\
         ;; /tmp（即 /private/tmp）的 cache 文件；不允许则 git 在沙箱内报错\n\
         ;; （冒烟实证）。网络仍按档位限制，写入限于临时目录，不影响工作区写隔离。\n",
    );
    profile.push_str("(allow file-write* (subpath \"/private/tmp\"))\n");
    profile.push_str("(allow file-read* (subpath \"/private/tmp\"))\n");
    profile.push_str(
        ";; /private/var/tmp：部分工具（构建缓存、packager）以 VARDIR 语义使用它，\n\
         ;; 与 /private/tmp 同属系统级共享临时区，写入不触达用户数据（codex 同款）。\n",
    );
    profile.push_str("(allow file-write* (subpath \"/private/var/tmp\"))\n");
    profile.push_str("(allow file-read* (subpath \"/private/var/tmp\"))\n");

    profile.push_str(";; 凭据载体显式 deny（§5，黑名单；防御深度含 ssh/aws/gnupg）\n");
    for credential in SENSITIVE_READ_CREDENTIAL_FILES {
        profile.push_str(&format!(
            "(deny file-read* (literal (string-append (param \"HOME\") \"/{credential}\")))\n"
        ));
    }
    for credential in SENSITIVE_READ_CREDENTIAL_SUBPATHS {
        profile.push_str(&format!(
            "(deny file-read* (subpath (string-append (param \"HOME\") \"/{credential}\")))\n"
        ));
    }

    profile.push_str(
        ";; 敏感个人目录 deny（默认拒绝文档/桌面/下载等；工作区位于其内时由调用侧跳过）\n",
    );
    for dir in sensitive_read_deny_dirs(home, workspace_root)
        .into_iter()
        .chain(extra_deny_dirs_from_env(home, workspace_root))
    {
        // canonicalize 解析 symlink 后的具体路径不再经过入口处的字符白名单，
        // 进入 profile 文本前必须逐个校验（路径以插值形态嵌入 subpath 规则）。
        if validate_profile_path(&dir, "sensitive deny dir").is_err() {
            continue;
        }
        profile.push_str(&format!("(deny file-read* (subpath \"{}\"))\n", dir.display()));
    }

    // VCS 认证命令（git push/pull/fetch/clone 等）需要读取 SSH 私钥或 git 文件型
    // 凭据才能正常工作。在 NetworkRequired 档位内精确放行这两个路径，覆盖上方
    // 的凭据 deny；其余凭据目录（aws/gnupg/npmrc/cargo）仍保持拒绝。
    if allow_vcs_credentials {
        profile.push_str(
            ";; VCS 认证命令：精确放行 SSH 私钥与 git 文件型凭据（覆盖上方 deny）\n\
             (allow file-read* (subpath (string-append (param \"HOME\") \"/.ssh\")))\n\
             (allow file-read* (literal (string-append (param \"HOME\") \"/.config/git/credentials\")))\n",
        );
    }

    profile.push_str(
        ";; 网络：默认全拒绝（覆盖 AF_INET 与 AF_UNIX socket——冒烟实证），\n\
         ;; 再按档位放行（last-match-wins，allow 在 deny 之后）。AF_UNIX 默认保持拒绝：\n\
         ;; unix socket 可直连宿主守护进程（ssh-agent、Docker daemon——后者等价于\n\
         ;; 以宿主权限执行任意操作），只两处定点放行：系统解析器（mDNSResponder）与容器引擎 daemon socket（仅网络档，见下方 OutboundEnabled 分支）。\n\
         (deny network*)\n",
    );
    let container_socket_rules = if matches!(network, NetworkPolicy::OutboundEnabled) {
        container_engine_profile_rules(home)
    } else {
        String::new()
    };
    match network {
        NetworkPolicy::LoopbackOnly => {
            profile.push_str(
                ";; 本机回环放行：bind 收全接口（express 等默认 listen 0.0.0.0，\n\
                 ;; 收窄到 localhost:* 会让 server 直接启动失败），但入方向仅允许\n\
                 ;; 回环连入——外部客户端被 inbound 规则挡住，LAN 不可达。\n\
                 (allow network-bind (local ip \"*:*\"))\n\
                 (allow network-inbound (local ip \"localhost:*\"))\n\
                 (allow network-outbound (remote ip \"localhost:*\"))\n",
            );
        }
        NetworkPolicy::OutboundEnabled => {
            profile.push_str(
                ";; network: true 声明命令：IP 网络全放行（写仍限工作区）。放行精确到\n\
                 ;; ip 类型过滤——AF_UNIX 不匹配，仍被上方 (deny network*) 拒绝：unix\n\
                 ;; socket 可直连宿主守护进程（ssh-agent、Docker daemon——后者等价于\n\
                 ;; 以宿主权限执行任意操作），不能随网络档一起放开（实测回归：通配\n\
                 ;; (allow network*) 曾让网络档 bind AF_UNIX 成功）。唯一例外：macOS\n\
                 ;; 系统 DNS 解析（libinfo/getaddrinfo）本身走 mDNSResponder 的 unix\n\
                 ;; socket，不定点放行则网络档内所有域名解析全挂（curl exit=6 实测）。\n\
                 (allow network-outbound (remote ip \"*:*\"))\n\
                 (allow network-inbound (local ip \"*:*\"))\n\
                 (allow network-bind (local ip \"*:*\"))\n\
                 (allow network-outbound (remote unix-socket (literal \"/private/var/run/mDNSResponder\")))\n",
            );
        }
    }
    profile.push_str(&container_socket_rules);
    profile.push('\n');

    profile.push_str(
        ";; 进程信号与 IPC。显式 deny 省略——(deny default) 已覆盖，此处只列 allow：\n\
         ;; - signal same-sandbox：命令自身进程组管理（超时回收依赖）\n\
         ;; - ipc-posix-sem：Python multiprocessing SemLock 必需（codex 同款，禁则\n\
         ;;   pytest -n auto 等并行测试全崩）\n",
    );
    profile.push_str("(allow signal (target same-sandbox))\n");
    profile.push_str("(allow ipc-posix-sem)\n");
    profile.push_str(
        ";; mach-lookup 白名单（默认仍拒）：cfprefsd / opendirectoryd 是进程启动与\n\
         ;; 用户名解析的常见依赖（defaults read、getpwnam 类工具），底层 plist 文件\n\
         ;; 本就在全局读范围内，放行不扩大泄露面（codex 同款名单）。\n",
    );
    profile.push_str("(allow mach-lookup\n");
    profile.push_str("  (global-name \"com.apple.cfprefsd.agent\")\n");
    profile.push_str("  (global-name \"com.apple.cfprefsd.daemon\")\n");
    profile.push_str("  (global-name \"com.apple.system.opendirectoryd.libinfo\"))\n");
    if network == NetworkPolicy::OutboundEnabled {
        profile.push_str(
            ";; 网络档追加（Chromium network.sb 同源）：TLS 信任链与 DNS 配置读取。\n\
             ;; SecurityServer/trustd/ocspd 参与证书校验，configd/DNSConfiguration\n\
             ;; 参与解析器配置，缺省则 curl/git 的 https 全部失败。\n",
        );
        profile.push_str("(allow mach-lookup\n");
        for service in [
            "com.apple.SecurityServer",
            "com.apple.trustd",
            "com.apple.trustd.agent",
            "com.apple.ocspd",
            "com.apple.networkd",
            "com.apple.SystemConfiguration.configd",
            "com.apple.SystemConfiguration.DNSConfiguration",
        ] {
            profile.push_str(&format!("  (global-name \"{service}\")\n"));
        }
        profile.push_str(")\n");
    }
    profile.push('\n');

    // fork bomb 防御：seatbelt profile 不支持 (limit process-fork)（实测报
    // "unbound variable: limit"），依赖 execute_command 的进程组回收 + wall-clock
    // timeout（terminate_remaining_process_group）作为主兜底（docs/os-sandbox-plan.md §3.1）。

    append_write_boundary_hardening(&mut profile, workspace_root, home);

    std::fs::create_dir_all(sandbox_dir).map_err(|error| {
        format!(
            "failed to create sandbox directory {}: {error}",
            sandbox_dir.display()
        )
    })?;
    let profile_path = sandbox_dir.join(format!("{request_id}.sb"));
    std::fs::write(&profile_path, profile).map_err(|error| {
        format!(
            "failed to write sandbox profile {}: {error}",
            profile_path.display()
        )
    })?;

    Ok(SandboxProfile { path: profile_path })
}

// ---------------------------------------------------------------------------
// 写边界硬化（seatbelt）：读取 deny 与写入 allow 之间的缝隙封堵辅助函数。
// ---------------------------------------------------------------------------
/// 写边界硬化段（对齐 codex `sandboxing/src/seatbelt.rs` 的三类防御）：读取面
/// deny 只按路径匹配，而写入面 allow 覆盖整个工作区——位于工作区内的读取 deny
/// 子树可以整体被 rename 到工作区其它路径后再读取（rename 源操作落在源 vnode
/// 上，被 `file-write*` allow 覆盖），`AXIOM_SANDBOX_EXTRA_DENY_DIRS` 指向工作区
/// 内部、或工作区本身是 $HOME（凭据/敏感目录全在其内）时这是真实可走的逃逸路径。
/// 规则必须位于 profile 末尾：last-match-wins 语义下 deny 要压在全部 allow 之后。
///
/// ① 受保护子树 `file-write*` deny——阻止改写内容、阻止把其中文件 rename 出去；
/// ② 祖先目录 `file-write-unlink` deny——阻止 rename/rmdir 受保护目录本身或其
///    祖先链（把受保护目录改名移出 deny 路径是同一 bypass 的目录级形态）。祖先
///    只 deny unlink 不 deny 全部写：在受保护目录旁正常创建文件必须保留；
/// ③ 写根锚点 `file-write-unlink` deny——工作区/临时目录根不可被沙箱内命令
///    unlink（后续命令的 profile 仍以该路径为授权边界，codex 原注释：a sandboxed
///    process must not be able to replace an authority boundary）。
/// 另有两条全局硬化：XPC service lookup 显式 deny（deny default 不覆盖
/// xpc-service-name 维度，codex 同款），与 fcntl 80/110 deny——`F_MAKECOMPRESSED`
/// /`F_TRANSFEREXTENTS` 可经只读描述符改写文件，绕过 `file-write*`，甚至
/// `(deny default)` 也不覆盖 system-fcntl（codex 原注释：even deny-default needs
/// this explicit deny）。
#[cfg_attr(all(not(target_os = "macos"), not(test)), allow(dead_code))]
fn append_write_boundary_hardening(profile: &mut String, workspace_root: &Path, home: &Path) {
    profile.push_str(
        ";; 写边界硬化（读取 deny 与写入 allow 之间的缝隙封堵；规则压在全部 allow 之后）\n",
    );
    profile.push_str("(deny mach-lookup (xpc-service-name-prefix \"\"))\n");
    profile.push_str(
        ";; ③ 写根锚点：沙箱内命令不得 unlink 工作区/临时目录根本身。\n",
    );
    profile.push_str(
        "(deny file-write-unlink (require-all (literal (param \"WORKSPACE\")) (vnode-type DIRECTORY)))\n",
    );
    profile.push_str(
        "(deny file-write-unlink (require-all (literal (param \"TMPDIR\")) (vnode-type DIRECTORY)))\n",
    );
    for tmp in ["/private/tmp", "/private/var/tmp"] {
        profile.push_str(&format!(
            "(deny file-write-unlink (require-all (literal \"{tmp}\") (vnode-type DIRECTORY)))\n"
        ));
    }
    profile.push_str(
        ";; ①② 工作区内的读取 deny 路径同步收紧写入面：子树整体写 deny + 祖先链\n\
         ;; unlink deny（读取 deny 被 rename 逃逸的封堵，见函数头注释）。\n",
    );
    for protected in protected_read_deny_paths(home, workspace_root) {
        match &protected.form {
            ProtectedPathForm::SubpathParam(param_path) => {
                profile.push_str(&format!(
                    "(deny file-write* (subpath (string-append (param \"HOME\") \"/{param_path}\")))\n"
                ));
            }
            ProtectedPathForm::LiteralParam(param_path) => {
                profile.push_str(&format!(
                    "(deny file-write* (literal (string-append (param \"HOME\") \"/{param_path}\")))\n"
                ));
            }
            ProtectedPathForm::Concrete(path) => {
                profile.push_str(&format!(
                    "(deny file-write* (subpath \"{}\"))\n",
                    path.display()
                ));
            }
        }
        // 祖先链：仅「严格位于工作区内」的目录（工作区根自身由锚点 deny 覆盖，
        // 工作区外的祖先本就不可写）。工作区内的路径分量都经过 canonical 化，
        // literal 规则与真实 vnode 一一对应。
        for ancestor in protected.ancestors_under_workspace(workspace_root) {
            profile.push_str(&format!(
                "(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal \"{}\")))\n",
                ancestor.display()
            ));
        }
    }
    profile.push_str("(deny system-fcntl (fcntl-command 80 110))\n");
}

/// 受保护读取 deny 路径在 profile 中的形态。凭据载体以 `(param "HOME")` 拼接
/// 形态 emit（与读取 deny 同构、无需新增 -D 参数）；敏感/额外 deny 目录是
/// canonical 具体路径，直接以 literal 嵌入（进入 profile 前已经字符白名单校验）。
#[cfg_attr(all(not(target_os = "macos"), not(test)), allow(dead_code))]
enum ProtectedPathForm {
    /// HOME 相对子路径（目录整体），以 `(string-append (param "HOME") ...)` 引用。
    SubpathParam(String),
    /// HOME 相对精确文件，同上但用 literal 匹配。
    LiteralParam(String),
    /// canonical 具体路径。
    Concrete(PathBuf),
}

#[cfg_attr(all(not(target_os = "macos"), not(test)), allow(dead_code))]
struct ProtectedReadPath {
    form: ProtectedPathForm,
    /// 用于工作区包含判定与祖先链计算的具体路径（与 form 指向同一路径）。
    concrete: PathBuf,
}

impl ProtectedReadPath {
    /// 从自身到工作区根之间的祖先目录（不含自身、不含工作区根）。
    fn ancestors_under_workspace(&self, workspace_root: &Path) -> Vec<PathBuf> {
        let mut ancestors = Vec::new();
        let mut current = self.concrete.parent();
        while let Some(dir) = current {
            if !dir.starts_with(workspace_root) || dir == workspace_root {
                break;
            }
            ancestors.push(dir.to_path_buf());
            current = dir.parent();
        }
        ancestors
    }
}

/// 全部读取 deny 路径（凭据子路径/凭据文件/敏感目录/额外 deny 目录）。
/// 只返回位于可写工作区内的条目——工作区外的路径本就不可写，无需写保护。
#[cfg_attr(all(not(target_os = "macos"), not(test)), allow(dead_code))]
fn protected_read_deny_paths(home: &Path, workspace_root: &Path) -> Vec<ProtectedReadPath> {
    // 敏感目录在 sensitive_read_deny_dirs 内部做 canonical 化，包含比较必须用
    // 同一坐标系：home 与工作区都 canonical 化（/tmp 符号链接形态的路径会让
    // starts_with 失配，规则静默漏发）。
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let workspace_root = std::fs::canonicalize(workspace_root)
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let mut paths = Vec::new();
    let mut push_if_inside = |form: ProtectedPathForm, concrete: PathBuf| {
        if concrete.starts_with(workspace_root.as_path()) {
            paths.push(ProtectedReadPath { form, concrete });
        }
    };
    for sub in SENSITIVE_READ_CREDENTIAL_SUBPATHS {
        push_if_inside(
            ProtectedPathForm::SubpathParam((*sub).to_string()),
            home.join(sub),
        );
    }
    for file in SENSITIVE_READ_CREDENTIAL_FILES {
        push_if_inside(
            ProtectedPathForm::LiteralParam((*file).to_string()),
            home.join(file),
        );
    }
    for dir in sensitive_read_deny_dirs(&home, &workspace_root)
        .into_iter()
        .chain(extra_deny_dirs_from_env(&home, &workspace_root))
    {
        if validate_profile_path(&dir, "protected deny dir").is_err() {
            continue;
        }
        push_if_inside(ProtectedPathForm::Concrete(dir.clone()), dir);
    }
    paths
}

// ---------------------------------------------------------------------------
// Linux 后端（bubblewrap）：与 seatbelt 同语义的声明式参数生成。
//
// 设计依据：docs/linux-support.md §2。profile 映射（seatbelt → bwrap）：
// - 全局只读 + 工作区/临时目录可写 → `--ro-bind / /` 先行，`--bind` 工作区与
//   会话 tmpdir 覆盖在后（bwrap 按参数顺序挂载，后挂者胜，等价 last-match-wins）；
// - 凭据/敏感目录 deny → `--tmpfs`（目录遮蔽为空）与 `--ro-bind /dev/null`（文件
//   遮蔽为空），VCS 认证例外 = 不遮蔽对应路径；
// - 档位 A（仅回环）→ `--unshare-net`（新网络命名空间只 up lo，外发全断）；
// - 档位 B（网络启用）→ 不隔离网络，AF_UNIX 防线由「遮蔽 /run + 定点重绑容器
//   socket」承担（unix socket 不受 netns 隔离，必须按路径遮蔽）。
// 参数生成是纯函数（给定 spec 不写文件系统）：macOS 构建同样编译并单测这份语义，
// 只有执行分派与探测是平台专属代码。
// ---------------------------------------------------------------------------

/// Linux bwrap 参数生成的输入（docs/linux-support.md §2.1 映射表的全部外部量）。
/// 路径必须 canonical 化（与 seatbelt 同一约定，调用方经 `prepare_sandbox_tmpdir` /
/// `host_home` 取得）；`container_sockets` 与 `resolv_conf_rebind` 由调用方经本模块
/// 的辅助函数读取宿主状态后传入，保持生成本身可离线单测。
#[cfg_attr(all(not(target_os = "linux"), not(test)), allow(dead_code))]
pub(crate) struct BwrapSandboxSpec<'a> {
    pub(crate) workspace_root: &'a Path,
    pub(crate) home: &'a Path,
    pub(crate) tmpdir: &'a Path,
    pub(crate) network: NetworkPolicy,
    pub(crate) allow_vcs_credentials: bool,
    /// 宿主 `/var/run` 是否为符号链接（merged-usr 布局：遮蔽 `/run` 已覆盖，
    /// 对符号链接路径挂 tmpfs 会失败，必须跳过）。
    pub(crate) var_run_is_symlink: bool,
    /// `/etc/resolv.conf` 的 canonical 目标位于被遮蔽的 `/run` 内时（systemd-resolved
    /// 的 `stub-resolv.conf`），需要把该文件重绑回沙箱，否则 DNS 全挂。
    pub(crate) resolv_conf_rebind: Option<&'a Path>,
    /// 容器引擎 daemon socket（仅网络档定点重绑；见 `container_sockets_for_command`）。
    pub(crate) container_sockets: &'a [PathBuf],
}

/// 生成 bwrap 参数（不含尾部要执行的程序——调用方追加 `/bin/bash -c <command>`，
/// 生成参数以 `--` 收尾防路径形似选项）。
#[cfg_attr(all(not(target_os = "linux"), not(test)), allow(dead_code))]
pub(crate) fn generate_bwrap_args(spec: &BwrapSandboxSpec) -> Vec<std::ffi::OsString> {
    // bwrap 语法约定：`--dev/--tmpfs <path>` 单路径，`--ro-bind/--bind <src> <dst>`
    // 成对路径（同路径自绑即「以指定模式重新暴露」）。遮蔽类挂载必须在 root 绑
    // 之后（bwrap 按参数顺序应用，后挂者覆盖先挂者——等价 seatbelt 的
    // last-match-wins），网络档的定点重绑必须在遮蔽之后。
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    macro_rules! one {
        ($argument:expr, $path:expr) => {
            args.push(std::ffi::OsString::from($argument));
            args.push(($path).as_os_str().to_os_string());
        };
    }
    macro_rules! pair {
        ($argument:expr, $source:expr, $target:expr) => {
            args.push(std::ffi::OsString::from($argument));
            args.push(($source).as_os_str().to_os_string());
            args.push(($target).as_os_str().to_os_string());
        };
    }

    // 根只读绑 + 基础虚拟文件系统：--dev/--proc 提供 /dev/null、ps/kill 依赖的
    // procfs（不换 pid 命名空间，进程模型与 seatbelt 一致：进程组管理在宿主侧）。
    pair!("--ro-bind", Path::new("/"), Path::new("/"));
    one!("--dev", Path::new("/dev"));
    one!("--proc", Path::new("/proc"));
    // 可写：工作区完全读写 + 会话 tmpdir（与进程环境 TMPDIR 一致，§3.2 同构）。
    pair!("--bind", spec.workspace_root, spec.workspace_root);
    pair!("--bind", spec.tmpdir, spec.tmpdir);
    // 系统临时目录：tmpfs 全新实例（写不落宿主 /tmp；seatbelt 的 /private/tmp 放行
    // 同语义——git 等工具的回退缓存位置）。
    one!("--tmpfs", Path::new("/tmp"));
    one!("--tmpfs", Path::new("/var/tmp"));
    // AF_UNIX 防线：/run（含 /run/user/<uid> 的 X11/Wayland/ssh-agent/podman socket）
    // 整体遮蔽；merged-usr 下 /var/run 是同一目录的符号链接，仅在真实目录布局时
    // 补充遮蔽。
    one!("--tmpfs", Path::new("/run"));
    if !spec.var_run_is_symlink {
        one!("--tmpfs", Path::new("/var/run"));
    }
    // systemd-resolved：/etc/resolv.conf 通常是 /run 内 stub-resolv.conf 的符号链接，
    // 遮蔽 /run 会吊死 DNS——按 canonical 目标定点重绑（只读即可）。
    if let Some(target) = spec.resolv_conf_rebind {
        pair!("--ro-bind", target, target);
    }

    // 敏感目录 deny（`sensitive_read_deny_dirs` 已含「工作区位于其内时跳过」豁免；
    // 与 seatbelt 同一单一事实源）。仅遮蔽实际存在的路径——bwrap 对不存在路径挂
    // tmpfs 会失败，而遮蔽不存在的路径本就无意义。环境扩展 deny 同 seatbelt 生效。
    let deny_dirs = sensitive_read_deny_dirs(spec.home, spec.workspace_root)
        .into_iter()
        .chain(extra_deny_dirs_from_env(spec.home, spec.workspace_root));
    for dir in deny_dirs {
        if dir.symlink_metadata().is_ok() {
            one!("--tmpfs", &dir);
        }
    }

    // 凭据载体 deny。VCS 认证命令例外 = 跳过遮蔽 ~/.ssh 与 ~/.config/git/credentials
    //（seatbelt 的 deny-后-allow 在 bwrap 里等价于「按原始内容重新挂载」；.ssh 用
    // 只读重绑——git 认证只读私钥，不需要可写）。网络档另豁免 ~/.docker（docker
    // CLI 状态目录，与 seatbelt 网络档的 read+write 放行同语义：根本不遮蔽）。
    let vcs = spec.allow_vcs_credentials;
    let network_enabled = matches!(spec.network, NetworkPolicy::OutboundEnabled);
    for subpath in SENSITIVE_READ_CREDENTIAL_SUBPATHS {
        let path = spec.home.join(subpath);
        if vcs && *subpath == ".ssh" && path.symlink_metadata().is_ok() {
            pair!("--ro-bind", &path, &path);
            continue;
        }
        if network_enabled && *subpath == ".docker" {
            continue;
        }
        if path.symlink_metadata().is_ok() {
            one!("--tmpfs", &path);
        }
    }
    for file in SENSITIVE_READ_CREDENTIAL_FILES {
        let path = spec.home.join(file);
        if vcs && *file == ".config/git/credentials" && path.symlink_metadata().is_ok() {
            pair!("--ro-bind", &path, &path);
            continue;
        }
        if path.symlink_metadata().is_ok() {
            // 文件型遮蔽：/dev/null 只读绑定为空文件（tmpfs 只能挂目录）。
            pair!("--ro-bind", Path::new("/dev/null"), &path);
        }
    }

    // 网络档位。
    match spec.network {
        NetworkPolicy::LoopbackOnly => {
            // 新网络命名空间只 up lo：dev server bind/回环连接全通过，外发全断
            //（比 seatbelt 的 localhost 规则更严且更简单）。
            args.push(std::ffi::OsString::from("--unshare-net"));
        }
        NetworkPolicy::OutboundEnabled => {
            // 共享宿主网络命名空间（IP 网络全放行）；AF_UNIX 已由 /run 遮蔽兜底，
            // 容器引擎 daemon socket 定点重绑（仅实际存在的；等价宿主权限操作面，
            // 与 seatbelt 一样只在双层审批档放行）。
            for socket in spec.container_sockets {
                if socket.symlink_metadata().is_ok() {
                    pair!("--bind", socket, socket);
                }
            }
        }
    }

    args.push(std::ffi::OsString::from("--"));
    args
}

/// 执行路径的容器引擎 socket 清单（`DOCKER_HOST`/`CONTAINER_HOST` 的 `unix://` 声明 +
/// `AXIOM_SANDBOX_EXTRA_ALLOW_SOCKETS` + 常见引擎默认路径；仅实际存在的条目）。
/// `container_engine_profile_rules`（seatbelt 网络档）与 bwrap 网络档共用同一清单，
/// 保证两后端的容器放行面一致。（仅沙箱路径消费；Windows 保留编译。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) fn container_sockets_for_command(home: &Path) -> Vec<PathBuf> {
    let docker_host = std::env::var("DOCKER_HOST").ok();
    let container_host = std::env::var("CONTAINER_HOST").ok();
    let extra = std::env::var("AXIOM_SANDBOX_EXTRA_ALLOW_SOCKETS").unwrap_or_default();
    container_engine_sockets(
        home,
        &declared_container_sockets(docker_host.as_deref(), container_host.as_deref(), &extra),
    )
}

/// `/etc/resolv.conf` 的 canonical 目标落在 `/run` 内时返回该目标（systemd-resolved
/// 布局的 DNS 重绑参数）；其余布局返回 None（root 只读绑已覆盖，无需处理）。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn resolv_conf_rebind_path() -> Option<PathBuf> {
    let target = std::fs::canonicalize("/etc/resolv.conf").ok()?;
    (target.starts_with("/run")).then_some(target)
}

/// 敏感目录（HOME 相对）：沙箱内命令**读取**全盘开放时，这些目录承载凭据或通讯隐私，
/// 纳入默认 deny 名单。定位是纵深防御的第二道闸——第一道闸仍是逐次审批对话框展示的
/// 命令串。对齐 codex 的哲学：**不 deny 个人文档类目录**（Documents/Desktop/Downloads
/// 等是合法工作素材，读它们经逐次审批授权即可），只 deny「泄露即失守」的凭据与通讯
/// 数据面。工作区位于某目录内部时该目录会被跳过（否则用户把工作区放在其内会导致
/// 沙箱内读取全部失败）；想收紧的用户可用 `AXIOM_SANDBOX_EXTRA_DENY_DIRS` 加回。
#[cfg(target_os = "macos")]
const SENSITIVE_READ_DENY_SUBPATHS: &[&str] = &[
    // Axiom 自身数据根（axiom.db、授权注册表、Provider 密钥）——沙箱内命令可读会
    // 泄露全部会话历史与工作区授权面；工作区位于其内时由下方跳过逻辑豁免。
    ".axiom",
    // 通讯与隐私数据面：泄露伤害大、编程场景几乎无正当读取需求。
    "Library/Keychains",
    "Library/Mail",
    "Library/Messages",
    "Library/Safari",
    "Library/Cookies",
    "Library/Calendars",
    "Library/Contacts",
    ".Trash",
];

/// Linux 侧的敏感目录 deny 名单（XDG 路径语义，定位与 macOS 名单一致：只 deny
/// 「泄露即失守」的凭据与隐私数据面）。`.axiom` 数据根与凭据载体清单（下方两个
/// 跨平台常量）不变；`Library/*` 与 `.Trash` 是 macOS 路径约定，对应替换为
/// freedesktop Trash 与桌面密钥环数据面。个人文档目录（~/Documents 等）同样
/// 不 deny——经逐次审批授权即可读。
#[cfg(target_os = "linux")]
const SENSITIVE_READ_DENY_SUBPATHS: &[&str] = &[
    // Axiom 自身数据根（同 macOS：axiom.db、授权注册表、Provider 密钥）。
    ".axiom",
    // freedesktop 垃圾箱（macOS `.Trash` 的对应物）。
    ".local/share/Trash",
    // 桌面密钥环明文载荷（GNOME keyring 默认存储位与 kwalletd 数据面），
    // 对齐 macOS `Library/Keychains` 的定位：泄露即全量桌面凭据失守。
    ".local/share/keyrings",
    ".local/share/kwalletd",
];

/// Windows 侧的敏感目录 deny 名单。`.axiom` 数据根语义同 macOS/Linux；凭据载体
/// 主要由下方跨平台清单覆盖（Windows 的 OpenSSH / git 同样使用 HOME 下的
/// `.ssh` / `.git-credentials` 等点路径），DPAPI/凭据管理器数据面（AppData 下的
/// Crypto 等）待 Windows 后端立项时再评估——无 OS 沙箱时本名单只作用于 read
/// 工具的敏感读取判定（Phase 0，docs/windows-support.md）。
#[cfg(target_os = "windows")]
const SENSITIVE_READ_DENY_SUBPATHS: &[&str] = &[
    // Axiom 自身数据根（axiom.db、授权注册表、Provider 密钥）。
    ".axiom",
];

/// 计算默认敏感目录 deny 列表（绝对路径）。home 与 workspace_root 均 canonical 化后比较；
/// 工作区位于敏感目录内部 → 跳过该目录（工作区读取必须保留，last-match-wins 语义）。
fn sensitive_read_deny_dirs(home: &Path, workspace_root: &Path) -> Vec<PathBuf> {
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    SENSITIVE_READ_DENY_SUBPATHS
        .iter()
        .filter_map(|sub| {
            let dir = home.join(sub);
            if workspace_root.starts_with(&dir) { None } else { Some(dir) }
        })
        .collect()
}

/// 凭据载体（HOME 相对）：子路径形态（目录整体 deny）。与上方敏感个人目录分开
/// 声明，因为 seatbelt profile 与 read 工具判定都按「子路径 deny」消费它们。
///
/// 覆盖各主流工具链的凭据根：git SSH（.ssh）、云 CLI（.aws/.azure/.kube/.config/gcloud）、
/// 容器注册表（.docker）、代码托管（.config/gh）、以及其它 Agent 的配置根
/// （.config/opencode/.codex/.claude）——它们与 Axiom 同级，内含 API Key/token，
/// 沙箱内命令或 read 工具读取它们即跨 Agent 凭据泄露。
const SENSITIVE_READ_CREDENTIAL_SUBPATHS: &[&str] = &[
    ".ssh",
    ".aws",
    ".azure",
    ".gnupg",
    ".docker",
    ".kube",
    ".config/gh",
    ".config/gcloud",
    ".config/opencode",
    ".codex",
    ".claude",
];
/// 凭据载体（HOME 相对）：精确文件形态（literal deny，不 deny 同名目录内容）。
/// `.git-credentials` 是 `credential.helper=store` 的默认落盘文件（纯文本 token），
/// `.netrc` 是 curl/wget 的认证文件；两者都是编程工作流中真实存在的凭据载体。
const SENSITIVE_READ_CREDENTIAL_FILES: &[&str] = &[
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".cargo/credentials",
    ".config/git/credentials",
];

/// 容器引擎（Docker daemon）unix socket 候选：HOME 相对（OrbStack / Docker Desktop /
/// Colima）与系统路径。仅返回**实际存在**且通过 `validate_profile_path` 字符白名单的项
/// ——引擎未启动时不扩面，路径无引号注入面。
///
/// Docker daemon socket 等价宿主权限操作面（`docker run -v /:/host` 可读写整个宿主
/// 文件系统），因此只在 `network: true` 档（用户双层审批）内定点放行，默认档保持
/// AF_UNIX 全拒。（仅沙箱路径消费；Windows 保留编译。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn container_engine_sockets(home: &Path, declared: &[PathBuf]) -> Vec<PathBuf> {
    const HOME_RELATIVE: &[&str] = &[
        ".orbstack/run/docker.sock",
        ".docker/run/docker.sock",
        ".colima/default/docker.sock",
        ".colima/docker.sock",
    ];
    const ABSOLUTE: &[&str] = &["/var/run/docker.sock"];
    let mut sockets: Vec<PathBuf> = Vec::new();
    for candidate in HOME_RELATIVE
        .iter()
        .map(|relative| home.join(relative))
        .chain(ABSOLUTE.iter().map(PathBuf::from))
        .chain(declared.iter().cloned())
    {
        if !candidate.exists() || validate_profile_path(&candidate, "container socket").is_err() {
            continue;
        }
        // socket 常经 symlink 暴露（/var/run/docker.sock）：literal 与 canonical 形态都列，
        // 客户端用哪种路径连接都能匹配。
        for path in [
            candidate.clone(),
            std::fs::canonicalize(&candidate).unwrap_or(candidate),
        ] {
            if !sockets.contains(&path) {
                sockets.push(path);
            }
        }
    }
    sockets
}

/// 解析额外声明的引擎 socket：`DOCKER_HOST`/`CONTAINER_HOST` 的 `unix://<path>` 形式，
/// 以及 `AXIOM_SANDBOX_EXTRA_ALLOW_SOCKETS`（冒号分隔的绝对路径，留空即无）——自定义
/// 引擎（rootless docker / podman 等）只在自己声明时才扩面。非 unix:// 形式（tcp://…）、
/// 不存在与非法路径一律忽略，且仍受 `validate_profile_path` 字符白名单约束。
/// （仅沙箱路径消费；Windows 保留编译。）
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn declared_container_sockets(
    docker_host: Option<&str>,
    container_host: Option<&str>,
    extra: &str,
) -> Vec<PathBuf> {
    let mut declared: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if path.is_absolute()
            && path.exists()
            && validate_profile_path(&path, "declared container socket").is_ok()
            && !declared.contains(&path)
        {
            declared.push(path);
        }
    };
    for host in [docker_host, container_host].into_iter().flatten() {
        if let Some(path) = host.strip_prefix("unix://") {
            push(PathBuf::from(path));
        }
    }
    for entry in extra.split(':') {
        if !entry.trim().is_empty() {
            push(PathBuf::from(entry.trim()));
        }
    }
    declared
}

/// 网络档专属的容器引擎放行段：daemon socket + docker CLI 自身必需的两处读取
/// （registry 凭据与 CLI 插件目录）。无可用 socket 时返回空串——没装引擎/没启动引擎的
/// 机器上 profile 与改动前完全一致。（仅 seatbelt 路径消费；Windows/Linux 保留编译。）
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn container_engine_profile_rules(home: &Path) -> String {
    // socket 清单与 bwrap 网络档共用同一来源（container_sockets_for_command），
    // 保证两个沙箱后端的容器放行面一致。
    let sockets = container_sockets_for_command(home);
    // docker CLI 状态目录（config.json / contexts / buildx / cli-plugins / trust …）：
    // 只要装了 CLI（目录存在）或引擎 socket 在，就在本档放行——`docker login`、
    // `docker context ls` 不依赖 daemon，没跑引擎时同样需要。
    let has_cli_state = home.join(".docker").exists();
    if sockets.is_empty() && !has_cli_state {
        return String::new();
    }
    let mut rules = String::new();
    if !sockets.is_empty() {
        rules.push_str(
            ";; 容器引擎 daemon socket（仅网络档放行）：dockerd 等价宿主权限操作面，\n\
             ;; 故默认档保持 AF_UNIX 全拒；此处只列实际存在的 socket。\n",
        );
        for socket in &sockets {
            rules.push_str(&format!(
                "(allow network-outbound (remote unix-socket (literal \"{}\")))\n",
                socket.display()
            ));
        }
    }
    rules.push_str(
        ";; docker CLI 状态目录：读（config.json 的 registry 凭据、contexts 的端点元数据、\n\
         ;; cli-plugins 插件、buildx 状态）与写（login / context 切换 / buildx 缓存）都是\n\
         ;; 刚需。逐项枚举会漏——曾经只放行读 config.json + cli-plugins，docker 解析 context\n\
         ;; 时读 contexts/** 即被凭据 deny 拦住（实测「Docker 客户端在沙箱中被阻止」）。\n\
         ;; 本档已把引擎控制权交给命令，读写整个 CLI 状态目录不扩大爆炸半径；\n\
         ;; .docker 的凭据 deny 在默认档与 read 工具上继续生效。\n\
         (allow file-read* (subpath (string-append (param \"HOME\") \"/.docker\")))\n\
         (allow file-write* (subpath (string-append (param \"HOME\") \"/.docker\")))\n",
    );
    rules
}

/// read 工具绝对路径分支的单路径敏感读取判定，与沙箱敏感 deny 共用同一集合
/// （`SENSITIVE_READ_DENY_SUBPATHS` + 凭据载体）：读取面免审批后（对齐 codex
/// 的全盘读语义），read 不得成为绕过沙箱凭据保护的旁路。
///
/// `canonical` 必须已 canonicalize——判定按解析后的真实位置进行，调用方经
/// symlink 置换指向 deny 目标同样会被拒绝。`workspace_roots`（授权工作区根，
/// canonical）豁免优先于 deny：路径位于任一工作区内直接放行，镜像沙箱
/// 「工作区位于 deny 目录内时跳过该目录」的语义，且按单路径判定比按目录
/// 整体跳过更精确。`AXIOM_SANDBOX_EXTRA_DENY_DIRS` 仅作用于沙箱 profile，
/// 不参与本判定。
pub(crate) fn sensitive_read_denied(
    home: &Path,
    canonical: &Path,
    workspace_roots: &[PathBuf],
) -> bool {
    if workspace_roots.iter().any(|root| canonical.starts_with(root)) {
        return false;
    }
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    SENSITIVE_READ_DENY_SUBPATHS
        .iter()
        .chain(SENSITIVE_READ_CREDENTIAL_SUBPATHS.iter())
        .any(|sub| canonical.starts_with(home.join(sub)))
        || SENSITIVE_READ_CREDENTIAL_FILES
            .iter()
            .any(|file| canonical == home.join(file))
}

/// 解析 `AXIOM_SANDBOX_EXTRA_DENY_DIRS`（冒号分隔的 HOME 相对目录）。纯函数便于单测：
/// 非法路径（绝对/含特殊字符）静默跳过——单个怪路径不应让整个沙箱命令失败。
fn parse_extra_deny_dirs(raw: &str, home: &Path, workspace_root: &Path) -> Vec<PathBuf> {
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    raw.split(':')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .filter_map(|sub| {
            let dir = home.join(sub);
            if validate_profile_path(&dir, "extra deny dir").is_err() {
                return None;
            }
            if workspace_root.starts_with(&dir) { return None; }
            Some(dir)
        })
        .collect()
}

/// 从环境变量读取额外 deny 目录（用户扩展只读范围的无 UI 逃生口）。
fn extra_deny_dirs_from_env(home: &Path, workspace_root: &Path) -> Vec<PathBuf> {
    match std::env::var("AXIOM_SANDBOX_EXTRA_DENY_DIRS") {
        Ok(raw) => parse_extra_deny_dirs(&raw, home, workspace_root),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    fn classify(command: &str) -> CommandTier {
        classify_command(command, false)
    }

    #[test]
    fn classifies_plain_workspace_commands_as_sandbox_safe() {
        for command in [
            "ls -la",
            "npm test",
            "npm run build",
            "cargo build",
            "go test ./...",
            "git status --short",
            "yarn test",
            "pnpm build",
            "cat src/main.ts",
        ] {
            assert_eq!(
                classify(command),
                CommandTier::SandboxSafe,
                "command: {command}"
            );
        }
    }

    #[test]
    fn classifies_network_commands_as_network_required() {
        for command in [
            "npm install",
            "npm i lodash",
            "npm ci",
            "npm publish",
            "yarn add lodash",
            "yarn install",
            "pnpm add pkg",
            "pnpm install",
            "curl https://example.com",
            "wget https://example.com",
            "git clone https://github.com/x/y.git",
            "git push origin main",
            "git pull",
            "git fetch",
            "git ls-remote origin",
            "git submodule update --init",
            "pip install requests",
            "cargo add tokio",
            "cargo update",
            "go get example.com/pkg",
            "go mod download",
            "gem install rails",
            "bundle install",
            "dotnet restore",
            "brew install node",
            "docker pull node",
            "npx create-react-app my-app",
            "ssh user@host",
            "scp a.txt host:/tmp/",
            "telnet host 80",
            "rsync -avz ./ host:/srv/",
        ] {
            assert_eq!(
                classify(command),
                CommandTier::NetworkRequired,
                "command: {command}"
            );
        }
    }

    #[test]
    fn prefix_keywords_do_not_over_match_local_commands() {
        // 裸子串误匹配回归：`http://`/`ftp://` 而非 `http`/`ftp`
        assert_eq!(classify("cat http_server.go"), CommandTier::SandboxSafe);
        assert_eq!(classify("grep -r httproxy ."), CommandTier::SandboxSafe);
        assert_eq!(
            classify("mv http_cache.json old/"),
            CommandTier::SandboxSafe
        );
        assert_eq!(classify("ls ftp_server.py"), CommandTier::SandboxSafe);
        // 包管理器 install/add 级粒度：本地命令不误升级
        assert_eq!(classify("yarn test"), CommandTier::SandboxSafe);
        assert_eq!(classify("yarn build"), CommandTier::SandboxSafe);
        assert_eq!(classify("pnpm lint"), CommandTier::SandboxSafe);
        assert_eq!(classify("pnpm run dev"), CommandTier::SandboxSafe);
    }

    #[test]
    fn declared_network_overrides_keyword_absence() {
        // 模型声明需要网络但无关键字 → NetworkRequired（fail-safe）
        assert_eq!(
            classify_command("node script.js", true),
            CommandTier::NetworkRequired
        );
        assert_eq!(
            classify_command("node script.js", false),
            CommandTier::SandboxSafe
        );
    }

    #[test]
    fn interpreter_inline_network_is_not_keyword_detected_but_fail_safe() {
        // 解释器内联网络调用无关键字命中 → SandboxSafe（沙箱内网络 DENY，fail-closed）
        assert_eq!(
            classify("python3 -c 'import socket; s.connect((\"evil.com\",80))'"),
            CommandTier::SandboxSafe
        );
    }

    #[test]
    fn keyword_matching_is_case_sensitive() {
        // contains 大小写敏感：`CURL` 不命中 `curl`。漏报走沙箱 fail-closed，可接受。
        assert_eq!(classify("CURL -I"), CommandTier::SandboxSafe);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sandbox_available_reflects_system_state() {
        // 功能性探针：不止文件存在，还要能实际编译 profile 并 exec /usr/bin/true
        // （sandbox-exec 弃用风险的前置暴露）。冒烟环境与 CI 均应通过。
        assert!(sandbox_available());
    }

    /// deny 日志行解析：覆盖实测的普通格式、duplicate-report 格式与噪声行。
    #[test]
    fn parses_seatbelt_denial_log_lines() {
        let entry = parse_denial_line(
            "2026-08-15 23:47:15.069336+0800 0xbfb7 Error 0x0 0 0 kernel: (Sandbox) \
             Sandbox: ls(71137) deny(1) file-read-metadata /Users/amu/.ssh",
        )
        .expect("普通 deny 行应可解析");
        assert_eq!(entry.pid, 71137);
        assert_eq!(entry.operation, "file-read-metadata");
        assert_eq!(entry.path, "/Users/amu/.ssh");

        let duplicate = parse_denial_line(
            "kernel: (Sandbox) Sandbox: 1 duplicate report for Sandbox: ls(71137) \
             deny(1) file-read-metadata /Users/amu/.ssh",
        )
        .expect("duplicate-report 行应可解析");
        assert_eq!(duplicate.pid, 71137);
        assert_eq!(duplicate.operation, "file-read-metadata");

        // 非 deny 消息（Sandbox apply 等启动日志）不应误解析出条目
        assert!(parse_denial_line("kernel: (Sandbox) Sandbox apply: mdworker_shared[71081] <bytes>").is_none());
        // 空行 / 无关行
        assert!(parse_denial_line("").is_none());
        assert!(parse_denial_line("Filtering the log data using \"sender\"").is_none());
    }

    /// 端到端归属：沙箱内触发 deny 的命令，捕获器必须返回归属到本命令进程组的
    /// 条目（依赖「deny 行到达时进程仍存活」的实时 pgid 比对）。
    #[cfg(target_os = "macos")]
    #[test]
    fn denial_capture_attributes_own_process_group_only() {
        assert!(
            sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let dir = tempfile::tempdir().unwrap();
        // canonicalize 必须做：tempdir 路径含 /var → /private/var 符号链接，seatbelt
        // 按解析后 vnode 判定，非 canonical 的 HOME 参数会让 .ssh deny 规则永不命中
        // （ls 直接读成功，根本不产生 deny——本测试曾因此静默失效）。
        let home = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("home")).unwrap();
            dir.path().join("home")
        })
        .unwrap();
        let workspace = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("ws")).unwrap();
            dir.path().join("ws")
        })
        .unwrap();
        let tmpdir = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("tmp")).unwrap();
            dir.path().join("tmp")
        })
        .unwrap();
        // 凭据 deny 目标必须真实存在（subpath deny 命中存在的 vnode 最可靠）。
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh/authorized_keys"), "ssh-ed25519 test\n").unwrap();
        let profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "denial-e2e",
            NetworkPolicy::LoopbackOnly,
            false,
        )
        .unwrap();
        let capture = SandboxDenialCapture::start().expect("log stream 应可启动");
        // 命令进程组：与生产 execute_command 一致，sandbox-exec 以 process_group(0)
        // 独立成组，pgid == 其 pid（测试曾漏设导致归属永不匹配）。
        let mut child = {
            use std::os::unix::process::CommandExt;
            let mut command = std::process::Command::new("/usr/bin/sandbox-exec");
            command
                .arg("-D")
                .arg(format!("WORKSPACE={}", workspace.display()))
                .arg("-D")
                .arg(format!("HOME={}", home.display()))
                .arg("-D")
                .arg(format!("TMPDIR={}", tmpdir.display()))
                .arg("-f")
                .arg(&profile.path)
                .arg("/bin/bash")
                .arg("-c")
                .arg(format!("ls {}/.ssh", home.display())) // 凭据 deny → EPERM
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            command.process_group(0);
            command.spawn().expect("spawn sandbox-exec")
        };
        let pgid = child.id();
        capture.bind_process_group(pgid);
        let _ = child.wait();
        // 宽限对齐生产失败路径的 1.2s（内核 duplicate-report 聚合延迟实测 ~1s）。
        let denials = capture.stop(std::time::Duration::from_millis(1_200));
        assert!(
            denials.iter().any(|entry| entry.contains(".ssh")),
            "应捕获到本进程组的 .ssh deny: {denials:?}"
        );
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn rejects_invalid_profile_paths() {
        assert!(validate_profile_path(Path::new("relative/path"), "x").is_err());
        assert!(validate_profile_path(Path::new("/tmp/a b"), "x").is_ok());
        assert!(validate_profile_path(Path::new("/tmp/semi;colon"), "x").is_err());
        assert!(validate_profile_path(Path::new("/tmp/quote'"), "x").is_err());
        assert!(validate_profile_path(Path::new("/tmp/$(cmd)"), "x").is_err());
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn generates_profile_with_core_rules() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        let tmpdir = dir.path().join("tmp");
        let sandbox_dir = dir.path().join("sandbox");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tmpdir).unwrap();
        let profile = generate_sandbox_profile(
            &workspace,
            &dir.path().join("home"),
            &tmpdir,
            &sandbox_dir,
            "test-1",
            NetworkPolicy::LoopbackOnly,
            false,
        )
        .unwrap();
        let text = std::fs::read_to_string(&profile.path).unwrap();
        // 冒烟实证的必需规则
        for rule in [
            "(deny default)",
            "(allow process-fork)",
            "(allow process-exec)",
            "(allow sysctl-read)",
            "(allow file-write* (literal \"/dev/null\"))",
            "(deny network*)",
            "(allow signal (target same-sandbox))",
            "(allow ipc-posix-sem)",
            "(allow file-read*)",
            "(deny file-read* (literal (string-append (param \"HOME\") \"/.npmrc\")))",
            "(deny file-read* (subpath (string-append (param \"HOME\") \"/.ssh\")))",
            // 回环放行（bind 全接口 + 仅回环入/出）
            "(allow network-bind (local ip \"*:*\"))",
            "(allow network-inbound (local ip \"localhost:*\"))",
            "(allow network-outbound (remote ip \"localhost:*\"))",
            // mach-lookup 基础白名单
            "(global-name \"com.apple.cfprefsd.agent\")",
        ] {
            assert!(text.contains(rule), "profile missing rule: {rule}");
        }
        // 默认档不放开外网、不放行 TLS mach 服务
        assert!(!text.contains("(allow network*)\n"));
        assert!(!text.contains("com.apple.trustd"));
        // exec 改为无条件放行：不再有按目录推导的 EXEC_N 参数。
        assert!(!text.contains("EXEC_"));
        // 非 VCS 凭据命令不应对 .ssh 放行。
        assert!(!text.contains(
            "(allow file-read* (subpath (string-append (param \"HOME\") \"/.ssh\")))"
        ));
        assert!(profile.path.starts_with(&sandbox_dir));
    }

    /// 自定义引擎（DOCKER_HOST / CONTAINER_HOST / 显式附加名单）只在自己声明时扩面，
    /// 非 unix:// 形式、不存在与非法路径一律忽略。
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn declared_container_sockets_accepts_unix_scheme_and_extra_list() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let custom = dir.path().join("engine/rootless.sock");
        std::fs::create_dir_all(custom.parent().unwrap()).unwrap();
        std::fs::write(&custom, "").unwrap();

        let declared = declared_container_sockets(
            Some(&format!("unix://{}", custom.display())),
            Some("tcp://127.0.0.1:2375"),
            &format!("/nope/missing.sock:{}", custom.display()),
        );
        assert_eq!(declared, vec![custom.clone()]);
        assert!(container_engine_sockets(&home, &declared).contains(&custom));
        assert!(declared_container_sockets(None, None, "").is_empty());
    }

    // -------------------------------------------------------------------------
    // bwrap 参数生成（跨平台纯函数：在任意宿主上验证 Linux 沙箱语义，
    // docs/linux-support.md §2.2 的对抗矩阵）
    // -------------------------------------------------------------------------

    fn bwrap_args_strings(args: &[std::ffi::OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    /// 断言参数序列中存在相邻的 (flag, 路径…) 片段（成对路径按相邻匹配）。
    fn assert_has_arg(rendered: &[String], needle: &[&str]) {
        assert!(
            rendered.windows(needle.len()).any(|window| window
                .iter()
                .zip(needle)
                .all(|(actual, expected)| actual.as_str() == *expected)),
            "bwrap 参数缺少 {needle:?}；实际参数：{rendered:?}"
        );
    }

    fn assert_not_has_arg(rendered: &[String], needle: &[&str]) {
        assert!(
            !rendered.windows(needle.len()).any(|window| window
                .iter()
                .zip(needle)
                .all(|(actual, expected)| actual.as_str() == *expected)),
            "bwrap 参数不应出现 {needle:?}；实际参数：{rendered:?}"
        );
    }

    fn bwrap_spec_paths(dir: &tempfile::TempDir) -> (PathBuf, PathBuf, PathBuf) {
        let workspace = dir.path().join("ws");
        let tmpdir = dir.path().join("tmp");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tmpdir).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        (workspace, tmpdir, home)
    }

    fn bwrap_spec<'a>(
        workspace: &'a Path,
        home: &'a Path,
        tmpdir: &'a Path,
        network: NetworkPolicy,
        allow_vcs: bool,
    ) -> BwrapSandboxSpec<'a> {
        BwrapSandboxSpec {
            workspace_root: workspace,
            home,
            tmpdir,
            network,
            allow_vcs_credentials: allow_vcs,
            // merged-usr 布局形态（主流发行版）：/var/run → /run 符号链接。
            var_run_is_symlink: true,
            resolv_conf_rebind: None,
            container_sockets: &[],
        }
    }

    #[test]
    fn bwrap_args_base_layout_and_network_tiers() {
        let dir = tempfile::tempdir().unwrap();
        let (workspace, tmpdir, home) = bwrap_spec_paths(&dir);

        // 默认档：root 只读 + 工作区/会话 tmpdir 可写 + /tmp //var/tmp //run 遮蔽
        // + 网络命名空间隔离，参数以 -- 收尾。
        let rendered = bwrap_args_strings(&generate_bwrap_args(&bwrap_spec(
            &workspace,
            &home,
            &tmpdir,
            NetworkPolicy::LoopbackOnly,
            false,
        )));
        assert_has_arg(&rendered, &["--ro-bind", "/", "/"]);
        assert_has_arg(&rendered, &["--dev", "/dev"]);
        assert_has_arg(&rendered, &["--proc", "/proc"]);
        let workspace_text = workspace.to_string_lossy().into_owned();
        assert_has_arg(&rendered, &["--bind", &workspace_text, &workspace_text]);
        let tmpdir_text = tmpdir.to_string_lossy().into_owned();
        assert_has_arg(&rendered, &["--bind", &tmpdir_text, &tmpdir_text]);
        assert_has_arg(&rendered, &["--tmpfs", "/tmp"]);
        assert_has_arg(&rendered, &["--tmpfs", "/var/tmp"]);
        assert_has_arg(&rendered, &["--tmpfs", "/run"]);
        assert_has_arg(&rendered, &["--unshare-net"]);
        assert_eq!(rendered.last().map(String::as_str), Some("--"));
        // merged-usr 布局（var_run_is_symlink=true）不得遮蔽 /var/run；
        // 遮蔽必须发生在 root 绑之后（bwrap 后挂者胜）。
        assert_not_has_arg(&rendered, &["--tmpfs", "/var/run"]);
        let root_bind = rendered.iter().position(|arg| arg == "/").unwrap();
        let run_mask = rendered.iter().position(|arg| arg == "/run").unwrap();
        assert!(root_bind < run_mask, "遮蔽必须在 root 绑之后：{rendered:?}");

        // 真实目录布局（var_run_is_symlink=false）：补充遮蔽 /var/run。
        let mut spec = bwrap_spec(&workspace, &home, &tmpdir, NetworkPolicy::LoopbackOnly, false);
        spec.var_run_is_symlink = false;
        let rendered = bwrap_args_strings(&generate_bwrap_args(&spec));
        assert_has_arg(&rendered, &["--tmpfs", "/var/run"]);

        // 网络档：不隔离网络（共享宿主 netns，AF_UNIX 由 /run 遮蔽兜底）。
        let rendered = bwrap_args_strings(&generate_bwrap_args(&bwrap_spec(
            &workspace,
            &home,
            &tmpdir,
            NetworkPolicy::OutboundEnabled,
            false,
        )));
        assert_not_has_arg(&rendered, &["--unshare-net"]);

        // systemd-resolved 布局：/etc/resolv.conf 的 canonical 目标按只读重绑回沙箱。
        let run_target = PathBuf::from("/run/systemd/resolve/stub-resolv.conf");
        let mut spec = bwrap_spec(&workspace, &home, &tmpdir, NetworkPolicy::OutboundEnabled, false);
        spec.resolv_conf_rebind = Some(&run_target);
        let target_text = run_target.to_string_lossy().into_owned();
        let rendered = bwrap_args_strings(&generate_bwrap_args(&spec));
        assert_has_arg(&rendered, &["--ro-bind", &target_text, &target_text]);
    }

    #[test]
    fn bwrap_args_mask_sensitive_paths_with_workspace_exemption() {
        let dir = tempfile::tempdir().unwrap();
        let (workspace, tmpdir, home) = bwrap_spec_paths(&dir);
        // 凭据载体与敏感目录实际创建，触发遮蔽；断言以平台常量为单一事实源
        //（macOS 为 Library/* 名单、Linux 为 XDG 名单——遮蔽逻辑对名单无差别）。
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(home.join(".axiom")).unwrap();
        std::fs::write(home.join(".npmrc"), "token").unwrap();
        // 生产约定：传入生成器的 home/workspace 已 canonical 化（host_home /
        // validate_request 同一坐标系），macOS tempdir 在 /var → /private/var 下的
        // 符号链接差异必须先消解。
        let home = std::fs::canonicalize(&home).unwrap();

        let rendered = bwrap_args_strings(&generate_bwrap_args(&bwrap_spec(
            &workspace,
            &home,
            &tmpdir,
            NetworkPolicy::LoopbackOnly,
            false,
        )));
        let ssh = home.join(".ssh").to_string_lossy().into_owned();
        let axiom = home.join(".axiom").to_string_lossy().into_owned();
        let npmrc = home.join(".npmrc").to_string_lossy().into_owned();
        assert_has_arg(&rendered, &["--tmpfs", &ssh]);
        assert_has_arg(&rendered, &["--tmpfs", &axiom]);
        assert_has_arg(&rendered, &["--ro-bind", "/dev/null", &npmrc]);

        // 工作区位于敏感目录内：该目录被豁免（与 seatbelt 同一跳过逻辑），
        // 其余敏感目录仍遮蔽。
        let inner_workspace = home.join(".axiom/proj");
        std::fs::create_dir_all(&inner_workspace).unwrap();
        let inner_workspace = std::fs::canonicalize(inner_workspace).unwrap();
        let rendered = bwrap_args_strings(&generate_bwrap_args(&bwrap_spec(
            &inner_workspace,
            &home,
            &tmpdir,
            NetworkPolicy::LoopbackOnly,
            false,
        )));
        assert_not_has_arg(&rendered, &["--tmpfs", &axiom]);
        assert_has_arg(&rendered, &["--tmpfs", &ssh]);
    }

    #[test]
    fn bwrap_args_vcs_exception_rebinds_ssh_and_git_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let (workspace, tmpdir, home) = bwrap_spec_paths(&dir);
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(home.join(".config/git")).unwrap();
        std::fs::write(home.join(".config/git/credentials"), "token").unwrap();
        std::fs::write(home.join(".npmrc"), "token").unwrap();
        // 生产约定：传入生成器的 home 已 canonical 化（host_home 同一坐标系）。
        let home = std::fs::canonicalize(&home).unwrap();

        let rendered = bwrap_args_strings(&generate_bwrap_args(&bwrap_spec(
            &workspace,
            &home,
            &tmpdir,
            NetworkPolicy::OutboundEnabled,
            true,
        )));
        let ssh = home.join(".ssh").to_string_lossy().into_owned();
        let credentials = home
            .join(".config/git/credentials")
            .to_string_lossy()
            .into_owned();
        let npmrc = home.join(".npmrc").to_string_lossy().into_owned();
        // VCS 认证例外：.ssh 只读重绑（git 只读私钥）、credentials 文件重绑原文；
        // 其它凭据载体仍按原样遮蔽。
        assert_has_arg(&rendered, &["--ro-bind", &ssh, &ssh]);
        assert_has_arg(&rendered, &["--ro-bind", &credentials, &credentials]);
        assert_has_arg(&rendered, &["--ro-bind", "/dev/null", &npmrc]);
        assert_not_has_arg(&rendered, &["--tmpfs", &ssh]);
    }

    #[test]
    fn bwrap_args_network_tier_docker_state_and_container_sockets() {
        let dir = tempfile::tempdir().unwrap();
        let (workspace, tmpdir, home) = bwrap_spec_paths(&dir);
        std::fs::create_dir_all(home.join(".docker")).unwrap();
        let socket = dir.path().join("engine/docker.sock");
        std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
        std::fs::write(&socket, "").unwrap();
        let missing = dir.path().join("engine/missing.sock");
        let sockets = vec![socket.clone(), missing];
        // 生产约定：传入生成器的 home 已 canonical 化（host_home 同一坐标系）。
        let home = std::fs::canonicalize(&home).unwrap();
        let docker = home.join(".docker").to_string_lossy().into_owned();
        let socket_text = socket.to_string_lossy().into_owned();

        // 网络档：~/.docker（docker CLI 状态目录）不遮蔽；实际存在的容器 socket
        // 定点重绑，不存在的跳过。
        let spec = BwrapSandboxSpec {
            workspace_root: &workspace,
            home: &home,
            tmpdir: &tmpdir,
            network: NetworkPolicy::OutboundEnabled,
            allow_vcs_credentials: false,
            var_run_is_symlink: true,
            resolv_conf_rebind: None,
            container_sockets: &sockets,
        };
        let rendered = bwrap_args_strings(&generate_bwrap_args(&spec));
        assert_not_has_arg(&rendered, &["--tmpfs", &docker]);
        assert_has_arg(&rendered, &["--bind", &socket_text, &socket_text]);
        assert!(!rendered.iter().any(|arg| arg.contains("missing.sock")));

        // 默认档：~/.docker 照常遮蔽，容器 socket 一律不重绑（AF_UNIX 全拒）。
        let spec = BwrapSandboxSpec {
            workspace_root: &workspace,
            home: &home,
            tmpdir: &tmpdir,
            network: NetworkPolicy::LoopbackOnly,
            allow_vcs_credentials: false,
            var_run_is_symlink: true,
            resolv_conf_rebind: None,
            container_sockets: &sockets,
        };
        let rendered = bwrap_args_strings(&generate_bwrap_args(&spec));
        assert_has_arg(&rendered, &["--tmpfs", &docker]);
        assert_not_has_arg(&rendered, &["--bind", &socket_text, &socket_text]);
    }

    /// 只装了 docker CLI（无引擎 socket）时：仍需放行状态目录（login / context 不依赖 daemon），
    /// 但不得出现任何 socket 放行。
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn container_cli_state_allowed_in_network_tier_without_engine_socket() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        let tmpdir = dir.path().join("tmp");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tmpdir).unwrap();
        std::fs::create_dir_all(home.join(".docker")).unwrap();

        let profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox-cli"),
            "test-container-cli",
            NetworkPolicy::OutboundEnabled,
            false,
        )
        .unwrap();
        let text = std::fs::read_to_string(&profile.path).unwrap();
        assert!(text.contains(
            "(allow file-read* (subpath (string-append (param \"HOME\") \"/.docker\")))"
        ));
        // 本机可能真的存在 /var/run/docker.sock（如 OrbStack），故只对临时 HOME 下的 socket
        // 做负向断言：本用例的 HOME 里没有引擎。
        assert!(!text.contains(&home.join(".orbstack/run/docker.sock").display().to_string()));
    }

    /// 容器引擎 socket 只在网络档放行，且只列实际存在的 socket（默认档保持 AF_UNIX 全拒）。
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn container_engine_socket_rules_are_network_tier_only_and_require_presence() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        let tmpdir = dir.path().join("tmp");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tmpdir).unwrap();
        std::fs::create_dir_all(home.join(".orbstack/run")).unwrap();
        std::fs::write(home.join(".orbstack/run/docker.sock"), "").unwrap();

        let socket_rule = format!(
            "(allow network-outbound (remote unix-socket (literal \"{}\")))",
            home.join(".orbstack/run/docker.sock").display()
        );
        let network_profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox-net"),
            "test-container-net",
            NetworkPolicy::OutboundEnabled,
            false,
        )
        .unwrap();
        let network_text = std::fs::read_to_string(&network_profile.path).unwrap();
        assert!(
            network_text.contains(&socket_rule),
            "网络档应放行实际存在的容器 socket: {network_text}"
        );
        assert!(
            network_text.contains(
                "(allow file-read* (subpath (string-append (param \"HOME\") \"/.docker\")))"
            ),
            "网络档应放行 docker CLI 状态目录读取: {network_text}"
        );
        assert!(
            network_text.contains(
                "(allow file-write* (subpath (string-append (param \"HOME\") \"/.docker\")))"
            ),
            "网络档应放行 docker CLI 状态目录写入: {network_text}"
        );

        let default_profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox-default"),
            "test-container-default",
            NetworkPolicy::LoopbackOnly,
            false,
        )
        .unwrap();
        let default_text = std::fs::read_to_string(&default_profile.path).unwrap();
        assert!(
            !default_text.contains("docker.sock"),
            "默认档不得放行容器 socket: {default_text}"
        );
        assert!(!default_text.contains(
            "(allow file-read* (subpath (string-append (param \"HOME\") \"/.docker\")))"
        ));
        assert!(!default_text.contains(
            "(allow file-write* (subpath (string-append (param \"HOME\") \"/.docker\")))"
        ));
    }

    /// 网络档（network: true 声明命令）：IP 网络放行 + TLS/DNS mach 白名单，
    /// 但 AF_UNIX 仅定点放行系统解析器（mDNSResponder，域名解析硬依赖）与容器引擎
    /// daemon socket；写边界与凭据 deny 与默认档一致。
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn network_policy_profile_enables_network_with_same_write_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        let tmpdir = dir.path().join("tmp");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tmpdir).unwrap();
        let profile = generate_sandbox_profile(
            &workspace,
            &dir.path().join("home"),
            &tmpdir,
            &dir.path().join("sandbox"),
            "test-net",
            NetworkPolicy::OutboundEnabled,
            false,
        )
        .unwrap();
        let text = std::fs::read_to_string(&profile.path).unwrap();
        // IP 网络放行，但不能用通配 (allow network*)——那会把 AF_UNIX 一起放开
        // （Docker daemon / ssh-agent 等宿主守护进程 unix socket 等价宿主权限操作面）。
        assert!(!text.contains("(allow network*)\n"), "禁止通配网络放行");
        for rule in [
            "(allow network-outbound (remote ip \"*:*\"))",
            "(allow network-inbound (local ip \"*:*\"))",
            "(allow network-bind (local ip \"*:*\"))",
            // 系统 DNS 解析走 mDNSResponder 的 unix socket，是唯一放行的 AF_UNIX 例外
            "(allow network-outbound (remote unix-socket (literal \"/private/var/run/mDNSResponder\")))",
        ] {
            assert!(text.contains(rule), "网络档应含规则: {rule}");
        }
        for service in ["com.apple.trustd", "com.apple.ocspd", "com.apple.SecurityServer"] {
            assert!(text.contains(service), "网络档应放行 TLS 服务: {service}");
        }
        // 写边界不变：只有工作区 + 临时目录可写
        assert!(!text.contains("(allow file-write* (regex #\"^/\"))"));
        assert!(text.contains("(allow file-write* (subpath (param \"WORKSPACE\")))"));
        // 凭据 deny 不变
        assert!(text.contains("(deny file-read* (subpath (string-append (param \"HOME\") \"/.ssh\")))"));
    }

    /// VCS 认证命令（git push/pull/fetch/clone 等）需要读取 SSH 私钥与 git 文件型凭据。
    /// 当 `allow_vcs_credentials=true` 时，profile 应在 deny 之后精确放行
    /// `~/.ssh` 与 `~/.config/git/credentials`，且实测沙箱内可读取 SSH 目录。
    #[cfg(target_os = "macos")]
    #[test]
    fn vcs_credentials_profile_allows_ssh_and_git_credentials() {
        assert!(
            sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("home")).unwrap();
            dir.path().join("home")
        })
        .unwrap();
        let workspace = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("ws")).unwrap();
            dir.path().join("ws")
        })
        .unwrap();
        let tmpdir = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("tmp")).unwrap();
            dir.path().join("tmp")
        })
        .unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh/id_ed25519"), "ssh-private-key-stub\n").unwrap();

        let profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "vcs-creds",
            NetworkPolicy::OutboundEnabled,
            true,
        )
        .unwrap();
        let text = std::fs::read_to_string(&profile.path).unwrap();
        // allow 规则必须位于 deny 之后（last-match-wins），否则不会生效。
        let ssh_deny_pos = text
            .find("(deny file-read* (subpath (string-append (param \"HOME\") \"/.ssh\")))")
            .expect("profile 应含 .ssh deny");
        let ssh_allow_pos = text
            .find("(allow file-read* (subpath (string-append (param \"HOME\") \"/.ssh\")))")
            .expect("VCS 凭据 profile 应放行 .ssh");
        assert!(
            ssh_allow_pos > ssh_deny_pos,
            "allow .ssh 规则必须位于 deny 之后"
        );
        assert!(text.contains(
            "(allow file-read* (literal (string-append (param \"HOME\") \"/.config/git/credentials\")))"
        ));

        // 实测：沙箱内可列出并读取 ~/.ssh 私钥文件
        let output = std::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-D")
            .arg(format!("WORKSPACE={}", workspace.display()))
            .arg("-D")
            .arg(format!("HOME={}", home.display()))
            .arg("-D")
            .arg(format!("TMPDIR={}", tmpdir.display()))
            .arg("-f")
            .arg(&profile.path)
            .arg("/bin/bash")
            .arg("-c")
            .arg(format!("cat {}/.ssh/id_ed25519", home.display()))
            .output()
            .expect("spawn sandbox-exec");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "VCS 凭据 profile 内应能读取 SSH 私钥: {stdout} {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains("ssh-private-key-stub"));

        // 非 VCS 凭据目录仍应保持拒绝（以 .aws 为例）
        std::fs::create_dir_all(home.join(".aws")).unwrap();
        std::fs::write(home.join(".aws/credentials"), "[default]\n").unwrap();
        let aws_output = std::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-D")
            .arg(format!("WORKSPACE={}", workspace.display()))
            .arg("-D")
            .arg(format!("HOME={}", home.display()))
            .arg("-D")
            .arg(format!("TMPDIR={}", tmpdir.display()))
            .arg("-f")
            .arg(&profile.path)
            .arg("/bin/bash")
            .arg("-c")
            .arg(format!("cat {}/.aws/credentials", home.display()))
            .output()
            .expect("spawn sandbox-exec");
        assert!(
            !aws_output.status.success(),
            ".aws 凭据在非 VCS 凭据 profile 内仍应被拒绝"
        );
    }

    /// 实测回归：两跳派发工具链（Apple CLT shim / rustup 代理）在生成的 profile 内
    /// 必须可执行（曾经按 PATH 目录推导 exec 白名单时全部 Operation not permitted），
    /// 同时网络与工作区外写入两个硬边界必须保持拒绝；本机回环必须放行（dev server
    /// 是 SandboxSafe 命令的最常见形态）。
    #[cfg(target_os = "macos")]
    #[test]
    fn sandbox_profile_executes_two_hop_toolchains_and_keeps_boundaries() {
        assert!(
            sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let workspace = dir.path().join("ws");
        let tmpdir = dir.path().join("tmp");
        for path in [&home, &workspace, &tmpdir] {
            std::fs::create_dir_all(path).unwrap();
        }
        let profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "smoke",
            NetworkPolicy::LoopbackOnly,
            false,
        )
        .unwrap();
        let run_in_profile = |program: &str, args: &[&str]| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .arg("-D")
                .arg(format!("WORKSPACE={}", workspace.display()))
                .arg("-D")
                .arg(format!("HOME={}", home.display()))
                .arg("-D")
                .arg(format!("TMPDIR={}", tmpdir.display()))
                .arg("-f")
                .arg(&profile.path)
                .arg(program)
                .args(args)
                .output()
                .expect("spawn sandbox-exec")
        };
        // /usr/bin/git 是 Apple shim 二进制：第二跳 exec CLT 真实 git。
        let git = run_in_profile("/usr/bin/git", &["--version"]);
        assert!(
            git.status.success(),
            "git 两跳 exec 应可用: {}",
            String::from_utf8_lossy(&git.stderr)
        );
        // rustup 代理：~/.cargo/bin/cargo 第二跳 exec toolchain 内真实 cargo（存在才测）。
        let user_cargo = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".cargo/bin/cargo"))
            .filter(|path| path.is_file());
        if let Some(cargo) = user_cargo {
            let cargo = run_in_profile(cargo.to_str().unwrap(), &["--version"]);
            assert!(
                cargo.status.success(),
                "cargo 两跳 exec 应可用: {}",
                String::from_utf8_lossy(&cargo.stderr)
            );
        }
        // 硬边界回归：外网仍禁（DNS 解析/TCP 连接被拒 → curl 非零退出）。
        let curl = run_in_profile("/usr/bin/curl", &["--max-time", "3", "https://example.com"]);
        assert!(
            !curl.status.success(),
            "沙箱内网络必须仍被拒绝（exit {:?}）",
            curl.status.code()
        );
        // 回环放行回归：连 127.0.0.1 无人监听端口应得「Connection refused」（内核
        // 层正常拒绝），而非 seatbelt 的 EPERM——证明回环不在 deny 面内（dev server 依赖）。
        let loopback = run_in_profile(
            "/bin/bash",
            &["-c", "echo x > /dev/tcp/127.0.0.1/1 2>&1 || true"],
        );
        let loopback_text = format!(
            "{}{}",
            String::from_utf8_lossy(&loopback.stdout),
            String::from_utf8_lossy(&loopback.stderr)
        );
        assert!(
            !loopback_text.contains("Operation not permitted"),
            "回环连接不应被 seatbelt 拒绝: {loopback_text}"
        );
        // 硬边界回归：工作区（与 HOME）外写入被拒。
        let marker = home.join("escape-marker");
        let write_escape = run_in_profile(
            "/bin/bash",
            &["-c", &format!("echo x > {}", marker.display())],
        );
        assert!(
            !write_escape.status.success(),
            "沙箱内写入 HOME 必须仍被拒绝"
        );
        assert!(!marker.exists());
    }

    /// 网络档实测回归：AF_UNIX 不随 IP 放行一起放开（通配 (allow network*) 的教训）
    /// ——unix socket 可直连宿主守护进程（Docker daemon / ssh-agent），必须拒绝；
    /// 回环 TCP 不受影响（无需外网即可验证）。
    #[cfg(target_os = "macos")]
    #[test]
    fn network_profile_denies_unix_sockets_while_allowing_ip() {
        assert!(
            sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let workspace = dir.path().join("ws");
        let tmpdir = dir.path().join("tmp");
        for path in [&home, &workspace, &tmpdir] {
            std::fs::create_dir_all(path).unwrap();
        }
        let profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "smoke-net",
            NetworkPolicy::OutboundEnabled,
            false,
        )
        .unwrap();
        let run = |program: &str, args: &[&str]| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .arg("-D")
                .arg(format!("WORKSPACE={}", workspace.display()))
                .arg("-D")
                .arg(format!("HOME={}", home.display()))
                .arg("-D")
                .arg(format!("TMPDIR={}", tmpdir.display()))
                .arg("-f")
                .arg(&profile.path)
                .arg(program)
                .args(args)
                .output()
                .expect("spawn sandbox-exec")
        };
        // AF_UNIX bind 在网络档内仍必须 EPERM（路径经 validate_profile_path 字符白名单，无引号注入面）
        let unix_probe = run(
            "/usr/bin/python3",
            &["-c", &format!(
                "import socket\ns = socket.socket(socket.AF_UNIX)\ntry:\n    s.bind('{}')\n    print('UNIX-BIND-OK')\nexcept PermissionError:\n    print('UNIX-DENIED')\n",
                tmpdir.join("n.sock").display(),
            )],
        );
        let text = String::from_utf8_lossy(&unix_probe.stdout);
        assert!(
            text.contains("UNIX-DENIED"),
            "网络档内 AF_UNIX 必须被拒绝: {text}{}",
            String::from_utf8_lossy(&unix_probe.stderr)
        );
        // 回环 TCP 连接（IP 放行）：无人监听端口应得 ConnectionRefused 而非 EPERM
        let loop_probe = run(
            "/usr/bin/python3",
            &["-c", "\
import socket
s = socket.socket(); s.settimeout(2)
try:
    s.connect(('127.0.0.1', 1)); print('LOOP-CONNECTED')
except ConnectionRefusedError:
    print('LOOP-REFUSED')
except PermissionError:
    print('LOOP-EPERM')
"],
        );
        let text = String::from_utf8_lossy(&loop_probe.stdout);
        assert!(
            text.contains("LOOP-REFUSED") || text.contains("LOOP-CONNECTED"),
            "网络档内回环 TCP 不应被 seatbelt 拒绝: {text}{}",
            String::from_utf8_lossy(&loop_probe.stderr)
        );
    }

    /// 写边界硬化（P0-1）：锚点/fcntl/xpc deny 恒在且位于全部 allow 之后；
    /// workspace == HOME 形态下凭据子路径/凭据文件/敏感目录全部获得写保护，
    /// 覆盖 SubpathParam / LiteralParam / Concrete 三种规则形态。
    #[test]
    fn write_boundary_hardening_covers_workspace_inside_deny_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        let tmpdir = dir.path().join("tmp");
        std::fs::create_dir_all(&tmpdir).unwrap();
        // workspace == home：凭据载体与敏感目录全部落在工作区内
        let profile = generate_sandbox_profile(
            &home,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "hardening-ws",
            NetworkPolicy::LoopbackOnly,
            false,
        )
        .unwrap();
        let text = std::fs::read_to_string(&profile.path).unwrap();
        // 恒在的全局硬化
        assert!(
            text.contains("(deny mach-lookup (xpc-service-name-prefix \"\"))"),
            "应含 XPC service lookup deny"
        );
        assert!(
            text.contains("(deny system-fcntl (fcntl-command 80 110))"),
            "应含 fcntl 80/110 deny"
        );
        for anchor in [
            "(deny file-write-unlink (require-all (literal (param \"WORKSPACE\")) (vnode-type DIRECTORY)))",
            "(deny file-write-unlink (require-all (literal (param \"TMPDIR\")) (vnode-type DIRECTORY)))",
            "(deny file-write-unlink (require-all (literal \"/private/tmp\") (vnode-type DIRECTORY)))",
            "(deny file-write-unlink (require-all (literal \"/private/var/tmp\") (vnode-type DIRECTORY)))",
        ] {
            assert!(text.contains(anchor), "应含写根锚点 deny: {anchor}");
        }
        // workspace == HOME：三种形态的写保护全部出现
        assert!(text.contains(
            "(deny file-write* (subpath (string-append (param \"HOME\") \"/.ssh\")))"
        ));
        assert!(text.contains(
            "(deny file-write* (literal (string-append (param \"HOME\") \"/.npmrc\")))"
        ));
        let home_canonical = std::fs::canonicalize(&home).unwrap();
        assert!(
            text.contains(&format!(
                "(deny file-write* (subpath \"{}\"))",
                home_canonical.join("Library/Mail").display()
            )),
            "敏感目录（Concrete 形态）应获得写保护",
        );
        // 硬化段必须位于工作区写 allow 之后（last-match-wins 下 deny 才能生效）
        let allow_pos = text
            .find("(allow file-write* (subpath (param \"WORKSPACE\")))")
            .unwrap();
        let hardening_pos = text
            .find("(deny file-write* (subpath (string-append (param \"HOME\") \"/.ssh\")))")
            .unwrap();
        assert!(hardening_pos > allow_pos, "写保护 deny 必须在写 allow 之后");
    }

    /// 祖先链 unlink deny：工作区内的额外 deny 目录（嵌套路径）必须把从自身到
    /// 工作区根之间的每一级中间目录都钉死（rename/rmdir 均被拒）；工作区根本身
    /// 由锚点 deny 覆盖、不产生祖先规则；工作区外路径不受影响。
    #[test]
    fn write_boundary_hardening_pins_ancestor_chain_for_nested_deny_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join("dev/proj/nested")).unwrap();
        let workspace = std::fs::canonicalize(home.join("dev/proj")).unwrap();
        let tmpdir = dir.path().join("tmp");
        std::fs::create_dir_all(&tmpdir).unwrap();
        std::env::set_var("AXIOM_SANDBOX_EXTRA_DENY_DIRS", "dev/proj/nested/vault");
        let profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "hardening-ancestor",
            NetworkPolicy::LoopbackOnly,
            false,
        );
        std::env::remove_var("AXIOM_SANDBOX_EXTRA_DENY_DIRS");
        let text = std::fs::read_to_string(&profile.unwrap().path).unwrap();
        let canonical_home = std::fs::canonicalize(&home).unwrap();
        let vault = canonical_home.join("dev/proj/nested/vault");
        let nested = canonical_home.join("dev/proj/nested");
        assert!(
            text.contains(&format!(
                "(deny file-write* (subpath \"{}\"))",
                vault.display()
            )),
            "工作区内的额外 deny 目录应获得子树写保护: {text}"
        );
        assert!(
            text.contains(&format!(
                "(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal \"{}\")))",
                nested.display()
            )),
            "受保护目录的中间祖先目录应被 unlink deny 钉死"
        );
        // 工作区根本身由锚点 deny 覆盖，不产生祖先 unlink 规则
        assert!(!text.contains(&format!(
            "(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal \"{}\")))",
            workspace.display()
        )));
        // 工作区外的凭据路径不产生写保护（workspace != HOME）
        assert!(!text.contains(
            "(deny file-write* (subpath (string-append (param \"HOME\") \"/.ssh\")))"
        ));
    }

    /// 端到端回归（workspace == HOME 形态，最尖锐的硬化场景）：读取 deny 的凭据
    /// 路径必须无法经 rename 逃逸后读取；普通工作区写入不受影响；工作区根本身
    /// 不可被 rename/rmdir（锚点 deny）。
    #[test]
    fn sandbox_hardening_blocks_rename_escape_of_read_denied_credentials() {
        assert!(
            sandbox_available(),
            "seatbelt sandbox unavailable; refusing to silently skip sandbox regression test"
        );
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("home/.ssh")).unwrap();
            dir.path().join("home")
        })
        .unwrap();
        std::fs::write(home.join(".ssh/id_ed25519"), "ssh-private-key-stub\n").unwrap();
        let tmpdir = std::fs::canonicalize({
            std::fs::create_dir_all(dir.path().join("tmp")).unwrap();
            dir.path().join("tmp")
        })
        .unwrap();
        let profile = generate_sandbox_profile(
            &home,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "hardening-e2e",
            NetworkPolicy::LoopbackOnly,
            false,
        )
        .unwrap();
        let run = |shell: &str| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .arg("-D")
                .arg(format!("WORKSPACE={}", home.display()))
                .arg("-D")
                .arg(format!("HOME={}", home.display()))
                .arg("-D")
                .arg(format!("TMPDIR={}", tmpdir.display()))
                .arg("-f")
                .arg(&profile.path)
                .arg("/bin/bash")
                .arg("-c")
                .arg(shell)
                .output()
                .expect("spawn sandbox-exec")
        };
        // 普通工作区写入放行（硬化不得误伤常规工作流；命令用绝对路径，
        // 测试进程 cwd 在 src-tauri，相对路径会落到工作区外）
        assert!(
            run(format!("echo x > {}/ok.txt", home.display()).as_str())
                .status
                .success(),
            "工作区普通写入应放行"
        );
        // rename 逃逸路径 1：把凭据文件移出 deny 路径后读取——源 vnode 上的写 deny 拦截
        let escape = run(format!(
            "mv {}/.ssh/id_ed25519 {}/escaped.key",
            home.display(),
            home.display()
        )
        .as_str());
        assert!(
            !escape.status.success(),
            "凭据文件 rename 出 deny 子树必须被拒"
        );
        assert!(!home.join("escaped.key").exists());
        // rename 逃逸路径 2：受保护目录整体改名
        assert!(
            !run(format!("mv {}/.ssh {}/ssh2", home.display(), home.display()).as_str())
                .status
                .success(),
            "受保护目录整体 rename 必须被拒"
        );
        // 读取 deny 不变
        assert!(
            !run(format!("cat {}/.ssh/id_ed25519", home.display()).as_str())
                .status
                .success(),
            "凭据读取仍应被 deny"
        );
        // 写根锚点：rename 非空目录在 POSIX 语义下本可成功，必须由锚点 deny 拦截
        assert!(
            !run(format!("mv {} renamed-home", home.display()).as_str())
                .status
                .success(),
            "工作区根 rename 必须被锚点 deny 拦截"
        );
        assert!(home.exists(), "工作区根必须仍然存在");
    }

    #[test]
    fn rejects_workspace_path_with_invalid_characters() {
        let dir = tempfile::tempdir().unwrap();
        let result = generate_sandbox_profile(
            Path::new("/tmp/semi;colon"),
            &dir.path().join("home"),
            &dir.path().join("tmp"),
            &dir.path().join("sandbox"),
            "t",
            NetworkPolicy::LoopbackOnly,
            false,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("workspace root"));
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn rejects_relative_home_path() {
        let dir = tempfile::tempdir().unwrap();
        let result = generate_sandbox_profile(
            &dir.path().join("ws"),
            Path::new("relative/home"),
            &dir.path().join("tmp"),
            &dir.path().join("sandbox"),
            "t",
            NetworkPolicy::LoopbackOnly,
            false,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("home"));
    }

    #[test]
    fn denies_sensitive_user_directories_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let deny = sensitive_read_deny_dirs(&home, &workspace);
        let home_canonical = std::fs::canonicalize(&home).unwrap();
        // 平台敏感名单以 SENSITIVE_READ_DENY_SUBPATHS 为单一事实源（macOS 为
        // Library/* + .Trash，Linux 为 XDG Trash/keyrings，见常量处注释）：工作区
        // 不落在任何敏感目录内时不跳过任何条目，deny 列表与常量逐项一致。
        let expected: Vec<std::path::PathBuf> = SENSITIVE_READ_DENY_SUBPATHS
            .iter()
            .map(|sub| home_canonical.join(sub))
            .collect();
        assert_eq!(deny, expected, "敏感目录 deny 名单与常量不一致");
        // 个人文档类目录不再默认 deny（对齐 codex：只 deny 凭据与通讯隐私）
        for sub in ["Documents", "Desktop", "Downloads", "Library/Application Support"] {
            assert!(
                !deny.contains(&home_canonical.join(sub)),
                "个人目录不应再被默认 deny: {sub}",
            );
        }
    }

    // 「其余目录仍保留」断言依赖名单至少两项——Windows 名单仅 .axiom 一项，
    // 该用例只在 macOS/Linux 上有意义。
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn skips_sensitive_dir_that_contains_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        // 取名单首项作为工作区所在敏感目录（macOS 为 .axiom，Linux 亦然；跳过
        // 逻辑对条目无差别），第二项验证「其余目录仍保留」。
        let containing = SENSITIVE_READ_DENY_SUBPATHS[0];
        let remaining = SENSITIVE_READ_DENY_SUBPATHS[1];
        std::fs::create_dir_all(home.join(containing)).unwrap();
        // 工作区在仍被 deny 的敏感目录内：该目录必须被跳过，否则沙箱内工作区
        // 读取全失败。生产环境 workspace_root 是 canonical 的（validate_request），
        // 这里同样 canonical 化。
        let workspace = home.join(containing).join("proj");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = std::fs::canonicalize(&workspace).unwrap();
        let deny = sensitive_read_deny_dirs(&home, &workspace);
        assert!(
            !deny.iter().any(|p| p.ends_with(containing)),
            "工作区所在敏感目录必须被跳过: {containing}",
        );
        // 其余目录仍保留
        assert!(
            deny.iter().any(|p| p.ends_with(remaining)),
            "其余敏感目录仍应保留: {remaining}",
        );
    }

    #[test]
    fn read_deny_helper_blocks_credential_and_axiom_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        for sub in [
            ".ssh",
            ".aws",
            ".azure",
            ".gnupg",
            ".docker",
            ".kube",
            ".config/gh",
            ".config/gcloud",
            ".config/opencode",
            ".codex",
            ".claude",
            ".axiom",
            ".cargo",
            ".config/git",
            // 平台敏感目录（SENSITIVE_READ_DENY_SUBPATHS 按 OS 取名单）：
            // macOS 为 Library/*，Linux 为 XDG Trash/keyrings。
            #[cfg(target_os = "macos")]
            "Library/Mail",
            #[cfg(target_os = "linux")]
            ".local/share/Trash",
            #[cfg(target_os = "linux")]
            ".local/share/keyrings",
        ] {
            std::fs::create_dir_all(home.join(sub)).unwrap();
        }
        for file in [
            ".npmrc",
            ".netrc",
            ".git-credentials",
            ".cargo/credentials",
            ".config/git/credentials",
        ] {
            std::fs::write(home.join(file), "token").unwrap();
        }
        let home_canonical = std::fs::canonicalize(&home).unwrap();

        for denied in [
            home_canonical.join(".ssh/id_ed25519"),
            home_canonical.join(".aws/credentials"),
            home_canonical.join(".azure/accessTokens.json"),
            home_canonical.join(".gnupg/pubring.kbx"),
            home_canonical.join(".docker/config.json"),
            home_canonical.join(".kube/config"),
            home_canonical.join(".config/gh/hosts.yml"),
            home_canonical.join(".config/gcloud/credentials.db"),
            home_canonical.join(".config/opencode/auth.json"),
            home_canonical.join(".codex/auth.json"),
            home_canonical.join(".claude/.credentials.json"),
            home_canonical.join(".axiom/axiom.db"),
            #[cfg(target_os = "macos")]
            home_canonical.join("Library/Mail"),
            #[cfg(target_os = "linux")]
            home_canonical.join(".local/share/Trash/files/note.txt"),
            #[cfg(target_os = "linux")]
            home_canonical.join(".local/share/keyrings/default.keyring"),
            home_canonical.join(".npmrc"),
            home_canonical.join(".netrc"),
            home_canonical.join(".git-credentials"),
            home_canonical.join(".cargo/credentials"),
            home_canonical.join(".config/git/credentials"),
        ] {
            assert!(
                sensitive_read_denied(&home, &denied, &[]),
                "应 deny: {}",
                denied.display()
            );
        }
        // 个人文档类目录不 deny（与沙箱读取策略同一哲学）
        assert!(!sensitive_read_denied(
            &home,
            &home_canonical.join("Documents/notes.md"),
            &[],
        ));
        // ~/.gitconfig 不 deny：git 在沙箱内需读全局配置（user.name/email 等），
        // 其执行面（hooksPath/credential.helper 等）已由 git_config.rs 中和。
        assert!(!sensitive_read_denied(
            &home,
            &home_canonical.join(".gitconfig"),
            &[],
        ));
    }

    #[test]
    fn read_deny_helper_exempts_authorized_workspace_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        // 工作区落在 deny 目录（.axiom）内：其内容经 workspace 豁免可读；
        // 未授权时（空 roots）同一路径仍 deny。
        let workspace = home.join(".axiom/workspaces/demo");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("notes.md"), "hello").unwrap();
        let workspace = std::fs::canonicalize(&workspace).unwrap();
        let file = workspace.join("notes.md");
        assert!(sensitive_read_denied(&home, &file, &[]));
        assert!(!sensitive_read_denied(&home, &file, &[workspace]));
    }

    #[cfg(unix)]
    #[test]
    fn read_deny_helper_resolves_home_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real-home");
        std::fs::create_dir_all(real.join(".ssh")).unwrap();
        std::fs::write(real.join(".ssh/id_ed25519"), "key").unwrap();
        let home_link = dir.path().join("home-link");
        std::os::unix::fs::symlink(&real, &home_link).unwrap();
        // 传入非 canonical home（经 symlink）：判定仍按解析后位置命中。
        let canonical = std::fs::canonicalize(home_link.join(".ssh/id_ed25519")).unwrap();
        assert!(sensitive_read_denied(&home_link, &canonical, &[]));
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn parses_extra_deny_dirs_and_skips_invalid_or_workspace_containing() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let workspace = home.join("dev/ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = std::fs::canonicalize(&workspace).unwrap();
        let parsed = parse_extra_deny_dirs("Notes: Library/Developer :dev/ws:bad;path", &home, &workspace);
        // Notes 与 Library/Developer 生效（trim 后）
        assert!(parsed.iter().any(|p| p.ends_with("Notes")));
        assert!(parsed.iter().any(|p| p.ends_with("Library/Developer")));
        // 工作区所在目录被跳过
        assert!(!parsed.iter().any(|p| p.ends_with("dev/ws")));
        // 含特殊字符（分号）的路径被 validate_profile_path 拒绝
        assert!(!parsed.iter().any(|p| p.ends_with("bad;path")));
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn profile_contains_sensitive_dir_deny_rules() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let tmpdir = dir.path().join("tmp");
        std::fs::create_dir_all(&tmpdir).unwrap();
        let profile = generate_sandbox_profile(
            &workspace,
            &home,
            &tmpdir,
            &dir.path().join("sandbox"),
            "test-deny",
            NetworkPolicy::LoopbackOnly,
            false,
        )
        .unwrap();
        let text = std::fs::read_to_string(&profile.path).unwrap();
        let home_canonical = std::fs::canonicalize(&home).unwrap();
        assert!(
            text.contains(&format!(
                "(deny file-read* (subpath \"{}\"))",
                home_canonical.join(".axiom").display()
            )),
            "profile 应含 .axiom deny",
        );
        // 凭据子路径（含其它 Agent 配置根）以 (param "HOME") 拼接形式出现在 profile
        for sub in [".ssh", ".aws", ".kube", ".docker", ".config/gh", ".codex", ".claude"] {
            assert!(
                text.contains(&format!(
                    "(deny file-read* (subpath (string-append (param \"HOME\") \"/{sub}\")))"
                )),
                "profile 应含凭据子路径 deny: {sub}",
            );
        }
        // 凭据精确文件（literal deny）以 (param "HOME") 拼接形式出现在 profile
        for file in [".npmrc", ".netrc", ".git-credentials", ".config/git/credentials"] {
            assert!(
                text.contains(&format!(
                    "(deny file-read* (literal (string-append (param \"HOME\") \"/{file}\")))"
                )),
                "profile 应含凭据文件 deny: {file}",
            );
        }
        // 个人文档类目录不再默认 deny
        assert!(
            !text.contains(&format!(
                "(deny file-read* (subpath \"{}\"))",
                home_canonical.join("Documents").display()
            )),
            "profile 不应再 deny Documents",
        );
    }
}
