//! 原生确认对话框（tauri-plugin-dialog）。
//!
//! 用于「内容级」高风险动作：带 Secret 的 API 测试步骤、测试环境的边界字段变更。
//! 与 NSEvent 手势门的区别：手势只证明用户在场，原生对话框展示的是 Rust 侧构造的
//! 本次实际内容（请求目标 / 环境字段差异），用户确认后动作才继续。
//!
//! E2E 构建由脚本驱动，不弹对话框（`feature = "e2e"`）；对话框在 macOS/Linux/Windows
//! 均由宿主原生实现（Linux 走 GTK），不依赖 macOS 专属 API。

#[cfg(feature = "e2e")]
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 弹出警告型确认框：确认返回 `Ok(true)`，取消/关闭返回 `Ok(false)`；
/// 对话框自身异常返回错误（fail-closed）。
pub(crate) async fn confirm_native(
    app: &tauri::AppHandle,
    title: &str,
    message: &str,
    confirm_label: &str,
    cancel_label: &str,
) -> Result<bool, String> {
    #[cfg(feature = "e2e")]
    {
        let _ = (app, message, confirm_label, cancel_label);
        // E2E 不弹原生对话框，确认结果由 `AXIOM_E2E_NATIVE_CONFIRM` 注入：
        // `cancel` 一律取消；`cancel-once:<标题子串>` 只取消「标题命中该子串」的第一次确认
        // （子串让取消只作用于被测动作，不会被同进程更早的原生确认消耗）。
        let raw = std::env::var("AXIOM_E2E_NATIVE_CONFIRM").ok();
        let mode = parse_e2e_confirm_mode(raw.as_deref());
        let matched = match &mode {
            E2eConfirmMode::CancelOnce(subject) if title.contains(subject) => {
                E2E_CONFIRM_MATCHES.fetch_add(1, Ordering::SeqCst) + 1
            }
            _ => 0,
        };
        return Ok(e2e_confirm_answer(&mode, title, matched));
    }
    #[cfg(not(feature = "e2e"))]
    {
        let mut dialog = app
            .dialog()
            .message(message.to_string())
            .title(title.to_string())
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                confirm_label.to_string(),
                cancel_label.to_string(),
            ));
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.parent(&window);
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        dialog.show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
        match receiver.await {
            Ok(confirmed) => Ok(confirmed),
            Err(_) => Err("确认对话框意外关闭".to_string()),
        }
    }
}

/// E2E 下的确认策略（`AXIOM_E2E_NATIVE_CONFIRM`，仅 E2E 构建读取）：
/// - 未设置 / 其它值：一律确认；
/// - `cancel`：一律取消；
/// - `cancel-once:<标题子串>`：**标题包含该子串**的第一次确认取消，之后确认；其它标题照常确认。
///
/// 子串是为了让取消只作用于被测动作：同一进程里可能已有其它原生确认（如带 Secret 的
/// 步骤），按全局次数计数会把「第一次」错位。
#[cfg(any(test, feature = "e2e"))]
#[derive(Debug, PartialEq, Eq)]
enum E2eConfirmMode<'a> {
    Confirm,
    Cancel,
    CancelOnce(&'a str),
}

#[cfg(any(test, feature = "e2e"))]
fn parse_e2e_confirm_mode(raw: Option<&str>) -> E2eConfirmMode<'_> {
    match raw {
        Some("cancel") => E2eConfirmMode::Cancel,
        Some(value) => match value.strip_prefix("cancel-once:") {
            Some(subject) if !subject.is_empty() => E2eConfirmMode::CancelOnce(subject),
            // 空子串不成立：回落到「一律确认」，避免误把一切确认都取消。
            _ => E2eConfirmMode::Confirm,
        },
        None => E2eConfirmMode::Confirm,
    }
}

#[cfg(any(test, feature = "e2e"))]
fn e2e_confirm_answer(mode: &E2eConfirmMode<'_>, title: &str, matched: usize) -> bool {
    match mode {
        E2eConfirmMode::Confirm => true,
        E2eConfirmMode::Cancel => false,
        E2eConfirmMode::CancelOnce(subject) => {
            if !title.contains(subject) {
                return true;
            }
            matched != 1
        }
    }
}

#[cfg(feature = "e2e")]
static E2E_CONFIRM_MATCHES: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
mod tests {
    use super::{e2e_confirm_answer, parse_e2e_confirm_mode, E2eConfirmMode};

    #[test]
    fn e2e_confirm_mode_parses_known_values() {
        assert_eq!(parse_e2e_confirm_mode(None), E2eConfirmMode::Confirm);
        assert_eq!(parse_e2e_confirm_mode(Some("1")), E2eConfirmMode::Confirm);
        assert_eq!(
            parse_e2e_confirm_mode(Some("cancel")),
            E2eConfirmMode::Cancel
        );
        assert_eq!(
            parse_e2e_confirm_mode(Some("cancel-once:删除设计稿页")),
            E2eConfirmMode::CancelOnce("删除设计稿页")
        );
        // 空子串不成立：宁可一律确认，也不误取消。
        assert_eq!(
            parse_e2e_confirm_mode(Some("cancel-once:")),
            E2eConfirmMode::Confirm
        );
    }

    #[test]
    fn e2e_confirm_answer_honors_cancel_once_per_subject() {
        assert!(e2e_confirm_answer(&E2eConfirmMode::Confirm, "任意标题", 0));
        assert!(!e2e_confirm_answer(&E2eConfirmMode::Cancel, "任意标题", 0));
        let once = E2eConfirmMode::CancelOnce("删除设计稿页");
        // 第一次命中取消，第二次起确认（同一进程内先验取消路径、再验成功路径）。
        assert!(!e2e_confirm_answer(&once, "删除设计稿页", 1));
        assert!(e2e_confirm_answer(&once, "删除设计稿页", 2));
        // 标题不匹配时照常确认：取消不会被其它确认消耗。
        assert!(e2e_confirm_answer(&once, "保存测试环境", 0));
    }
}
