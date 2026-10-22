//! 测试目标授权（U1-2）：UI 测试运行只能操作一个被明确授予的浏览器 tab 与 origin。
//!
//! 授权是进程内状态，绑定 runId + tabId + origin + 工作区 generation。授权本身不放行任何副作用，
//! 每个 UI 写步骤仍需逐次审批（U1-5）；这里只限定"能碰哪个 tab、哪个 origin"。
//! 校验采用故障即关闭：tab 关闭、跳转到授权之外的 origin、工作区撤销或代际变化都会让后续校验失败，
//! 因此无需在浏览器的各个关闭路径上挂钩。P0 同一浏览器实例只允许一个 UI 测试运行，只保留一条授权。

//! `verify` 与 `revoke_workspace` 的生产调用方是 U1-3/U1-4 的步骤执行器；在那之前非测试构建
//! 只通过授权命令访问本模块，故允许未使用。
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

use crate::browser_session::{apply_tab_viewport, current_tab_url, BrowserSessionState};
use crate::workspace_access::{authorized_root, WorkspaceAccessState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TestTargetGrant {
    pub(crate) run_id: String,
    pub(crate) tab_id: String,
    pub(crate) origin: String,
    pub(crate) workspace_path: PathBuf,
    pub(crate) workspace_generation: u64,
    pub(crate) viewport: Option<TestViewport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestViewport {
    width: u32,
    height: u32,
}

#[derive(Default)]
pub struct TestTargetGrants(Mutex<Option<TestTargetGrant>>);

fn poisoned() -> String {
    "测试目标授权状态已损坏".to_string()
}

impl TestTargetGrants {
    pub(crate) fn issue(&self, grant: TestTargetGrant) -> Result<(), String> {
        let mut active = self.0.lock().map_err(|_| poisoned())?;
        if active.is_some() {
            return Err("已有测试运行占用浏览器，同一实例只允许一个 UI 测试运行".to_string());
        }
        *active = Some(grant);
        Ok(())
    }

    /// 每个 UI 步骤执行前调用。任一维度不一致都拒绝，错误文案区分原因便于报告定位。
    pub(crate) fn verify(
        &self,
        run_id: &str,
        tab_id: &str,
        observed_origin: &str,
        workspace_path: &Path,
        workspace_generation: u64,
    ) -> Result<(), String> {
        let active = self.0.lock().map_err(|_| poisoned())?;
        let grant = active
            .as_ref()
            .ok_or_else(|| "没有有效的测试目标授权".to_string())?;
        if grant.run_id != run_id {
            return Err("测试目标授权与当前运行不匹配".to_string());
        }
        if grant.tab_id != tab_id {
            return Err("测试目标 tab 与授权不一致".to_string());
        }
        if grant.origin != observed_origin {
            return Err("测试目标已跳转到授权之外的 origin".to_string());
        }
        if grant.workspace_path != workspace_path
            || grant.workspace_generation != workspace_generation
        {
            return Err("工作区授权已变化，测试目标授权失效".to_string());
        }
        Ok(())
    }

    pub(crate) fn revoke_run(&self, run_id: &str) -> Result<bool, String> {
        let mut active = self.0.lock().map_err(|_| poisoned())?;
        let matches = active.as_ref().is_some_and(|grant| grant.run_id == run_id);
        if matches {
            *active = None;
        }
        Ok(matches)
    }

    pub(crate) fn take_run(&self, run_id: &str) -> Result<Option<TestTargetGrant>, String> {
        let mut active = self.0.lock().map_err(|_| poisoned())?;
        if active.as_ref().is_some_and(|grant| grant.run_id == run_id) {
            Ok(active.take())
        } else {
            Ok(None)
        }
    }

    pub(crate) fn revoke_workspace(&self, path: &Path) -> Result<bool, String> {
        let mut active = self.0.lock().map_err(|_| poisoned())?;
        let matches = active
            .as_ref()
            .is_some_and(|grant| grant.workspace_path == path);
        if matches {
            *active = None;
        }
        Ok(matches)
    }
}

/// 把 URL 归一为 origin（scheme://host[:port]）。只接受 http/https，其它协议无法作为测试目标。
pub(crate) fn origin_of(raw: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "测试目标 URL 无法解析".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("测试目标只支持 http/https origin".to_string()),
    }
    if url.host_str().is_none() {
        return Err("测试目标缺少主机名".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueTestTargetGrantRequest {
    run_id: String,
    tab_id: String,
    expected_origin: String,
    #[serde(default)]
    viewport: Option<TestViewport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTargetGrantInfo {
    run_id: String,
    tab_id: String,
    origin: String,
    workspace_generation: u64,
    viewport: Option<TestViewport>,
}

/// 授权前确认：tab 当前所在 origin 必须等于用户选定的预期 origin。授权范围绑定当前工作区代际。
#[tauri::command]
pub async fn issue_test_target_grant(
    workspace: State<'_, WorkspaceAccessState>,
    browser: State<'_, BrowserSessionState>,
    grants: State<'_, TestTargetGrants>,
    request: IssueTestTargetGrantRequest,
) -> Result<TestTargetGrantInfo, String> {
    if request.run_id.trim().is_empty() || request.tab_id.trim().is_empty() {
        return Err("测试运行与 tab 标识不能为空".to_string());
    }
    let expected = origin_of(&request.expected_origin)?;
    let observed = origin_of(&current_tab_url(&browser, &request.tab_id).await?)?;
    if observed != expected {
        return Err("tab 当前 origin 与预期不一致，拒绝授权".to_string());
    }
    let root = authorized_root(&workspace)?;
    let generation = workspace.generation_for(&root);
    if let Some(viewport) = request.viewport {
        if !(320..=3840).contains(&viewport.width) || !(240..=2160).contains(&viewport.height) {
            return Err("测试视口尺寸超出允许范围".to_string());
        }
    }
    grants.issue(TestTargetGrant {
        run_id: request.run_id.clone(),
        tab_id: request.tab_id.clone(),
        origin: expected.clone(),
        workspace_path: root,
        workspace_generation: generation,
        viewport: request.viewport,
    })?;
    let viewport_result = apply_tab_viewport(
        &browser,
        &request.tab_id,
        request.viewport.map(|viewport| viewport.width),
        request.viewport.map(|viewport| viewport.height),
    )
    .await;
    if let Err(error) = viewport_result {
        let _ = grants.revoke_run(&request.run_id);
        return Err(error);
    }
    Ok(TestTargetGrantInfo {
        run_id: request.run_id,
        tab_id: request.tab_id,
        origin: expected,
        workspace_generation: generation,
        viewport: request.viewport,
    })
}

#[tauri::command]
pub async fn revoke_test_target_grant(
    browser: State<'_, BrowserSessionState>,
    grants: State<'_, TestTargetGrants>,
    run_id: String,
) -> Result<bool, String> {
    let Some(grant) = grants.take_run(&run_id)? else {
        return Ok(false);
    };
    if grant.viewport.is_some() {
        let _ = apply_tab_viewport(&browser, &grant.tab_id, None, None).await;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> TestTargetGrant {
        TestTargetGrant {
            run_id: "run-1".into(),
            tab_id: "tab-1".into(),
            origin: "https://shop.test".into(),
            workspace_path: PathBuf::from("/ws"),
            workspace_generation: 3,
            viewport: Some(TestViewport {
                width: 1280,
                height: 800,
            }),
        }
    }

    #[test]
    fn origin_keeps_scheme_host_and_non_default_port_only() {
        assert_eq!(
            origin_of("https://shop.test/checkout?x=1").unwrap(),
            "https://shop.test"
        );
        assert_eq!(
            origin_of("http://127.0.0.1:8080/a").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert!(origin_of("file:///etc/passwd").is_err());
        assert!(origin_of("not a url").is_err());
    }

    #[test]
    fn verify_fails_closed_without_a_grant() {
        let grants = TestTargetGrants::default();
        assert_eq!(
            grants.verify("run-1", "tab-1", "https://shop.test", Path::new("/ws"), 3),
            Err("没有有效的测试目标授权".to_string())
        );
    }

    #[test]
    fn verify_accepts_only_the_exact_bound_tuple() {
        let grants = TestTargetGrants::default();
        grants.issue(grant()).unwrap();
        assert!(grants
            .verify("run-1", "tab-1", "https://shop.test", Path::new("/ws"), 3)
            .is_ok());
    }

    #[test]
    fn each_bound_dimension_is_checked_independently() {
        let grants = TestTargetGrants::default();
        grants.issue(grant()).unwrap();
        let ws = Path::new("/ws");
        assert!(grants
            .verify("run-2", "tab-1", "https://shop.test", ws, 3)
            .is_err());
        assert!(grants
            .verify("run-1", "tab-9", "https://shop.test", ws, 3)
            .is_err());
        assert!(grants
            .verify("run-1", "tab-1", "https://evil.test", ws, 3)
            .is_err());
        assert!(grants
            .verify(
                "run-1",
                "tab-1",
                "https://shop.test",
                Path::new("/other"),
                3
            )
            .is_err());
        assert!(grants
            .verify("run-1", "tab-1", "https://shop.test", ws, 4)
            .is_err());
    }

    #[test]
    fn a_second_concurrent_run_is_refused() {
        let grants = TestTargetGrants::default();
        grants.issue(grant()).unwrap();
        assert!(grants
            .issue(TestTargetGrant {
                run_id: "run-2".into(),
                ..grant()
            })
            .is_err());
    }

    #[test]
    fn revoking_the_run_or_its_workspace_invalidates_the_grant() {
        let grants = TestTargetGrants::default();
        grants.issue(grant()).unwrap();
        assert_eq!(grants.revoke_run("other"), Ok(false));
        assert_eq!(grants.revoke_run("run-1"), Ok(true));
        assert!(grants
            .verify("run-1", "tab-1", "https://shop.test", Path::new("/ws"), 3)
            .is_err());

        grants.issue(grant()).unwrap();
        assert_eq!(grants.revoke_workspace(Path::new("/elsewhere")), Ok(false));
        assert_eq!(grants.revoke_workspace(Path::new("/ws")), Ok(true));
        assert!(grants.issue(grant()).is_ok(), "撤销后应能重新授权");
    }
}
