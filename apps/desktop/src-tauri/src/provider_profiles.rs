//! Provider Profile 解析表（强边界）。
//!
//! 这是模型端点安全模型的权威源：渲染进程只传入 `providerId`（和可选的 endpoint
//! 覆盖），最终请求 URL、认证格式、允许的 origin 全部由本模块按内置表解析。
//! 受陷渲染进程无法把密钥库里的密钥发到任意 host——见 `AGENTS.md` 安全模型段
//! 「模型端点绑定」与 `model_http.rs::stream_model_http_to_events` 的 origin 校验。
//!
//! Provider Profile 文档解析（v4/v3/v2/legacy 迁移）与 secretId 规范化/迁移也在此
//! 作为唯一权威源（`decode_profile_document` / `normalize_profile_draft`），WebView
//! 只传原始 JSON，由本模块校验后返回规范化结果。
//!
//! 与前端 `builtinProviderDescriptors.ts` 的 `defaultProfile.endpoint` / `apiFormat`
//! 逐字对应，由 `scripts/tauri-capability-audit.mjs` 的 secret namespace 一致性审计
//! 间接覆盖（defaultSecretId 前缀两侧必须一致）。

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::model_http::ModelApiFormat;
use crate::network_policy::{is_allowed_plain_http_host, url_origin, validate_model_url};

pub(crate) const PROVIDER_PROFILE_SCHEMA_VERSION: u64 = 4;
const PREVIOUS_PROVIDER_PROFILE_SCHEMA_VERSION: u64 = 3;
/// v2 是最后一个使用 legacy secret 前缀的版本：只有 v2 文档需要 secretId
/// 迁移（legacy 前缀 → 当前 namespace）；v3 起文档已持有当前 namespace。
const SECRET_MIGRATION_SCHEMA_VERSION: u64 = 2;

// Provider 内置表、边界常量、secret 前缀与 per-provider 可信 host 均由
// `contracts/providers.json` 生成（`generated_provider_table.rs`）。此处 re-export
// 供 `secrets.rs` 等模块消费；`BUILTIN_PROVIDER_PROFILES` 由生成表派生。
pub(crate) use crate::generated_provider_table::{
    CONTEXT_DEFAULT, CONTEXT_MAX, CONTEXT_MIN, CURRENT_PROVIDER_SECRET_PREFIXES,
    ENDPOINT_MAX_BYTES, GENERATED_PROVIDER_ENTRIES, IDENTIFIER_MAX_BYTES,
    LEGACY_PROVIDER_SECRET_PREFIXES, MAX_OUTPUT_DEFAULT, MAX_OUTPUT_MAX, MAX_OUTPUT_MIN,
    MODEL_ID_MAX_BYTES, PROVIDER_TRUSTED_HOSTS, TIMEOUT_DEFAULT_MS, TIMEOUT_MAX_MS,
    TIMEOUT_MIN_MS,
};
const BUILTIN_PROVIDER_PROFILES: &[ProviderProfileEntry] = GENERATED_PROVIDER_ENTRIES;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) enum AuthKind {
    None,
    ApiKey,
}

#[derive(Copy, Clone, Debug)]
pub(crate) struct ProviderAuth {
    pub kind: AuthKind,
    pub default_secret_id: Option<&'static str>,
    /// 与前端 descriptor 的 `auth.required` 逐字对应（供审计与未来命令校验；当前解析不消费）。
    #[allow(dead_code)]
    pub required: bool,
}

#[derive(Copy, Clone, Debug)]
pub(crate) struct ProviderCapabilities {
    pub tool_references: bool,
    pub tool_search: bool,
}

#[derive(Copy, Clone, Debug)]
pub(crate) struct ProviderDefaultProfile {
    /// 与前端 descriptor 的 `defaultProfile` 逐字对应（供审计与文档；解析不消费）。
    #[allow(dead_code)]
    pub profile_id: &'static str,
    pub endpoint: &'static str,
    #[allow(dead_code)]
    pub model_id: &'static str,
    pub timeout_ms: u64,
    pub max_output_tokens: u64,
    pub context_window: u64,
    #[allow(dead_code)]
    pub capabilities: ProviderCapabilities,
}

/// 模型级 wire 覆盖（多协议网关用，如 OpenCode Go：同一订阅下 chat / responses / messages）。
///
/// 只在**同 origin** 下声明（由 `scripts/generate-provider-sources.mjs` fail-closed 校验）：
/// 端点覆盖规则（换 host 时保留协议 path）依赖这一不变量。
#[derive(Copy, Clone, Debug)]
pub(crate) struct ProviderModelWire {
    pub model_id: &'static str,
    pub api_format: ModelApiFormat,
    pub endpoint: &'static str,
}

#[derive(Copy, Clone, Debug)]
pub(crate) struct ProviderProfileEntry {
    pub provider_id: &'static str,
    pub api_format: ModelApiFormat,
    pub auth: ProviderAuth,
    pub supported_capabilities: ProviderCapabilities,
    pub default_profile: ProviderDefaultProfile,
    /// 放行任意公网 https 端点（仅自定义中转站 provider 使用；http 公网仍由
    /// `validate_model_url` 拒绝，secret 绑定由请求期 `is_secret_id_bound_to_provider` 独立强制）。
    pub allow_public_endpoints: bool,
    /// 逐模型的协议/端点覆盖；未命中时回落 `api_format` + `default_profile.endpoint`。
    pub model_wires: &'static [ProviderModelWire],
    pub legacy_secret_id_prefixes: &'static [&'static str],
}

impl ProviderProfileEntry {
    fn api_format_str(&self) -> &'static str {
        match self.api_format {
            ModelApiFormat::OpenaiCompatible => "openai-compatible",
            ModelApiFormat::OpenaiResponses => "openai-responses",
            ModelApiFormat::AnthropicCompatible => "anthropic-compatible",
        }
    }

    /// 该模型生效的协议与端点（未声明 wire 或模型未知时即 provider 默认）。
    ///
    /// 未命中回落默认是有意的：用户可以在设置页手填目录外的 modelId，此时按 provider
    /// 主协议发送（与「未知模型 = 按 provider 默认」的既有语义一致）。
    pub(crate) fn wire_for(&self, model_id: Option<&str>) -> (ModelApiFormat, &'static str) {
        let Some(model_id) = model_id else {
            return (self.api_format, self.default_profile.endpoint);
        };
        self.model_wires
            .iter()
            .find(|wire| wire.model_id == model_id)
            .map(|wire| (wire.api_format, wire.endpoint))
            .unwrap_or((self.api_format, self.default_profile.endpoint))
    }
}

/// 内置 Provider Profile 表。
///
/// 数据段由 `contracts/providers.json` 单一来源生成（`generated_provider_table.rs`）。
/// 新增 Provider 只需修改 `contracts/providers.json` 并重新运行
/// `npm run generate:providers`；secret 前缀、可信第三方 host 白名单与
/// `runtime-semantic-versions.json` 的 provider 组件版本会同步更新。
fn find_profile(provider_id: &str) -> Result<&'static ProviderProfileEntry, String> {
    BUILTIN_PROVIDER_PROFILES
        .iter()
        .find(|entry| entry.provider_id == provider_id)
        .ok_or_else(|| format!("unknown provider id: {provider_id}"))
}

fn is_provider_id(value: &str) -> bool {
    value == "demo" || find_profile(value).is_ok()
}

/// Profile ID / Secret ID 共享的标识符形态校验（与 TS `providerProfile.ts` 逐字等价）。
fn matches_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= IDENTIFIER_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Provider Profile 配置期的 endpoint 校验：合法 URL、仅 http/https、不含用户信息。
/// origin 的本地/私网限制由 `resolve_profile` 在请求期强校验（配置期保持宽松）。
fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    if endpoint.is_empty() {
        return Err("模型 Endpoint 不能为空".into());
    }
    if endpoint.len() > ENDPOINT_MAX_BYTES {
        return Err("模型 Endpoint 过长".into());
    }
    let url =
        reqwest::Url::parse(endpoint).map_err(|_| "模型 Endpoint 不是有效 URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("模型 Endpoint 仅支持 HTTP 或 HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("模型 Endpoint 不能包含用户名或密码".into());
    }
    Ok(())
}

fn bounded_integer(value: Option<u64>, fallback: u64, minimum: u64, maximum: u64) -> u64 {
    value.unwrap_or(fallback).clamp(minimum, maximum)
}

fn strict_integer(
    value: Option<&Value>,
    minimum: u64,
    maximum: u64,
    label: &str,
) -> Result<u64, String> {
    match value.and_then(Value::as_u64) {
        Some(parsed) if parsed >= minimum && parsed <= maximum => Ok(parsed),
        _ => Err(format!("{label} 无效")),
    }
}

fn assert_exact_fields(
    value: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> Result<(), String> {
    for key in value.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("{label} 包含未知字段：{key}"));
        }
    }
    Ok(())
}

/// 草稿能力的宽松解析（未提供视为 false，多出的字段忽略）。
fn parse_capabilities_lenient(value: Option<&Value>) -> (bool, bool) {
    let Some(capabilities) = value.and_then(Value::as_object) else {
        return (false, false);
    };
    (
        capabilities
            .get("toolReferences")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        capabilities
            .get("toolSearch")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

/// 持久化文档能力的严格解析（字段必须齐全且为布尔，未知字段拒绝）。
fn parse_capabilities_strict(value: Option<&Value>) -> Result<(bool, bool), String> {
    let capabilities = value
        .and_then(Value::as_object)
        .ok_or_else(|| "Provider Profile 字段格式无效".to_string())?;
    let tool_references = capabilities
        .get("toolReferences")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Provider Profile 字段格式无效".to_string())?;
    let tool_search = capabilities
        .get("toolSearch")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Provider Profile 字段格式无效".to_string())?;
    assert_exact_fields(
        capabilities,
        &["toolReferences", "toolSearch"],
        "Provider capabilities",
    )?;
    Ok((tool_references, tool_search))
}

/// 判断 `secret_id` 是否落在该 provider 当前 secretId namespace（默认前缀或其子级）。
fn is_secret_id_compatible_with_provider(provider_id: &str, secret_id: &str) -> bool {
    let Ok(entry) = find_profile(provider_id) else {
        return false;
    };
    let Some(base) = entry.auth.default_secret_id else {
        return false;
    };
    secret_id == base || secret_id.starts_with(&format!("{base}."))
}

/// 判断 `secret_id` 是否落在该 provider 的 legacy secretId namespace。
fn is_legacy_secret_id_compatible_with_provider(provider_id: &str, secret_id: &str) -> bool {
    let Ok(entry) = find_profile(provider_id) else {
        return false;
    };
    entry
        .legacy_secret_id_prefixes
        .iter()
        .any(|base| secret_id == *base || secret_id.starts_with(&format!("{base}.")))
}

/// 是否属于任一 provider 的 legacy secretId namespace（清理/迁移授权用）。
fn is_known_legacy_secret_id(secret_id: &str) -> bool {
    BUILTIN_PROVIDER_PROFILES
        .iter()
        .any(|entry| is_legacy_secret_id_compatible_with_provider(entry.provider_id, secret_id))
}

/// 请求期 secret 绑定校验：`secret_id` 必须落在该 provider 的 current 或 legacy
/// namespace。与配置期的 `is_provider_secret_compatible` 不同，此处合并 current + legacy——
/// 尚未完成迁移的 legacy secret 仍可被其归属 provider 使用，但绝不允许落到其它 provider。
/// 封死跨 Provider 组合：受陷渲染进程不能拿 provider B 的密钥发到 provider A 允许的端点。
pub(crate) fn is_secret_id_bound_to_provider(provider_id: &str, secret_id: &str) -> bool {
    is_secret_id_compatible_with_provider(provider_id, secret_id)
        || is_legacy_secret_id_compatible_with_provider(provider_id, secret_id)
}

/// 规范化 secretId：空白值回落默认前缀，校验形态与 provider 身份匹配。
fn normalize_secret_id(provider_id: &str, value: Option<&str>) -> Result<Option<String>, String> {
    if provider_id == "demo" {
        return Ok(None);
    }
    let entry = find_profile(provider_id)?;
    if entry.auth.kind == AuthKind::None {
        return Ok(None);
    }
    let default_secret_id = entry.auth.default_secret_id;
    let secret_id = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(default_secret_id);
    let Some(secret_id) = secret_id else {
        return Err("Provider Secret ID 无效".into());
    };
    if !matches_identifier(secret_id) {
        return Err("Provider Secret ID 无效".into());
    }
    if !is_secret_id_compatible_with_provider(provider_id, secret_id) {
        return Err("Provider Secret ID 与 Provider 身份不匹配".into());
    }
    Ok(Some(secret_id.to_string()))
}

/// legacy secretId 迁移到当前 namespace（suffix 原样保留）。
fn migrate_secret_id(provider_id: &str, value: Option<&str>) -> Option<String> {
    if provider_id == "demo" {
        return None;
    }
    let entry = find_profile(provider_id).ok()?;
    if entry.auth.kind == AuthKind::None {
        return None;
    }
    let default_secret_id = entry.auth.default_secret_id?;
    let secret_id = value.unwrap_or(default_secret_id);
    for legacy in entry.legacy_secret_id_prefixes {
        if secret_id == *legacy {
            return Some(default_secret_id.to_string());
        }
        if let Some(suffix) = secret_id.strip_prefix(&format!("{legacy}.")) {
            return Some(format!("{default_secret_id}.{suffix}"));
        }
    }
    Some(secret_id.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesDoc {
    tool_references: bool,
    tool_search: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileDoc {
    schema_version: u64,
    profile_id: String,
    provider_id: String,
    api_format: String,
    endpoint: String,
    model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    website: Option<String>,
    timeout_ms: u64,
    max_output_tokens: u64,
    context_window: u64,
    capabilities: CapabilitiesDoc,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSecretMigration {
    source_secret_id: String,
    target_secret_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DecodedProfileDoc {
    profile: ProviderProfileDoc,
    requires_persistence_migration: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_migration: Option<ProfileSecretMigration>,
}

fn demo_profile_doc() -> ProviderProfileDoc {
    ProviderProfileDoc {
        schema_version: PROVIDER_PROFILE_SCHEMA_VERSION,
        profile_id: "builtin.demo".to_string(),
        provider_id: "demo".to_string(),
        api_format: "demo".to_string(),
        endpoint: String::new(),
        model_id: "demo-v1".to_string(),
        model_name: None,
        website: None,
        timeout_ms: TIMEOUT_DEFAULT_MS,
        max_output_tokens: MAX_OUTPUT_DEFAULT,
        context_window: CONTEXT_DEFAULT,
        capabilities: CapabilitiesDoc {
            tool_references: false,
            tool_search: false,
        },
        secret_id: None,
    }
}

/// 规范化 settings 草稿（与 TS `normalizeProviderProfileDraft` 逐字等价）。
fn normalize_profile_draft(draft: &Value) -> Result<ProviderProfileDoc, String> {
    let draft = draft
        .as_object()
        .ok_or_else(|| "Provider Profile 格式无效".to_string())?;
    if draft.get("schemaVersion").and_then(Value::as_u64) != Some(PROVIDER_PROFILE_SCHEMA_VERSION) {
        return Err("不支持的 Provider Profile 版本".into());
    }
    let provider_id = draft
        .get("providerId")
        .and_then(Value::as_str)
        .ok_or_else(|| "不支持的 Provider".to_string())?;
    if !is_provider_id(provider_id) {
        return Err("不支持的 Provider".into());
    }
    if provider_id == "demo" {
        return Ok(demo_profile_doc());
    }
    let entry = find_profile(provider_id)?;
    let api_format = draft
        .get("apiFormat")
        .and_then(Value::as_str)
        .ok_or_else(|| "Provider 身份与 API 格式不匹配".to_string())?;
    if api_format != entry.api_format_str() {
        return Err("Provider 身份与 API 格式不匹配".into());
    }
    let profile_id = draft
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !matches_identifier(profile_id) {
        return Err("Provider Profile ID 无效".into());
    }
    let endpoint = draft
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    validate_endpoint(endpoint)?;
    let model_id = draft
        .get("modelId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if model_id.is_empty() {
        return Err("模型 ID 不能为空".into());
    }
    if model_id.len() > MODEL_ID_MAX_BYTES {
        return Err("模型 ID 过长".into());
    }
    let model_name = draft
        .get("modelName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if model_name.len() > MODEL_ID_MAX_BYTES {
        return Err("模型名称过长".into());
    }
    // website 是纯展示字段（Provider 官网/文档地址）：运行时不 dereference，
    // 与 modelName 同待遇（trim、空省略、256 字节上限），不做 URL 格式校验——
    // 一旦校验，将来收紧会让含旧值文档的 decode fail-closed。
    let website = draft
        .get("website")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if website.len() > MODEL_ID_MAX_BYTES {
        return Err("官网地址过长".into());
    }
    let timeout_ms = bounded_integer(
        draft.get("timeoutMs").and_then(Value::as_u64),
        entry.default_profile.timeout_ms,
        TIMEOUT_MIN_MS,
        TIMEOUT_MAX_MS,
    );
    let max_output_tokens = bounded_integer(
        draft.get("maxOutputTokens").and_then(Value::as_u64),
        entry.default_profile.max_output_tokens,
        MAX_OUTPUT_MIN,
        MAX_OUTPUT_MAX,
    );
    let context_window = bounded_integer(
        draft.get("contextWindow").and_then(Value::as_u64),
        entry.default_profile.context_window,
        CONTEXT_MIN,
        CONTEXT_MAX,
    );
    let (requested_tool_references, requested_tool_search) =
        parse_capabilities_lenient(draft.get("capabilities"));
    let secret_id =
        normalize_secret_id(provider_id, draft.get("secretId").and_then(Value::as_str))?;
    Ok(ProviderProfileDoc {
        schema_version: PROVIDER_PROFILE_SCHEMA_VERSION,
        profile_id: profile_id.to_string(),
        provider_id: provider_id.to_string(),
        api_format: entry.api_format_str().to_string(),
        endpoint: endpoint.to_string(),
        model_id: model_id.to_string(),
        model_name: (!model_name.is_empty()).then(|| model_name.to_string()),
        website: (!website.is_empty()).then(|| website.to_string()),
        timeout_ms,
        max_output_tokens,
        context_window,
        capabilities: CapabilitiesDoc {
            tool_references: entry.supported_capabilities.tool_references
                && requested_tool_references,
            tool_search: entry.supported_capabilities.tool_search && requested_tool_search,
        },
        secret_id,
    })
}

fn legacy_provider_id(kind: &str) -> &'static str {
    match kind {
        "demo" => "demo",
        "openai-compatible" => "generic-openai-compatible",
        "openai-responses" => "openai",
        // 旧版 anthropic-compatible 与已移除的 minimax 统一降级为
        // generic-anthropic-compatible（endpoint/modelId 原样保留）。
        _ => "generic-anthropic-compatible",
    }
}

fn is_legacy_kind(kind: &str) -> bool {
    matches!(
        kind,
        "demo" | "openai-compatible" | "openai-responses" | "anthropic-compatible"
    )
}

/// 旧版 kind 配置迁移（与 TS `migrateLegacyProviderConfig` 逐字等价）。
fn migrate_legacy_provider_config(
    value: &Map<String, Value>,
) -> Result<ProviderProfileDoc, String> {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    let provider_id = legacy_provider_id(kind);
    if provider_id == "demo" {
        return Ok(demo_profile_doc());
    }
    let entry = find_profile(provider_id)?;
    let draft = json!({
        "schemaVersion": PROVIDER_PROFILE_SCHEMA_VERSION,
        "profileId": format!("migrated.{provider_id}"),
        "providerId": provider_id,
        "apiFormat": entry.api_format_str(),
        "endpoint": value.get("endpoint").and_then(Value::as_str).unwrap_or(""),
        "modelId": value.get("model").and_then(Value::as_str).unwrap_or(""),
        "timeoutMs": value.get("timeoutMs").and_then(Value::as_u64),
        "maxOutputTokens": value.get("maxTokens").and_then(Value::as_u64),
        "contextWindow": value.get("contextWindow").and_then(Value::as_u64),
        "capabilities": {
            "toolReferences": value
                .get("supportsToolReferences")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "toolSearch": value
                .get("supportsToolSearch")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "secretId": migrate_secret_id(provider_id, value.get("secretId").and_then(Value::as_str)),
    });
    normalize_profile_draft(&draft)
}

/// 计算 legacy → current 的 secret 迁移映射（清理/迁移授权用）。
fn provider_secret_migration(
    value: &Map<String, Value>,
    profile: &ProviderProfileDoc,
) -> Option<ProfileSecretMigration> {
    let entry = find_profile(&profile.provider_id).ok()?;
    if entry.auth.kind == AuthKind::None
        || profile.secret_id.is_none()
        || entry.legacy_secret_id_prefixes.is_empty()
    {
        return None;
    }
    let stored_secret_id = match value.get("secretId") {
        Some(Value::String(value)) => value.as_str(),
        _ => entry.legacy_secret_id_prefixes[0],
    };
    let source = entry.legacy_secret_id_prefixes.iter().find(|base| {
        stored_secret_id == **base || stored_secret_id.starts_with(&format!("{base}."))
    })?;
    let suffix = &stored_secret_id[source.len()..];
    Some(ProfileSecretMigration {
        source_secret_id: format!("{source}{suffix}"),
        target_secret_id: profile.secret_id.clone()?,
    })
}

/// 解码已持久化的 Provider Profile 文档（v4/v3/v2/legacy），返回规范化 profile 与迁移元数据。
fn decode_profile_fields(
    value: &Map<String, Value>,
    version: u64,
) -> Result<ProviderProfileDoc, String> {
    const FIELDS: &[&str] = &[
        "schemaVersion",
        "profileId",
        "providerId",
        "apiFormat",
        "endpoint",
        "modelId",
        "modelName",
        "website",
        "timeoutMs",
        "maxOutputTokens",
        "contextWindow",
        "capabilities",
        "secretId",
    ];
    assert_exact_fields(value, FIELDS, &format!("Provider Profile v{version}"))?;
    let profile_id = value
        .get("profileId")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Provider Profile v{version} 字段格式无效"))?;
    let raw_provider_id = value
        .get("providerId")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Provider Profile v{version} 字段格式无效"))?;
    let api_format = value
        .get("apiFormat")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Provider Profile v{version} 字段格式无效"))?;
    let endpoint = value
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Provider Profile v{version} 字段格式无效"))?;
    let model_id = value
        .get("modelId")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Provider Profile v{version} 字段格式无效"))?;
    let model_name = match value.get("modelName") {
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(format!("Provider Profile v{version} 字段格式无效")),
        None => None,
    };
    let website = match value.get("website") {
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(format!("Provider Profile v{version} 字段格式无效")),
        None => None,
    };
    let secret_id = match value.get("secretId") {
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(format!("Provider Profile v{version} 字段格式无效")),
        None => None,
    };
    let (requested_tool_references, requested_tool_search) =
        parse_capabilities_strict(value.get("capabilities"))?;
    // 已移除的内置 minimax provider 向前兼容：providerId='minimax' 的 v2/v3
    // profile 统一降级为 generic-anthropic-compatible（endpoint/modelId 原样保留）。
    let provider_id = if raw_provider_id == "minimax" {
        "generic-anthropic-compatible"
    } else {
        raw_provider_id
    };
    if !is_provider_id(provider_id) {
        return Err("不支持的 Provider".into());
    }
    if provider_id == "demo" {
        if api_format != "demo" {
            return Err("Provider 身份与 API 格式不匹配".into());
        }
        let normalized = demo_profile_doc();
        if normalized.profile_id != profile_id
            || normalized.endpoint != endpoint
            || normalized.model_id != model_id
            || normalized.model_name.as_deref() != model_name.filter(|name| !name.is_empty())
            || normalized.website.as_deref() != website.filter(|site| !site.is_empty())
            || normalized.secret_id.is_some()
            || normalized.capabilities.tool_references != requested_tool_references
            || normalized.capabilities.tool_search != requested_tool_search
        {
            return Err(format!("Provider Profile v{version} 不是规范化数据"));
        }
        return Ok(normalized);
    }
    let entry = find_profile(provider_id)?;
    if api_format != entry.api_format_str() {
        return Err("Provider 身份与 API 格式不匹配".into());
    }
    let migrated_secret_id = if version == SECRET_MIGRATION_SCHEMA_VERSION {
        migrate_secret_id(provider_id, secret_id)
    } else {
        secret_id
            .or(entry.auth.default_secret_id)
            .map(str::to_string)
    };
    let timeout_ms = strict_integer(
        value.get("timeoutMs"),
        TIMEOUT_MIN_MS,
        TIMEOUT_MAX_MS,
        "Provider timeoutMs",
    )?;
    let max_output_tokens = strict_integer(
        value.get("maxOutputTokens"),
        MAX_OUTPUT_MIN,
        MAX_OUTPUT_MAX,
        "Provider maxOutputTokens",
    )?;
    let context_window = strict_integer(
        value.get("contextWindow"),
        CONTEXT_MIN,
        CONTEXT_MAX,
        "Provider contextWindow",
    )?;
    let draft = json!({
        "schemaVersion": PROVIDER_PROFILE_SCHEMA_VERSION,
        "profileId": profile_id,
        "providerId": provider_id,
        "apiFormat": entry.api_format_str(),
        "endpoint": endpoint,
        "modelId": model_id,
        "modelName": value.get("modelName"),
        "website": value.get("website"),
        "timeoutMs": timeout_ms,
        "maxOutputTokens": max_output_tokens,
        "contextWindow": context_window,
        "capabilities": {
            "toolReferences": requested_tool_references,
            "toolSearch": requested_tool_search,
        },
        "secretId": migrated_secret_id,
    });
    let normalized = normalize_profile_draft(&draft)?;
    if normalized.profile_id != profile_id
        || normalized.endpoint != endpoint
        || normalized.model_id != model_id
        || normalized.model_name.as_deref() != model_name.filter(|name| !name.is_empty())
        || normalized.website.as_deref() != website.filter(|site| !site.is_empty())
        || normalized.timeout_ms != timeout_ms
        || normalized.max_output_tokens != max_output_tokens
        || normalized.context_window != context_window
        || normalized.secret_id != migrated_secret_id
        || normalized.capabilities.tool_references != requested_tool_references
        || normalized.capabilities.tool_search != requested_tool_search
    {
        return Err(format!("Provider Profile v{version} 不是规范化数据"));
    }
    Ok(normalized)
}

fn decode_profile_document(raw: &Value) -> Result<DecodedProfileDoc, String> {
    let value = raw
        .as_object()
        .ok_or_else(|| "Provider Profile 格式无效".to_string())?;
    if value.get("schemaVersion").and_then(Value::as_u64) == Some(PROVIDER_PROFILE_SCHEMA_VERSION) {
        let profile = decode_profile_fields(value, PROVIDER_PROFILE_SCHEMA_VERSION)?;
        return Ok(DecodedProfileDoc {
            profile,
            requires_persistence_migration: false,
            secret_migration: None,
        });
    }
    if value.get("schemaVersion").and_then(Value::as_u64)
        == Some(PREVIOUS_PROVIDER_PROFILE_SCHEMA_VERSION)
    {
        // v3 起文档已持有当前 secret namespace：只需重写版本号，无 secret 迁移。
        let profile = decode_profile_fields(value, PREVIOUS_PROVIDER_PROFILE_SCHEMA_VERSION)?;
        return Ok(DecodedProfileDoc {
            profile,
            requires_persistence_migration: true,
            secret_migration: None,
        });
    }
    if value.get("schemaVersion").and_then(Value::as_u64) == Some(SECRET_MIGRATION_SCHEMA_VERSION) {
        let profile = decode_profile_fields(value, SECRET_MIGRATION_SCHEMA_VERSION)?;
        let secret_migration = provider_secret_migration(value, &profile);
        return Ok(DecodedProfileDoc {
            profile,
            requires_persistence_migration: true,
            secret_migration,
        });
    }
    if let Some(kind) = value.get("kind").and_then(Value::as_str) {
        if is_legacy_kind(kind) {
            let profile = migrate_legacy_provider_config(value)?;
            let secret_migration = provider_secret_migration(value, &profile);
            return Ok(DecodedProfileDoc {
                profile,
                requires_persistence_migration: true,
                secret_migration,
            });
        }
    }
    Err("Provider Profile 格式无效".into())
}

/// 该 provider 官方/可信模型服务 host（providers.json 每个 provider 的 `trustedHosts`
/// 生成，小写精确匹配；默认 endpoint host 由 `resolve_profile` 的 origin 匹配放行）。
///
/// 自定义端点 host 必须命中：内置默认同 origin、本地/私网地址，或**当前 provider 自己**
/// 的可信 host 表。受陷渲染进程不能把密钥发往任意公网 host，也不能把 Provider A 的
/// Secret 发往 Provider B 的官方域名——provider→origin 强绑定。
fn provider_trusted_hosts(provider_id: &str) -> &'static [&'static str] {
    PROVIDER_TRUSTED_HOSTS
        .iter()
        .find(|(id, _)| *id == provider_id)
        .map(|(_, hosts)| *hosts)
        .unwrap_or(&[])
}

/// 解析后的 Profile（供 model_http 构造请求）。
#[derive(Debug)]
pub(crate) struct ResolvedProfile {
    pub url: reqwest::Url,
    pub api_format: ModelApiFormat,
}

/// 按 provider（与可选 modelId）解析最终请求 URL 与允许的 origin。
///
/// - `endpoint_override` 为 `None` 时用该模型生效的端点（无模型 wire 时即内置默认）。
/// - 自定义 endpoint 必须命中以下任一才放行：
///   - 与该 provider 内置默认 endpoint 同 origin（官方 endpoint 的不同 path）
///   - 本地/私网地址（`is_allowed_plain_http_host`，覆盖 localhost mock 与自托管模型）
///   - 该 provider 自己的官方/可信模型服务 host（`provider_trusted_hosts`，providers.json
///     `trustedHosts` 生成）——按 provider 收窄，Provider A 的 Secret 不能发往 Provider B
///     的官方域名（provider→origin 强绑定）
///   - 标记 `allow_public_endpoints` 的 provider（自定义中转站）：任意公网 **https** origin。
///     明文 http 公网仍由 `validate_model_url` 拒绝；Key 只能来自该 provider 自己的独立
///     secret namespace（`is_secret_id_bound_to_provider` 请求期绑定校验，见 model_http.rs）
///
/// 其它自定义 origin 一律拒绝——受陷渲染进程无法把密钥发到任意公网 host。
///
/// **模型级 wire 与覆盖规则的交互**（多协议网关）：模型声明了 wire 时，override 只用来
/// 决定 host，协议 path 始终由该模型的 wire 决定——同 origin 的 override 视为「未换 host」
/// 直接取 wire 端点；异 origin 的 override 取「override 的 origin + wire 的 path」（自建
/// 镜像场景）。无 wire 的模型/ provider 完全沿用旧行为（override 原样生效），既有 provider
/// 的语义逐字不变。
pub(crate) fn resolve_profile(
    provider_id: &str,
    endpoint_override: Option<&str>,
    model_id: Option<&str>,
) -> Result<ResolvedProfile, String> {
    let entry = find_profile(provider_id)?;
    let (api_format, wire_endpoint) = entry.wire_for(model_id);
    let model_wire = entry
        .model_wires
        .iter()
        .find(|wire| Some(wire.model_id) == model_id);
    let override_value = endpoint_override.map(str::trim).filter(|value| !value.is_empty());
    let raw_endpoint = match (override_value, model_wire) {
        (None, _) => wire_endpoint.to_string(),
        (Some(override_endpoint), None) => override_endpoint.to_string(),
        (Some(override_endpoint), Some(wire)) => {
            let override_url = validate_model_url(override_endpoint)?;
            let default_origin =
                url_origin(&validate_model_url(entry.default_profile.endpoint)?);
            if url_origin(&override_url) == default_origin {
                // 同 origin：用户没换 host，协议 path 由该模型的 wire 说了算。
                wire_endpoint.to_string()
            } else {
                // 异 origin（自建镜像）：换 host、保留该模型形状的 path。
                let wire_url = validate_model_url(wire.endpoint)?;
                let mut mirrored = override_url;
                mirrored.set_path(wire_url.path());
                mirrored.set_query(wire_url.query());
                mirrored.to_string()
            }
        }
    };
    // Anthropic 格式需要 path 补全（与前端 anthropicMessagesEndpoint 等价）。
    let final_endpoint = match api_format {
        ModelApiFormat::AnthropicCompatible => resolve_anthropic_endpoint(&raw_endpoint)?,
        _ => raw_endpoint,
    };
    let url = validate_model_url(&final_endpoint)?;
    let origin = url_origin(&url);
    let default_origin = url_origin(&validate_model_url(entry.default_profile.endpoint)?);
    let allowed = origin == default_origin
        || url
            .host_str()
            .map(is_allowed_plain_http_host)
            .unwrap_or(false)
        || url
            .host_str()
            .map(|host| {
                provider_trusted_hosts(provider_id)
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(host))
            })
            .unwrap_or(false)
        || (entry.allow_public_endpoints && url.scheme() == "https");
    if !allowed {
        return Err(format!(
            "provider {provider_id} 的端点 {origin} 既非官方 origin 也非本地/私网地址，已拒绝"
        ));
    }
    Ok(ResolvedProfile { url, api_format })
}

/// Anthropic Messages API 的 path 补全。
///
/// 与前端 `anthropicMessagesEndpoint`（`AnthropicCompatibleTransport.ts`）逐字等价：
/// 剥末尾 `/`，已含 `/messages` 则保持，含 `/v1` 则补 `/messages`，否则补 `/v1/messages`。
fn resolve_anthropic_endpoint(raw_url: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(raw_url)
        .map_err(|error| format!("invalid anthropic endpoint: {error}"))?;
    let path = url.path().trim_end_matches('/').to_string();
    let resolved = if path.ends_with("/messages") {
        path
    } else if path.ends_with("/v1") {
        format!("{path}/messages")
    } else {
        format!("{path}/v1/messages")
    };
    url.set_path(&resolved);
    Ok(url.to_string())
}

#[tauri::command]
pub(crate) fn decode_provider_profile(raw: Value) -> Result<Value, String> {
    let decoded = decode_profile_document(&raw)?;
    serde_json::to_value(decoded)
        .map_err(|error| format!("failed to serialize provider profile: {error}"))
}

#[tauri::command]
pub(crate) fn normalize_provider_profile_draft(draft: Value) -> Result<Value, String> {
    let profile = normalize_profile_draft(&draft)?;
    serde_json::to_value(profile)
        .map_err(|error| format!("failed to serialize provider profile: {error}"))
}

#[tauri::command]
pub(crate) fn is_provider_secret_compatible(provider_id: String, secret_id: String) -> bool {
    is_secret_id_compatible_with_provider(&provider_id, &secret_id)
}

#[tauri::command]
pub(crate) fn is_legacy_provider_secret_compatible(provider_id: String, secret_id: String) -> bool {
    is_legacy_secret_id_compatible_with_provider(&provider_id, &secret_id)
}

#[tauri::command]
pub(crate) fn is_known_legacy_provider_secret(secret_id: String) -> bool {
    is_known_legacy_secret_id(&secret_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4_profile() -> Value {
        json!({
            "schemaVersion": 4,
            "profileId": "work.openai",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses",
            "modelId": "gpt-4.1",
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": false, "toolSearch": true },
            "secretId": "provider.openai-responses.api-key"
        })
    }

    #[test]
    fn decodes_normalized_v4_profile_without_migration() {
        let decoded = decode_profile_document(&v4_profile()).unwrap();
        assert!(!decoded.requires_persistence_migration);
        assert!(decoded.secret_migration.is_none());
        assert_eq!(decoded.profile.profile_id, "work.openai");
        assert_eq!(
            decoded.profile.secret_id.as_deref(),
            Some("provider.openai-responses.api-key")
        );
    }

    #[test]
    fn rejects_v4_profile_with_unknown_field() {
        let mut value = v4_profile();
        value
            .as_object_mut()
            .unwrap()
            .insert("surprise".into(), Value::Bool(true));
        let error = decode_profile_document(&value).unwrap_err();
        assert!(error.contains("未知字段"), "unexpected error: {error}");
    }

    #[test]
    fn decodes_v4_profile_with_model_name_and_website() {
        let mut value = v4_profile();
        {
            let object = value.as_object_mut().unwrap();
            object.insert("modelName".into(), Value::from("GPT-4.1 主力"));
            object.insert("website".into(), Value::from("https://openai.com"));
        }
        let decoded = decode_profile_document(&value).unwrap();
        assert_eq!(decoded.profile.model_name.as_deref(), Some("GPT-4.1 主力"));
        assert_eq!(decoded.profile.website.as_deref(), Some("https://openai.com"));
        assert!(!decoded.requires_persistence_migration);
    }

    #[test]
    fn decodes_previous_v3_profile_with_persistence_migration() {
        // v3 旧文档（无 website）：解码成功但需重写持久化；secret 已是当前
        // namespace，不产生 secret 迁移。
        let mut value = v4_profile();
        value
            .as_object_mut()
            .unwrap()
            .insert("schemaVersion".into(), Value::from(3));
        let decoded = decode_profile_document(&value).unwrap();
        assert!(decoded.requires_persistence_migration);
        assert!(decoded.secret_migration.is_none());
        assert_eq!(decoded.profile.website, None);
        assert_eq!(decoded.profile.schema_version, PROVIDER_PROFILE_SCHEMA_VERSION);
    }

    #[test]
    fn normalizes_model_name_with_trim_and_empty_omission() {
        let trimmed = normalize_profile_draft(&json!({
            "schemaVersion": 4,
            "profileId": "work.openai",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses",
            "modelId": "gpt-4.1",
            "modelName": "  GPT-4.1 主力  ",
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": false, "toolSearch": true },
            "secretId": "provider.openai-responses.api-key"
        }))
        .unwrap();
        assert_eq!(trimmed.model_name.as_deref(), Some("GPT-4.1 主力"));

        let empty = normalize_profile_draft(&json!({
            "schemaVersion": 4,
            "profileId": "work.openai",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses",
            "modelId": "gpt-4.1",
            "modelName": "   ",
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": false, "toolSearch": true },
            "secretId": "provider.openai-responses.api-key"
        }))
        .unwrap();
        assert_eq!(empty.model_name, None);
    }

    #[test]
    fn normalizes_website_with_trim_and_empty_omission() {
        let trimmed = normalize_profile_draft(&json!({
            "schemaVersion": 4,
            "profileId": "work.openai",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses",
            "modelId": "gpt-4.1",
            "website": "  https://openai.com  ",
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": false, "toolSearch": true },
            "secretId": "provider.openai-responses.api-key"
        }))
        .unwrap();
        assert_eq!(trimmed.website.as_deref(), Some("https://openai.com"));

        let empty = normalize_profile_draft(&json!({
            "schemaVersion": 4,
            "profileId": "work.openai",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses",
            "modelId": "gpt-4.1",
            "website": "   ",
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": false, "toolSearch": true },
            "secretId": "provider.openai-responses.api-key"
        }))
        .unwrap();
        assert_eq!(empty.website, None);
    }

    #[test]
    fn rejects_overlong_model_name() {
        let model_name = "x".repeat(MODEL_ID_MAX_BYTES + 1);
        let error = normalize_profile_draft(&json!({
            "schemaVersion": 4,
            "profileId": "work.openai",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses",
            "modelId": "gpt-4.1",
            "modelName": model_name,
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": false, "toolSearch": true },
            "secretId": "provider.openai-responses.api-key"
        }))
        .unwrap_err();
        assert!(error.contains("模型名称过长"), "unexpected error: {error}");
    }

    #[test]
    fn rejects_overlong_website() {
        let website = "x".repeat(MODEL_ID_MAX_BYTES + 1);
        let error = normalize_profile_draft(&json!({
            "schemaVersion": 4,
            "profileId": "work.openai",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses",
            "modelId": "gpt-4.1",
            "website": website,
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": false, "toolSearch": true },
            "secretId": "provider.openai-responses.api-key"
        }))
        .unwrap_err();
        assert!(error.contains("官网地址过长"), "unexpected error: {error}");
    }

    #[test]
    fn resolves_own_official_host_per_provider() {
        // 每个 provider 放行自己的官方域名（默认 origin，或 providers.json `trustedHosts`）。
        for (provider_id, endpoint) in [
            ("zhipu-glm", "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"),
            ("minimax-chat", "https://api.minimaxi.com/v1/chat/completions"),
            ("deepseek", "https://api.deepseek.com/chat/completions"),
            ("kimi", "https://api.moonshot.cn/v1/chat/completions"),
            ("kimi-coding", "https://api.kimi.com/coding/v1/messages"),
            ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"),
        ] {
            let resolved = resolve_profile(provider_id, Some(endpoint), None).unwrap();
            assert_eq!(
                resolved.url.host_str(),
                reqwest::Url::parse(endpoint).unwrap().host_str()
            );
        }
    }

    #[test]
    fn rejects_cross_provider_third_party_host() {
        // Provider A 的 Secret 不能被发往 Provider B 的官方域名（provider→origin 强绑定）。
        for (provider_id, foreign_endpoint) in [
            ("zhipu-glm", "https://api.minimaxi.com/v1/chat/completions"),
            ("minimax-chat", "https://api.deepseek.com/chat/completions"),
            ("deepseek", "https://api.moonshot.cn/v1/chat/completions"),
            ("generic-anthropic-compatible", "https://api.kimi.com/coding/v1/messages"),
        ] {
            let error = resolve_profile(provider_id, Some(foreign_endpoint), None).unwrap_err();
            assert!(
                error.contains("已拒绝"),
                "{provider_id} → {foreign_endpoint} 应被拒绝，unexpected error: {error}"
            );
        }
    }

    #[test]
    fn resolves_kimi_coding_default_endpoint() {
        // Kimi Coding Plan 走 Anthropic 兼容端点（api.kimi.com/coding），
        // 与开放平台（api.moonshot.cn）是两套独立体系：开放平台 Key 用于
        // coding 端点会得到 HTTP 401 Invalid Authentication。
        let resolved = resolve_profile("kimi-coding", None, None).unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://api.kimi.com/coding/v1/messages"
        );
        assert_eq!(resolved.api_format, ModelApiFormat::AnthropicCompatible);
    }

    #[test]
    fn rejects_unknown_public_model_endpoint() {
        let error = resolve_profile(
            "generic-anthropic-compatible",
            Some("https://attacker.example.com/v1/messages"),
            None,
        )
        .unwrap_err();
        assert!(error.contains("已拒绝"), "unexpected error: {error}");
    }

    #[test]
    fn custom_openai_compatible_allows_public_https_endpoint() {
        // 自定义（中转站）provider 放行任意公网 https origin（独立 secret namespace 兜底）。
        let resolved = resolve_profile(
            "custom-openai-compatible",
            Some("https://any-transit.example.com/v1/chat/completions"),
            None,
        )
        .unwrap();
        assert_eq!(resolved.url.host_str(), Some("any-transit.example.com"));
        assert_eq!(resolved.api_format, ModelApiFormat::OpenaiCompatible);
    }

    #[test]
    fn custom_anthropic_compatible_allows_public_https_endpoint_with_path_fill() {
        // Anthropic 兼容走 path 补全：base URL 补 /v1/messages。
        let resolved = resolve_profile(
            "custom-anthropic-compatible",
            Some("https://any-transit.example.com/v1"),
            None,
        )
        .unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://any-transit.example.com/v1/messages"
        );
        assert_eq!(resolved.api_format, ModelApiFormat::AnthropicCompatible);
    }

    #[test]
    fn custom_provider_still_rejects_public_plain_http() {
        // allow_public_endpoints 只放行 https；明文 http 公网仍被 validate_model_url 拒绝。
        let error = resolve_profile(
            "custom-openai-compatible",
            Some("http://any-transit.example.com/v1/chat/completions"),
            None,
        )
        .unwrap_err();
        assert!(error.contains("plain HTTP"), "unexpected error: {error}");
    }

    #[test]
    fn custom_provider_secret_namespace_is_isolated() {
        // 自定义 provider 的 Key 只能来自自己的 namespace，内置 provider 的 Key 不能复用；
        // 内置 provider 也不能用自定义 namespace 的 Key（跨 provider 组合 fail-closed）。
        assert!(is_secret_id_compatible_with_provider(
            "custom-openai-compatible",
            "provider.custom-openai-compatible.api-key"
        ));
        assert!(!is_secret_id_compatible_with_provider(
            "custom-openai-compatible",
            "provider.openai-compatible.api-key"
        ));
        assert!(!is_secret_id_compatible_with_provider(
            "openai",
            "provider.custom-openai-compatible.api-key"
        ));
        assert!(is_secret_id_compatible_with_provider(
            "custom-anthropic-compatible",
            "provider.custom-anthropic-compatible.api-key"
        ));
        assert!(!is_secret_id_bound_to_provider(
            "custom-anthropic-compatible",
            "provider.anthropic-compatible.api-key"
        ));
        assert!(is_secret_id_bound_to_provider(
            "custom-anthropic-compatible",
            "provider.custom-anthropic-compatible.api-key.suffix"
        ));
    }

    #[test]
    fn rejects_non_normalized_v4_profile() {
        let mut value = v4_profile();
        // 越界 maxOutputTokens 在 v4 文档中必须 fail-closed（strict 校验）。
        // 用常量 + 1 而非旧魔数：范围由契约生成，写死字面量会在上限变更时静默失效
        // （64000 → 512000 时 99_999 变为合法值，用例曾因此失去意义）。
        value
            .as_object_mut()
            .unwrap()
            .insert("maxOutputTokens".into(), Value::from(MAX_OUTPUT_MAX + 1));
        let error = decode_profile_document(&value).unwrap_err();
        assert!(error.contains("无效"), "unexpected error: {error}");
    }

    #[test]
    fn decodes_v2_profile_with_secret_migration() {
        let value = json!({
            "schemaVersion": 2,
            "profileId": "legacy.anthropic",
            "providerId": "generic-anthropic-compatible",
            "apiFormat": "anthropic-compatible",
            "endpoint": "https://api.anthropic.com/v1/messages",
            "modelId": "claude-3-5-sonnet",
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": true, "toolSearch": false },
            "secretId": "provider.anthropic-compatible.api-key"
        });
        let decoded = decode_profile_document(&value).unwrap();
        assert!(decoded.requires_persistence_migration);
        assert_eq!(
            decoded.profile.secret_id.as_deref(),
            Some("provider.generic-anthropic-compatible.api-key")
        );
        let migration = decoded.secret_migration.unwrap();
        assert_eq!(
            migration.source_secret_id,
            "provider.anthropic-compatible.api-key"
        );
        assert_eq!(
            migration.target_secret_id,
            "provider.generic-anthropic-compatible.api-key"
        );
    }

    #[test]
    fn downgrades_minimax_v2_profile_to_anthropic_compatible() {
        // minimax 曾以内置 provider 持久化（旧 schema v2），统一降级为
        // generic-anthropic-compatible，secretId 走 legacy 迁移。
        let value = json!({
            "schemaVersion": 2,
            "profileId": "legacy.minimax",
            "providerId": "minimax",
            "apiFormat": "anthropic-compatible",
            "endpoint": "https://api.minimax.example/v1/messages",
            "modelId": "abab6.5",
            "timeoutMs": 60_000,
            "maxOutputTokens": 4_096,
            "contextWindow": 128_000,
            "capabilities": { "toolReferences": true, "toolSearch": false },
            "secretId": "provider.minimax.api-key"
        });
        let decoded = decode_profile_document(&value).unwrap();
        assert_eq!(decoded.profile.provider_id, "generic-anthropic-compatible");
        assert_eq!(
            decoded.profile.endpoint,
            "https://api.minimax.example/v1/messages"
        );
        assert_eq!(
            decoded.profile.secret_id.as_deref(),
            Some("provider.generic-anthropic-compatible.api-key")
        );
        assert_eq!(
            decoded.secret_migration.unwrap().source_secret_id,
            "provider.minimax.api-key"
        );
    }

    #[test]
    fn migrates_legacy_kind_config() {
        let value = json!({
            "kind": "openai-compatible",
            "endpoint": "https://api.example.com/v1/chat/completions",
            "model": "custom-model",
            "timeoutMs": 30_000,
            "maxTokens": 8_192,
            "contextWindow": 256_000,
            "supportsToolReferences": false,
            "supportsToolSearch": true
        });
        let decoded = decode_profile_document(&value).unwrap();
        assert!(decoded.requires_persistence_migration);
        assert_eq!(decoded.profile.provider_id, "generic-openai-compatible");
        assert_eq!(decoded.profile.model_id, "custom-model");
        assert_eq!(decoded.profile.max_output_tokens, 8_192);
        assert_eq!(decoded.profile.context_window, 256_000);
        assert!(!decoded.profile.capabilities.tool_search);
    }

    #[test]
    fn legacy_anthropic_kind_maps_to_generic_anthropic_compatible() {
        let value = json!({
            "kind": "anthropic-compatible",
            "endpoint": "https://open.bigmodel.cn/api/anthropic",
            "model": "glm-4.5",
            "timeoutMs": 60_000,
            "maxTokens": 4_096,
            "contextWindow": 128_000
        });
        let decoded = decode_profile_document(&value).unwrap();
        assert_eq!(decoded.profile.provider_id, "generic-anthropic-compatible");
        assert_eq!(
            decoded.profile.endpoint,
            "https://open.bigmodel.cn/api/anthropic"
        );
        // 无 secretId 时回落默认 current 前缀。
        assert_eq!(
            decoded.profile.secret_id.as_deref(),
            Some("provider.generic-anthropic-compatible.api-key")
        );
    }

    #[test]
    fn normalizes_draft_with_clamped_bounds_and_default_secret() {
        let draft = json!({
            "schemaVersion": 4,
            "profileId": "draft.profile",
            "providerId": "generic-anthropic-compatible",
            "apiFormat": "anthropic-compatible",
            "endpoint": "https://api.anthropic.com/v1/messages",
            "modelId": "claude-sonnet-4-5",
            "timeoutMs": 999,
            "maxOutputTokens": 1_000_000,
            "contextWindow": 100,
            "capabilities": { "toolReferences": true, "toolSearch": false }
        });
        let profile = normalize_profile_draft(&draft).unwrap();
        assert_eq!(profile.timeout_ms, TIMEOUT_MIN_MS);
        assert_eq!(profile.max_output_tokens, MAX_OUTPUT_MAX);
        assert_eq!(profile.context_window, CONTEXT_MIN);
        // 能力受描述符约束：anthropic-compatible 支持 toolReferences。
        assert!(profile.capabilities.tool_references);
        assert_eq!(
            profile.secret_id.as_deref(),
            Some("provider.generic-anthropic-compatible.api-key")
        );
    }

    #[test]
    fn rejects_draft_without_model_id() {
        let mut draft = json!({
            "schemaVersion": 4,
            "profileId": "draft.profile",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://api.openai.com/v1/responses"
        });
        let error = normalize_profile_draft(&draft).unwrap_err();
        assert!(error.contains("模型 ID"), "unexpected error: {error}");
        draft
            .as_object_mut()
            .unwrap()
            .insert("modelId".into(), Value::String(String::new()));
        assert!(normalize_profile_draft(&draft).is_err());
    }

    #[test]
    fn rejects_credentials_inside_endpoint() {
        let draft = json!({
            "schemaVersion": 4,
            "profileId": "draft.profile",
            "providerId": "openai",
            "apiFormat": "openai-responses",
            "endpoint": "https://user:pass@api.openai.com/v1/responses",
            "modelId": "gpt-4.1"
        });
        let error = normalize_profile_draft(&draft).unwrap_err();
        assert!(error.contains("用户名或密码"), "unexpected error: {error}");
    }

    #[test]
    fn demo_draft_always_normalizes_to_builtin_demo() {
        let draft = json!({
            "schemaVersion": 4,
            "profileId": "whatever",
            "providerId": "demo",
            "apiFormat": "demo",
            "endpoint": "https://ignored.example.com",
            "modelId": "ignored"
        });
        let profile = normalize_profile_draft(&draft).unwrap();
        assert_eq!(profile.profile_id, "builtin.demo");
        assert_eq!(profile.model_id, "demo-v1");
        assert_eq!(profile.endpoint, "");
        assert!(profile.secret_id.is_none());
    }

    #[test]
    fn secret_helpers_enforce_provider_namespaces() {
        assert!(is_secret_id_compatible_with_provider(
            "openai",
            "provider.openai-responses.api-key"
        ));
        assert!(is_secret_id_compatible_with_provider(
            "openai",
            "provider.openai-responses.api-key.team-a"
        ));
        assert!(!is_secret_id_compatible_with_provider(
            "openai",
            "provider.openai-compatible.api-key"
        ));
        assert!(is_legacy_secret_id_compatible_with_provider(
            "generic-anthropic-compatible",
            "provider.minimax.api-key"
        ));
        assert!(!is_legacy_secret_id_compatible_with_provider(
            "openai",
            "provider.anthropic-compatible.api-key"
        ));
        assert!(is_known_legacy_secret_id(
            "provider.anthropic-compatible.api-key"
        ));
        assert!(!is_known_legacy_secret_id(
            "provider.openai-responses.api-key"
        ));
    }

    #[test]
    fn secret_binding_rejects_cross_provider_combination() {
        // current 与归属 provider 的 legacy 均可被绑定使用
        assert!(is_secret_id_bound_to_provider(
            "openai",
            "provider.openai-responses.api-key"
        ));
        assert!(is_secret_id_bound_to_provider(
            "openai",
            "provider.openai-responses.api-key.team-a"
        ));
        assert!(is_secret_id_bound_to_provider(
            "generic-anthropic-compatible",
            "provider.minimax.api-key"
        ));
        // 跨 Provider 组合一律拒绝
        assert!(!is_secret_id_bound_to_provider(
            "openai",
            "provider.openai-compatible.api-key"
        ));
        assert!(!is_secret_id_bound_to_provider(
            "generic-openai-compatible",
            "provider.openai-responses.api-key"
        ));
        assert!(!is_secret_id_bound_to_provider(
            "minimax-chat",
            "provider.minimax.api-key"
        ));
        assert!(!is_secret_id_bound_to_provider(
            "openai",
            "provider.anthropic-compatible.api-key"
        ));
        // 未注册命名空间与未知 provider 一律拒绝
        assert!(!is_secret_id_bound_to_provider(
            "openai",
            "provider.evil.api-key"
        ));
        assert!(!is_secret_id_bound_to_provider(
            "unknown",
            "provider.openai-responses.api-key"
        ));
    }

    #[test]
    fn normalize_secret_id_rejects_mismatched_provider() {
        assert_eq!(
            normalize_secret_id("openai", None).unwrap().as_deref(),
            Some("provider.openai-responses.api-key")
        );
        let error =
            normalize_secret_id("openai", Some("provider.openai-compatible.api-key")).unwrap_err();
        assert!(error.contains("身份不匹配"), "unexpected error: {error}");
    }

    #[test]
    fn migrate_secret_id_preserves_suffix() {
        assert_eq!(
            migrate_secret_id(
                "generic-anthropic-compatible",
                Some("provider.minimax.api-key.team-a"),
            )
            .unwrap(),
            "provider.generic-anthropic-compatible.api-key.team-a"
        );
    }

    #[test]
    fn secret_prefix_lists_match_the_builtin_table() {
        let mut current: Vec<&str> = BUILTIN_PROVIDER_PROFILES
            .iter()
            .filter_map(|entry| entry.auth.default_secret_id)
            .collect();
        current.sort();
        current.dedup();
        let mut current_const = CURRENT_PROVIDER_SECRET_PREFIXES.to_vec();
        current_const.sort();
        assert_eq!(current, current_const);
        let mut legacy: Vec<&str> = BUILTIN_PROVIDER_PROFILES
            .iter()
            .flat_map(|entry| entry.legacy_secret_id_prefixes.iter().copied())
            .collect();
        legacy.sort();
        legacy.dedup();
        let mut legacy_const = LEGACY_PROVIDER_SECRET_PREFIXES.to_vec();
        legacy_const.sort();
        assert_eq!(legacy, legacy_const);
    }

    #[test]
    fn resolves_model_wire_for_multi_protocol_provider() {
        // OpenCode Go：一个订阅三种协议，按模型分发（同一 origin、不同 path）。
        let chat = resolve_profile("opencode-go", None, Some("glm-5.3")).unwrap();
        assert_eq!(
            chat.url.as_str(),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        assert_eq!(chat.api_format, ModelApiFormat::OpenaiCompatible);

        let messages = resolve_profile("opencode-go", None, Some("minimax-m3")).unwrap();
        assert_eq!(messages.url.as_str(), "https://opencode.ai/zen/go/v1/messages");
        assert_eq!(messages.api_format, ModelApiFormat::AnthropicCompatible);

        let responses = resolve_profile("opencode-go", None, Some("grok-4.6")).unwrap();
        assert_eq!(
            responses.url.as_str(),
            "https://opencode.ai/zen/go/v1/responses"
        );
        assert_eq!(responses.api_format, ModelApiFormat::OpenaiResponses);
    }

    #[test]
    fn falls_back_to_provider_default_for_unknown_or_missing_model() {
        // 目录外自定义 modelId 与「未传 modelId」都按 provider 主协议发送。
        for model_id in [None, Some("some-unknown-model")] {
            let resolved = resolve_profile("opencode-go", None, model_id).unwrap();
            assert_eq!(
                resolved.url.as_str(),
                "https://opencode.ai/zen/go/v1/chat/completions"
            );
            assert_eq!(resolved.api_format, ModelApiFormat::OpenaiCompatible);
        }
        // 单协议 provider 不受影响。
        let resolved = resolve_profile("openai", None, Some("gpt-4.1")).unwrap();
        assert_eq!(resolved.url.as_str(), "https://api.openai.com/v1/responses");
    }

    #[test]
    fn model_wire_keeps_its_protocol_path_under_same_origin_override() {
        // 同 origin 的 endpoint 覆盖：用户没换 host，协议 path 由模型 wire 决定
        // （否则会把 messages 请求打到 chat 路径上）。
        let resolved = resolve_profile(
            "opencode-go",
            Some("https://opencode.ai/zen/go/v1/chat/completions"),
            Some("minimax-m3"),
        )
        .unwrap();
        assert_eq!(resolved.url.as_str(), "https://opencode.ai/zen/go/v1/messages");
        assert_eq!(resolved.api_format, ModelApiFormat::AnthropicCompatible);
    }

    #[test]
    fn model_wire_mirrors_its_path_onto_a_foreign_override_origin() {
        // 自建镜像（本地/私网放行）：换 host、保留该模型形状的 path。
        let resolved = resolve_profile(
            "opencode-go",
            Some("http://127.0.0.1:8080/zen/go/v1/chat/completions"),
            Some("grok-4.6"),
        )
        .unwrap();
        assert_eq!(resolved.url.as_str(), "http://127.0.0.1:8080/zen/go/v1/responses");
        assert_eq!(resolved.api_format, ModelApiFormat::OpenaiResponses);
    }

    #[test]
    fn model_wire_does_not_relax_the_endpoint_allow_list() {
        // wire 只覆盖 path，不放宽 origin：攻击者域名仍然被拒（密钥不外发）。
        let error = resolve_profile(
            "opencode-go",
            Some("https://attacker.example.com/zen/go/v1/chat/completions"),
            Some("minimax-m3"),
        )
        .unwrap_err();
        assert!(error.contains("已拒绝"), "unexpected error: {error}");
    }

    #[test]
    fn provider_without_wires_keeps_the_legacy_override_semantics() {
        // 回归：无 wire 的 provider，同 origin 的任意 path 覆盖仍原样生效
        // （模型级 path 规则只作用于声明了 wire 的模型）。
        let resolved = resolve_profile(
            "generic-openai-compatible",
            Some("https://api.openai.com/v1/other-path"),
            Some("anything"),
        )
        .unwrap();
        assert_eq!(resolved.url.as_str(), "https://api.openai.com/v1/other-path");
    }

    #[test]
    fn resolves_builtin_openai_compatible_default_endpoint() {
        let resolved = resolve_profile("generic-openai-compatible", None, None).unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(resolved.api_format, ModelApiFormat::OpenaiCompatible);
    }

    #[test]
    fn resolves_builtin_openai_responses_default_endpoint() {
        let resolved = resolve_profile("openai", None, None).unwrap();
        assert_eq!(resolved.url.as_str(), "https://api.openai.com/v1/responses");
        assert_eq!(resolved.api_format, ModelApiFormat::OpenaiResponses);
    }

    #[test]
    fn resolves_builtin_anthropic_default_endpoint() {
        let resolved = resolve_profile("generic-anthropic-compatible", None, None).unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(resolved.api_format, ModelApiFormat::AnthropicCompatible);
    }

    #[test]
    fn allows_custom_path_on_official_origin() {
        // 同 origin（api.anthropic.com）不同 path 放行。
        let resolved = resolve_profile(
            "generic-anthropic-compatible",
            Some("https://api.anthropic.com/v2/messages"),
            None,
        )
        .unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://api.anthropic.com/v2/messages"
        );
    }

    #[test]
    fn rejects_custom_public_origin() {
        let error = resolve_profile(
            "generic-anthropic-compatible",
            Some("https://attacker.example.com/v1/messages"),
            None,
        )
        .unwrap_err();
        assert!(error.contains("已拒绝"), "unexpected error: {error}");
    }

    #[test]
    fn allows_localhost_override_for_self_hosted_models() {
        let resolved = resolve_profile(
            "generic-openai-compatible",
            Some("http://127.0.0.1:11434/v1/chat/completions"),
            None,
        )
        .unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
    }

    #[test]
    fn allows_localhost_host_for_anthropic_compatible() {
        let resolved = resolve_profile(
            "generic-anthropic-compatible",
            Some("http://localhost:8080/anthropic"),
            None,
        )
        .unwrap();
        // path 补全：/anthropic → /anthropic/v1/messages
        assert_eq!(
            resolved.url.as_str(),
            "http://localhost:8080/anthropic/v1/messages"
        );
    }

    #[test]
    fn anthropic_path_completion_preserves_messages_suffix() {
        let resolved = resolve_profile(
            "generic-anthropic-compatible",
            Some("https://api.anthropic.com/v1/messages"),
            None,
        )
        .unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn anthropic_path_completion_appends_messages_to_v1() {
        let resolved = resolve_profile(
            "generic-anthropic-compatible",
            Some("https://api.anthropic.com/v1"),
            None,
        )
        .unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn anthropic_path_completion_appends_v1_messages_to_bare_endpoint() {
        let resolved = resolve_profile(
            "generic-anthropic-compatible",
            Some("https://api.anthropic.com"),
            None,
        )
        .unwrap();
        assert_eq!(
            resolved.url.as_str(),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn rejects_unknown_provider_id() {
        let error = resolve_profile("minimax", None, None).unwrap_err();
        assert!(
            error.contains("unknown provider id"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_empty_endpoint_override_falls_back_to_default() {
        // 空字符串覆盖等同不覆盖。
        let resolved = resolve_profile("openai", Some("  "), None).unwrap();
        assert_eq!(resolved.url.as_str(), "https://api.openai.com/v1/responses");
    }

    /// 与 TS `providerParity.test.ts` 共享同一份黄金夹具
    /// （`contracts/provider-parity-fixtures.json`），锁死双实现漂移。
    #[test]
    fn parity_fixtures_match_the_reference_contract() {
        let raw = include_str!("../../contracts/provider-parity-fixtures.json");
        let fixtures: Value =
            serde_json::from_str(raw).expect("parity fixtures must be valid JSON");
        let fixtures = fixtures["fixtures"]
            .as_array()
            .expect("fixtures must be an array");
        for fixture in fixtures {
            let name = fixture["name"].as_str().expect("fixture name");
            let input = fixture["input"].clone();
            let expected = fixture["expected"].as_object().expect("fixture expected");
            if expected.get("expectError").and_then(Value::as_bool) == Some(true) {
                assert!(
                    decode_profile_document(&input).is_err(),
                    "fixture {name} 应当解析失败"
                );
                continue;
            }
            let decoded = decode_profile_document(&input)
                .unwrap_or_else(|error| panic!("fixture {name} 解析失败: {error}"));
            let actual = serde_json::to_value(&decoded).expect("serialize decoded profile");
            let actual_profile = actual["profile"]
                .as_object()
                .expect("decoded profile object");
            let expected_profile = expected["profile"]
                .as_object()
                .expect("expected profile object");
            for (key, value) in expected_profile {
                assert_eq!(
                    actual_profile.get(key),
                    Some(value),
                    "fixture {name} profile.{key} 与黄金夹具不一致"
                );
            }
            assert_eq!(
                actual["requiresPersistenceMigration"], expected["requiresPersistenceMigration"],
                "fixture {name} requiresPersistenceMigration"
            );
            assert_eq!(
                actual["secretMigration"], expected["secretMigration"],
                "fixture {name} secretMigration"
            );
        }
    }
}
