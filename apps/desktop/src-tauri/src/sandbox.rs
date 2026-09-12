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
    "docker pull",
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

/// `/usr/bin/sandbox-exec` 可用性探测：不止检查文件存在，而是**功能性探测**——
/// 用最小 profile 实际跑一次 `/usr/bin/true`。sandbox-exec 处于弃用状态（Apple
/// 标记 deprecated，Chrome/codex 仍在用），未来 macOS 更新若移除或改变其行为，
/// 文件存在性检查会漏报；这里让它提前暴露为明确失败（fail-closed）。结果按进程
/// 缓存——探测要 fork+exec，不能每条命令都跑。
pub(crate) fn sandbox_available() -> bool {
    static OPERATIONAL: OnceLock<bool> = OnceLock::new();
    *OPERATIONAL.get_or_init(|| {
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
    })
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
#[derive(Debug, Clone)]
struct SandboxDenialEntry {
    pid: i32,
    operation: String,
    path: String,
}

/// 从日志行提取 `name(pid) deny(n) op path` 尾部。正则从行内任意位置起匹配，
/// 兼容 duplicate-report 前缀与不同 --style 的行首格式；不匹配（无 deny 或
/// 非目标消息）返回 None。
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
    fn terminate(&mut self) {
        let process_id = self.child.id() as i32;
        unsafe {
            libc::kill(process_id, libc::SIGTERM);
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
         ;; 再按档位放行（last-match-wins，allow 在 deny 之后）。AF_UNIX 保持拒绝：\n\
         ;; unix socket 可直连宿主守护进程（ssh-agent、Docker daemon——后者等价于\n\
         ;; 以宿主权限执行任意操作），不设路径白名单不放行。\n\
         (deny network*)\n",
    );
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

/// 敏感目录（HOME 相对）：沙箱内命令**读取**全盘开放时，这些目录承载凭据或通讯隐私，
/// 纳入默认 deny 名单。定位是纵深防御的第二道闸——第一道闸仍是逐次审批对话框展示的
/// 命令串。对齐 codex 的哲学：**不 deny 个人文档类目录**（Documents/Desktop/Downloads
/// 等是合法工作素材，读它们经逐次审批授权即可），只 deny「泄露即失守」的凭据与通讯
/// 数据面。工作区位于某目录内部时该目录会被跳过（否则用户把工作区放在其内会导致
/// 沙箱内读取全部失败）；想收紧的用户可用 `AXIOM_SANDBOX_EXTRA_DENY_DIRS` 加回。
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
const SENSITIVE_READ_CREDENTIAL_SUBPATHS: &[&str] = &[".ssh", ".aws", ".gnupg"];
/// 凭据载体（HOME 相对）：精确文件形态（literal deny，不 deny 同名目录内容）。
const SENSITIVE_READ_CREDENTIAL_FILES: &[&str] = &[
    ".npmrc",
    ".cargo/credentials",
    ".config/git/credentials",
];

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
    fn rejects_invalid_profile_paths() {
        assert!(validate_profile_path(Path::new("relative/path"), "x").is_err());
        assert!(validate_profile_path(Path::new("/tmp/a b"), "x").is_ok());
        assert!(validate_profile_path(Path::new("/tmp/semi;colon"), "x").is_err());
        assert!(validate_profile_path(Path::new("/tmp/quote'"), "x").is_err());
        assert!(validate_profile_path(Path::new("/tmp/$(cmd)"), "x").is_err());
    }

    #[test]
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

    /// 网络档（network: true 声明命令）：IP 网络放行 + TLS/DNS mach 白名单，
    /// 但 AF_UNIX 仅定点放行系统解析器（mDNSResponder），写边界与凭据 deny 与默认档一致。
    #[test]
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
        // 凭据与通讯隐私面保留 deny
        for sub in [
            ".axiom",
            ".Trash",
            "Library/Keychains",
            "Library/Mail",
            "Library/Messages",
            "Library/Safari",
            "Library/Cookies",
            "Library/Calendars",
            "Library/Contacts",
        ] {
            assert!(
                deny.contains(&home_canonical.join(sub)),
                "缺少敏感目录 deny: {sub}",
            );
        }
        // 个人文档类目录不再默认 deny（对齐 codex：只 deny 凭据与通讯隐私）
        for sub in ["Documents", "Desktop", "Downloads", "Library/Application Support"] {
            assert!(
                !deny.contains(&home_canonical.join(sub)),
                "个人目录不应再被默认 deny: {sub}",
            );
        }
    }

    #[test]
    fn skips_sensitive_dir_that_contains_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join("Library/Mail")).unwrap();
        // 工作区在仍被 deny 的敏感目录（Library/Mail）内：该目录必须被跳过，
        // 否则沙箱内工作区读取全失败。生产环境 workspace_root 是 canonical 的
        // （validate_request），这里同样 canonical 化。
        let workspace = home.join("Library/Mail/proj");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = std::fs::canonicalize(&workspace).unwrap();
        let deny = sensitive_read_deny_dirs(&home, &workspace);
        assert!(!deny.iter().any(|p| p.ends_with("Library/Mail")));
        // 其余目录仍保留
        assert!(deny.iter().any(|p| p.ends_with("Library/Safari")));
    }

    #[test]
    fn read_deny_helper_blocks_credential_and_axiom_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        for sub in [".ssh", ".aws", ".gnupg", ".axiom", ".cargo", ".config/git", "Library/Mail"] {
            std::fs::create_dir_all(home.join(sub)).unwrap();
        }
        std::fs::write(home.join(".npmrc"), "token").unwrap();
        std::fs::write(home.join(".cargo/credentials"), "token").unwrap();
        std::fs::write(home.join(".config/git/credentials"), "token").unwrap();
        let home_canonical = std::fs::canonicalize(&home).unwrap();

        for denied in [
            home_canonical.join(".ssh/id_ed25519"),
            home_canonical.join(".aws/credentials"),
            home_canonical.join(".gnupg/pubring.kbx"),
            home_canonical.join(".axiom/axiom.db"),
            home_canonical.join("Library/Mail"),
            home_canonical.join(".npmrc"),
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
