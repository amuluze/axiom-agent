use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::{
    sandbox::{self, CommandTier},
    workspace_access::{authorized_root_for, WorkspaceAccessState},
};

const APPROVAL_LEASE_TTL: Duration = Duration::from_secs(60);
const MAX_APPROVAL_LEASES: usize = 64;
const MAX_APPROVAL_INPUT_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;

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

#[derive(Clone, Copy, Debug, Deserialize, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceApprovalConfirmationMode {
    #[default]
    Interactive,
    Automatic,
    /// 单层 UI 审批：bash 专用（出网不单独设卡）。tier 由 Rust 权威分类并绑定 lease，
    /// 不信任前端自报（与 Automatic 同级特权模式，fail-closed）。
    SandboxSafe,
    /// SSH 远程执行的「会话内已授权主机」签发模式：仅对 run_ssh_command 生效，
    /// 且必须命中 ssh_agent 的 Rust 权威授权表（由原生对话框「本会话内允许」
    /// 写入）。渲染进程自报本模式而无真实授权时 fail-closed 拒绝。
    SshSessionGranted,
}

struct WorkspaceApprovalLease {
    tool_name: String,
    input_digest: String,
    workspace_generation: u64,
    workspace_path: Option<String>,
    expires_at: Instant,
    /// 命令安全分级。仅 bash / run_workspace_command 的 SandboxSafe 租约有值；
    /// 其余工具为 None。签发时由 Rust 权威分类，consume 时返回供执行分流。
    tier: Option<CommandTier>,
}

#[derive(Default)]
pub(crate) struct WorkspaceApprovalState {
    leases: Mutex<HashMap<String, WorkspaceApprovalLease>>,
    /// Rust 权威的审批模式：只有用户通过 access-mode 显式开启自动放行后，
    /// 前端才能以 automatic 模式签发租约。默认为 Interactive（逐次审批），fail-closed。
    mode: Mutex<WorkspaceApprovalConfirmationMode>,
}

impl WorkspaceApprovalState {
    fn set_mode(&self, mode: WorkspaceApprovalConfirmationMode) -> Result<(), String> {
        *self
            .mode
            .lock()
            .map_err(|_| "workspace approval state lock is poisoned".to_string())? = mode;
        Ok(())
    }

    fn mode(&self) -> Result<WorkspaceApprovalConfirmationMode, String> {
        self.mode
            .lock()
            .map_err(|_| "workspace approval state lock is poisoned".to_string())
            .map(|mode| *mode)
    }
}

fn confirm_automatic_allowed(
    held_mode: WorkspaceApprovalConfirmationMode,
    requested_mode: WorkspaceApprovalConfirmationMode,
) -> Result<(), String> {
    if requested_mode == WorkspaceApprovalConfirmationMode::Automatic
        && held_mode != WorkspaceApprovalConfirmationMode::Automatic
    {
        return Err(
            "automatic approval is not enabled; select an auto-approval access mode first"
                .to_string(),
        );
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
    if tool_name == "run_workspace_command" {
        // bash 工具采用自由命令模型：lease 必须精确绑定实际执行的命令字符串。
        // 只归一化 command + cwd，忽略超时字段——签发侧（前端参数 `timeout`，秒）
        // 与消费侧（Rust `WorkspaceCommandRequest.timeoutMs`，毫秒）字段名/单位不一致，
        // 但超时不构成安全语义，不参与绑定。
        let command = required_string(input, "command")?;
        return Ok(json!({
            "command": command,
            "cwd": input.get("cwd").and_then(Value::as_str),
        }));
    }
    if tool_name == "run_ssh_command" {
        // SSH 远程执行绑定「目标主机 + 命令」；超时同 bash 不参与绑定。
        let host = required_string(input, "host")?;
        let command = required_string(input, "command")?;
        return Ok(json!({
            "host": host,
            "command": command,
        }));
    }
    Ok(input.clone())
}

fn canonical_input_digest(tool_name: &str, input: &Value) -> Result<String, String> {
    let input = canonical_input(tool_name, input)?;
    let encoded = serde_json::to_vec(&json!({ "toolName": tool_name, "input": input }))
        .map_err(|error| format!("failed to encode workspace approval input: {error}"))?;
    if encoded.len() > MAX_APPROVAL_INPUT_BYTES {
        return Err("workspace approval input exceeds the safe limit".into());
    }
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn required_string<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("workspace approval input is missing {field}"))
}

/// 对话框文案总长度兜底：截断到 500 字符，避免原生对话框过长。
fn bounded_dialog_message(message: &str) -> String {
    let mut result = message.chars().take(500).collect::<String>();
    if message.chars().count() > 500 {
        result.push('…');
    }
    result
}

/// 单段内容预览：字符截断并追加省略提示。
fn bounded_preview(text: &str, max_chars: usize) -> String {
    let mut result = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        result.push_str("…[预览已截断]");
    }
    result
}

/// apply_workspace_changes 的单条操作摘要行。
fn summarize_change_operation(operation: &Value) -> Option<String> {
    let kind = operation.get("type").and_then(Value::as_str)?;
    match kind {
        "create-file" => {
            let path = operation.get("path").and_then(Value::as_str)?;
            Some(format!("新建文件 {path}"))
        }
        "patch-file" => {
            let path = operation.get("path").and_then(Value::as_str)?;
            let removed = operation
                .get("oldText")
                .and_then(Value::as_str)
                .unwrap_or("")
                .lines()
                .count();
            let added = operation
                .get("newText")
                .and_then(Value::as_str)
                .unwrap_or("")
                .lines()
                .count();
            Some(format!("修改文件 {path}（-{removed}/+{added} 行）"))
        }
        "create-directory" => {
            let path = operation.get("path").and_then(Value::as_str)?;
            Some(format!("新建目录 {path}"))
        }
        "move" => {
            let from = operation.get("from").and_then(Value::as_str)?;
            let to = operation.get("to").and_then(Value::as_str)?;
            Some(format!("移动 {from} → {to}"))
        }
        "trash" => {
            let path = operation.get("path").and_then(Value::as_str)?;
            Some(format!("删除（可恢复）{path}"))
        }
        _ => None,
    }
}

const MAX_CHANGE_OPERATION_ROWS: usize = 8;
const MAX_EDIT_PREVIEW_ROWS: usize = 3;
const PREVIEW_CHARS: usize = 240;

/// 为 Rust 侧原生审批对话框构造人类可读的操作摘要。纯函数，便于单元测试。
/// 审批数据（命令/路径/内容/操作列表）全在 `request.input` 中且已被 SHA-256 绑定，
/// 此处只做展示增强，不参与 lease 绑定语义。
fn approval_dialog_message(request: &WorkspaceApprovalRequest) -> String {
    let (label, detail) = match request.tool_name.as_str() {
        "run_workspace_command" => (
            "执行命令",
            request
                .input
                .get("command")
                .and_then(Value::as_str)
                .map(|command| format!("命令：{command}")),
        ),
        "create_workspace_file" => (
            "创建文件",
            request.input.get("path").and_then(Value::as_str).map(|path| {
                let preview = request
                    .input
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|content| format!("\n写入内容预览：{}", bounded_preview(content, PREVIEW_CHARS)));
                format!("路径：{path}{}", preview.unwrap_or_default())
            }),
        ),
        "edit_workspace_file" => (
            "修改文件",
            request.input.get("path").and_then(Value::as_str).map(|path| {
                let summary = request
                    .input
                    .get("edits")
                    .and_then(Value::as_array)
                    .map(|edits| {
                        let rows: Vec<String> = edits
                            .iter()
                            .take(MAX_EDIT_PREVIEW_ROWS)
                            .map(|edit| {
                                let old = edit.get("oldText").and_then(Value::as_str).unwrap_or("");
                                let new = edit.get("newText").and_then(Value::as_str).unwrap_or("");
                                format!(
                                    "替换：{} → {}",
                                    bounded_preview(old, PREVIEW_CHARS),
                                    bounded_preview(new, PREVIEW_CHARS)
                                )
                            })
                            .collect();
                        let mut body = rows.join("\n");
                        if edits.len() > MAX_EDIT_PREVIEW_ROWS {
                            body.push_str(&format!(
                                "\n… 其余 {} 处替换省略",
                                edits.len() - MAX_EDIT_PREVIEW_ROWS
                            ));
                        }
                        format!("\n{body}")
                    });
                format!("路径：{path}{}", summary.unwrap_or_default())
            }),
        ),
        "apply_workspace_changes" => (
            "批量应用工作区改动",
            request
                .input
                .get("operations")
                .and_then(Value::as_array)
                .map(|operations| {
                    let mut body = String::new();
                    for (index, operation) in operations.iter().take(MAX_CHANGE_OPERATION_ROWS).enumerate() {
                        let line = summarize_change_operation(operation).unwrap_or_else(|| "未知操作".to_string());
                        body.push_str(&format!("{}. {line}\n", index + 1));
                    }
                    if operations.len() > MAX_CHANGE_OPERATION_ROWS {
                        body.push_str(&format!(
                            "… 其余 {} 条操作省略（共 {} 条）",
                            operations.len() - MAX_CHANGE_OPERATION_ROWS,
                            operations.len()
                        ));
                    }
                    body.pop();
                    body
                }),
        ),
        "restore_workspace_trash" => (
            "恢复工作区删除",
            request
                .input
                .get("recoveryId")
                .and_then(Value::as_str)
                .map(|recovery_id| format!("恢复批次：{recovery_id}")),
        ),
        "run_ssh_command" => (
            "SSH 远程执行",
            request.input.get("host").and_then(Value::as_str).map(|host| {
                let command = request
                    .input
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                format!("主机：{host}\n命令：{}", bounded_preview(command, PREVIEW_CHARS))
            }),
        ),
        other => (other, None),
    };
    let message = match detail {
        Some(detail) => format!("{label}\n{detail}\n\n此操作仅允许执行一次。"),
        None => format!("{label}\n\n此操作仅允许执行一次。"),
    };
    bounded_dialog_message(&message)
}

/// Interactive（逐次审批）的确认收敛到 Rust 侧原生对话框：用户在系统级对话框
/// 点“允许”后才由调用方签发 lease token。受陷渲染进程无法伪造该用户手势。
/// 用非阻塞 `show` + oneshot 等待，避免阻塞 async runtime 线程导致应用卡死。
///
/// 对话框必须绑定主窗口作为 parent：否则 rfd 会退化为 CFUserNotification 用户
/// 通知（无 parent 分支），其窗口不属于常规 AX 可访问树（无障碍不可用，且无人
/// 值守自动化无法驱动）。绑定 parent 后走 NSAlert sheet，AX 可读且可自动测试。
async fn confirm_interactive(app: &tauri::AppHandle, request: &WorkspaceApprovalRequest) -> Result<(), String> {
    use tauri::Manager as _;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut dialog = app.dialog()
        .message(approval_dialog_message(request))
        .title("Axiom 请求批准操作")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("允许".to_string(), "拒绝".to_string()));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.show(move |confirmed| {
        let _ = sender.send(confirmed);
    });
    let confirmed = receiver
        .await
        .map_err(|_| "审批对话框意外关闭".to_string())?;
    if !confirmed {
        return Err("用户在系统审批对话框中拒绝了该操作".into());
    }
    Ok(())
}



fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    crate::platform_process::fill_random(&mut bytes)
        .map_err(|error| format!("failed to generate workspace approval lease: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl WorkspaceApprovalState {
    fn issue(
        &self,
        tool_name: String,
        input_digest: String,
        workspace_generation: u64,
        workspace_path: Option<String>,
        tier: Option<CommandTier>,
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
                tool_name,
                input_digest,
                workspace_generation,
                workspace_path,
                expires_at: now + APPROVAL_LEASE_TTL,
                tier,
            },
        );
        Ok(token)
    }

    pub(crate) fn consume(
        &self,
        token: &str,
        tool_name: &str,
        input: Value,
        workspace_generation: u64,
        workspace_path: Option<&str>,
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
    _app: tauri::AppHandle,
    approval_state: tauri::State<'_, WorkspaceApprovalState>,
    mode: WorkspaceApprovalConfirmationMode,
) -> Result<(), String> {
    let held_mode = approval_state.mode()?;
    // 自动放行是安全模式跃迁：从逐次审批切到自动放行必须经系统级对话框确认，
    // 防止受陷渲染进程无条件置 automatic 从而绕过逐次审批。
    // e2e 构建由无人值守的故障注入脚本驱动，旁路该对话框。
    if mode == WorkspaceApprovalConfirmationMode::Automatic
        && held_mode != WorkspaceApprovalConfirmationMode::Automatic
    {
        #[cfg(not(feature = "e2e"))]
        {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            let (sender, receiver) = tokio::sync::oneshot::channel();
            _app
                .dialog()
                .message(
                    "开启自动放行后，Agent 在授权工作区内执行写操作将不再逐次询问。\n此确认仅影响当前进程。",
                )
                .title("开启自动审批")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "开启自动审批".to_string(),
                    "保持逐次审批".to_string(),
                ))
                .show(move |confirmed| {
                    let _ = sender.send(confirmed);
                });
            let confirmed = receiver
                .await
                .map_err(|_| "自动放行确认对话框意外关闭".to_string())?;
            if !confirmed {
                return Err("用户取消了开启自动放行".into());
            }
        }
    }
    approval_state.set_mode(mode)
}

#[tauri::command]
pub(crate) async fn request_workspace_approval_lease(
    _app: tauri::AppHandle,
    workspace_state: tauri::State<'_, WorkspaceAccessState>,
    approval_state: tauri::State<'_, WorkspaceApprovalState>,
    request: WorkspaceApprovalRequest,
) -> Result<String, String> {
    validate_scope_id(&request.session_id, "sessionId")?;
    validate_scope_id(&request.run_id, "runId")?;
    validate_scope_id(&request.tool_call_id, "toolCallId")?;
    // 自动放行必须是用户显式开启的 access-mode（Rust 侧权威状态）为前提；
    // WebView 不得凭空自报 automatic。
    let held_mode = approval_state.mode()?;
    confirm_automatic_allowed(held_mode, request.confirmation_mode)?;
    let digest = canonical_input_digest(&request.tool_name, &request.input)?;
    let workspace = authorized_root_for(&workspace_state, request.workspace_path.as_deref())?;
    let workspace_path = Some(workspace.to_string_lossy().into_owned());
    let workspace_generation = workspace_state.generation_for(&workspace);

    // bash 命令统一在签发时权威分类并绑定 lease（含模型声明的 network）：执行侧
    // 不再重复关键字分类，三种确认模式的网络档口径一致。非 bash 工具为 None。
    let bash_tier = if request.tool_name == "run_workspace_command" {
        let command = required_string(&request.input, "command")?;
        let declared_network = request
            .input
            .get("network")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Some(sandbox::classify_command(command, declared_network))
    } else {
        None
    };

    // Interactive（逐次审批）的确认收敛到 Rust 侧原生对话框：用户在系统级对话框
    // 点“允许”后才签发 lease token，受陷渲染进程无法伪造该用户手势。
    // automatic 模式已在 set_workspace_approval_mode 经原生对话框开启，此处直接签发。
    // SandboxSafe（单层 UI）是特权模式：出网不再单独设二次原生确认，单层卡片审批
    // 覆盖 bash 全部分级；tier 由 Rust 权威分类并存入 lease（不信任前端自报）。
    // 沙箱不可用时：SandboxSafe 档 fail-closed 拒绝（沙箱是该档唯一防护，与执行侧
    // 回退语义一致）；NetworkRequired 档放行（执行侧本就回退常规用户权限执行，
    // 见 workspace_command.rs 的 network_policy 选择）。
    let lease_tier = match request.confirmation_mode {
        WorkspaceApprovalConfirmationMode::Interactive => {
            // SSH 远程执行的首连确认走三选一对话框（仅此一次 / 本会话内允许该
            // 主机 / 拒绝）：「本会话允许」写入 ssh_agent 的授权表，是唯一的
            // SshSessionGranted 授权来源。其余工具维持通用两键对话框。
            if request.tool_name == "run_ssh_command" {
                let host = required_string(&request.input, "host")?;
                let command = required_string(&request.input, "command")?;
                crate::ssh_agent::confirm_ssh_exec_interactive(
                    &_app,
                    &request.session_id,
                    host,
                    command,
                )
                .await?;
            } else {
                confirm_interactive(&_app, &request).await?;
            }
            bash_tier
        }
        WorkspaceApprovalConfirmationMode::SshSessionGranted => {
            if request.tool_name != "run_ssh_command" {
                return Err("ssh session-granted approval only applies to run_ssh_command".into());
            }
            let host = required_string(&request.input, "host")?;
            if !crate::ssh_agent::ssh_session_grant_valid(&_app, &request.session_id, host) {
                // 授权表未命中：TS 镜像丢失/伪造/会话已回收，回落审批卡重新确认。
                return Err("SSH 会话授权缺失或已失效，请重新审批".into());
            }
            None
        }
        WorkspaceApprovalConfirmationMode::SandboxSafe => {
            // 非 bash 工具不得走单层模式（该模式无原生确认，越权请求 fail-closed）。
            let tier = bash_tier
                .ok_or("sandboxSafe single-step approval only applies to run_workspace_command")?;
            if !sandbox::sandbox_available() && tier == CommandTier::SandboxSafe {
                return Err(sandbox::sandbox_unavailable_error(
                    "single-step approval requires the sandbox",
                ));
            }
            Some(tier)
        }
        WorkspaceApprovalConfirmationMode::Automatic => bash_tier,
    };

    approval_state.issue(
        request.tool_name,
        digest,
        workspace_generation,
        workspace_path,
        lease_tier,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_ssh_command_canonical_input_binds_host_and_command_only() {
        // 超时/会话字段不参与绑定：签发与消费两侧的非安全字段差异不影响 digest。
        let issued = json!({
            "sessionId": "sess-1",
            "host": "prod",
            "command": "uptime",
            "timeout_ms": 30_000,
        });
        let digest = canonical_input_digest("run_ssh_command", &issued).unwrap();
        let consumed = json!({ "host": "prod", "command": "uptime" });
        assert_eq!(
            digest,
            canonical_input_digest("run_ssh_command", &consumed).unwrap()
        );
        // 目标主机或命令任一变化即不匹配。
        let tampered = json!({ "host": "other", "command": "uptime" });
        assert_ne!(
            digest,
            canonical_input_digest("run_ssh_command", &tampered).unwrap()
        );
        let tampered = json!({ "host": "prod", "command": "rm -rf /" });
        assert_ne!(
            digest,
            canonical_input_digest("run_ssh_command", &tampered).unwrap()
        );
        // 缺 host/command 时 fail-closed。
        assert!(canonical_input_digest("run_ssh_command", &json!({ "host": "prod" })).is_err());
    }

    #[test]
    fn automatic_lease_requires_an_explicit_rust_side_mode() {
        // 默认 Interactive：前端自报 automatic 必须被拒绝
        assert!(confirm_automatic_allowed(
            WorkspaceApprovalConfirmationMode::Interactive,
            WorkspaceApprovalConfirmationMode::Automatic,
        )
        .is_err());
        // Interactive 请求总是放行
        assert!(confirm_automatic_allowed(
            WorkspaceApprovalConfirmationMode::Interactive,
            WorkspaceApprovalConfirmationMode::Interactive,
        )
        .is_ok());
        // 用户显式开启自动放行后才允许 automatic
        assert!(confirm_automatic_allowed(
            WorkspaceApprovalConfirmationMode::Automatic,
            WorkspaceApprovalConfirmationMode::Automatic,
        )
        .is_ok());
    }

    #[test]
    fn state_mode_roundtrips_through_set_mode() {
        let state = WorkspaceApprovalState::default();
        assert_eq!(
            state.mode().unwrap(),
            WorkspaceApprovalConfirmationMode::Interactive,
            "未显式开启自动放行前必须保持 fail-closed 的 Interactive"
        );
        state
            .set_mode(WorkspaceApprovalConfirmationMode::Automatic)
            .unwrap();
        assert_eq!(
            state.mode().unwrap(),
            WorkspaceApprovalConfirmationMode::Automatic
        );
    }

    #[test]
    fn approval_dialog_message_carries_operation_details() {
        let command = json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "run_workspace_command",
            "input": { "command": "npm test -- --coverage", "cwd": "apps/desktop" },
            "confirmationMode": "interactive"
        });
        let request: WorkspaceApprovalRequest =
            serde_json::from_value(command).unwrap();
        let message = approval_dialog_message(&request);
        assert!(message.contains("执行命令"), "missing label: {message}");
        assert!(message.contains("npm test -- --coverage"), "missing command: {message}");
        assert!(message.contains("仅允许执行一次"), "missing scope note: {message}");

        let change = json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "toolCallId": "call-2",
            "toolName": "apply_workspace_changes",
            "input": {
                "operations": [
                    { "type": "create-file", "path": "src/new.ts", "content": "export const x = 1\n" },
                    { "type": "patch-file", "path": "src/main.ts", "expectedSha256": "abc", "oldText": "a\nb", "newText": "a\nb\nc" },
                    { "type": "move", "from": "a.txt", "to": "b.txt", "expectedSha256": null },
                    { "type": "trash", "path": "old.log", "expectedSha256": null },
                ]
            },
            "confirmationMode": "interactive"
        });
        let request: WorkspaceApprovalRequest = serde_json::from_value(change).unwrap();
        let message = approval_dialog_message(&request);
        assert!(message.contains("批量应用工作区改动"), "missing label: {message}");
        assert!(message.contains("新建文件 src/new.ts"), "missing create-file: {message}");
        assert!(message.contains("修改文件 src/main.ts（-2/+3 行）"), "missing patch-file: {message}");
        assert!(message.contains("移动 a.txt → b.txt"), "missing move: {message}");
        assert!(message.contains("删除（可恢复）old.log"), "missing trash: {message}");

        let create = json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "toolCallId": "call-3",
            "toolName": "create_workspace_file",
            "input": { "path": "docs/todo.md", "content": "# TODO\n- 修复审批预览\n" },
            "confirmationMode": "interactive"
        });
        let request: WorkspaceApprovalRequest = serde_json::from_value(create).unwrap();
        let message = approval_dialog_message(&request);
        assert!(message.contains("创建文件"), "missing label: {message}");
        assert!(message.contains("路径：docs/todo.md"), "missing path: {message}");
        assert!(message.contains("写入内容预览：# TODO"), "missing content preview: {message}");

        let edit = json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "toolCallId": "call-4",
            "toolName": "edit_workspace_file",
            "input": {
                "path": "src/main.ts",
                "edits": [
                    { "oldText": "console.log(1)", "newText": "console.log(2)" },
                    { "oldText": "a", "newText": "b" },
                ],
            },
            "confirmationMode": "interactive"
        });
        let request: WorkspaceApprovalRequest = serde_json::from_value(edit).unwrap();
        let message = approval_dialog_message(&request);
        assert!(message.contains("修改文件"), "missing label: {message}");
        assert!(message.contains("路径：src/main.ts"), "missing path: {message}");
        assert!(message.contains("替换：console.log(1) → console.log(2)"), "missing edit preview: {message}");
    }

    #[test]
    fn approval_dialog_message_falls_back_to_tool_name() {
        let request = WorkspaceApprovalRequest {
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: "custom_tool".into(),
            input: json!({ "opaque": true }),
            confirmation_mode: WorkspaceApprovalConfirmationMode::Interactive,
            workspace_path: None,
        };
        let message = approval_dialog_message(&request);
        assert!(message.contains("custom_tool"), "missing fallback label: {message}");
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
    fn requires_an_explicit_strict_confirmation_mode() {
        let base = json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "toolCallId": "call-1",
            "toolName": "create_workspace_file",
            "input": { "path": "notes.txt", "content": "hello" }
        });
        assert!(serde_json::from_value::<WorkspaceApprovalRequest>(base.clone()).is_err());

        let mut automatic = base.clone();
        automatic["confirmationMode"] = json!("automatic");
        assert_eq!(
            serde_json::from_value::<WorkspaceApprovalRequest>(automatic)
                .unwrap()
                .confirmation_mode,
            WorkspaceApprovalConfirmationMode::Automatic
        );

        let mut sandbox = base.clone();
        sandbox["confirmationMode"] = json!("sandboxSafe");
        assert_eq!(
            serde_json::from_value::<WorkspaceApprovalRequest>(sandbox)
                .unwrap()
                .confirmation_mode,
            WorkspaceApprovalConfirmationMode::SandboxSafe
        );

        let mut invalid = base;
        invalid["confirmationMode"] = json!(true);
        assert!(serde_json::from_value::<WorkspaceApprovalRequest>(invalid).is_err());
    }

    #[test]
    fn sandbox_lease_returns_bound_tier() {
        let state = WorkspaceApprovalState::default();
        // SandboxSafe 租约：tier 存 lease，consume 时原样返回
        let issued = json!({ "command": "npm test", "cwd": "." });
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
            .consume(
                &token,
                "run_workspace_command",
                consumed,
                1,
                Some("/repo"),
            )
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
    fn command_lease_is_insensitive_to_timeout_field_differences() {
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
}
