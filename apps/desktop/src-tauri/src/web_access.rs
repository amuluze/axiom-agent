//! web 只读访问命令：`web_search`（DuckDuckGo HTML 端点）与 `web_fetch`（URL → 文本）。
//!
//! 与 bash 网络档的边界差异：这两个命令是**无人值守的只读通道**（不消费审批
//! 租赁、无原生对话框），因此必须比「沙箱内 + 网络启用」的 bash 更保守：
//! - 仅接受 http/https、URL 不得携带 userinfo；
//! - 目标主机必须是公网地址：字面量私有/回环/链路本地/unspecified IP 直接拒绝，
//!   域名经 DNS 解析后逐一校验全部解析结果（封内网服务与云元数据端点探测）；
//!   重定向逐跳做同样字面量校验，响应完成后再对终点 URL 复核 DNS；
//! - 下载体积与输出长度双上限，HTML 统一转纯文本（标签与实体解码）后交付，
//!   防止把任意网页原样塞进模型上下文。
//!
//! HTML 解析手写不引第三方 crate：搜索结果结构与「HTML → 文本」的保真度要求
//! 都很低，避免为一次性能力引入依赖（牵动依赖审计与 SBOM）。

use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;
use std::net::IpAddr;

use crate::network_policy::{is_allowed_plain_http_host, is_private_or_local_ip};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::Url;

const WEB_USER_AGENT: &str = "Axiom/0.1 (macOS desktop agent)";
const DUCKDUCKGO_HTML_ENDPOINT: &str = "https://html.duckduckgo.com/html/";

const MAX_QUERY_CHARS: usize = 400;
const DEFAULT_SEARCH_RESULTS: usize = 8;
const MAX_SEARCH_RESULTS: usize = 20;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);
const SEARCH_PAGE_CAP_BYTES: u64 = 512 * 1024;

const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_FETCH_MAX_BYTES: u64 = 1024;
const DEFAULT_FETCH_MAX_BYTES: u64 = 256 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024;
/// 输出上限对齐 read 工具的 128 KiB 语义：超限截断并置 truncated，
/// 模型可按 nextOffset 式分段思路改用更小的 maxBytes 复取。
const MAX_OUTPUT_CHARS: usize = 128 * 1024;

const MAX_REDIRECTS: usize = 5;
const MAX_URL_CHARS: usize = 2048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub query: String,
    pub results: Vec<WebSearchResultItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResponse {
    /// 重定向跟随后的最终 URL。
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub content: String,
    pub truncated: bool,
    pub fetched_bytes: u64,
}

/// 主机策略：生产命令一律 `PublicOnly`；`AllowPrivate` 仅供本模块测试
/// 用回环地址起本地 HTTP 服务验证真实请求路径（不削弱生产校验）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum WebHostPolicy {
    PublicOnly,
    /// 仅供本模块测试用回环地址起本地 HTTP 服务验证真实请求路径；
    /// 编译期从生产构建中移除，不构成可配置的放宽开关。
    #[cfg(test)]
    AllowPrivate,
}

#[tauri::command]
pub async fn web_search(query: String, limit: Option<usize>) -> Result<WebSearchResponse, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query must not be empty".into());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(format!("search query must not exceed {MAX_QUERY_CHARS} characters"));
    }
    let limit = limit
        .unwrap_or(DEFAULT_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);
    let results = perform_search(DUCKDUCKGO_HTML_ENDPOINT, query, limit).await?;
    Ok(WebSearchResponse {
        query: query.to_string(),
        results,
    })
}

#[tauri::command]
pub async fn web_fetch(
    url: String,
    max_bytes: Option<u64>,
) -> Result<WebFetchResponse, String> {
    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_FETCH_MAX_BYTES)
        .clamp(MIN_FETCH_MAX_BYTES, MAX_DOWNLOAD_BYTES);
    perform_fetch(url.trim(), max_bytes, WebHostPolicy::PublicOnly).await
}

async fn perform_search(
    endpoint: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchResultItem>, String> {
    let url = Url::parse_with_params(endpoint, &[("q", query)])
        .map_err(|error| format!("invalid search endpoint: {error}"))?;
    let client = build_web_client(SEARCH_TIMEOUT)?;
    let response = client
        .get(url)
        .header(ACCEPT, "text/html")
        .send()
        .await
        .map_err(|error| format!("search request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("search endpoint returned HTTP {status}"));
    }
    let (body, _) = read_body_limited(response, SEARCH_PAGE_CAP_BYTES).await?;
    let html = String::from_utf8_lossy(&body);
    Ok(parse_search_results(&html, limit))
}

async fn perform_fetch(
    raw_url: &str,
    max_bytes: u64,
    policy: WebHostPolicy,
) -> Result<WebFetchResponse, String> {
    let url = validate_web_url(raw_url, policy)?;
    if policy == WebHostPolicy::PublicOnly {
        ensure_resolved_hosts_allowed(&url).await?;
    }
    let client = build_web_client(FETCH_TIMEOUT)?;
    let response = client
        .get(url)
        .header(ACCEPT, "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5")
        .send()
        .await
        .map_err(|error| format!("web request failed: {error}"))?;
    let status_code = response.status();
    if !status_code.is_success() {
        return Err(format!("web request returned HTTP {status_code}"));
    }
    // 重定向终点复核：redirect policy 只能做同步字面量校验，DNS 层面在
    // 响应回来后对最终 URL 再查一次，阻断「公网域名 302 → 内网域名」的绕过。
    let final_url = response.url().clone();
    if policy == WebHostPolicy::PublicOnly {
        ensure_resolved_hosts_allowed(&final_url).await?;
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !is_supported_content_type(&content_type) {
        return Err(format!("unsupported content type: {content_type}"));
    }
    let (body, download_truncated) = read_body_limited(response, max_bytes).await?;
    let raw_text = String::from_utf8_lossy(&body);
    let text = if is_html_content_type(&content_type) {
        html_to_text(&raw_text)
    } else {
        raw_text.into_owned()
    };
    let (content, output_truncated) = truncate_output(text);
    Ok(WebFetchResponse {
        url: final_url.to_string(),
        status: status_code.as_u16(),
        content_type,
        content,
        truncated: download_truncated || output_truncated,
        fetched_bytes: body.len() as u64,
    })
}

fn build_web_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(WEB_USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .redirect(web_redirect_policy())
        .build()
        .map_err(|error| error.to_string())
}

fn web_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("too many web redirects");
        }
        // 重定向逐跳校验（字面量层）：DNS 层由请求前/响应后的显式校验兜底。
        if let Err(error) = validate_parsed_web_url(attempt.url(), WebHostPolicy::PublicOnly) {
            return attempt.error(error);
        }
        attempt.follow()
    })
}

/// 用系统默认浏览器打开外部 URL：会话输出中的 markdown 链接（如 PR 链接）
/// 点击后由前端调用。与 web_fetch 不同——这是用户主动点击的有意行为，
/// 不把内容带回模型，因此不限制公网主机（允许 localhost / 内网 dev server）；
/// 但仍拒绝非 http/https 协议与带凭据 URL，避免 file://、javascript: 等
/// 协议滥用（等价浏览器地址栏语义）。macOS 经 `/usr/bin/open`，Linux 经
/// `xdg-open`（freedesktop 约定在 PATH；缺失时报错文案含工具名，用户可自行
/// 安装 xdg-utils），Windows 经 `rundll32 FileProtocolHandler`（explorer.exe
/// 退出码不可靠——成功也常返回 1；cmd start 有 shell 注入面），均不经 shell。
/// 用 `cfg!` 运行时分派而非 `#[cfg]`：三个臂在所有平台上都参与编译与类型
/// 检查——Windows 主机尚缺（docs/windows-support.md），macOS 构建即能锁住
/// 全部平台臂的语法与契约。
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    let (mut command, opener): (std::process::Command, &str) = if cfg!(target_os = "macos") {
        (std::process::Command::new("/usr/bin/open"), "/usr/bin/open")
    } else if cfg!(target_os = "linux") {
        (std::process::Command::new("xdg-open"), "xdg-open")
    } else {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        (command, "rundll32")
    };
    let status = command
        .arg(&url)
        .status()
        .map_err(|error| format!("failed to launch system browser ({opener}): {error}"))?;
    if !status.success() {
        return Err(format!("system browser exited with {status}"));
    }
    Ok(())
}

fn validate_external_url(raw_url: &str) -> Result<(), String> {
    if raw_url.chars().count() > MAX_URL_CHARS {
        return Err(format!("web URL must not exceed {MAX_URL_CHARS} characters"));
    }
    let url = Url::parse(raw_url).map_err(|error| format!("invalid web URL: {error}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials are not allowed in web URLs".into());
    }
    match url.scheme() {
        "http" | "https" => Ok(()),
        _ => Err("only http and https web URLs can be opened in the browser".into()),
    }
}

fn validate_web_url(raw_url: &str, policy: WebHostPolicy) -> Result<Url, String> {
    if raw_url.chars().count() > MAX_URL_CHARS {
        return Err(format!("web URL must not exceed {MAX_URL_CHARS} characters"));
    }
    let url = Url::parse(raw_url).map_err(|error| format!("invalid web URL: {error}"))?;
    validate_parsed_web_url(&url, policy)?;
    Ok(url)
}

fn validate_parsed_web_url(url: &Url, policy: WebHostPolicy) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials are not allowed in web URLs".into());
    }
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("only http and https web URLs are allowed".into()),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "web URL host is missing".to_string())?;
    if policy == WebHostPolicy::PublicOnly && is_allowed_plain_http_host(host) {
        // is_allowed_plain_http_host 为 true 即「本地/私网」语义（localhost、
        // *.local、私有/回环/链路本地 IP 字面量）——无人值守通道拒绝。
        return Err("web tools only allow public internet hosts".into());
    }
    Ok(())
}

/// DNS 解析后逐一校验全部地址：任一解析结果落在私网/回环/链路本地即拒绝。
/// 攻击面：内网域名（如内部服务名）直接探测、公网域名解析到内网 IP 的
/// split-horizon DNS。失败（含解析失败）一律 fail-closed。
async fn ensure_resolved_hosts_allowed(url: &Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "web URL host is missing".to_string())?;
    // 字面量 IP（IPv6 字面量在 host_str 中带方括号）无需 DNS 解析，但仍复检
    // 私网判定：与 validate_parsed_web_url 的前置校验互为纵深，前置口径调整
    // 时这里不会退化为静默放行口；公网字面量无 rebinding 风险，直接放行。
    let normalized_host = host.trim_matches(|character| character == '[' || character == ']');
    if let Ok(ip) = normalized_host.parse::<IpAddr>() {
        if is_private_or_local_ip(ip) {
            return Err(format!(
                "host {host} is a private or local address; web tools only allow public internet hosts"
            ));
        }
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("failed to resolve host {host}: {error}"))?;
    for address in addresses {
        if is_private_or_local_ip(address.ip()) {
            return Err(format!(
                "host {host} resolves to a private or local address; web tools only allow public internet hosts"
            ));
        }
    }
    Ok(())
}

fn is_supported_content_type(content_type: &str) -> bool {
    let normalized = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    normalized.starts_with("text/")
        || normalized == "application/json"
        || normalized == "application/xml"
        || normalized == "application/javascript"
        || normalized == "application/yaml"
        || normalized == "application/x-yaml"
        || normalized.ends_with("+json")
        || normalized.ends_with("+xml")
}

fn is_html_content_type(content_type: &str) -> bool {
    let normalized = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    normalized == "text/html" || normalized == "application/xhtml+xml"
}

/// 分块读取并施加硬上限：服务器瞒报 Content-Length 或无上限流式响应都
/// 不会突破 cap 内存预算；超限即停并标记 truncated。
async fn read_body_limited(
    mut response: reqwest::Response,
    cap: u64,
) -> Result<(Vec<u8>, bool), String> {
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("failed to read response body: {error}"))?
    {
        if body.len() as u64 + chunk.len() as u64 > cap {
            let remaining = (cap as usize).saturating_sub(body.len());
            body.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, truncated))
}

fn truncate_output(text: String) -> (String, bool) {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return (text, false);
    }
    let truncated: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
    (truncated, true)
}

/// 解析 DuckDuckGo HTML 端点的结果页。锚点属性顺序在不同版本间有漂移，
/// 因此不匹配完整属性串，而是「抓全部 `<a>` → 按属性子串分类」：
/// `result__a` 是结果链接、`result__snippet` 是摘要；DDG 的真实 URL 藏在
/// `duckduckgo.com/l/?uddg=<encoded>` 跳转参数里，需解包；`y.js` 是广告跳转，丢弃。
fn parse_search_results(html: &str, limit: usize) -> Vec<WebSearchResultItem> {
    let anchor_regex = regex::Regex::new(r"(?is)<a\b([^>]*)>(.*?)</a>")
        .expect("search anchor regex must compile");
    struct Pending {
        title: String,
        url: Option<String>,
        snippet: String,
    }
    let mut entries: Vec<Pending> = Vec::new();
    for captures in anchor_regex.captures_iter(html) {
        let attributes = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let inner = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        if attributes.contains("result__a") {
            entries.push(Pending {
                title: html_to_text(inner),
                url: extract_href(attributes),
                snippet: String::new(),
            });
        } else if attributes.contains("result__snippet") {
            if let Some(entry) = entries.last_mut() {
                if entry.snippet.is_empty() {
                    entry.snippet = html_to_text(inner);
                }
            }
        }
    }
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for entry in entries {
        let Some(href) = entry.url else { continue };
        let Some(url) = resolve_ddg_href(&href) else {
            continue;
        };
        if url.host_str().map(|h| h.ends_with("duckduckgo.com")).unwrap_or(false)
            && url.path().starts_with("/y.js")
        {
            // 广告跳转，不是搜索结果。
            continue;
        }
        if entry.title.trim().is_empty() || !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        if !seen.insert(url.to_string()) {
            continue;
        }
        results.push(WebSearchResultItem {
            title: truncate_chars(entry.title.trim(), 300),
            url: url.to_string(),
            snippet: truncate_chars(entry.snippet.trim(), 600),
        });
        if results.len() >= limit {
            break;
        }
    }
    results
}

fn extract_href(attributes: &str) -> Option<String> {
    let start = attributes.find("href=\"")? + "href=\"".len();
    let rest = &attributes[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 解包 DDG 跳转链接：`//duckduckgo.com/l/?uddg=<encoded real url>` → 真实 URL；
/// 其余按原始 href 处理（协议相对 URL 补 https:）。
fn resolve_ddg_href(href: &str) -> Option<Url> {
    let normalized = if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href.to_string()
    };
    let url = Url::parse(&normalized).ok()?;
    let host = url.host_str()?;
    if host.ends_with("duckduckgo.com") && url.path().starts_with("/l/") {
        for (key, value) in url.query_pairs() {
            if key == "uddg" {
                return Url::parse(&value).ok();
            }
        }
        return None;
    }
    Some(url)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

/// 块级元素标签：命中开/闭标签时补换行，让段落结构在纯文本里可读。
const BLOCK_TAGS: &[&str] = &[
    "p", "div", "section", "article", "header", "footer", "main", "aside", "nav",
    "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "tr", "blockquote",
    "pre", "form", "figure", "figcaption", "dl", "dt", "dd", "hr",
];

/// 找出最早出现的 script/style/noscript 块（含闭合标签与结尾 '>'），
/// 返回 (块起点, 块结束后的偏移)。三个候选取最早命中位置——不能按
/// 「先命中的候选」处理，否则同页更早出现的其他块会被漏删。
fn strip_tag_block(input: &str) -> Option<(usize, usize)> {
    const CANDIDATES: &[(&str, &str)] = &[
        ("<script", "</script>"),
        ("<style", "</style>"),
        ("<noscript", "</noscript>"),
    ];
    let mut earliest: Option<(usize, &str)> = None;
    for (opening, closing) in CANDIDATES {
        if let Some(start) = find_case_insensitive(input, opening) {
            if earliest.is_none_or(|(best, _)| start < best) {
                earliest = Some((start, closing));
            }
        }
    }
    let (start, closing) = earliest?;
    let closing_offset = find_case_insensitive(&input[start..], closing)?;
    // closing 含结尾 '>'，直接跳过整个闭合标签。
    Some((start, start + closing_offset + closing.len()))
}

/// 手写 HTML → 纯文本：删 script/style/noscript 块（含内容）、块级标签补换行、
/// 其余标签剔除、HTML 实体解码、行内空白折叠。`<pre>` 的原始排版会被
/// 折叠——对「把网页正文交给模型阅读」的目标足够，不值得为此引解析器。
pub(crate) fn html_to_text(html: &str) -> String {
    let mut without_blocks = String::with_capacity(html.len());
    let mut rest = html;
    while let Some((start, after_close)) = strip_tag_block(rest) {
        without_blocks.push_str(&rest[..start]);
        rest = &rest[after_close..];
    }
    without_blocks.push_str(rest);

    let mut output = String::with_capacity(without_blocks.len());
    let mut chars = without_blocks.char_indices().peekable();
    while let Some((index, character)) = chars.next() {
        if character != '<' {
            output.push(character);
            continue;
        }
        // 标签：找到 '>'，取标签名（跳过可选的 '/'）。
        let remainder = &without_blocks[index..];
        let Some(greater) = remainder.find('>') else {
            // 未闭合的 '<'（正文中的数学比较符等）：原样保留后终止。
            output.push('<');
            continue;
        };
        let tag_body = &remainder[1..greater];
        let tag_name: String = tag_body
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if tag_name == "br" {
            output.push('\n');
        } else if tag_name == "li" {
            output.push_str("\n- ");
        } else if BLOCK_TAGS.contains(&tag_name.as_str()) {
            output.push('\n');
        }
        // 跳过整个标签内容（按字节边界对齐，标签内可含多字节 UTF-8 属性值）。
        let tag_end = index + greater;
        while let Some(&(byte_index, _)) = chars.peek() {
            if byte_index >= tag_end {
                break;
            }
            chars.next();
        }
        chars.next();
    }

    let decoded = decode_html_entities(&output);
    normalize_whitespace(&decoded)
}

fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
}

fn decode_html_entities(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'&' {
            let start = index;
            while index < bytes.len() && bytes[index] != b'&' {
                index += 1;
            }
            output.push_str(&input[start..index]);
            continue;
        }
        let semicolon = input[index + 1..]
            .find(';')
            .map(|offset| index + 1 + offset);
        let Some(semicolon) = semicolon else {
            output.push('&');
            index += 1;
            continue;
        };
        // 实体长度有界（命名实体最长 10 字符），超长视为普通文本。
        let entity = &input[index + 1..semicolon];
        if entity.len() > 10 || entity.is_empty() {
            output.push('&');
            index += 1;
            continue;
        }
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => {
                if let Some(numeric) = entity.strip_prefix('#') {
                    let code = if let Some(hex) = numeric
                        .strip_prefix('x')
                        .or_else(|| numeric.strip_prefix('X'))
                    {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        numeric.parse::<u32>().ok()
                    };
                    code.and_then(char::from_u32)
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(character) => {
                output.push(character);
                index = semicolon + 1;
            }
            None => {
                output.push('&');
                index += 1;
            }
        }
    }
    output
}

fn normalize_whitespace(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let collapsed: Vec<&str> = line.split_whitespace().collect();
        lines.push(collapsed.join(" "));
    }
    let mut output = String::with_capacity(text.len());
    let mut blank_run = 0;
    for line in lines {
        if line.is_empty() {
            blank_run += 1;
            // 连续空行压缩为一行，保留段落分隔。
            if blank_run <= 1 {
                output.push('\n');
            }
        } else {
            blank_run = 0;
            output.push_str(&line);
            output.push('\n');
        }
    }
    output.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn validates_web_url_scheme_credentials_and_local_hosts() {
        assert!(validate_web_url("https://example.com/docs", WebHostPolicy::PublicOnly).is_ok());
        assert!(validate_web_url("http://example.com:8080/page", WebHostPolicy::PublicOnly).is_ok());
        assert!(validate_web_url("ftp://example.com/file", WebHostPolicy::PublicOnly).is_err());
        assert!(validate_web_url("file:///etc/passwd", WebHostPolicy::PublicOnly).is_err());
        assert!(
            validate_web_url("https://user:secret@example.com", WebHostPolicy::PublicOnly).is_err(),
            "userinfo must be rejected"
        );
        assert!(validate_web_url("http://localhost:3000", WebHostPolicy::PublicOnly).is_err());
        assert!(validate_web_url("http://127.0.0.1/", WebHostPolicy::PublicOnly).is_err());
        assert!(validate_web_url("http://192.168.1.10/", WebHostPolicy::PublicOnly).is_err());
        assert!(validate_web_url("http://169.254.169.254/latest", WebHostPolicy::PublicOnly).is_err());
        assert!(validate_web_url("http://[::1]/", WebHostPolicy::PublicOnly).is_err());
        // IPv4-mapped IPv6 字面量折算回 v4 判定：曾可绕过私网封堵直连云元数据端点。
        assert!(validate_web_url("http://[::ffff:169.254.169.254]/latest", WebHostPolicy::PublicOnly).is_err());
        assert!(validate_web_url("http://[::ffff:127.0.0.1]/", WebHostPolicy::PublicOnly).is_err());
        // unspecified（0.0.0.0）在 BSD/macOS 上等价回环，按本地拒绝。
        assert!(validate_web_url("http://0.0.0.0/", WebHostPolicy::PublicOnly).is_err());
        // 嵌入公网地址仍是公网语义，不得误伤。
        assert!(validate_web_url("http://[::ffff:8.8.8.8]/", WebHostPolicy::PublicOnly).is_ok());
        assert!(
            validate_web_url("http://printer.local/", WebHostPolicy::PublicOnly).is_err(),
            "*.local must be rejected"
        );
        // AllowPrivate（测试策略）放行回环字面量，供本地集成测试使用。
        assert!(validate_web_url("http://127.0.0.1:9/", WebHostPolicy::AllowPrivate).is_ok());
    }

    #[test]
    fn validates_external_url_scheme_credentials_and_length() {
        // open_external_url 是用户主动点击的有意行为：公网、localhost、内网
        // dev server 都放行；但非 http/https 协议与凭据必须拒绝（防止 file://、
        // javascript: 等协议滥用）。
        assert!(validate_external_url("https://github.com/amuluze/axiom-agent/pull/1").is_ok());
        assert!(validate_external_url("http://localhost:5173/").is_ok());
        assert!(validate_external_url("http://192.168.1.10:8080/status").is_ok());
        assert!(validate_external_url("ftp://example.com/file").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(
            validate_external_url("https://user:secret@example.com").is_err(),
            "userinfo must be rejected"
        );
        let too_long = format!("https://example.com/{}", "a".repeat(MAX_URL_CHARS + 1));
        assert!(validate_external_url(&too_long).is_err());
    }

    #[tokio::test]
    async fn rejects_hosts_resolving_to_private_addresses() {
        let url = Url::parse("http://localhost:9/").unwrap();
        let error = ensure_resolved_hosts_allowed(&url)
            .await
            .expect_err("localhost resolves to loopback and must be rejected");
        assert!(error.contains("private or local"));
    }

    #[tokio::test]
    async fn rechecks_literal_mapped_ipv6_without_dns_resolution() {
        // 字面量 IP 分支必须复检私网判定（含 IPv4-mapped 折算），而不是信任
        // validate_parsed_web_url 的前置校验直接放行。
        let url = Url::parse("http://[::ffff:169.254.169.254]/latest").unwrap();
        let error = ensure_resolved_hosts_allowed(&url)
            .await
            .expect_err("mapped link-local literal must be rejected without DNS");
        assert!(error.contains("private or local"));
    }

    #[test]
    fn checks_supported_and_html_content_types() {
        assert!(is_supported_content_type("text/html; charset=utf-8"));
        assert!(is_supported_content_type("application/json"));
        assert!(is_supported_content_type("application/xhtml+xml"));
        assert!(is_supported_content_type("text/plain"));
        assert!(!is_supported_content_type("image/png"));
        assert!(!is_supported_content_type("application/octet-stream"));
        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(is_html_content_type("application/xhtml+xml"));
        assert!(!is_html_content_type("application/json"));
    }

    #[test]
    fn converts_html_to_readable_text() {
        let html = concat!(
            "<html><head><style>body{color:red}</style><script>alert(1)</script></head>",
            "<body><h1>Title &amp; more</h1><p>First &lt;paragraph&gt;</p>",
            "<ul><li>alpha</li><li>beta</li></ul>",
            "<div>tail<br/>line</div></body></html>"
        );
        let text = html_to_text(html);
        assert!(!text.contains("color:red"), "style block must be removed");
        assert!(!text.contains("alert(1)"), "script block must be removed");
        assert!(text.contains("Title & more"));
        assert!(text.contains("First <paragraph>"));
        assert!(text.contains("- alpha"));
        assert!(text.contains("- beta"));
        assert!(text.contains("tail\nline"), "br must become newline: {text:?}");
    }

    #[test]
    fn decodes_html_entities_including_numeric() {
        assert_eq!(decode_html_entities("a&amp;b"), "a&b");
        assert_eq!(decode_html_entities("&#65;&#x42;"), "AB");
        assert_eq!(decode_html_entities("keep & stray;"), "keep & stray;");
        assert_eq!(decode_html_entities("a&nbsp;b"), "a b");
    }

    const DDG_FIXTURE: &str = concat!(
        r#"<div class="result results_links"><h2 class="result__title">"#,
        r#"<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">"#,
        r#"Example <b>Docs</b> guide</a></h2>"#,
        r#"<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">"#,
        r#"Everything about &amp;lt;widgets&amp;gt; usage</a></div>"#,
        r#"<div class="result"><a class="result__a" href="https://example.org/second">Second result</a>"#,
        r#"<a class="result__snippet">Second snippet</a></div>"#,
        r#"<div class="result"><a class="result__a" href="//duckduckgo.com/y.js?ad_provider=sponsored&amp;u2=abc">"#,
        r#"Sponsored</a><a class="result__snippet">buy now</a></div>"#,
        r#"<a class="result__a" href="https://example.com/docs">Example Docs guide</a>"#
    );

    #[test]
    fn parses_ddg_results_unwrapping_redirects() {
        let results = parse_search_results(DDG_FIXTURE, 10);
        assert_eq!(results.len(), 2, "duplicate + ad entries must be dropped");
        assert_eq!(results[0].title, "Example Docs guide");
        assert_eq!(results[0].url, "https://example.com/docs");
        assert_eq!(results[0].snippet, "Everything about &lt;widgets&gt; usage");
        assert_eq!(results[1].url, "https://example.org/second");
    }

    #[test]
    fn caps_search_results_at_limit() {
        assert_eq!(parse_search_results(DDG_FIXTURE, 1).len(), 1);
    }

    fn spawn_http_server(
        status_line: &'static str,
        headers: &'static str,
        body: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let mut read = 0;
            while read < buffer.len() {
                match stream.read(&mut buffer[read..]) {
                    Ok(0) => break,
                    Ok(count) => {
                        read += count;
                        if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let response = format!("{status_line}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });
        (format!("http://{address}/"), handle)
    }

    #[tokio::test]
    async fn fetches_local_page_with_allow_private_policy() {
        let (base, server) = spawn_http_server(
            "HTTP/1.1 200 OK",
            "Content-Type: text/html; charset=utf-8\r\n",
            "<html><body><h1>Hello</h1><p>World &amp; more</p></body></html>",
        );
        let response = perform_fetch(&base, DEFAULT_FETCH_MAX_BYTES, WebHostPolicy::AllowPrivate)
            .await
            .expect("local fetch must succeed under the test policy");
        server.join().unwrap();
        assert_eq!(response.status, 200);
        assert!(response.content_type.starts_with("text/html"));
        assert!(response.content.contains("Hello"));
        assert!(response.content.contains("World & more"));
        assert!(!response.truncated);
    }

    #[tokio::test]
    async fn fetch_rejects_private_host_under_public_policy_before_request() {
        let (base, _server) = spawn_http_server(
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain\r\n",
            "should never be read",
        );
        let error = perform_fetch(&base, DEFAULT_FETCH_MAX_BYTES, WebHostPolicy::PublicOnly)
            .await
            .expect_err("public policy must reject loopback hosts");
        assert!(
            error.contains("public internet hosts"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn fetch_reports_http_errors() {
        let (base, server) = spawn_http_server(
            "HTTP/1.1 404 Not Found",
            "Content-Type: text/plain\r\n",
            "missing",
        );
        let error = perform_fetch(&base, DEFAULT_FETCH_MAX_BYTES, WebHostPolicy::AllowPrivate)
            .await
            .expect_err("non-2xx must surface as an error");
        server.join().unwrap();
        assert!(error.contains("404"), "unexpected error: {error}");
    }

    #[tokio::test]
    async fn fetch_truncates_at_max_bytes() {
        let large_body = "a".repeat(4096);
        let body: &'static str = Box::leak(large_body.into_boxed_str());
        let (base, server) = spawn_http_server(
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain\r\n",
            body,
        );
        let response = perform_fetch(&base, 1024, WebHostPolicy::AllowPrivate)
            .await
            .expect("fetch must succeed");
        server.join().unwrap();
        assert!(response.truncated, "download over the cap must be flagged");
        assert_eq!(response.content.len(), 1024);
        assert_eq!(response.fetched_bytes, 1024);
    }

    #[tokio::test]
    async fn search_uses_endpoint_results() {
        let (base, server) = spawn_http_server(
            "HTTP/1.1 200 OK",
            "Content-Type: text/html; charset=utf-8\r\n",
            DDG_FIXTURE,
        );
        let results = perform_search(&base, "widgets", 10)
            .await
            .expect("search against the local fixture must succeed");
        server.join().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.com/docs");
    }
}
