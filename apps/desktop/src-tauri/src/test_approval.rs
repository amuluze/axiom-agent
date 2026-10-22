//! 测试步骤审批租约（U1-5）：`testStep` actor，不伪造 Agent 的 toolCallId。
//!
//! 租约只签发给一个已通过授权校验的写步骤，绑定 runId / stepId / tabId / origin /
//! 定位器摘要 / 动作摘要 / 工作区代际。摘要由 Rust 从原始定位器与动作计算，WebView 无法指定。
//! 消费（执行）时重新计算并比对，单次有效，并在过期后失效。

#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

use crate::browser_locator::LocatorSpec;
use crate::browser_session::{read_ui_snapshot, BrowserSessionState};
use crate::test_target::TestTargetGrants;
use crate::ui_test::verify_test_grant;
use crate::user_gesture::{
    current_operating_system, require_user_confirmation, ContentConfirm, UserGestureState,
};
use crate::workspace_access::WorkspaceAccessState;

/// 审批窗口：用户确认后应在此时间内执行，过期即作废，防止旧确认被延迟消费。
const LEASE_TTL: Duration = Duration::from_secs(120);

/// 租约签发请求。摘要不在此处接收：由 Rust 从 `locator` 与 `action` 原文计算。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestStepLeaseRequest {
    pub(crate) run_id: String,
    pub(crate) step_id: String,
    pub(crate) tab_id: String,
    pub(crate) origin: String,
    #[serde(default)]
    pub(crate) locator: Option<LocatorSpec>,
    pub(crate) action: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TestStepBinding {
    run_id: String,
    step_id: String,
    tab_id: String,
    origin: String,
    locator_digest: String,
    action_digest: String,
    workspace_generation: u64,
}

struct TestStepLease {
    binding: TestStepBinding,
    expires_at: Instant,
}

#[derive(Default)]
pub struct TestStepLeases {
    leases: Mutex<HashMap<String, TestStepLease>>,
    counter: AtomicU64,
}

fn sha256_hex(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 摘要输入使用 serde_json 的规范输出（Value 键按字典序），同一定位器/动作得到同一摘要。
fn digest_of<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value)
        .map(|text| sha256_hex(&text))
        .map_err(|error| format!("无法计算测试步骤摘要：{error}"))
}

fn binding_for(
    request: &TestStepLeaseRequest,
    workspace_generation: u64,
) -> Result<TestStepBinding, String> {
    if request.step_id.trim().is_empty() || request.run_id.trim().is_empty() {
        return Err("测试运行与步骤标识不能为空".to_string());
    }
    Ok(TestStepBinding {
        run_id: request.run_id.clone(),
        step_id: request.step_id.clone(),
        tab_id: request.tab_id.clone(),
        origin: request.origin.clone(),
        locator_digest: digest_of(&request.locator)?,
        action_digest: digest_of(&request.action)?,
        workspace_generation,
    })
}

impl TestStepLeases {
    pub(crate) fn issue(
        &self,
        request: &TestStepLeaseRequest,
        workspace_generation: u64,
        now: Instant,
    ) -> Result<String, String> {
        let binding = binding_for(request, workspace_generation)?;
        let sequence = self.counter.fetch_add(1, Ordering::Relaxed);
        let lease_id = sha256_hex(&format!(
            "{sequence}|{:?}|{}|{}",
            now, binding.run_id, binding.step_id
        ));
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| "测试步骤租约状态已损坏".to_string())?;
        leases.retain(|_, lease| lease.expires_at > now);
        leases.insert(
            lease_id.clone(),
            TestStepLease {
                binding,
                expires_at: now + LEASE_TTL,
            },
        );
        Ok(lease_id)
    }

    /// 单次消费：无论成功失败，租约都被移出（失败的尝试不能再次尝试同一租约）。
    pub(crate) fn consume(
        &self,
        lease_id: &str,
        request: &TestStepLeaseRequest,
        workspace_generation: u64,
        now: Instant,
    ) -> Result<(), String> {
        let expected = binding_for(request, workspace_generation)?;
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| "测试步骤租约状态已损坏".to_string())?;
        let lease = leases
            .remove(lease_id)
            .ok_or_else(|| "测试步骤租约不存在或已消费".to_string())?;
        if lease.expires_at <= now {
            return Err("测试步骤审批已过期，请重新确认".to_string());
        }
        if lease.binding != expected {
            return Err("测试步骤与审批时的内容不一致，拒绝执行".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStepLeaseIssued {
    lease_id: String,
    ttl_ms: u64,
}

/// 签发步骤租约。签发前重新校验授权：origin 以当前 URL 为准，tab 与工作区须仍在授权内。
#[tauri::command]
pub async fn issue_test_step_lease(
    app: AppHandle,
    browser: State<'_, BrowserSessionState>,
    workspace: State<'_, WorkspaceAccessState>,
    grants: State<'_, TestTargetGrants>,
    leases: State<'_, TestStepLeases>,
    gesture: State<'_, Arc<UserGestureState>>,
    request: TestStepLeaseRequest,
) -> Result<TestStepLeaseIssued, String> {
    let snapshot = read_ui_snapshot(&app, &browser, &request.tab_id, None).await?;
    verify_test_grant(
        &workspace,
        &grants,
        &request.run_id,
        &request.tab_id,
        &snapshot.url,
    )?;
    let generation = {
        let root = crate::workspace_access::authorized_root(&workspace)?;
        workspace.generation_for(&root)
    };
    // 校验全部通过后再要求在场证明：失败的操作不应消耗用户的批准点击。
    // macOS 消费原生手势配额；非 macOS 没有等价信号，降级为一次宿主原生确认
    // 对话框——受陷渲染进程无法自动确认对话框，因此不能静默签发租约。
    let confirmed = require_user_confirmation(
        &app,
        gesture.inner().as_ref(),
        current_operating_system(),
        None,
        ContentConfirm {
            title: "确认执行 UI 测试步骤",
            message: format!(
                "即将在浏览器标签页执行测试步骤：\n\n步骤：{}\n目标：{}\n\n确认执行？",
                request.step_id, request.origin
            ),
            confirm_label: "允许执行",
        },
    )
    .await?;
    if !confirmed {
        return Err("用户取消了该测试步骤".to_string());
    }
    let lease_id = leases.issue(&request, generation, Instant::now())?;
    Ok(TestStepLeaseIssued {
        lease_id,
        ttl_ms: u64::try_from(LEASE_TTL.as_millis()).unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> TestStepLeaseRequest {
        TestStepLeaseRequest {
            run_id: "run-1".into(),
            step_id: "apply".into(),
            tab_id: "tab-1".into(),
            origin: "https://shop.test".into(),
            locator: Some(LocatorSpec {
                role: Some("button".into()),
                name: Some("应用".into()),
                ..LocatorSpec::default()
            }),
            action: json!({"action": "ui.click"}),
        }
    }

    #[test]
    fn a_lease_is_consumed_exactly_once() {
        let leases = TestStepLeases::default();
        let now = Instant::now();
        let id = leases.issue(&request(), 1, now).unwrap();
        assert!(leases.consume(&id, &request(), 1, now).is_ok());
        assert!(
            leases.consume(&id, &request(), 1, now).is_err(),
            "重放必须失败"
        );
    }

    #[test]
    fn a_changed_locator_or_action_is_rejected() {
        let leases = TestStepLeases::default();
        let now = Instant::now();
        let id = leases.issue(&request(), 1, now).unwrap();
        let mut changed = request();
        changed.locator = Some(LocatorSpec {
            role: Some("button".into()),
            name: Some("删除".into()),
            ..LocatorSpec::default()
        });
        assert!(leases.consume(&id, &changed, 1, now).is_err());
    }

    #[test]
    fn workspace_generation_drift_invalidates_the_lease() {
        let leases = TestStepLeases::default();
        let now = Instant::now();
        let id = leases.issue(&request(), 1, now).unwrap();
        assert!(leases.consume(&id, &request(), 2, now).is_err());
    }

    #[test]
    fn an_expired_lease_cannot_be_consumed() {
        let leases = TestStepLeases::default();
        let issued = Instant::now();
        let id = leases.issue(&request(), 1, issued).unwrap();
        let later = issued + LEASE_TTL + Duration::from_secs(1);
        assert_eq!(
            leases.consume(&id, &request(), 1, later),
            Err("测试步骤审批已过期，请重新确认".to_string())
        );
    }

    #[test]
    fn digests_are_derived_from_content_not_from_caller_supplied_fields() {
        let first = binding_for(&request(), 1).unwrap();
        let second = binding_for(&request(), 1).unwrap();
        assert_eq!(first, second, "同一内容必须得到同一摘要");
        assert_eq!(first.locator_digest.len(), 64);
    }

    #[test]
    fn a_missing_lease_is_reported_as_consumed_or_unknown() {
        let leases = TestStepLeases::default();
        assert!(leases
            .consume("nope", &request(), 1, Instant::now())
            .is_err());
    }
}
