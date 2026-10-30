use regex::Regex;
use serde_json::Value;
use std::{collections::BTreeMap, sync::OnceLock};

type CredentialPatterns = Vec<(&'static str, Regex)>;

const PATTERNS: &[(&str, &str)] = &[
    (
        "私钥",
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\r\n\t ]+[A-Za-z0-9+/=]{32,}",
    ),
    (
        "供应商或代码托管令牌",
        r"\b(?:sk-(?:proj-|ant-api[0-9]{2}-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b",
    ),
];

/// 名字显式声明「非生产凭据」的作用域前缀（env 变量风格，大小写不敏感）。
///
/// 名称作用域豁免只作用于「按名字判定」这一层：令牌形态（sk-/ghp_/私钥块）与
/// 当前 Provider 密钥的精确匹配仍然命中——真实凭据不会被放过。依据是这些前缀
/// 本身就是内容作者的声明（该值属测试/示例夹具），不是扫描器的猜测。
const NON_CREDENTIAL_NAME_SCOPES: &[&str] = &[
    "E2E_", "TEST_", "TESTING_", "CI_", "DEMO_", "EXAMPLE_", "FAKE_", "MOCK_", "SAMPLE_",
    "FIXTURE_", "STUB_",
];

/// 值里显式标注「假值」的词段：按分隔符切段后**整段**匹配，避免 contest 命中
/// test 一类的子串误伤。真实凭据极少整段等于这些词（`correct-horse-battery-staple`
/// 这类真口令不含这些词段，仍按凭据拦截）。
const NON_CREDENTIAL_VALUE_SEGMENTS: &[&str] = &[
    "e2e",
    "fake",
    "mock",
    "sample",
    "example",
    "dummy",
    "changeme",
    "placeholder",
    "notreal",
    "foobar",
    "demo",
];

fn patterns() -> Result<&'static CredentialPatterns, String> {
    static COMPILED: OnceLock<Result<CredentialPatterns, String>> = OnceLock::new();
    COMPILED
        .get_or_init(|| {
            PATTERNS
                .iter()
                .map(|(kind, pattern)| {
                    Regex::new(pattern)
                        .map(|regex| (*kind, regex))
                        .map_err(|_| "凭据扫描规则不可用，已阻止模型请求".to_string())
                })
                .collect()
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 名称是否落在测试/示例作用域（如 `E2E_AUTH_SECRET`、`TEST_PASSWORD`）。
fn non_credential_scope(name: &str) -> bool {
    let upper = name.trim().to_ascii_uppercase();
    NON_CREDENTIAL_NAME_SCOPES
        .iter()
        .any(|scope| upper.starts_with(scope))
}

/// 值是否含显式标注假值的词段（整段匹配）。
fn placeholder_value_segment(value: &str) -> bool {
    value
        .split(['-', '_', '.', '/', ':', '+', '@'])
        .any(|segment| {
            NON_CREDENTIAL_VALUE_SEGMENTS.contains(&segment.to_ascii_lowercase().as_str())
        })
}

fn credential_field(name: &str) -> bool {
    let normalized: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    // 公钥标识（publicKey / publicKeyToken / publicKeyId）不是秘密：公钥本就公开，
    // 真正的私钥另由「私钥块」形态规则与 privatekey 字段名覆盖。
    if normalized.contains("publickey") {
        return false;
    }
    // 名字已声明非生产作用域（E2E_/TEST_/CI_…）：该值属测试/示例夹具，
    // 不按凭据字段判定（曾把 e2e/.env.example 的示例值当成真实凭据，阻断整轮请求）。
    if non_credential_scope(name) {
        return false;
    }
    [
        "apikey",
        "accesstoken",
        "accesskey",
        "authtoken",
        "password",
        "secret",
        "secretkey",
        "privatekey",
        "token",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn credential_value(value: &str) -> bool {
    let value = value.trim().trim_matches(['\'', '"']);
    if value.len() < 16 || value.chars().any(char::is_whitespace) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if [
        "$",
        "<",
        "your_",
        "your-",
        "example",
        "placeholder",
        "[redacted]",
        "changeme",
        "dummy",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
    {
        return false;
    }
    // 值整段等于显式假值词（e2e/fake/mock/…）：夹具值不是凭据。
    if placeholder_value_segment(&lower) {
        return false;
    }
    value
        .chars()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        >= 8
}

fn scan_text(
    text: &str,
    secret: Option<&str>,
    findings: &mut BTreeMap<&'static str, usize>,
) -> Result<(), String> {
    for (kind, pattern) in patterns()? {
        let count = pattern.find_iter(text).count();
        if count > 0 {
            *findings.entry(kind).or_default() += count;
        }
    }
    if secret.is_some_and(|secret| secret.len() >= 8 && text.contains(secret)) {
        *findings.entry("当前 Provider 密钥").or_default() += 1;
    }
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((name, value)) = line.split_once('=') {
            if name
                .trim()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                && credential_field(name.trim())
                && credential_value(value)
            {
                *findings.entry("凭据赋值").or_default() += 1;
            }
        }
    }
    Ok(())
}

fn scan_value(
    value: &Value,
    secret: Option<&str>,
    findings: &mut BTreeMap<&'static str, usize>,
) -> Result<(), String> {
    match value {
        Value::String(text) => scan_text(text, secret, findings)?,
        Value::Array(items) => {
            for item in items {
                scan_value(item, secret, findings)?;
            }
        }
        Value::Object(fields) => {
            for (name, value) in fields {
                scan_text(name, secret, findings)?;
                if credential_field(name) && value.as_str().is_some_and(credential_value) {
                    *findings.entry("凭据字段").or_default() += 1;
                }
                scan_value(value, secret, findings)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_model_egress(body: &str, secret: Option<&str>) -> Result<(), String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "模型请求正文不是有效 JSON，已阻止发送".to_string())?;
    let mut findings = BTreeMap::new();
    scan_value(&value, secret, &mut findings)?;
    if findings.is_empty() {
        return Ok(());
    }
    let summary = findings
        .into_iter()
        .map(|(kind, count)| format!("{kind} {count} 处"))
        .collect::<Vec<_>>()
        .join("、");
    Err(format!(
        "模型请求已阻止：检测到{summary}。请移除凭据或改用占位值；请求未发送。"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_decoded_nested_payloads_and_never_echoes_secrets() {
        let token = format!("ghp_{}", "aB1234567890".repeat(3));
        for body in [
            serde_json::json!({"messages": [{"role": "tool", "content": token}]}),
            serde_json::json!({token.clone(): "value"}),
            serde_json::json!({"input": [{"content": [{"text": token}]}]}),
            serde_json::json!({"messages": [{"content": format!("<conversation>{token}</conversation>")}]}),
        ] {
            let error = validate_model_egress(&body.to_string(), None).unwrap_err();
            assert!(error.contains("请求未发送"));
            assert!(!error.contains(&token));
        }
        let escaped = format!(r#"{{"text":"\u0067hp_{}"}}"#, "Ab1234567890".repeat(3));
        assert!(validate_model_egress(&escaped, None).is_err());
    }

    #[test]
    fn rejects_private_keys_env_assignments_and_structured_credentials() {
        for text in [
            format!(
                "-----BEGIN OPENSSH PRIVATE KEY-----\n{}",
                "aBcD1234".repeat(10)
            ),
            "export DATABASE_PASSWORD='aLongProductionPassword123'".into(),
            "OPENAI_API_KEY=anotherLongSecretValue456".into(),
            "SESSION_TOKEN=anotherLongSecretValue456".into(),
        ] {
            assert!(
                validate_model_egress(&serde_json::json!({"text": text}).to_string(), None)
                    .is_err()
            );
        }
        assert!(validate_model_egress(
            r#"{"content":{"api_key":"anotherLongSecretValue456"}}"#,
            None
        )
        .is_err());
        assert!(validate_model_egress(
            r#"{"text":"known-provider-secret"}"#,
            Some("known-provider-secret")
        )
        .is_err());
    }

    #[test]
    fn accepts_code_placeholders_and_secret_ids() {
        for text in [
            "API_KEY=${OPENAI_API_KEY}",
            "password=your_password_placeholder",
            "const apiKey = process.env.API_KEY",
            "-----BEGIN PRIVATE KEY-----\n<private-key>",
            "secretId=provider.openai-compatible.api-key",
            "# PASSWORD=documentation_example_only",
        ] {
            assert!(
                validate_model_egress(&serde_json::json!({"text": text}).to_string(), None).is_ok(),
                "{text}"
            );
        }
        assert!(validate_model_egress("{}", None).is_ok());
        assert!(validate_model_egress("not json", None).is_err());
    }

    #[test]
    fn accepts_test_scope_fixtures_and_still_blocks_real_credentials() {
        // 回归：会话读入 e2e/.env.example（测试夹具示例值）后，4 处 E2E_* 赋值
        // 被判成高置信「凭据赋值」，整轮模型请求被阻止——会话被永久卡死。
        let fixture = "\
# Quoin e2e 本地测试环境配置示例
E2E_AUTH_SECRET=quoin-manager-e2e-auth-secret-key
E2E_QUOIN_DETECTOR_SECRET=quoin-manager-e2e-shared-secret
E2E_ADMIN_PASSWORD=e2e-admin-pass-123
E2E_STAFF_PASSWORD=E2e-staff-pass-123";
        assert!(
            validate_model_egress(&serde_json::json!({"text": fixture}).to_string(), None).is_ok(),
            "E2E 夹具示例值不应触发凭据拦截"
        );
        // 夹具作用域只豁免「按名字判定」这一层：真实凭据形态仍必须拦截。
        let provider_token = format!("sk-ant-{}", "aB1234567890".repeat(3));
        assert!(validate_model_egress(
            &serde_json::json!({"text": format!("E2E_API_KEY={provider_token}")}).to_string(),
            None
        )
        .is_err());
        // 当前 Provider 密钥落在夹具作用域里也照拦（精确匹配优先于作用域豁免）。
        assert!(validate_model_egress(
            &serde_json::json!({"text": "E2E_AUTH_SECRET=known-provider-secret"}).to_string(),
            Some("known-provider-secret")
        )
        .is_err());
        // 生产作用域的真实凭据不受影响。
        for text in [
            "DATABASE_PASSWORD=correct-horse-battery-staple",
            "API_KEY=contest-secret-value-2024",
            "PROD_AUTH_SECRET=8f3c1d9a7b5e2f4c6a0d",
        ] {
            assert!(
                validate_model_egress(&serde_json::json!({"text": text}).to_string(), None)
                    .is_err(),
                "{text}"
            );
        }
        // 值整段等于显式假值词：夹具值不按凭据判定（名字非测试作用域时同样成立）。
        assert!(validate_model_egress(
            &serde_json::json!({"text": "QUOIN_ADMIN_PASSWORD=quoin-e2e-admin-pass"}).to_string(),
            None
        )
        .is_ok());
        // 公钥标识不是秘密（微软程序集 publicKeyToken）。
        assert!(validate_model_egress(
            &serde_json::json!({"text": "publicKeyToken=\"6595b64144ccf1df\""}).to_string(),
            None
        )
        .is_ok());
    }
}
