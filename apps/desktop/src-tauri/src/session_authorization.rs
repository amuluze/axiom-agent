//! 会话撤销代际：审批租约绑定「会话代际」，停止/撤销会话时递增，使该会话的旧
//! 租约失效（见 `workspace_approval.rs::consume_scoped`）。
//!
//! 历史：本模块曾同时承载「会话级资源授权」（VCS 凭据 15 分钟授权等）。随着原生
//! 确认与「完全访问」自动签发路径一起退役，资源授权已无创建入口，其 API、快照
//! 资源列表与撤销定向参数一并删除；仅保留代际校验——它仍是租约绑定的核心。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::sync::watch;

const MAX_SESSIONS: usize = 4096;

#[derive(Default)]
struct SessionEntry {
    generation: u64,
}

#[derive(Default)]
struct AuthorizationInner {
    sessions: HashMap<String, SessionEntry>,
}

#[derive(Clone)]
pub(crate) struct SessionAuthorizationState {
    inner: Arc<Mutex<AuthorizationInner>>,
    changes: watch::Sender<u64>,
}

impl Default for SessionAuthorizationState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(AuthorizationInner::default())),
            changes: watch::channel(0).0,
        }
    }
}

pub(crate) fn validate_session_id(session: &str) -> Result<(), String> {
    if session.is_empty()
        || session.len() > 160
        || !session
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':'))
    {
        return Err("会话标识不合法".into());
    }
    Ok(())
}

const AUTHORIZATION_INVALID: &str = "会话授权已撤销或发生变化，请重新发起";

impl SessionAuthorizationState {
    fn locked<T>(
        &self,
        body: impl FnOnce(&mut AuthorizationInner) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "会话授权锁不可用".to_string())?;
        body(&mut inner)
    }

    fn changed(&self) {
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    /// 取（并在首次访问时创建）会话代际。租约签发前记录，消费时复核。
    pub(crate) fn scope_generation(&self, session: &str) -> Result<u64, String> {
        validate_session_id(session)?;
        self.locked(|inner| {
            if !inner.sessions.contains_key(session) && inner.sessions.len() >= MAX_SESSIONS {
                return Err("会话授权状态达到上限".into());
            }
            let generation = inner.sessions.entry(session.into()).or_default().generation;
            if generation == u64::MAX {
                return Err(AUTHORIZATION_INVALID.into());
            }
            Ok(generation)
        })
    }

    /// 复核租约绑定的会话代际：代际已前移（停止/撤销）即拒绝。
    pub(crate) fn verify_scope_generation(
        &self,
        session: &str,
        generation: u64,
    ) -> Result<(), String> {
        validate_session_id(session)?;
        self.locked(|inner| {
            if inner
                .sessions
                .get(session)
                .is_some_and(|entry| entry.generation == generation && generation != u64::MAX)
            {
                Ok(())
            } else {
                Err(AUTHORIZATION_INVALID.into())
            }
        })
    }

    /// 递增目标会话代际：使该会话既有的全部审批租约失效（停止会话入口调用）。
    /// 只影响目标会话——多工作区并行会话互不干扰。
    pub(crate) fn revoke_session(&self, session: &str) -> Result<(), String> {
        validate_session_id(session)?;
        self.locked(|inner| {
            if let Some(entry) = inner.sessions.get_mut(session) {
                entry.generation = entry.generation.saturating_add(1);
            }
            Ok(())
        })?;
        self.changed();
        Ok(())
    }

    pub(crate) fn snapshot(
        &self,
        session: &str,
        sandbox_available: bool,
    ) -> Result<SessionAuthorizationSnapshot, String> {
        validate_session_id(session)?;
        self.locked(|inner| {
            let mut capabilities = vec!["workspace:read", "workspace:write"];
            if sandbox_available && cfg!(any(target_os = "macos", target_os = "linux")) {
                capabilities.push("workspace:execute");
            }
            Ok(SessionAuthorizationSnapshot {
                session_id: session.into(),
                generation: inner
                    .sessions
                    .get(session)
                    .map_or(0, |entry| entry.generation),
                capabilities,
            })
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionAuthorizationSnapshot {
    session_id: String,
    generation: u64,
    capabilities: Vec<&'static str>,
}

/// 渲染进程只能查询与撤销：不存在任何可由 WebView 直接调用的授予动作。
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SessionAuthorizationRequest {
    Snapshot { session_id: String },
    Revoke { session_id: String },
}

#[tauri::command]
pub(crate) async fn session_authorization_command(
    state: State<'_, SessionAuthorizationState>,
    request: SessionAuthorizationRequest,
) -> Result<SessionAuthorizationSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = match request {
            SessionAuthorizationRequest::Snapshot { session_id } => session_id,
            SessionAuthorizationRequest::Revoke { session_id } => {
                state.revoke_session(&session_id)?;
                session_id
            }
        };
        state.snapshot(&session, crate::sandbox::sandbox_available())
    })
    .await
    .map_err(|error| format!("会话授权任务中断：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 渲染进程只能查询与撤销：授予动作与多余字段一律拒绝（deny_unknown_fields）。
    #[test]
    fn renderer_can_query_and_revoke_but_cannot_supply_extra_fields() {
        for request in [
            json!({"action":"grant","sessionId":"s1"}),
            json!({"action":"snapshot","sessionId":"s1","capabilities":["workspace:execute"]}),
            json!({"action":"revoke","sessionId":"s1","resource":{"kind":"vcsCredentials"}}),
            json!({"action":"revoke","sessionId":"s1","allSessions":true}),
        ] {
            assert!(serde_json::from_value::<SessionAuthorizationRequest>(request).is_err());
        }
        assert!(serde_json::from_value::<SessionAuthorizationRequest>(
            json!({"action":"revoke","sessionId":"s1"})
        )
        .is_ok());
    }

    #[test]
    fn session_inputs_are_bounded() {
        let state = SessionAuthorizationState::default();
        for session in ["", " s1", "s1/s2", "s1\n", "中文"] {
            assert!(state.scope_generation(session).is_err());
        }
        assert!(state.scope_generation(&"s".repeat(161)).is_err());
        assert!(state.scope_generation("s_1:run-2").is_ok());
    }

    /// 撤销只使目标会话的旧代际失效——多工作区并行会话互不干扰。
    #[test]
    fn revocation_advances_only_the_target_session_generation() {
        let state = SessionAuthorizationState::default();
        let s1 = state.scope_generation("s1").unwrap();
        let s2 = state.scope_generation("s2").unwrap();
        state.revoke_session("s1").unwrap();
        assert!(state.verify_scope_generation("s1", s1).is_err());
        assert!(state.verify_scope_generation("s2", s2).is_ok());
        let renewed = state.scope_generation("s1").unwrap();
        assert!(state.verify_scope_generation("s1", renewed).is_ok());
        // 未登记会话一律拒绝（fail-closed）。
        assert!(state.verify_scope_generation("unknown", 0).is_err());
    }

    /// 快照只报代际与能力位：会话级特权授权已不存在，故不点亮任何额外能力。
    #[test]
    fn snapshot_reports_generation_and_capabilities_only() {
        let state = SessionAuthorizationState::default();
        state.scope_generation("s1").unwrap();
        let snapshot = state.snapshot("s1", false).unwrap();
        assert_eq!(snapshot.generation, 0);
        assert_eq!(
            snapshot.capabilities,
            vec!["workspace:read", "workspace:write"]
        );
        assert_eq!(
            state.snapshot("s1", true).unwrap().capabilities,
            vec!["workspace:read", "workspace:write", "workspace:execute"]
        );
        assert!(state.snapshot("", true).is_err());
    }

    /// 会话数上限与代际耗尽 fail-closed，不驱逐既有条目。
    #[test]
    fn capacity_and_generation_exhaustion_fail_closed() {
        let state = SessionAuthorizationState::default();
        state
            .locked(|inner| {
                for index in 0..MAX_SESSIONS {
                    inner
                        .sessions
                        .insert(format!("session-{index}"), SessionEntry::default());
                }
                Ok(())
            })
            .unwrap();
        assert!(state.scope_generation("overflow").is_err());
        assert!(state.scope_generation("session-0").is_ok());

        let exhausted = SessionAuthorizationState::default();
        exhausted
            .locked(|inner| {
                inner.sessions.insert(
                    "s1".into(),
                    SessionEntry {
                        generation: u64::MAX,
                    },
                );
                Ok(())
            })
            .unwrap();
        assert!(exhausted.scope_generation("s1").is_err());
        assert!(exhausted.verify_scope_generation("s1", u64::MAX).is_err());
    }
}
