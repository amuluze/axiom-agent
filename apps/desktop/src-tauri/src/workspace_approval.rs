use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::bash_policy_generated::MAX_TIMEOUT_MS;
use crate::{
    sandbox::{self, CommandTier},
    workspace_access::{authorized_root_for, WorkspaceAccessState},
};

const APPROVAL_LEASE_TTL: Duration = Duration::from_secs(60);
const MAX_APPROVAL_LEASES: usize = 64;
// **规范化后**的审批输入上限：内容规模已被规范化消掉（见 `canonicalize_value`），
// 该护栏拦的是「结构异常巨大」的输入（如海量短字段），超限一律拒绝签发。
const MAX_APPROVAL_INPUT_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;
// 规范化时以内容摘要参与绑定的字符串阈值（UTF-8 字节）：口径见
// `.specs/domain/workspace-authorization.md` 不变量 7——阈值与摘要形态都是口径的一部分。
const APPROVAL_STRING_INLINE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceApprovalRequest {
    session_id: String,
    run_id: String,
    tool_call_id: String,
    tool_name: String,
    input: Value,
    confirmation_mode: WorkspaceApprovalConfirmationMode,
    workspace_path: Option<String>,
}

/// 会话审批模式。原生确认退役后只剩两档：
/// - `Interactive`（标准）：写入与命令经审批卡片确认一次，始终在 OS 沙箱内执行；
/// - `Automatic`（完全访问）：无任何确认，命令不经沙箱直属。
///
/// 历史的 `SandboxSafe` / `Single` 逐请求单层值已随原生确认一并删除——它们曾经
/// 只用于区分「需要第二次原生手势」，而那道手势已不存在。
#[derive(Clone, Copy, Debug, Deserialize, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceApprovalConfirmationMode {
    #[default]
    Interactive,
    Automatic,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalScope {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) tool_call_id: String,
}

impl ApprovalScope {
    fn validate(&self) -> Result<(), String> {
        validate_scope_id(&self.session_id, "sessionId")?;
        validate_scope_id(&self.run_id, "runId")?;
        validate_scope_id(&self.tool_call_id, "toolCallId")
    }
}

struct ApprovalBinding {
    scope: Option<ApprovalScope>,
    session_generation: Option<u64>,
}

struct ApprovalLeaseInput {
    tool_name: String,
    input_digest: String,
    workspace_generation: u64,
    workspace_path: Option<String>,
    tier: Option<CommandTier>,
    confirmation_mode: WorkspaceApprovalConfirmationMode,
    mode_generation: u64,
}

struct WorkspaceApprovalLease {
    binding: ApprovalBinding,
    tool_name: String,
    input_digest: String,
    workspace_generation: u64,
    workspace_path: Option<String>,
    expires_at: Instant,
    /// 命令安全分级。仅 bash / run_workspace_command 的租约有值；
    /// 其余工具为 None。签发时由 Rust 权威分类，consume 时返回供执行分流。
    tier: Option<CommandTier>,
    confirmation_mode: WorkspaceApprovalConfirmationMode,
    mode_generation: u64,
}

#[derive(Clone, Copy)]
struct WorkspaceApprovalModeEntry {
    mode: WorkspaceApprovalConfirmationMode,
    generation: u64,
}

#[derive(Default)]
pub(crate) struct WorkspaceApprovalState {
    leases: Mutex<HashMap<String, WorkspaceApprovalLease>>,
    modes: Mutex<HashMap<String, WorkspaceApprovalModeEntry>>,
}

/// 会话模式只承载「交互确认 / 完全访问（自动）」两档；SandboxSafe 与 Single 是
/// 逐请求单层确认模式，已停用，不能作为会话状态。
fn validate_session_mode(mode: WorkspaceApprovalConfirmationMode) -> Result<(), String> {
    if !matches!(
        mode,
        WorkspaceApprovalConfirmationMode::Interactive
            | WorkspaceApprovalConfirmationMode::Automatic
    ) {
        return Err("会话审批模式只支持 interactive / automatic".into());
    }
    Ok(())
}

impl WorkspaceApprovalState {
    /// 写入 held 模式并返回新代际。`pub(crate)`：跨层联合测试（DB access_mode +
    /// held 模式 + 会话撤销代际）需要在仓储测试里直接布置动作前状态。
    pub(crate) fn set_mode(
        &self,
        session_id: &str,
        mode: WorkspaceApprovalConfirmationMode,
    ) -> Result<u64, String> {
        validate_scope_id(session_id, "sessionId")?;
        validate_session_mode(mode)?;
        let mut modes = self
            .modes
            .lock()
            .map_err(|_| "workspace approval state lock is poisoned".to_string())?;
        let entry = modes
            .entry(session_id.to_string())
            .or_insert(WorkspaceApprovalModeEntry {
                mode: WorkspaceApprovalConfirmationMode::Interactive,
                generation: 0,
            });
        entry.mode = mode;
        entry.generation = entry.generation.saturating_add(1);
        Ok(entry.generation)
    }

    /// 切换会话审批模式（标准 / 完全访问）。模式代际由 `set_mode` 递增，使既有
    /// Automatic 租约失效——降级后旧租约不得继续被消费。
    fn apply_mode(
        &self,
        session_id: &str,
        mode: WorkspaceApprovalConfirmationMode,
    ) -> Result<(), String> {
        validate_scope_id(session_id, "sessionId")?;
        validate_session_mode(mode)?;
        self.set_mode(session_id, mode).map(|_| ())
    }

    /// 当前 held 模式与代际；缺失条目等价标准模式。`pub(crate)` 理由同
    /// {@link Self::set_mode}。
    pub(crate) fn mode_snapshot(
        &self,
        session_id: &str,
    ) -> Result<(WorkspaceApprovalConfirmationMode, u64), String> {
        validate_scope_id(session_id, "sessionId")?;
        self.modes
            .lock()
            .map_err(|_| "workspace approval state lock is poisoned".to_string())
            .map(|modes| {
                modes
                    .get(session_id)
                    .map(|entry| (entry.mode, entry.generation))
                    .unwrap_or((WorkspaceApprovalConfirmationMode::Interactive, 0))
            })
    }

    /// 会话离开可运行生命周期时删除 held mode。缺失条目等价于标准模式，且旧
    /// Automatic 租约因代际快照不再匹配而无法消费。
    pub(crate) fn retire_session(&self, session_id: &str) -> Result<(), String> {
        validate_scope_id(session_id, "sessionId")?;
        self.modes
            .lock()
            .map_err(|_| "workspace approval state lock is poisoned".to_string())?
            .remove(session_id);
        Ok(())
    }
}

/// 自动签发的双重门：请求侧 Automatic 必须以用户在 Composer 显式选择的
/// 「完全访问」会话模式（held Automatic）为前提——受陷渲染进程无法绕过用户
/// 选择自行请求自动租约。
fn confirm_automatic_allowed(
    held_mode: WorkspaceApprovalConfirmationMode,
    requested_mode: WorkspaceApprovalConfirmationMode,
) -> Result<(), String> {
    if requested_mode == WorkspaceApprovalConfirmationMode::Automatic
        && held_mode != WorkspaceApprovalConfirmationMode::Automatic
    {
        return Err("自动审批需要用户在 Composer 显式选择完全访问模式".into());
    }
    Ok(())
}

fn validate_scope_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
        })
    {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn canonical_input(tool_name: &str, input: &Value) -> Result<Value, String> {
    Ok(canonicalize_value(&semantic_input(tool_name, input)?))
}

fn workspace_command_timeout(input: &Value) -> Result<Option<u64>, String> {
    let seconds = input.get("timeout").filter(|value| !value.is_null());
    let milliseconds = input.get("timeoutMs").filter(|value| !value.is_null());
    if seconds.is_some() && milliseconds.is_some() {
        return Err("workspace command must declare timeout or timeoutMs, not both".into());
    }
    let timeout = if let Some(seconds) = seconds {
        let milliseconds = seconds.as_f64().ok_or("timeout must be a number")? * 1_000.0;
        let rounded = milliseconds.round();
        if !milliseconds.is_finite()
            || rounded <= 0.0
            || (milliseconds - rounded).abs() > f64::EPSILON * milliseconds.abs().max(1.0) * 4.0
            || milliseconds > MAX_TIMEOUT_MS as f64
        {
            return Err(
                "timeout must resolve to a positive whole millisecond within the limit".into(),
            );
        }
        Some(rounded as u64)
    } else if let Some(milliseconds) = milliseconds {
        Some(
            milliseconds
                .as_u64()
                .filter(|timeout| *timeout > 0 && *timeout <= MAX_TIMEOUT_MS)
                .ok_or("timeoutMs must be a positive integer within the limit")?,
        )
    } else {
        None
    };
    Ok(timeout)
}

fn semantic_input(tool_name: &str, input: &Value) -> Result<Value, String> {
    if tool_name == "run_workspace_command" {
        // bash 工具采用自由命令模型：lease 必须精确绑定实际执行的命令字符串。
        let command = required_string(input, "command")?;
        return Ok(json!({
            "command": command,
            "cwd": input.get("cwd").and_then(Value::as_str),
            "timeoutMs": workspace_command_timeout(input)?,
            "vcsCredentials": command_privilege(input, "vcsCredentials")?,
            "containerControl": command_privilege(input, "containerControl")?,
        }));
    }
    Ok(input.clone())
}

/// 规范化的单射编码（口径见 `.specs/domain/workspace-authorization.md` 不变量 7）：
/// 长字符串以内容摘要参与绑定，使绑定输入的大小与内容规模无关；同时给字符串与对象
/// **不同标签**——若共用标签，真实对象 `{"@s": "x"}` 会与字符串 `"x"` 的编码同形，
/// 单射性失效（digest 碰撞）。
fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::String(text) if text.len() > APPROVAL_STRING_INLINE_BYTES => json!({
            "@sha256": format!("{:x}", Sha256::digest(text.as_bytes())),
            "@bytes": text.len(),
        }),
        Value::String(text) => json!({ "@s": text }),
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        Value::Object(map) => {
            // 键序不依赖 serde_json 的 Map 实现（preserve_order 可能被传递依赖开启）：
            // 显式按 UTF-8 字节序排序，保证「同一输入必得同一编码」。
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            let ordered: serde_json::Map<String, Value> = entries
                .into_iter()
                .map(|(key, item)| (key.clone(), canonicalize_value(item)))
                .collect();
            json!({ "@o": ordered })
        }
        scalar => scalar.clone(),
    }
}

pub(crate) fn canonical_input_digest(tool_name: &str, input: &Value) -> Result<String, String> {
    let input = canonical_input(tool_name, input)?;
    let encoded = serde_json::to_vec(&json!({ "toolName": tool_name, "input": input }))
        .map_err(|error| format!("failed to encode workspace approval input: {error}"))?;
    if encoded.len() > MAX_APPROVAL_INPUT_BYTES {
        return Err("workspace approval input exceeds the safe limit".into());
    }
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn command_privilege(input: &Value, field: &str) -> Result<bool, String> {
    match input.get(field) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(format!("{field} must be a boolean")),
    }
}

/// 高危命令判定的 TS 侧对应物：`bashTool.ts::isDangerousCommand`。Rust 侧不再做
/// 风险判定（原生确认已整体退役），但两侧词表的逐字一致性断言仍保留在
/// `scripts/bash-policy-audit.mjs` 的 TS 语料中。
fn validate_command_confirmation(
    input: &Value,
    mode: WorkspaceApprovalConfirmationMode,
    available: bool,
) -> Result<CommandTier, String> {
    let command = required_string(input, "command")?;
    // 完全访问：对齐 ChatGPT Full Access（Codex 的 danger-full-access）——命令
    // 不经沙箱，以宿主用户权限直跑。不做档位分类也不做特权门：沙箱已被绕开，
    // 档位与 vcsCredentials/containerControl 声明都失去了约束对象，网络、凭据与
    // 容器权限直接由宿主用户权限决定。这就是「把确认和沙箱一起关掉」的落点。
    if mode == WorkspaceApprovalConfirmationMode::Automatic {
        return Ok(CommandTier::Unrestricted);
    }
    let declared_network = input
        .get("network")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tier = sandbox::classify_command(command, declared_network);
    // 标准模式全档单层：分类仍决定沙箱档位（回环 / 出网），但不再触发任何原生
    // 确认——用户在审批卡片上点一次即可（卡片上的 danger 勾选框、命令预览与网络
    // 档说明仍由 TS 侧 isDangerousCommand 驱动）。沙箱不可用时 fail-closed。
    sandbox::command_network_policy(tier, available)?;
    Ok(tier)
}

fn required_string<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("workspace approval input is missing {field}"))
}

async fn confirm_full_access(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager as _;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut dialog = app
        .dialog()
        .message(
            "完全访问会在当前会话关闭 OS 沙箱并取消全部确认：命令以你的用户权限直接执行，可读写工作区之外的任意文件、读取或修改凭据与 Axiom 数据、发起任意网络请求——包括以本机存储的凭据（如 SSH 私钥）连接网络可达的远程机器并执行任意操作。命令文本的尽力拦截不构成安全边界。影响范围不限于这台机器，也覆盖它能触达的远程系统。仅在你完全信任当前任务与工作区内容时启用。",
        )
        .title("为当前会话启用完全访问（关闭沙箱）？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "启用完全访问".to_string(),
            "取消".to_string(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.show(move |confirmed| {
        let _ = sender.send(confirmed);
    });
    if receiver
        .await
        .map_err(|_| "访问模式确认对话框意外关闭".to_string())?
    {
        Ok(())
    } else {
        Err("用户取消启用完全访问".into())
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    crate::platform_process::fill_random(&mut bytes)
        .map_err(|error| format!("failed to generate workspace approval lease: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl WorkspaceApprovalState {
    #[cfg(test)]
    fn issue(
        &self,
        tool_name: String,
        input_digest: String,
        workspace_generation: u64,
        workspace_path: Option<String>,
        tier: Option<CommandTier>,
    ) -> Result<String, String> {
        self.issue_bound(
            ApprovalLeaseInput {
                tool_name,
                input_digest,
                workspace_generation,
                workspace_path,
                tier,
                confirmation_mode: WorkspaceApprovalConfirmationMode::Interactive,
                mode_generation: 0,
            },
            ApprovalBinding {
                scope: None,
                session_generation: None,
            },
        )
    }

    fn issue_scoped(
        &self,
        input: ApprovalLeaseInput,
        binding: ApprovalBinding,
    ) -> Result<String, String> {
        binding
            .scope
            .as_ref()
            .ok_or("审批调用身份缺失")?
            .validate()?;
        if binding.session_generation.is_none() {
            return Err("审批会话代际缺失".into());
        }
        self.issue_bound(input, binding)
    }

    fn issue_bound(
        &self,
        input: ApprovalLeaseInput,
        binding: ApprovalBinding,
    ) -> Result<String, String> {
        let token = random_token()?;
        let now = Instant::now();
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| "workspace approval state lock is poisoned".to_string())?;
        leases.retain(|_, lease| lease.expires_at > now);
        if leases.len() >= MAX_APPROVAL_LEASES {
            return Err("too many pending workspace approval leases".into());
        }
        leases.insert(
            token.clone(),
            WorkspaceApprovalLease {
                binding,
                tool_name: input.tool_name,
                input_digest: input.input_digest,
                workspace_generation: input.workspace_generation,
                workspace_path: input.workspace_path,
                expires_at: now + APPROVAL_LEASE_TTL,
                tier: input.tier,
                confirmation_mode: input.confirmation_mode,
                mode_generation: input.mode_generation,
            },
        );
        Ok(token)
    }

    #[cfg(test)]
    pub(crate) fn consume(
        &self,
        token: &str,
        tool_name: &str,
        input: Value,
        workspace_generation: u64,
        workspace_path: Option<&str>,
    ) -> Result<Option<CommandTier>, String> {
        self.consume_bound(
            token,
            tool_name,
            input,
            workspace_generation,
            workspace_path,
            None,
        )
    }

    pub(crate) fn consume_scoped(
        &self,
        token: &str,
        tool_name: &str,
        input: Value,
        workspace_generation: u64,
        workspace_path: Option<&str>,
        authority: (
            &ApprovalScope,
            &crate::session_authorization::SessionAuthorizationState,
        ),
    ) -> Result<Option<CommandTier>, String> {
        authority.0.validate()?;
        self.consume_bound(
            token,
            tool_name,
            input,
            workspace_generation,
            workspace_path,
            Some(authority),
        )
    }

    fn consume_bound(
        &self,
        token: &str,
        tool_name: &str,
        input: Value,
        workspace_generation: u64,
        workspace_path: Option<&str>,
        authority: Option<(
            &ApprovalScope,
            &crate::session_authorization::SessionAuthorizationState,
        )>,
    ) -> Result<Option<CommandTier>, String> {
        if token.len() != 64 || !token.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err("workspace approval lease is invalid".into());
        }
        let lease = self
            .leases
            .lock()
            .map_err(|_| "workspace approval state lock is poisoned".to_string())?
            .remove(token)
            .ok_or_else(|| "workspace approval lease is missing or already consumed".to_string())?;
        if lease.binding.scope.as_ref() != authority.map(|(scope, _)| scope) {
            return Err("审批租赁不属于本次会话、run 或工具调用".into());
        }
        if let Some((scope, authorizations)) = authority {
            authorizations.verify_scope_generation(
                &scope.session_id,
                lease.binding.session_generation.ok_or("审批会话代际缺失")?,
            )?;
            if lease.confirmation_mode == WorkspaceApprovalConfirmationMode::Automatic {
                let (_, current_generation) = self.mode_snapshot(&scope.session_id)?;
                if lease.mode_generation != current_generation {
                    return Err("访问模式已变化，自动审批租赁失效".into());
                }
            }
        }
        if lease.expires_at <= Instant::now() {
            return Err("workspace approval lease has expired".into());
        }
        if lease.workspace_generation != workspace_generation {
            return Err("workspace authorization changed after approval".into());
        }
        if lease.workspace_path.as_deref() != workspace_path {
            return Err("workspace approval lease belongs to another workspace".into());
        }
        if lease.tool_name != tool_name
            || lease.input_digest != canonical_input_digest(tool_name, &input)?
        {
            return Err("workspace approval lease does not match the requested operation".into());
        }
        Ok(lease.tier)
    }
}

#[tauri::command]
pub(crate) async fn set_workspace_approval_mode(
    app: tauri::AppHandle,
    approval_state: tauri::State<'_, WorkspaceApprovalState>,
    session_id: String,
    mode: WorkspaceApprovalConfirmationMode,
) -> Result<(), String> {
    let (held_mode, _) = approval_state.mode_snapshot(&session_id)?;
    if mode == WorkspaceApprovalConfirmationMode::Automatic
        && held_mode != WorkspaceApprovalConfirmationMode::Automatic
    {
        confirm_full_access(&app).await?;
    }
    approval_state.apply_mode(&session_id, mode)
}

#[tauri::command]
pub(crate) async fn request_workspace_approval_lease(
    _app: tauri::AppHandle,
    workspace_state: tauri::State<'_, WorkspaceAccessState>,
    approval_state: tauri::State<'_, WorkspaceApprovalState>,
    request: WorkspaceApprovalRequest,
) -> Result<String, String> {
    use tauri::Manager as _;
    validate_scope_id(&request.session_id, "sessionId")?;
    validate_scope_id(&request.run_id, "runId")?;
    validate_scope_id(&request.tool_call_id, "toolCallId")?;
    let (held_mode, mode_generation) = approval_state.mode_snapshot(&request.session_id)?;
    confirm_automatic_allowed(held_mode, request.confirmation_mode)?;
    let approval_input = request.input.clone();
    let authorizations = _app.state::<crate::session_authorization::SessionAuthorizationState>();
    let session_generation = authorizations.scope_generation(&request.session_id)?;
    let digest = canonical_input_digest(&request.tool_name, &approval_input)?;
    let workspace = authorized_root_for(&workspace_state, request.workspace_path.as_deref())?;
    let workspace_path = Some(workspace.to_string_lossy().into_owned());
    let workspace_generation = workspace_state.generation_for(&workspace);

    let lease_tier = if request.tool_name == "run_workspace_command" {
        Some(validate_command_confirmation(
            &request.input,
            request.confirmation_mode,
            sandbox::sandbox_available(),
        )?)
    } else if held_mode == WorkspaceApprovalConfirmationMode::Automatic {
        // 完全访问不只关确认，也关沙箱：写工具的租约同样标记为 Unrestricted，
        // 消费方据此放开工作区包含限制，改为只受敏感路径策略约束。
        // 判据是 held_mode（会话持有的用户选择），不是请求自报的
        // confirmation_mode——受陷渲染进程无法自报取到该档。
        Some(CommandTier::Unrestricted)
    } else {
        None
    };

    authorizations.verify_scope_generation(&request.session_id, session_generation)?;
    approval_state.issue_scoped(
        ApprovalLeaseInput {
            tool_name: request.tool_name,
            input_digest: digest,
            workspace_generation,
            workspace_path,
            tier: lease_tier,
            confirmation_mode: request.confirmation_mode,
            mode_generation,
        },
        ApprovalBinding {
            session_generation: Some(session_generation),
            scope: Some(ApprovalScope {
                session_id: request.session_id,
                run_id: request.run_id,
                tool_call_id: request.tool_call_id,
            }),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 完全访问对齐 ChatGPT Full Access：Automatic 档返回 Unrestricted（无沙箱、
    /// 无确认），且不再做特权门与网络档分类。标准模式全档单层：分类仍决定沙箱
    /// 档位，但不再触发任何原生确认。
    #[test]
    fn automatic_returns_unsandboxed_tier_while_standard_classifies() {
        let outbound = json!({ "command": "npm publish --dry-run", "network": true });
        let loopback = json!({ "command": "npm test" });
        // 标准模式：分类照旧（出网 / 回环），沙箱不可用时 fail-closed。
        assert_eq!(
            validate_command_confirmation(
                &outbound,
                WorkspaceApprovalConfirmationMode::Interactive,
                true,
            )
            .unwrap(),
            CommandTier::NetworkRequired
        );
        assert_eq!(
            validate_command_confirmation(
                &loopback,
                WorkspaceApprovalConfirmationMode::Interactive,
                true,
            )
            .unwrap(),
            CommandTier::SandboxSafe
        );
        assert!(validate_command_confirmation(
            &loopback,
            WorkspaceApprovalConfirmationMode::Interactive,
            false,
        )
        .is_err());
        // 完全访问：无沙箱档，不需要沙箱可用，也不因特权声明被拒。
        for input in [
            loopback.clone(),
            outbound.clone(),
            json!({ "command": "git push", "vcsCredentials": true }),
            json!({ "command": "docker compose up -d", "containerControl": true }),
        ] {
            assert_eq!(
                validate_command_confirmation(
                    &input,
                    WorkspaceApprovalConfirmationMode::Automatic,
                    false,
                )
                .unwrap(),
                CommandTier::Unrestricted,
                "完全访问恒返回无沙箱档：{input}"
            );
        }
    }
    #[test]
    fn state_mode_roundtrips_through_set_mode() {
        let state = WorkspaceApprovalState::default();
        assert_eq!(
            state.mode_snapshot("s1").unwrap(),
            (WorkspaceApprovalConfirmationMode::Interactive, 0),
            "未显式开启自动放行前必须保持 fail-closed 的 Interactive"
        );
        state
            .set_mode("s1", WorkspaceApprovalConfirmationMode::Automatic)
            .unwrap();
        assert_eq!(
            state.mode_snapshot("s1").unwrap().0,
            WorkspaceApprovalConfirmationMode::Automatic
        );
        assert_eq!(
            state.mode_snapshot("s2").unwrap().0,
            WorkspaceApprovalConfirmationMode::Interactive,
            "会话模式不得串扰"
        );
        // 此处曾用 SandboxSafe 断言「逐请求模式不能作为会话状态」；该变体已随原生
        // 确认删除，枚举只剩 Interactive / Automatic 两个合法值，故不再有可构造的
        // 非法会话模式可供断言。
        state
            .set_mode("s1", WorkspaceApprovalConfirmationMode::Interactive)
            .unwrap();
        assert_eq!(
            state.mode_snapshot("s1").unwrap().0,
            WorkspaceApprovalConfirmationMode::Interactive
        );
    }

    #[test]
    fn mode_change_invalidates_automatic_lease() {
        let state = WorkspaceApprovalState::default();
        let authorizations = crate::session_authorization::SessionAuthorizationState::default();
        let scope = ApprovalScope {
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            tool_call_id: "call-1".into(),
        };
        let session_generation = authorizations.scope_generation(&scope.session_id).unwrap();
        let mode_generation = state
            .set_mode(
                &scope.session_id,
                WorkspaceApprovalConfirmationMode::Automatic,
            )
            .unwrap();
        let input = json!({ "path": "src/main.ts", "content": "hello" });
        let token = state
            .issue_scoped(
                ApprovalLeaseInput {
                    tool_name: "create_workspace_file".into(),
                    input_digest: canonical_input_digest("create_workspace_file", &input).unwrap(),
                    workspace_generation: 3,
                    workspace_path: Some("/repo".into()),
                    tier: None,
                    confirmation_mode: WorkspaceApprovalConfirmationMode::Automatic,
                    mode_generation,
                },
                ApprovalBinding {
                    scope: Some(scope.clone()),
                    session_generation: Some(session_generation),
                },
            )
            .unwrap();

        state
            .set_mode(
                &scope.session_id,
                WorkspaceApprovalConfirmationMode::Interactive,
            )
            .unwrap();
        let error = state
            .consume_scoped(
                &token,
                "create_workspace_file",
                input,
                3,
                Some("/repo"),
                (&scope, &authorizations),
            )
            .unwrap_err();
        assert!(
            error.contains("访问模式已变化"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn retiring_session_removes_full_access_and_invalidates_automatic_lease() {
        let state = WorkspaceApprovalState::default();
        let authorizations = crate::session_authorization::SessionAuthorizationState::default();
        let scope = ApprovalScope {
            session_id: "session-retired".into(),
            run_id: "run-1".into(),
            tool_call_id: "call-1".into(),
        };
        let session_generation = authorizations.scope_generation(&scope.session_id).unwrap();
        let mode_generation = state
            .set_mode(
                &scope.session_id,
                WorkspaceApprovalConfirmationMode::Automatic,
            )
            .unwrap();
        let input = json!({ "path": "src/main.ts", "content": "hello" });
        let token = state
            .issue_scoped(
                ApprovalLeaseInput {
                    tool_name: "create_workspace_file".into(),
                    input_digest: canonical_input_digest("create_workspace_file", &input).unwrap(),
                    workspace_generation: 3,
                    workspace_path: Some("/repo".into()),
                    tier: None,
                    confirmation_mode: WorkspaceApprovalConfirmationMode::Automatic,
                    mode_generation,
                },
                ApprovalBinding {
                    scope: Some(scope.clone()),
                    session_generation: Some(session_generation),
                },
            )
            .unwrap();

        state.retire_session(&scope.session_id).unwrap();
        assert_eq!(
            state.mode_snapshot(&scope.session_id).unwrap(),
            (WorkspaceApprovalConfirmationMode::Interactive, 0)
        );
        assert!(state
            .consume_scoped(
                &token,
                "create_workspace_file",
                input,
                3,
                Some("/repo"),
                (&scope, &authorizations),
            )
            .unwrap_err()
            .contains("访问模式已变化"));
    }

    #[test]
    fn consumes_only_one_matching_lease() {
        let state = WorkspaceApprovalState::default();
        let input = json!({ "path": "src/main.ts", "content": "hello" });
        let digest = canonical_input_digest("create_workspace_file", &input).unwrap();
        let token = state
            .issue(
                "create_workspace_file".into(),
                digest,
                3,
                Some("/repo".into()),
                None,
            )
            .unwrap();

        state
            .consume(
                &token,
                "create_workspace_file",
                input.clone(),
                3,
                Some("/repo"),
            )
            .unwrap();
        assert!(state
            .consume(&token, "create_workspace_file", input, 3, Some("/repo"))
            .is_err());
    }

    #[test]
    fn burns_a_lease_on_workspace_drift() {
        let state = WorkspaceApprovalState::default();
        let input = json!({ "recoveryId": "recovery-1" });
        let digest = canonical_input_digest("restore_workspace_trash", &input).unwrap();
        let token = state
            .issue(
                "restore_workspace_trash".into(),
                digest,
                4,
                Some("/repo".into()),
                None,
            )
            .unwrap();

        assert!(state
            .consume(
                &token,
                "restore_workspace_trash",
                input,
                4,
                Some("/other-repo"),
            )
            .is_err());
        assert!(state
            .consume(
                &token,
                "restore_workspace_trash",
                json!({ "recoveryId": "recovery-1" }),
                4,
                Some("/repo"),
            )
            .is_err());
    }

    #[test]
    fn sandbox_lease_returns_bound_tier() {
        let state = WorkspaceApprovalState::default();
        // SandboxSafe 租约：tier 存 lease，consume 时原样返回
        let issued = json!({ "command": "npm test", "cwd": ".", "timeout": 30 });
        let token = state
            .issue(
                "run_workspace_command".into(),
                canonical_input_digest("run_workspace_command", &issued).unwrap(),
                1,
                None,
                Some(CommandTier::SandboxSafe),
            )
            .unwrap();
        assert_eq!(
            state
                .consume(
                    &token,
                    "run_workspace_command",
                    json!({ "command": "npm test", "cwd": ".", "timeoutMs": 30_000 }),
                    1,
                    None,
                )
                .unwrap(),
            Some(CommandTier::SandboxSafe)
        );

        // 非沙箱租约（写文件工具）无 tier → None
        let input = json!({ "path": "a.txt" });
        let token = state
            .issue(
                "create_workspace_file".into(),
                canonical_input_digest("create_workspace_file", &input).unwrap(),
                1,
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            state
                .consume(&token, "create_workspace_file", input, 1, None)
                .unwrap(),
            None
        );
    }

    #[test]
    fn command_lease_rejects_privilege_tampering_and_reuse() {
        let state = WorkspaceApprovalState::default();
        let issued = json!({ "command": "git fetch", "cwd": ".", "vcsCredentials": true, "containerControl": false });
        let issue = || {
            state
                .issue(
                    "run_workspace_command".into(),
                    canonical_input_digest("run_workspace_command", &issued).unwrap(),
                    1,
                    Some("/repo".into()),
                    Some(CommandTier::NetworkRequired),
                )
                .unwrap()
        };
        for field in ["vcsCredentials", "containerControl"] {
            let token = issue();
            let mut tampered = issued.clone();
            tampered[field] = json!(!issued[field].as_bool().unwrap());
            assert!(state
                .consume(&token, "run_workspace_command", tampered, 1, Some("/repo"))
                .is_err());
        }
        let token = issue();
        assert_eq!(
            state
                .consume(
                    &token,
                    "run_workspace_command",
                    issued.clone(),
                    1,
                    Some("/repo")
                )
                .unwrap(),
            Some(CommandTier::NetworkRequired)
        );
        assert!(state
            .consume(&token, "run_workspace_command", issued, 1, Some("/repo"))
            .is_err());
    }

    #[test]
    fn command_lease_closes_loop_across_frontend_and_backend_input_shapes() {
        let state = WorkspaceApprovalState::default();
        // 签发侧 input 来自前端 bash 工具参数 { command, cwd, timeout（秒） }，
        // 消费侧 input 来自 run_workspace_command 的 { command, cwd, timeoutMs（毫秒） }。
        let issued = json!({
            "command": "npm test -- --coverage",
            "cwd": "apps/desktop",
            "timeout": 120,
        });
        let consumed = json!({
            "command": "npm test -- --coverage",
            "cwd": "apps/desktop",
            "timeoutMs": 120_000,
        });
        let token = state
            .issue(
                "run_workspace_command".into(),
                canonical_input_digest("run_workspace_command", &issued).unwrap(),
                1,
                Some("/repo".into()),
                None,
            )
            .unwrap();
        state
            .consume(&token, "run_workspace_command", consumed, 1, Some("/repo"))
            .unwrap();
    }

    #[test]
    fn command_lease_rejects_a_different_command_string() {
        let state = WorkspaceApprovalState::default();
        let issued = json!({ "command": "git status --short", "cwd": "." });
        let token = state
            .issue(
                "run_workspace_command".into(),
                canonical_input_digest("run_workspace_command", &issued).unwrap(),
                1,
                None,
                None,
            )
            .unwrap();
        assert!(state
            .consume(
                &token,
                "run_workspace_command",
                json!({ "command": "git push --force", "cwd": "." }),
                1,
                None,
            )
            .is_err());
    }

    #[test]
    fn command_lease_normalizes_timeout_units() {
        let state = WorkspaceApprovalState::default();
        // 签发侧缺失 cwd（前端未提供）与消费侧显式 null（Rust 序列化）必须归一化一致；
        // timeout（秒）与 timeoutMs（毫秒）字段形状差异不影响绑定。
        let issued = json!({ "command": "ls -la", "timeout": 30 });
        let token = state
            .issue(
                "run_workspace_command".into(),
                canonical_input_digest("run_workspace_command", &issued).unwrap(),
                1,
                None,
                None,
            )
            .unwrap();
        state
            .consume(
                &token,
                "run_workspace_command",
                json!({ "command": "ls -la", "cwd": null, "timeoutMs": 30_000 }),
                1,
                None,
            )
            .unwrap();
    }

    #[test]
    fn command_lease_rejects_changed_removed_or_added_timeout() {
        for (issued, consumed) in [
            (
                json!({ "command": "ls -la", "timeout": 30 }),
                json!({ "command": "ls -la", "timeoutMs": 60_000 }),
            ),
            (
                json!({ "command": "ls -la", "timeout": 30 }),
                json!({ "command": "ls -la", "timeoutMs": null }),
            ),
            (
                json!({ "command": "ls -la", "timeout": 30 }),
                json!({ "command": "ls -la" }),
            ),
            (
                json!({ "command": "ls -la" }),
                json!({ "command": "ls -la", "timeoutMs": 30_000 }),
            ),
        ] {
            let state = WorkspaceApprovalState::default();
            let token = state
                .issue(
                    "run_workspace_command".into(),
                    canonical_input_digest("run_workspace_command", &issued).unwrap(),
                    1,
                    None,
                    None,
                )
                .unwrap();
            assert!(state
                .consume(&token, "run_workspace_command", consumed, 1, None)
                .is_err());
        }
    }

    #[test]
    fn command_timeout_rejects_ambiguous_or_invalid_values() {
        for input in [
            json!({ "timeout": 30, "timeoutMs": 30_000 }),
            json!({ "timeout": "30" }),
            json!({ "timeout": 0.0001 }),
            json!({ "timeout": 0 }),
            json!({ "timeout": -1 }),
            json!({ "timeout": 2_147_483.648 }),
            json!({ "timeoutMs": 1.1 }),
            json!({ "timeoutMs": 0 }),
            json!({ "timeoutMs": 2_147_483_648_u64 }),
        ] {
            assert!(workspace_command_timeout(&input).is_err(), "{input}");
        }
        assert_eq!(
            workspace_command_timeout(&json!({ "timeout": 0.001 })).unwrap(),
            Some(1)
        );
        assert_eq!(
            workspace_command_timeout(&json!({ "timeout": 0.029 })).unwrap(),
            Some(29)
        );
        assert_eq!(
            workspace_command_timeout(&json!({ "timeoutMs": 2_147_483_647 })).unwrap(),
            Some(2_147_483_647)
        );
        assert_eq!(
            workspace_command_timeout(&json!({ "timeout": null, "timeoutMs": null })).unwrap(),
            None
        );
    }

    // ---- 规范化口径（.specs/domain/workspace-authorization.md 不变量 7）----

    fn digest_of(input: &Value) -> String {
        canonical_input_digest("create_workspace_file", input).unwrap()
    }

    fn digest_for(tool_name: &str, input: &Value) -> String {
        canonical_input_digest(tool_name, input).unwrap()
    }

    fn encoded_len_of_content(content: String) -> usize {
        serde_json::to_vec(
            &canonical_input(
                "create_workspace_file",
                &json!({ "path": "p.ax", "content": content }),
            )
            .unwrap(),
        )
        .unwrap()
        .len()
    }

    #[test]
    fn canonical_input_accepts_multi_megabyte_content() {
        // 8 MiB 与 1 MiB 都在阈值之上：编码规模必须完全相等（仅摘要值不同）。
        assert_eq!(
            encoded_len_of_content("x".repeat(8 * 1024 * 1024)),
            encoded_len_of_content("y".repeat(1024 * 1024))
        );
        assert!(canonical_input_digest(
            "create_workspace_file",
            &json!({ "path": "p.ax", "content": "x".repeat(8 * 1024 * 1024) }),
        )
        .is_ok());
    }

    #[test]
    fn canonical_input_binds_content_bytes() {
        let base = json!({ "path": "p.ax", "content": "a".repeat(2 * 1024 * 1024) });
        let same = json!({ "path": "p.ax", "content": "a".repeat(2 * 1024 * 1024) });
        let changed = json!({
            "path": "p.ax",
            "content": format!("{}b", "a".repeat(2 * 1024 * 1024)),
        });
        let other_path = json!({ "path": "q.ax", "content": "a".repeat(2 * 1024 * 1024) });
        assert_eq!(digest_of(&base), digest_of(&same));
        assert_ne!(digest_of(&base), digest_of(&changed));
        assert_ne!(digest_of(&base), digest_of(&other_path));
    }

    #[test]
    fn canonicalization_distinguishes_short_string_from_object() {
        assert_ne!(
            digest_of(&json!({ "content": "x" })),
            digest_of(&json!({ "content": { "@s": "x" } }))
        );
    }

    #[test]
    fn canonicalization_is_injective_for_object_shapes() {
        let long = "s".repeat(APPROVAL_STRING_INLINE_BYTES + 1);
        let content_digest = format!("{:x}", Sha256::digest(long.as_bytes()));
        let cases = [
            json!({ "content": long.clone() }),
            json!({ "content": { "@sha256": content_digest, "@bytes": APPROVAL_STRING_INLINE_BYTES + 1 } }),
            json!({ "content": { "@s": long.clone() } }),
            json!({ "content": { "@o": {} } }),
        ];
        for (index, left) in cases.iter().enumerate() {
            for (other_index, right) in cases.iter().enumerate() {
                if index != other_index {
                    assert_ne!(
                        digest_of(left),
                        digest_of(right),
                        "cases {index} and {other_index} collided"
                    );
                }
            }
        }
    }

    #[test]
    fn canonical_input_normalizes_nested_operations() {
        let base = json!({
            "operations": [{ "path": "a.txt", "content": "z".repeat(2 * 1024 * 1024) }],
        });
        let other = json!({
            "operations": [{ "path": "b.txt", "content": "z".repeat(2 * 1024 * 1024) }],
        });
        assert!(canonical_input_digest("apply_workspace_changes", &base).is_ok());
        assert_ne!(
            digest_for("apply_workspace_changes", &base),
            digest_for("apply_workspace_changes", &other)
        );
    }

    #[test]
    fn canonical_input_rejects_oversized_structure() {
        // 内容规模已被规范化消掉，但「结构异常巨大」的输入仍必须 fail-closed。
        let mut map = serde_json::Map::new();
        for index in 0..200_000 {
            map.insert(format!("key{index}"), json!("v".repeat(20)));
        }
        let error =
            canonical_input_digest("create_workspace_file", &Value::Object(map)).unwrap_err();
        assert_eq!(error, "workspace approval input exceeds the safe limit");
    }

    #[test]
    fn canonicalization_string_threshold_boundary() {
        let inline = "t".repeat(APPROVAL_STRING_INLINE_BYTES);
        let hashed = "t".repeat(APPROVAL_STRING_INLINE_BYTES + 1);
        assert_eq!(
            canonical_input(
                "create_workspace_file",
                &json!({ "content": inline.clone() })
            )
            .unwrap(),
            json!({ "@o": { "content": { "@s": inline } } })
        );
        assert_eq!(
            canonical_input(
                "create_workspace_file",
                &json!({ "content": hashed.clone() })
            )
            .unwrap(),
            json!({ "@o": { "content": {
                "@sha256": format!("{:x}", Sha256::digest(hashed.as_bytes())),
                "@bytes": APPROVAL_STRING_INLINE_BYTES + 1,
            } } })
        );
    }

    #[test]
    fn canonicalization_is_deterministic_and_key_order_agnostic() {
        let mut first = serde_json::Map::new();
        first.insert("b".into(), json!("1"));
        first.insert("a".into(), json!("2"));
        let mut second = serde_json::Map::new();
        second.insert("a".into(), json!("2"));
        second.insert("b".into(), json!("1"));
        assert_eq!(
            canonical_input("create_workspace_file", &Value::Object(first)).unwrap(),
            canonical_input("create_workspace_file", &Value::Object(second)).unwrap()
        );
        // 数组顺序参与绑定（与对象键序不同）。
        assert_ne!(
            digest_of(&json!({ "operations": [1, 2] })),
            digest_of(&json!({ "operations": [2, 1] }))
        );
    }

    #[test]
    fn canonicalization_keeps_scalars_and_empty_containers() {
        assert_eq!(
            canonical_input(
                "create_workspace_file",
                &json!({ "size": 3, "flag": true, "note": null }),
            )
            .unwrap(),
            json!({ "@o": { "size": 3, "flag": true, "note": null } })
        );
        assert_eq!(
            canonical_input("create_workspace_file", &json!({ "items": [], "meta": {} })).unwrap(),
            json!({ "@o": { "items": [], "meta": { "@o": {} } } })
        );
    }
}
