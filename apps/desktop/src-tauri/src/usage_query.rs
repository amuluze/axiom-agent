//! Provider 用量查询：对已配置的内置 Provider 调用官方账户接口，查询余额/额度。
//!
//! 安全模型：用量端点全部由本模块的内置表权威决定，渲染进程只传 providerId 与
//! secretId——受陷渲染进程无法借本命令把密钥库密钥发到任意端点。这比
//! model_http 的 `resolve_profile`（接受同 origin 的 endpoint 覆盖）更严格：
//! 连 endpoint 覆盖都不接受，因为用量接口与用户可自定义的 chat endpoint 无
//! 路径派生关系。密钥经 `model_http::resolve_secret` 做 per-provider 绑定
//! 校验（跨 Provider 组合在读取密钥库前即被拒绝），认证头仅在请求期构造，
//! 不回传渲染进程。

use crate::{
    model_http::{error_detail, redact_secret, resolve_secret},
    network_policy::redirect_policy,
    secrets::SecretState,
};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

// 余额/额度响应都是小 JSON，上限远低于模型响应通道。
const USAGE_RESPONSE_LIMIT_BYTES: usize = 256 * 1024;
const USAGE_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageQueryRequest {
    provider_id: String,
    secret_id: Option<String>,
    // 用户在「设置 → 模型」配置的 chat endpoint。仅用于智谱国内/国际站分流，
    // 且必须在官方站点白名单内（见 UsageUrl::ZhipuQuotaSites）；其余 Provider
    // 忽略该字段——用量 URL 始终来自内置表，渲染进程无法借它指定任意端点。
    endpoint_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageMetric {
    label: String,
    // None 字段不进 JSON（skip_serializing_if）：serde 默认会把 None 序列化
    // 为 `null`，而 TS 契约是 `field?: number`（缺失/undefined）——前端按
    // `!== undefined` 判空时 null 会漏过并触发 `null.toFixed` 崩溃。
    #[serde(skip_serializing_if = "Option::is_none")]
    used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remaining: Option<f64>,
    unit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resets_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageQueryResult {
    provider_id: String,
    kind: String,
    metrics: Vec<UsageMetric>,
    checked_at_ms: u64,
}

#[derive(Clone, Copy)]
enum UsageAuthStyle {
    Bearer,
    // 智谱的 monitor 接口要求裸 API key（无 Bearer 前缀）。
    RawKey,
}

struct UsageEndpointSpec {
    url: UsageUrl,
    auth: UsageAuthStyle,
    // balance（账户余额，货币计）或 quota（额度窗口，百分比计）。
    kind: &'static str,
    parse: fn(&serde_json::Value) -> Result<Vec<UsageMetric>, String>,
}

/// 用量 URL 来源：全部由 Rust 内置白名单权威决定。固定端点的 Provider 用
/// `Fixed`；智谱国内/国际站共用同一路径与响应结构，按用户配置的 chat
/// endpoint host 在官方站点白名单内分流，其余 host 一律 fail-closed 拒绝
/// ——密钥只会发往官方域名，受陷渲染进程无法借 endpointHint 探针。
enum UsageUrl {
    Fixed(&'static str),
    ZhipuQuotaSites,
}

impl UsageUrl {
    fn resolve(&self, endpoint_hint: Option<&str>) -> Result<String, String> {
        match self {
            Self::Fixed(url) => Ok((*url).to_string()),
            Self::ZhipuQuotaSites => zhipu_quota_url(endpoint_hint),
        }
    }
}

fn zhipu_quota_url(endpoint_hint: Option<&str>) -> Result<String, String> {
    const QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";
    let default_url = || format!("https://open.bigmodel.cn{QUOTA_PATH}");
    let Some(hint) = endpoint_hint.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(default_url());
    };
    let parsed = reqwest::Url::parse(hint)
        .map_err(|_| "智谱 Endpoint 不是有效 URL，无法确定用量查询站点".to_string())?;
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    if host.contains("bigmodel.cn") {
        Ok(default_url())
    } else if host == "z.ai" || host.ends_with(".z.ai") {
        Ok(format!("https://api.z.ai{QUOTA_PATH}"))
    } else {
        Err(format!(
            "智谱用量查询仅支持官方站点（open.bigmodel.cn / api.z.ai），已拒绝：{host}"
        ))
    }
}

fn usage_endpoint(provider_id: &str) -> Option<UsageEndpointSpec> {
    match provider_id {
        "deepseek" => Some(UsageEndpointSpec {
            url: UsageUrl::Fixed("https://api.deepseek.com/user/balance"),
            auth: UsageAuthStyle::Bearer,
            kind: "balance",
            parse: parse_deepseek_balance,
        }),
        "zhipu-glm" => Some(UsageEndpointSpec {
            url: UsageUrl::ZhipuQuotaSites,
            auth: UsageAuthStyle::RawKey,
            kind: "quota",
            parse: parse_zhipu_quota,
        }),
        "kimi" => Some(UsageEndpointSpec {
            url: UsageUrl::Fixed("https://api.moonshot.cn/v1/users/me/balance"),
            auth: UsageAuthStyle::Bearer,
            kind: "balance",
            parse: parse_moonshot_balance,
        }),
        "kimi-coding" => Some(UsageEndpointSpec {
            url: UsageUrl::Fixed("https://api.kimi.com/coding/v1/usages"),
            auth: UsageAuthStyle::Bearer,
            kind: "quota",
            parse: parse_kimi_coding_usage,
        }),
        "minimax-chat" => Some(UsageEndpointSpec {
            url: UsageUrl::Fixed("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"),
            auth: UsageAuthStyle::Bearer,
            kind: "quota",
            parse: parse_minimax_token_plan,
        }),
        _ => None,
    }
}

/// 余额/额度接口普遍把数值序列化为字符串或数字，两种都接受。
fn number_field(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())
}

/// 从 JSON 值提取重置时间：字符串（ISO 8601 等）原样透传；数字统一归一为
/// 毫秒时间戳字符串（秒级时间戳 < 1e12 时放大），前端 `new Date(...)`
/// 对两种形态都能直接解析；0/负值视为无重置时间。
fn extract_reset_time(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let raw = value.as_i64()?;
    if raw <= 0 {
        return None;
    }
    let millis = if raw < 1_000_000_000_000 { raw * 1_000 } else { raw };
    Some(millis.to_string())
}

fn parse_deepseek_balance(value: &serde_json::Value) -> Result<Vec<UsageMetric>, String> {
    let infos = value
        .get("balance_infos")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "DeepSeek 响应缺少 balance_infos".to_string())?;
    let is_available = value
        .get("is_available")
        .and_then(|item| item.as_bool())
        .unwrap_or(true);
    let mut metrics = Vec::new();
    for info in infos {
        let currency = info
            .get("currency")
            .and_then(|item| item.as_str())
            .unwrap_or("CNY");
        metrics.push(UsageMetric {
            label: "账户余额".into(),
            used: None,
            total: None,
            remaining: info.get("total_balance").and_then(number_field),
            unit: currency.to_string(),
            resets_at: None,
            detail: if is_available {
                None
            } else {
                Some("余额不可用（可能已欠费）".into())
            },
        });
    }
    if metrics.is_empty() {
        return Err("DeepSeek 响应未包含余额条目".into());
    }
    Ok(metrics)
}

/// 把智谱 `data.limits[]` 解析成 5 小时/周两个窗口槽位（对齐 cc-switch 的
/// `parse_zhipu_token_tiers` 实测语义）。
///
/// 分类优先级：
/// 1. 显式 `unit` 字段（3 → 5 小时滚动窗，6 → 周窗）。不能按重置时间排序
///    代替——周期末尾周窗会比 5 小时窗更早重置，时间排序必然把两桶标反。
/// 2. 兜底启发式（unit 缺失或不认识）：无 nextResetTime 的条目优先归
///    5 小时窗（该桶在 0% 等状态可能没有 reset），其余按重置时间升序
///    依次填入仍空缺的槽位。
///
/// 老套餐（2026-02-12 前订阅）只回 1 条 TOKENS_LIMIT，自然降级为仅展示
/// 5 小时窗；多余条目忽略（智谱当前最多两条）。
fn parse_zhipu_quota(value: &serde_json::Value) -> Result<Vec<UsageMetric>, String> {
    enum ZhipuWindow {
        FiveHour,
        Weekly,
    }
    struct ZhipuEntry {
        credit_limit: bool,
        percentage: Option<f64>,
        reset_ms: Option<i64>,
    }

    let data = value
        .get("data")
        .ok_or_else(|| "智谱响应缺少 data".to_string())?;
    let limits = data
        .get("limits")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "智谱响应缺少 limits".to_string())?;
    let level = data.get("level").and_then(|item| item.as_str());

    let classify = |limit: &serde_json::Value| {
        match limit.get("unit").and_then(|item| item.as_i64()) {
            Some(3) => Some(ZhipuWindow::FiveHour),
            Some(6) => Some(ZhipuWindow::Weekly),
            _ => None,
        }
    };
    let mut five_hour: Option<ZhipuEntry> = None;
    let mut weekly: Option<ZhipuEntry> = None;
    let mut unclassified: Vec<ZhipuEntry> = Vec::new();
    for limit in limits {
        let limit_type = limit
            .get("type")
            .and_then(|item| item.as_str())
            .unwrap_or_default();
        // 大小写不敏感比较：上游若把 "TOKENS_LIMIT" 改成小写或驼峰，依然能识别。
        let credit_limit = limit_type.eq_ignore_ascii_case("CREDIT_LIMIT");
        if !credit_limit && !limit_type.eq_ignore_ascii_case("TOKENS_LIMIT") {
            continue;
        }
        let entry = ZhipuEntry {
            credit_limit,
            percentage: limit.get("percentage").and_then(number_field),
            reset_ms: limit.get("nextResetTime").and_then(|item| item.as_i64()),
        };
        match classify(limit) {
            Some(ZhipuWindow::FiveHour) if five_hour.is_none() => five_hour = Some(entry),
            Some(ZhipuWindow::Weekly) if weekly.is_none() => weekly = Some(entry),
            _ => unclassified.push(entry),
        }
    }
    unclassified.sort_by_key(|entry| (entry.reset_ms.is_some(), entry.reset_ms.unwrap_or(i64::MIN)));
    for entry in unclassified {
        if five_hour.is_none() {
            five_hour = Some(entry);
        } else if weekly.is_none() {
            weekly = Some(entry);
        }
    }

    let to_metric = |window: &str, entry: Option<ZhipuEntry>| -> Option<UsageMetric> {
        let entry = entry?;
        let kind_prefix = if entry.credit_limit { "额度" } else { "Token" };
        Some(UsageMetric {
            label: format!("{kind_prefix}{window}"),
            used: entry.percentage,
            total: entry.percentage.map(|_| 100.0),
            remaining: None,
            unit: "%".into(),
            resets_at: entry
                .reset_ms
                .and_then(|ms| extract_reset_time(&serde_json::Value::from(ms))),
            detail: level.map(|value| format!("套餐：{value}")),
        })
    };
    let mut metrics = Vec::new();
    if let Some(metric) = to_metric("5 小时窗口", five_hour) {
        metrics.push(metric);
    }
    if let Some(metric) = to_metric("周窗口", weekly) {
        metrics.push(metric);
    }
    if metrics.is_empty() {
        return Err("智谱响应未包含可用额度条目".into());
    }
    Ok(metrics)
}

fn parse_moonshot_balance(value: &serde_json::Value) -> Result<Vec<UsageMetric>, String> {
    let data = value
        .get("data")
        .ok_or_else(|| "Kimi 响应缺少 data".to_string())?;
    let available = data
        .get("available_balance")
        .and_then(number_field)
        .ok_or_else(|| "Kimi 响应缺少 available_balance".to_string())?;
    let voucher = data.get("voucher_balance").and_then(number_field);
    let cash = data.get("cash_balance").and_then(number_field);
    let detail = match (voucher, cash) {
        (Some(voucher), Some(cash)) => Some(format!("代金券 {voucher:.2} · 现金 {cash:.2}")),
        _ => None,
    };
    Ok(vec![UsageMetric {
        label: "可用余额".into(),
        used: None,
        total: None,
        remaining: Some(available),
        unit: "CNY".into(),
        resets_at: None,
        detail,
    }])
}

fn parse_kimi_coding_usage(value: &serde_json::Value) -> Result<Vec<UsageMetric>, String> {
    // 返回 (已用百分比, 剩余百分比, "余量/总量" 明细)。剩余百分比 =
    // 100 - 已用（对齐 cc-switch token_plan 展示层），与 MiniMax 的
    // "剩余 N %" 形态一致；额度余量绝对值经 detail 展示补充语义。
    let utilization = |limit: Option<f64>, remaining: Option<f64>| {
        match (limit, remaining) {
            (Some(limit), Some(remaining)) if limit > 0.0 => {
                let used = (limit - remaining).max(0.0);
                let used_percent = used / limit * 100.0;
                (
                    Some(used_percent),
                    Some(100.0 - used_percent),
                    Some(format!("额度余量 {remaining} / {limit}")),
                )
            }
            _ => (None, None, None),
        }
    };
    let mut metrics = Vec::new();
    // 5 小时滚动窗：limits[].detail（可能多条，逐条展示）。
    if let Some(limits) = value.get("limits").and_then(|item| item.as_array()) {
        for window in limits {
            let Some(detail) = window.get("detail") else {
                continue;
            };
            let (used, remaining, quota_detail) = utilization(
                detail.get("limit").and_then(number_field),
                detail.get("remaining").and_then(number_field),
            );
            metrics.push(UsageMetric {
                label: "5 小时窗口".into(),
                used,
                total: Some(100.0),
                remaining,
                unit: "%".into(),
                resets_at: detail.get("resetTime").and_then(extract_reset_time),
                detail: quota_detail,
            });
        }
    }
    // 周配额（每 7 天自订阅日刷新）：usage（单条）。
    if let Some(usage) = value.get("usage") {
        let (used, remaining, quota_detail) = utilization(
            usage.get("limit").and_then(number_field),
            usage.get("remaining").and_then(number_field),
        );
        metrics.push(UsageMetric {
            label: "周窗口".into(),
            used,
            total: Some(100.0),
            remaining,
            unit: "%".into(),
            resets_at: usage.get("resetTime").and_then(extract_reset_time),
            detail: quota_detail,
        });
    }
    if metrics.is_empty() {
        return Err("Kimi Coding 响应未包含用量条目".into());
    }
    Ok(metrics)
}

/// MiniMax Token Plan（编程套餐）额度解析。
///
/// `model_remains` 数组含 `general`（编程套餐）与 `video` 等其他模型条目，
/// 只取 `general`。字段语义是"剩余百分比"（0-100），反转为已用百分比。
/// 5 小时桶始终存在；周桶靠 `current_weekly_status == 1` 判定激活——无周
/// 限额的套餐该字段为 3 且剩余恒为 100，不应展示。
fn parse_minimax_token_plan(value: &serde_json::Value) -> Result<Vec<UsageMetric>, String> {
    // MiniMax 的业务错误走 HTTP 200 + base_resp.status_code，必须先于解析检查。
    if let Some(base_resp) = value.get("base_resp") {
        let status_code = base_resp
            .get("status_code")
            .and_then(|item| item.as_i64())
            .unwrap_or(0);
        if status_code != 0 {
            let message = base_resp
                .get("status_msg")
                .and_then(|item| item.as_str())
                .unwrap_or("unknown error");
            return Err(format!("MiniMax 接口错误（code {status_code}）：{message}"));
        }
    }
    let model_remains = value
        .get("model_remains")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "MiniMax 响应缺少 model_remains".to_string())?;
    let item = model_remains
        .iter()
        .find(|item| item.get("model_name").and_then(|value| value.as_str()) == Some("general"))
        .ok_or_else(|| "MiniMax 响应未包含编程套餐（general）条目".to_string())?;
    let mut metrics = Vec::new();
    // 5 小时桶：剩余百分比 → 已用百分比。
    if let Some(remaining) = item
        .get("current_interval_remaining_percent")
        .and_then(number_field)
    {
        metrics.push(UsageMetric {
            label: "5 小时窗口".into(),
            used: Some(100.0 - remaining),
            total: Some(100.0),
            remaining: Some(remaining),
            unit: "%".into(),
            resets_at: item.get("end_time").and_then(extract_reset_time),
            detail: None,
        });
    }
    // 周桶：仅 status=1 时激活（status=3 表示该套餐无周限额）。
    if item.get("current_weekly_status").and_then(|value| value.as_i64()) == Some(1) {
        if let Some(remaining) = item
            .get("current_weekly_remaining_percent")
            .and_then(number_field)
        {
            metrics.push(UsageMetric {
                label: "周窗口".into(),
                used: Some(100.0 - remaining),
                total: Some(100.0),
                remaining: Some(remaining),
                unit: "%".into(),
                resets_at: item.get("weekly_end_time").and_then(extract_reset_time),
                detail: None,
            });
        }
    }
    if metrics.is_empty() {
        return Err("MiniMax 响应未包含可用额度条目".into());
    }
    Ok(metrics)
}

async fn fetch_usage_json(
    spec: &UsageEndpointSpec,
    url: &str,
    secret: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(timeout)
        .redirect(redirect_policy())
        .build()
        .map_err(|error| error.to_string())?;
    let credential = match spec.auth {
        UsageAuthStyle::Bearer => format!("Bearer {secret}"),
        UsageAuthStyle::RawKey => secret.to_string(),
    };
    let mut header = HeaderValue::from_str(&credential)
        .map_err(|_| "API key contains invalid header characters".to_string())?;
    header.set_sensitive(true);
    let mut request = client
        .get(url)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, header);
    if matches!(spec.auth, UsageAuthStyle::RawKey) {
        // 智谱 monitor 接口按 Accept-Language 本地化文案，固定英文避免字段漂移。
        request = request.header("Accept-Language", "en-US,en");
    }
    let response = tokio::time::timeout(timeout, request.send())
        .await
        .map_err(|_| "用量查询超时".to_string())?
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        if response.content_length().unwrap_or(0) > USAGE_RESPONSE_LIMIT_BYTES as u64 {
            return Err(format!("HTTP {status}"));
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        let visible = &bytes[..bytes.len().min(USAGE_RESPONSE_LIMIT_BYTES)];
        return Err(error_detail(status, visible));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > USAGE_RESPONSE_LIMIT_BYTES {
        return Err("用量响应过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "用量响应不是有效 JSON".to_string())
}

/// 401/403 是凭证问题（对齐 cc-switch coding plan 的 credential_status::
/// Expired 语义）：加人可读前缀引导用户到「设置 → 模型」检查 API Key；
/// 其余错误（网络/超时/5xx/业务解析）原样返回。错误串以 `HTTP {status}`
/// 开头由 error_detail 的输出格式保证。
fn with_credential_hint(error: String) -> String {
    if error.starts_with("HTTP 401") || error.starts_with("HTTP 403") {
        format!("API Key 无效或已过期（{error}）")
    } else {
        error
    }
}

pub(crate) async fn query_provider_usage_inner(
    request: UsageQueryRequest,
    secret_state: &SecretState,
) -> Result<UsageQueryResult, String> {
    let provider_id = request.provider_id.trim().to_string();
    let Some(spec) = usage_endpoint(&provider_id) else {
        return Err(format!("Provider {provider_id} 暂不支持用量查询"));
    };
    let secret = resolve_secret(
        secret_state,
        &provider_id,
        request.secret_id.as_deref(),
    )?
    .ok_or_else(|| "未配置 API Key，无法查询用量".to_string())?;
    // 先做密钥绑定校验再用 endpointHint 解析 URL：分流拒绝发生在任何网络
    // 访问之前，且密钥不参与 URL 解析。
    let url = spec.url.resolve(request.endpoint_hint.as_deref())?;
    let value = fetch_usage_json(
        &spec,
        &url,
        &secret,
        Duration::from_millis(USAGE_TIMEOUT_MS),
    )
    .await
    .map_err(|error| with_credential_hint(redact_secret(&error, Some(&secret))))?;
    let metrics = (spec.parse)(&value)?;
    let checked_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64;
    Ok(UsageQueryResult {
        provider_id,
        kind: spec.kind.to_string(),
        metrics,
        checked_at_ms,
    })
}

#[tauri::command]
pub(crate) async fn query_provider_usage(
    request: UsageQueryRequest,
    secret_state: State<'_, SecretState>,
) -> Result<UsageQueryResult, String> {
    query_provider_usage_inner(request, &secret_state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn number_field_accepts_numbers_and_numeric_strings() {
        assert_eq!(number_field(&serde_json::json!(12.5)), Some(12.5));
        assert_eq!(number_field(&serde_json::json!("110.00")), Some(110.0));
        assert_eq!(number_field(&serde_json::json!(" 3.5 ")), Some(3.5));
        assert_eq!(number_field(&serde_json::json!(null)), None);
        assert_eq!(number_field(&serde_json::json!("abc")), None);
        assert_eq!(number_field(&serde_json::json!(true)), None);
    }

    #[test]
    fn reset_time_normalizes_seconds_millis_and_strings() {
        // 秒级时间戳 1_700_000_000 → 统一毫秒时间戳字符串。
        assert_eq!(
            extract_reset_time(&serde_json::json!(1_700_000_000)),
            Some("1700000000000".to_string())
        );
        // 毫秒级（>= 1e12）不二次放大。
        assert_eq!(
            extract_reset_time(&serde_json::json!(1_700_000_000_000_i64)),
            Some("1700000000000".to_string())
        );
        // ISO 字符串透传，0/负值视为无重置时间。
        assert_eq!(
            extract_reset_time(&serde_json::json!("2024-01-01T00:00:00Z")),
            Some("2024-01-01T00:00:00Z".to_string())
        );
        assert_eq!(extract_reset_time(&serde_json::json!(0)), None);
        assert_eq!(extract_reset_time(&serde_json::json!(-1)), None);
    }

    #[test]
    fn endpoint_table_only_covers_supported_providers_over_https() {
        for provider in ["deepseek", "zhipu-glm", "kimi", "kimi-coding", "minimax-chat"] {
            let spec = usage_endpoint(provider).expect("supported provider");
            let url = spec.url.resolve(None).expect("default URL must resolve");
            assert!(url.starts_with("https://"), "{provider} must use https");
            assert!(matches!(spec.kind, "balance" | "quota"));
        }
        for provider in ["openai", "gemini", "ollama", "demo", ""] {
            assert!(usage_endpoint(provider).is_none(), "{provider} must be unsupported");
        }
    }

    #[test]
    fn zhipu_quota_url_routes_official_sites_only() {
        let cn = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
        let en = "https://api.z.ai/api/monitor/usage/quota/limit";
        // 无 hint / 空白 hint → 默认国内站。
        assert_eq!(zhipu_quota_url(None).unwrap(), cn);
        assert_eq!(zhipu_quota_url(Some("  ")).unwrap(), cn);
        assert_eq!(
            zhipu_quota_url(Some("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions")).unwrap(),
            cn,
        );
        assert_eq!(
            zhipu_quota_url(Some("https://api.z.ai/api/coding/paas/v4/chat/completions")).unwrap(),
            en,
        );
        // 白名单外的 host 一律 fail-closed 拒绝（密钥不离开官方域名）。
        let attacker = zhipu_quota_url(Some("https://attacker.example.com/v1")).unwrap_err();
        assert!(attacker.contains("已拒绝"), "unexpected error: {attacker}");
        assert!(zhipu_quota_url(Some("not a url")).is_err());
    }

    #[test]
    fn parses_deepseek_balance_with_availability() {
        let metrics = parse_deepseek_balance(&serde_json::json!({
            "is_available": true,
            "balance_infos": [
                { "currency": "CNY", "total_balance": "110.00" },
                { "currency": "USD", "total_balance": "5.50" }
            ]
        }))
        .unwrap();
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].remaining, Some(110.0));
        assert_eq!(metrics[0].unit, "CNY");
        assert!(metrics[0].detail.is_none());

        let depleted = parse_deepseek_balance(&serde_json::json!({
            "is_available": false,
            "balance_infos": [{ "currency": "CNY", "total_balance": "0.00" }]
        }))
        .unwrap();
        assert!(depleted[0].detail.as_deref().is_some_and(|detail| detail.contains("欠费")));

        assert!(parse_deepseek_balance(&serde_json::json!({ "balance_infos": [] })).is_err());
        assert!(parse_deepseek_balance(&serde_json::json!({})).is_err());
    }

    #[test]
    fn parses_zhipu_quota_windows_and_plan_level() {
        let metrics = parse_zhipu_quota(&serde_json::json!({
            "data": {
                "level": "pro",
                "limits": [
                    { "type": "TOKENS_LIMIT", "percentage": 12.34, "nextResetTime": 1_700_000_000_000_i64, "unit": 3 },
                    { "type": "tokens_limit", "percentage": 45.0, "unit": 6 },
                    { "type": "CREDIT_LIMIT", "percentage": 80.0, "unit": 3 },
                    { "type": "UNKNOWN_LIMIT", "percentage": 99.0, "unit": 3 }
                ]
            }
        }))
        .unwrap();
        // 大小写不敏感识别 TOKENS_LIMIT/CREDIT_LIMIT，未知类型忽略；unit 显式
        // 分类占槽后多余的 unit:3 CREDIT_LIMIT 落入兜底但两槽已满 → 忽略
        // （每窗一条，对齐 cc-switch 槽位语义）。
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].label, "Token5 小时窗口");
        assert_eq!(metrics[0].used, Some(12.34));
        assert_eq!(metrics[0].total, Some(100.0));
        assert_eq!(
            metrics[0].resets_at.as_deref(),
            Some("1700000000000")
        );
        assert_eq!(metrics[0].detail.as_deref(), Some("套餐：pro"));
        assert_eq!(metrics[1].label, "Token周窗口");
        assert_eq!(metrics[1].used, Some(45.0));
    }

    #[test]
    fn parses_zhipu_quota_fallback_classification_without_unit() {
        // 兜底 a：无 nextResetTime 的条目优先归 5 小时窗（0% 状态可能无 reset），
        // 有 reset 的归周窗。
        let metrics = parse_zhipu_quota(&serde_json::json!({
            "data": { "limits": [
                { "type": "TOKENS_LIMIT", "percentage": 30.0, "nextResetTime": 2_000_000_000_000_i64 },
                { "type": "TOKENS_LIMIT", "percentage": 10.0 }
            ] }
        }))
        .unwrap();
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].label, "Token5 小时窗口");
        assert_eq!(metrics[0].used, Some(10.0));
        assert!(metrics[0].resets_at.is_none());
        assert_eq!(metrics[1].label, "Token周窗口");
        assert_eq!(metrics[1].used, Some(30.0));

        // 兜底 b：三条均有 reset → 按重置时间升序填空槽（较早的归 5 小时窗），
        // 与数组顺序无关；两槽填满后最晚的一条（50%）忽略。
        let metrics = parse_zhipu_quota(&serde_json::json!({
            "data": { "limits": [
                { "type": "TOKENS_LIMIT", "percentage": 50.0, "nextResetTime": 3_000_000_000_000_i64 },
                { "type": "TOKENS_LIMIT", "percentage": 20.0, "nextResetTime": 1_000_000_000_000_i64 },
                { "type": "TOKENS_LIMIT", "percentage": 99.0, "nextResetTime": 2_000_000_000_000_i64 }
            ] }
        }))
        .unwrap();
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].used, Some(20.0));
        assert_eq!(metrics[1].used, Some(99.0));

        // 兜底 c：老套餐单条（无 unit）自然降级为仅展示 5 小时窗。
        let metrics = parse_zhipu_quota(&serde_json::json!({
            "data": { "limits": [ { "type": "TOKENS_LIMIT", "percentage": 7.0 } ] }
        }))
        .unwrap();
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].label, "Token5 小时窗口");
    }

    #[test]
    fn parses_moonshot_balance_breakdown() {
        let metrics = parse_moonshot_balance(&serde_json::json!({
            "code": 0,
            "data": {
                "available_balance": 49.58894,
                "voucher_balance": 46.58893,
                "cash_balance": 3.00001
            },
            "scode": "0x0",
            "status": true
        }))
        .unwrap();
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].remaining, Some(49.58894));
        assert_eq!(metrics[0].unit, "CNY");
        assert!(metrics[0]
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("代金券 46.59") && detail.contains("现金 3.00")));

        // 字符串数值同样可解析；缺失 available_balance 报错。
        assert_eq!(
            parse_moonshot_balance(&serde_json::json!({
                "data": { "available_balance": "110.50" }
            }))
            .unwrap()[0]
                .remaining,
            Some(110.5)
        );
        assert!(parse_moonshot_balance(&serde_json::json!({ "data": {} })).is_err());
    }

    #[test]
    fn parses_kimi_coding_windows_as_utilization() {
        let metrics = parse_kimi_coding_usage(&serde_json::json!({
            "limits": [
                { "detail": { "limit": "2", "remaining": "1.5", "resetTime": "2024-01-01T00:00:00Z" } }
            ],
            "usage": { "limit": 10, "remaining": 2.5, "resetTime": 1_700_000_000 }
        }))
        .unwrap();
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].label, "5 小时窗口");
        assert_eq!(metrics[0].used, Some(25.0));
        // 剩余百分比 = 100 - 已用（对齐 cc-switch token_plan 展示层与
        // MiniMax 的"剩余 N %"形态）；额度余量绝对值经 detail 补充语义。
        assert_eq!(metrics[0].remaining, Some(75.0));
        assert_eq!(metrics[0].detail.as_deref(), Some("额度余量 1.5 / 2"));
        assert_eq!(metrics[0].resets_at.as_deref(), Some("2024-01-01T00:00:00Z"));
        assert_eq!(metrics[1].label, "周窗口");
        assert_eq!(metrics[1].used, Some(75.0));
        assert_eq!(metrics[1].remaining, Some(25.0));
        assert_eq!(metrics[1].detail.as_deref(), Some("额度余量 2.5 / 10"));

        assert!(parse_kimi_coding_usage(&serde_json::json!({})).is_err());
    }

    #[test]
    fn optional_metric_fields_are_absent_not_null_in_json() {
        // wire 契约：Option 字段 None 时不出现在 JSON（而非 null）——TS 侧按
        // `field?: number`（undefined/缺失）判空，null 会漏过检查导致前端崩溃。
        let value = serde_json::to_value(UsageMetric {
            label: "Token5 小时窗口".into(),
            used: Some(12.5),
            total: None,
            remaining: None,
            unit: "%".into(),
            resets_at: None,
            detail: None,
        })
        .unwrap();
        let object = value.as_object().unwrap();
        assert!(object.contains_key("used") && object.contains_key("unit"));
        for field in ["total", "remaining", "resetsAt", "detail"] {
            assert!(!object.contains_key(field), "{field} must be absent, not null");
        }
    }

    #[test]
    fn credential_hint_covers_401_and_403_only() {        assert_eq!(
            with_credential_hint("HTTP 401: Authentication Fails, Your api key is invalid".into()),
            "API Key 无效或已过期（HTTP 401: Authentication Fails, Your api key is invalid）",
        );
        assert!(with_credential_hint("HTTP 403: only available for Coding Agents".into())
            .starts_with("API Key 无效或已过期（"));
        // 其余错误原样透传：4xx 其他状态、5xx、超时与业务解析错误。
        assert_eq!(
            with_credential_hint("HTTP 429: rate limited".into()),
            "HTTP 429: rate limited",
        );
        assert_eq!(
            with_credential_hint("HTTP 500: internal".into()),
            "HTTP 500: internal",
        );
        assert_eq!(
            with_credential_hint("用量查询超时".into()),
            "用量查询超时",
        );
    }

    #[test]
    fn parses_minimax_token_plan_two_windows_from_remaining_percent() {
        // 主路径：general 桶 5h 剩 98% / weekly 剩 95% → 已用 2% / 5%。
        let metrics = parse_minimax_token_plan(&serde_json::json!({
            "model_remains": [
                {
                    "model_name": "general",
                    "current_interval_remaining_percent": 98.0,
                    "current_weekly_remaining_percent": 95.0,
                    "current_interval_status": 1,
                    "current_weekly_status": 1,
                    "end_time": 1_780_329_600_000_i64,
                    "weekly_end_time": 1_780_848_000_000_i64
                },
                {
                    "model_name": "video",
                    "current_interval_remaining_percent": 100.0,
                    "current_weekly_remaining_percent": 100.0
                }
            ],
            "base_resp": { "status_code": 0, "status_msg": "success" }
        }))
        .unwrap();
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].label, "5 小时窗口");
        assert_eq!(metrics[0].used, Some(2.0));
        assert_eq!(metrics[0].remaining, Some(98.0));
        assert_eq!(metrics[0].total, Some(100.0));
        assert_eq!(metrics[0].resets_at.as_deref(), Some("1780329600000"));
        assert_eq!(metrics[1].label, "周窗口");
        assert_eq!(metrics[1].used, Some(5.0));
        assert_eq!(metrics[1].remaining, Some(95.0));
        assert_eq!(metrics[1].resets_at.as_deref(), Some("1780848000000"));
    }

    #[test]
    fn parses_minimax_skips_video_and_handles_weekly_inactive() {
        // video 在前、general 在后仍能定位；weekly status=3（无周限额）只出 5h 桶。
        let metrics = parse_minimax_token_plan(&serde_json::json!({
            "model_remains": [
                {
                    "model_name": "video",
                    "current_interval_remaining_percent": 50.0,
                    "current_weekly_remaining_percent": 50.0
                },
                {
                    "model_name": "general",
                    "current_interval_remaining_percent": 80.0,
                    "current_weekly_remaining_percent": 100.0,
                    "current_weekly_status": 3
                }
            ]
        }))
        .unwrap();
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].used, Some(20.0));
    }

    #[test]
    fn parses_minimax_surfaces_business_error_and_missing_general() {
        // MiniMax 业务错误走 HTTP 200 + base_resp.status_code，必须先于解析报出。
        let business_error = parse_minimax_token_plan(&serde_json::json!({
            "base_resp": { "status_code": 1004, "status_msg": "invalid api key" }
        }))
        .unwrap_err();
        assert!(business_error.contains("1004") && business_error.contains("invalid api key"));

        // 只有 video / 缺 model_remains → 确定性错误。
        assert!(parse_minimax_token_plan(&serde_json::json!({
            "model_remains": [{ "model_name": "video", "current_interval_remaining_percent": 100.0 }]
        }))
        .is_err());
        assert!(parse_minimax_token_plan(&serde_json::json!({})).is_err());
    }

    #[tokio::test]
    async fn rejects_unsupported_provider_without_network_access() {
        let result = query_provider_usage_inner(
            UsageQueryRequest {
                provider_id: "openai".into(),
                secret_id: None,
                endpoint_hint: None,
            },
            &SecretState::default(),
        )
        .await;
        assert!(result.unwrap_err().contains("暂不支持用量查询"));
    }

    #[tokio::test]
    async fn rejects_cross_provider_secret_before_secret_store_access() {
        // 受陷渲染进程用 deepseek 身份 + openai 的 secretId：绑定校验必须先于
        // 密钥库读取拒绝。
        let result = query_provider_usage_inner(
            UsageQueryRequest {
                provider_id: "deepseek".into(),
                secret_id: Some("provider.openai.api-key".into()),
                endpoint_hint: None,
            },
            &SecretState::default(),
        )
        .await;
        assert!(result.unwrap_err().contains("not bound to provider"));
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let bytes_read = stream.read(&mut buffer).unwrap();
            assert!(bytes_read > 0, "HTTP request ended prematurely");
            request.extend_from_slice(&buffer[..bytes_read]);
            let Some(header_end) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
            else {
                continue;
            };
            if request.len() >= header_end {
                return String::from_utf8_lossy(&request[..header_end]).to_string();
            }
        }
    }

    #[tokio::test]
    async fn fetches_usage_with_bearer_and_raw_key_auth_over_local_http() {
        // 同一本地 server 处理两次请求：Bearer（deepseek spec）与裸 key（智谱 spec）。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"balance_infos":[{"currency":"CNY","total_balance":"88.00"}],"is_available":true}"#;
        let server = std::thread::spawn(move || {
            let mut received = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                received.push(read_http_request(&mut stream));
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .unwrap();
            }
            received
        });
        let url = format!("http://{address}/user/balance");
        let deepseek_spec = usage_endpoint("deepseek").unwrap();
        let zhipu_spec = usage_endpoint("zhipu-glm").unwrap();
        let timeout = Duration::from_millis(5_000);

        let bearer = fetch_usage_json(&deepseek_spec, &url, "bearer-secret", timeout)
            .await
            .unwrap();
        assert!(bearer.get("balance_infos").is_some());

        let raw_key = fetch_usage_json(&zhipu_spec, &url, "raw-secret", timeout)
            .await
            .unwrap();
        assert!(raw_key.get("balance_infos").is_some());

        let requests = server.join().unwrap();
        assert!(requests[0].contains("GET /user/balance HTTP/1.1"));
        assert!(requests[0].contains("Authorization: Bearer bearer-secret"));
        assert!(requests[1].contains("Authorization: raw-secret"));
        assert!(requests[1].contains("Accept-Language: en-US,en"));
    }

    #[tokio::test]
    async fn surfaces_non_success_status_with_sanitized_detail() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_http_request(&mut stream);
            let body = r#"{"error":{"message":"Authentication Fails, Your api key: bearer-secret is invalid"}}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .unwrap();
        });
        let url = format!("http://{address}/user/balance");
        let spec = usage_endpoint("deepseek").unwrap();
        let error = fetch_usage_json(&spec, &url, "bearer-secret", Duration::from_millis(5_000))
            .await
            .unwrap_err();
        server.join().unwrap();
        // 错误详情里的密钥回显必须被脱敏。
        let redacted = redact_secret(&error, Some("bearer-secret"));
        assert!(redacted.contains("HTTP 401"), "unexpected error: {redacted}");
        assert!(!redacted.contains("bearer-secret"), "secret leaked: {redacted}");
        assert!(redacted.contains("[REDACTED]"));
    }
}
