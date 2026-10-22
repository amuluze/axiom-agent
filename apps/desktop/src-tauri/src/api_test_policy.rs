use regex::Regex;
use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;

use reqwest::Url;

use crate::network_policy::is_private_or_local_ip;

const MAX_API_URL_BYTES: usize = 4096;
pub(crate) const MAX_API_REDIRECTS: usize = 5;

pub(crate) fn contains_plaintext_credential(value: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r#"(?:^|[\s"'=:])(?:Bearer|Basic)\s|(?:^|[\s"'=:])(?:sk-|sk_live_|ghp_|gho_|xoxb-|AKIA|AIza)"#)
                .expect("compile-time API credential prefix pattern")
        })
        .is_match(value)
}

pub(crate) fn parse_api_url(raw: &str) -> Result<Url, String> {
    if raw.is_empty() || raw.len() > MAX_API_URL_BYTES {
        return Err("API 测试 URL 长度无效".to_string());
    }
    let url = Url::parse(raw).map_err(|_| "API 测试 URL 无法解析".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("API 测试仅支持 HTTP(S) URL".to_string());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("API 测试 URL 必须包含主机且不能内嵌凭据".to_string());
    }
    if url.fragment().is_some() {
        return Err("API 测试 URL 不能包含 fragment".to_string());
    }
    Ok(url)
}

pub(crate) fn validate_resolved_api_addresses(
    url: &Url,
    addresses: &[IpAddr],
    allow_private_network: bool,
) -> Result<(), String> {
    if addresses.is_empty() {
        return Err("API 测试目标 DNS 未返回地址".to_string());
    }
    let has_private = addresses.iter().copied().any(is_private_or_local_ip);
    let has_public = addresses
        .iter()
        .copied()
        .any(|ip| !is_private_or_local_ip(ip));
    if has_private && !allow_private_network {
        return Err("API 测试环境未授权访问回环或私网地址".to_string());
    }
    if url.scheme() == "http" && has_public {
        return Err("公网 API 测试禁止使用明文 HTTP".to_string());
    }
    Ok(())
}

pub(crate) async fn resolve_api_target(
    url: &Url,
    allow_private_network: bool,
) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "API 测试 URL 缺少主机".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "API 测试 URL 缺少端口".to_string())?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "API 测试目标 DNS 解析失败".to_string())?
        .collect::<Vec<_>>();
    let ips = addresses
        .iter()
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    validate_resolved_api_addresses(url, &ips, allow_private_network)?;
    Ok(addresses)
}

pub(crate) fn same_api_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && left.port_or_known_default() == right.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_public_https_and_rejects_credentials_or_fragments() {
        assert!(parse_api_url("https://api.example.com/v1/orders").is_ok());
        assert!(parse_api_url("ftp://api.example.com/file").is_err());
        assert!(parse_api_url("https://user:pass@example.com/v1").is_err());
        assert!(parse_api_url("https://example.com/v1#secret").is_err());
    }

    #[test]
    fn recognizes_explicit_plaintext_credential_prefixes() {
        assert!(contains_plaintext_credential("Bearer secret"));
        assert!(contains_plaintext_credential("token=ghp_123"));
        assert!(contains_plaintext_credential("x: AKIA123"));
        assert!(!contains_plaintext_credential("release-sk-channel"));
    }

    #[test]
    fn enforces_public_http_and_private_environment_authorization() {
        let public_https = parse_api_url("https://example.com/v1").unwrap();
        let public_http = parse_api_url("http://example.com/v1").unwrap();
        let private_http = parse_api_url("http://localhost:8080/v1").unwrap();
        let public = ["93.184.216.34".parse().unwrap()];
        let private = ["127.0.0.1".parse().unwrap()];
        assert!(validate_resolved_api_addresses(&public_https, &public, false).is_ok());
        assert!(validate_resolved_api_addresses(&public_http, &public, true).is_err());
        assert!(validate_resolved_api_addresses(&private_http, &private, false).is_err());
        assert!(validate_resolved_api_addresses(&private_http, &private, true).is_ok());
    }

    #[test]
    fn mixed_dns_answers_require_private_authorization_and_http_stays_blocked() {
        let https = parse_api_url("https://mixed.example/v1").unwrap();
        let http = parse_api_url("http://mixed.example/v1").unwrap();
        let mixed = [
            "10.0.0.2".parse().unwrap(),
            "93.184.216.34".parse().unwrap(),
        ];
        assert!(validate_resolved_api_addresses(&https, &mixed, false).is_err());
        assert!(validate_resolved_api_addresses(&https, &mixed, true).is_ok());
        assert!(validate_resolved_api_addresses(&http, &mixed, true).is_err());
    }

    #[test]
    fn same_origin_normalizes_case_and_default_ports() {
        let first = parse_api_url("https://EXAMPLE.com/v1").unwrap();
        let same = parse_api_url("https://example.com:443/v2").unwrap();
        let different = parse_api_url("https://example.com:8443/v2").unwrap();
        assert!(same_api_origin(&first, &same));
        assert!(!same_api_origin(&first, &different));
    }
}
