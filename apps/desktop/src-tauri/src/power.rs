//! 电源管理：设置页「保持电脑运行」开关的原生实现。
//!
//! 通过 IOPMAssertion 持有 `PreventUserIdleSystemSleep`——只阻止系统**因空闲**
//! 进入休眠，手动睡眠与合盖休眠不受影响。assertion 归属当前进程，进程退出
//! （含崩溃）时由 IOKit 自动释放，无需显式清理路径。
//!
//! IOPMAssertion 是 macOS 专属能力；Linux 侧的 logind inhibitor 方案见
//! docs/linux-support.md（未实现前 `set_prevent_idle_sleep` 为 no-op 成功，
//! 状态壳仅为命令注册与 capability 契约稳定而存在）。

#[cfg(target_os = "macos")]
use std::{
    ffi::{c_char, c_void, CString},
    sync::Mutex,
};

use tauri::State;

#[cfg(target_os = "macos")]
/// IOPMAssertionID：IOKit 分配的 assertion 句柄。
type IOPMAssertionID = u32;
#[cfg(target_os = "macos")]
/// CFStringRef：CoreFoundation 不透明字符串指针。
type CFStringRef = *const c_void;

#[cfg(target_os = "macos")]
const KIOR_RETURN_SUCCESS: i32 = 0;
#[cfg(target_os = "macos")]
const KIOPM_ASSERTION_LEVEL_ON: u32 = 255;
#[cfg(target_os = "macos")]
const KCFSTRING_ENCODING_UTF8: u32 = 0x0800_0100;
#[cfg(target_os = "macos")]
const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
#[cfg(target_os = "macos")]
const ASSERTION_NAME: &str = "Axiom settings: prevent idle sleep";

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        value: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFRelease(value: *const c_void);
}

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(
        assertion_type: CFStringRef,
        level: u32,
        assertion_name: CFStringRef,
        assertion_id: *mut IOPMAssertionID,
    ) -> i32;
    fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> i32;
}

#[cfg(target_os = "macos")]
/// RAII 包装：确保参与 FFI 调用的 CFString 离开作用域即释放。
struct ScopedCFString(CFStringRef);

#[cfg(target_os = "macos")]
impl ScopedCFString {
    fn new(value: &str) -> Result<Self, String> {
        // CString 构造失败仅当内嵌 NUL——固定常量与 ASCII 名称不会触发。
        let encoded =
            CString::new(value).map_err(|_| "power assertion name contains NUL".to_string())?;
        // SAFETY: encoded 指向有效 NUL 结尾 UTF-8；失败路径返回空指针，由下方判定。
        let raw = unsafe {
            CFStringCreateWithCString(std::ptr::null(), encoded.as_ptr(), KCFSTRING_ENCODING_UTF8)
        };
        if raw.is_null() {
            return Err("failed to create CFString for power assertion".to_string());
        }
        Ok(Self(raw))
    }
}

#[cfg(target_os = "macos")]
impl Drop for ScopedCFString {
    fn drop(&mut self) {
        // SAFETY: self.0 由 CFStringCreateWithCString 分配且尚未释放。
        unsafe { CFRelease(self.0) };
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
pub(crate) struct PowerManagementState {
    /// 当前持有的 idle-sleep assertion；None 表示未阻止休眠。
    assertion_id: Mutex<Option<IOPMAssertionID>>,
}

/// Linux/其它平台的状态壳：电源管理尚未提供原生实现，命令保持注册以维持
/// capability 契约稳定（旧会话恢复不因 command 缺失而失败），调用为 no-op 成功。
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub(crate) struct PowerManagementState;

#[cfg(target_os = "macos")]
impl PowerManagementState {
    /// 幂等切换 idle-sleep 阻止：重复开启/关闭为 no-op，避免泄漏重复 assertion。
    fn set_prevent_idle_sleep(&self, enabled: bool) -> Result<(), String> {
        let mut assertion_id = self
            .assertion_id
            .lock()
            .map_err(|_| "power management state lock is poisoned".to_string())?;
        if enabled {
            if assertion_id.is_some() {
                return Ok(());
            }
            let id = create_idle_sleep_assertion()?;
            *assertion_id = Some(id);
            Ok(())
        } else {
            match assertion_id.take() {
                Some(id) => release_idle_sleep_assertion(id),
                None => Ok(()),
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn create_idle_sleep_assertion() -> Result<IOPMAssertionID, String> {
    let assertion_type = ScopedCFString::new(PREVENT_USER_IDLE_SYSTEM_SLEEP)?;
    let assertion_name = ScopedCFString::new(ASSERTION_NAME)?;
    let mut id: IOPMAssertionID = 0;
    // SAFETY: 两个 CFString 参数均由 ScopedCFString 保证存活且为合法 CFStringRef；
    // id 为合法出参指针。返回值非 kIOReturnSuccess 时 id 不含有效句柄。
    let status = unsafe {
        IOPMAssertionCreateWithName(
            assertion_type.0,
            KIOPM_ASSERTION_LEVEL_ON,
            assertion_name.0,
            &mut id,
        )
    };
    if status != KIOR_RETURN_SUCCESS || id == 0 {
        return Err(format!("IOPMAssertionCreateWithName failed: {status}"));
    }
    Ok(id)
}

#[cfg(target_os = "macos")]
fn release_idle_sleep_assertion(id: IOPMAssertionID) -> Result<(), String> {
    // SAFETY: id 来自此前成功的 IOPMAssertionCreateWithName 且仅释放一次（经锁内 take）。
    let status = unsafe { IOPMAssertionRelease(id) };
    if status != KIOR_RETURN_SUCCESS {
        return Err(format!("IOPMAssertionRelease failed: {status}"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn set_prevent_idle_sleep(
    power_state: State<'_, PowerManagementState>,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        power_state.set_prevent_idle_sleep(enabled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux no-op 成功：防休眠缺失只影响长任务期间的空闲休眠（UX 降级，
        // 非安全问题），报错反而会让设置页开关出现无意义的失败提示。
        let _ = (power_state, enabled);
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn toggling_is_idempotent_and_releases_the_assertion() {
        let state = PowerManagementState::default();
        state.set_prevent_idle_sleep(true).expect("enable must succeed");
        // 重复开启为 no-op（不泄漏第二个 assertion）。
        state
            .set_prevent_idle_sleep(true)
            .expect("re-enable must succeed");
        state
            .set_prevent_idle_sleep(false)
            .expect("disable must succeed");
        // 关闭态重复关闭同样为 no-op。
        state
            .set_prevent_idle_sleep(false)
            .expect("re-disable must succeed");
    }

    #[test]
    fn cf_string_roundtrip_rejects_nul() {
        assert!(ScopedCFString::new("PreventUserIdleSystemSleep").is_ok());
        assert!(ScopedCFString::new("bad\0name").is_err());
    }
}
