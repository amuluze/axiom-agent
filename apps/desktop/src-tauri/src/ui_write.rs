//! UI 写步骤执行器（U1-4）：navigate / click / input / select / press。
//!
//! 每次执行都必须同时满足：
//! 1. 持有 Rust 签发、与当前内容摘要一致、未消费、未过期的审批租约（`test_approval.rs`）；
//! 2. 测试目标授权仍有效（tab、origin、工作区代际，U1-2）；
//! 3. 目标定位唯一（U1-1）。ref 只在本次调用内解析并立即使用，执行后即作废。
//!
//! 导航先于发出前检查目标 origin 是否仍在授权内，越界直接拒绝；动作之后再次校验授权，
//! 若页面已越界则报错——此时动作已经发生，结果如实上报，不做回滚假设。

use serde::Deserialize;
use std::time::Instant;
use tauri::{AppHandle, State};

use crate::browser_locator::LocatorResolution;
use crate::browser_session::{
    dispatch_browser_command, read_ui_snapshot, BrowserCommandRequest, BrowserSessionState,
};
use crate::test_approval::{TestStepLeaseRequest, TestStepLeases};
use crate::test_target::{origin_of, TestTargetGrants};
use crate::ui_test::{verify_test_grant, UiVerdict};
use crate::workspace_access::{authorized_root, WorkspaceAccessState};

/// 写动作的可执行形态。`action` 字段是判别符；多余字段（如 `id`、`locator`）被忽略——
/// 定位器由 `TestStepLeaseRequest.locator` 单独携带并参与摘要，不在此重复解析。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "action")]
pub(crate) enum UiWriteAction {
    #[serde(rename = "ui.navigate")]
    Navigate { url: String },
    #[serde(rename = "ui.click")]
    Click {},
    #[serde(rename = "ui.input")]
    Input { value: String },
    #[serde(rename = "ui.select")]
    Select { value: String },
    #[serde(rename = "ui.press")]
    Press { key: String },
}

impl UiWriteAction {
    /// 需要定位器的动作（navigate 不需要；press 可选）。
    fn requires_locator(&self) -> bool {
        matches!(
            self,
            Self::Click {} | Self::Input { .. } | Self::Select { .. }
        )
    }
}

/// 导航目标必须与授权 origin 相同。相对地址已在编译期解析为绝对地址，这里只做比较。
pub(crate) fn ensure_navigation_within_origin(
    url: &str,
    granted_origin: &str,
) -> Result<(), String> {
    let target = origin_of(url)?;
    if target == granted_origin {
        Ok(())
    } else {
        Err("导航目标位于授权之外的 origin，已拒绝".to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiWriteRequest {
    #[serde(flatten)]
    lease: TestStepLeaseRequest,
    lease_id: String,
}

/// 执行写步骤。返回 passed 仅表示动作已按序发出且执行后授权仍有效。
#[tauri::command]
pub async fn run_ui_write_step(
    app: AppHandle,
    browser: State<'_, BrowserSessionState>,
    workspace: State<'_, WorkspaceAccessState>,
    grants: State<'_, TestTargetGrants>,
    leases: State<'_, TestStepLeases>,
    request: UiWriteRequest,
) -> Result<UiVerdict, String> {
    let action: UiWriteAction = serde_json::from_value(request.lease.action.clone())
        .map_err(|_| "不支持的写步骤动作".to_string())?;
    let root = authorized_root(&workspace)?;
    let generation = workspace.generation_for(&root);
    // 先消费租约：无论后续成败，同一租约都不能再次使用。
    leases.consume(
        &request.lease_id,
        &request.lease,
        generation,
        Instant::now(),
    )?;

    let tab_id = request.lease.tab_id.clone();
    let run_id = request.lease.run_id.clone();
    let data_root = crate::storage_paths::axiom_data_root(&app)?;

    let before = read_ui_snapshot(&app, &browser, &tab_id, request.lease.locator.as_ref()).await?;
    verify_test_grant(&workspace, &grants, &run_id, &tab_id, &before.url)?;
    let granted_origin = request.lease.origin.clone();

    let target_ref = if action.requires_locator() {
        match &before.resolution {
            Some(LocatorResolution::Unique { candidate }) => Some(candidate.ref_id),
            Some(LocatorResolution::NotFound) => {
                return Err("定位失败：零匹配，动作未执行".to_string())
            }
            Some(LocatorResolution::Ambiguous { total, .. }) => {
                return Err(format!("定位歧义：{total} 个候选，动作未执行"))
            }
            None => return Err("写步骤缺少定位器".to_string()),
        }
    } else {
        None
    };

    let command = match &action {
        UiWriteAction::Navigate { url } => {
            ensure_navigation_within_origin(url, &granted_origin)?;
            BrowserCommandRequest::Navigate {
                tab_id: tab_id.clone(),
                url: url.clone(),
            }
        }
        UiWriteAction::Click {} => BrowserCommandRequest::Click {
            tab_id: tab_id.clone(),
            r#ref: target_ref.ok_or("写步骤缺少定位结果")?,
        },
        UiWriteAction::Input { value } => BrowserCommandRequest::Fill {
            tab_id: tab_id.clone(),
            r#ref: target_ref.ok_or("写步骤缺少定位结果")?,
            text: value.clone(),
        },
        UiWriteAction::Select { value } => BrowserCommandRequest::SelectOption {
            tab_id: tab_id.clone(),
            r#ref: target_ref.ok_or("写步骤缺少定位结果")?,
            text: value.clone(),
        },
        UiWriteAction::Press { key } => BrowserCommandRequest::Press {
            tab_id: tab_id.clone(),
            key: key.clone(),
            r#ref: target_ref,
        },
    };

    dispatch_browser_command(&app, &browser, command, &data_root, Some(&app)).await?;

    let after = read_ui_snapshot(&app, &browser, &tab_id, None).await?;
    verify_test_grant(&workspace, &grants, &run_id, &tab_id, &after.url)
        .map_err(|error| format!("动作已执行，但页面随后越出授权：{error}"))?;
    // H1-4 故障窗口：动作已按序发出、授权复核通过，但步骤尚未结算落库。
    crate::runtime_fault::checkpoint_if_configured("test_step_action_applied")?;
    Ok(UiVerdict::Passed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_each_supported_write_action_by_its_discriminator() {
        assert_eq!(
            serde_json::from_value::<UiWriteAction>(
                json!({"id": "s", "action": "ui.click", "locator": {"role": "button"}})
            )
            .unwrap(),
            UiWriteAction::Click {}
        );
        assert_eq!(
            serde_json::from_value::<UiWriteAction>(
                json!({"id": "s", "action": "ui.input", "locator": {}, "value": "SHOP"})
            )
            .unwrap(),
            UiWriteAction::Input {
                value: "SHOP".into()
            }
        );
        assert_eq!(
            serde_json::from_value::<UiWriteAction>(
                json!({"id": "s", "action": "ui.press", "key": "Enter"})
            )
            .unwrap(),
            UiWriteAction::Press {
                key: "Enter".into()
            }
        );
    }

    #[test]
    fn read_and_unknown_actions_are_not_executable_as_writes() {
        assert!(serde_json::from_value::<UiWriteAction>(
            json!({"action": "ui.assert", "expect": {"exists": true}})
        )
        .is_err());
        assert!(serde_json::from_value::<UiWriteAction>(json!({"action": "ui.eval"})).is_err());
    }

    #[test]
    fn only_navigate_and_press_may_run_without_a_locator() {
        assert!(!UiWriteAction::Navigate {
            url: "https://a.test".into()
        }
        .requires_locator());
        assert!(!UiWriteAction::Press {
            key: "Enter".into()
        }
        .requires_locator());
        assert!(UiWriteAction::Click {}.requires_locator());
        assert!(UiWriteAction::Input {
            value: String::new()
        }
        .requires_locator());
    }

    #[test]
    fn navigation_is_refused_outside_the_granted_origin() {
        assert!(
            ensure_navigation_within_origin("https://shop.test/cart", "https://shop.test").is_ok()
        );
        assert!(
            ensure_navigation_within_origin("https://evil.test/", "https://shop.test").is_err()
        );
        assert!(ensure_navigation_within_origin("http://shop.test/", "https://shop.test").is_err());
        assert!(
            ensure_navigation_within_origin("file:///etc/passwd", "https://shop.test").is_err()
        );
    }
}
