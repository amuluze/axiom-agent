use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, LOCATION};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tokio::sync::Notify;

use crate::api_test_policy::{
    contains_plaintext_credential, parse_api_url, resolve_api_target, same_api_origin,
    MAX_API_REDIRECTS,
};
use crate::artifacts::{register_artifact_metadata, write_json_artifact_at};
use crate::secrets::{load_api_test_secret, SecretState};
use crate::session_state::SessionRepositoryState;
use crate::test_repository::{load_test_environment_access, TestEnvironmentAccess};
use crate::user_gesture::{
    current_operating_system, require_user_confirmation, ContentConfirm, UserGestureState,
};
use crate::workspace_access::{authorized_root, WorkspaceAccessState};

const LEASE_TTL: Duration = Duration::from_secs(120);
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
/// api.poll：轮询间隔缺省/上下界（与 TS `TEST_SPEC_LIMITS` 同源约束，权威判定在这里）。
const DEFAULT_POLL_INTERVAL_MS: u64 = 2_000;
const MIN_POLL_INTERVAL_MS: u64 = 500;
const MAX_POLL_INTERVAL_MS: u64 = 30_000;
/// 单次轮询尝试的请求超时：以间隔为基准夹在 [1s, 30s]——端点比间隔还慢时，按「尚未就绪」重试。
const MIN_POLL_ATTEMPT_TIMEOUT_MS: u64 = 1_000;
/// 证据里的逐次尝试摘要上限：120s 窗口 × 最小 500ms 间隔也只到 240 条，超限截断并标注。
const MAX_POLL_ATTEMPT_SUMMARIES: usize = 240;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApiSecretReference {
    secret_id: String,
}

/// v6：运行时凭据引用——值来自同 case 内 `sensitive: true` 的抽取，随步骤请求由 WebView
/// 传入（`variableValues`），Rust 在发请求前注入并按凭据脱敏。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApiVariableReference {
    variable: String,
    #[serde(default)]
    prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum ApiHeaderValue {
    Plain(String),
    Secret(ApiSecretReference),
    Variable(ApiVariableReference),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiExtraction {
    #[serde(default)]
    json_pointer: Option<String>,
    #[serde(default)]
    header: Option<String>,
    #[serde(default)]
    sensitive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractedTestValue {
    value: Value,
    sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiRequestAction {
    id: String,
    /// `api.request`（单次）或 `api.poll`（窗口内按 interval 重试，直到 expect 全部通过）。
    action: String,
    method: String,
    url: String,
    #[serde(default)]
    query: BTreeMap<String, Value>,
    #[serde(default)]
    headers: BTreeMap<String, ApiHeaderValue>,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    body_mode: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// 仅 `api.poll`：轮询间隔（毫秒）。
    #[serde(default)]
    interval_ms: Option<u64>,
    #[serde(default)]
    redirect: Option<String>,
    /// Host 头覆盖（`host[:port]`）：网络目的地仍由 url 决定，只影响服务端路由。
    #[serde(default)]
    virtual_host: Option<String>,
    #[serde(default)]
    expect: Vec<Value>,
    #[serde(default)]
    extract: BTreeMap<String, ApiExtraction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiTestStepRequest {
    run_id: String,
    step_id: String,
    #[serde(default)]
    environment_id: Option<String>,
    action: ApiRequestAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunApiTestStepRequest {
    #[serde(flatten)]
    request: ApiTestStepRequest,
    lease_id: String,
    /// 前序敏感提取值：只用于证据脱敏，不参与请求与租约摘要。
    #[serde(default)]
    sensitive_values: Vec<String>,
    /// v6：步骤显式引用的运行时凭据取值（变量名 → 值）。不参与租约摘要——租约绑定的是
    /// 「引用哪个变量 + 原始动作」，值在审批后被变量表更新属于预期（令牌轮换）。
    #[serde(default)]
    variable_values: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiTestLeaseIssued {
    lease_id: String,
    ttl_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiTestStepResult {
    verdict: String,
    runner_verdict: String,
    transport: String,
    message: String,
    evidence_content_hash: String,
    status_code: Option<u16>,
    elapsed_ms: u64,
    extracted: BTreeMap<String, ExtractedTestValue>,
}

#[derive(PartialEq, Eq)]
struct ApiTestBinding {
    run_id: String,
    step_id: String,
    request_digest: String,
    environment_digest: String,
    workspace_generation: u64,
}

struct ApiTestLease {
    binding: ApiTestBinding,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct ApiTestState {
    leases: Mutex<HashMap<String, ApiTestLease>>,
    requests: Mutex<ApiTestRequests>,
    counter: AtomicU64,
}

#[derive(Default)]
struct ApiTestRequests {
    active: HashMap<String, Arc<ApiTestCancel>>,
    canceled_until: HashMap<String, Instant>,
}

#[derive(Default)]
struct ApiTestCancel {
    canceled: AtomicBool,
    notify: Notify,
}

#[derive(Clone)]
struct PreparedRequest {
    method: Method,
    url: Url,
    headers: HeaderMap,
    request_headers_for_evidence: BTreeMap<String, String>,
    body: Option<String>,
    timeout: Duration,
    redirect: String,
    secret_values: Vec<String>,
}

#[derive(Debug)]
struct ReceivedResponse {
    status: u16,
    headers: HeaderMap,
    body: Vec<u8>,
    total_bytes: usize,
    body_hash: String,
    truncated: bool,
    final_url: Url,
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn digest<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|bytes| hex_digest(&bytes))
        .map_err(|error| format!("无法计算 API 测试摘要：{error}"))
}

fn binding_for(
    request: &ApiTestStepRequest,
    environment: &TestEnvironmentAccess,
    workspace_generation: u64,
) -> Result<ApiTestBinding, String> {
    if request.run_id.trim().is_empty()
        || request.step_id.trim().is_empty()
        || request.action.id != request.step_id
        || (request.action.action != "api.request" && request.action.action != "api.poll")
    {
        return Err("API 测试运行或步骤标识无效".to_string());
    }
    Ok(ApiTestBinding {
        run_id: request.run_id.clone(),
        step_id: request.step_id.clone(),
        request_digest: digest(request)?,
        environment_digest: digest(environment)?,
        workspace_generation,
    })
}

fn issue_lease(
    state: &ApiTestState,
    binding: ApiTestBinding,
    now: Instant,
) -> Result<String, String> {
    let sequence = state.counter.fetch_add(1, Ordering::Relaxed);
    let lease_id = hex_digest(format!("{sequence}|{:?}|{}", now, binding.run_id).as_bytes());
    let mut leases = state
        .leases
        .lock()
        .map_err(|_| "API 测试租约状态已损坏".to_string())?;
    leases.retain(|_, lease| lease.expires_at > now);
    leases.insert(
        lease_id.clone(),
        ApiTestLease {
            binding,
            expires_at: now + LEASE_TTL,
        },
    );
    Ok(lease_id)
}

fn consume_lease(
    state: &ApiTestState,
    lease_id: &str,
    binding: ApiTestBinding,
    now: Instant,
) -> Result<(), String> {
    let mut leases = state
        .leases
        .lock()
        .map_err(|_| "API 测试租约状态已损坏".to_string())?;
    let lease = leases
        .remove(lease_id)
        .ok_or_else(|| "API 测试租约不存在或已消费".to_string())?;
    if lease.expires_at <= now {
        return Err("API 测试审批已过期，请重新确认".to_string());
    }
    if lease.binding != binding {
        return Err("API 测试请求或环境在审批后发生变化".to_string());
    }
    Ok(())
}

fn register_request(
    state: &ApiTestState,
    run_id: &str,
    now: Instant,
) -> Result<Arc<ApiTestCancel>, String> {
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "API 测试取消状态已损坏".to_string())?;
    requests
        .canceled_until
        .retain(|_, expires_at| *expires_at > now);
    if requests.canceled_until.remove(run_id).is_some() {
        return Err("运行已停止".to_string());
    }
    if requests.active.contains_key(run_id) {
        return Err("API 测试运行已有请求正在执行".to_string());
    }
    let cancel = Arc::new(ApiTestCancel::default());
    requests
        .active
        .insert(run_id.to_string(), Arc::clone(&cancel));
    Ok(cancel)
}

fn remove_request(state: &ApiTestState, run_id: &str) -> Result<(), String> {
    state
        .requests
        .lock()
        .map_err(|_| "API 测试取消状态已损坏".to_string())?
        .active
        .remove(run_id);
    Ok(())
}

/// 只读检查：该 run 是否已被要求停止（活跃请求在看 `cancel.notify`，间隙里看 canceled_until）。
fn cancellation_requested(state: &ApiTestState, run_id: &str, now: Instant) -> bool {
    let Ok(requests) = state.requests.lock() else {
        return false;
    };
    requests
        .active
        .get(run_id)
        .is_some_and(|cancel| cancel.canceled.load(Ordering::Acquire))
        || requests
            .canceled_until
            .get(run_id)
            .is_some_and(|expires_at| *expires_at > now)
}

fn cancel_run(state: &ApiTestState, run_id: &str, now: Instant) -> Result<bool, String> {
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "API 测试取消状态已损坏".to_string())?;
    requests
        .canceled_until
        .retain(|_, expires_at| *expires_at > now);
    if let Some(cancel) = requests.active.get(run_id) {
        cancel.canceled.store(true, Ordering::Release);
        cancel.notify.notify_one();
    } else {
        requests
            .canceled_until
            .insert(run_id.to_string(), now + LEASE_TTL);
    }
    Ok(true)
}

async fn environment_access(
    repository: &SessionRepositoryState,
    workspace: &WorkspaceAccessState,
    environment_id: Option<&str>,
) -> Result<(TestEnvironmentAccess, u64), String> {
    let root = authorized_root(workspace)?;
    let generation = workspace.generation_for(&root);
    let mut connection = repository.acquire().await?;
    let access =
        load_test_environment_access(&mut connection, &root.to_string_lossy(), environment_id)
            .await?;
    Ok((access, generation))
}

fn validate_action(action: &ApiRequestAction) -> Result<(), String> {
    if !matches!(
        action.method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err("API 测试 HTTP method 无效".to_string());
    }
    parse_api_url(&action.url)?;
    if contains_plaintext_credential(&action.url) {
        return Err("API 测试 URL 包含疑似明文凭据；请改用 apitest.* Secret 引用".to_string());
    }
    if let Some(virtual_host) = &action.virtual_host {
        validate_virtual_host(virtual_host)?;
    }
    if action.action == "api.poll" {
        // 轮询是「步骤自身声明的语义」而非隐式重试：幂等方法 + 必有就绪断言 + 有界间隔，
        // 单租约单审批覆盖整个窗口，迭代是命令内部行为。
        if !matches!(action.method.as_str(), "GET" | "HEAD") {
            return Err("api.poll 只允许 GET 或 HEAD（轮询必须保持幂等读）".to_string());
        }
        if action.body.is_some() {
            return Err("api.poll 不允许携带请求体".to_string());
        }
        if action.expect.is_empty() {
            return Err("api.poll 必须声明至少一条就绪断言".to_string());
        }
    }
    if action.interval_ms.is_some() && action.action != "api.poll" {
        return Err("intervalMs 只属于 api.poll 步骤".to_string());
    }
    let interval_ms = action.interval_ms.unwrap_or(DEFAULT_POLL_INTERVAL_MS);
    if action.action == "api.poll"
        && !(MIN_POLL_INTERVAL_MS..=MAX_POLL_INTERVAL_MS).contains(&interval_ms)
    {
        return Err(format!(
            "api.poll 轮询间隔必须在 {MIN_POLL_INTERVAL_MS}–{MAX_POLL_INTERVAL_MS} 毫秒之间"
        ));
    }
    for value in action.query.values() {
        if let Some(text) = value.as_str() {
            if contains_plaintext_credential(text) {
                return Err(
                    "API 测试查询参数包含疑似明文凭据；请改用 apitest.* Secret 引用".to_string(),
                );
            }
        }
    }
    for (name, value) in &action.headers {
        match value {
            ApiHeaderValue::Plain(text) => {
                if is_sensitive_header(name) || contains_plaintext_credential(text) {
                    return Err(format!(
                        "敏感请求头 {name} 必须使用 apitest.* Secret 或运行时变量引用"
                    ));
                }
            }
            ApiHeaderValue::Variable(reference) => {
                if !valid_variable_name(&reference.variable) {
                    return Err("API 测试运行时凭据变量名无效".to_string());
                }
                if let Some(prefix) = &reference.prefix {
                    if !valid_credential_prefix(prefix) {
                        return Err(
                            "API 测试运行时凭据前缀必须是「Scheme 」形式（如 Bearer ）".to_string()
                        );
                    }
                }
            }
            ApiHeaderValue::Secret(_) => {}
        }
    }
    for expectation in &action.expect {
        let serialized = serde_json::to_string(expectation).unwrap_or_default();
        if contains_plaintext_credential(&serialized) {
            return Err(
                "API 测试断言值包含疑似明文凭据；请改用运行变量或 apitest.* Secret 引用"
                    .to_string(),
            );
        }
        for key in [
            "headerEquals",
            "headerContains",
            "headerExists",
            "headerAbsent",
        ] {
            if let Some(name) = expectation
                .get(key)
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
            {
                if is_sensitive_header(name) {
                    return Err("敏感响应头不能用于断言（避免实际值进入证据）".to_string());
                }
            }
        }
    }
    if action.query.len() > 64
        || action.headers.len() > 64
        || action.expect.len() > 32
        || action.extract.len() > 64
    {
        return Err("API 测试请求字段数量超出上限".to_string());
    }
    for (name, extraction) in &action.extract {
        if !valid_variable_name(name) {
            return Err("API 测试提取变量名无效".to_string());
        }
        if extraction.json_pointer.is_some() == extraction.header.is_some() {
            return Err("API 测试提取必须且只能指定 JSON Pointer 或响应头".to_string());
        }
        if let Some(header) = &extraction.header {
            HeaderName::from_bytes(header.as_bytes())
                .map_err(|_| "API 测试提取响应头名称无效".to_string())?;
            if is_sensitive_header(header) {
                return Err("敏感响应头不能进入运行变量表".to_string());
            }
        }
        if let Some(pointer) = &extraction.json_pointer {
            validate_json_pointer(pointer)?;
        }
    }
    let timeout_ms = action.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
        return Err("API 测试超时时间无效".to_string());
    }
    if !matches!(
        action.redirect.as_deref(),
        None | Some("manual") | Some("same-origin")
    ) {
        return Err("API 测试重定向策略无效".to_string());
    }
    if !matches!(
        action.body_mode.as_deref(),
        None | Some("json") | Some("text") | Some("form")
    ) {
        return Err("API 测试 bodyMode 无效".to_string());
    }
    if action.body.is_some()
        && !matches!(action.method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE")
    {
        return Err("当前 HTTP method 不允许请求体".to_string());
    }
    let encoded = match (&action.body, action.body_mode.as_deref()) {
        (Some(Value::String(text)), Some("text")) => text.clone(),
        (Some(_), Some("text")) => return Err("text 请求体必须是字符串".to_string()),
        (Some(body), Some("form")) => encode_form_body(body)?,
        (Some(body), _) => {
            serde_json::to_string(body).map_err(|_| "API 测试请求体无效".to_string())?
        }
        (None, _) => String::new(),
    };
    if encoded.len() > MAX_REQUEST_BODY_BYTES {
        return Err("API 测试请求体超过 256 KiB".to_string());
    }
    if contains_plaintext_credential(&encoded) {
        return Err(
            "API 测试请求体包含疑似明文凭据；请改用运行变量或 apitest.* Secret 引用".to_string(),
        );
    }
    Ok(())
}

/// 运行时凭据前缀是认证 scheme 标签（`Bearer ` / `Token `），不是凭据本体：
/// 只接受「一个 ASCII 字母开头的 scheme + 单个尾随空格」，杜绝把令牌塞进前缀。
fn valid_credential_prefix(prefix: &str) -> bool {
    let Some(scheme) = prefix.strip_suffix(' ') else {
        return false;
    };
    if scheme.is_empty() || scheme.len() > 32 || prefix.len() > 33 {
        return false;
    }
    let mut characters = scheme.chars();
    characters.next().is_some_and(|c| c.is_ascii_alphabetic())
        && characters.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
        && name.len() <= 64
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn validate_json_pointer(pointer: &str) -> Result<(), String> {
    if pointer.is_empty() {
        return Ok(());
    }
    if !pointer.starts_with('/') {
        return Err("API 测试提取 JSON Pointer 无效".to_string());
    }
    let bytes = pointer.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'~' {
            if index + 1 >= bytes.len() || !matches!(bytes[index + 1], b'0' | b'1') {
                return Err("API 测试提取 JSON Pointer 无效".to_string());
            }
            index += 1;
        }
        index += 1;
    }
    Ok(())
}

fn scalar_query_value(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => Ok(value.clone()),
        _ => Err("API 测试查询参数必须是标量".to_string()),
    }
}

fn encode_form_body(value: &Value) -> Result<String, String> {
    let fields = value
        .as_object()
        .ok_or_else(|| "form 请求体必须是标量对象".to_string())?;
    if fields.len() > 64 {
        return Err("API 测试表单字段数量超出上限".to_string());
    }
    let mut url = Url::parse("http://form.invalid/").map_err(|_| "无法编码表单".to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in fields {
            pairs.append_pair(name, &scalar_query_value(value)?);
        }
    }
    Ok(url.query().unwrap_or_default().to_string())
}

fn is_sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie" | "x-api-key"
    )
}

fn is_forbidden_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "transfer-encoding" | "connection"
    )
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), String> {
    if is_forbidden_request_header(name) {
        return Err(format!("API 测试禁止设置请求头 {name}"));
    }
    let name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| "API 测试请求头名称无效".to_string())?;
    let value = HeaderValue::from_str(value).map_err(|_| "API 测试请求头值无效".to_string())?;
    headers.insert(name, value);
    Ok(())
}

fn uses_credentials(action: &ApiRequestAction) -> bool {
    action.headers.values().any(|value| {
        matches!(
            value,
            ApiHeaderValue::Secret(_) | ApiHeaderValue::Variable(_)
        )
    })
}

/// v4：Host 头覆盖只接受字面 `host[:port]`（占位符已在 TS 编译期物化）。网络目的地仍由
/// 步骤 url 决定（DNS/SSRF/TLS 校验不变），这里只约束路由头的形状，防止把 scheme、
/// 路径或凭据夹带进 Host。
fn validate_virtual_host(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 253 {
        return Err("API 测试 virtualHost 必须是 host[:port]".to_string());
    }
    if contains_plaintext_credential(value) {
        return Err("API 测试 virtualHost 包含疑似明文凭据".to_string());
    }
    let (host, port) = match value.rsplit_once(':') {
        None => (value, None),
        Some((host, port)) => (host, Some(port)),
    };
    if host.is_empty() {
        return Err("API 测试 virtualHost 必须是 host[:port]".to_string());
    }
    for label in host.split('.') {
        let mut characters = label.chars();
        let valid_label = characters.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && label
                .chars()
                .last()
                .is_some_and(|c| c.is_ascii_alphanumeric())
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid_label {
            return Err(
                "API 测试 virtualHost 必须是 host[:port]，不能包含协议、路径或凭据".to_string(),
            );
        }
    }
    if let Some(port) = port {
        let parsed: u32 = port
            .parse()
            .map_err(|_| "API 测试 virtualHost 端口无效".to_string())?;
        if !(1..=65535).contains(&parsed) {
            return Err("API 测试 virtualHost 端口必须在 1–65535 之间".to_string());
        }
    }
    Ok(())
}

/// 凭据（宿主 Secret 或 v6 运行时变量引用）注入的同源边界：只能发往该环境声明的目的地
/// ——API Base URL 的同源地址，或 `secretOrigins` 里显式声明的服务 origin（多服务拓扑：
/// 控制面、数据面管理面各有各的凭据）。签发租约前与真正发请求前都走这一份判定，避免
/// 先让用户确认、再在运行期失败。
fn validate_credential_destination(
    action: &ApiRequestAction,
    environment: &TestEnvironmentAccess,
) -> Result<(), String> {
    if !uses_credentials(action) {
        return Ok(());
    }
    if environment.api_base_url.is_none() && environment.secret_origins.is_empty() {
        return Err("使用凭据的请求需要测试环境配置 API Base URL 或 secretOrigins".to_string());
    }
    let target = parse_api_url(&action.url)?;
    if let Some(base) = &environment.api_base_url {
        let base_url = parse_api_url(base)?;
        if same_api_origin(&base_url, &target) {
            return Ok(());
        }
    }
    for origin in &environment.secret_origins {
        let Ok(origin_url) = parse_api_url(origin) else {
            // 环境保存侧已校验过形状；这里的坏值按不匹配处理，fail-closed。
            continue;
        };
        if same_api_origin(&origin_url, &target) {
            return Ok(());
        }
    }
    Err("凭据只能发送到测试环境 API Base URL 或 secretOrigins 声明的同源地址".to_string())
}

/// 受信环境（`approval_mode = trusted`）的放行作用域：**该环境自己声明的 origin 集合**。
///
/// 受信的含义只是「不再逐次弹原生确认」，不是「可以打任意地址」。作用域由环境记录
/// 决定（Web Base / API Base / secretOrigins），越界的步骤照旧逐次审批。
pub(crate) fn trusted_scope_origins(environment: &TestEnvironmentAccess) -> Vec<Url> {
    let mut origins = Vec::new();
    for value in [
        environment.api_base_url.as_deref(),
        environment.web_base_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .chain(environment.secret_origins.iter().map(String::as_str))
    {
        if let Ok(url) = parse_api_url(value) {
            origins.push(url);
        }
    }
    origins
}

/// 目标地址是否落在受信环境的放行作用域内。
pub(crate) fn within_trusted_scope(environment: &TestEnvironmentAccess, target: &Url) -> bool {
    trusted_scope_origins(environment)
        .iter()
        .any(|origin| same_api_origin(origin, target))
}

/// 该步骤是否可以按受信环境放行：环境是受信档，且目标 origin 在其作用域内。
pub(crate) fn trusted_step_allowed(environment: &TestEnvironmentAccess, target: &Url) -> bool {
    environment.approval_mode == "trusted" && within_trusted_scope(environment, target)
}

fn prepare_request(
    action: &ApiRequestAction,
    environment: &TestEnvironmentAccess,
    secrets: &SecretState,
    variable_values: &BTreeMap<String, String>,
) -> Result<PreparedRequest, String> {
    validate_action(action)?;
    validate_credential_destination(action, environment)?;
    let method = Method::from_bytes(action.method.as_bytes())
        .map_err(|_| "API 测试 HTTP method 无效".to_string())?;
    let mut url = parse_api_url(&action.url)?;
    {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in &action.query {
            pairs.append_pair(name, &scalar_query_value(value)?);
        }
    }
    let mut headers = HeaderMap::new();
    let mut evidence = BTreeMap::new();
    for (name, value) in &environment.headers {
        if contains_plaintext_credential(value) {
            return Err(format!(
                "请求头 {name} 包含疑似明文凭据，必须改用 apitest.* Secret 引用"
            ));
        }
        insert_header(&mut headers, name, value)?;
        evidence.insert(name.clone(), value.clone());
    }
    let mut secret_values = Vec::new();
    for (name, value) in &action.headers {
        let (resolved, secret) = match value {
            ApiHeaderValue::Plain(value) => {
                if is_sensitive_header(name) || contains_plaintext_credential(value) {
                    return Err(format!("敏感请求头 {name} 必须使用 apitest.* Secret 引用"));
                }
                (value.clone(), false)
            }
            ApiHeaderValue::Secret(reference) => {
                if !environment.secret_ids.contains(&reference.secret_id) {
                    return Err("API 测试 Secret 未被当前环境授权".to_string());
                }
                let value = load_api_test_secret(secrets, &reference.secret_id)?
                    .ok_or_else(|| "API 测试 Secret 不存在".to_string())?;
                secret_values.push(value.clone());
                (value, true)
            }
            ApiHeaderValue::Variable(reference) => {
                let value = variable_values
                    .get(&reference.variable)
                    .ok_or_else(|| format!("运行时凭据变量「{}」缺少取值", reference.variable))?;
                let resolved = format!("{}{}", reference.prefix.clone().unwrap_or_default(), value);
                secret_values.push(resolved.clone());
                (resolved, true)
            }
        };
        insert_header(&mut headers, name, &resolved)?;
        evidence.insert(
            name.clone(),
            if secret || is_sensitive_header(name) {
                "[REDACTED]".to_string()
            } else {
                resolved
            },
        );
    }
    let body = match (&action.body, action.body_mode.as_deref()) {
        (Some(Value::String(text)), Some("text")) => Some(text.clone()),
        (Some(body), Some("form")) => Some(encode_form_body(body)?),
        (Some(body), _) => {
            Some(serde_json::to_string(body).map_err(|_| "API 测试请求体无效".to_string())?)
        }
        (None, _) => None,
    };
    if action.body.is_some() {
        let content_type = match action.body_mode.as_deref() {
            Some("text") => "text/plain;charset=utf-8",
            Some("form") => "application/x-www-form-urlencoded",
            _ => "application/json",
        };
        if !headers.contains_key("content-type") {
            insert_header(&mut headers, "content-type", content_type)?;
            evidence.insert("content-type".to_string(), content_type.to_string());
        }
    }
    // Host 覆盖最后落笔：不允许被环境/动作头抢占（headers 通道本身拒绝 host 名），证据如实记录。
    if let Some(virtual_host) = &action.virtual_host {
        let value = HeaderValue::from_str(virtual_host)
            .map_err(|_| "API 测试 virtualHost 无效".to_string())?;
        headers.insert(reqwest::header::HOST, value);
        evidence.insert("host".to_string(), virtual_host.clone());
    }
    Ok(PreparedRequest {
        method,
        url,
        headers,
        request_headers_for_evidence: evidence,
        body,
        timeout: Duration::from_millis(action.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)),
        redirect: action
            .redirect
            .clone()
            .unwrap_or_else(|| "manual".to_string()),
        secret_values,
    })
}

fn request_builder(
    client: &reqwest::Client,
    prepared: &PreparedRequest,
    url: Url,
) -> reqwest::RequestBuilder {
    let request = client
        .request(prepared.method.clone(), url)
        .headers(prepared.headers.clone());
    match &prepared.body {
        Some(body) => request.body(body.clone()),
        None => request,
    }
}

async fn collect_response(
    mut response: reqwest::Response,
    cancel: &ApiTestCancel,
) -> Result<ReceivedResponse, String> {
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let final_url = response.url().clone();
    let mut captured = Vec::new();
    let mut total_bytes = 0usize;
    let mut hasher = Sha256::new();
    loop {
        if cancel.canceled.load(Ordering::Acquire) {
            return Err("运行已停止".to_string());
        }
        let chunk = tokio::select! {
            result = response.chunk() => result.map_err(|_| "API 响应读取失败".to_string())?,
            () = cancel.notify.notified() => return Err("运行已停止".to_string()),
        };
        let Some(chunk) = chunk else {
            break;
        };
        total_bytes = total_bytes.saturating_add(chunk.len());
        hasher.update(&chunk);
        if captured.len() < MAX_RESPONSE_BYTES {
            let remaining = MAX_RESPONSE_BYTES - captured.len();
            captured.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
    }
    let body_hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(ReceivedResponse {
        status,
        headers,
        body: captured,
        total_bytes,
        body_hash,
        truncated: total_bytes > MAX_RESPONSE_BYTES,
        final_url,
    })
}

async fn send_request(
    prepared: &PreparedRequest,
    allow_private_network: bool,
    tls_trust: &str,
    cancel: &ApiTestCancel,
) -> Result<ReceivedResponse, String> {
    let mut current = prepared.url.clone();
    for redirect_count in 0..=MAX_API_REDIRECTS {
        if cancel.canceled.load(Ordering::Acquire) {
            return Err("运行已停止".to_string());
        }
        let addresses = resolve_api_target(&current, allow_private_network).await?;
        let host = current
            .host_str()
            .ok_or_else(|| "API 测试 URL 缺少主机".to_string())?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(prepared.timeout)
            .resolve_to_addrs(host, &addresses)
            // 私有 CA 的测试环境用系统信任库握手必然失败。环境显式声明 `insecure`
            // 时才跳过校验——该声明只对确定在私网/回环的目标开放（保存侧校验），
            // 且改变它必须经原生内容确认，用户看得见。
            .danger_accept_invalid_certs(tls_trust == "insecure")
            .build()
            .map_err(|_| "无法创建 API 测试 HTTP Client".to_string())?;
        let response = tokio::select! {
            result = request_builder(&client, prepared, current.clone()).send() => result.map_err(|error| {
                if error.is_timeout() {
                    "API 请求超时".to_string()
                } else {
                    "API 请求失败".to_string()
                }
            })?,
            () = cancel.notify.notified() => return Err("运行已停止".to_string()),
        };
        if !response.status().is_redirection() || prepared.redirect == "manual" {
            return collect_response(response, cancel).await;
        }
        if redirect_count == MAX_API_REDIRECTS {
            return Err("API 同源重定向次数超过上限".to_string());
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "API 重定向缺少有效 Location".to_string())?;
        let next = current
            .join(location)
            .map_err(|_| "API 重定向 Location 无法解析".to_string())?;
        if !same_api_origin(&prepared.url, &next) {
            let mut safe = next.clone();
            safe.set_query(None);
            safe.set_fragment(None);
            return Err(format!(
                "API 跨源重定向已阻止：{}",
                redacted(safe.as_str(), &prepared.secret_values)
            ));
        }
        current = next;
    }
    Err("API 同源重定向次数超过上限".to_string())
}

fn redacted(value: &str, secrets: &[String]) -> String {
    secrets
        .iter()
        .filter(|secret| !secret.is_empty())
        .fold(value.to_string(), |text, secret| {
            text.replace(secret, "[REDACTED]")
        })
}

fn response_headers_for_evidence(
    headers: &HeaderMap,
    secrets: &[String],
) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let value = value.to_str().unwrap_or("[NON_UTF8]");
            (
                name.to_string(),
                if is_sensitive_header(name.as_str()) {
                    "[REDACTED]".to_string()
                } else {
                    redacted(value, secrets)
                },
            )
        })
        .collect()
}

fn bounded_json_value(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    let encoded = serde_json::to_vec(value).unwrap_or_default();
    if encoded.len() <= 4096 {
        value.clone()
    } else {
        json!({
            "truncated": true,
            "sizeBytes": encoded.len(),
            "sha256": hex_digest(&encoded),
        })
    }
}

fn response_is_textual(response: &ReceivedResponse) -> bool {
    response
        .headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            let value = value.to_ascii_lowercase();
            value.starts_with("text/")
                || value.contains("json")
                || value.contains("xml")
                || value.contains("x-www-form-urlencoded")
        })
        .unwrap_or(false)
}

fn assertion_result(
    expectation: &Value,
    response: &ReceivedResponse,
    body_text: &str,
    elapsed_ms: u64,
) -> Result<(bool, String, Value, Value), String> {
    let object = expectation
        .as_object()
        .ok_or_else(|| "API 断言必须是对象".to_string())?;
    if object.len() != 1 {
        return Err("API 断言必须且只能包含一个字段".to_string());
    }
    let (kind, expected) = object
        .iter()
        .next()
        .ok_or_else(|| "API 断言为空".to_string())?;
    let body_kind = matches!(
        kind.as_str(),
        "bodyContains"
            | "jsonPointerExists"
            | "jsonPointerEquals"
            | "jsonPointerLengthEquals"
            | "jsonPointerNumberAtLeast"
            | "jsonPointerNumberAtMost"
    );
    if response.truncated && body_kind {
        return Err("响应超过断言读取上限，无法完成正文断言".to_string());
    }
    if !response_is_textual(response) && body_kind {
        return Err("二进制响应不支持正文断言".to_string());
    }
    let (passed, actual) = match kind.as_str() {
        "status" => (
            expected.as_u64() == Some(u64::from(response.status)),
            json!(response.status),
        ),
        "bodyContains" => {
            let text = expected
                .as_str()
                .ok_or_else(|| "bodyContains 断言无效".to_string())?;
            (
                body_text.contains(text),
                json!({ "responseBytes": response.total_bytes, "truncated": response.truncated }),
            )
        }
        "bodyNotContains" => {
            let text = expected
                .as_str()
                .ok_or_else(|| "bodyNotContains 断言无效".to_string())?;
            (
                !body_text.contains(text),
                json!({ "responseBytes": response.total_bytes, "truncated": response.truncated }),
            )
        }
        "statusIn" => {
            let codes = expected
                .as_array()
                .ok_or_else(|| "statusIn 断言无效".to_string())?;
            if codes.is_empty() {
                return Err("statusIn 断言无效".to_string());
            }
            let status = u64::from(response.status);
            (
                codes.iter().any(|code| code.as_u64() == Some(status)),
                json!(response.status),
            )
        }
        "maxElapsedMs" => {
            let maximum = expected
                .as_u64()
                .ok_or_else(|| "maxElapsedMs 断言无效".to_string())?;
            (elapsed_ms <= maximum, json!(elapsed_ms))
        }
        "headerEquals" | "headerContains" => {
            let name = expected
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "响应头断言名称无效".to_string())?;
            let wanted = expected
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| "响应头断言值无效".to_string())?;
            let actual = response
                .headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            let passed = if kind == "headerEquals" {
                actual == wanted
            } else {
                actual.contains(wanted)
            };
            (passed, json!(actual))
        }
        "jsonPointerExists" => {
            let pointer = expected
                .as_str()
                .ok_or_else(|| "JSON Pointer 断言无效".to_string())?;
            let body: Value = serde_json::from_slice(&response.body)
                .map_err(|_| "响应不是有效 JSON".to_string())?;
            (
                body.pointer(pointer).is_some(),
                bounded_json_value(body.pointer(pointer)),
            )
        }
        "jsonPointerEquals" => {
            let pointer = expected
                .get("pointer")
                .and_then(Value::as_str)
                .ok_or_else(|| "JSON Pointer 断言无效".to_string())?;
            let wanted = expected
                .get("value")
                .ok_or_else(|| "JSON Pointer 断言缺少 value".to_string())?;
            let body: Value = serde_json::from_slice(&response.body)
                .map_err(|_| "响应不是有效 JSON".to_string())?;
            let actual = body.pointer(pointer);
            (actual == Some(wanted), bounded_json_value(actual))
        }
        "headerExists" | "headerAbsent" => {
            let name = expected
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "响应头断言名称无效".to_string())?;
            let present = response.headers.get(name).is_some();
            let passed = if kind == "headerExists" {
                present
            } else {
                !present
            };
            (passed, json!(present))
        }
        "jsonPointerLengthEquals" => {
            let (pointer, wanted) =
                pointer_number_expectation(expected, "jsonPointerLengthEquals")?;
            let body: Value = serde_json::from_slice(&response.body)
                .map_err(|_| "响应不是有效 JSON".to_string())?;
            let actual = body
                .pointer(&pointer)
                .and_then(Value::as_array)
                .map(Vec::len);
            let passed = actual
                .map(|length| length as f64 == wanted)
                .unwrap_or(false);
            (passed, bounded_json_value(body.pointer(&pointer)))
        }
        "jsonPointerNumberAtLeast" | "jsonPointerNumberAtMost" => {
            let (pointer, bound) = pointer_number_expectation(expected, kind.as_str())?;
            let body: Value = serde_json::from_slice(&response.body)
                .map_err(|_| "响应不是有效 JSON".to_string())?;
            let actual = body.pointer(&pointer).and_then(Value::as_f64);
            let passed = match (actual, kind.as_str()) {
                (Some(value), "jsonPointerNumberAtLeast") => value >= bound,
                (Some(value), _) => value <= bound,
                (None, _) => false,
            };
            (passed, bounded_json_value(body.pointer(&pointer)))
        }
        _ => return Err("未知的 API 断言".to_string()),
    };
    Ok((passed, kind.clone(), expected.clone(), actual))
}

/// v4 数值类 Pointer 断言的公共读取：`{ pointer, value }`，value 必须是有限数字。
fn pointer_number_expectation(expected: &Value, kind: &str) -> Result<(String, f64), String> {
    let pointer = expected
        .get("pointer")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{kind} 断言缺少 pointer"))?
        .to_string();
    let value = expected
        .get("value")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("{kind} 断言缺少有限数字 value"))?;
    Ok((pointer, value))
}

fn extract_values(
    extractions: &BTreeMap<String, ApiExtraction>,
    response: &ReceivedResponse,
    secrets: &[String],
) -> Result<BTreeMap<String, ExtractedTestValue>, String> {
    let needs_json = extractions
        .values()
        .any(|extraction| extraction.json_pointer.is_some());
    if needs_json && response.truncated {
        return Err("响应超过读取上限，无法提取 JSON 变量".to_string());
    }
    if needs_json && !response_is_textual(response) {
        return Err("二进制响应不支持 JSON 变量提取".to_string());
    }
    let body = if needs_json {
        Some(
            serde_json::from_slice::<Value>(&response.body)
                .map_err(|_| "响应不是有效 JSON，无法提取变量".to_string())?,
        )
    } else {
        None
    };
    let mut extracted = BTreeMap::new();
    for (name, extraction) in extractions {
        let value = if let Some(pointer) = &extraction.json_pointer {
            body.as_ref()
                .and_then(|value| value.pointer(pointer))
                .cloned()
                .ok_or_else(|| format!("JSON Pointer 未命中，无法提取变量「{name}」"))?
        } else if let Some(header) = &extraction.header {
            Value::String(
                response
                    .headers
                    .get(header)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
                    .ok_or_else(|| format!("响应头未命中，无法提取变量「{name}」"))?,
            )
        } else {
            return Err("API 测试提取配置无效".to_string());
        };
        if !matches!(
            value,
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
        ) {
            return Err(format!("变量「{name}」提取结果不是标量"));
        }
        let comparable = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        if secrets
            .iter()
            .any(|secret| !secret.is_empty() && comparable.contains(secret))
        {
            return Err(format!(
                "变量「{name}」提取结果包含 Secret，已拒绝写入变量表"
            ));
        }
        extracted.insert(
            name.clone(),
            ExtractedTestValue {
                value,
                sensitive: extraction.sensitive,
            },
        );
    }
    Ok(extracted)
}

fn transport_for_error(message: &str, canceled: bool) -> &'static str {
    if canceled {
        "canceled"
    } else if message.contains("超时") {
        "timeout"
    } else if message.contains("禁止")
        || message.contains("未授权")
        || message.contains("阻止")
        || message.contains("重定向")
    {
        "blocked"
    } else {
        "network_error"
    }
}

async fn persist_evidence(
    app: &AppHandle,
    repository: &SessionRepositoryState,
    evidence: Value,
    secrets: &[String],
) -> Result<String, String> {
    let root = crate::storage_paths::axiom_data_root(app)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(0))
        .unwrap_or(0);
    let content = redacted(
        &serde_json::to_string(&evidence).map_err(|_| "无法序列化 API 测试证据".to_string())?,
        secrets,
    );
    let artifact = tauri::async_runtime::spawn_blocking(move || {
        write_json_artifact_at(&root, content, created_at)
    })
    .await
    .map_err(|error| format!("API 测试证据写入任务失败：{error}"))??;
    register_artifact_metadata(repository, &artifact).await?;
    // H1-4 故障窗口：证据 Artifact 已写盘且元数据已登记，但 run/step 引用尚未提交。
    crate::runtime_fault::checkpoint_if_configured("test_evidence_written")?;
    Ok(artifact.content_hash)
}

/// 带 Secret 的步骤需要内容级确认：展示 method、同源地址、路径与 Secret 数量，
/// 不展示 query/body/Secret 值。没有 Secret 引用时返回 None（只走手势门）。
fn secret_step_confirmation(action: &ApiRequestAction) -> Option<String> {
    let secret_count = action
        .headers
        .values()
        .filter(|value| matches!(value, ApiHeaderValue::Secret(_)))
        .count();
    if secret_count == 0 {
        return None;
    }
    let url = parse_api_url(&action.url).ok()?;
    let host_line = action
        .virtual_host
        .as_deref()
        .map(|virtual_host| format!("\nHost 覆盖：{virtual_host}"))
        .unwrap_or_default();
    let poll_line = if action.action == "api.poll" {
        format!(
            "\n轮询：每 {} ms 一次，窗口 {} ms",
            action.interval_ms.unwrap_or(DEFAULT_POLL_INTERVAL_MS),
            action.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        )
    } else {
        String::new()
    };
    Some(format!(
        "即将执行带 Secret 的 API 测试步骤：\n\n\
         步骤：{}\n\
         请求：{} {}{}{}{}\n\
         Secret：{} 个（值不会显示）\n\n\
         Secret 只能注入到环境 API Base URL 或 secretOrigins 声明的同源地址。",
        action.id,
        action.method,
        url.origin().ascii_serialization(),
        url.path(),
        host_line,
        poll_line,
        secret_count,
    ))
}

#[tauri::command]
pub(crate) async fn issue_api_test_step_lease(
    app: AppHandle,
    repository: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    state: State<'_, ApiTestState>,
    gesture: State<'_, Arc<UserGestureState>>,
    request: ApiTestStepRequest,
) -> Result<Option<ApiTestLeaseIssued>, String> {
    validate_action(&request.action)?;
    let (environment, generation) =
        environment_access(&repository, &workspace, request.environment_id.as_deref()).await?;
    // 同源判定先行：跨源 Secret 请求在弹确认框之前就失败，不消耗用户点击。
    validate_credential_destination(&request.action, &environment)?;
    // 受信环境（`approval_mode = trusted`）：目标落在该环境声明的 origin 集合内时
    // 免逐次原生确认。作用域之外的步骤照旧逐次审批——受信放行的边界是环境自己
    // 声明的地址，不是「任意地址」。
    let target_url = parse_api_url(&request.action.url)?;
    if !trusted_step_allowed(&environment, &target_url) {
        // 与 UI 步骤同一条在场门：校验全部通过后再要求，失败不消耗用户点击。
        // macOS 是「手势 + 内容确认」两层；非 macOS 没有等价手势信号，内容确认框的
        // 那一次点击即充当在场证明（不重复弹框）；无 Secret 的步骤补一次通用确认框。
        let content = secret_step_confirmation(&request.action).map(|message| ContentConfirm {
            title: "确认发送 Secret 的测试步骤",
            message,
            confirm_label: "允许执行",
        });
        let confirmed = require_user_confirmation(
            &app,
            gesture.inner().as_ref(),
            current_operating_system(),
            content,
            ContentConfirm {
                title: "确认执行 API 测试步骤",
                message: format!(
                    "即将执行 API 测试步骤：\n\n步骤：{}\n方法：{}\n目标：{}\n\n确认执行？",
                    request.step_id, request.action.method, request.action.url
                ),
                confirm_label: "允许执行",
            },
        )
        .await?;
        if !confirmed {
            return Ok(None);
        }
    }
    let lease_id = issue_lease(
        &state,
        binding_for(&request, &environment, generation)?,
        Instant::now(),
    )?;
    Ok(Some(ApiTestLeaseIssued {
        lease_id,
        ttl_ms: u64::try_from(LEASE_TTL.as_millis()).unwrap_or(u64::MAX),
    }))
}

#[tauri::command]
pub(crate) async fn run_api_test_step(
    app: AppHandle,
    repository: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    secrets: State<'_, SecretState>,
    state: State<'_, ApiTestState>,
    request: RunApiTestStepRequest,
) -> Result<ApiTestStepResult, String> {
    let started = Instant::now();
    let (environment, generation) = environment_access(
        &repository,
        &workspace,
        request.request.environment_id.as_deref(),
    )
    .await?;
    consume_lease(
        &state,
        &request.lease_id,
        binding_for(&request.request, &environment, generation)?,
        Instant::now(),
    )?;
    let action = &request.request.action;
    let prepared = prepare_request(action, &environment, &secrets, &request.variable_values)?;
    // 敏感提取值不是本次请求的 SecretReference，但可能被后续步骤写进 URL/header/body；
    // 证据必须先按它们脱敏，而不是只按本次注入的 Secret 脱敏。
    let mut evidence_secrets = prepared.secret_values.clone();
    evidence_secrets.extend(
        request
            .sensitive_values
            .iter()
            .filter(|value| !value.is_empty())
            .cloned(),
    );

    let poll = action.action == "api.poll";
    let interval_ms = action.interval_ms.unwrap_or(DEFAULT_POLL_INTERVAL_MS);
    let window_ms = action.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let deadline = started + Duration::from_millis(window_ms);

    let mut attempts: u64 = 0;
    let mut summaries: Vec<Value> = Vec::new();
    let mut summaries_truncated = false;
    let mut outcome = loop {
        // 单次尝试的请求超时：轮询按间隔夹取（端点比间隔还慢就按「尚未就绪」重试），
        // 且不越过剩余窗口；单次执行沿用步骤声明的超时。
        let mut attempt_prepared = prepared.clone();
        if poll {
            let remaining = u64::try_from(
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis(),
            )
            .unwrap_or(0);
            let budget = interval_ms
                .clamp(MIN_POLL_ATTEMPT_TIMEOUT_MS, MAX_POLL_INTERVAL_MS)
                .min(remaining)
                .max(1);
            attempt_prepared.timeout = Duration::from_millis(budget);
        }
        let attempt_started = Instant::now();
        let outcome = match execute_attempt(
            &state,
            &request,
            &attempt_prepared,
            &environment,
            attempt_started,
        )
        .await
        {
            Ok(outcome) => outcome,
            // 尝试间隙里运行被停止：register_request 在 canceled_until 里拦下，转为 canceled 结算。
            Err(message) if message == "运行已停止" => AttemptOutcome::canceled(&message),
            Err(message) => return Err(message),
        };
        attempts += 1;
        if summaries.len() < MAX_POLL_ATTEMPT_SUMMARIES {
            summaries.push(json!({
                "attempt": attempts,
                "status": outcome.status_code,
                "transport": outcome.transport,
                "verdict": outcome.runner_verdict,
                "elapsedMs": outcome.attempt_elapsed_ms,
            }));
        } else {
            summaries_truncated = true;
        }
        let settled = matches!(outcome.runner_verdict, "passed" | "canceled");
        if !poll || settled || Instant::now() >= deadline {
            break outcome;
        }
        // poll：断言失败与传输/求值错误都是「尚未就绪」——窗口内按间隔重试，显式声明的
        // 轮询语义，不违反「无隐式重试」。等待按 250ms 切片检查取消：尝试间隙没有 active
        // 请求，停止请求落在 canceled_until 里，这里据此提前结束（最多滞后 250ms）。
        let mut remaining_wait = Duration::from_millis(interval_ms)
            .min(deadline.saturating_duration_since(Instant::now()));
        while !remaining_wait.is_zero() {
            if cancellation_requested(state.inner(), &request.request.run_id, Instant::now()) {
                break;
            }
            let slice = remaining_wait.min(Duration::from_millis(250));
            tokio::time::sleep(slice).await;
            remaining_wait = remaining_wait.saturating_sub(slice);
        }
        if cancellation_requested(state.inner(), &request.request.run_id, Instant::now()) {
            break AttemptOutcome::canceled("运行已停止");
        }
    };

    let total_elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    evidence_secrets.append(&mut outcome.new_sensitive_values);
    let mut evidence = outcome.evidence;
    if poll {
        if let Some(object) = evidence.as_object_mut() {
            object.insert(
                "poll".to_string(),
                json!({
                    "intervalMs": interval_ms,
                    "timeoutMs": window_ms,
                    "attempts": attempts,
                    "elapsedMs": total_elapsed_ms,
                    "attemptSummaries": summaries,
                    "summariesTruncated": summaries_truncated,
                }),
            );
        }
    }
    let evidence_content_hash =
        persist_evidence(&app, &repository, evidence, &evidence_secrets).await?;

    let canceled = outcome.runner_verdict == "canceled";
    let evaluation_error = outcome.evaluation_error;
    let assertion_failed = outcome.runner_verdict == "failed";
    let message = if canceled {
        outcome.message
    } else if poll && outcome.runner_verdict != "passed" {
        format!(
            "轮询 {window_ms} ms 窗口内未就绪（{attempts} 次尝试）：{}",
            outcome.message
        )
    } else {
        outcome.message
    };
    Ok(ApiTestStepResult {
        verdict: if canceled || evaluation_error {
            "not_evaluated"
        } else if assertion_failed {
            "failed"
        } else {
            "passed"
        }
        .to_string(),
        runner_verdict: outcome.runner_verdict.to_string(),
        transport: outcome.transport.clone(),
        message,
        evidence_content_hash,
        status_code: outcome.status_code,
        elapsed_ms: total_elapsed_ms,
        extracted: outcome.extracted,
    })
}

/// 单次尝试的结算事实。证据只在最终尝试上落盘（轮询可能产生上百次尝试，逐次写
/// Artifact 只会刷屏证据列表），逐次概况由外层汇总进 `poll.attemptSummaries`。
struct AttemptOutcome {
    runner_verdict: &'static str,
    transport: String,
    message: String,
    status_code: Option<u16>,
    attempt_elapsed_ms: u64,
    evidence: Value,
    extracted: BTreeMap<String, ExtractedTestValue>,
    /// 断言/提取求值失败（not_evaluated）：对轮询而言同样是「尚未就绪」，对单次执行是 error。
    evaluation_error: bool,
    /// 本次尝试新产出的敏感提取值：成功尝试才有，交由外层并入证据脱敏名单。
    new_sensitive_values: Vec<String>,
}

impl AttemptOutcome {
    fn canceled(message: &str) -> Self {
        Self {
            runner_verdict: "canceled",
            transport: "canceled".to_string(),
            message: message.to_string(),
            status_code: None,
            attempt_elapsed_ms: 0,
            evidence: json!({
                "schemaVersion": 1,
                "transport": "canceled",
                "message": message,
            }),
            extracted: BTreeMap::new(),
            evaluation_error: false,
            new_sensitive_values: Vec::new(),
        }
    }
}

/// 执行一次请求并完成断言/提取/证据组装。`Err` 只代表命令级失败（注册/状态损坏）；
/// 请求层结果（含传输失败与取消）都折叠为 [`AttemptOutcome`]，让轮询循环自己决策。
async fn execute_attempt(
    state: &ApiTestState,
    request: &RunApiTestStepRequest,
    prepared: &PreparedRequest,
    environment: &TestEnvironmentAccess,
    attempt_started: Instant,
) -> Result<AttemptOutcome, String> {
    let cancel = register_request(state, &request.request.run_id, Instant::now())?;
    let received = send_request(
        prepared,
        environment.allow_private_network,
        &environment.tls_trust,
        &cancel,
    )
    .await;
    remove_request(state, &request.request.run_id)?;
    let elapsed_ms = u64::try_from(attempt_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match received {
        Ok(response) => {
            // H1-4 故障窗口：响应已完整收到，但断言/证据尚未落库。
            crate::runtime_fault::checkpoint_if_configured("test_api_response_received")?;
            let raw_body = String::from_utf8_lossy(&response.body);
            let body_text = redacted(&raw_body, &prepared.secret_values);
            let mut assertions = Vec::new();
            let mut first_failure = None;
            let mut assertion_error = false;
            for expectation in &request.request.action.expect {
                let result = assertion_result(expectation, &response, &body_text, elapsed_ms);
                match result {
                    Ok((passed, kind, expected, actual)) => {
                        if !passed && first_failure.is_none() {
                            first_failure = Some(format!("API 断言失败：{kind}"));
                        }
                        assertions.push(json!({ "kind": kind, "passed": passed, "expected": expected, "actual": actual }));
                    }
                    Err(message) => {
                        assertion_error = true;
                        if first_failure.is_none() {
                            first_failure = Some(message.clone());
                        }
                        assertions.push(
                            json!({ "kind": "invalid", "passed": false, "message": message }),
                        );
                    }
                }
            }
            let extracted_result = extract_values(
                &request.request.action.extract,
                &response,
                &prepared.secret_values,
            );
            let extraction_error = extracted_result.as_ref().err().cloned();
            if first_failure.is_none() {
                first_failure = extraction_error.clone();
            }
            let extracted = extracted_result.unwrap_or_default();
            let extraction_evidence = extracted
                .iter()
                .map(|(name, value)| {
                    (
                        name.clone(),
                        json!({
                            "value": if value.sensitive { json!("[REDACTED]") } else { value.value.clone() },
                            "sensitive": value.sensitive,
                        }),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            // 敏感提取值可能出现在响应正文/断言 actual 里；它们不是请求 SecretReference，
            // 但同样必须先脱敏再写证据。
            let mut new_sensitive_values = Vec::new();
            for value in extracted.values() {
                if !value.sensitive {
                    continue;
                }
                let text = value
                    .value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.value.to_string());
                if !text.is_empty() {
                    new_sensitive_values.push(text);
                }
            }
            let body_for_evidence = if response.truncated || !response_is_textual(&response) {
                None
            } else {
                Some(body_text.as_str())
            };
            let evidence = json!({
                "schemaVersion": 1,
                "request": {
                    "method": prepared.method.as_str(),
                    "url": prepared.url,
                    "headers": prepared.request_headers_for_evidence,
                    "bodyBytes": prepared.body.as_ref().map_or(0, String::len),
                },
                "response": {
                    "status": response.status,
                    "url": response.final_url,
                    "headers": response_headers_for_evidence(&response.headers, &prepared.secret_values),
                    "body": body_for_evidence,
                    "bodySha256": response.body_hash,
                    "totalBytes": response.total_bytes,
                    "truncated": response.truncated,
                    "elapsedMs": elapsed_ms,
                },
                "assertions": assertions,
                "extracted": extraction_evidence,
            });
            let evaluation_error = assertion_error || extraction_error.is_some();
            let assertion_failed = first_failure.is_some() && !evaluation_error;
            Ok(AttemptOutcome {
                runner_verdict: if evaluation_error {
                    "error"
                } else if assertion_failed {
                    "failed"
                } else {
                    "passed"
                },
                transport: "received".to_string(),
                message: first_failure
                    .unwrap_or_else(|| format!("HTTP {} · {} ms", response.status, elapsed_ms)),
                status_code: Some(response.status),
                attempt_elapsed_ms: elapsed_ms,
                evidence,
                extracted,
                evaluation_error,
                new_sensitive_values,
            })
        }
        Err(message) => {
            let canceled = cancel.canceled.load(Ordering::Acquire);
            let transport = transport_for_error(&message, canceled);
            let evidence = json!({
                "schemaVersion": 1,
                "request": {
                    "method": prepared.method.as_str(),
                    "url": prepared.url,
                    "headers": prepared.request_headers_for_evidence,
                    "bodyBytes": prepared.body.as_ref().map_or(0, String::len),
                },
                "transport": transport,
                "message": message,
                "elapsedMs": elapsed_ms,
            });
            Ok(AttemptOutcome {
                runner_verdict: if canceled { "canceled" } else { "error" },
                transport: transport.to_string(),
                message,
                status_code: None,
                attempt_elapsed_ms: elapsed_ms,
                evidence,
                extracted: BTreeMap::new(),
                evaluation_error: !canceled,
                new_sensitive_values: Vec::new(),
            })
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_api_test_run(
    state: State<'_, ApiTestState>,
    run_id: String,
) -> Result<bool, String> {
    cancel_run(&state, &run_id, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn action() -> ApiRequestAction {
        ApiRequestAction {
            id: "load-orders".to_string(),
            action: "api.request".to_string(),
            method: "GET".to_string(),
            url: "https://example.com/orders".to_string(),
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
            body: None,
            body_mode: None,
            timeout_ms: None,
            redirect: None,
            virtual_host: None,
            interval_ms: None,
            expect: vec![json!({"status": 200})],
            extract: BTreeMap::new(),
        }
    }

    fn access() -> TestEnvironmentAccess {
        TestEnvironmentAccess {
            allow_private_network: false,
            headers: BTreeMap::new(),
            secret_ids: BTreeSet::new(),
            api_base_url: Some("https://example.com".to_string()),
            secret_origins: BTreeSet::new(),
            tls_trust: "system".to_string(),
            approval_mode: "per_step".to_string(),
            web_base_url: None,
        }
    }

    /// 受信放行的作用域是环境自己声明的 origin 集合：环境内的目标免逐次确认，
    /// 环境外的目标照旧逐次确认。
    #[test]
    fn trusted_scope_covers_only_the_declared_origins() {
        let mut environment = access();
        environment.approval_mode = "trusted".to_string();
        environment.web_base_url = Some("https://shop.example.com".to_string());
        environment.secret_origins = BTreeSet::from(["https://admin.example.com:8443".to_string()]);

        let in_scope = parse_api_url("https://example.com/orders").unwrap();
        assert!(trusted_step_allowed(&environment, &in_scope));
        let web_in_scope = parse_api_url("https://shop.example.com/login").unwrap();
        assert!(trusted_step_allowed(&environment, &web_in_scope));
        let secret_origin = parse_api_url("https://admin.example.com:8443/console").unwrap();
        assert!(trusted_step_allowed(&environment, &secret_origin));

        let out_of_scope = parse_api_url("https://attacker.example/orders").unwrap();
        assert!(!trusted_step_allowed(&environment, &out_of_scope));
        // 同 host 不同端口不算同一 origin。
        let other_port = parse_api_url("https://example.com:8443/orders").unwrap();
        assert!(!trusted_step_allowed(&environment, &other_port));

        // 未受信的环境：作用域判定为真，但放行判定为假。
        environment.approval_mode = "per_step".to_string();
        assert!(within_trusted_scope(&environment, &in_scope));
        assert!(!trusted_step_allowed(&environment, &in_scope));
    }

    #[test]
    fn lease_is_single_use_and_binds_environment() {
        let state = ApiTestState::default();
        let request = ApiTestStepRequest {
            run_id: "run-1".to_string(),
            step_id: "load-orders".to_string(),
            environment_id: Some("staging".to_string()),
            action: action(),
        };
        let now = Instant::now();
        let id = issue_lease(&state, binding_for(&request, &access(), 1).unwrap(), now).unwrap();
        assert!(consume_lease(
            &state,
            &id,
            binding_for(&request, &access(), 1).unwrap(),
            now
        )
        .is_ok());
        assert!(consume_lease(
            &state,
            &id,
            binding_for(&request, &access(), 1).unwrap(),
            now
        )
        .is_err());
    }

    #[test]
    fn cancellation_between_poll_attempts_is_observed() {
        let state = ApiTestState::default();
        let now = Instant::now();
        assert!(!cancellation_requested(&state, "run-gap", now));
        cancel_run(&state, "run-gap", now).unwrap();
        assert!(cancellation_requested(&state, "run-gap", now));
        // 间隙取消只在 TTL 内有效：过期后视为未取消（与 register_request 的清理窗口一致）。
        assert!(!cancellation_requested(
            &state,
            "run-gap",
            now + LEASE_TTL + Duration::from_secs(1)
        ));
    }

    #[test]
    fn cancellation_before_request_registration_is_not_lost() {
        let state = ApiTestState::default();
        let now = Instant::now();
        assert!(cancel_run(&state, "run-canceled", now).unwrap());
        assert!(matches!(
            register_request(&state, "run-canceled", now),
            Err(message) if message == "运行已停止"
        ));
        assert!(register_request(&state, "run-canceled", now + LEASE_TTL).is_ok());
    }

    #[test]
    fn plaintext_sensitive_headers_are_rejected() {
        let mut value = action();
        value.headers.insert(
            "Authorization".to_string(),
            ApiHeaderValue::Plain("Bearer leaked".to_string()),
        );
        let secrets = SecretState::default();
        assert!(prepare_request(&value, &access(), &secrets, &BTreeMap::new()).is_err());

        let mut custom = action();
        custom.headers.insert(
            "X-Custom-Auth".to_string(),
            ApiHeaderValue::Plain("token=ghp_leaked".to_string()),
        );
        assert!(prepare_request(&custom, &access(), &secrets, &BTreeMap::new()).is_err());

        let mut environment = access();
        environment
            .headers
            .insert("X-Custom-Auth".to_string(), "Bearer leaked".to_string());
        assert!(prepare_request(&action(), &environment, &secrets, &BTreeMap::new()).is_err());
    }

    #[test]
    fn plaintext_credentials_in_query_body_and_expectations_are_rejected() {
        let secrets = SecretState::default();

        let mut query = action();
        query.query.insert("token".to_string(), json!("ghp_leaked"));
        assert!(prepare_request(&query, &access(), &secrets, &BTreeMap::new()).is_err());

        let mut body = action();
        body.method = "POST".to_string();
        body.body = Some(json!({ "token": "ghp_leaked" }));
        assert!(prepare_request(&body, &access(), &secrets, &BTreeMap::new()).is_err());

        let mut expectation = action();
        expectation.expect = vec![json!({
            "headerEquals": { "name": "x-trace", "value": "Bearer leaked" }
        })];
        assert!(prepare_request(&expectation, &access(), &secrets, &BTreeMap::new()).is_err());
    }

    #[test]
    fn sensitive_response_header_assertions_are_rejected() {
        let mut value = action();
        value.expect = vec![json!({
            "headerEquals": { "name": "set-cookie", "value": "session=abc" }
        })];
        let secrets = SecretState::default();
        assert!(prepare_request(&value, &access(), &secrets, &BTreeMap::new()).is_err());
    }

    #[test]
    fn injects_only_environment_allowed_secrets_and_redacts_evidence_headers() {
        let mut value = action();
        value.headers.insert(
            "Authorization".to_string(),
            ApiHeaderValue::Secret(ApiSecretReference {
                secret_id: "apitest.orders-token".to_string(),
            }),
        );
        let mut environment = access();
        environment
            .secret_ids
            .insert("apitest.orders-token".to_string());
        let secrets = SecretState::default();
        crate::secrets::store_api_test_secret(
            &secrets,
            "apitest.orders-token",
            "Bearer top-secret",
        )
        .unwrap();
        let prepared = prepare_request(&value, &environment, &secrets, &BTreeMap::new()).unwrap();
        assert_eq!(
            prepared.headers.get("authorization").unwrap(),
            "Bearer top-secret"
        );
        assert_eq!(
            prepared
                .request_headers_for_evidence
                .get("Authorization")
                .map(String::as_str),
            Some("[REDACTED]")
        );
    }

    #[test]
    fn secret_steps_produce_a_content_confirmation_without_leaking_values() {
        let mut value = action();
        assert_eq!(secret_step_confirmation(&value), None);

        value.headers.insert(
            "Authorization".to_string(),
            ApiHeaderValue::Secret(ApiSecretReference {
                secret_id: "apitest.orders-token".to_string(),
            }),
        );
        let message = secret_step_confirmation(&value).expect("secret step confirmation");
        assert!(message.contains("GET https://example.com/orders"));
        assert!(message.contains("Secret：1 个"));
        assert!(!message.contains("top-secret"));
    }

    #[test]
    fn secrets_are_bound_to_the_environment_api_origin() {
        let mut value = action();
        value.headers.insert(
            "Authorization".to_string(),
            ApiHeaderValue::Secret(ApiSecretReference {
                secret_id: "apitest.orders-token".to_string(),
            }),
        );
        let mut environment = access();
        environment
            .secret_ids
            .insert("apitest.orders-token".to_string());
        let secrets = SecretState::default();
        crate::secrets::store_api_test_secret(
            &secrets,
            "apitest.orders-token",
            "Bearer top-secret",
        )
        .unwrap();

        let mut cross_origin = value.clone();
        cross_origin.url = "https://attacker.example/orders".to_string();
        assert_eq!(
            prepare_request(&cross_origin, &environment, &secrets, &BTreeMap::new())
                .err()
                .as_deref(),
            Some("凭据只能发送到测试环境 API Base URL 或 secretOrigins 声明的同源地址"),
        );

        let mut different_port = value.clone();
        different_port.url = "https://example.com:8443/orders".to_string();
        assert_eq!(
            prepare_request(&different_port, &environment, &secrets, &BTreeMap::new())
                .err()
                .as_deref(),
            Some("凭据只能发送到测试环境 API Base URL 或 secretOrigins 声明的同源地址"),
        );

        let no_base = TestEnvironmentAccess {
            allow_private_network: false,
            headers: BTreeMap::new(),
            secret_ids: BTreeSet::from(["apitest.orders-token".to_string()]),
            api_base_url: None,
            secret_origins: BTreeSet::new(),
            tls_trust: "system".to_string(),
            approval_mode: "per_step".to_string(),
            web_base_url: None,
        };
        assert_eq!(
            prepare_request(&value, &no_base, &secrets, &BTreeMap::new())
                .err()
                .as_deref(),
            Some("使用凭据的请求需要测试环境配置 API Base URL 或 secretOrigins"),
        );
    }

    #[test]
    fn evaluates_status_and_json_pointer_assertions() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let response = ReceivedResponse {
            status: 200,
            headers,
            body: br#"{"ok":true}"#.to_vec(),
            total_bytes: 11,
            body_hash: "hash".to_string(),
            truncated: false,
            final_url: Url::parse("https://example.com").unwrap(),
        };
        assert!(
            assertion_result(&json!({"status": 200}), &response, "{\"ok\":true}", 10)
                .unwrap()
                .0
        );
        assert!(
            assertion_result(
                &json!({"jsonPointerEquals": {"pointer": "/ok", "value": true}}),
                &response,
                "{\"ok\":true}",
                10
            )
            .unwrap()
            .0
        );
    }

    #[test]
    fn extracts_scalar_json_and_headers_without_admitting_secrets_or_objects() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-trace-id", HeaderValue::from_static("trace-1"));
        let response = ReceivedResponse {
            status: 200,
            headers,
            body: br#"{"id":42,"nested":{"value":1},"echo":"top-secret"}"#.to_vec(),
            total_bytes: 51,
            body_hash: "hash".to_string(),
            truncated: false,
            final_url: Url::parse("https://example.com").unwrap(),
        };
        let extractions = BTreeMap::from([
            (
                "orderId".to_string(),
                ApiExtraction {
                    json_pointer: Some("/id".to_string()),
                    header: None,
                    sensitive: false,
                },
            ),
            (
                "traceId".to_string(),
                ApiExtraction {
                    json_pointer: None,
                    header: Some("x-trace-id".to_string()),
                    sensitive: true,
                },
            ),
        ]);
        let extracted =
            extract_values(&extractions, &response, &["top-secret".to_string()]).unwrap();
        assert_eq!(extracted["orderId"].value, json!(42));
        assert!(extracted["traceId"].sensitive);

        let object = BTreeMap::from([(
            "nested".to_string(),
            ApiExtraction {
                json_pointer: Some("/nested".to_string()),
                header: None,
                sensitive: false,
            },
        )]);
        assert!(extract_values(&object, &response, &[]).is_err());

        let secret = BTreeMap::from([(
            "echo".to_string(),
            ApiExtraction {
                json_pointer: Some("/echo".to_string()),
                header: None,
                sensitive: true,
            },
        )]);
        assert!(extract_values(&secret, &response, &["top-secret".to_string()]).is_err());
    }

    #[test]
    fn redacts_every_secret_occurrence() {
        assert_eq!(
            redacted("token=abc and abc", &["abc".to_string()]),
            "token=[REDACTED] and [REDACTED]"
        );
    }

    #[test]
    fn encodes_form_body_without_accepting_nested_values() {
        assert_eq!(
            encode_form_body(&json!({"name": "A B", "active": true})).unwrap(),
            "active=true&name=A+B"
        );
        assert!(encode_form_body(&json!({"nested": {"value": 1}})).is_err());
    }

    async fn fixture_url(response: Vec<u8>, delay: Duration) -> Url {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).await;
            tokio::time::sleep(delay).await;
            let _ = stream.write_all(&response).await;
        });
        Url::parse(&format!("http://{address}/api")).unwrap()
    }

    fn prepared_for(url: Url, timeout: Duration, redirect: &str) -> PreparedRequest {
        PreparedRequest {
            method: Method::GET,
            url,
            headers: HeaderMap::new(),
            request_headers_for_evidence: BTreeMap::new(),
            body: None,
            timeout,
            redirect: redirect.to_string(),
            secret_values: Vec::new(),
        }
    }

    #[tokio::test]
    async fn received_404_is_not_a_transport_error() {
        let body = br#"{"error":"missing"}"#;
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect();
        let url = fixture_url(response, Duration::ZERO).await;
        let result = send_request(
            &prepared_for(url, Duration::from_secs(1), "manual"),
            true,
            "system",
            &ApiTestCancel::default(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, 404);
    }

    #[tokio::test]
    async fn timeout_and_cancel_interrupt_in_flight_requests() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec();
        let url = fixture_url(response.clone(), Duration::from_millis(200)).await;
        let timed_out = send_request(
            &prepared_for(url, Duration::from_millis(20), "manual"),
            true,
            "system",
            &ApiTestCancel::default(),
        )
        .await;
        assert!(matches!(timed_out, Err(message) if message == "API 请求超时"));

        let url = fixture_url(response, Duration::from_secs(5)).await;
        let cancel = Arc::new(ApiTestCancel::default());
        let trigger = Arc::clone(&cancel);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            trigger.canceled.store(true, Ordering::Release);
            trigger.notify.notify_one();
        });
        let started = Instant::now();
        let canceled = send_request(
            &prepared_for(url, Duration::from_secs(10), "manual"),
            true,
            "system",
            &cancel,
        )
        .await;
        assert!(matches!(canceled, Err(message) if message == "运行已停止"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn cross_origin_redirect_is_blocked_without_query_leakage() {
        let response = b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private?token=hidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let url = fixture_url(response, Duration::ZERO).await;
        let error = send_request(
            &prepared_for(url, Duration::from_secs(1), "same-origin"),
            true,
            "system",
            &ApiTestCancel::default(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("跨源重定向已阻止"));
        assert!(!error.contains("token=hidden"));
    }

    #[tokio::test]
    async fn oversized_response_keeps_only_the_bounded_prefix_and_full_hash() {
        let body = vec![b'x'; MAX_RESPONSE_BYTES + 1];
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let response = header
            .into_bytes()
            .into_iter()
            .chain(body.iter().copied())
            .collect();
        let url = fixture_url(response, Duration::ZERO).await;
        let result = send_request(
            &prepared_for(url, Duration::from_secs(2), "manual"),
            true,
            "system",
            &ApiTestCancel::default(),
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert_eq!(result.body.len(), MAX_RESPONSE_BYTES);
        assert_eq!(result.total_bytes, MAX_RESPONSE_BYTES + 1);
        assert_eq!(result.body_hash, hex_digest(&body));
    }

    // ---- v4：virtualHost / api.poll / 新断言 / secretOrigins ----

    #[test]
    fn body_not_contains_is_a_negative_assertion() {
        let response = response_with(
            200,
            r#"{"err":"","data":{"token":"hidden"}}"#,
            &[("content-type", "application/json")],
        );
        let body_text = String::from_utf8_lossy(&response.body).to_string();
        let evaluate = |expectation: Value| {
            assertion_result(&expectation, &response, &body_text, 1).map(|(passed, _, _, _)| passed)
        };
        assert!(evaluate(json!({"bodyNotContains": "leaked"})).unwrap());
        assert!(!evaluate(json!({"bodyNotContains": "hidden"})).unwrap());
        assert!(evaluate(json!({"bodyNotContains": ""})).is_ok());
    }

    #[test]
    fn status_in_assertions_accept_any_listed_code() {
        let response = response_with(404, "{}", &[]);
        let evaluate = |expectation: Value| {
            assertion_result(&expectation, &response, "", 1).map(|(passed, _, _, _)| passed)
        };
        assert!(evaluate(json!({"statusIn": [200, 404]})).unwrap());
        assert!(!evaluate(json!({"statusIn": [200, 204]})).unwrap());
        assert!(evaluate(json!({"statusIn": []})).is_err());
        assert!(evaluate(json!({"statusIn": "404"})).is_err());
    }

    #[test]
    fn virtual_host_shape_is_validated() {
        for bad in [
            "",
            "https://api.example.test",
            "api.example.test/path",
            "user:pass@host",
            "host:99999",
            "host:0x10",
            "-lead.example.test",
            "a:1:2",
        ] {
            let mut value = action();
            value.virtual_host = Some(bad.to_string());
            assert!(
                validate_action(&value).is_err(),
                "virtualHost「{bad}」应当被拒绝"
            );
        }
        let mut value = action();
        value.virtual_host = Some("shop.example.test:8443".to_string());
        assert!(validate_action(&value).is_ok());
    }

    #[test]
    fn virtual_host_overrides_the_host_header_only() {
        let mut value = action();
        value.url = "http://127.0.0.1:8081/orders".to_string();
        value.virtual_host = Some("shop.example.test".to_string());
        let prepared =
            prepare_request(&value, &access(), &SecretState::default(), &BTreeMap::new()).unwrap();
        assert_eq!(
            prepared.headers.get(reqwest::header::HOST).unwrap(),
            "shop.example.test"
        );
        assert_eq!(
            prepared.request_headers_for_evidence.get("host").unwrap(),
            "shop.example.test"
        );
        // 普通 headers 通道依旧拒绝 host：覆盖只能走显式 virtualHost 字段。
        let mut plain = action();
        plain.headers.insert(
            "Host".to_string(),
            ApiHeaderValue::Plain("evil.example.test".to_string()),
        );
        assert!(
            prepare_request(&plain, &access(), &SecretState::default(), &BTreeMap::new()).is_err()
        );
    }

    #[test]
    fn virtual_host_is_sent_on_the_wire() {
        use std::io::{Read, Write};

        // 真实 TCP 回环服务：读完整请求头后回 200，用来验证 Host 覆盖确实生效于网络线。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 512];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            }
            stream
                .write_all(
                    b"HTTP/1.1 200 OK
Content-Length: 2
Content-Type: text/plain
Connection: close

ok",
                )
                .unwrap();
            String::from_utf8_lossy(&request).to_string()
        });

        let mut value = action();
        value.url = format!("http://{}/orders", addr);
        value.virtual_host = Some("shop.example.test".to_string());
        let prepared =
            prepare_request(&value, &access(), &SecretState::default(), &BTreeMap::new()).unwrap();
        let cancel = ApiTestCancel::default();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let response = runtime
            .block_on(send_request(&prepared, true, "system", &cancel))
            .unwrap();
        assert_eq!(response.status, 200);
        let request = server.join().unwrap();
        let lowered = request.to_ascii_lowercase();
        assert!(
            lowered.contains("host: shop.example.test"),
            "Host 覆盖未生效，实际请求：{request}"
        );
        // 只在线上出现一次 Host 头：不能出现「URL 主机 + 覆盖主机」两份。
        assert_eq!(
            lowered.matches("\nhost:").count(),
            1,
            "重复 Host 头：{request}"
        );
    }

    #[test]
    fn poll_actions_must_stay_idempotent_and_bounded() {
        let mut poll_post = action();
        poll_post.action = "api.poll".to_string();
        poll_post.method = "POST".to_string();
        assert_eq!(
            validate_action(&poll_post).err().as_deref(),
            Some("api.poll 只允许 GET 或 HEAD（轮询必须保持幂等读）")
        );

        let mut poll_no_expect = action();
        poll_no_expect.action = "api.poll".to_string();
        poll_no_expect.expect = Vec::new();
        assert_eq!(
            validate_action(&poll_no_expect).err().as_deref(),
            Some("api.poll 必须声明至少一条就绪断言")
        );

        let mut poll_interval_too_fast = action();
        poll_interval_too_fast.action = "api.poll".to_string();
        poll_interval_too_fast.interval_ms = Some(100);
        assert!(validate_action(&poll_interval_too_fast)
            .err()
            .is_some_and(|message| message.contains("500")));

        let mut request_with_interval = action();
        request_with_interval.interval_ms = Some(2_000);
        assert_eq!(
            validate_action(&request_with_interval).err().as_deref(),
            Some("intervalMs 只属于 api.poll 步骤")
        );

        // api.poll 的合法形态：GET + expect + 窗口与间隔。
        let mut poll = action();
        poll.action = "api.poll".to_string();
        poll.method = "GET".to_string();
        poll.interval_ms = Some(2_000);
        poll.timeout_ms = Some(60_000);
        assert!(validate_action(&poll).is_ok());

        // binding_for 接受两种动作名（api.delay 是 Runner 本地步骤，永远不进 Rust）。
        let request = ApiTestStepRequest {
            run_id: "run-1".to_string(),
            step_id: "load-orders".to_string(),
            environment_id: None,
            action: poll,
        };
        assert!(binding_for(&request, &access(), 1).is_ok());
    }

    #[test]
    fn secrets_may_target_declared_service_origins() {
        let mut value = action();
        value.url = "http://127.0.0.1:18081/healthz".to_string();
        value.headers.insert(
            "X-Quoin-Secret".to_string(),
            ApiHeaderValue::Secret(ApiSecretReference {
                secret_id: "apitest.detector-secret".to_string(),
            }),
        );
        let mut environment = access();
        environment
            .secret_ids
            .insert("apitest.detector-secret".to_string());
        let secrets = SecretState::default();
        crate::secrets::store_api_test_secret(&secrets, "apitest.detector-secret", "shared-secret")
            .unwrap();

        // 未声明该 origin：拒绝（api_base_url 是 https://example.com，不同源）。
        assert!(prepare_request(&value, &environment, &secrets, &BTreeMap::new()).is_err());

        // 声明数据面管理面 origin 后放行；另一个未声明 origin 仍拒绝。
        environment
            .secret_origins
            .insert("http://127.0.0.1:18081".to_string());
        assert!(prepare_request(&value, &environment, &secrets, &BTreeMap::new()).is_ok());

        let mut other_port = value.clone();
        other_port.url = "http://127.0.0.1:18082/healthz".to_string();
        assert!(prepare_request(&other_port, &environment, &secrets, &BTreeMap::new()).is_err());
    }

    #[test]
    fn runtime_credentials_are_injected_and_destination_bound() {
        let mut value = action();
        value.headers.insert(
            "Authorization".to_string(),
            ApiHeaderValue::Variable(ApiVariableReference {
                variable: "token".to_string(),
                prefix: Some("Bearer ".to_string()),
            }),
        );
        let environment = access(); // api_base_url = https://example.com
        let secrets = SecretState::default();
        let mut values = BTreeMap::new();
        values.insert("token".to_string(), "jwt-abc".to_string());

        let prepared = prepare_request(&value, &environment, &secrets, &values).unwrap();
        assert_eq!(
            prepared
                .headers
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer jwt-abc"
        );
        // 证据按凭据脱敏（值本身进入脱敏名单，正文出现也会被替换）。
        assert_eq!(
            prepared
                .request_headers_for_evidence
                .get("Authorization")
                .unwrap(),
            "[REDACTED]"
        );
        assert!(prepared
            .secret_values
            .iter()
            .any(|secret| secret == "Bearer jwt-abc"));

        // 缺取值：明确失败，不静默发空头。
        assert_eq!(
            prepare_request(&value, &environment, &secrets, &BTreeMap::new())
                .err()
                .as_deref(),
            Some("运行时凭据变量「token」缺少取值")
        );

        // 同一套目的地边界：跨源与未授权环境都拒绝。
        let mut cross_origin = value.clone();
        cross_origin.url = "https://attacker.example/orders".to_string();
        assert!(prepare_request(&cross_origin, &environment, &secrets, &values).is_err());

        let no_destination = TestEnvironmentAccess {
            allow_private_network: false,
            headers: BTreeMap::new(),
            secret_ids: BTreeSet::new(),
            api_base_url: None,
            secret_origins: BTreeSet::new(),
            tls_trust: "system".to_string(),
            approval_mode: "per_step".to_string(),
            web_base_url: None,
        };
        assert_eq!(
            prepare_request(&value, &no_destination, &secrets, &values)
                .err()
                .as_deref(),
            Some("使用凭据的请求需要测试环境配置 API Base URL 或 secretOrigins")
        );

        // 名字/前缀形状校验。
        let mut bad_name = value.clone();
        bad_name.headers.insert(
            "Authorization".to_string(),
            ApiHeaderValue::Variable(ApiVariableReference {
                variable: "1bad".to_string(),
                prefix: None,
            }),
        );
        assert!(validate_action(&bad_name).is_err());
    }

    fn response_with(status: u16, body: &str, headers: &[(&str, &str)]) -> ReceivedResponse {
        let mut header_map = HeaderMap::new();
        for (name, header_value) in headers {
            header_map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(header_value).unwrap(),
            );
        }
        ReceivedResponse {
            status,
            headers: header_map,
            body: body.as_bytes().to_vec(),
            total_bytes: body.len(),
            body_hash: String::new(),
            truncated: false,
            final_url: Url::parse("https://example.test/").unwrap(),
        }
    }

    #[test]
    fn v4_assertion_variants_evaluate_in_rust() {
        let response = response_with(
            200,
            r#"{"data":{"items":[1,2,3],"total":7},"err":""}"#,
            &[
                ("x-security-block", "waf"),
                ("content-type", "application/json"),
            ],
        );
        let body_text = String::from_utf8_lossy(&response.body).to_string();

        let evaluate = |expectation: Value| {
            assertion_result(&expectation, &response, &body_text, 12)
                .map(|(passed, _, _, _)| passed)
        };
        assert!(evaluate(json!({"headerExists": {"name": "x-security-block"}})).unwrap());
        assert!(!evaluate(json!({"headerAbsent": {"name": "x-security-block"}})).unwrap());
        assert!(evaluate(json!({"headerAbsent": {"name": "x-missing"}})).unwrap());
        assert!(evaluate(
            json!({"jsonPointerLengthEquals": {"pointer": "/data/items", "value": 3}})
        )
        .unwrap());
        assert!(!evaluate(
            json!({"jsonPointerLengthEquals": {"pointer": "/data/items", "value": 4}})
        )
        .unwrap());
        assert!(evaluate(
            json!({"jsonPointerNumberAtLeast": {"pointer": "/data/total", "value": 7}})
        )
        .unwrap());
        assert!(evaluate(
            json!({"jsonPointerNumberAtMost": {"pointer": "/data/total", "value": 7.5}})
        )
        .unwrap());
        assert!(!evaluate(
            json!({"jsonPointerNumberAtLeast": {"pointer": "/data/total", "value": 8}})
        )
        .unwrap());
        // 非数组/非数字目标按不成立处理（不是求值错误）。
        assert!(!evaluate(
            json!({"jsonPointerLengthEquals": {"pointer": "/data/total", "value": 1}})
        )
        .unwrap());
        assert!(!evaluate(
            json!({"jsonPointerNumberAtLeast": {"pointer": "/data/items", "value": 0}})
        )
        .unwrap());
        // 敏感响应头的存在性断言在 validate_action 就被拒绝（与 TS 解析器同判据）。
        let mut sensitive = action();
        sensitive.expect = vec![json!({"headerExists": {"name": "set-cookie"}})];
        assert_eq!(
            validate_action(&sensitive).err().as_deref(),
            Some("敏感响应头不能用于断言（避免实际值进入证据）")
        );
    }
}
