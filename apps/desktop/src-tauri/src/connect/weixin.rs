//! 微信个人号适配：腾讯 ilink 机器人 HTTP 网关（长轮询模拟长连接）。
//!
//! 线协议（对照 cc-connect platform/weixin）：
//! - 全部为普通 HTTP，鉴权三件 header：`AuthorizationType: ilink_bot_token`、
//!   `Authorization: Bearer <token>`、`X-WECHAT-UIN: base64(十进制随机 uint32)`；
//! - 扫码登录：get_bot_qrcode →（二维码内容渲染给用户扫）→ 轮询 get_qrcode_status
//!   （header `iLink-App-ClientVersion: 1`）直到 confirmed 拿到 bot_token；
//! - 收消息：POST getupdates 长轮询，游标 get_updates_buf 必须落盘续传；
//! - 回复必须携带入站消息里捕获的 context_token（每个对话一份，落盘）；
//! - errcode -14 = 登录过期（停止并提示重扫）；ret -2 = 突发节流（fail-fast）。

use super::{
    now_ms, process_inbound, reset_inbound_watermark, replace_config, set_status, sleep_backoff,
    update_login_session, ConnectEventPayload, ConnectInner, ConnectPlatform, ConnectStatusKind,
    InboundChatMessage, ReplyContext, StoredBinding, CONNECT_EVENT,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

const BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION: &str = "axiom-desktop/1.0";
/// 长轮询窗口：35s（HTTP 超时 = 窗口 + 5s）。
const LONGPOLL_WINDOW_MS: u64 = 35_000;
/// 回复分块上限：对齐 cc-connect 的 3800 字符（防触发突发节流）。
const REPLY_CHUNK_CHARS: usize = 3_800;
/// 扫码登录整体超时。
const LOGIN_DEADLINE_MS: i64 = 180_000;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 项目内 reqwest 未启用 json feature：统一走字符串 body + 手动反序列化。
async fn read_json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取微信网关响应失败: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析微信网关响应失败: {error}"))
}

#[derive(Clone, Debug)]
pub(crate) enum WechatLoginStatus {
    Starting,
    /// 点阵在 `WechatLoginSession.rows`（生成后不变，poll 时一并返回）。
    Waiting,
    Scanned,
    Confirmed,
    Expired,
    Failed { message: String },
}

fn authed_request(
    builder: reqwest::RequestBuilder,
    token: &str,
) -> reqwest::RequestBuilder {
    // X-WECHAT-UIN：每次请求随机生成（base64(十进制随机 uint32)）。
    let bytes = super::random_bytes(4);
    let uin = ((bytes[0] as u32) << 24) | ((bytes[1] as u32) << 16) | ((bytes[2] as u32) << 8)
        | bytes[3] as u32;
    let uin = base64::engine::general_purpose::STANDARD.encode(uin.to_string());
    builder
        .header("AuthorizationType", "ilink_bot_token")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-WECHAT-UIN", uin)
        .header("Content-Type", "application/json")
}

/* ------------------------------------------------------------------ *
 * 扫码登录
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct QrcodeResponse {
    #[serde(default)]
    qrcode: String,
    #[serde(default, rename = "qrcode_img_content")]
    qrcode_img_content: String,
}

#[derive(Deserialize)]
struct QrcodeStatusResponse {
    #[serde(default)]
    status: String,
    #[serde(default, rename = "bot_token")]
    bot_token: String,
    #[serde(default, rename = "ilink_user_id")]
    ilink_user_id: String,
}

fn encode_qr_rows(content: &str) -> Result<Vec<String>, String> {
    let qr = qrcodegen::QrCode::encode_text(content, qrcodegen::QrCodeEcc::Medium)
        .map_err(|error| format!("生成二维码失败: {error}"))?;
    let size = qr.size();
    let mut rows = Vec::with_capacity(size as usize);
    for y in 0..size {
        let mut row = String::with_capacity(size as usize);
        for x in 0..size {
            row.push(if qr.get_module(x, y) { '1' } else { '0' });
        }
        rows.push(row);
    }
    Ok(rows)
}

pub(crate) async fn run_wechat_login(
    app: AppHandle,
    state: Arc<Mutex<ConnectInner>>,
    login_id: String,
) {
    let fail = |message: String| {
        update_login_session(&state, &login_id, |session| {
            session.status = WechatLoginStatus::Failed { message };
        });
    };
    // 1. 获取二维码内容并生成点阵。
    let qrcode = match async {
        let response = http_client()
            .get(format!("{BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3"))
            .timeout(Duration::from_secs(40))
            .send()
            .await
            .map_err(|error| format!("获取微信登录二维码失败: {error}"))?;
        let payload: QrcodeResponse = read_json(response).await?;
        Ok::<QrcodeResponse, String>(payload)
    }
    .await
    {
        Ok(payload) if !payload.qrcode.is_empty() && !payload.qrcode_img_content.is_empty() => payload,
        Ok(_) => return fail("微信登录二维码响应无效".into()),
        Err(error) => return fail(error),
    };
    let rows = match encode_qr_rows(&qrcode.qrcode_img_content) {
        Ok(rows) => rows,
        Err(error) => return fail(error),
    };
    update_login_session(&state, &login_id, |session| {
        session.rows = rows;
        session.status = WechatLoginStatus::Waiting;
    });

    // 2. 轮询扫码状态直到 confirmed / expired / 超时。
    let deadline = now_ms() + LOGIN_DEADLINE_MS;
    loop {
        if now_ms() > deadline {
            update_login_session(&state, &login_id, |session| {
                session.status = WechatLoginStatus::Expired;
            });
            return;
        }
        let poll = async {
            let response = http_client()
                .get(format!(
                    "{BASE_URL}/ilink/bot/get_qrcode_status?qrcode={}",
                    urlencoding(&qrcode.qrcode)
                ))
                .header("iLink-App-ClientVersion", "1")
                .timeout(Duration::from_secs(LONGPOLL_WINDOW_MS / 1000 + 5))
                .send()
                .await
                .map_err(|error| format!("查询微信扫码状态失败: {error}"))?;
            let payload: QrcodeStatusResponse = read_json(response).await?;
            Ok::<QrcodeStatusResponse, String>(payload)
        };
        match poll.await {
            Ok(payload) => match payload.status.as_str() {
                "scaned" | "scanned" => {
                    update_login_session(&state, &login_id, |session| {
                        session.status = WechatLoginStatus::Scanned;
                    });
                }
                "expired" => {
                    update_login_session(&state, &login_id, |session| {
                        session.status = WechatLoginStatus::Expired;
                    });
                    return;
                }
                "confirmed" => {
                    if payload.bot_token.is_empty() {
                        return fail("微信登录确认响应缺少 token".into());
                    }
                    // token 只进本地密钥库（axiom.db secrets 表）；扫码用户自动绑定为控制器（cc-connect 同语义）。
                    let secret_state: tauri::State<'_, crate::secrets::SecretState> = app.state();
                    if let Err(error) =
                        crate::secrets::save_connect_secret(&secret_state, "connect.weixin.bot-token", &payload.bot_token)
                    {
                        return fail(error);
                    }
                    let user_id = if payload.ilink_user_id.is_empty() {
                        "weixin-scanner".to_string()
                    } else {
                        payload.ilink_user_id.clone()
                    };
                    let app_for_config = app.clone();
                    let state_for_config = Arc::clone(&state);
                    let bind_result = replace_config(&app_for_config, &state_for_config, |config| {
                        let exists = config.bindings.iter().any(|binding| {
                            binding.platform == ConnectPlatform::Weixin && binding.user_id == user_id
                        });
                        if !exists {
                            config.bindings.push(StoredBinding {
                                platform: ConnectPlatform::Weixin,
                                chat_id: user_id.clone(),
                                chat_type: "p2p".into(),
                                user_id: user_id.clone(),
                                user_name: "微信扫码用户".into(),
                                paired_at: now_ms(),
                            });
                        }
                    });
                    if let Err(error) = bind_result {
                        return fail(error);
                    }
                    update_login_session(&state, &login_id, |session| {
                        session.status = WechatLoginStatus::Confirmed;
                    });
                    let _ = app.emit(CONNECT_EVENT, ConnectEventPayload::Paired {
                        platform: ConnectPlatform::Weixin,
                        chat_id: user_id.clone(),
                        chat_type: "p2p".into(),
                        user_id,
                        user_name: "微信扫码用户".into(),
                    });
                    return;
                }
                _ => {} // wait / 空：继续轮询
            },
            Err(_) => { /* 网络抖动按 wait 处理 */ }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// 最小 percent-encoding：查询参数只含安全字符时原样返回，否则编码保留字。
fn urlencoding(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/* ------------------------------------------------------------------ *
 * 消息长轮询
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
struct BaseInfo {
    channel_version: String,
}

#[derive(Serialize)]
struct GetUpdatesRequest {
    get_updates_buf: String,
    base_info: BaseInfo,
}

#[derive(Deserialize, Default)]
struct GetUpdatesResponse {
    #[serde(default)]
    ret: i64,
    #[serde(default)]
    errcode: i64,
    #[serde(default)]
    msgs: Vec<Value>,
    #[serde(default)]
    get_updates_buf: String,
}

#[derive(Serialize, Default)]
struct TextItem {
    text: String,
}

#[derive(Serialize)]
struct OutboundItem {
    #[serde(rename = "type")]
    item_type: i64,
    text_item: TextItem,
}

#[derive(Serialize)]
struct OutboundMessage {
    from_user_id: String,
    to_user_id: String,
    client_id: String,
    message_type: i64,
    message_state: i64,
    item_list: Vec<OutboundItem>,
    context_token: String,
}

#[derive(Serialize)]
struct SendMessageRequest {
    msg: OutboundMessage,
    base_info: BaseInfo,
}

#[derive(Deserialize, Default)]
struct SendMessageResponse {
    #[serde(default)]
    ret: i64,
    #[serde(default)]
    errcode: i64,
    #[serde(default)]
    errmsg: String,
}

fn cursor_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(super::connect_dir(app)?.join("weixin-getupdates.buf"))
}

#[derive(Serialize, Deserialize, Default)]
struct WeixinContextFile {
    #[serde(default, rename = "contextTokens")]
    context_tokens: HashMap<String, String>,
}

fn contexts_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(super::connect_dir(app)?.join("weixin-contexts.json"))
}

fn load_cursor(app: &AppHandle) -> String {
    fs::read_to_string(cursor_path(app).unwrap_or_default()).unwrap_or_default()
}

fn persist_cursor(app: &AppHandle, cursor: &str) {
    if let Ok(path) = cursor_path(app) {
        let _ = fs::write(path, cursor);
    }
}

fn load_contexts(app: &AppHandle) -> WeixinContextFile {
    contexts_path(app)
        .and_then(|path| fs::read_to_string(path).map_err(|error| error.to_string()))
        .and_then(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
        .unwrap_or_default()
}

fn persist_contexts(app: &AppHandle, contexts: &WeixinContextFile) {
    if let Ok(path) = contexts_path(app) {
        if let Ok(encoded) = serde_json::to_vec(contexts) {
            let _ = fs::write(path, encoded);
        }
    }
}

fn extract_text(message: &Value) -> Option<String> {
    let items = message.get("item_list")?.as_array()?;
    let mut parts = Vec::new();
    for item in items {
        if item.get("type").and_then(Value::as_i64) == Some(1) {
            if let Some(text) = item.pointer("/text_item/text").and_then(Value::as_str) {
                parts.push(text.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

pub(crate) async fn run_weixin(app: AppHandle, state: Arc<Mutex<ConnectInner>>, token: String) {
    let mut attempt: u32 = 0;
    let mut cursor = load_cursor(&app);
    // 重启恢复：把落盘的 context_token 预热进内存回复上下文。
    {
        let contexts = load_contexts(&app);
        if let Ok(mut inner) = state.lock() {
            for (user_id, context_token) in contexts.context_tokens {
                let reply = ReplyContext::Weixin {
                    to_user_id: user_id.clone(),
                    context_token,
                };
                inner
                    .reply_contexts
                    .insert((ConnectPlatform::Weixin, user_id.clone(), user_id), reply);
            }
        }
    }
    reset_inbound_watermark(&state, ConnectPlatform::Weixin);
    set_status(&app, &state, ConnectPlatform::Weixin, ConnectStatusKind::Connected, None);
    loop {
        let encoded = serde_json::to_string(&GetUpdatesRequest {
            get_updates_buf: cursor.clone(),
            base_info: BaseInfo { channel_version: CHANNEL_VERSION.to_string() },
        })
        .map_err(|error| format!("编码微信长轮询请求失败: {error}"))
        .unwrap_or_default();
        let response = authed_request(
            http_client().post(format!("{BASE_URL}/ilink/bot/getupdates")),
            &token,
        )
        .body(encoded)
        .timeout(Duration::from_millis(LONGPOLL_WINDOW_MS + 10_000))
        .send()
        .await;
        let payload = match response {
            Ok(response) => match read_json::<GetUpdatesResponse>(response).await {
                Ok(payload) => payload,
                Err(error) => {
                    set_status(
                        &app,
                        &state,
                        ConnectPlatform::Weixin,
                        ConnectStatusKind::Error,
                        Some(format!("解析微信消息失败: {error}")),
                    );
                    tokio::time::sleep(sleep_backoff(attempt)).await;
                    attempt += 1;
                    continue;
                }
            },
            Err(_) => {
                // 长轮询超时按空响应处理：游标不变、短歇后继续。
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        attempt = 0;
        if payload.errcode == -14 {
            // 登录过期：停止轮询并禁用自动重连，等待用户重新扫码。
            set_status(
                &app,
                &state,
                ConnectPlatform::Weixin,
                ConnectStatusKind::Error,
                Some("微信登录已过期，请重新扫码登录".into()),
            );
            let _ = replace_config(&app, &state, |config| {
                config.weixin.enabled = false;
            });
            return;
        }
        if payload.ret != 0 {
            // ret=-2 突发节流：加大间隔，不 fail-fast 重试以免加重惩罚。
            tokio::time::sleep(Duration::from_secs(if payload.ret == -2 { 30 } else { 5 })).await;
            continue;
        }
        if !payload.get_updates_buf.is_empty() {
            cursor = payload.get_updates_buf.clone();
            persist_cursor(&app, &cursor);
        }
        for message in &payload.msgs {
            // message_type：1=用户消息，2=机器人自发（回环丢弃）。
            if message.get("message_type").and_then(Value::as_i64) != Some(1) {
                continue;
            }
            let Some(from_user_id) = message.get("from_user_id").and_then(Value::as_str) else {
                continue;
            };
            // 群聊（@chatroom）MVP 不支持：机器人入群需手动拉且消息形态不同。
            if from_user_id.ends_with("@chatroom") {
                continue;
            }
            let Some(text) = extract_text(message) else {
                continue;
            };
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            let context_token = message
                .get("context_token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if context_token.is_empty() {
                continue;
            }
            let message_id = message
                .get("message_id")
                .and_then(Value::as_i64)
                .filter(|value| *value != 0)
                .map(|value| value.to_string())
                .unwrap_or_else(|| super::random_hex(8));
            // context_token 落盘：跨重启仍可回复（不落盘则重启后须等用户再发一条）。
            {
                let mut contexts = load_contexts(&app);
                contexts
                    .context_tokens
                    .insert(from_user_id.to_string(), context_token.clone());
                persist_contexts(&app, &contexts);
            }
            let inbound = InboundChatMessage {
                platform: ConnectPlatform::Weixin,
                chat_id: from_user_id.to_string(),
                chat_type: "p2p".to_string(),
                user_id: from_user_id.to_string(),
                user_name: from_user_id.to_string(),
                message_id,
                text,
                create_time_ms: message
                    .get("create_time_ms")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                reply: ReplyContext::Weixin {
                    to_user_id: from_user_id.to_string(),
                    context_token,
                },
            };
            let send = {
                let app_for_send = app.clone();
                let context = inbound.reply.clone();
                let token_for_send = token.clone();
                move |text: &str| {
                    let text = text.to_string();
                    let app = app_for_send.clone();
                    let context = context.clone();
                    let token = token_for_send.clone();
                    async move { send_reply(&app, &context, &token, &text).await.map(|_| ()) }
                }
            };
            let _ = process_inbound(&app, &state, inbound, send).await;
        }
    }
}

/* ------------------------------------------------------------------ *
 * 出站回复
 * ------------------------------------------------------------------ */

pub(crate) async fn send_reply(
    _app: &AppHandle,
    context: &ReplyContext,
    token: &str,
    text: &str,
) -> Result<(), String> {
    let ReplyContext::Weixin { to_user_id, context_token } = context else {
        return Err("回复上下文与平台不匹配".into());
    };
    if context_token.is_empty() {
        return Err("缺少 context_token（需要用户先发一条消息）".into());
    }
    let chunks = if text.chars().count() <= REPLY_CHUNK_CHARS {
        vec![text.to_string()]
    } else {
        let mut chunks = Vec::new();
        let mut current = String::new();
        for line in text.split_inclusive('\n') {
            if current.chars().count() + line.chars().count() > REPLY_CHUNK_CHARS && !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            current.push_str(line);
        }
        if !current.is_empty() {
            chunks.push(current);
        }
        chunks
    };
    for chunk in chunks {
        let request = SendMessageRequest {
            msg: OutboundMessage {
                from_user_id: String::new(),
                to_user_id: to_user_id.clone(),
                client_id: format!("axiom-{}", super::random_hex(6)),
                message_type: 2,
                message_state: 2,
                item_list: vec![OutboundItem {
                    item_type: 1,
                    text_item: TextItem { text: chunk },
                }],
                context_token: context_token.clone(),
            },
            base_info: BaseInfo { channel_version: CHANNEL_VERSION.to_string() },
        };
        let encoded = serde_json::to_string(&request)
            .map_err(|error| format!("编码微信消息失败: {error}"))?;
        let response = authed_request(
            http_client().post(format!("{BASE_URL}/ilink/bot/sendmessage")),
            token,
        )
        .body(encoded)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("微信消息发送失败: {error}"))?;
        let status = response.status();
        let payload: SendMessageResponse = read_json(response).await?;
        if !status.is_success() || payload.ret != 0 || payload.errcode != 0 {
            // ret=-2 是突发节流：向调用方暴露明确语义（TS 侧静默丢弃）。
            return Err(if payload.ret == -2 {
                "微信发送触发节流（发送过于频繁，请稍候）".into()
            } else {
                format!(
                    "微信消息发送失败（ret {} / errcode {}）: {}",
                    payload.ret, payload.errcode, payload.errmsg
                )
            });
        }
        // 多块之间稍作间隔，贴近人工节奏、降低节流概率。
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_rows_form_a_square_matrix() {
        let rows = encode_qr_rows("https://example.com/login?ticket=abc").unwrap();
        assert!(!rows.is_empty());
        assert!(rows.iter().all(|row| row.len() == rows.len()));
        assert!(rows.iter().all(|row| row.chars().all(|c| c == '0' || c == '1')));
    }

    #[test]
    fn text_extraction_joins_text_items_only() {
        let message = serde_json::json!({
            "item_list": [
                { "type": 1, "text_item": { "text": "第一段" } },
                { "type": 2, "image_item": { "media": {} } },
                { "type": 1, "text_item": { "text": "第二段" } },
            ],
        });
        assert_eq!(extract_text(&message).as_deref(), Some("第一段\n第二段"));
        let empty = serde_json::json!({ "item_list": [ { "type": 2 } ] });
        assert!(extract_text(&empty).is_none());
    }

    #[test]
    fn urlencoding_leaves_safe_characters() {
        assert_eq!(urlencoding("abc-1_2.3~"), "abc-1_2.3~");
        assert_eq!(urlencoding("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn outbound_request_shape_matches_protocol() {
        let request = SendMessageRequest {
            msg: OutboundMessage {
                from_user_id: String::new(),
                to_user_id: "ilink_user_1".into(),
                client_id: "axiom-01".into(),
                message_type: 2,
                message_state: 2,
                item_list: vec![OutboundItem { item_type: 1, text_item: TextItem { text: "hi".into() } }],
                context_token: "ctx".into(),
            },
            base_info: BaseInfo { channel_version: CHANNEL_VERSION.into() },
        };
        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["msg"]["message_type"], 2);
        assert_eq!(encoded["msg"]["item_list"][0]["type"], 1);
        assert_eq!(encoded["msg"]["item_list"][0]["text_item"]["text"], "hi");
        assert_eq!(encoded["base_info"]["channel_version"], CHANNEL_VERSION);
    }
}
