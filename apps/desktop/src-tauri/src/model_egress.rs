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

fn credential_field(name: &str) -> bool {
    let normalized: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
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
}
