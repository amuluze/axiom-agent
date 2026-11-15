//! 环境级 Secret 登录配方（环境档 v4 `secretRefresh`）。
//!
//! 目标：会话型 Secret（Cookie/CSRF 等）由 Axiom 自动刷新，而不是让用户从浏览器
//! 复制粘贴。配方是环境档里可评审的结构事实（请求序列 + 响应 Cookie 捕获），执行权
//! 在 Rust：
//! - 配方只打环境 `API_BASE_URL` 同源地址（相对路径），沿用 API 测试的私网/明文/TLS
//!   策略；
//! - Secret 引用只从宿主 `secrets` 表解析，捕获值直接写回 `secrets`，明文**不回传
//!   WebView**；
//! - 执行前弹宿主原生内容确认（目标、步骤数、Secret ID），macOS 另需原生手势；
//! - 步骤之间共享的 Cookie Jar 只活在一次刷新命令内，不跨运行、不落盘。
//!
//! 触发点：测试批次开跑前自动执行；环境弹窗也提供手动「刷新 Secret」按钮。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, SET_COOKIE};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::api_test_policy::{parse_api_url, resolve_api_target, same_api_origin};
use crate::secrets::{load_api_test_secret, store_api_test_secret, SecretState};
use crate::test_repository::{
    load_test_environment_access, load_test_environment_refresh, TestEnvironmentAccess,
};
use crate::user_gesture::{
    current_operating_system, require_user_confirmation, ContentConfirm, UserGestureState,
};
use crate::workspace_access::{authorized_root, WorkspaceAccessState};
use crate::SessionRepositoryState;

const MAX_REFRESH_STEPS: usize = 8;
const MAX_REFRESH_HEADERS: usize = 32;
const MAX_REFRESH_CAPTURES: usize = 16;
const MAX_REFRESH_PATH_BYTES: usize = 1024;
const MAX_REFRESH_JSON_BYTES: usize = 64 * 1024;
const MAX_REFRESH_BODY_DEPTH: usize = 16;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
const SECRET_ID_PREFIX: &str = "apitest.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretRefreshRecipe {
    steps: Vec<SecretRefreshStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretRefreshStep {
    method: String,
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, RefreshHeaderValue>,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    expect_status: Option<Vec<u16>>,
    #[serde(default)]
    capture: Vec<SecretRefreshCapture>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RefreshHeaderValue {
    Plain(String),
    Secret {
        #[serde(rename = "secretId")]
        secret_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretRefreshCapture {
    secret_id: String,
    cookie: String,
    #[serde(default)]
    format: Option<String>,
}

/// 返回给 WebView 的刷新结果：只有 Secret ID 与时间，没有值。
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretRefreshResult {
    pub(crate) secret_ids: Vec<String>,
    pub(crate) updated_at: i64,
}

struct ParsedRefresh {
    recipe: SecretRefreshRecipe,
    referenced_ids: BTreeSet<String>,
    capture_ids: BTreeSet<String>,
}

fn validate_secret_id(id: &str) -> Result<(), String> {
    let valid = id.starts_with(SECRET_ID_PREFIX)
        && id.len() > SECRET_ID_PREFIX.len()
        && id.len() <= 256
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    if valid {
        Ok(())
    } else {
        Err(format!("Secret ID 无效：{id}"))
    }
}

fn valid_cookie_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '!' | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '*'
                        | '+'
                        | '-'
                        | '.'
                        | '^'
                        | '_'
                        | '`'
                        | '|'
                        | '~'
                )
        })
}

fn infer_refs(value: &Value, ids: &mut BTreeSet<String>, depth: usize) -> Result<(), String> {
    if depth > MAX_REFRESH_BODY_DEPTH {
        return Err("登录配方请求体嵌套过深".to_string());
    }
    match value {
        Value::Object(record) => {
            if record.len() == 1 {
                if let Some(Value::String(secret_id)) = record.get("secretId") {
                    validate_secret_id(secret_id)?;
                    ids.insert(secret_id.clone());
                    return Ok(());
                }
            }
            for child in record.values() {
                infer_refs(child, ids, depth + 1)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                infer_refs(item, ids, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn parse_recipe(
    source: &str,
    authorized: &BTreeSet<String>,
    api_base_url: Option<&str>,
) -> Result<ParsedRefresh, String> {
    if source.len() > MAX_REFRESH_JSON_BYTES {
        return Err("登录配方超过大小上限".to_string());
    }
    let base = api_base_url.ok_or_else(|| "登录配方需要环境 API Base URL".to_string())?;
    parse_api_url(base)?;
    let recipe: SecretRefreshRecipe =
        serde_json::from_str(source).map_err(|_| "登录配方不是合法的声明式 JSON".to_string())?;
    if recipe.steps.is_empty() || recipe.steps.len() > MAX_REFRESH_STEPS {
        return Err(format!("登录配方步骤数必须在 1–{MAX_REFRESH_STEPS} 之间"));
    }
    let mut referenced_ids = BTreeSet::new();
    let mut capture_ids = BTreeSet::new();
    for (index, step) in recipe.steps.iter().enumerate() {
        let label = format!("登录配方第 {} 步", index + 1);
        if !matches!(
            step.method.as_str(),
            "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
        ) {
            return Err(format!("{label}的 method 无效"));
        }
        if !step.path.starts_with('/')
            || step.path.starts_with("//")
            || step.path.len() > MAX_REFRESH_PATH_BYTES
            || step.path.contains("://")
            || step.path.contains('\\')
            || step.path.chars().any(char::is_whitespace)
        {
            return Err(format!("{label}的 path 必须是以 / 开头的相对路径"));
        }
        if step.headers.len() > MAX_REFRESH_HEADERS {
            return Err(format!("{label}的请求头数量超过上限"));
        }
        for (name, value) in &step.headers {
            if !name.is_ascii() || name.is_empty() || name.len() > 128 {
                return Err(format!("{label}的请求头名称无效"));
            }
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| format!("{label}的请求头名称无效"))?;
            let lowered = name.to_ascii_lowercase();
            // Cookie 由步骤间 Cookie Jar 统一维护；手写 Cookie 头会让会话状态分叉。
            if matches!(lowered.as_str(), "cookie" | "set-cookie") {
                return Err(format!(
                    "{label}的 Cookie 由配方自动携带，不要在请求头里手写"
                ));
            }
            match value {
                RefreshHeaderValue::Plain(text) => {
                    if matches!(
                        lowered.as_str(),
                        "authorization" | "proxy-authorization" | "x-api-key"
                    ) {
                        return Err(format!("{label}的敏感请求头必须使用 Secret 引用"));
                    }
                    if crate::api_test_policy::contains_plaintext_credential(text) {
                        return Err(format!("{label}的请求头包含疑似明文凭据"));
                    }
                }
                RefreshHeaderValue::Secret { secret_id } => {
                    validate_secret_id(secret_id)?;
                    referenced_ids.insert(secret_id.clone());
                }
            }
        }
        if let Some(body) = &step.body {
            infer_refs(body, &mut referenced_ids, 0)?;
        }
        if let Some(statuses) = &step.expect_status {
            if statuses.is_empty() || statuses.len() > 16 {
                return Err(format!("{label}的 expectStatus 数量无效"));
            }
            if statuses.iter().any(|status| !(100..=599).contains(status)) {
                return Err(format!("{label}的 expectStatus 必须在 100–599 之间"));
            }
        }
        if step.capture.len() > MAX_REFRESH_CAPTURES {
            return Err(format!("{label}的捕获项超过上限"));
        }
        for capture in &step.capture {
            validate_secret_id(&capture.secret_id)?;
            if !valid_cookie_name(&capture.cookie) {
                return Err(format!("{label}的 Cookie 名无效"));
            }
            match capture.format.as_deref() {
                None | Some("value") | Some("cookieHeader") => {}
                Some(_) => return Err(format!("{label}的捕获格式只允许 value 或 cookieHeader")),
            }
            capture_ids.insert(capture.secret_id.clone());
        }
    }
    for id in referenced_ids.iter().chain(capture_ids.iter()) {
        if !authorized.contains(id) {
            return Err(format!("登录配方引用的 «{id}» 未被当前环境授权"));
        }
    }
    Ok(ParsedRefresh {
        recipe,
        referenced_ids,
        capture_ids,
    })
}

/// 保存环境记录时的纯校验入口（不执行网络请求）。
pub(crate) fn validate_secret_refresh(
    source: &str,
    authorized: &BTreeSet<String>,
    api_base_url: Option<&str>,
) -> Result<(), String> {
    parse_recipe(source, authorized, api_base_url).map(|_| ())
}

fn capture_value(
    cookie: &str,
    format: Option<&str>,
    jar: &BTreeMap<String, String>,
) -> Result<String, String> {
    let value = jar
        .get(cookie)
        .ok_or_else(|| format!("刷新响应没有下发 Cookie «{cookie}»"))?;
    Ok(match format {
        Some("cookieHeader") => format!("{cookie}={value}"),
        _ => value.clone(),
    })
}

fn replace_refs(
    value: &Value,
    resolve: &mut impl FnMut(&str) -> Result<String, String>,
    depth: usize,
) -> Result<Value, String> {
    if depth > MAX_REFRESH_BODY_DEPTH {
        return Err("登录配方请求体嵌套过深".to_string());
    }
    match value {
        Value::Object(record) => {
            if record.len() == 1 {
                if let Some(Value::String(secret_id)) = record.get("secretId") {
                    return Ok(Value::String(resolve(secret_id)?));
                }
            }
            let mut output = serde_json::Map::new();
            for (key, child) in record {
                output.insert(key.clone(), replace_refs(child, resolve, depth + 1)?);
            }
            Ok(Value::Object(output))
        }
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| replace_refs(item, resolve, depth + 1))
                .collect::<Result<Vec<_>, _>>()?,
        )),
        _ => Ok(value.clone()),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn confirmation_message(environment_name: &str, base: &str, parsed: &ParsedRefresh) -> String {
    let ids = parsed
        .referenced_ids
        .iter()
        .chain(parsed.capture_ids.iter())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "即将执行测试环境「{}」的登录配方并写入 Secret：\n\n目标：{}\n步骤：{}\nSecret：{}\n\n刷新会覆盖这些 Secret 的当前值。确认执行？",
        environment_name,
        base,
        parsed.recipe.steps.len(),
        ids
    )
}

async fn execute_recipe(
    parsed: &ParsedRefresh,
    access: &TestEnvironmentAccess,
    secrets: &SecretState,
) -> Result<BTreeMap<String, String>, String> {
    let base_source = access
        .api_base_url
        .as_deref()
        .ok_or_else(|| "登录配方需要环境 API Base URL".to_string())?;
    let base = parse_api_url(base_source)?;
    let allowed_origins = std::iter::once(base.clone())
        .chain(
            access
                .secret_origins
                .iter()
                .filter_map(|origin| parse_api_url(origin).ok()),
        )
        .collect::<Vec<_>>();
    let mut jar: BTreeMap<String, String> = BTreeMap::new();
    let mut captured: BTreeMap<String, String> = BTreeMap::new();

    for (index, step) in parsed.recipe.steps.iter().enumerate() {
        let url = base
            .join(&step.path)
            .map_err(|_| format!("登录配方第 {} 步的 path 无法解析", index + 1))?;
        if !allowed_origins
            .iter()
            .any(|origin| same_api_origin(origin, &url))
        {
            return Err(format!("登录配方第 {} 步越过环境允许的 origin", index + 1));
        }
        let method = Method::from_bytes(step.method.as_bytes())
            .map_err(|_| format!("登录配方第 {} 步的 method 无效", index + 1))?;
        let mut headers = HeaderMap::new();
        for (name, value) in &access.headers {
            insert_header(&mut headers, name, value)?;
        }
        for (name, value) in &step.headers {
            let resolved = match value {
                RefreshHeaderValue::Plain(text) => text.clone(),
                RefreshHeaderValue::Secret { secret_id } => captured
                    .get(secret_id)
                    .cloned()
                    .or_else(|| load_api_test_secret(secrets, secret_id).ok().flatten())
                    .ok_or_else(|| "登录配方引用的 Secret 尚未保存".to_string())?,
            };
            insert_header(&mut headers, name, &resolved)?;
        }
        if !jar.is_empty() && !headers.contains_key(reqwest::header::COOKIE) {
            let cookie = jar
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; ");
            insert_header(&mut headers, "cookie", &cookie)?;
        }
        let body = match &step.body {
            Some(body) => {
                let replaced = replace_refs(
                    body,
                    &mut |secret_id| {
                        captured
                            .get(secret_id)
                            .cloned()
                            .or_else(|| load_api_test_secret(secrets, secret_id).ok().flatten())
                            .ok_or_else(|| "登录配方引用的 Secret 尚未保存".to_string())
                    },
                    0,
                )?;
                if !headers.contains_key(CONTENT_TYPE) {
                    insert_header(&mut headers, "content-type", "application/json")?;
                }
                Some(
                    serde_json::to_string(&replaced)
                        .map_err(|_| "登录配方请求体无法序列化".to_string())?,
                )
            }
            None => None,
        };

        let host = url
            .host_str()
            .ok_or_else(|| "登录配方目标缺少主机".to_string())?;
        let addresses = resolve_api_target(&url, access.allow_private_network).await?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(REFRESH_TIMEOUT)
            .resolve_to_addrs(host, &addresses)
            .danger_accept_invalid_certs(access.tls_trust == "insecure")
            .build()
            .map_err(|_| "无法创建登录配方的 HTTP Client".to_string())?;
        let mut request = client.request(method, url).headers(headers);
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|error| {
            let _ = error;
            format!("登录配方第 {} 步请求失败", index + 1)
        })?;
        let status = response.status().as_u16();
        let expected = step.expect_status.as_ref();
        let status_ok = match expected {
            Some(statuses) => statuses.contains(&status),
            None => (200..=299).contains(&status),
        };
        if !status_ok {
            let hint = if matches!(status, 401 | 403) {
                "；检查该步引用的账号/口令 Secret 是否仍是当前值"
            } else {
                ""
            };
            return Err(format!(
                "登录配方第 {} 步返回 HTTP {status}{hint}",
                index + 1
            ));
        }
        for value in response.headers().get_all(SET_COOKIE) {
            let Ok(raw) = value.to_str() else { continue };
            let pair = raw.split(';').next().unwrap_or_default().trim();
            if let Some((name, cookie_value)) = pair.split_once('=') {
                let name = name.trim();
                if valid_cookie_name(name) {
                    jar.insert(name.to_string(), cookie_value.trim().to_string());
                }
            }
        }
        for capture in &step.capture {
            captured.insert(
                capture.secret_id.clone(),
                capture_value(&capture.cookie, capture.format.as_deref(), &jar)?,
            );
        }
    }
    Ok(captured)
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), String> {
    let name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| "登录配方请求头名称无效".to_string())?;
    let value = HeaderValue::from_str(value).map_err(|_| "登录配方请求头值无效".to_string())?;
    headers.insert(name, value);
    Ok(())
}

/// 执行环境声明的登录配方；`None` 表示用户在原生确认框里取消。
#[tauri::command]
pub(crate) async fn refresh_test_environment_secrets(
    app: AppHandle,
    repository: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    secrets: State<'_, SecretState>,
    gesture: State<'_, Arc<UserGestureState>>,
    environment_id: String,
) -> Result<Option<SecretRefreshResult>, String> {
    let root = authorized_root(&workspace)?;
    let root = root.to_string_lossy().into_owned();
    let (meta, access) = {
        let mut connection = repository.acquire().await?;
        let meta = load_test_environment_refresh(&mut connection, &root, &environment_id)
            .await?
            .ok_or_else(|| "测试环境不存在或不属于当前工作区".to_string())?;
        let access =
            load_test_environment_access(&mut connection, &root, Some(&environment_id)).await?;
        (meta, access)
    };
    let source = meta
        .secret_refresh_json
        .as_deref()
        .ok_or_else(|| "该环境没有登录配方".to_string())?;
    let parsed = parse_recipe(source, &access.secret_ids, access.api_base_url.as_deref())?;
    let base = access.api_base_url.clone().unwrap_or_default();
    let confirmed = require_user_confirmation(
        &app,
        gesture.inner().as_ref(),
        current_operating_system(),
        Some(ContentConfirm {
            title: "确认刷新测试环境 Secret",
            message: confirmation_message(&meta.name, &base, &parsed),
            confirm_label: "刷新",
        }),
        ContentConfirm {
            title: "确认刷新测试环境 Secret",
            message: "即将执行登录配方并覆盖环境 Secret。确认执行？".to_string(),
            confirm_label: "刷新",
        },
    )
    .await?;
    if !confirmed {
        return Ok(None);
    }
    let captured = execute_recipe(&parsed, &access, &secrets).await?;
    let secret_ids = captured.keys().cloned().collect::<Vec<_>>();
    for (secret_id, value) in &captured {
        store_api_test_secret(&secrets, secret_id, value)?;
    }
    Ok(Some(SecretRefreshResult {
        secret_ids,
        updated_at: now_ms(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authorized(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    const BASE: &str = "https://127.0.0.1:18443";

    #[test]
    fn accepts_the_beacon_login_recipe_and_collects_refs() {
        let source = r#"{
          "steps": [
            {
              "method": "GET",
              "path": "/api/v1/auth/csrf",
              "capture": [{ "secretId": "apitest.beacon-csrf", "cookie": "beacon_csrf_token" }]
            },
            {
              "method": "POST",
              "path": "/api/v1/auth/login",
              "headers": { "X-CSRF-Token": { "secretId": "apitest.beacon-csrf" } },
              "body": {
                "username": { "secretId": "apitest.beacon-user" },
                "password": { "secretId": "apitest.beacon-pass" }
              },
              "capture": [{
                "secretId": "apitest.beacon-session",
                "cookie": "beacon_access_token",
                "format": "cookieHeader"
              }]
            }
          ]
        }"#;
        let parsed = parse_recipe(
            source,
            &authorized(&[
                "apitest.beacon-csrf",
                "apitest.beacon-user",
                "apitest.beacon-pass",
                "apitest.beacon-session",
            ]),
            Some(BASE),
        )
        .expect("recipe");
        assert_eq!(parsed.recipe.steps.len(), 2);
        assert!(parsed.referenced_ids.contains("apitest.beacon-user"));
        assert!(parsed.capture_ids.contains("apitest.beacon-session"));
    }

    #[test]
    fn rejects_unauthorized_refs_and_plaintext_sensitive_headers() {
        let unauthorized = r#"{"steps":[{"method":"GET","path":"/x","headers":{"Cookie":"a=b"},"capture":[{"secretId":"apitest.s","cookie":"sid"}]}]}"#;
        assert!(parse_recipe(unauthorized, &authorized(&["apitest.s"]), Some(BASE)).is_err());
        let missing = r#"{"steps":[{"method":"GET","path":"/x","capture":[{"secretId":"apitest.s","cookie":"sid"}]}]}"#;
        assert!(parse_recipe(missing, &authorized(&[]), Some(BASE)).is_err());
        assert!(parse_recipe(missing, &authorized(&["apitest.s"]), None).is_err());
    }

    #[test]
    fn captures_raw_and_cookie_header_forms() {
        let mut jar = BTreeMap::new();
        jar.insert("sid".to_string(), "v".to_string());
        assert_eq!(capture_value("sid", None, &jar).unwrap(), "v");
        assert_eq!(capture_value("sid", Some("value"), &jar).unwrap(), "v");
        assert_eq!(
            capture_value("sid", Some("cookieHeader"), &jar).unwrap(),
            "sid=v"
        );
        assert!(capture_value("missing", None, &jar).is_err());
    }

    #[test]
    fn replace_refs_walks_nested_json() {
        let body: Value = serde_json::from_str(
            r#"{"user":{"secretId":"apitest.u"},"items":[{"secretId":"apitest.p"}],"n":1}"#,
        )
        .unwrap();
        let replaced = replace_refs(&body, &mut |id| Ok(format!("<{id}>")), 0).unwrap();
        assert_eq!(
            replaced,
            serde_json::json!({"user":"<apitest.u>","items":["<apitest.p>"],"n":1})
        );
    }

    #[tokio::test]
    async fn executes_a_beacon_style_flow_with_a_transient_cookie_jar() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for response in [
                "HTTP/1.1 204 No Content\r\nSet-Cookie: beacon_csrf_token=csrf-value; Path=/; HttpOnly\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nSet-Cookie: beacon_access_token=session-value; Path=/; HttpOnly\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0_u8; 4096];
                let _ = socket.read(&mut buffer).await.unwrap();
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let source = r#"{
          "steps": [
            {
              "method": "GET",
              "path": "/api/v1/auth/csrf",
              "capture": [{ "secretId": "apitest.csrf", "cookie": "beacon_csrf_token" }]
            },
            {
              "method": "POST",
              "path": "/api/v1/auth/login",
              "headers": { "X-CSRF-Token": { "secretId": "apitest.csrf" } },
              "capture": [{
                "secretId": "apitest.session",
                "cookie": "beacon_access_token",
                "format": "cookieHeader"
              }]
            }
          ]
        }"#;
        let parsed = parse_recipe(
            source,
            &authorized(&["apitest.csrf", "apitest.session"]),
            Some(&format!("http://{address}")),
        )
        .expect("recipe");
        let access = TestEnvironmentAccess {
            allow_private_network: true,
            headers: BTreeMap::new(),
            secret_ids: authorized(&["apitest.csrf", "apitest.session"]),
            api_base_url: Some(format!("http://{address}")),
            secret_origins: BTreeSet::new(),
            tls_trust: "system".to_string(),
            approval_mode: "per_step".to_string(),
            web_base_url: None,
        };
        let captured = execute_recipe(&parsed, &access, &SecretState::default())
            .await
            .expect("refresh");
        assert_eq!(
            captured.get("apitest.csrf").map(String::as_str),
            Some("csrf-value")
        );
        assert_eq!(
            captured.get("apitest.session").map(String::as_str),
            Some("beacon_access_token=session-value")
        );
        server.await.unwrap();
    }
}
