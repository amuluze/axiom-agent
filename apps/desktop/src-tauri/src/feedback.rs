//! 产品内反馈上报：`submit_feedback` 命令把反馈弹窗的表单推送到 Pusher
//! 反馈聚合服务的采集端点（`/api/hooks/:source`，Feed hook 协议）。
//!
//! 与 `web_access.rs` 的边界差异：这是**用户显式提交**的一次性动作（有按钮、
//! 有加载态），不是无人值守通道，因此不需要公网/DNS 逐跳校验那套保守面；
//! 目标端点与签名密钥都由本模块持有（编译期内置），WebView 只传表单四项，
//! 永远接触不到密钥。签名协议（Stripe 风格，与 Pusher 服务端逐字对应）：
//!
//!   X-Pusher-Timestamp: <unix 秒>
//!   X-Pusher-Signature: sha256=<hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))>
//!
//! `event_hash` 幂等去重：哈希绑定表单内容 + 进程内随机实例盐——同一次提交
//! 的「重试」命中去重不产生重复工单，不同用户提交相同内容互不吞并。
//!
//! HMAC-SHA256 手写不引 `hmac` crate：实现约 20 行（RFC 2104 的标准 ipad/opad
//! 结构），`sha2` 已是直接依赖，避免为单一能力新增依赖（牵动依赖审计与 SBOM）。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 反馈服务端点与 HMAC 密钥：构建期经环境变量注入（`~/.axiom/release-credentials.env`，
/// 发布链 build:dmg/build:app 自动 source）。密钥不入源码——源码镜像会公开导出
/// （scripts/export-public.mjs），写死即等于公开；未注入（源码构建/开发态）时
/// 提交 fail-closed 报「未配置」。服务端换密钥时只需同步改凭据文件，不动代码。
const FEEDBACK_ENDPOINT: Option<&str> = option_env!("AXIOM_FEEDBACK_ENDPOINT");
const HOOK_SECRET: Option<&str> = option_env!("AXIOM_FEEDBACK_HMAC_SECRET");
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(15);

/// 与前端弹窗的字数上限（i18n 文案与 maxLength）保持一致；服务端超限返回 422。
const MAX_TITLE_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_CONTACT_CHARS: usize = 200;
/// 错误响应体的读取上限：只用于透出服务端 error 字段，防止异常响应撑爆错误文案。
const MAX_ERROR_BODY_BYTES: usize = 4096;

/// 反馈弹窗提交载荷：四个字段全部必填（校验在前端，Rust 侧兜底复核）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackSubmission {
    /// "feature"（功能需求）| "bug"（缺陷问题），对应 Pusher 的 type 枚举。
    kind: String,
    title: String,
    description: String,
    contact: String,
}

/// Pusher 采集端点的响应（201 `{"ok":true,"ref":"#AX-1","deduped":false}`；
/// event_hash 重放时 200 `{"ok":true,"deduped":true}` 且无 ref）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackSubmitResponse {
    ok: bool,
    #[serde(rename = "ref")]
    reference: Option<String>,
    deduped: bool,
}

#[tauri::command]
pub(crate) async fn submit_feedback(
    request: FeedbackSubmission,
    app: tauri::AppHandle,
) -> Result<FeedbackSubmitResponse, String> {
    let kind = match request.kind.as_str() {
        "feature" => "feature",
        "bug" => "bug",
        other => return Err(format!("未知的反馈类型：{other}")),
    };
    let title = request.title.trim();
    let description = request.description.trim();
    let contact = request.contact.trim();
    if title.is_empty() {
        return Err("反馈标题不能为空".into());
    }
    if description.is_empty() {
        return Err("反馈描述不能为空".into());
    }
    if contact.is_empty() {
        return Err("联系方式不能为空".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("反馈标题不能超过 {MAX_TITLE_CHARS} 字"));
    }
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!("反馈描述不能超过 {MAX_DESCRIPTION_CHARS} 字"));
    }
    if contact.chars().count() > MAX_CONTACT_CHARS {
        return Err(format!("联系方式不能超过 {MAX_CONTACT_CHARS} 字"));
    }

    let app_version = app.package_info().version.to_string();
    let body = build_payload(kind, title, description, contact, &app_version);
    // 密钥经构建期注入：缺失（源码构建/开发态）时 fail-closed，不发起无签名请求。
    let (endpoint, hook_secret) = FEEDBACK_ENDPOINT.zip(HOOK_SECRET).ok_or_else(|| {
        "反馈服务未随此构建配置：请使用官网发布的正式版本".to_string()
    })?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("系统时钟异常，无法签名反馈：{error}"))?
        .as_secs()
        .to_string();
    let signature = hex_hmac_sha256(hook_secret.as_bytes(), &message_bytes(&timestamp, &body));

    let client = reqwest::Client::builder()
        .timeout(SUBMIT_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))?;
    let response = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("X-Pusher-Timestamp", &timestamp)
        .header("X-Pusher-Signature", format!("sha256={signature}"))
        .body(body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "提交超时，请检查网络后重试".to_string()
            } else {
                format!("网络连接异常，请检查网络后重试（{error}）")
            }
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(MAX_ERROR_BODY_BYTES)
            .collect::<String>();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("error").and_then(|error| error.as_str()).map(String::from))
            .unwrap_or_else(|| if body.is_empty() { "无响应体".into() } else { body });
        return Err(format!("反馈服务返回 {status}：{detail}"));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("反馈服务响应无法解析：{error}"))?;
    let ok = payload.get("ok").and_then(|value| value.as_bool()).unwrap_or(false);
    if !ok {
        return Err("反馈服务返回了异常结果，请稍后重试".into());
    }
    Ok(FeedbackSubmitResponse {
        ok: true,
        reference: payload
            .get("ref")
            .and_then(|value| value.as_str())
            .map(String::from),
        deduped: payload
            .get("deduped")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    })
}

/// `<timestamp>.<body>` 的原始字节：签名与请求体必须逐字节一致，因此请求体
/// 直接复用序列化产物，不走重新序列化。
fn message_bytes(timestamp: &str, body: &[u8]) -> Vec<u8> {
    let mut message = timestamp.as_bytes().to_vec();
    message.push(b'.');
    message.extend_from_slice(body);
    message
}

/// 组装 Pusher hook 载荷并序列化。type 枚举归一化由服务端兜底，这里直接发
/// 归一化后的值；reporter.name 取联系方式原文（收件箱列表的主展示字段），
/// 看起来像邮箱的联系方式同时填入 email 供回复通道使用。
fn build_payload(
    kind: &str,
    title: &str,
    description: &str,
    contact: &str,
    app_version: &str,
) -> Vec<u8> {
    let event_hash = event_hash(kind, title, description, contact);
    let reporter_email = if contact.contains('@') { contact } else { "" };
    serde_json::to_vec(&serde_json::json!({
        "title": title,
        "message": description,
        "type": kind,
        "event_hash": event_hash,
        "reporter": {
            "name": contact,
            "email": reporter_email,
            "via": "widget",
            "build": app_version,
            "source_page": "Axiom 桌面端",
        },
        "payload": {
            "app_version": app_version,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
    }))
    .expect("feedback payload serialization cannot fail")
}

/// 幂等键：绑定表单内容 + 进程内实例盐。同进程内重试同一份表单命中去重；
/// 实例盐让不同用户提交相同内容产生独立工单（服务端 event_hash 按 source
/// 全局去重）。64 个十六进制字符，低于服务端 128 字符上限。
fn event_hash(kind: &str, title: &str, description: &str, contact: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"axiom-feedback-v1|");
    hasher.update(instance_salt().as_bytes());
    hasher.update(b"|");
    hasher.update(kind.as_bytes());
    hasher.update(b"|");
    hasher.update(title.as_bytes());
    hasher.update(b"|");
    hasher.update(description.as_bytes());
    hasher.update(b"|");
    hasher.update(contact.as_bytes());
    hex(&hasher.finalize())
}

/// 进程内随机盐（进程启动后固定）：RandomState 每次构造使用独立随机种子，
/// 两路拼接出 128 位熵。仅用于去重命名空间隔离，无安全职能。
fn instance_salt() -> &'static String {
    static SALT: OnceLock<String> = OnceLock::new();
    SALT.get_or_init(|| {
        let first = RandomState::new().build_hasher().finish();
        let second = RandomState::new().build_hasher().finish();
        format!("{first:016x}{second:016x}")
    })
}

/// RFC 2104 HMAC-SHA256（标准 ipad/opad 结构；密钥超过块长 64 字节时先哈希）。
pub(crate) fn hmac_sha256(secret: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_LENGTH: usize = 64;
    let mut key = [0u8; BLOCK_LENGTH];
    if secret.len() > BLOCK_LENGTH {
        let mut hasher = Sha256::new();
        hasher.update(secret);
        key[..32].copy_from_slice(&hasher.finalize());
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }
    let mut ipad = [0x36u8; BLOCK_LENGTH];
    let mut opad = [0x5cu8; BLOCK_LENGTH];
    for (index, key_byte) in key.iter().enumerate() {
        ipad[index] ^= key_byte;
        opad[index] ^= key_byte;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn hex_hmac_sha256(secret: &[u8], message: &[u8]) -> String {
    hex(&hmac_sha256(secret, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 4231 Test Case 2：HMAC-SHA256 的标准测试向量。
    #[test]
    fn hmac_sha256_matches_rfc_4231_vector() {
        let signature = hex_hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            signature,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    // 超过块长（64 字节）的密钥必须先哈希再进 ipad/opad（RFC 2104 §2）。
    #[test]
    fn hmac_sha256_hashes_oversized_keys() {
        let long_key = [0xaau8; 131];
        let signature = hex_hmac_sha256(
            &long_key,
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        // RFC 4231 Test Case 6（131 字节 0xaa 密钥）。
        assert_eq!(
            signature,
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn message_bytes_joins_timestamp_and_body_with_dot() {
        let message = message_bytes("1700000000", b"{\"title\":1}");
        assert_eq!(message, b"1700000000.{\"title\":1}");
    }

    #[test]
    fn event_hash_is_stable_for_same_content_and_salt() {
        let first = event_hash("feature", "标题", "描述", "a@example.com");
        let second = event_hash("feature", "标题", "描述", "a@example.com");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        // 内容任一字段变化都产生不同哈希。
        assert_ne!(first, event_hash("bug", "标题", "描述", "a@example.com"));
        assert_ne!(first, event_hash("feature", "标题", "描述", "b@example.com"));
    }

    #[test]
    fn build_payload_matches_pusher_hook_contract() {
        let body = build_payload("bug", "标题", "描述", "a@example.com", "0.4.5");
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["title"], "标题");
        assert_eq!(payload["message"], "描述");
        assert_eq!(payload["type"], "bug");
        assert_eq!(payload["reporter"]["name"], "a@example.com");
        assert_eq!(payload["reporter"]["email"], "a@example.com");
        assert_eq!(payload["reporter"]["via"], "widget");
        assert_eq!(payload["reporter"]["build"], "0.4.5");
        assert_eq!(payload["payload"]["app_version"], "0.4.5");
        assert_eq!(payload["event_hash"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn build_payload_keeps_non_email_contact_out_of_email_field() {
        let body = build_payload("feature", "标题", "描述", "微信: axiom-user", "0.4.5");
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["reporter"]["name"], "微信: axiom-user");
        assert_eq!(payload["reporter"]["email"], "");
    }
}
