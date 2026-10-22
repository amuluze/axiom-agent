//! 原生用户手势配额（macOS）：把「渲染进程可调用」的敏感写入收敛到「必须有一次
//! 真实用户交互」。
//!
//! 与终端 stdin 的 keyDown 手势门同一信任模型：NSEvent local monitor 只能观察本 app
//! 的原生事件流，受陷渲染进程无法伪造；配额单次消费、短 TTL。它证明的是「用户此刻在
//! 操作本 app」，不是「用户看懂了这条具体操作」——内容级同意仍由审批卡/编辑器承载。
//!
//! 当前消费者：
//! - 测试步骤租约签发（UI/API）；
//! - 测试环境保存（API Base URL / Secret 名单 / 私网授权等任何字段）；
//! - 文档保存（SDD 受管文档与 AGENTS.md 的受限写通道）；
//! - 设计稿历史版本恢复（`design_access::restore_design_document_version`）。
//!
//! ## 非 macOS 的在场证明
//!
//! 非 macOS 没有 NSEvent 等价物（Wayland 明确禁止全局输入观测，X11 XRecord
//! 只覆盖 X 应用且不可依赖）。此前的实现是「`consume_user_gesture` 保持放行」——
//! 那等于让受陷渲染进程**静默**签发租约、保存带 Secret 的环境、写入受管文档，
//! 是 fail-open，与本仓库的失败关闭哲学相悖（对照：终端在 Linux 整条禁用而非降级）。
//!
//! 现在改为两级：
//! 1. `consume_user_gesture` 在非 macOS **拒绝**（不再放行）；
//! 2. `require_user_confirmation` 是所有消费点的统一入口：macOS 消费手势配额，
//!    非 macOS 降级为**一次宿主原生确认对话框**——本次动作若本来就有内容确认框，
//!    那一次点击即充当在场证明（不重复弹框）；没有内容确认框的动作补一次通用
//!    确认框。受陷渲染进程无法自动确认宿主原生对话框，因此注入面被关掉。

#[cfg(target_os = "macos")]
use std::sync::Mutex;
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::time::Instant;

/// 配额距最近一次原生事件的最大窗口。正常链路（点击 → IPC → 签发）是毫秒级；
/// 5 秒窗口在覆盖慢 IPC 的同时限制「用户离开后残留配额」的可用时间。
pub(crate) const USER_GESTURE_WINDOW: Duration = Duration::from_secs(5);

/// 原生手势配额状态（以 `Arc<UserGestureState>` 托管，monitor 与命令共享）。
#[derive(Default)]
pub(crate) struct UserGestureState {
    #[cfg(target_os = "macos")]
    pending: Mutex<bool>,
    #[cfg(target_os = "macos")]
    last_granted_at: Mutex<Option<Instant>>,
}

#[cfg(target_os = "macos")]
fn grant_user_gesture(state: &UserGestureState) {
    // 只保留一个待消费配额：一次用户操作授权一次敏感动作，不累积点击。
    if let Ok(mut pending) = state.pending.lock() {
        *pending = true;
    }
    if let Ok(mut last) = state.last_granted_at.lock() {
        *last = Some(Instant::now());
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn consume_user_gesture(
    state: &UserGestureState,
    window: Duration,
) -> Result<(), String> {
    consume_user_gesture_at(state, window, Instant::now())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn consume_user_gesture(
    _state: &UserGestureState,
    _window: Duration,
) -> Result<(), String> {
    // 非 macOS 没有与 NSEvent local monitor 等价的、渲染进程不可伪造的本地手势信号。
    // 此处**必须拒绝**：放行等于让受陷渲染进程在没有真实用户交互的情况下静默签发
    // 测试租约 / 改道测试环境 / 写入受管文档。非 macOS 的在场证明改由
    // `require_user_confirmation` 的原生确认对话框承担（见模块文档）。
    Err("该平台没有与 NSEvent 等价的原生手势信号，请改用原生确认对话框".to_string())
}

/// 「用户在场」门的形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UserGestureGate {
    /// 消费 macOS NSEvent 手势配额（受陷渲染进程不可伪造）。
    ConsumeNativeGesture,
    /// 已由本次动作的内容确认框满足：用户刚在宿主原生对话框上点过确认。
    SatisfiedByContentConfirm,
    /// 需要补一次宿主原生确认对话框。
    ConfirmDialog,
}

/// 平台与「本次动作是否带内容确认框」共同决定门的形态。
///
/// 纯函数（不依赖 `cfg`）：非 macOS 的分支在 macOS 上也能被单测覆盖——否则
/// 「跨平台差异只能靠肉眼审」会留下长期空档。
pub(crate) fn resolve_user_gesture_gate(
    operating_system: &str,
    has_content_confirm: bool,
) -> UserGestureGate {
    if operating_system == "macos" {
        // macOS 保留两层：手势证明在场，内容确认展示实际动作。
        return UserGestureGate::ConsumeNativeGesture;
    }
    if has_content_confirm {
        // 内容确认框的那一次点击即充当在场证明，不重复弹框。
        return UserGestureGate::SatisfiedByContentConfirm;
    }
    UserGestureGate::ConfirmDialog
}

/// 宿主操作系统的稳定标识（`macos` / `linux` / `windows`）。
pub(crate) fn current_operating_system() -> &'static str {
    std::env::consts::OS
}

/// 一次敏感动作的确认文案（标题 + 正文 + 确认按钮标签）。
pub(crate) struct ContentConfirm {
    pub(crate) title: &'static str,
    pub(crate) message: String,
    pub(crate) confirm_label: &'static str,
}

/// 要求一次「用户在场」证明。
///
/// - macOS：消费 NSEvent 手势配额，再叠加内容确认框（两层都在）。
/// - 非 macOS：没有手势信号，改用一次宿主原生确认对话框——本次动作的内容确认框
///   若已存在则复用（用户点过确认即证明在场），否则补一次通用确认框。
///
/// 返回 `Ok(false)` 表示用户在对话框上点了取消；各调用点按自己的语义映射
/// （签发租约的命令返回 `None`/`Err`，保存类命令返回 `false`）。
pub(crate) async fn require_user_confirmation(
    app: &tauri::AppHandle,
    state: &UserGestureState,
    operating_system: &str,
    content: Option<ContentConfirm>,
    fallback: ContentConfirm,
) -> Result<bool, String> {
    let confirmed = match resolve_user_gesture_gate(operating_system, content.is_some()) {
        UserGestureGate::ConsumeNativeGesture => {
            consume_user_gesture(state, USER_GESTURE_WINDOW)?;
            let Some(content) = content else {
                return Ok(true);
            };
            crate::native_confirm::confirm_native(
                app,
                content.title,
                &content.message,
                content.confirm_label,
                "取消",
            )
            .await?
        }
        UserGestureGate::SatisfiedByContentConfirm => {
            // content 在此分支必然存在（resolve 的入参决定了形态）。
            let content = content.expect("内容确认形态下 content 必然存在");
            crate::native_confirm::confirm_native(
                app,
                content.title,
                &content.message,
                content.confirm_label,
                "取消",
            )
            .await?
        }
        UserGestureGate::ConfirmDialog => {
            crate::native_confirm::confirm_native(
                app,
                fallback.title,
                &fallback.message,
                fallback.confirm_label,
                "取消",
            )
            .await?
        }
    };
    // 对话框按钮点击会再授予一个手势配额；无论确认还是取消都清掉，避免残留配额
    // 被后续动作消费。非 macOS 无配额可清，调用是 no-op。
    drain_user_gesture(state);
    Ok(confirmed)
}

/// 原生对话框的确认/取消点击会再授予一个配额；内容级确认完成后清掉，
/// 避免残留配额被后续动作消费。
pub(crate) fn drain_user_gesture(state: &UserGestureState) {
    let _ = consume_user_gesture(state, USER_GESTURE_WINDOW);
}

#[cfg(target_os = "macos")]
fn consume_user_gesture_at(
    state: &UserGestureState,
    window: Duration,
    now: Instant,
) -> Result<(), String> {
    // E2E 构建的 approver/自动化脚本不产生真实原生事件；只在测试构建里豁免。
    #[cfg(feature = "e2e")]
    {
        let _ = (state, window, now);
        return Ok(());
    }
    #[cfg(not(feature = "e2e"))]
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "用户手势状态已损坏".to_string())?;
        if !*pending {
            return Err("该操作需要用户点击或按键确认（未检测到原生用户手势）".to_string());
        }
        let granted_at = match *state
            .last_granted_at
            .lock()
            .map_err(|_| "用户手势状态已损坏".to_string())?
        {
            Some(at) => at,
            None => {
                *pending = false;
                return Err("用户手势状态未记录".to_string());
            }
        };
        if now.saturating_duration_since(granted_at) > window {
            *pending = false;
            return Err("用户手势已过期，请重新操作".to_string());
        }
        *pending = false;
        Ok(())
    }
}

/// 安装 NSEvent local monitor：左键按下、Return / 小键盘 Enter、⌘S 授予一个配额。
/// 只观察本 app 的事件流，无需辅助功能权限；必须在主线程调用。
#[cfg(target_os = "macos")]
fn install_user_gesture_monitor(state: &std::sync::Arc<UserGestureState>) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use objc2_foundation::MainThreadMarker;

    if MainThreadMarker::new().is_none() {
        return Err("user gesture monitor requires the main thread".into());
    }
    let state = std::sync::Arc::clone(state);
    let block: RcBlock<dyn Fn(std::ptr::NonNull<NSEvent>) -> *mut NSEvent> =
        RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
            // SAFETY: AppKit 保证事件指针在 local monitor 回调期间有效；这里只读取
            // 事件类型、键码与修饰键，不保留引用。
            let event_ref = unsafe { event.as_ref() };
            let should_grant = match event_ref.r#type() {
                // 任意左键按下都意味着用户正在操作本 app；审批/保存按钮都经此路径。
                NSEventType::LeftMouseDown => true,
                NSEventType::KeyDown => {
                    let code = event_ref.keyCode();
                    // Return / 小键盘 Enter（键盘批准）或 ⌘S（文档保存快捷键）。
                    matches!(code, 36 | 76)
                        || (code == 1
                            && event_ref
                                .modifierFlags()
                                .contains(NSEventModifierFlags::Command))
                }
                _ => false,
            };
            if should_grant {
                grant_user_gesture(&state);
            }
            // 返回原事件继续传递（不吞用户的点击/按键）。
            event.as_ptr()
        });
    let block: &'static RcBlock<dyn Fn(std::ptr::NonNull<NSEvent>) -> *mut NSEvent> =
        Box::leak(Box::new(block));
    // 返回值由 NSApplication 持有；drop 不会自动移除 monitor。
    let _monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::KeyDown | NSEventMask::LeftMouseDown,
            block,
        )
    };
    Ok(())
}

/// 在 app setup 阶段安装手势 monitor（主线程）。
pub(crate) fn install_gesture_monitor(app: &tauri::App) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let state = app.state::<std::sync::Arc<UserGestureState>>();
        install_user_gesture_monitor(state.inner())
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

    /// 门形态决策是纯函数：平台矩阵在任意平台都可断言——非 macOS 的行为不会
    /// 因为「那段代码只能在 macOS 上编译」而失去测试覆盖。
    #[test]
    fn resolves_gate_per_platform() {
        assert_eq!(
            resolve_user_gesture_gate("macos", false),
            UserGestureGate::ConsumeNativeGesture
        );
        assert_eq!(
            resolve_user_gesture_gate("macos", true),
            UserGestureGate::ConsumeNativeGesture
        );
        // 非 macOS：有内容确认框 → 那一次点击即在场证明（不重复弹框）。
        assert_eq!(
            resolve_user_gesture_gate("linux", true),
            UserGestureGate::SatisfiedByContentConfirm
        );
        // 非 macOS 且无内容确认框 → 补一次通用确认框（不得静默放行）。
        assert_eq!(
            resolve_user_gesture_gate("linux", false),
            UserGestureGate::ConfirmDialog
        );
        assert_eq!(
            resolve_user_gesture_gate("windows", false),
            UserGestureGate::ConfirmDialog
        );
    }

    /// 非 macOS 不得放行原生手势消费：放行等于受陷渲染进程可静默签发租约。
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_never_grants_native_gesture() {
        let state = UserGestureState::default();
        assert!(consume_user_gesture(&state, USER_GESTURE_WINDOW).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn user_gesture_is_single_use_and_expires() {
        let state = UserGestureState::default();
        let now = Instant::now();
        assert!(consume_user_gesture_at(&state, USER_GESTURE_WINDOW, now).is_err());

        // 连续两次原生事件只保留一个配额：一次点击只能授权一次敏感动作。
        grant_user_gesture(&state);
        grant_user_gesture(&state);
        assert!(consume_user_gesture_at(&state, USER_GESTURE_WINDOW, now).is_ok());
        assert!(consume_user_gesture_at(&state, USER_GESTURE_WINDOW, now).is_err());

        grant_user_gesture(&state);
        let later = now + USER_GESTURE_WINDOW + Duration::from_secs(1);
        assert_eq!(
            consume_user_gesture_at(&state, USER_GESTURE_WINDOW, later),
            Err("用户手势已过期，请重新操作".to_string())
        );
        // 过期消费会清空配额，不能靠重新消费复活。
        assert!(consume_user_gesture_at(&state, USER_GESTURE_WINDOW, later).is_err());
    }
}
