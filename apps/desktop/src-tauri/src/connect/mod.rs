//! 「连接」远程操控通道：飞书 / 钉钉 / 微信个人号 三平台适配 + 配对绑定。
//!
//! 架构约束：
//! - 凭证（App Secret / Client Secret / 微信 token）只进本地密钥库
//!   （axiom.db `secrets` 表 `connect.` 命名空间，经 secrets.rs 独占辅助函数
//!   读写），非密配置存
//!   `~/.axiom/connect/config.json`（0600，Rust 独占）。
//! - 长连接任务（飞书 WS / 钉钉 Stream / 微信长轮询）由本模块持有，
//!   入站消息经 `axiom:connect-event` 推给 WebView，由 connectService 路由到
//!   agentStore；出站回复经 `connect_reply_message` 命令回流。
//! - 只有「配对绑定」过的聊天（平台 + 聊天 + 用户三元组）可以操控会话：
//!   配对码由桌面端生成（10 分钟有效、生成即作废旧码），或微信扫码登录自动绑定。
//! - 锁序约定：任何路径都不得同时持有 `ConnectInner` 锁与 `SecretState` 锁——
//!   需要两者时先取 ConnectInner 的数据并释放，再访问密钥库。

mod dingtalk;
mod feishu;
mod weixin;

use crate::secrets::{
    delete_connect_secret, load_connect_secret, save_connect_secret, SecretState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const CONNECT_EVENT: &str = "axiom:connect-event";
const CONFIG_SCHEMA_VERSION: u32 = 1;
const MAX_SEEN_MESSAGES: usize = 1024;
const PAIRING_CODE_TTL_MS: u64 = 10 * 60 * 1000;
/// 同一聊天在 30 秒滑动窗口内 `/bind` 失败 ≥ PAIRING_MAX_ATTEMPTS 次即进入短暂锁定，
/// 抑制 6 位数字码在 10 分钟 TTL 内的穷举面。作用域收窄到单个聊天（platform+chat_id），
/// 避免未绑定用户封死整个平台的配对入口。
const PAIRING_MAX_ATTEMPTS: usize = 5;
/// 连续失败后锁定该聊天的时间：锁定窗口内只拒绝**错误的码**；提交正确码不受影响。
const PAIRING_LOCKOUT_MS: i64 = 30_000;
/// 入站消息文本上限：防止超长消息撑爆事件通道。
const MAX_INBOUND_TEXT_BYTES: usize = 32 * 1024;
/// 旧消息水位：连接建立时丢弃早于（现在 - 该窗口）的消息，避免长连接
/// 摘要模式在重连后重放离线期间的旧消息。
const OLD_MESSAGE_GRACE_MS: i64 = 120_000;
/// 同时保留的扫码登录会话数（新会话挤掉最旧的）。
const MAX_WECHAT_LOGIN_SESSIONS: usize = 4;

const FEISHU_SECRET_KEY: &str = "connect.feishu.app-secret";
const DINGTALK_SECRET_KEY: &str = "connect.dingtalk.client-secret";
const WEIXIN_SECRET_KEY: &str = "connect.weixin.bot-token";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConnectPlatform {
    Feishu,
    Dingtalk,
    Weixin,
}

impl ConnectPlatform {
    pub(crate) const ALL: [ConnectPlatform; 3] = [
        ConnectPlatform::Feishu,
        ConnectPlatform::Dingtalk,
        ConnectPlatform::Weixin,
    ];
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConnectStatusKind {
    Unconfigured,
    Disconnected,
    Connecting,
    Connected,
    Error,
}

/// 出站回复上下文：由入站消息捕获（飞书 reply 目标 / 钉钉 webhook / 微信
/// context_token）。没有上下文就无法主动回复——微信协议规定必须先收到用户消息。
#[derive(Clone, Debug)]
pub(crate) enum ReplyContext {
    Feishu {
        chat_id: String,
        message_id: String,
    },
    Dingtalk {
        session_webhook: String,
        session_webhook_expired_time_ms: i64,
        conversation_id: String,
        sender_staff_id: String,
        conversation_type: String,
    },
    Weixin {
        to_user_id: String,
        context_token: String,
    },
}

/// 平台适配器交给共享入站处理器的规范化消息。
pub(crate) struct InboundChatMessage {
    pub platform: ConnectPlatform,
    pub chat_id: String,
    /// "p2p" | "group"。
    pub chat_type: String,
    pub user_id: String,
    pub user_name: String,
    pub message_id: String,
    pub text: String,
    /// 毫秒；0 表示平台未提供。
    pub create_time_ms: i64,
    pub reply: ReplyContext,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredBinding {
    pub platform: ConnectPlatform,
    pub chat_id: String,
    pub chat_type: String,
    pub user_id: String,
    pub user_name: String,
    pub paired_at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PlatformIdConfig {
    enabled: bool,
    /// 飞书 App ID（cli_ 开头）/ 钉钉 Client ID（AppKey）。非密，存配置文件。
    account_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct WeixinConfig {
    enabled: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ConnectConfigFile {
    schema_version: u32,
    workspace_path: Option<String>,
    feishu: PlatformIdConfig,
    dingtalk: PlatformIdConfig,
    weixin: WeixinConfig,
    bindings: Vec<StoredBinding>,
}

pub(crate) struct PairingCode {
    code: String,
    expires_at_ms: u64,
}

pub(crate) struct WechatLoginSession {
    pub rows: Vec<String>,
    pub status: weixin::WechatLoginStatus,
}

pub(crate) struct PlatformInbound {
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    watermark_ms: i64,
}

pub(crate) struct ConnectInner {
    pub(crate) config: ConnectConfigFile,
    pub(crate) statuses: HashMap<ConnectPlatform, (ConnectStatusKind, Option<String>)>,
    pub(crate) tasks: HashMap<ConnectPlatform, tauri::async_runtime::JoinHandle<()>>,
    pub(crate) pairing: Option<PairingCode>,
    pub(crate) logins: HashMap<String, WechatLoginSession>,
    pub(crate) reply_contexts: HashMap<(ConnectPlatform, String, String), ReplyContext>,
    pub(crate) inbounds: HashMap<ConnectPlatform, PlatformInbound>,
    /// 飞书 tenant_access_token / 钉钉 accessToken 缓存（token, 到期时刻秒）。
    pub(crate) feishu_token: Option<(String, i64)>,
    pub(crate) dingtalk_token: Option<(String, i64)>,
    /// 单聊天（platform+chat_id）最近一次连续 `/bind` 失败时间戳（毫秒，保留最近
    /// PAIRING_MAX_ATTEMPTS 次）。超出阈值即锁定该聊天；配对成功会清空，重置计数。
    /// 以聊天为键而非平台：防止未绑定用户连发错误码封死整个平台的配对入口。
    pairing_failures: HashMap<(ConnectPlatform, String), VecDeque<i64>>,
}

impl ConnectInner {
    fn new() -> Self {
        let statuses = ConnectPlatform::ALL
            .into_iter()
            .map(|platform| (platform, (ConnectStatusKind::Unconfigured, None)))
            .collect();
        Self {
            config: ConnectConfigFile::default(),
            statuses,
            tasks: HashMap::new(),
            pairing: None,
            logins: HashMap::new(),
            reply_contexts: HashMap::new(),
            inbounds: HashMap::new(),
            feishu_token: None,
            dingtalk_token: None,
            pairing_failures: HashMap::new(),
        }
    }
}

impl Default for ConnectInner {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
pub(crate) struct ConnectState {
    inner: Arc<Mutex<ConnectInner>>,
    initialized: Mutex<bool>,
}

impl ConnectState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ConnectInner>, String> {
        self.inner.lock().map_err(|_| "connect state lock is poisoned".to_string())
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// /dev/urandom 随机字节（macOS 本地足够，避免引入 rand 依赖面）。
pub(crate) fn random_bytes(count: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buffer = vec![0_u8; count];
    if let Ok(mut file) = fs::File::open("/dev/urandom") {
        if file.read_exact(&mut buffer).is_ok() {
            return buffer;
        }
    }
    // 兜底：时间熵打散（仅配对码 / client_id 等非密码学关键场景使用）。
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0x9E_37_79_B9_7F_4A_7C_15);
    for byte in buffer.iter_mut() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *byte = (seed & 0xFF) as u8;
    }
    buffer
}

pub(crate) fn random_hex(count: usize) -> String {
    random_bytes(count).iter().map(|byte| format!("{byte:02x}")).collect()
}

/* ------------------------------------------------------------------ *
 * 配置持久化（~/.axiom/connect/config.json，0600，Rust 独占）
 * ------------------------------------------------------------------ */

pub(crate) fn connect_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = crate::storage_paths::axiom_data_root(app)?;
    let directory = root.join("connect");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create connect dir: {error}"))?;
    Ok(directory)
}

fn load_config_from(directory: &std::path::Path) -> Result<ConnectConfigFile, String> {
    let path = directory.join("config.json");
    match fs::metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConnectConfigFile {
                schema_version: CONFIG_SCHEMA_VERSION,
                ..ConnectConfigFile::default()
            })
        }
        Err(error) => return Err(format!("failed to inspect connect config: {error}")),
    }
    let bytes = fs::read(&path).map_err(|error| format!("failed to read connect config: {error}"))?;
    let config: ConnectConfigFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("connect config is invalid: {error}"))?;
    // 只拒绝「更新版本写入的配置」（降级运行时读不懂其语义，fail-closed 不丢数据）；
    // 旧版本（含缺字段被 serde 默认值补齐的 0）一律接受，由 initialize 回写当前版本。
    if config.schema_version > CONFIG_SCHEMA_VERSION {
        return Err(format!(
            "connect config schema version {} is newer than supported {}",
            config.schema_version, CONFIG_SCHEMA_VERSION
        ));
    }
    Ok(config)
}

fn persist_config_to(directory: &std::path::Path, config: &ConnectConfigFile) -> Result<(), String> {
    let encoded = serde_json::to_vec(config)
        .map_err(|error| format!("failed to encode connect config: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("failed to stage connect config: {error}"))?;
    use std::io::Write;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure connect config: {error}"))?;
    }
    temporary
        .write_all(&encoded)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("failed to sync connect config: {error}"))?;
    temporary
        .persist(directory.join("config.json"))
        .map(|_| ())
        .map_err(|error| format!("failed to commit connect config: {}", error.error))?;
    Ok(())
}

fn persist_config(app: &AppHandle, config: &ConnectConfigFile) -> Result<(), String> {
    persist_config_to(&connect_dir(app)?, config)
}

/* ------------------------------------------------------------------ *
 * 状态与事件
 * ------------------------------------------------------------------ */

// rename_all 只作用于 variant 名（tag 值）；字段必须另用 rename_all_fields 转
// camelCase——否则 WebView 读 event.chatId 得到 undefined，回发路由全断。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub(crate) enum ConnectEventPayload {
    Status {
        platform: ConnectPlatform,
        status: ConnectStatusKind,
        message: Option<String>,
    },
    Message {
        platform: ConnectPlatform,
        chat_id: String,
        chat_type: String,
        user_id: String,
        user_name: String,
        message_id: String,
        text: String,
    },
    Paired {
        platform: ConnectPlatform,
        chat_id: String,
        chat_type: String,
        user_id: String,
        user_name: String,
    },
}

pub(crate) fn set_status(
    app: &AppHandle,
    state: &Arc<Mutex<ConnectInner>>,
    platform: ConnectPlatform,
    status: ConnectStatusKind,
    message: Option<String>,
) {
    let payload = {
        let mut inner = match state.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        inner.statuses.insert(platform, (status, message.clone()));
        ConnectEventPayload::Status { platform, status, message }
    };
    let _ = app.emit(CONNECT_EVENT, payload);
}

pub(crate) fn reset_inbound_watermark(state: &Arc<Mutex<ConnectInner>>, platform: ConnectPlatform) {
    if let Ok(mut inner) = state.lock() {
        let inbound = inner.inbounds.entry(platform).or_insert_with(|| PlatformInbound {
            seen: HashSet::new(),
            seen_order: VecDeque::new(),
            watermark_ms: 0,
        });
        inbound.watermark_ms = now_ms() - OLD_MESSAGE_GRACE_MS;
    }
}

/* ------------------------------------------------------------------ *
 * 入站共享处理（去重 / 水位 / 绑定 / 配对）
 * ------------------------------------------------------------------ */

/// 判定某平台是否处于配对锁定窗口：最近 PAIRING_LOCKOUT_MS 内的失败次数 ≥ 阈值。
pub(crate) fn is_pairing_locked(failures: &VecDeque<i64>, now: i64) -> bool {
    failures
        .iter()
        .filter(|at| now - **at < PAIRING_LOCKOUT_MS)
        .count()
        >= PAIRING_MAX_ATTEMPTS
}

/// 清理锁定窗口之外的过期失败记录，并把新增失败 append 进队列（仍截断到窗口内）。
pub(crate) fn record_pairing_failure(failures: &mut VecDeque<i64>, now: i64) {
    failures.retain(|at| now - *at < PAIRING_LOCKOUT_MS);
    failures.push_back(now);
}

/// 把新的配对绑定合并进绑定列表：同 platform+chat_id+user_id 三元组已存在则仅刷新
/// 字段（paired_at / chat_type / user_name），否则追加。返回是否发生了追加（新增绑定）。
pub(crate) fn upsert_binding(
    bindings: &mut Vec<StoredBinding>,
    platform: ConnectPlatform,
    chat_id: &str,
    chat_type: &str,
    user_id: &str,
    user_name: &str,
    paired_at: i64,
) -> bool {
    if let Some(existing) = bindings.iter_mut().find(|binding| {
        binding.platform == platform && binding.chat_id == chat_id && binding.user_id == user_id
    }) {
        existing.paired_at = paired_at;
        existing.chat_type = chat_type.to_string();
        existing.user_name = user_name.to_string();
        false
    } else {
        bindings.push(StoredBinding {
            platform,
            chat_id: chat_id.to_string(),
            chat_type: chat_type.to_string(),
            user_id: user_id.to_string(),
            user_name: user_name.to_string(),
            paired_at,
        });
        true
    }
}

pub(crate) enum InboundOutcome {
    /// 已配对：已 emit 给 WebView（reply 上下文已登记）。
    Dispatched,
    /// 已完成配对并回复。
    Paired,
    /// 未配对且不构成配对请求：静默丢弃（或已回复指引）。
    Ignored,
    Duplicated,
    TooOld,
    TooLarge,
}

pub(crate) async fn process_inbound<S, F>(
    app: &AppHandle,
    state: &Arc<Mutex<ConnectInner>>,
    message: InboundChatMessage,
    send: S,
) -> InboundOutcome
where
    S: Fn(&str) -> F,
    F: std::future::Future<Output = Result<(), String>>,
{
    if message.text.len() > MAX_INBOUND_TEXT_BYTES {
        return InboundOutcome::TooLarge;
    }
    let binding_key = (message.platform, message.chat_id.clone(), message.user_id.clone());
    let dispatch = {
        let mut inner = match state.lock() {
            Ok(inner) => inner,
            Err(_) => return InboundOutcome::Ignored,
        };
        let inbound = inner
            .inbounds
            .entry(message.platform)
            .or_insert_with(|| PlatformInbound {
                seen: HashSet::new(),
                seen_order: VecDeque::new(),
                watermark_ms: 0,
            });
        if inbound.seen.contains(&message.message_id) {
            return InboundOutcome::Duplicated;
        }
        inbound.seen.insert(message.message_id.clone());
        inbound.seen_order.push_back(message.message_id.clone());
        while inbound.seen_order.len() > MAX_SEEN_MESSAGES {
            if let Some(oldest) = inbound.seen_order.pop_front() {
                inbound.seen.remove(&oldest);
            }
        }
        if message.create_time_ms > 0 && message.create_time_ms < inbound.watermark_ms {
            return InboundOutcome::TooOld;
        }
        inner.reply_contexts.insert(binding_key, message.reply.clone());
        let bound = inner.config.bindings.iter().any(|binding| {
            binding.platform == message.platform
                && binding.chat_id == message.chat_id
                && binding.user_id == message.user_id
        });
        if bound {
            Some(ConnectEventPayload::Message {
                platform: message.platform,
                chat_id: message.chat_id.clone(),
                chat_type: message.chat_type.clone(),
                user_id: message.user_id.clone(),
                user_name: message.user_name.clone(),
                message_id: message.message_id.clone(),
                text: message.text.clone(),
            })
        } else {
            None
        }
    };
    if let Some(payload) = dispatch {
        let _ = app.emit(CONNECT_EVENT, payload);
        return InboundOutcome::Dispatched;
    }

    // 未配对：只认 /bind <code>；其余命令回指引，普通消息静默丢弃。
    let trimmed = message.text.trim();
    if let Some(code) = trimmed.strip_prefix("/bind") {
        let code = code.trim();
        let outcome = {
            let mut inner = match state.lock() {
                Ok(inner) => inner,
                Err(_) => return InboundOutcome::Ignored,
            };
            let now = now_ms();
            // 先判配对码是否匹配：持正确码的合法用户永远不被锁定拦截（避免拒绝服务）。
            let matches = inner
                .pairing
                .as_ref()
                .map(|pairing| pairing.code == code && pairing.expires_at_ms > now as u64)
                .unwrap_or(false);
            if matches {
                inner.pairing = None;
                // 成功即清空该聊天的计数，重置限速窗口。
                let failure_key = (message.platform, message.chat_id.clone());
                inner.pairing_failures.remove(&failure_key);
                // 绑定去重/刷新：同三元组已存在则仅刷新字段，不重复 push。
                upsert_binding(
                    &mut inner.config.bindings,
                    message.platform,
                    &message.chat_id,
                    &message.chat_type,
                    &message.user_id,
                    &message.user_name,
                    now,
                );
                let config = inner.config.clone();
                drop(inner);
                if persist_config(app, &config).is_err() {
                    return InboundOutcome::Ignored;
                }
                (true, "") // 成功回复在下方统一发送
            } else {
                // 码不匹配/已过期：查该聊天的锁定状态；若已锁定直接拒绝，否则记一次失败。
                let failure_key = (message.platform, message.chat_id.clone());
                let failures = inner.pairing_failures.entry(failure_key).or_default();
                if is_pairing_locked(failures, now) {
                    (false, "配对尝试过多，请稍后再试。")
                } else {
                    record_pairing_failure(failures, now);
                    (false, "配对码无效或已过期，请在 Axiom 连接面板重新生成。")
                }
            }
        };
        if outcome.0 {
            let _ = app.emit(CONNECT_EVENT, ConnectEventPayload::Paired {
                platform: message.platform,
                chat_id: message.chat_id.clone(),
                chat_type: message.chat_type.clone(),
                user_id: message.user_id.clone(),
                user_name: message.user_name.clone(),
            });
            let _ = send("✅ 已连接 Axiom，现在可以直接发消息操控会话。发送 /help 查看用法。").await;
            return InboundOutcome::Paired;
        }
        let _ = send(outcome.1).await;
        return InboundOutcome::Ignored;
    }
    if trimmed.starts_with('/') {
        let _ = send("此聊天尚未与 Axiom 配对。请在 Axiom 连接面板生成配对码，然后发送：/bind <配对码>").await;
    }
    InboundOutcome::Ignored
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

fn load_platform_secret(
    app: &AppHandle,
    platform: ConnectPlatform,
) -> Result<Option<String>, String> {
    let secret_state: tauri::State<'_, SecretState> = app.state();
    load_connect_secret(&secret_state, platform_secret_key(platform))
}

fn platform_secret_key(platform: ConnectPlatform) -> &'static str {
    match platform {
        ConnectPlatform::Feishu => FEISHU_SECRET_KEY,
        ConnectPlatform::Dingtalk => DINGTALK_SECRET_KEY,
        ConnectPlatform::Weixin => WEIXIN_SECRET_KEY,
    }
}

fn spawn_platform(app: &AppHandle, state: &ConnectState, platform: ConnectPlatform) -> Result<(), String> {
    let shared = state.inner.clone();
    {
        let mut inner = state.lock()?;
        // 先停旧任务（连接任务自身不感知取消，靠 abort 收尾）。
        if let Some(handle) = inner.tasks.remove(&platform) {
            handle.abort();
        }
    }
    let app_handle = app.clone();
    let handle = match platform {
        ConnectPlatform::Feishu => {
            let app_id = state.lock()?.config.feishu.account_id.clone();
            let app_secret = load_platform_secret(app, ConnectPlatform::Feishu)?
                .ok_or_else(|| "飞书 App Secret 未配置".to_string())?;
            tauri::async_runtime::spawn(feishu::run_feishu(
                app_handle,
                shared,
                feishu::FeishuCreds { app_id, app_secret },
            ))
        }
        ConnectPlatform::Dingtalk => {
            let client_id = state.lock()?.config.dingtalk.account_id.clone();
            let client_secret = load_platform_secret(app, ConnectPlatform::Dingtalk)?
                .ok_or_else(|| "钉钉 Client Secret 未配置".to_string())?;
            tauri::async_runtime::spawn(dingtalk::run_dingtalk(
                app_handle,
                shared,
                dingtalk::DingtalkCreds { client_id, client_secret },
            ))
        }
        ConnectPlatform::Weixin => {
            let token = load_platform_secret(app, ConnectPlatform::Weixin)?
                .ok_or_else(|| "微信尚未扫码登录".to_string())?;
            tauri::async_runtime::spawn(weixin::run_weixin(app_handle, shared, token))
        }
    };
    state.lock()?.tasks.insert(platform, handle);
    Ok(())
}

fn stop_platform(app: &AppHandle, state: &ConnectState, platform: ConnectPlatform) {
    let payload = {
        let mut inner = match state.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        if let Some(handle) = inner.tasks.remove(&platform) {
            handle.abort();
        }
        match platform {
            ConnectPlatform::Feishu => inner.feishu_token = None,
            ConnectPlatform::Dingtalk => inner.dingtalk_token = None,
            ConnectPlatform::Weixin => {}
        }
        let (status, message) = (ConnectStatusKind::Disconnected, None);
        inner.statuses.insert(platform, (status, message.clone()));
        ConnectEventPayload::Status { platform, status, message }
    };
    let _ = app.emit(CONNECT_EVENT, payload);
}

/// 启动初始化（lib.rs setup 调用）：加载配置并拉起 enabled 平台。
pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let state: tauri::State<'_, ConnectState> = app.state();
    // check-and-set 必须原子：并发命令同时进入初始化会重复加载盘面、重复拉起平台任务，
    // 后进入者还会用旧值覆盖内存态。initialize 全程同步（无 await），guard 持到函数结束；
    // 锁序 initialized → inner 与本模块其它取锁方向一致（无反向路径，不成环）。
    let mut initialized = state
        .initialized
        .lock()
        .map_err(|_| "connect init lock is poisoned".to_string())?;
    if *initialized {
        return Ok(());
    }
    let directory = connect_dir(app)?;
    let mut config = load_config_from(&directory)?;
    // 旧版本（或被 serde 默认值补齐的 0）读入后统一回写为当前版本：每次启动都
    // 能自愈，不会让一份历史配置把面板永久钉在「空配置 + 写入写回旧版本」的死态。
    config.schema_version = CONFIG_SCHEMA_VERSION;
    let enabled_platforms = {
        let mut inner = state.lock()?;
        inner.config = config;
        let config = inner.config.clone();
        drop(inner);
        let _ = persist_config_to(&directory, &config);
        ConnectPlatform::ALL
            .into_iter()
            .filter(|platform| match platform {
                ConnectPlatform::Feishu => config.feishu.enabled,
                ConnectPlatform::Dingtalk => config.dingtalk.enabled,
                ConnectPlatform::Weixin => config.weixin.enabled,
            })
            .collect::<Vec<_>>()
    };
    // 就绪标记只在配置真正读入（并写入内存）之后置位：失败路径直接 return Err 而不
    // 置位，命令侧会重新尝试初始化，不会静默跑在默认空配置上（面板显示全未配置、
    // 写入读不回来，且重启也不重试）。
    *initialized = true;
    for platform in enabled_platforms {
        if let Err(error) = spawn_platform(app, &state, platform) {
            let _ = app.emit(CONNECT_EVENT, ConnectEventPayload::Status {
                platform,
                status: ConnectStatusKind::Error,
                message: Some(error),
            });
        }
    }
    Ok(())
}

fn ensure_initialized(app: &AppHandle) -> Result<(), String> {
    initialize(app)
}

/* ------------------------------------------------------------------ *
 * 命令：配置读写
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectPlatformStatusView {
    platform: ConnectPlatform,
    status: ConnectStatusKind,
    message: Option<String>,
    configured: bool,
    credential_hint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectBindingView {
    platform: ConnectPlatform,
    chat_id: String,
    chat_type: String,
    user_id: String,
    user_name: String,
    paired_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectConfigSummary {
    workspace_path: Option<String>,
    bindings: Vec<ConnectBindingView>,
    platforms: Vec<ConnectPlatformStatusView>,
}

fn mask_credential(value: &str) -> String {
    let visible: String = value.chars().take(10).collect();
    if value.chars().count() > 10 {
        format!("{visible}…")
    } else {
        visible
    }
}

#[tauri::command]
pub fn get_connect_config(
    app: AppHandle,
    state: State<'_, ConnectState>,
    secrets: State<'_, SecretState>,
) -> Result<ConnectConfigSummary, String> {
    ensure_initialized(&app)?;
    // 锁序约定：先取完 ConnectInner 数据释放锁，再访问密钥库。
    let (workspace_path, bindings, feishu_id, dingtalk_id, statuses) = {
        let inner = state.lock()?;
        (
            inner.config.workspace_path.clone(),
            inner.config.bindings.clone(),
            inner.config.feishu.account_id.clone(),
            inner.config.dingtalk.account_id.clone(),
            ConnectPlatform::ALL
                .into_iter()
                .map(|platform| {
                    let entry = inner
                        .statuses
                        .get(&platform)
                        .cloned()
                        .unwrap_or((ConnectStatusKind::Unconfigured, None));
                    (platform, entry)
                })
                .collect::<Vec<_>>(),
        )
    };
    let mut platforms = Vec::new();
    for (platform, (status, message)) in statuses {
        // 状态展示用元数据检查（不解密不弹窗），与密钥读取路径分离。
        let has_secret =
            crate::secrets::connect_secret_exists(&secrets, platform_secret_key(platform))?;
        let id_configured = match platform {
            ConnectPlatform::Feishu => !feishu_id.is_empty(),
            ConnectPlatform::Dingtalk => !dingtalk_id.is_empty(),
            ConnectPlatform::Weixin => true,
        };
        let configured = id_configured && has_secret;
        let effective_status = if !configured && status != ConnectStatusKind::Error {
            ConnectStatusKind::Unconfigured
        } else {
            status
        };
        let credential_hint = match (platform, configured) {
            (ConnectPlatform::Feishu, true) => Some(mask_credential(&feishu_id)),
            (ConnectPlatform::Dingtalk, true) => Some(mask_credential(&dingtalk_id)),
            (ConnectPlatform::Weixin, true) => Some("已保存登录令牌".to_string()),
            _ => None,
        };
        platforms.push(ConnectPlatformStatusView {
            platform,
            status: effective_status,
            message,
            configured,
            credential_hint,
        });
    }
    Ok(ConnectConfigSummary {
        workspace_path,
        bindings: bindings
            .into_iter()
            .map(|binding| ConnectBindingView {
                platform: binding.platform,
                chat_id: binding.chat_id,
                chat_type: binding.chat_type,
                user_id: binding.user_id,
                user_name: binding.user_name,
                paired_at: binding.paired_at,
            })
            .collect(),
        platforms,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectCredentialDraft {
    app_id: Option<String>,
    app_secret: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveConnectPlatformRequest {
    platform: ConnectPlatform,
    credential: ConnectCredentialDraft,
}

#[tauri::command]
pub fn save_connect_platform_config(
    app: AppHandle,
    state: State<'_, ConnectState>,
    secrets: State<'_, SecretState>,
    request: SaveConnectPlatformRequest,
) -> Result<(), String> {
    ensure_initialized(&app)?;
    let SaveConnectPlatformRequest { platform, credential } = request;
    let normalized = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    match platform {
        ConnectPlatform::Feishu => {
            let app_id = normalized(&credential.app_id)
                .ok_or_else(|| "飞书 App ID 不能为空".to_string())?;
            let app_secret = normalized(&credential.app_secret)
                .ok_or_else(|| "飞书 App Secret 不能为空".to_string())?;
            save_connect_secret(&secrets, FEISHU_SECRET_KEY, &app_secret)?;
            let config = {
                let mut inner = state.lock()?;
                inner.config.feishu.account_id = app_id;
                inner.config.schema_version = CONFIG_SCHEMA_VERSION;
                inner.config.clone()
            };
            persist_config(&app, &config)?;
            restart_if_running(&app, &state, platform)
        }
        ConnectPlatform::Dingtalk => {
            let client_id = normalized(&credential.client_id)
                .ok_or_else(|| "钉钉 Client ID 不能为空".to_string())?;
            let client_secret = normalized(&credential.client_secret)
                .ok_or_else(|| "钉钉 Client Secret 不能为空".to_string())?;
            save_connect_secret(&secrets, DINGTALK_SECRET_KEY, &client_secret)?;
            let config = {
                let mut inner = state.lock()?;
                inner.config.dingtalk.account_id = client_id;
                inner.config.schema_version = CONFIG_SCHEMA_VERSION;
                inner.config.clone()
            };
            persist_config(&app, &config)?;
            restart_if_running(&app, &state, platform)
        }
        ConnectPlatform::Weixin => {
            let token = normalized(&credential.token)
                .ok_or_else(|| "微信 token 不能为空".to_string())?;
            save_connect_secret(&secrets, WEIXIN_SECRET_KEY, &token)
        }
    }
}

/// 已连接的平台在凭证更新后重启连接（新凭证生效）。
fn restart_if_running(
    app: &AppHandle,
    state: &ConnectState,
    platform: ConnectPlatform,
) -> Result<(), String> {
    let running = state
        .lock()
        .map(|inner| inner.tasks.contains_key(&platform))
        .unwrap_or(false);
    if running {
        stop_platform(app, state, platform);
        spawn_platform(app, state, platform)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlatformOnlyRequest {
    platform: ConnectPlatform,
}

#[tauri::command]
pub fn clear_connect_platform_config(
    app: AppHandle,
    state: State<'_, ConnectState>,
    secrets: State<'_, SecretState>,
    request: PlatformOnlyRequest,
) -> Result<(), String> {
    ensure_initialized(&app)?;
    stop_platform(&app, &state, request.platform);
    delete_connect_secret(&secrets, platform_secret_key(request.platform))?;
    let config = {
        let mut inner = state.lock()?;
        match request.platform {
            ConnectPlatform::Feishu => inner.config.feishu = PlatformIdConfig::default(),
            ConnectPlatform::Dingtalk => inner.config.dingtalk = PlatformIdConfig::default(),
            ConnectPlatform::Weixin => inner.config.weixin = WeixinConfig::default(),
        }
        inner
            .config
            .bindings
            .retain(|binding| binding.platform != request.platform);
        inner
            .reply_contexts
            .retain(|(platform, _, _), _| *platform != request.platform);
        inner.config.clone()
    };
    persist_config(&app, &config)
}

#[tauri::command]
pub fn connect_platform(
    app: AppHandle,
    state: State<'_, ConnectState>,
    request: PlatformOnlyRequest,
) -> Result<(), String> {
    ensure_initialized(&app)?;
    {
        let mut inner = state.lock()?;
        match request.platform {
            ConnectPlatform::Feishu => inner.config.feishu.enabled = true,
            ConnectPlatform::Dingtalk => inner.config.dingtalk.enabled = true,
            ConnectPlatform::Weixin => inner.config.weixin.enabled = true,
        }
        inner.config.schema_version = CONFIG_SCHEMA_VERSION;
        let config = inner.config.clone();
        drop(inner);
        persist_config(&app, &config)?;
    }
    spawn_platform(&app, &state, request.platform)
}

#[tauri::command]
pub fn disconnect_platform(
    app: AppHandle,
    state: State<'_, ConnectState>,
    request: PlatformOnlyRequest,
) -> Result<(), String> {
    ensure_initialized(&app)?;
    stop_platform(&app, &state, request.platform);
    let config = {
        let mut inner = state.lock()?;
        match request.platform {
            ConnectPlatform::Feishu => inner.config.feishu.enabled = false,
            ConnectPlatform::Dingtalk => inner.config.dingtalk.enabled = false,
            ConnectPlatform::Weixin => inner.config.weixin.enabled = false,
        }
        inner.config.clone()
    };
    persist_config(&app, &config)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetConnectWorkspaceRequest {
    workspace_path: Option<String>,
}

#[tauri::command]
pub fn set_connect_workspace(
    app: AppHandle,
    state: State<'_, ConnectState>,
    request: SetConnectWorkspaceRequest,
) -> Result<(), String> {
    ensure_initialized(&app)?;
    let workspace_path = request
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let config = {
        let mut inner = state.lock()?;
        inner.config.workspace_path = workspace_path;
        // 持久化带上当前 schema 版本（platform 配置写入口同样如此），避免把默认态
        // （0）写回磁盘——那份配置下次启动会被 load_config_from 拒绝。
        inner.config.schema_version = CONFIG_SCHEMA_VERSION;
        inner.config.clone()
    };
    persist_config(&app, &config)
}

/* ------------------------------------------------------------------ *
 * 命令：配对 / 绑定
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectPairingCodeView {
    code: String,
    expires_at: i64,
}

#[tauri::command]
pub fn create_connect_pairing_code(
    app: AppHandle,
    state: State<'_, ConnectState>,
) -> Result<ConnectPairingCodeView, String> {
    ensure_initialized(&app)?;
    // 6 位数字码，取值空间 10^6；10 分钟有效、生成即作废旧码。
    let bytes = random_bytes(3);
    let value = ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32;
    let code = format!("{:06}", value % 1_000_000);
    let expires_at = now_ms() + PAIRING_CODE_TTL_MS as i64;
    let mut inner = state.lock()?;
    inner.pairing = Some(PairingCode {
        code: code.clone(),
        expires_at_ms: expires_at as u64,
    });
    Ok(ConnectPairingCodeView { code, expires_at })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnpairConnectBindingRequest {
    platform: ConnectPlatform,
    chat_id: String,
    user_id: String,
}

#[tauri::command]
pub fn unpair_connect_binding(
    app: AppHandle,
    state: State<'_, ConnectState>,
    request: UnpairConnectBindingRequest,
) -> Result<(), String> {
    ensure_initialized(&app)?;
    let config = {
        let mut inner = state.lock()?;
        inner.config.bindings.retain(|binding| {
            !(binding.platform == request.platform
                && binding.chat_id == request.chat_id
                && binding.user_id == request.user_id)
        });
        inner
            .reply_contexts
            .remove(&(request.platform, request.chat_id.clone(), request.user_id.clone()));
        inner.config.clone()
    };
    persist_config(&app, &config)
}

/* ------------------------------------------------------------------ *
 * 命令：出站回复
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectReplyMessageRequest {
    platform: ConnectPlatform,
    chat_id: String,
    user_id: String,
    text: String,
}

#[tauri::command]
pub async fn connect_reply_message(
    app: AppHandle,
    state: State<'_, ConnectState>,
    secrets: State<'_, SecretState>,
    request: ConnectReplyMessageRequest,
) -> Result<(), String> {
    ensure_initialized(&app)?;
    let text = request.text.trim().to_string();
    if text.is_empty() {
        return Err("回复内容不能为空".into());
    }
    // 锁序约定：取出回复上下文与非密配置后释放锁，再取密钥库凭证。
    let (context, feishu_id, dingtalk_id) = {
        let inner = state.lock()?;
        let context = inner
            .reply_contexts
            .get(&(request.platform, request.chat_id.clone(), request.user_id.clone()))
            .cloned()
            .ok_or_else(|| "该会话尚无可用的回复通道（请先从聊天工具发送一条消息）".to_string())?;
        (context, inner.config.feishu.account_id.clone(), inner.config.dingtalk.account_id.clone())
    };
    match request.platform {
        ConnectPlatform::Feishu => {
            let app_secret = load_connect_secret(&secrets, FEISHU_SECRET_KEY)?
                .ok_or_else(|| "飞书 App Secret 未配置".to_string())?;
            feishu::send_reply(
                &app,
                state.inner.clone(),
                feishu::FeishuCreds { app_id: feishu_id, app_secret },
                &context,
                &text,
            )
            .await
        }
        ConnectPlatform::Dingtalk => {
            let client_secret = load_connect_secret(&secrets, DINGTALK_SECRET_KEY)?
                .ok_or_else(|| "钉钉 Client Secret 未配置".to_string())?;
            dingtalk::send_reply(
                &app,
                state.inner.clone(),
                dingtalk::DingtalkCreds { client_id: dingtalk_id, client_secret },
                &context,
                &text,
            )
            .await
        }
        ConnectPlatform::Weixin => {
            let token = load_connect_secret(&secrets, WEIXIN_SECRET_KEY)?
                .ok_or_else(|| "微信尚未登录".to_string())?;
            weixin::send_reply(&app, &context, &token, &text).await
        }
    }
}

/* ------------------------------------------------------------------ *
 * 命令：微信扫码登录
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectWechatQrView {
    login_id: String,
    rows: Vec<String>,
}

#[tauri::command]
pub fn start_wechat_login(
    app: AppHandle,
    state: State<'_, ConnectState>,
) -> Result<ConnectWechatQrView, String> {
    ensure_initialized(&app)?;
    let login_id = format!("wxlogin-{}", random_hex(8));
    {
        let mut inner = state.lock()?;
        // 同时只允许一个活跃登录会话：旧的直接标记过期，并限制会话数量。
        for (_, session) in inner.logins.iter_mut() {
            if !matches!(session.status, weixin::WechatLoginStatus::Confirmed) {
                session.status = weixin::WechatLoginStatus::Expired;
            }
        }
        if inner.logins.len() >= MAX_WECHAT_LOGIN_SESSIONS {
            if let Some(oldest) = inner.logins.keys().next().cloned() {
                inner.logins.remove(&oldest);
            }
        }
        inner.logins.insert(login_id.clone(), WechatLoginSession {
            rows: Vec::new(),
            status: weixin::WechatLoginStatus::Starting,
        });
    }
    let app_handle = app.clone();
    let state_inner = state.inner.clone();
    let login_for_task = login_id.clone();
    tauri::async_runtime::spawn(async move {
        weixin::run_wechat_login(app_handle, state_inner, login_for_task).await;
    });
    Ok(ConnectWechatQrView { login_id, rows: Vec::new() })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PollWechatLoginRequest {
    login_id: String,
}

// 同 ConnectEventPayload：variant 级字段需 rename_all_fields（当前字段均为
// 单词，暂无实际影响，防御未来新增多词字段）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub(crate) enum ConnectWechatLoginStatusView {
    Starting,
    Waiting { rows: Vec<String> },
    Scanned,
    Confirmed,
    Expired,
    Failed { message: String },
}

#[tauri::command]
pub fn poll_wechat_login(
    app: AppHandle,
    state: State<'_, ConnectState>,
    request: PollWechatLoginRequest,
) -> Result<ConnectWechatLoginStatusView, String> {
    ensure_initialized(&app)?;
    let inner = state.lock()?;
    let session = inner
        .logins
        .get(&request.login_id)
        .ok_or_else(|| "登录会话不存在或已结束".to_string())?;
    Ok(match &session.status {
        weixin::WechatLoginStatus::Starting => ConnectWechatLoginStatusView::Starting,
        weixin::WechatLoginStatus::Waiting => ConnectWechatLoginStatusView::Waiting {
            rows: session.rows.clone(),
        },
        weixin::WechatLoginStatus::Scanned => ConnectWechatLoginStatusView::Scanned,
        weixin::WechatLoginStatus::Confirmed => ConnectWechatLoginStatusView::Confirmed,
        weixin::WechatLoginStatus::Expired => ConnectWechatLoginStatusView::Expired,
        weixin::WechatLoginStatus::Failed { message } => ConnectWechatLoginStatusView::Failed {
            message: message.clone(),
        },
    })
}

/* ------------------------------------------------------------------ *
 * 子模块共享的状态写入口
 * ------------------------------------------------------------------ */

pub(crate) fn update_login_session(
    state: &Arc<Mutex<ConnectInner>>,
    login_id: &str,
    update: impl FnOnce(&mut WechatLoginSession),
) {
    if let Ok(mut inner) = state.lock() {
        if let Some(session) = inner.logins.get_mut(login_id) {
            update(session);
        }
    }
}

pub(crate) fn replace_config(
    app: &AppHandle,
    state: &Arc<Mutex<ConnectInner>>,
    mutate: impl FnOnce(&mut ConnectConfigFile),
) -> Result<(), String> {
    let config = {
        let mut inner = state
            .lock()
            .map_err(|_| "connect state lock is poisoned".to_string())?;
        mutate(&mut inner.config);
        inner.config.clone()
    };
    persist_config(app, &config)
}

pub(crate) fn cached_rest_token(
    state: &Arc<Mutex<ConnectInner>>,
    platform: ConnectPlatform,
) -> Option<String> {
    let inner = state.lock().ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let (token, expires_at) = match platform {
        ConnectPlatform::Feishu => inner.feishu_token.clone()?,
        ConnectPlatform::Dingtalk => inner.dingtalk_token.clone()?,
        ConnectPlatform::Weixin => return None,
    };
    (expires_at > now + 60).then_some(token)
}

pub(crate) fn cache_rest_token(
    state: &Arc<Mutex<ConnectInner>>,
    platform: ConnectPlatform,
    token: String,
    expires_at: i64,
) {
    if let Ok(mut inner) = state.lock() {
        match platform {
            ConnectPlatform::Feishu => inner.feishu_token = Some((token, expires_at)),
            ConnectPlatform::Dingtalk => inner.dingtalk_token = Some((token, expires_at)),
            ConnectPlatform::Weixin => {}
        }
    }
}

pub(crate) fn sleep_backoff(attempt: u32) -> Duration {
    // 1s → 2s → 4s → … 封顶 60s。
    let base = 1_u64 << attempt.min(6);
    Duration::from_secs(base.min(60))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_credentials_without_leaking_secrets() {
        assert_eq!(mask_credential("cli_a1b2c3d4e5f6g7"), "cli_a1b2c3…");
        assert_eq!(mask_credential("short"), "short");
    }

    #[test]
    fn config_round_trips_with_camel_case_fields() {
        let config = ConnectConfigFile {
            schema_version: CONFIG_SCHEMA_VERSION,
            workspace_path: Some("/tmp/project".into()),
            feishu: PlatformIdConfig { enabled: true, account_id: "cli_test".into() },
            dingtalk: PlatformIdConfig::default(),
            weixin: WeixinConfig { enabled: false },
            bindings: vec![StoredBinding {
                platform: ConnectPlatform::Feishu,
                chat_id: "oc_1".into(),
                chat_type: "p2p".into(),
                user_id: "ou_1".into(),
                user_name: "张三".into(),
                paired_at: 1_700_000_000_000,
            }],
        };
        let encoded = serde_json::to_vec(&config).unwrap();
        let decoded: ConnectConfigFile = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.workspace_path.as_deref(), Some("/tmp/project"));
        assert_eq!(decoded.feishu.account_id, "cli_test");
        assert_eq!(decoded.bindings.len(), 1);
        assert_eq!(decoded.bindings[0].platform, ConnectPlatform::Feishu);
    }

    #[test]
    fn rejects_unsupported_config_schema() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("config.json"),
            br#"{"schemaVersion":99,"workspacePath":null,"feishu":{"enabled":false,"accountId":""},"dingtalk":{"enabled":false,"accountId":""},"weixin":{"enabled":false},"bindings":[]}"#,
        )
        .unwrap();
        assert!(load_config_from(directory.path()).is_err());
    }

    #[test]
    fn accepts_older_config_schema_for_upgrade() {
        // 旧版本配置（含默认值补齐出的 0）必须可读：由 initialize 回写为当前版本，
        // 否则一份历史配置会让连接面板永久停在空配置且任何写入都读不回来。
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("config.json"),
            br#"{"workspacePath":"/tmp/project","feishu":{"enabled":false,"accountId":""},"dingtalk":{"enabled":false,"accountId":""},"weixin":{"enabled":false},"bindings":[]}"#,
        )
        .unwrap();
        let config = load_config_from(directory.path()).expect("旧版本配置必须可读");
        assert_eq!(config.schema_version, 0);
        assert_eq!(config.workspace_path.as_deref(), Some("/tmp/project"));
    }

    #[test]
    fn backoff_is_capped() {
        assert_eq!(sleep_backoff(0), Duration::from_secs(1));
        assert_eq!(sleep_backoff(6), Duration::from_secs(60));
        assert_eq!(sleep_backoff(20), Duration::from_secs(60));
    }

    #[test]
    fn pairing_lockout_activates_after_consecutive_failures() {
        let now = 1_000_000;
        let mut failures = VecDeque::new();
        // 未达阈值：不锁定。
        for _ in 0..PAIRING_MAX_ATTEMPTS - 1 {
            record_pairing_failure(&mut failures, now);
        }
        assert!(!is_pairing_locked(&failures, now));
        // 达到阈值：锁定。
        record_pairing_failure(&mut failures, now);
        assert!(is_pairing_locked(&failures, now));
    }

    #[test]
    fn pairing_lockout_expires_after_window() {
        let now = 1_000_000;
        let mut failures = VecDeque::new();
        for _ in 0..PAIRING_MAX_ATTEMPTS {
            record_pairing_failure(&mut failures, now);
        }
        assert!(is_pairing_locked(&failures, now));
        // 超出锁定窗口后：窗口内有效失败清空，不再锁定。
        let later = now + PAIRING_LOCKOUT_MS + 1;
        assert!(!is_pairing_locked(&failures, later));
    }

    #[test]
    fn upsert_binding_dedupes_existing_triplet() {
        let mut bindings = vec![StoredBinding {
            platform: ConnectPlatform::Feishu,
            chat_id: "oc_1".into(),
            chat_type: "p2p".into(),
            user_id: "ou_1".into(),
            user_name: "张三".into(),
            paired_at: 1_700_000_000_000,
        }];
        // 同三元组复用：返回 false（未新增），但刷新字段。
        let added = upsert_binding(
            &mut bindings,
            ConnectPlatform::Feishu,
            "oc_1",
            "group",
            "ou_1",
            "李四",
            1_800_000_000_000,
        );
        assert!(!added);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].paired_at, 1_800_000_000_000);
        assert_eq!(bindings[0].chat_type, "group");
        assert_eq!(bindings[0].user_name, "李四");
        // 不同三元组：返回 true（新增）。
        let added = upsert_binding(
            &mut bindings,
            ConnectPlatform::Feishu,
            "oc_2",
            "p2p",
            "ou_2",
            "王五",
            1_900_000_000_000,
        );
        assert!(added);
        assert_eq!(bindings.len(), 2);
    }

    #[test]
    fn pairing_lockout_is_per_chat() {
        // 锁定作用域按聊天隔离：一个聊天的失败不影响另一个聊天。
        let now = 1_000_000;
        let mut chat_a = VecDeque::new();
        for _ in 0..PAIRING_MAX_ATTEMPTS {
            record_pairing_failure(&mut chat_a, now);
        }
        assert!(is_pairing_locked(&chat_a, now));
        // 另一个聊天无失败：不锁定。
        let chat_b = VecDeque::new();
        assert!(!is_pairing_locked(&chat_b, now));
    }

    // 事件字段名契约：WebView 按 camelCase 读取（event.chatId 等）。曾因 enum 级
    // rename_all 不作用于 variant 字段，导致 TS 读到 undefined、回发链路全断。
    #[test]
    fn connect_event_payload_fields_are_camel_case() {
        let payload = ConnectEventPayload::Message {
            platform: ConnectPlatform::Weixin,
            chat_id: "wx-chat".into(),
            chat_type: "p2p".into(),
            user_id: "wx-user".into(),
            user_name: "测试用户".into(),
            message_id: "m-1".into(),
            text: "你好".into(),
        };
        let encoded = serde_json::to_value(&payload).unwrap();
        assert_eq!(encoded["kind"], "message");
        assert_eq!(encoded["chatId"], "wx-chat");
        assert_eq!(encoded["chatType"], "p2p");
        assert_eq!(encoded["userId"], "wx-user");
        assert_eq!(encoded["userName"], "测试用户");
        assert_eq!(encoded["messageId"], "m-1");
        assert_eq!(encoded["text"], "你好");
        assert!(encoded.get("chat_id").is_none());

        let paired = ConnectEventPayload::Paired {
            platform: ConnectPlatform::Feishu,
            chat_id: "oc_1".into(),
            chat_type: "p2p".into(),
            user_id: "ou_1".into(),
            user_name: "张三".into(),
        };
        let encoded = serde_json::to_value(&paired).unwrap();
        assert_eq!(encoded["kind"], "paired");
        assert_eq!(encoded["chatId"], "oc_1");
        assert_eq!(encoded["userId"], "ou_1");

        let status = ConnectEventPayload::Status {
            platform: ConnectPlatform::Dingtalk,
            status: ConnectStatusKind::Error,
            message: Some("失败".into()),
        };
        let encoded = serde_json::to_value(&status).unwrap();
        assert_eq!(encoded["kind"], "status");
        assert_eq!(encoded["status"], "error");
        assert_eq!(encoded["message"], "失败");
    }
}
