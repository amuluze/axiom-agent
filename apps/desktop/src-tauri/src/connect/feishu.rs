//! 飞书长连接适配：官方「WebSocket 摘要模式」。
//!
//! 线协议（对照 larkws SDK v3.5.3 逆向，不走 SDK）：
//! 1. `POST /callback/ws/endpoint`（PascalCase body {AppID, AppSecret}）换取 WS URL；
//! 2. WS 帧是 **protobuf 二进制**（Frame：seq/log/service/method/headers/payload），
//!    method 0=Control（ping/pong）、1=Data（事件）；
//! 3. 客户端按 PingInterval（默认 120s）发 ping 帧，服务端回 pong；
//! 4. 每个事件帧处理完必须回一个 Data 帧（payload 为 {"code":200}）；
//! 5. 事件体 im.message.receive_v1：content 是再包一层 JSON 的 {"text": "..."}；
//! 6. 回复走 REST：tenant_access_token/internal + im/v1/messages/{id}/reply，
//!    markdown 用 interactive 卡片（schema 2.0）。

use super::{
    cached_rest_token, cache_rest_token, now_ms, reset_inbound_watermark, set_status,
    sleep_backoff, ConnectInner, ConnectPlatform, ConnectStatusKind, InboundChatMessage,
    ReplyContext,
};
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::Message;

const BASE_URL: &str = "https://open.feishu.cn";
/// 回复分块上限：interactive 卡片 markdown 过长会被飞书拒绝，留足余量。
const REPLY_CHUNK_CHARS: usize = 3_800;

#[derive(Clone)]
pub(crate) struct FeishuCreds {
    pub app_id: String,
    pub app_secret: String,
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 项目内 reqwest 未启用 json feature：统一走字符串 body + 手动反序列化。
async fn read_json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取飞书响应失败: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析飞书响应失败: {error}"))
}

/* ------------------------------------------------------------------ *
 * protobuf Frame 最小编解码（proto2 wire format，字段见模块注释）
 * ------------------------------------------------------------------ */

#[derive(Debug, Default, Clone)]
struct FrameHeader {
    key: String,
    value: String,
}

#[derive(Debug, Default, Clone)]
struct Frame {
    seq_id: u64,
    log_id: u64,
    service: i32,
    method: i32,
    headers: Vec<FrameHeader>,
    payload: Option<Vec<u8>>,
}

fn write_varint(buffer: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        buffer.push(byte);
        if value == 0 {
            break;
        }
    }
}

fn write_tag(buffer: &mut Vec<u8>, field: u32, wire: u32) {
    write_varint(buffer, ((field << 3) | wire) as u64);
}

fn write_len_delim(buffer: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    write_tag(buffer, field, 2);
    write_varint(buffer, bytes.len() as u64);
    buffer.extend_from_slice(bytes);
}

fn encode_frame(frame: &Frame) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(64 + frame.payload.as_ref().map_or(0, Vec::len));
    write_tag(&mut buffer, 1, 0);
    write_varint(&mut buffer, frame.seq_id);
    write_tag(&mut buffer, 2, 0);
    write_varint(&mut buffer, frame.log_id);
    write_tag(&mut buffer, 3, 0);
    // proto2 int32 负值按 64 位补码编码；service/method 实际非负。
    write_varint(&mut buffer, frame.service as i64 as u64);
    write_tag(&mut buffer, 4, 0);
    write_varint(&mut buffer, frame.method as i64 as u64);
    for header in &frame.headers {
        let mut entry = Vec::with_capacity(header.key.len() + header.value.len() + 8);
        write_len_delim(&mut entry, 1, header.key.as_bytes());
        write_len_delim(&mut entry, 2, header.value.as_bytes());
        write_len_delim(&mut buffer, 5, &entry);
    }
    if let Some(payload) = &frame.payload {
        write_len_delim(&mut buffer, 8, payload);
    }
    buffer
}

fn read_varint(bytes: &[u8], cursor: &mut usize) -> Option<u64> {
    let mut value = 0_u64;
    let mut shift = 0_u32;
    while *cursor < bytes.len() {
        let byte = bytes[*cursor];
        *cursor += 1;
        value |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

fn read_len_delim<'a>(bytes: &'a [u8], cursor: &mut usize) -> Option<&'a [u8]> {
    let length = read_varint(bytes, cursor)? as usize;
    if *cursor + length > bytes.len() {
        return None;
    }
    let slice = &bytes[*cursor..*cursor + length];
    *cursor += length;
    Some(slice)
}

fn decode_frame(bytes: &[u8]) -> Option<Frame> {
    let mut frame = Frame::default();
    let mut cursor = 0_usize;
    while cursor < bytes.len() {
        let tag = read_varint(bytes, &mut cursor)?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 0x7) as u32;
        match (field, wire) {
            (1, 0) => frame.seq_id = read_varint(bytes, &mut cursor)?,
            (2, 0) => frame.log_id = read_varint(bytes, &mut cursor)?,
            (3, 0) => frame.service = read_varint(bytes, &mut cursor)? as i32,
            (4, 0) => frame.method = read_varint(bytes, &mut cursor)? as i32,
            (5, 2) => {
                let entry = read_len_delim(bytes, &mut cursor)?;
                let mut header = FrameHeader::default();
                let mut entry_cursor = 0_usize;
                while entry_cursor < entry.len() {
                    let entry_tag = read_varint(entry, &mut entry_cursor)?;
                    let entry_field = (entry_tag >> 3) as u32;
                    let entry_wire = (entry_tag & 0x7) as u32;
                    match (entry_field, entry_wire) {
                        (1, 2) => {
                            let key = read_len_delim(entry, &mut entry_cursor)?;
                            header.key = String::from_utf8_lossy(key).into_owned();
                        }
                        (2, 2) => {
                            let value = read_len_delim(entry, &mut entry_cursor)?;
                            header.value = String::from_utf8_lossy(value).into_owned();
                        }
                        _ => {
                            // 未知字段跳过（本结构只有 len-delim 字段）。
                            if entry_wire == 2 {
                                read_len_delim(entry, &mut entry_cursor)?;
                            } else if entry_wire == 0 {
                                read_varint(entry, &mut entry_cursor)?;
                            } else {
                                return None;
                            }
                        }
                    }
                }
                frame.headers.push(header);
            }
            (6, 2) | (7, 2) | (9, 2) => {
                read_len_delim(bytes, &mut cursor)?;
            }
            (8, 2) => {
                frame.payload = Some(read_len_delim(bytes, &mut cursor)?.to_vec());
            }
            (_, 0) => {
                read_varint(bytes, &mut cursor)?;
            }
            (field, 2) => {
                let _ = field;
                read_len_delim(bytes, &mut cursor)?;
            }
            _ => return None,
        }
    }
    Some(frame)
}

fn header_value<'a>(frame: &'a Frame, key: &str) -> Option<&'a str> {
    frame
        .headers
        .iter()
        .find(|header| header.key == key)
        .map(|header| header.value.as_str())
}

/* ------------------------------------------------------------------ *
 * 连接建立
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct EndpointResponse {
    code: i64,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    data: Option<EndpointData>,
}

#[derive(Deserialize)]
struct EndpointData {
    #[serde(rename = "URL")]
    url: String,
    #[serde(default)]
    client_config: Option<EndpointClientConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct EndpointClientConfig {
    #[serde(default)]
    ping_interval: Option<u64>,
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if name == key {
            return Some(value.to_string());
        }
    }
    None
}

/// 获取 WS URL。鉴权失败（code 403/514）返回 fatal=true，任务停止重试。
async fn fetch_endpoint_url(creds: &FeishuCreds) -> Result<Result<(String, u64, u64), String>, String> {
    let body = serde_json::to_string(&serde_json::json!({
        "AppID": creds.app_id,
        "AppSecret": creds.app_secret,
    }))
    .map_err(|error| format!("编码飞书长连接请求失败: {error}"))?;
    let response = http_client()
        .post(format!("{BASE_URL}/callback/ws/endpoint"))
        .header("locale", "zh")
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("获取飞书长连接地址失败: {error}"))?;
    let status = response.status();
    let payload: EndpointResponse = read_json(response).await?;
    if payload.code != 0 {
        let message = format!("飞书长连接鉴权失败（code {}）: {}", payload.code, payload.msg);
        // 403 Forbidden / 514 AuthFailed：凭证问题，停止重试直到用户修改配置。
        return Ok(Err(if payload.code == 403 || payload.code == 514 {
            format!("{message}（请检查 App ID / App Secret，以及应用是否开通了长连接模式）")
        } else {
            message
        }));
    }
    if !status.is_success() {
        return Ok(Err(format!("飞书长连接地址响应异常（HTTP {status}）")));
    }
    let data = payload.data.ok_or_else(|| "飞书长连接地址响应缺少 data".to_string())?;
    let service_id = query_param(&data.url, "service_id")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    Ok(Ok((
        data.url,
        service_id,
        data.client_config.and_then(|config| config.ping_interval).unwrap_or(120),
    )))
}

/* ------------------------------------------------------------------ *
 * 事件解析
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct EventEnvelope {
    #[serde(default)]
    header: Option<EventHeader>,
    #[serde(default)]
    event: Option<Value>,
}

#[derive(Deserialize, Default)]
struct EventHeader {
    #[serde(default)]
    event_type: String,
}

struct ParsedChatMessage {
    message_id: String,
    chat_id: String,
    chat_type: String,
    user_id: String,
    text: String,
    create_time_ms: i64,
    mention_keys: Vec<String>,
}

fn parse_receive_event(event: &Value) -> Option<ParsedChatMessage> {
    let message = event.get("message")?;
    let sender = event.get("sender")?;
    let message_type = message.get("message_type")?.as_str()?;
    if message_type != "text" {
        return None;
    }
    let content = message.get("content")?.as_str()?;
    let text = serde_json::from_str::<HashMap<String, Value>>(content)
        .ok()
        .and_then(|map| map.get("text")?.as_str().map(str::to_string))
        .unwrap_or_default();
    let mut cleaned = text;
    let mut mention_keys = Vec::new();
    if let Some(mentions) = message.get("mentions").and_then(Value::as_array) {
        for mention in mentions {
            if let Some(key) = mention.get("key").and_then(Value::as_str) {
                mention_keys.push(key.to_string());
                cleaned = cleaned.replace(key, "");
            }
        }
    }
    Some(ParsedChatMessage {
        message_id: message.get("message_id")?.as_str()?.to_string(),
        chat_id: message.get("chat_id")?.as_str()?.to_string(),
        chat_type: message.get("chat_type").and_then(Value::as_str).unwrap_or("p2p").to_string(),
        user_id: sender
            .pointer("/sender_id/open_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        text: cleaned.trim().to_string(),
        create_time_ms: message
            .get("create_time")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0),
        mention_keys,
    })
}

/* ------------------------------------------------------------------ *
 * 连接主循环
 * ------------------------------------------------------------------ */

pub(crate) async fn run_feishu(app: AppHandle, state: Arc<Mutex<ConnectInner>>, creds: FeishuCreds) {
    let mut attempt: u32 = 0;
    loop {
        set_status(&app, &state, ConnectPlatform::Feishu, ConnectStatusKind::Connecting, None);
        match run_feishu_once(&app, &state, &creds).await {
            Ok(()) => return, // fatal：凭证/配置错误，等待用户处理
            Err(error) => {
                set_status(
                    &app,
                    &state,
                    ConnectPlatform::Feishu,
                    ConnectStatusKind::Error,
                    Some(error),
                );
                tokio::time::sleep(sleep_backoff(attempt)).await;
                attempt += 1;
            }
        }
    }
}

async fn run_feishu_once(
    app: &AppHandle,
    state: &Arc<Mutex<ConnectInner>>,
    creds: &FeishuCreds,
) -> Result<(), String> {
    let (url, service_id, ping_interval_secs) = match fetch_endpoint_url(creds).await? {
        Ok(values) => values,
        Err(fatal) => {
            set_status(app, state, ConnectPlatform::Feishu, ConnectStatusKind::Error, Some(fatal));
            return Ok(());
        }
    };
    let (mut socket, _response) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| format!("飞书 WebSocket 连接失败: {error}"))?;
    reset_inbound_watermark(state, ConnectPlatform::Feishu);
    set_status(app, state, ConnectPlatform::Feishu, ConnectStatusKind::Connected, None);
    let mut ping_interval = tokio::time::interval(Duration::from_secs(ping_interval_secs.max(30)));
    ping_interval.tick().await; // 首个 tick 立即完成，跳过
    let mut ping_seq: u64 = now_ms() as u64;
    loop {
        let incoming = tokio::select! {
            _ = ping_interval.tick() => {
                ping_seq += 1;
                let ping = Frame {
                    seq_id: ping_seq,
                    log_id: ping_seq,
                    service: service_id as i32,
                    method: 0,
                    headers: vec![FrameHeader { key: "type".into(), value: "ping".into() }],
                    payload: None,
                };
                use futures_util::SinkExt;
                socket
                    .send(Message::Binary(encode_frame(&ping).into()))
                    .await
                    .map_err(|error| format!("飞书心跳发送失败: {error}"))?;
                continue;
            }
            frame = socket.next() => frame,
        };
        let message = match incoming {
            Some(Ok(message)) => message,
            Some(Err(error)) => return Err(format!("飞书 WebSocket 读取失败: {error}")),
            None => return Err("飞书 WebSocket 连接被关闭".into()),
        };
        let Message::Binary(bytes) = message else {
            continue;
        };
        let Some(frame) = decode_frame(&bytes) else {
            continue;
        };
        if frame.method == 0 {
            // pong：携带 ClientConfig 的热更新参数，忽略（重连时重新获取）。
            continue;
        }
        let event_type = header_value(&frame, "type").unwrap_or_default().to_string();
        if event_type != "event" {
            continue;
        }
        let payload = frame.payload.clone().unwrap_or_default();
        let parsed: Option<ParsedChatMessage> = serde_json::from_slice::<EventEnvelope>(&payload)
            .ok()
            .and_then(|envelope| {
                let header = envelope.header?;
                if header.event_type == "im.message.receive_v1" {
                    envelope.event.as_ref().and_then(parse_receive_event)
                } else {
                    None
                }
            });
        if let Some(parsed) = parsed {
            // 群聊必须 @机器人（mentions 非空或 @所有人）才处理，防刷屏。
            let is_group = parsed.chat_type == "group" || parsed.chat_type == "topic_group";
            let mentioned_all = parsed.text.contains("@_all");
            if !is_group || !parsed.mention_keys.is_empty() || mentioned_all {
                let cleaned = parsed.text.replace("@_all", "").trim().to_string();
                if !cleaned.is_empty() {
                    let inbound = InboundChatMessage {
                        platform: ConnectPlatform::Feishu,
                        chat_id: parsed.chat_id.clone(),
                        chat_type: parsed.chat_type.clone(),
                        user_id: parsed.user_id.clone(),
                        user_name: String::new(),
                        message_id: parsed.message_id.clone(),
                        text: cleaned,
                        create_time_ms: parsed.create_time_ms,
                        reply: ReplyContext::Feishu {
                            chat_id: parsed.chat_id.clone(),
                            message_id: parsed.message_id.clone(),
                        },
                    };
                    // 配对应答需要经 REST 回发：闭包按值克隆捕获（保持 Fn 语义，
                    // process_inbound 可能对同一消息只调用一次，但签名按 Fn 约束）。
                    let send = {
                        let app_for_send = app.clone();
                        let state_for_send = Arc::clone(state);
                        let creds_for_reply = creds.clone();
                        let context = inbound.reply.clone();
                        move |text: &str| {
                            let text = text.to_string();
                            let app = app_for_send.clone();
                            let state = Arc::clone(&state_for_send);
                            let creds = creds_for_reply.clone();
                            let context = context.clone();
                            async move {
                                send_reply(&app, state, creds, &context, &text)
                                    .await
                                    .map(|_| ())
                            }
                        }
                    };
                    let _ = super::process_inbound(app, state, inbound, send).await;
                }
            }
        }
        // 每个事件帧都要回 ack（payload 为 {"code":200}），否则服务端会重推。
        let mut ack = frame.clone();
        ack.headers.push(FrameHeader { key: "biz_rt".into(), value: "1".into() });
        ack.payload = Some(br#"{"code":200}"#.to_vec());
        use futures_util::SinkExt;
        if socket.send(Message::Binary(encode_frame(&ack).into())).await.is_err() {
            return Err("飞书 ack 发送失败".into());
        }
    }
}

/* ------------------------------------------------------------------ *
 * 出站回复（REST）
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct TenantTokenResponse {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    tenant_access_token: String,
    #[serde(default)]
    expire: i64,
}

async fn tenant_token(
    state: &Arc<Mutex<ConnectInner>>,
    creds: &FeishuCreds,
) -> Result<String, String> {
    if let Some(token) = cached_rest_token(state, ConnectPlatform::Feishu) {
        return Ok(token);
    }
    let body = serde_json::to_string(&serde_json::json!({
        "app_id": creds.app_id,
        "app_secret": creds.app_secret,
    }))
    .map_err(|error| format!("编码飞书 token 请求失败: {error}"))?;
    let response = http_client()
        .post(format!("{BASE_URL}/open-apis/auth/v3/tenant_access_token/internal"))
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("获取飞书 tenant_access_token 失败: {error}"))?;
    let payload: TenantTokenResponse = read_json(response).await?;
    if payload.code != 0 || payload.tenant_access_token.is_empty() {
        return Err(format!(
            "获取飞书 tenant_access_token 失败（code {}）",
            payload.code
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    cache_rest_token(
        state,
        ConnectPlatform::Feishu,
        payload.tenant_access_token.clone(),
        now + payload.expire,
    );
    Ok(payload.tenant_access_token)
}

fn looks_like_markdown(text: &str) -> bool {
    text.lines().any(|line| {
        line.starts_with('#')
            || line.starts_with("- ")
            || line.starts_with("* ")
            || line.starts_with("1. ")
            || line.starts_with("```")
            || (line.contains('|') && line.contains('-'))
    }) || text.contains("**")
        || text.contains("`")
}

fn reply_content(text: &str) -> (String, String) {
    if looks_like_markdown(text) {
        let card = serde_json::json!({
            "schema": "2.0",
            "config": { "wide_screen_mode": true },
            "body": { "elements": [ { "tag": "markdown", "content": text } ] },
        });
        ("interactive".to_string(), card.to_string())
    } else {
        ("text".to_string(), serde_json::json!({ "text": text }).to_string())
    }
}

fn split_chunks(text: &str, limit: usize) -> Vec<String> {
    if text.chars().count() <= limit {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        if current.chars().count() + line.chars().count() > limit && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        if line.chars().count() > limit {
            let mut remaining = line;
            while remaining.chars().count() > limit {
                let cut = remaining.char_indices().nth(limit).map_or(remaining.len(), |(index, _)| index);
                chunks.push(remaining[..cut].to_string());
                remaining = &remaining[cut..];
            }
            current.push_str(remaining);
        } else {
            current.push_str(line);
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

async fn post_message(
    token: &str,
    path: &str,
    query: Option<&str>,
    body: &Value,
) -> Result<(), String> {
    let url = match query {
        Some(query) => format!("{BASE_URL}{path}?{query}"),
        None => format!("{BASE_URL}{path}"),
    };
    let encoded = serde_json::to_string(body)
        .map_err(|error| format!("编码飞书消息失败: {error}"))?;
    let response = http_client()
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/json")
        .body(encoded)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("飞书消息发送失败: {error}"))?;
    let status = response.status();
    let payload: Value = read_json(response).await?;
    let code = payload.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if !status.is_success() || code != 0 {
        return Err(format!(
            "飞书消息发送失败（HTTP {status} / code {code}）: {}",
            payload.get("msg").and_then(Value::as_str).unwrap_or("")
        ));
    }
    Ok(())
}

pub(crate) async fn send_reply(
    _app: &AppHandle,
    state: Arc<Mutex<ConnectInner>>,
    creds: FeishuCreds,
    context: &ReplyContext,
    text: &str,
) -> Result<(), String> {
    let ReplyContext::Feishu { chat_id, message_id } = context else {
        return Err("回复上下文与平台不匹配".into());
    };
    let token = tenant_token(&state, &creds).await?;
    for chunk in split_chunks(text, REPLY_CHUNK_CHARS) {
        let (msg_type, content) = reply_content(&chunk);
        let uuid = super::random_hex(8);
        // 优先 reply（引用用户消息）；失败（消息过旧/无权限）回退按 chat_id 创建。
        let reply_body = serde_json::json!({ "msg_type": msg_type, "content": content, "uuid": uuid });
        let replied = post_message(
            &token,
            &format!("/open-apis/im/v1/messages/{message_id}/reply"),
            None,
            &reply_body,
        )
        .await;
        if let Err(reply_error) = replied {
            let create_body = serde_json::json!({
                "receive_id": chat_id,
                "msg_type": msg_type,
                "content": content,
                "uuid": format!("{uuid}-c"),
            });
            let created = post_message(
                &token,
                "/open-apis/im/v1/messages",
                Some("receive_id_type=chat_id"),
                &create_body,
            )
            .await;
            // 卡片被拒时降级纯文本重试一次（飞书 markdown 元素限制）；
            // 其余类型或降级也失败时把错误传出去——回发失败必须对上层可见，
            // 否则聊天侧只会看到「任务执行了但结果没回来」而没有任何线索。
            if let Err(create_error) = created {
                if msg_type == "interactive" {
                    let fallback = serde_json::json!({
                        "receive_id": chat_id,
                        "msg_type": "text",
                        "content": serde_json::json!({ "text": chunk }).to_string(),
                        "uuid": format!("{uuid}-t"),
                    });
                    if let Err(fallback_error) = post_message(
                        &token,
                        "/open-apis/im/v1/messages",
                        Some("receive_id_type=chat_id"),
                        &fallback,
                    )
                    .await
                    {
                        return Err(format!(
                            "回复消息失败：{reply_error}；按 chat_id 创建失败：{create_error}；卡片降级纯文本也失败：{fallback_error}"
                        ));
                    }
                } else {
                    return Err(format!(
                        "回复消息失败：{reply_error}；按 chat_id 创建失败：{create_error}"
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trips_through_protobuf_wire_format() {
        let frame = Frame {
            seq_id: 42,
            log_id: 7,
            service: 555,
            method: 1,
            headers: vec![
                FrameHeader { key: "type".into(), value: "event".into() },
                FrameHeader { key: "message_id".into(), value: "om_测试".into() },
            ],
            payload: Some(br#"{"schema":"2.0"}"#.to_vec()),
        };
        let decoded = decode_frame(&encode_frame(&frame)).expect("frame should decode");
        assert_eq!(decoded.seq_id, 42);
        assert_eq!(decoded.log_id, 7);
        assert_eq!(decoded.service, 555);
        assert_eq!(decoded.method, 1);
        assert_eq!(decoded.headers.len(), 2);
        assert_eq!(header_value(&decoded, "type"), Some("event"));
        assert_eq!(decoded.payload.as_deref(), Some(br#"{"schema":"2.0"}"#.as_slice()));
    }

    #[test]
    fn varint_encodes_multi_byte_values() {
        let mut buffer = Vec::new();
        write_varint(&mut buffer, 300);
        assert_eq!(buffer, vec![0xAC, 0x02]);
        assert_eq!(read_varint(&buffer, &mut 0), Some(300));
    }

    #[test]
    fn query_params_are_extracted_from_endpoint_url() {
        let url = "wss://example.com/ws?device_id=dev1&service_id=123&x=1";
        assert_eq!(query_param(url, "device_id").as_deref(), Some("dev1"));
        assert_eq!(query_param(url, "service_id").as_deref(), Some("123"));
        assert_eq!(query_param(url, "missing"), None);
    }

    #[test]
    fn receive_event_parses_text_and_strips_mentions() {
        let event = serde_json::json!({
            "sender": { "sender_id": { "open_id": "ou_1" }, "sender_type": "user" },
            "message": {
                "message_id": "om_1",
                "chat_id": "oc_1",
                "chat_type": "group",
                "message_type": "text",
                "content": "{\"text\":\"@_user_1 帮我看看\"}",
                "create_time": "1700000000000",
                "mentions": [ { "key": "@_user_1", "id": { "open_id": "ou_bot" } } ],
            },
        });
        let parsed = parse_receive_event(&event).expect("event should parse");
        assert_eq!(parsed.text, "帮我看看");
        assert_eq!(parsed.user_id, "ou_1");
        assert_eq!(parsed.create_time_ms, 1_700_000_000_000);
        assert_eq!(parsed.mention_keys, vec!["@_user_1"]);
    }

    #[test]
    fn non_text_messages_are_ignored() {
        let event = serde_json::json!({
            "sender": { "sender_id": { "open_id": "ou_1" } },
            "message": {
                "message_id": "om_2",
                "chat_id": "oc_1",
                "chat_type": "p2p",
                "message_type": "image",
                "content": "{\"image_key\":\"k\"}",
            },
        });
        assert!(parse_receive_event(&event).is_none());
    }

    #[test]
    fn markdown_detection_and_chunking() {
        assert!(looks_like_markdown("# 标题\n正文"));
        assert!(looks_like_markdown("包含 **加粗** 的文本"));
        assert!(!looks_like_markdown("普通中文句子。"));
        let chunks = split_chunks(&"行\n".repeat(3000), 100);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 100));
        assert_eq!(split_chunks("短文本", 100), vec!["短文本".to_string()]);
    }

    #[test]
    fn reply_content_uses_card_for_markdown() {
        let (msg_type, content) = reply_content("# 结果\n- 一");
        assert_eq!(msg_type, "interactive");
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["schema"], "2.0");
        let (msg_type, content) = reply_content("纯文本");
        assert_eq!(msg_type, "text");
        let parsed: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["text"], "纯文本");
    }
}
