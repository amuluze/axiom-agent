//! 钉钉 Stream 模式适配（官方长连接，JSON 文本帧）。
//!
//! 线协议（对照 dingtalk-stream-sdk-go v0.9.1）：
//! 1. `POST /v1.0/gateway/connections/open`（订阅在请求体声明，连上即生效）；
//! 2. WS = endpoint + "?ticket="；帧是 JSON 文本，`data` 是**双重编码**的 JSON 字符串；
//! 3. 服务端 SYSTEM/ping 帧必须回 ACK（code 200 + 原 messageId）；topic=disconnect 重连；
//! 4. 机器人消息 topic = /v1.0/im/bot/messages/get，处理后同样要回成功 ACK；
//! 5. 回复优先用消息里的 sessionWebhook（有有效期）；过期后走企业 API 主动推送
//!    （oauth2/accessToken + robot/oToMessages/batchSend 或 groupMessages/send）。

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
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::Message;

const OPEN_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const BOT_TOPIC: &str = "/v1.0/im/bot/messages/get";
/// 回复分块上限：钉钉 markdown 消息建议不超过 5000 字节，留足余量。
const REPLY_CHUNK_CHARS: usize = 3_800;

#[derive(Clone)]
pub(crate) struct DingtalkCreds {
    pub client_id: String,
    pub client_secret: String,
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
        .map_err(|error| format!("读取钉钉响应失败: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析钉钉响应失败: {error}"))
}

/* ------------------------------------------------------------------ *
 * 连接建立
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct OpenResponse {
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    ticket: String,
}

async fn open_connection(creds: &DingtalkCreds) -> Result<Result<(String, String), String>, String> {
    let body = serde_json::to_string(&serde_json::json!({
        "clientId": creds.client_id,
        "clientSecret": creds.client_secret,
        "subscriptions": [
            { "type": "SYSTEM", "topic": "ping" },
            { "type": "SYSTEM", "topic": "disconnect" },
            { "type": "CALLBACK", "topic": BOT_TOPIC },
        ],
        "ua": "axiom-desktop",
    }))
    .map_err(|error| format!("编码钉钉接入请求失败: {error}"))?;
    let response = http_client()
        .post(OPEN_URL)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| format!("钉钉 Stream 接入失败: {error}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(Err("钉钉 Stream 鉴权失败（请检查 Client ID / Client Secret）".into()));
    }
    let payload: OpenResponse = read_json(response).await?;
    if payload.endpoint.is_empty() || payload.ticket.is_empty() {
        return Ok(Err(format!("钉钉 Stream 接入响应无效（HTTP {status}）")));
    }
    Ok(Ok((payload.endpoint, payload.ticket)))
}

/* ------------------------------------------------------------------ *
 * 帧解析
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct DataFrame {
    #[serde(default)]
    headers: FrameHeaders,
    #[serde(default)]
    data: String,
}

#[derive(Deserialize, Default)]
struct FrameHeaders {
    #[serde(default, rename = "topic")]
    topic: String,
    #[serde(default, rename = "messageId")]
    message_id: String,
}

fn ack_frame(message_id: &str) -> String {
    serde_json::json!({
        "code": 200,
        "headers": { "contentType": "application/json", "messageId": message_id },
        "message": "ok",
        "data": "",
    })
    .to_string()
}

struct BotMessage {
    conversation_id: String,
    conversation_type: String,
    sender_staff_id: String,
    sender_nick: String,
    msg_id: String,
    text: String,
    create_at_ms: i64,
    session_webhook: String,
    session_webhook_expired_ms: i64,
}

fn parse_bot_message(data: &str) -> Option<BotMessage> {
    let value: Value = serde_json::from_str(data).ok()?;
    // MVP 只消费 text；richText/audio/image 等暂不支持。
    let msgtype = value.get("msgtype")?.as_str()?;
    if msgtype != "text" {
        return None;
    }
    let text = value
        .pointer("/text/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    Some(BotMessage {
        conversation_id: value.get("conversationId")?.as_str()?.to_string(),
        conversation_type: value
            .get("conversationType")
            .and_then(Value::as_str)
            .unwrap_or("1")
            .to_string(),
        sender_staff_id: value
            .get("senderStaffId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .or_else(|| value.get("senderId").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
        sender_nick: value
            .get("senderNick")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        msg_id: value.get("msgId")?.as_str()?.to_string(),
        text,
        create_at_ms: value.get("createAt").and_then(Value::as_i64).unwrap_or(0),
        session_webhook: value
            .get("sessionWebhook")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        session_webhook_expired_ms: value
            .get("sessionWebhookExpiredTime")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    })
}

/* ------------------------------------------------------------------ *
 * 连接主循环
 * ------------------------------------------------------------------ */

pub(crate) async fn run_dingtalk(app: AppHandle, state: Arc<Mutex<ConnectInner>>, creds: DingtalkCreds) {
    let mut attempt: u32 = 0;
    loop {
        set_status(&app, &state, ConnectPlatform::Dingtalk, ConnectStatusKind::Connecting, None);
        match run_dingtalk_once(&app, &state, &creds).await {
            Ok(()) => return,
            Err(error) => {
                set_status(
                    &app,
                    &state,
                    ConnectPlatform::Dingtalk,
                    ConnectStatusKind::Error,
                    Some(error),
                );
                tokio::time::sleep(sleep_backoff(attempt)).await;
                attempt += 1;
            }
        }
    }
}

async fn run_dingtalk_once(
    app: &AppHandle,
    state: &Arc<Mutex<ConnectInner>>,
    creds: &DingtalkCreds,
) -> Result<(), String> {
    let (endpoint, ticket) = match open_connection(creds).await? {
        Ok(values) => values,
        Err(fatal) => {
            set_status(app, state, ConnectPlatform::Dingtalk, ConnectStatusKind::Error, Some(fatal));
            return Ok(());
        }
    };
    let (mut socket, _response) =
        tokio_tungstenite::connect_async(format!("{endpoint}?ticket={ticket}"))
            .await
            .map_err(|error| format!("钉钉 WebSocket 连接失败: {error}"))?;
    reset_inbound_watermark(state, ConnectPlatform::Dingtalk);
    set_status(app, state, ConnectPlatform::Dingtalk, ConnectStatusKind::Connected, None);
    // 协议层保活：服务端有应用层 ping，这里再兜一层 WS ping，防中间设备空闲断连。
    let mut ws_ping = tokio::time::interval(Duration::from_secs(45));
    ws_ping.tick().await;
    loop {
        let incoming = tokio::select! {
            _ = ws_ping.tick() => {
                use futures_util::SinkExt;
                socket.send(Message::Ping(Vec::new().into())).await.map_err(|error| format!("钉钉 WS ping 失败: {error}"))?;
                continue;
            }
            frame = socket.next() => frame,
        };
        let message = match incoming {
            Some(Ok(message)) => message,
            Some(Err(error)) => return Err(format!("钉钉 WebSocket 读取失败: {error}")),
            None => return Err("钉钉 WebSocket 连接被关闭".into()),
        };
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<DataFrame>(&text) else {
            continue;
        };
        let topic = frame.headers.topic.as_str();
        if topic == "ping" {
            use futures_util::SinkExt;
            socket
                .send(Message::Text(ack_frame(&frame.headers.message_id).into()))
                .await
                .map_err(|error| format!("钉钉心跳应答失败: {error}"))?;
            continue;
        }
        if topic == "disconnect" {
            return Err("钉钉服务端要求断开，正在重连".into());
        }
        if topic != BOT_TOPIC {
            continue;
        }
        if let Some(bot_message) = parse_bot_message(&frame.data) {
            if !bot_message.text.is_empty() && !bot_message.sender_staff_id.is_empty() {
                let chat_type = if bot_message.conversation_type == "2" { "group" } else { "p2p" };
                let inbound = InboundChatMessage {
                    platform: ConnectPlatform::Dingtalk,
                    chat_id: bot_message.conversation_id.clone(),
                    chat_type: chat_type.to_string(),
                    user_id: bot_message.sender_staff_id.clone(),
                    user_name: bot_message.sender_nick.clone(),
                    message_id: bot_message.msg_id.clone(),
                    text: bot_message.text,
                    create_time_ms: bot_message.create_at_ms,
                    reply: ReplyContext::Dingtalk {
                        session_webhook: bot_message.session_webhook.clone(),
                        session_webhook_expired_time_ms: bot_message.session_webhook_expired_ms,
                        conversation_id: bot_message.conversation_id.clone(),
                        sender_staff_id: bot_message.sender_staff_id.clone(),
                        conversation_type: bot_message.conversation_type.clone(),
                    },
                };
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
                            send_reply(&app, state, creds, &context, &text).await.map(|_| ())
                        }
                    }
                };
                let _ = super::process_inbound(app, state, inbound, send).await;
            }
        }
        use futures_util::SinkExt;
        if socket
            .send(Message::Text(ack_frame(&frame.headers.message_id).into()))
            .await
            .is_err()
        {
            return Err("钉钉消息 ACK 发送失败".into());
        }
    }
}

/* ------------------------------------------------------------------ *
 * 出站回复
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct AccessTokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expire_in: i64,
}

async fn access_token(
    state: &Arc<Mutex<ConnectInner>>,
    creds: &DingtalkCreds,
) -> Result<String, String> {
    if let Some(token) = cached_rest_token(state, ConnectPlatform::Dingtalk) {
        return Ok(token);
    }
    let body = serde_json::to_string(&serde_json::json!({
        "appKey": creds.client_id,
        "appSecret": creds.client_secret,
    }))
    .map_err(|error| format!("编码钉钉 token 请求失败: {error}"))?;
    let response = http_client()
        .post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("获取钉钉 accessToken 失败: {error}"))?;
    let payload: AccessTokenResponse = read_json(response).await?;
    if payload.access_token.is_empty() {
        return Err("获取钉钉 accessToken 失败".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    cache_rest_token(
        state,
        ConnectPlatform::Dingtalk,
        payload.access_token.clone(),
        now + payload.expire_in,
    );
    Ok(payload.access_token)
}

fn chunk_text(text: &str, limit: usize) -> Vec<String> {
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
                let cut = remaining
                    .char_indices()
                    .nth(limit)
                    .map_or(remaining.len(), |(index, _)| index);
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

fn markdown_title(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().chars().take(30).collect::<String>())
        .unwrap_or_else(|| "Axiom".to_string())
}

async fn post_json(url: &str, body: &Value, token: Option<&str>) -> Result<(), String> {
    let encoded = serde_json::to_string(body)
        .map_err(|error| format!("编码钉钉消息失败: {error}"))?;
    let mut request = http_client()
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .body(encoded);
    if let Some(token) = token {
        request = request.header("x-acs-dingtalk-access-token", token);
    }
    let response = request
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("钉钉消息发送失败: {error}"))?;
    let status = response.status();
    // 钉钉 webhook / 企业 API 失败时返回非 2xx，body 为错误说明。
    let body_text = response
        .text()
        .await
        .unwrap_or_default();
    if !status.is_success() {
        return Err(format!("钉钉消息发送失败（HTTP {status}）: {body_text}"));
    }
    Ok(())
}

pub(crate) async fn send_reply(
    app: &AppHandle,
    state: Arc<Mutex<ConnectInner>>,
    creds: DingtalkCreds,
    context: &ReplyContext,
    text: &str,
) -> Result<(), String> {
    let ReplyContext::Dingtalk {
        session_webhook,
        session_webhook_expired_time_ms,
        conversation_id,
        sender_staff_id,
        conversation_type,
    } = context
    else {
        return Err("回复上下文与平台不匹配".into());
    };
    let _ = app;
    for chunk in chunk_text(text, REPLY_CHUNK_CHARS) {
        let markdown = serde_json::json!({
            "msgtype": "markdown",
            "markdown": { "title": markdown_title(&chunk), "text": chunk },
            "at": { "isAtAll": false },
        });
        // sessionWebhook 是临时通道（默认 ~90s 有效）；过期后走企业主动推送。
        let webhook_usable = !session_webhook.is_empty()
            && (*session_webhook_expired_time_ms == 0
                || *session_webhook_expired_time_ms > now_ms() + 30_000);
        if webhook_usable && post_json(session_webhook, &markdown, None).await.is_ok() {
            continue;
        }
        let token = access_token(&state, &creds).await?;
        let robot_code = creds.client_id.clone();
        let title = markdown_title(&chunk);
        if conversation_type == "2" {
            let body = serde_json::json!({
                "robotCode": robot_code,
                "openConversationId": conversation_id,
                "msgKey": "sampleMarkdown",
                "msgParam": serde_json::json!({ "title": title, "text": chunk }).to_string(),
            });
            post_json(
                "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
                &body,
                Some(&token),
            )
            .await?;
        } else {
            let body = serde_json::json!({
                "robotCode": robot_code,
                "userIds": [sender_staff_id],
                "msgKey": "sampleMarkdown",
                "msgParam": serde_json::json!({ "title": title, "text": chunk }).to_string(),
            });
            post_json(
                "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
                &body,
                Some(&token),
            )
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_frame_echoes_message_id_with_ok() {
        let ack: Value = serde_json::from_str(&ack_frame("m-1")).unwrap();
        assert_eq!(ack["code"], 200);
        assert_eq!(ack["headers"]["messageId"], "m-1");
        assert_eq!(ack["message"], "ok");
    }

    #[test]
    fn bot_message_parses_text_payload() {
        let data = serde_json::json!({
            "conversationId": "cid1",
            "conversationType": "1",
            "senderStaffId": "staff1",
            "senderNick": "李四",
            "msgId": "msg1",
            "createAt": 1_700_000_000_000_i64,
            "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession/x",
            "sessionWebhookExpiredTime": 1_700_000_090_000_i64,
            "msgtype": "text",
            "text": { "content": " 帮我修个 bug " },
        })
        .to_string();
        let parsed = parse_bot_message(&data).expect("bot message should parse");
        assert_eq!(parsed.text, "帮我修个 bug");
        assert_eq!(parsed.sender_staff_id, "staff1");
        assert_eq!(parsed.conversation_id, "cid1");
        assert!(!parsed.session_webhook.is_empty());
    }

    #[test]
    fn non_text_bot_messages_are_ignored() {
        let data = serde_json::json!({
            "conversationId": "cid1",
            "senderStaffId": "staff1",
            "msgId": "msg2",
            "msgtype": "picture",
            "content": { "downloadCode": "x" },
        })
        .to_string();
        assert!(parse_bot_message(&data).is_none());
    }

    #[test]
    fn chunking_respects_char_boundaries() {
        let chunks = chunk_text(&"句子。\n".repeat(2000), 200);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 200));
        assert_eq!(chunk_text("短", 100), vec!["短".to_string()]);
    }

    #[test]
    fn markdown_title_takes_first_non_empty_line() {
        assert_eq!(markdown_title("\n# 标题很长的啊".to_string().as_str()), "# 标题很长的啊");
        assert_eq!(markdown_title(""), "Axiom");
    }
}
