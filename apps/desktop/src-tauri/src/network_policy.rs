use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

fn is_private_or_local_ipv4(ip: Ipv4Addr) -> bool {
    // unspecified（0.0.0.0）也按本地处理：BSD/macOS 上 connect 到 0.0.0.0
    // 等价连接回环，放行即等同放行 localhost。
    ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
}

/// 折算 IPv6 地址中嵌入的 IPv4 地址。双栈 socket 会把 IPv4-mapped
/// （::ffff:a.b.c.d）映射回 IPv4 连接，NAT64 well-known 前缀（64:ff9b::/96）
/// 经网关转回 v4，::/96 是已弃用的 IPv4-compatible——漏判任意一种都等于
/// 放行对应的私网/回环 IPv4 目标（如 ::ffff:169.254.169.254 直连云元数据端点）。
fn embedded_ipv4_address(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return Some(mapped);
    }
    let segments = ip.segments();
    let is_nat64 = segments[0] == 0x0064
        && segments[1] == 0xff9b
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0;
    let is_ipv4_compatible = segments[0] == 0 && segments[1] == 0 && segments[2] == 0;
    if is_nat64 || is_ipv4_compatible {
        // 嵌入的 IPv4 位于最后 32 位（segments[6]/[7]）。
        return Some(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        ));
    }
    None
}

fn is_private_or_local_ipv6(ip: Ipv6Addr) -> bool {
    // ::1 必须先于嵌入折算判定（::1 折算出 0.0.0.1 不具私网语义）。
    if ip.is_loopback() {
        return true;
    }
    if let Some(embedded) = embedded_ipv4_address(ip) {
        return is_private_or_local_ipv4(embedded);
    }
    let first_segment = ip.segments()[0];
    (first_segment & 0xfe00) == 0xfc00 || (first_segment & 0xffc0) == 0xfe80
}

/// web 工具（web_access.rs）复用同一私网/回环判定：无人值守只读通道
/// 与模型端点共享「非公网地址」的单一语义来源。
pub(crate) fn is_private_or_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_or_local_ipv4(ip),
        IpAddr::V6(ip) => is_private_or_local_ipv6(ip),
    }
}

pub(crate) fn is_allowed_plain_http_host(host: &str) -> bool {
    let normalized = host
        .trim_matches(|character| character == '[' || character == ']')
        .to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
    {
        return true;
    }
    normalized
        .parse::<IpAddr>()
        .map(is_private_or_local_ip)
        .unwrap_or(false)
}

pub(crate) fn validate_model_url(raw_url: &str) -> Result<reqwest::Url, String> {
    if raw_url.len() > 4096 {
        return Err("model URL is too long".into());
    }
    let url = reqwest::Url::parse(raw_url).map_err(|error| error.to_string())?;
    validate_parsed_model_url(&url)?;
    Ok(url)
}

fn validate_parsed_model_url(url: &reqwest::Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials are not allowed in model URLs".into());
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" => {
            let host = url
                .host_str()
                .ok_or_else(|| "model URL host is missing".to_string())?;
            if is_allowed_plain_http_host(host) {
                Ok(())
            } else {
                Err("plain HTTP is only allowed for local or private model hosts".into())
            }
        }
        _ => Err("only HTTP and HTTPS model URLs are allowed".into()),
    }
}

fn effective_port(url: &reqwest::Url) -> Option<u16> {
    url.port_or_known_default()
}

/// 规范化 origin（`scheme://host:port`）。host 小写、端口用已知默认值补全，
/// 用于 provider_profiles 的端点一致性校验（官方 origin 或本地/私网放行）。
pub(crate) fn url_origin(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let port = effective_port(url)
        .map(|port| port.to_string())
        .unwrap_or_default();
    format!("{}://{}:{}", url.scheme(), host, port)
}

fn same_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && effective_port(left) == effective_port(right)
}

pub(crate) fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many model endpoint redirects");
        }
        let Some(initial_url) = attempt.previous().first() else {
            return attempt.error("redirect origin is missing");
        };
        if !same_origin(initial_url, attempt.url()) {
            return attempt.error("cross-origin model endpoint redirects are blocked");
        }
        if let Err(error) = validate_parsed_model_url(attempt.url()) {
            return attempt.error(error);
        }
        attempt.follow()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_https_and_local_plain_http() {
        assert!(validate_model_url("https://api.example.com/v1/chat").is_ok());
        assert!(validate_model_url("http://localhost:11434/v1/chat").is_ok());
        assert!(validate_model_url("http://127.0.0.1:11434/v1/chat").is_ok());
        assert!(validate_model_url("http://192.168.1.20:8080/v1/chat").is_ok());
        assert!(validate_model_url("http://model-server.local/v1/chat").is_ok());
    }

    #[test]
    fn rejects_public_plain_http_credentials_and_other_schemes() {
        assert!(validate_model_url("http://api.example.com/v1/chat").is_err());
        assert!(validate_model_url("https://user:pass@example.com/v1/chat").is_err());
        assert!(validate_model_url("file:///tmp/model").is_err());
    }

    #[test]
    fn treats_embedded_ipv4_addresses_as_their_ipv4_equivalent() {
        // IPv4-mapped / NAT64 / IPv4-compatible：双栈 socket 或 NAT64 网关会折算回
        // IPv4 连接，漏判任意一种即放行对应的私网/回环目标（含云元数据端点）。
        for literal in [
            "::ffff:169.254.169.254",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "::ffff:192.168.1.10",
            "64:ff9b::a00:1",
            "::10.0.0.1",
        ] {
            let ip: IpAddr = literal.parse().unwrap();
            assert!(is_private_or_local_ip(ip), "{literal} must be private or local");
        }
        // unspecified：BSD/macOS 上 connect 到 0.0.0.0 等价连接回环。
        assert!(is_private_or_local_ip("0.0.0.0".parse().unwrap()));
        assert!(is_private_or_local_ip("::".parse().unwrap()));
        // 公网地址的映射/嵌入形式保持公网语义，不得误伤。
        for literal in ["::ffff:8.8.8.8", "64:ff9b::808:808", "2001:db8::1", "8.8.8.8"] {
            let ip: IpAddr = literal.parse().unwrap();
            assert!(!is_private_or_local_ip(ip), "{literal} must stay public");
        }
    }

    #[test]
    fn maps_embedded_ipv6_literal_endpoints_to_local_semantics() {
        // 明文 HTTP 模型端点仅允许本地/私网——映射形式折算后与 v4 字面量同语义。
        assert!(validate_model_url("http://[::ffff:127.0.0.1]:11434/v1/chat").is_ok());
        assert!(validate_model_url("http://[::ffff:192.168.1.20]:8080/v1/chat").is_ok());
        // 嵌入公网地址仍是公网：明文 HTTP 拒绝。
        assert!(validate_model_url("http://[::ffff:8.8.8.8]/v1/chat").is_err());
    }

    #[test]
    fn compares_origins_including_effective_ports() {
        let first = reqwest::Url::parse("https://example.com/v1/chat").unwrap();
        let same = reqwest::Url::parse("https://EXAMPLE.com/v2/chat").unwrap();
        let different_port = reqwest::Url::parse("https://example.com:8443/v1/chat").unwrap();
        let different_scheme = reqwest::Url::parse("http://example.com/v1/chat").unwrap();
        assert!(same_origin(&first, &same));
        assert!(!same_origin(&first, &different_port));
        assert!(!same_origin(&first, &different_scheme));
    }
}
