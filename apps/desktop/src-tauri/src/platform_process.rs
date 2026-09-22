//! 跨平台进程组管理原语（workspace 命令 / 终端 / SSH / browser 共用）。
//!
//! macOS/Linux 用 POSIX 进程组语义：spawn 时 `process_group(0)`，终止时
//! `kill(-pgid, SIG)` 覆盖派生的辅助进程。Windows 无进程组等价物，首版映射：
//! - 树终止：`taskkill /T`（宽档投递 WM_CLOSE——GUI 程序如 Chrome 会响应，
//!   控制台程序多半无视，由调用侧既有的「宽限等待 → 强杀」节奏兜底 `/F`）；
//! - 存活探测：手写 `OpenProcess` + `GetExitCodeProcess` FFI（不引 windows-sys
//!   新依赖，与 computer_control.rs 手写 FFI 同一约定）；
//! - spawn 无进程组可设（no-op），Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）
//!   是更精确的等价物，选型评估见 docs/windows-support.md §0.2。

use std::process::Command;

/// 语义信号：平台各自映射——unix 为 SIGTERM/SIGKILL，Windows 为 Job 整树终止
///（无 Job 挂载时 taskkill 宽档 `/T` / 强档 `/T /F`）。调用侧不再触碰具体信号常量。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TreeSignal {
    /// 优雅终止：给进程清理落盘的机会（unix SIGTERM；Windows 无等价树信号，
    /// 仅无 Job 挂载的 GUI 进程经 taskkill /T 投递 WM_CLOSE 时有此语义）。
    Graceful,
    /// 强制终止（unix SIGKILL；Windows TerminateJobObject / taskkill /T /F）。
    Force,
}

/// 子进程派生进独立进程组（unix）。Windows 在此 no-op：进程组在 spawn 前不可
/// 挂载，由调用方在 spawn 后走 `attach_process_job`（Job Object 实测裁决取代
/// taskkill 兜底，见 signal_process_group 注释与 docs/windows-support.md §0.2）。
pub(crate) fn spawn_in_new_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

/// 向进程组发信号（unix 语义：组内全部进程；ESRCH → Ok(false)，其余错误上抛）。
/// Windows 语义：pid 若挂载了本进程派生的 Job Object 则 `TerminateJobObject`
/// 整树终止（实测 taskkill /T 对 msys fork 树不可靠：报 SUCCESS 但孙进程存活，
/// 握住输出管道直到自然退出）；无 Job 时回退 taskkill。
pub(crate) fn signal_process_group(process_id: u32, signal: TreeSignal) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let libc_signal = match signal {
            TreeSignal::Graceful => libc::SIGTERM,
            TreeSignal::Force => libc::SIGKILL,
        };
        let result = unsafe { libc::kill(-(process_id as i32), libc_signal) };
        if result == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(format!(
                "failed to signal process group {process_id}: {error}"
            ))
        }
    }
    #[cfg(windows)]
    {
        if let Some(job) = take_process_job(process_id) {
            return job.terminate();
        }
        if !process_alive(process_id) {
            return Ok(false);
        }
        let mut command = Command::new("taskkill");
        command.arg("/PID").arg(process_id.to_string()).arg("/T");
        if signal == TreeSignal::Force {
            command.arg("/F");
        }
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let status = command
            .status()
            .map_err(|error| format!("执行 taskkill 失败：{error}"))?;
        if status.success() {
            Ok(true)
        } else {
            // 宽档 taskkill 对控制台程序会报「无法在不开 /F 的情况下终止」：
            // 视为未送达（false），由调用侧的强杀兜底推进，不算执行错误。
            Ok(false)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (process_id, signal);
        Err("process group signaling is unsupported on this platform".into())
    }
}

/// spawn 后把子进程挂入 `KILL_ON_JOB_CLOSE` 的 Job Object（仅 windows：
/// 进程组的 Windows 等价物，取消/超时按 Job 整树终止，覆盖 msys fork 派生的
/// 全部子孙）。必须紧随 spawn 调用；子进程若已派生更早的子进程，该子进程不
/// 在 Job 内（竞态窗口极小，bash 初始化先于首个 fork）。
pub(crate) fn attach_process_job(process_id: u32) {
    #[cfg(windows)]
    {
        let job = match ProcessJob::attach(process_id) {
            Ok(job) => job,
            Err(error) => {
                // 挂载失败退化为 taskkill 兜底，不阻断命令执行。
                eprintln!("[platform_process] job attach failed: {error}");
                return;
            }
        };
        process_jobs()
            .lock()
            .ok()
            .map(|mut jobs| jobs.insert(process_id, job));
    }
    #[cfg(not(windows))]
    {
        let _ = process_id;
    }
}

/// 命令收尾时摘除并释放 Job（KILL_ON_JOB_CLOSE 会终止 Job 内残留的后台
/// 子进程——对齐 unix 组杀的清理语义）。返回是否确有挂载。
pub(crate) fn detach_process_job(process_id: u32) -> bool {
    #[cfg(windows)]
    {
        process_jobs()
            .lock()
            .ok()
            .map(|mut jobs| jobs.remove(&process_id).is_some())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = process_id;
        false
    }
}

#[cfg(windows)]
fn take_process_job(process_id: u32) -> Option<ProcessJob> {
    process_jobs().lock().ok()?.remove(&process_id)
}

#[cfg(windows)]
fn process_jobs() -> &'static std::sync::Mutex<std::collections::HashMap<u32, ProcessJob>> {
    static JOBS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, ProcessJob>>> =
        std::sync::OnceLock::new();
    JOBS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 组信号优先（覆盖派生的辅助进程）；pid 不是组长（历史版本 spawn 未设进程组）
/// 时回退单进程信号。错误吞掉——调用侧全部是清理/回收路径，尽力而为。
pub(crate) fn signal_process_tree_best_effort(process_id: u32, signal: TreeSignal) {
    #[cfg(unix)]
    {
        let libc_signal = match signal {
            TreeSignal::Graceful => libc::SIGTERM,
            TreeSignal::Force => libc::SIGKILL,
        };
        unsafe {
            if libc::kill(-(process_id as i32), libc_signal) != 0 {
                libc::kill(process_id as i32, libc_signal);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = signal_process_group(process_id, signal);
    }
}

/// pid 存活探测（`kill(pid, 0)` 的跨平台等价物）。
pub(crate) fn process_alive(process_id: u32) -> bool {
    // 三个平台分支互斥，各产出一个 `alive` 绑定；cfg 块不能作尾表达式使用
    // （块值会被当作语句丢弃，函数返回 () 导致编译失败）。
    #[cfg(unix)]
    let alive = {
        // EPERM 也说明进程还在（无权限发信号）；只有 ESRCH 是已死。
        // unsafe 块必须括起来——块后紧跟 || 会被解析为闭包起始。
        (unsafe { libc::kill(process_id as i32, 0) == 0 })
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    };
    #[cfg(windows)]
    let alive = {
        use windows_api::{
            CloseHandle, GetExitCodeProcess, OpenProcess, ERROR_ACCESS_DENIED,
            PROCESS_QUERY_LIMITED_INFORMATION, STILL_ACTIVE,
        };
        // SAFETY：句柄三件套为标准 kernel32 调用；GetExitCodeProcess 失败时按
        // 已死处理（保守——探测结果只影响清理与接管决策）。
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if handle.is_null() {
                // ERROR_ACCESS_DENIED：进程存在但无权查询（系统进程）——视为存活，
                // 对齐 unix EPERM=alive 的判定方向。
                return std::io::Error::last_os_error().raw_os_error()
                    == Some(ERROR_ACCESS_DENIED);
            }
            let mut exit_code: u32 = 0;
            let queried = GetExitCodeProcess(handle, &mut exit_code);
            let _ = CloseHandle(handle);
            queried != 0 && exit_code == STILL_ACTIVE
        }
    };
    #[cfg(not(any(unix, windows)))]
    let alive = {
        let _ = process_id;
        false
    };
    alive
}

/// 密码学安全随机字节填充：unix 读 `/dev/urandom`；Windows 用 `ProcessPrng`
/// （bcryptprimitives.dll，Win10+，Rust 标准库随机源同一来源），审批租赁
/// token 等安全敏感场景不得回退到时间戳类弱熵。
pub(crate) fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")
            .and_then(|mut urandom| urandom.read_exact(bytes))
            .map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        use windows_api::ProcessPrng;
        // SAFETY：ProcessPrng 是标准 BCrypt 原语包装，缓冲区指针/长度自洽。
        unsafe {
            if ProcessPrng(bytes.as_mut_ptr(), bytes.len()) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = bytes;
        Err("secure random is unsupported on this platform".into())
    }
}

#[cfg(windows)]
mod windows_api {
    pub(crate) type Handle = *mut core::ffi::c_void;
    /// PROCESS_QUERY_LIMITED_INFORMATION：仅需查询退出码，不申请终止权限——
    /// 探测系统进程时也能拿到有效句柄或明确的 ACCESS_DENIED。
    pub(crate) const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    /// PROCESS_SET_QUOTA | PROCESS_TERMINATE：AssignProcessToJobObject 的最低权限要求。
    pub(crate) const PROCESS_SET_QUOTA: u32 = 0x0100;
    pub(crate) const PROCESS_TERMINATE: u32 = 0x0001;
    /// GetExitCodeProcess 对仍存活进程返回的哨兵退出码。
    pub(crate) const STILL_ACTIVE: u32 = 259;
    pub(crate) const ERROR_ACCESS_DENIED: i32 = 5;
    /// JobObjectExtendedLimitInformation 信息类。
    pub(crate) const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    /// 句柄上最后一个引用关闭时终止 Job 内全部进程。
    pub(crate) const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[repr(C)]
    pub(crate) struct JobObjectBasicLimitInformation {
        pub(crate) per_process_user_time_limit: i64,
        pub(crate) per_job_user_time_limit: i64,
        pub(crate) limit_flags: u32,
        pub(crate) _pad: u32,
        pub(crate) minimum_working_set_size: usize,
        pub(crate) maximum_working_set_size: usize,
        pub(crate) active_process_limit: u32,
        pub(crate) _pad2: u32,
        pub(crate) affinity: usize,
        pub(crate) priority_class: u32,
        pub(crate) scheduling_class: u32,
    }

    #[repr(C)]
    pub(crate) struct IoCounters {
        pub(crate) read_operation_count: u64,
        pub(crate) write_operation_count: u64,
        pub(crate) other_operation_count: u64,
        pub(crate) read_transfer_count: u64,
        pub(crate) write_transfer_count: u64,
        pub(crate) other_transfer_count: u64,
    }

    #[repr(C)]
    pub(crate) struct JobObjectExtendedLimitInformation {
        pub(crate) basic: JobObjectBasicLimitInformation,
        pub(crate) io_info: IoCounters,
        pub(crate) process_memory_limit: usize,
        pub(crate) job_memory_limit: usize,
        pub(crate) peak_process_memory_used: usize,
        pub(crate) peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub(crate) fn OpenProcess(
            desiredaccess: u32,
            inherithandle: i32,
            processid: u32,
        ) -> Handle;
        pub(crate) fn GetExitCodeProcess(handle: Handle, exitcode: *mut u32) -> i32;
        pub(crate) fn CloseHandle(handle: Handle) -> i32;
        pub(crate) fn CreateJobObjectW(
            job_attributes: *mut core::ffi::c_void,
            name: *const u16,
        ) -> Handle;
        pub(crate) fn SetInformationJobObject(
            job: Handle,
            information_class: i32,
            information: *const JobObjectExtendedLimitInformation,
            length: u32,
        ) -> i32;
        pub(crate) fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        pub(crate) fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    }

    // raw-dylib：编译期自生成导入表，不依赖 Windows SDK 的 bcryptprimitives.lib
    // 导入库——新版 MSVC/SDK 镜像缺失该 lib 时 link.exe LNK1181（CI 实跑踩坑）；
    // std 对 ProcessPrng 的链接正是 raw-dylib 形态。
    #[link(name = "bcryptprimitives", kind = "raw-dylib")]
    extern "system" {
        /// 返回非零表示成功（BOOL 语义）。
        pub(crate) fn ProcessPrng(buffer: *mut u8, length: usize) -> i32;
    }
}

/// 已挂载命令进程树的 Job Object 句柄：TerminateJobObject 按 Job 整树终止；
/// Drop（CloseHandle）时 `KILL_ON_JOB_CLOSE` 收掉 Job 内残留的后台子进程——
/// 对齐 unix「命令结束回收进程组」的清理语义。
/// SAFETY：HANDLE 是进程全局内核句柄，跨线程 Close/Terminate 均合法。
#[cfg(windows)]
struct ProcessJob {
    handle: windows_api::Handle,
}

#[cfg(windows)]
unsafe impl Send for ProcessJob {}

#[cfg(windows)]
impl ProcessJob {
    fn attach(process_id: u32) -> Result<Self, String> {
        use windows_api::{
            AssignProcessToJobObject, CloseHandle, CreateJobObjectW, JobObjectBasicLimitInformation,
            JobObjectExtendedLimitInformation, OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
            SetInformationJobObject, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY：标准 kernel32 Job 三件套；结构体按 win32 布局全零初始化后仅
        // 置 KILL_ON_JOB_CLOSE，句柄失败路径逐一 CloseHandle。
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "CreateJobObjectW failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let limits = JobObjectExtendedLimitInformation {
                basic: JobObjectBasicLimitInformation {
                    per_process_user_time_limit: 0,
                    per_job_user_time_limit: 0,
                    limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    _pad: 0,
                    minimum_working_set_size: 0,
                    maximum_working_set_size: 0,
                    active_process_limit: 0,
                    _pad2: 0,
                    affinity: 0,
                    priority_class: 0,
                    scheduling_class: 0,
                },
                io_info: windows_api::IoCounters {
                    read_operation_count: 0,
                    write_operation_count: 0,
                    other_operation_count: 0,
                    read_transfer_count: 0,
                    write_transfer_count: 0,
                    other_transfer_count: 0,
                },
                process_memory_limit: 0,
                job_memory_limit: 0,
                peak_process_memory_used: 0,
                peak_job_memory_used: 0,
            };
            let set_ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &limits,
                std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
            );
            if set_ok == 0 {
                let error = std::io::Error::last_os_error();
                let _ = CloseHandle(job);
                return Err(format!("SetInformationJobObject failed: {error}"));
            }
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                process_id,
            );
            if process.is_null() {
                let error = std::io::Error::last_os_error();
                let _ = CloseHandle(job);
                return Err(format!("OpenProcess({process_id}) failed: {error}"));
            }
            let assigned = AssignProcessToJobObject(job, process);
            let _ = CloseHandle(process);
            if assigned == 0 {
                let error = std::io::Error::last_os_error();
                let _ = CloseHandle(job);
                return Err(format!("AssignProcessToJobObject({process_id}) failed: {error}"));
            }
            Ok(Self { handle: job })
        }
    }

    fn terminate(&self) -> Result<bool, String> {
        use windows_api::TerminateJobObject;
        // SAFETY：持有合法 Job 句柄；整树终止等价 unix SIGKILL 组信号。
        unsafe {
            if TerminateJobObject(self.handle, 1) == 0 {
                return Err(format!(
                    "TerminateJobObject failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(true)
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE：关闭句柄即终止 Job 内残留进程（命令收尾清理）。
        unsafe {
            let _ = windows_api::CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive() {
        assert!(process_alive(std::process::id()));
    }

    #[test]
    fn dead_pid_is_not_alive() {
        // 取远超各平台 pid 上限的正数（Linux pid_max ≤ 4M、macOS ≤ 99998、
        // Windows 进程 id 上限远低）：ESRCH 确定性返回。不能用接近 u32::MAX
        // 的值——as i32 会变成 -1，unix 上 kill(-1) 是「全部进程」广播。
        assert!(!process_alive(2_000_000_000));
    }
}
