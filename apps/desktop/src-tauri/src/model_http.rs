use crate::{
    generated_provider_table::{
        PROVIDER_REQUEST_HEADERS, PROVIDER_SESSION_HEADER_HOSTS, PROVIDER_SESSION_HEADERS,
    },
    network_policy::redirect_policy,
    provider_profiles::{is_secret_id_bound_to_provider, resolve_profile, ResolvedProfile},
    secrets::{load_secret, SecretState},
};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, State};
use tokio::sync::watch;
use tokio::time::{sleep, timeout};

const MODEL_STREAM_EVENT: &str = "axiom:model-stream";
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_DETAIL_BYTES: usize = 4 * 1024;
const MAX_EVENT_CHUNK_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_RETRIES: u32 = 5;
const BASE_RETRY_DELAY_MS: u64 = 500;
const MAX_BACKOFF_DELAY_MS: u64 = 8_000;
const MAX_RETRY_DELAY_MS: u64 = 60_000;
const REDACTED_SECRET_BYTES: &[u8] = b"[REDACTED]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelApiFormat {
    OpenaiCompatible,
    OpenaiResponses,
    AnthropicCompatible,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelHttpRequest {
    request_id: String,
    provider_id: String,
    endpoint: Option<String>,
    body: String,
    secret_id: Option<String>,
    timeout_ms: Option<u64>,
    /// 本次请求使用的模型：多协议 provider（模型级 wire）据此选协议与端点。只是查表键
    /// ——最终 URL/协议/认证头仍由 Rust 权威解析（`resolve_profile`），未知模型回落
    /// provider 默认协议。
    model_id: Option<String>,
    /// 会话身份：仅用于 provider 声明的会话头（`x-opencode-session` 等）按会话归因，
    /// 不参与 URL/认证解析。
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProbeRequest {
    provider_id: String,
    endpoint: Option<String>,
    body: String,
    secret_id: Option<String>,
    timeout_ms: Option<u64>,
    model_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProbeResult {
    ok: bool,
    status: Option<u16>,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelStreamChunk {
    request_id: String,
    status: Option<u16>,
    chunk: Option<Vec<u8>>,
    done: bool,
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct ModelRequestState(Mutex<HashMap<String, watch::Sender<bool>>>);

struct SecretRedactor {
    needle: Option<Vec<u8>>,
    pending: Vec<u8>,
}

impl SecretRedactor {
    fn new(secret: Option<&str>) -> Self {
        Self {
            needle: secret
                .filter(|value| !value.is_empty())
                .map(|value| value.as_bytes().to_vec()),
            pending: Vec::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let Some(needle) = &self.needle else {
            return bytes.to_vec();
        };
        self.pending.extend_from_slice(bytes);
        let ready_bytes = self
            .pending
            .len()
            .saturating_sub(needle.len().saturating_sub(1));
        self.drain(ready_bytes)
    }

    fn finish(&mut self) -> Vec<u8> {
        let ready_bytes = self.pending.len();
        self.drain(ready_bytes)
    }

    fn drain(&mut self, ready_bytes: usize) -> Vec<u8> {
        let Some(needle) = &self.needle else {
            return std::mem::take(&mut self.pending);
        };
        let mut output = Vec::new();
        let mut index = 0usize;
        while index < ready_bytes {
            if self.pending[index..].starts_with(needle) {
                output.extend_from_slice(REDACTED_SECRET_BYTES);
                index += needle.len();
            } else {
                output.push(self.pending[index]);
                index += 1;
            }
        }
        self.pending.drain(..index);
        output
    }
}

fn register_request(
    state: &ModelRequestState,
    request_id: &str,
) -> Result<(String, watch::Receiver<bool>), String> {
    let request_id = crate::request_id::validate_request_id("model", request_id)?.to_string();
    let (sender, receiver) = watch::channel(false);
    let mut requests = state
        .0
        .lock()
        .map_err(|_| "model request state lock is poisoned".to_string())?;
    if let Some(previous) = requests.insert(request_id.clone(), sender) {
        let _ = previous.send(true);
    }
    Ok((request_id, receiver))
}

fn unregister_request(state: &ModelRequestState, request_id: &str) {
    if let Ok(mut requests) = state.0.lock() {
        requests.remove(request_id);
    }
}

fn timeout_duration(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, 300_000),
    )
}

fn build_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(timeout)
        .redirect(redirect_policy())
        .build()
        .map_err(|error| error.to_string())
}

/// provider 声明的静态请求头（providers.json `requestHeaders` 生成表）。`{version}`
/// 占位替换为应用版本——生成物保持字面量，发版不会触发生成产物 digest 漂移。
fn provider_request_headers(provider_id: &str) -> &'static [(&'static str, &'static str)] {
    PROVIDER_REQUEST_HEADERS
        .iter()
        .find(|(id, _)| *id == provider_id)
        .map(|(_, headers)| *headers)
        .unwrap_or(&[])
}

fn provider_session_header(provider_id: &str) -> Option<&'static str> {
    PROVIDER_SESSION_HEADERS
        .iter()
        .find(|(id, _)| *id == provider_id)
        .map(|(_, header)| *header)
}

/// 会话头解析：provider 声明优先，其次按**解析后的 host** 命中服务级声明。
///
/// 为什么需要 host 级：上游的要求属于服务（「发往 opencode.ai 的所有推理请求」），
/// 而不是某个 provider 条目——把 OpenCode Go 配成自定义 provider（自定义 endpoint 指向
/// opencode.ai）的用户同样必须带这个头，否则 400 MissingSessionID。host 集合由生成器从
/// 声明了会话头的 provider 的默认 endpoint 与 trustedHosts 派生。
fn session_header_for(provider_id: &str, host: Option<&str>) -> Option<&'static str> {
    if let Some(header) = provider_session_header(provider_id) {
        return Some(header);
    }
    let host = host?.trim().to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    PROVIDER_SESSION_HEADER_HOSTS
        .iter()
        .find(|(declared, _)| host == *declared || host.ends_with(&format!(".{declared}")))
        .map(|(_, header)| *header)
}

fn apply_static_headers(
    mut builder: reqwest::RequestBuilder,
    provider_id: &str,
) -> reqwest::RequestBuilder {
    for (name, value) in provider_request_headers(provider_id) {
        let value = value.replace("{version}", env!("CARGO_PKG_VERSION"));
        builder = builder.header(*name, value);
    }
    builder
}

/// provider 声明的会话头（providers.json `sessionHeader` 生成表）。
///
/// **该头必须恒存在**：上游按它做会话归因/路由，缺失时直接 400（OpenCode Go：
/// 「Request is missing x-opencode-session and cannot be routed efficiently」）——
/// 探针（无会话身份）与任何未带 sessionId 的请求都不能省略它。因此缺失时回落一个
/// 进程内稳定的合成值：路由只需要一个稳定的非空标识，而合成值不会把不同会话混为
/// 同一个（真实会话仍用真实 sessionId）。
fn apply_session_header(
    builder: reqwest::RequestBuilder,
    provider_id: &str,
    host: Option<&str>,
    session_id: Option<&str>,
) -> reqwest::RequestBuilder {
    let Some(header) = session_header_for(provider_id, host) else {
        return builder;
    };
    let session_id = session_id.map(str::trim).filter(|value| !value.is_empty());
    match session_id {
        Some(session_id) => builder.header(header, session_id),
        None => builder.header(header, fallback_client_session_id()),
    }
}

/// 无会话身份时使用的稳定标识（如探针、标题生成等宿主自发的请求）。
/// 进程内稳定：同一进程的多次请求得到同一值，上游的路由/归因不会因每次请求变化而失效。
fn fallback_client_session_id() -> &'static str {
    static FALLBACK: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    FALLBACK.get_or_init(|| {
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();
        format!("axiom-desktop-{}-{started}", std::process::id())
    })
}

fn apply_authentication(
    mut builder: reqwest::RequestBuilder,
    api_format: ModelApiFormat,
    secret: Option<&str>,
) -> Result<reqwest::RequestBuilder, String> {
    if let Some(secret) = secret {
        let mut value = match api_format {
            ModelApiFormat::OpenaiCompatible | ModelApiFormat::OpenaiResponses => {
                HeaderValue::from_str(&format!("Bearer {secret}"))
            }
            ModelApiFormat::AnthropicCompatible => HeaderValue::from_str(secret),
        }
        .map_err(|_| "API key contains invalid header characters".to_string())?;
        value.set_sensitive(true);
        builder = match api_format {
            ModelApiFormat::OpenaiCompatible | ModelApiFormat::OpenaiResponses => {
                builder.header(AUTHORIZATION, value)
            }
            ModelApiFormat::AnthropicCompatible => builder.header("x-api-key", value),
        };
    }
    if matches!(api_format, ModelApiFormat::AnthropicCompatible) {
        builder = builder.header("anthropic-version", "2023-06-01");
    }
    Ok(builder)
}

// pub(crate)：usage_query 复用同一密钥解析边界（provider 绑定校验 + 密钥库读取），
// 保证用量查询与模型请求对 Secret 的约束始终一致。
pub(crate) fn resolve_secret(
    state: &SecretState,
    provider_id: &str,
    secret_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(secret_id) = secret_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    // 请求期绑定校验：secret 必须属于当前 provider（current 或 legacy namespace）。
    // 封死跨 Provider 组合——受陷渲染进程无法把 provider B 的密钥发到 provider A 允许的端点。
    if !is_secret_id_bound_to_provider(provider_id, secret_id) {
        return Err(format!(
            "secret {secret_id} is not bound to provider {provider_id}"
        ));
    }
    match load_secret(state, secret_id)? {
        Some(secret) => Ok(Some(secret)),
        None => Err(format!(
            "configured API key is missing from secure storage ({secret_id})"
        )),
    }
}

/// 解析 Provider Profile 并校验端点（强边界）。
///
/// 渲染进程只传 providerId、可选的 endpoint 覆盖与 modelId；最终 URL、apiFormat、允许的
/// origin 全部由 `provider_profiles` 按内置表解析。自定义端点必须命中该 provider 的官方
/// origin、本地/私网，或该 provider 自己的可信 host 表（per-provider，provider→origin 强
/// 绑定），受陷渲染进程无法把密钥发到任意公网 host 或其它 Provider 的官方域名。
fn resolve_request_profile(
    provider_id: &str,
    endpoint_override: Option<&str>,
    model_id: Option<&str>,
) -> Result<ResolvedProfile, String> {
    resolve_profile(provider_id, endpoint_override, model_id)
}

// pub(crate)：usage_query 的错误透传与脱敏复用同一实现，避免两套错误格式漂移。
pub(crate) fn redact_secret(error: &str, secret: Option<&str>) -> String {
    secret
        .filter(|value| !value.is_empty())
        .map(|value| error.replace(value, "[REDACTED]"))
        .unwrap_or_else(|| error.to_string())
}

#[derive(Debug)]
enum CancellableHttpError {
    Cancelled,
    Timeout(&'static str),
    Request(reqwest::Error),
}

impl CancellableHttpError {
    fn message(&self) -> String {
        match self {
            Self::Cancelled => "model request cancelled".into(),
            Self::Timeout(phase) => format!("model response timed out while waiting for {phase}"),
            Self::Request(error) if error.is_body() => {
                format!("model response stream was interrupted: {error}")
            }
            Self::Request(error) => error.to_string(),
        }
    }

    fn is_retryable(&self) -> bool {
        match self {
            Self::Cancelled => false,
            Self::Timeout(_) => true,
            Self::Request(error) => {
                error.is_timeout() || error.is_connect() || error.is_body() || error.is_request()
            }
        }
    }
}

async fn send_with_cancel(
    builder: reqwest::RequestBuilder,
    cancel_receiver: &mut watch::Receiver<bool>,
    inactivity_timeout: Duration,
) -> Result<reqwest::Response, CancellableHttpError> {
    tokio::select! {
        response = timeout(inactivity_timeout, builder.send()) => response
            .map_err(|_| CancellableHttpError::Timeout("response headers"))?
            .map_err(CancellableHttpError::Request),
        _ = cancel_receiver.changed() => Err(CancellableHttpError::Cancelled),
    }
}

async fn next_chunk_with_cancel(
    response: &mut reqwest::Response,
    cancel_receiver: &mut watch::Receiver<bool>,
    inactivity_timeout: Duration,
) -> Result<Option<Vec<u8>>, CancellableHttpError> {
    tokio::select! {
        chunk = timeout(inactivity_timeout, response.chunk()) => chunk
            .map_err(|_| CancellableHttpError::Timeout("response body data"))?
            .map(|value| value.map(|bytes| bytes.to_vec()))
            .map_err(CancellableHttpError::Request),
        _ = cancel_receiver.changed() => Err(CancellableHttpError::Cancelled),
    }
}

async fn read_limited_response(
    mut response: reqwest::Response,
    cancel_receiver: &mut watch::Receiver<bool>,
    limit: usize,
    inactivity_timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    while let Some(chunk) =
        next_chunk_with_cancel(&mut response, cancel_receiver, inactivity_timeout)
            .await
            .map_err(|error| error.message())?
    {
        if output.len() + chunk.len() > limit {
            return Err("model response is too large".into());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn is_retryable_status(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

fn can_retry(retries: u32, response_body_started: bool, retryable: bool) -> bool {
    retries < MAX_RETRIES && !response_body_started && retryable
}

fn parse_retry_after(headers: &HeaderMap, now: SystemTime) -> Option<Duration> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    let delay = if let Ok(seconds) = value.parse::<u64>() {
        Duration::from_secs(seconds)
    } else {
        httpdate::parse_http_date(value)
            .ok()?
            .duration_since(now)
            .unwrap_or(Duration::ZERO)
    };
    Some(delay.min(Duration::from_millis(MAX_RETRY_DELAY_MS)))
}

fn retry_delay(retry_number: u32, retry_after: Option<Duration>, entropy: u64) -> Duration {
    let exponent = retry_number.saturating_sub(1).min(16);
    let base_ms = BASE_RETRY_DELAY_MS
        .saturating_mul(1u64 << exponent)
        .min(MAX_BACKOFF_DELAY_MS);
    let jitter_span = base_ms / 4;
    let jitter_width = jitter_span.saturating_mul(2).saturating_add(1);
    let jittered_ms = base_ms
        .saturating_sub(jitter_span)
        .saturating_add(entropy % jitter_width);
    let retry_after_ms = retry_after
        .map(|delay| delay.as_millis().min(MAX_RETRY_DELAY_MS as u128) as u64)
        .unwrap_or(0);
    Duration::from_millis(jittered_ms.max(retry_after_ms).min(MAX_RETRY_DELAY_MS))
}

fn retry_entropy(request_id: &str, retry_number: u32) -> u64 {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .subsec_nanos() as u64;
    request_id
        .bytes()
        .fold(time ^ u64::from(retry_number), |state, byte| {
            state.rotate_left(5) ^ u64::from(byte)
        })
}

async fn wait_before_retry(
    request_id: &str,
    retry_number: u32,
    retry_after: Option<Duration>,
    cancel_receiver: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    if *cancel_receiver.borrow() {
        return Err("model request cancelled".into());
    }
    let delay = retry_delay(
        retry_number,
        retry_after,
        retry_entropy(request_id, retry_number),
    );
    tokio::select! {
        _ = sleep(delay) => Ok(()),
        _ = cancel_receiver.changed() => Err("model request cancelled".into()),
    }
}

/// 从错误响应体中提取最接近人可读的 provider 消息，避免把原始 JSON 信封
/// （OpenAI/Anthropic 风格 `{"error":{"message":"..."}}`、FastAPI `{"detail":...}`）
/// 原样展示给用户。解析失败时回退到原始文本（由调用方决定）。
fn extract_error_message(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let message: &str = match value.get("error") {
        Some(serde_json::Value::String(text)) => text.as_str(),
        Some(error) => error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(""),
        None => value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .or_else(|| value.get("detail").and_then(serde_json::Value::as_str))
            .unwrap_or(""),
    }
    .trim();
    if message.is_empty() {
        None
    } else {
        Some(message.to_string())
    }
}

// pub(crate)：usage_query 的非 2xx 响应复用同一人可读错误提取。
pub(crate) fn error_detail(status: u16, bytes: &[u8]) -> String {
    let visible = &bytes[..bytes.len().min(MAX_ERROR_DETAIL_BYTES)];
    let detail = extract_error_message(visible)
        .unwrap_or_else(|| String::from_utf8_lossy(visible).trim().to_string());
    if detail.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {detail}")
    }
}

fn status_event(request_id: &str, status: u16) -> ModelStreamChunk {
    ModelStreamChunk {
        request_id: request_id.to_string(),
        status: Some(status),
        chunk: None,
        done: false,
        error: None,
    }
}

fn bytes_event(request_id: &str, chunk: Vec<u8>) -> ModelStreamChunk {
    ModelStreamChunk {
        request_id: request_id.to_string(),
        status: None,
        chunk: Some(chunk),
        done: false,
        error: None,
    }
}

fn done_event(request_id: &str) -> ModelStreamChunk {
    ModelStreamChunk {
        request_id: request_id.to_string(),
        status: None,
        chunk: None,
        done: true,
        error: None,
    }
}

fn error_event(request_id: &str, error: &str) -> ModelStreamChunk {
    ModelStreamChunk {
        request_id: request_id.to_string(),
        status: None,
        chunk: None,
        done: true,
        error: Some(error.to_string()),
    }
}

async fn stream_model_http_to_events<F>(
    request: ModelHttpRequest,
    request_state: &ModelRequestState,
    secret_state: &SecretState,
    mut emit: F,
) -> Result<(), String>
where
    F: FnMut(ModelStreamChunk) -> Result<(), String>,
{
    if request.body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("model request body is too large".into());
    }
    let profile = resolve_request_profile(
        &request.provider_id,
        request.endpoint.as_deref(),
        request.model_id.as_deref(),
    )?;
    let url = profile.url;
    let api_format = profile.api_format;
    let secret = resolve_secret(
        secret_state,
        &request.provider_id,
        request.secret_id.as_deref(),
    )?;
    let timeout = timeout_duration(request.timeout_ms);
    let client = build_client(timeout)?;
    let (request_id, mut cancel_receiver) = register_request(request_state, &request.request_id)?;

    let result = async {
        let mut retries = 0u32;
        loop {
            let builder = client
                .post(url.clone())
                .header(CONTENT_TYPE, "application/json")
                .header(ACCEPT, "text/event-stream")
                .body(request.body.clone());
            // 顺序：静态头 → 会话头 → 认证头。认证最后应用，静态数据无法覆盖它。
            let builder = apply_static_headers(builder, &request.provider_id);
            let builder = apply_session_header(
                builder,
                &request.provider_id,
                url.host_str(),
                request.session_id.as_deref(),
            );
            let builder = apply_authentication(builder, api_format, secret.as_deref())?;
            let mut response = match send_with_cancel(builder, &mut cancel_receiver, timeout).await
            {
                Ok(response) => response,
                Err(error) if can_retry(retries, false, error.is_retryable()) => {
                    retries += 1;
                    wait_before_retry(&request_id, retries, None, &mut cancel_receiver).await?;
                    continue;
                }
                Err(error) => return Err(error.message()),
            };
            if response.content_length().unwrap_or(0) > MAX_RESPONSE_BODY_BYTES as u64 {
                return Err("model response is too large".into());
            }
            let status = response.status().as_u16();
            if !response.status().is_success() {
                if can_retry(retries, false, is_retryable_status(status)) {
                    let retry_after = parse_retry_after(response.headers(), SystemTime::now());
                    drop(response);
                    retries += 1;
                    wait_before_retry(&request_id, retries, retry_after, &mut cancel_receiver)
                        .await?;
                    continue;
                }
                // 非 2xx 且重试耗尽：先透传真实 HTTP 状态，再发错误事件。此前只
                // return Err，TS 侧 observer 取不到 lastHttpStatus，错误分类降级。
                emit(status_event(&request_id, status))?;
                let bytes = read_limited_response(
                    response,
                    &mut cancel_receiver,
                    MAX_RESPONSE_BODY_BYTES,
                    timeout,
                )
                .await?;
                return Err(error_detail(status, &bytes));
            }

            // 已收到 200 响应 = 服务端已受理并开始生成。首 chunk 传输失败不得整单重 POST：
            // 重试会让 Anthropic 等场景重复生成工具调用。以 `response_body_started=true`
            // 关闭重试（不可重放边界在响应已开始之后）。
            let first_chunk =
                match next_chunk_with_cancel(&mut response, &mut cancel_receiver, timeout).await {
                    Ok(chunk) => chunk,
                    Err(error) if can_retry(retries, true, error.is_retryable()) => {
                        retries += 1;
                        wait_before_retry(&request_id, retries, None, &mut cancel_receiver).await?;
                        continue;
                    }
                    Err(error) => return Err(error.message()),
                };

            emit(status_event(&request_id, status))?;
            let mut received = 0usize;
            let mut redactor = SecretRedactor::new(secret.as_deref());
            let mut next_chunk = first_chunk;
            while let Some(chunk) = next_chunk {
                received += chunk.len();
                if received > MAX_RESPONSE_BODY_BYTES {
                    return Err("model response is too large".into());
                }
                let visible = redactor.push(&chunk);
                for event_chunk in visible.chunks(MAX_EVENT_CHUNK_BYTES) {
                    emit(bytes_event(&request_id, event_chunk.to_vec()))?;
                }
                next_chunk = next_chunk_with_cancel(&mut response, &mut cancel_receiver, timeout)
                    .await
                    .map_err(|error| error.message())?;
            }
            let visible = redactor.finish();
            for event_chunk in visible.chunks(MAX_EVENT_CHUNK_BYTES) {
                emit(bytes_event(&request_id, event_chunk.to_vec()))?;
            }
            emit(done_event(&request_id))?;
            break Ok(());
        }
    }
    .await;

    unregister_request(request_state, &request_id);
    if let Err(error) = result {
        let error = redact_secret(&error, secret.as_deref());
        let _ = emit(error_event(&request_id, &error));
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn stream_model_http(
    app: tauri::AppHandle,
    request: ModelHttpRequest,
    request_state: State<'_, ModelRequestState>,
    secret_state: State<'_, SecretState>,
) -> Result<(), String> {
    stream_model_http_to_events(request, &request_state, &secret_state, |event| {
        app.emit(MODEL_STREAM_EVENT, event)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) fn cancel_model_http(
    request_id: String,
    state: State<'_, ModelRequestState>,
) -> Result<bool, String> {
    let request_id = crate::request_id::validate_request_id("model", &request_id)?;
    let sender = state
        .0
        .lock()
        .map_err(|_| "model request state lock is poisoned".to_string())?
        .remove(request_id);
    if let Some(sender) = sender {
        let _ = sender.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) async fn probe_model_http(
    request: ModelProbeRequest,
    secret_state: State<'_, SecretState>,
) -> Result<ModelProbeResult, String> {
    probe_model_http_with_state(request, &secret_state).await
}

/// 探针实现（与命令解耦以便单测直接驱动）：请求头装配与 `stream_model_http_to_events` 一致
/// ——静态头 → 会话头 → 认证头；声明了会话头的 provider 在探针上也必须带上它。
async fn probe_model_http_with_state(
    request: ModelProbeRequest,
    secret_state: &SecretState,
) -> Result<ModelProbeResult, String> {
    if request.body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("model probe request body is too large".into());
    }
    let profile = resolve_request_profile(
        &request.provider_id,
        request.endpoint.as_deref(),
        request.model_id.as_deref(),
    )?;
    let url = profile.url;
    let api_format = profile.api_format;
    let secret = resolve_secret(
        secret_state,
        &request.provider_id,
        request.secret_id.as_deref(),
    )?;
    let inactivity_timeout = timeout_duration(request.timeout_ms);
    let client = build_client(inactivity_timeout)?;
    let host = url.host_str().map(str::to_string);
    let builder = client
        .post(url)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(request.body);
    // 与 stream 同一套头（静态头 → 会话头 → 认证头）。探针没有会话身份，会话头取回落值
    // ——但**不能省略**：声明了该头的 provider 会以「缺少会话头」直接 400，连通性测试会
    // 表现成「接了但连不通」，与真实请求不一致。
    let builder = apply_static_headers(builder, &request.provider_id);
    let builder = apply_session_header(builder, &request.provider_id, host.as_deref(), None);
    let builder = apply_authentication(builder, api_format, secret.as_deref())?;
    let response = timeout(inactivity_timeout, builder.send())
        .await
        .map_err(|_| "model response timed out while waiting for response headers".to_string())?
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    if response.status().is_success() {
        return Ok(ModelProbeResult {
            ok: true,
            status: Some(status),
            message: "连接成功".into(),
        });
    }
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BODY_BYTES as u64 {
        return Ok(ModelProbeResult {
            ok: false,
            status: Some(status),
            message: "model response is too large".into(),
        });
    }
    let (_cancel_sender, mut cancel_receiver) = watch::channel(false);
    let bytes = read_limited_response(
        response,
        &mut cancel_receiver,
        MAX_RESPONSE_BODY_BYTES,
        inactivity_timeout,
    )
    .await?;
    let message = redact_secret(&error_detail(status, &bytes), secret.as_deref());
    Ok(ModelProbeResult {
        ok: false,
        status: Some(status),
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
    };

    fn request(url: String, request_id: &str, body: String) -> ModelHttpRequest {
        ModelHttpRequest {
            request_id: request_id.into(),
            provider_id: "generic-openai-compatible".into(),
            endpoint: Some(url),
            body,
            secret_id: None,
            timeout_ms: Some(5_000),
            model_id: None,
            session_id: None,
        }
    }

    #[tokio::test]
    async fn rejects_attacker_endpoint_before_network_access() {
        // 受陷渲染进程传一个公网攻击者 endpoint：resolve_profile 必须拒绝，
        // 因为它既非官方 origin 也非本地/私网地址。
        let request = ModelHttpRequest {
            request_id: "attacker-async-test".into(),
            provider_id: "generic-openai-compatible".into(),
            endpoint: Some("https://attacker.example.com/collect".into()),
            body: "{}".into(),
            secret_id: None,
            timeout_ms: Some(5_000),
            model_id: None,
            session_id: None,
        };
        let result = stream_model_http_to_events(
            request,
            &ModelRequestState::default(),
            &SecretState::default(),
            |_| Ok(()),
        )
        .await;
        let error = result.unwrap_err();
        assert!(
            error.contains("已拒绝"),
            "expected rejection of attacker endpoint, got: {error}"
        );
    }

    #[tokio::test]
    async fn rejects_cross_provider_secret_before_secret_store_access() {
        // 受陷渲染进程用 provider A 身份 + provider B 的 secretId 组合请求：
        // resolve_secret 必须在读取密钥库前拒绝（绑定校验先于 load）。
        let request = ModelHttpRequest {
            request_id: "cross-provider-secret".into(),
            provider_id: "openai".into(),
            endpoint: None,
            body: "{}".into(),
            secret_id: Some("provider.openai-compatible.api-key".into()),
            timeout_ms: Some(5_000),
            model_id: None,
            session_id: None,
        };
        let result = stream_model_http_to_events(
            request,
            &ModelRequestState::default(),
            &SecretState::default(),
            |_| Ok(()),
        )
        .await;
        let error = result.unwrap_err();
        assert!(
            error.contains("not bound to provider"),
            "expected cross-provider secret rejection, got: {error}"
        );
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let bytes_read = stream.read(&mut buffer).unwrap();
            assert!(
                bytes_read > 0,
                "HTTP request ended before its body was complete"
            );
            request.extend_from_slice(&buffer[..bytes_read]);

            let Some(header_end) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
            else {
                continue;
            };
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if request.len() >= header_end + content_length {
                return String::from_utf8_lossy(&request).into_owned();
            }
        }
    }

    fn spawn_streaming_server(
        response_chunks: Vec<&'static [u8]>,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_http_request(&mut stream);
            let content_length = response_chunks
                .iter()
                .map(|chunk| chunk.len())
                .sum::<usize>();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .unwrap();
            for chunk in response_chunks {
                stream.write_all(chunk).unwrap();
                stream.flush().unwrap();
            }
        });
        (format!("http://{address}/v1/chat/completions"), handle)
    }

    fn spawn_response_sequence(responses: Vec<Vec<u8>>) -> (String, thread::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let mut accepted = 0usize;
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                accepted += 1;
                read_http_request(&mut stream);
                if !response.is_empty() {
                    stream.write_all(&response).unwrap();
                    stream.flush().unwrap();
                }
            }
            accepted
        });
        (format!("http://{address}/v1/chat/completions"), handle)
    }

    #[test]
    fn validates_request_ids() {
        assert_eq!(crate::request_id::validate_request_id("model", "request-1"), Ok("request-1"));
        assert!(crate::request_id::validate_request_id("model", "").is_err());
        assert!(crate::request_id::validate_request_id("model", "request/1").is_err());
    }

    #[test]
    fn deserializes_provider_profile_request_payload() {
        // 新 payload：providerId + 可选 endpoint 覆盖，不再含 url/apiFormat。
        let request: ModelHttpRequest = serde_json::from_value(serde_json::json!({
            "requestId": "responses-test",
            "providerId": "openai",
            "endpoint": "https://api.openai.com/v1/responses",
            "body": "{}"
        }))
        .unwrap();

        assert_eq!(request.provider_id, "openai");
        assert_eq!(
            request.endpoint.as_deref(),
            Some("https://api.openai.com/v1/responses")
        );
    }

    #[test]
    fn applies_bearer_authentication_to_openai_responses() {
        let request = apply_authentication(
            reqwest::Client::new().post("http://localhost/v1/responses"),
            ModelApiFormat::OpenaiResponses,
            Some("responses-secret"),
        )
        .unwrap()
        .build()
        .unwrap();

        assert_eq!(
            request.headers().get(AUTHORIZATION).unwrap(),
            "Bearer responses-secret"
        );
        assert!(request.headers().get("x-api-key").is_none());
        assert!(request.headers().get("anthropic-version").is_none());
    }

    #[test]
    fn applies_messages_authentication_for_anthropic_wire_models() {
        // OpenCode Go 的 messages 形状模型：认证走 x-api-key + anthropic-version，
        // 不能是 Bearer（同一个 Key，不同协议头的区别由 resolve_profile 的 apiFormat 决定）。
        let resolved = crate::provider_profiles::resolve_profile(
            "opencode-go",
            None,
            Some("minimax-m3"),
        )
        .unwrap();
        let request = apply_authentication(
            reqwest::Client::new().post("http://localhost/v1/messages"),
            resolved.api_format,
            Some("go-secret"),
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(request.headers().get("x-api-key").unwrap(), "go-secret");
        assert_eq!(
            request.headers().get("anthropic-version").unwrap(),
            "2023-06-01"
        );
        assert!(request.headers().get(AUTHORIZATION).is_none());
    }

    #[test]
    fn applies_provider_static_headers_with_version_placeholder() {
        let request = apply_static_headers(
            reqwest::Client::new().post("http://localhost/v1/chat/completions"),
            "opencode-go",
        )
        .build()
        .unwrap();
        assert_eq!(
            request.headers().get("user-agent").unwrap(),
            format!("Axiom/{}", env!("CARGO_PKG_VERSION")).as_str()
        );
        // 未声明静态头的 provider 不注入任何头。
        let plain = apply_static_headers(
            reqwest::Client::new().post("http://localhost/v1/chat/completions"),
            "generic-openai-compatible",
        )
        .build()
        .unwrap();
        assert!(plain.headers().get("user-agent").is_none());
    }

    /// 捕获服务端：回一条 200，并把收到的原始报文交回给测试断言「线上真实请求头」。
    fn spawn_capturing_server(response: Vec<u8>) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let captured = read_http_request(&mut stream);
            stream.write_all(&response).unwrap();
            stream.flush().unwrap();
            captured
        });
        (format!("http://{address}/v1/chat/completions"), handle)
    }

    fn ok_json_response() -> Vec<u8> {
        let body = b"{}";
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
    }

    #[tokio::test]
    async fn stream_sends_declared_headers_with_fallback_session_id() {
        // 回归（真实报文层）：OpenCode Go 要求 x-opencode-session 恒存在，缺失时直接 400
        // 「Request is missing x-opencode-session and cannot be routed efficiently」。
        // 这里故意**不传** session_id（如宿主自发请求），断言仍带上了回落值，且客户端自报身份。
        let (endpoint, captured) = spawn_capturing_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 14\r\nConnection: close\r\n\r\ndata: [DONE]\n\n".to_vec(),
        );
        let request = ModelHttpRequest {
            request_id: "opencode-go-stream-headers".into(),
            provider_id: "opencode-go".into(),
            endpoint: Some(endpoint),
            body: "{}".into(),
            secret_id: None,
            timeout_ms: Some(5_000),
            model_id: Some("glm-5.3".into()),
            session_id: None,
        };
        let result = stream_model_http_to_events(
            request,
            &ModelRequestState::default(),
            &SecretState::default(),
            |_| Ok(()),
        )
        .await;
        assert!(result.is_ok(), "unexpected error: {:?}", result.err());

        let wire = captured.join().unwrap().to_lowercase();
        assert!(
            wire.contains("x-opencode-session: axiom-desktop-"),
            "session header missing on the wire:\n{wire}"
        );
        assert!(
            wire.contains(&format!("user-agent: axiom/{}", env!("CARGO_PKG_VERSION").to_lowercase())),
            "user-agent missing on the wire:\n{wire}"
        );
    }

    #[tokio::test]
    async fn probe_sends_the_same_declared_headers_as_stream() {
        // 用户报的 400 就出在连通性测试（探针）上：探针与真实请求必须带同一套头。
        let (endpoint, captured) = spawn_capturing_server(ok_json_response());
        let result = probe_model_http_with_state(
            ModelProbeRequest {
                provider_id: "opencode-go".into(),
                endpoint: Some(endpoint),
                body: "{}".into(),
                secret_id: None,
                timeout_ms: Some(5_000),
                model_id: Some("glm-5.3".into()),
            },
            &SecretState::default(),
        )
        .await
        .unwrap();
        assert!(result.ok, "unexpected probe result: {result:?}");

        let wire = captured.join().unwrap().to_lowercase();
        assert!(
            wire.contains("x-opencode-session: axiom-desktop-"),
            "session header missing on the probe wire:\n{wire}"
        );
        assert!(
            wire.contains(&format!("user-agent: axiom/{}", env!("CARGO_PKG_VERSION").to_lowercase())),
            "user-agent missing on the probe wire:\n{wire}"
        );
    }

    #[test]
    fn applies_session_header_always_when_the_provider_declares_one() {
        let request = |session_id: Option<&str>| {
            apply_session_header(
                reqwest::Client::new().post("http://localhost/v1/chat/completions"),
                "opencode-go",
                Some("opencode.ai"),
                session_id,
            )
            .build()
            .unwrap()
        };
        // 真实会话身份原样透传（上游按它做会话归因）。
        assert_eq!(
            request(Some("session-abc")).headers().get("x-opencode-session").unwrap(),
            "session-abc"
        );
        // 回归：缺失/空白的会话身份**不能省略该头**——上游按它路由，缺失即 400
        // （「Request is missing x-opencode-session and cannot be routed efficiently」）。
        // 回落值只需稳定非空，且同一进程内保持一致。
        let fallback = request(None);
        let value = fallback.headers().get("x-opencode-session").unwrap().to_str().unwrap();
        assert!(value.starts_with("axiom-desktop-"), "unexpected fallback: {value}");
        assert_eq!(value, request(Some("   ")).headers().get("x-opencode-session").unwrap());
        assert_eq!(value, request(None).headers().get("x-opencode-session").unwrap());
        // provider 未声明、且 host 不属于任何声明了会话头的服务：不注入。
        let undeclared = apply_session_header(
            reqwest::Client::new().post("http://localhost/v1/responses"),
            "openai",
            Some("api.openai.com"),
            Some("session-abc"),
        )
        .build()
        .unwrap();
        assert!(undeclared.headers().get("x-opencode-session").is_none());
    }

    #[test]
    fn applies_session_header_by_host_for_custom_providers_on_the_same_service() {
        // 上游的要求属于服务：把 OpenCode Go 配成自定义 provider（endpoint 指向
        // opencode.ai）时同样必须带这个头，否则 400 MissingSessionID。host 命中即可，
        // 与 provider 条目无关；子域同样命中（zen.opencode.ai），其它 host 不命中。
        let header_of = |provider_id: &str, host: &str| {
            apply_session_header(
                reqwest::Client::new().post("https://opencode.ai/zen/go/v1/chat/completions"),
                provider_id,
                Some(host),
                Some("session-abc"),
            )
            .build()
            .unwrap()
            .headers()
            .get("x-opencode-session")
            .map(|value| value.to_str().unwrap().to_string())
        };
        assert_eq!(
            header_of("custom-openai-compatible", "opencode.ai").as_deref(),
            Some("session-abc")
        );
        assert_eq!(
            header_of("custom-openai-compatible", "zen.opencode.ai").as_deref(),
            Some("session-abc")
        );
        // 形近域名不命中（避免把会话头发给无关服务）。
        assert_eq!(header_of("custom-openai-compatible", "notopencode.ai"), None);
        assert_eq!(header_of("generic-openai-compatible", "api.openai.com"), None);
    }

    #[test]
    fn stream_events_never_contain_request_headers_or_secrets() {
        let status = status_event("request-1", 200);
        let bytes = bytes_event("request-1", b"data: ok".to_vec());
        let done = done_event("request-1");
        assert_eq!(status.status, Some(200));
        assert_eq!(bytes.chunk.as_deref(), Some(b"data: ok".as_slice()));
        assert!(done.done);
        assert!(done.error.is_none());
    }

    #[test]
    fn limits_error_details() {
        let oversized = vec![b'x'; MAX_ERROR_DETAIL_BYTES + 100];
        let detail = error_detail(500, &oversized);
        assert_eq!(detail.len(), "HTTP 500: ".len() + MAX_ERROR_DETAIL_BYTES);
    }

    #[test]
    fn extracts_human_message_from_openai_style_error_envelope() {
        let body =
            br#"{"error":{"message":"Service is too busy. Please retry later.","type":"service_unavailable_error","param":null,"code":"service_unavailable_error"}}"#;
        assert_eq!(
            error_detail(503, body),
            "HTTP 503: Service is too busy. Please retry later."
        );
    }

    #[test]
    fn extracts_human_message_from_anthropic_and_flat_envelopes() {
        assert_eq!(
            extract_error_message(
                br#"{"error":{"type":"overloaded_error","message":"overloaded"}}"#
            ),
            Some("overloaded".to_string())
        );
        assert_eq!(
            extract_error_message(br#"{"message":"boom"}"#),
            Some("boom".to_string())
        );
        assert_eq!(
            extract_error_message(br#"{"detail":"boom"}"#),
            Some("boom".to_string())
        );
        assert_eq!(
            extract_error_message(br#"{"error":"boom"}"#),
            Some("boom".to_string())
        );
    }

    #[test]
    fn error_detail_falls_back_to_raw_body_when_envelope_is_unparseable() {
        assert_eq!(extract_error_message(b"not json at all"), None);
        assert_eq!(extract_error_message(br#"{"error":{}}"#), None);
        assert_eq!(extract_error_message(b""), None);
        // 无法解析为信封时，error_detail 仍保留原始 body。
        let detail = error_detail(500, b"overloaded: try again");
        assert_eq!(detail, "HTTP 500: overloaded: try again");
    }

    #[test]
    fn redacts_secrets_from_remote_error_details() {
        assert_eq!(
            redact_secret("HTTP 400: received secret-token", Some("secret-token")),
            "HTTP 400: received [REDACTED]"
        );
        assert_eq!(redact_secret("HTTP 400", None), "HTTP 400");
    }

    #[test]
    fn redacts_secrets_even_when_split_across_response_chunks() {
        let mut redactor = SecretRedactor::new(Some("secret-token"));
        let mut output = redactor.push(b"before sec");
        output.extend(redactor.push(b"ret-token after secret-").iter());
        output.extend(redactor.push(b"token end").iter());
        output.extend(redactor.finish().iter());
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "before [REDACTED] after [REDACTED] end"
        );
    }

    #[tokio::test]
    async fn streams_local_http_bytes_into_scoped_events() {
        let (url, server) = spawn_streaming_server(vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
            b"data: [DONE]\n\n",
        ]);
        let request_state = ModelRequestState::default();
        let secret_state = SecretState::default();
        let mut events = Vec::new();

        stream_model_http_to_events(
            request(url, "stream-test", "{}".into()),
            &request_state,
            &secret_state,
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
        server.join().unwrap();

        assert_eq!(events.first().and_then(|event| event.status), Some(200));
        let body = events
            .iter()
            .filter_map(|event| event.chunk.as_ref())
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert!(String::from_utf8(body).unwrap().contains("hello"));
        assert!(events
            .last()
            .is_some_and(|event| event.done && event.error.is_none()));
    }

    #[tokio::test]
    async fn cancels_an_in_flight_http_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_sender, accepted_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_http_request(&mut stream);
            let _ = accepted_sender.send(());
            let _ = release_receiver.recv();
        });
        let request_state = ModelRequestState::default();
        let secret_state = SecretState::default();
        let mut events = Vec::new();
        let run = stream_model_http_to_events(
            request(
                format!("http://{address}/v1/chat/completions"),
                "cancel-test",
                "{}".into(),
            ),
            &request_state,
            &secret_state,
            |event| {
                events.push(event);
                Ok(())
            },
        );
        let cancel = async {
            accepted_receiver.await.unwrap();
            let sender = request_state
                .0
                .lock()
                .unwrap()
                .remove("cancel-test")
                .unwrap();
            sender.send(true).unwrap();
            release_sender.send(()).unwrap();
        };

        let (result, ()) = tokio::join!(run, cancel);
        server.join().unwrap();

        assert_eq!(result, Err("model request cancelled".into()));
        assert!(events.last().is_some_and(|event| {
            event.done && event.error.as_deref() == Some("model request cancelled")
        }));
    }

    #[tokio::test]
    async fn rejects_oversized_request_bodies_before_network_access() {
        let result = stream_model_http_to_events(
            request(
                "http://127.0.0.1:9/v1/chat/completions".into(),
                "oversized-test",
                "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
            ),
            &ModelRequestState::default(),
            &SecretState::default(),
            |_| Ok(()),
        )
        .await;
        assert_eq!(result, Err("model request body is too large".into()));
    }

    #[test]
    fn clamps_provider_timeouts_to_safe_bounds() {
        assert_eq!(timeout_duration(Some(1)), Duration::from_millis(1_000));
        assert_eq!(
            timeout_duration(Some(999_999)),
            Duration::from_millis(300_000)
        );
    }

    #[test]
    fn parses_and_bounds_retry_after_values() {
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("120"));
        assert_eq!(
            parse_retry_after(&headers, now),
            Some(Duration::from_millis(MAX_RETRY_DELAY_MS))
        );

        let retry_at = now + Duration::from_secs(12);
        headers.insert(
            RETRY_AFTER,
            HeaderValue::from_str(&httpdate::fmt_http_date(retry_at)).unwrap(),
        );
        assert_eq!(
            parse_retry_after(&headers, now),
            Some(Duration::from_secs(12))
        );
    }

    #[test]
    fn bounds_exponential_backoff_and_forbids_replay_after_body_bytes() {
        assert_eq!(retry_delay(1, None, 0), Duration::from_millis(375));
        assert!(
            retry_delay(20, None, 0)
                <= Duration::from_millis(MAX_BACKOFF_DELAY_MS + MAX_BACKOFF_DELAY_MS / 2)
        );
        assert!(retry_delay(20, None, u64::MAX) <= Duration::from_millis(MAX_RETRY_DELAY_MS));
        assert!(retry_delay(1, Some(Duration::from_secs(2)), 0) >= Duration::from_secs(2));
        assert!(can_retry(0, false, true));
        assert!(!can_retry(MAX_RETRIES, false, true));
        assert!(!can_retry(0, true, true));
        assert!(!can_retry(0, false, false));
    }

    #[tokio::test]
    async fn retries_recoverable_status_before_streaming_body() {
        let body =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"retried\"}}]}\n\ndata: [DONE]\n\n";
        let success = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        )
        .into_bytes();
        let (url, server) = spawn_response_sequence(vec![
            b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            success,
        ]);
        let mut events = Vec::new();

        stream_model_http_to_events(
            request(url, "status-retry-test", "{}".into()),
            &ModelRequestState::default(),
            &SecretState::default(),
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(server.join().unwrap(), 2);
        assert_eq!(
            events
                .iter()
                .filter_map(|event| event.status)
                .collect::<Vec<_>>(),
            vec![200]
        );
        let streamed = events
            .iter()
            .filter_map(|event| event.chunk.as_ref())
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert!(String::from_utf8(streamed).unwrap().contains("retried"));
    }

    #[tokio::test]
    async fn retries_network_failure_before_response_body() {
        let body = b"data: [DONE]\n\n";
        let success = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        )
        .into_bytes();
        let (url, server) = spawn_response_sequence(vec![Vec::new(), success]);
        let mut events = Vec::new();

        stream_model_http_to_events(
            request(url, "network-retry-test", "{}".into()),
            &ModelRequestState::default(),
            &SecretState::default(),
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(server.join().unwrap(), 2);
        assert_eq!(
            events
                .iter()
                .filter_map(|event| event.status)
                .collect::<Vec<_>>(),
            vec![200]
        );
        assert!(events
            .last()
            .is_some_and(|event| event.done && event.error.is_none()));
    }

    #[tokio::test]
    async fn keeps_streaming_past_the_timeout_while_body_data_remains_active() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_http_request(&mut stream);
            let chunks: [&[u8]; 3] = [
                b"data: {\"choices\":[{\"delta\":{\"content\":\"one\"}}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{\"content\":\"two\"}}]}\n\n",
                b"data: [DONE]\n\n",
            ];
            let content_length = chunks.iter().map(|chunk| chunk.len()).sum::<usize>();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .unwrap();
            for (index, chunk) in chunks.iter().enumerate() {
                stream.write_all(chunk).unwrap();
                stream.flush().unwrap();
                if index + 1 < chunks.len() {
                    thread::sleep(Duration::from_millis(600));
                }
            }
        });
        let mut events = Vec::new();

        stream_model_http_to_events(
            ModelHttpRequest {
                timeout_ms: Some(1_000),
                ..request(
                    format!("http://{address}/v1/chat/completions"),
                    "active-long-stream-test",
                    "{}".into(),
                )
            },
            &ModelRequestState::default(),
            &SecretState::default(),
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
        server.join().unwrap();

        let body = events
            .iter()
            .filter_map(|event| event.chunk.as_ref())
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert!(String::from_utf8(body).unwrap().contains("two"));
        assert!(events
            .last()
            .is_some_and(|event| event.done && event.error.is_none()));
    }

    #[tokio::test]
    async fn does_not_retry_nonrecoverable_http_status() {
        let response =
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad"
                .to_vec();
        let (url, server) = spawn_response_sequence(vec![response]);
        let mut events = Vec::new();
        let result = stream_model_http_to_events(
            request(url, "no-status-retry-test", "{}".into()),
            &ModelRequestState::default(),
            &SecretState::default(),
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await;

        assert_eq!(result, Err("HTTP 400: bad".into()));
        assert_eq!(server.join().unwrap(), 1);
        // 非 2xx 终态必须透传真实 HTTP 状态事件，供 TS observer 记录 lastHttpStatus。
        assert!(
            events.iter().any(|event| event.status == Some(400)),
            "expected a status event for HTTP 400, got {events:?}"
        );
    }

    #[tokio::test]
    async fn does_not_retry_when_first_body_chunk_fails_after_200() {
        // 服务端已回 200（受理并开始生成），但首个 body chunk 传输失败。
        // 不得整单重 POST（会重复生成工具调用）——只接受一次连接并失败返回。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_http_request(&mut stream);
            // 声明 10 字节 body 但立即关闭：next_chunk 读到连接中断错误。
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 10\r\nConnection: close\r\n\r\n",
            );
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Both);
        });

        let result = stream_model_http_to_events(
            request(
                format!("http://{address}/v1/chat/completions"),
                "first-chunk-fail-test",
                "{}".into(),
            ),
            &ModelRequestState::default(),
            &SecretState::default(),
            |_| Ok(()),
        )
        .await;

        server.join().unwrap();
        // 200 后失败不再重试：直接以错误结束，且不重新发起请求。
        assert!(
            result.is_err(),
            "expected an error for a broken body after 200, got {result:?}"
        );
    }

    #[tokio::test]
    async fn retry_wait_is_abortable() {
        let (sender, mut receiver) = watch::channel(false);
        let cancel = tokio::spawn(async move {
            sleep(Duration::from_millis(20)).await;
            sender.send(true).unwrap();
        });
        let started = std::time::Instant::now();
        let result = wait_before_retry(
            "abort-retry-test",
            1,
            Some(Duration::from_secs(30)),
            &mut receiver,
        )
        .await;
        cancel.await.unwrap();

        assert_eq!(result, Err("model request cancelled".into()));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
