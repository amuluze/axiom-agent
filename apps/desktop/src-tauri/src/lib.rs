mod artifacts;
mod browser_session;
mod connect;
mod computer_control;
mod feedback;
mod file_access;
mod file_access_registry;
mod fuzzy_match;
mod generated_provider_table;
mod git_config;
mod image_detect;
mod model_http;
mod network_policy;
mod platform_process;
mod power;
mod provider_profiles;
mod request_id;
mod runtime_fault;
mod runtime_manifest;
mod sandbox;
mod secrets;
mod session_mutations;
mod session_repository;
mod session_schema;
mod session_state;
mod ssh;
mod ssh_agent;
mod ssh_session;
mod specta_bindings;
mod storage_paths;
mod terminal;
mod usage_query;
mod workspace_access;
mod workspace_approval;
mod workspace_changes;
mod workspace_command;
mod workspace_registry;
mod web_access;

use serde::Serialize;
use std::sync::Arc;
#[cfg(feature = "e2e")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use tauri::Manager;
#[cfg(feature = "e2e")]
use tauri::{WebviewUrl, WebviewWindowBuilder};

use artifacts::{
    get_artifact_storage_stats, read_artifact, reconcile_artifacts, trash_artifacts, write_artifact,
};
use browser_session::{browser_command, reap_browser_for_exit, BrowserSessionState};
use computer_control::{computer_command, ComputerSessionState};
use ssh::{ssh_command, SshState};
use ssh_agent::{ssh_agent_command, SshAgentState};
use ssh_session::{reap_ssh_sessions_for_exit, SshSessionState};
use connect::{
    clear_connect_platform_config, connect_platform, connect_reply_message,
    create_connect_pairing_code, disconnect_platform, get_connect_config, poll_wechat_login,
    save_connect_platform_config, set_connect_workspace, start_wechat_login,
    unpair_connect_binding, ConnectState,
};
use file_access::{
    list_authorized_read_files, pick_and_authorize_read_directory, pick_and_authorize_read_file,
    read_authorized_text, revoke_authorized_read_file, FileAccessState,
};
use feedback::submit_feedback;
use model_http::{cancel_model_http, probe_model_http, stream_model_http, ModelRequestState};
use power::{set_prevent_idle_sleep, PowerManagementState};
use web_access::{open_external_url, web_fetch, web_search};
use provider_profiles::{
    decode_provider_profile, is_known_legacy_provider_secret, is_legacy_provider_secret_compatible,
    is_provider_secret_compatible, normalize_provider_profile_draft,
};
#[cfg(feature = "e2e")]
use runtime_fault::e2e_runtime_fault_checkpoint;
#[cfg(feature = "e2e")]
use workspace_access::e2e_register_workspace;
#[cfg(feature = "e2e")]
use secrets::seed_e2e_legacy_provider_secret;
use secrets::{
    delete_secret, has_secret, load_provider_secret_cleanup_intent, migrate_secret,
    persist_provider_secret_cleanup_intent, save_secret, SecretState,
};
use session_mutations::commit_session_mutation_batch;
use session_repository::{
    append_session_journal_entry, clear_session_repository, create_session_branch,
    delete_session_with_successor, delete_unreferenced_artifact_metadata,
    execute_session_repository, finish_session_run, gc_artifacts,
    initialize_session_repository, initialize_session_runtime_defaults,
    load_session_repository_snapshot, migrate_session_provider_profiles, persist_session_message,
    query_session_repository, receive_provider_response, recover_session_repository,
    recover_session_repository_session, save_session_checkpoint, save_session_turn_point,
    settle_session_run, start_provider_request, start_session_run,
    start_tool_execution, transition_session_journal_entries, update_session_runtime_config,
};
use session_state::SessionRepositoryState;
use terminal::{
    kill_terminal, resize_terminal, set_terminal_focus, spawn_terminal, write_terminal_stdin,
    TerminalGestureState, TerminalState,
};
use usage_query::query_provider_usage;
use workspace_access::{
    activate_authorized_workspace, authorize_workspace, cancel_workspace_search,
    create_workspace_text_file, edit_workspace_text_file, find_workspace_files,
    get_authorized_workspace, get_authorized_workspaces, list_workspace,
    pick_and_authorize_workspace, read_workspace_text, revoke_workspace, search_workspace_text,
    WorkspaceAccessState,
};
use workspace_approval::{
    request_workspace_approval_lease, set_workspace_approval_mode, WorkspaceApprovalState,
};
use workspace_changes::{
    apply_workspace_changes, get_workspace_recovery_issue, initialize_workspace_recovery,
    restore_workspace_trash, retry_workspace_recovery, WorkspaceRecoveryState,
};
use workspace_command::{cancel_workspace_command, run_workspace_command, WorkspaceCommandState};

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    app_name: String,
    app_version: String,
    operating_system: &'static str,
    architecture: &'static str,
}

#[cfg(feature = "e2e")]
static E2E_DATA_STORE_CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(feature = "e2e")]
static E2E_DATA_STORE_CLEANUP_FINISHED: AtomicBool = AtomicBool::new(false);
#[cfg(feature = "e2e")]
static E2E_DATA_STORE_IDENTIFIER: OnceLock<[u8; 16]> = OnceLock::new();

#[cfg(feature = "e2e")]
fn e2e_data_store_identifier() -> [u8; 16] {
    let raw = std::env::var("AXIOM_E2E_DATA_STORE_ID")
        .expect("AXIOM_E2E_DATA_STORE_ID is required for E2E builds");
    assert_eq!(
        raw.len(),
        32,
        "AXIOM_E2E_DATA_STORE_ID must contain 32 hexadecimal characters"
    );
    let mut identifier = [0_u8; 16];
    for (index, byte) in identifier.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw[index * 2..index * 2 + 2], 16)
            .expect("AXIOM_E2E_DATA_STORE_ID must be hexadecimal");
    }
    identifier
}

#[cfg(feature = "e2e")]
fn handle_e2e_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if std::env::var("AXIOM_E2E_CLEANUP_WEBKIT").as_deref() != Ok("1") {
        return;
    }
    let tauri::RunEvent::ExitRequested { api, .. } = event else {
        return;
    };
    if E2E_DATA_STORE_CLEANUP_FINISHED.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_exit();
    if E2E_DATA_STORE_CLEANUP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.destroy();
        }
        let identifier = *E2E_DATA_STORE_IDENTIFIER
            .get()
            .expect("E2E data store identifier should be initialized");
        let exit_code = match app.remove_data_store(identifier).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("failed to clean isolated E2E WebKit data store: {error}");
                1
            }
        };
        E2E_DATA_STORE_CLEANUP_FINISHED.store(true, Ordering::SeqCst);
        app.exit(exit_code);
    });
}

/// 应用退出前同步回收 spawn 的浏览器：macOS 关窗退出走 Cocoa 终止路径，
/// 不执行 Rust drop（kill_on_drop 失效）；且关窗路径只发 ExitRequested、
/// 不发 Exit，所以两个事件都要挂回收（reap 取走 state，二次调用是空操作）。
/// 不兜底会留下孤儿 Chrome 锁死 profile，导致下次启动浏览器直接超时。
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(feature = "e2e")]
    handle_e2e_run_event(app, &event);
    match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            let state: tauri::State<BrowserSessionState> = app.state();
            reap_browser_for_exit(&state);
            let state: tauri::State<SshSessionState> = app.state();
            reap_ssh_sessions_for_exit(&state);
            // Agent SSH 通道的 ControlPersist master 与 askpass 脚本同步收口。
            ssh_agent::reap_ssh_agent_for_exit(app);
        }
        _ => {}
    }
}

#[tauri::command]
#[specta::specta]
fn get_runtime_info(app: tauri::AppHandle) -> RuntimeInfo {
    RuntimeInfo {
        app_name: app.package_info().name.clone(),
        app_version: app.package_info().version.to_string(),
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), String> {
    let context = tauri::generate_context!();
    #[cfg(feature = "e2e")]
    assert_eq!(
        context.config().identifier, "com.axiom.desktop.e2e",
        "the e2e feature requires the isolated E2E bundle identifier"
    );
    // 密钥存储 worker（SQLite 唯一权威存储，无任何 Keychain 触点）。
    let secret_state = SecretState::new();
    #[cfg(feature = "e2e")]
    let e2e_data_store_identifier = e2e_data_store_identifier();
    #[cfg(feature = "e2e")]
    let e2e_reset_web_storage = std::env::var("AXIOM_E2E_RESET_WEB_STORAGE").as_deref() == Ok("1");
    #[cfg(feature = "e2e")]
    E2E_DATA_STORE_IDENTIFIER
        .set(e2e_data_store_identifier)
        .expect("E2E data store identifier should only be initialized once");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(secret_state)
        .manage(ModelRequestState::default())
        .manage(FileAccessState::default())
        .manage(WorkspaceAccessState::default())
        .manage(WorkspaceApprovalState::default())
        .manage(WorkspaceRecoveryState::default())
        .manage(WorkspaceCommandState::default())
        .manage(SessionRepositoryState::default())
        .manage(PowerManagementState::default())
        .manage(TerminalState::default())
        .manage(BrowserSessionState::default())
    .manage(ComputerSessionState::default())
        .manage(SshState::default())
        .manage(SshSessionState::default())
        .manage(SshAgentState::default())
        .manage(ConnectState::default())
        // 终端手势门状态以 Arc 托管，供原生 keyDown monitor 与命令共享同一实例
        // （stdin 输入来源校验，见 terminal.rs）。
        .manage(Arc::new(TerminalGestureState::default()))
        .plugin(tauri_plugin_dialog::init());
    // 自更新插件按需注册：updater 的 Config 反序列化不接受 null，配置缺失
    // （开发模式 / 无签名凭据构建，见 generate-release-config.mjs）时注册会
    // 在 PluginInitialization 阶段失败并阻断启动，故仅在配置存在时挂载。
    let builder = if context.config().plugins.0.contains_key("updater") {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            write_artifact,
            read_artifact,
            trash_artifacts,
            reconcile_artifacts,
            gc_artifacts,
            get_artifact_storage_stats,
            save_secret,
            has_secret,
            migrate_secret,
            delete_secret,
            load_provider_secret_cleanup_intent,
            persist_provider_secret_cleanup_intent,
            stream_model_http,
            cancel_model_http,
            probe_model_http,
            query_provider_usage,
            web_search,
            web_fetch,
            open_external_url,
            submit_feedback,
            browser_command,
            computer_command,
            ssh_command,
            ssh_agent_command,
            get_connect_config,
            save_connect_platform_config,
            clear_connect_platform_config,
            connect_platform,
            disconnect_platform,
            set_connect_workspace,
            create_connect_pairing_code,
            unpair_connect_binding,
            connect_reply_message,
            start_wechat_login,
            poll_wechat_login,
            decode_provider_profile,
            normalize_provider_profile_draft,
            is_provider_secret_compatible,
            is_legacy_provider_secret_compatible,
            is_known_legacy_provider_secret,
            pick_and_authorize_read_file,
            pick_and_authorize_read_directory,
            list_authorized_read_files,
            revoke_authorized_read_file,
            read_authorized_text,
            authorize_workspace,
            pick_and_authorize_workspace,
            activate_authorized_workspace,
            get_authorized_workspace,
            get_authorized_workspaces,
            revoke_workspace,
            request_workspace_approval_lease,
            set_workspace_approval_mode,
            set_prevent_idle_sleep,
            list_workspace,
            read_workspace_text,
            create_workspace_text_file,
            edit_workspace_text_file,
            search_workspace_text,
            cancel_workspace_search,
            find_workspace_files,
            apply_workspace_changes,
            restore_workspace_trash,
            get_workspace_recovery_issue,
            retry_workspace_recovery,
            run_workspace_command,
            cancel_workspace_command,
            spawn_terminal,
            write_terminal_stdin,
            resize_terminal,
            kill_terminal,
            set_terminal_focus,
            commit_session_mutation_batch,
            initialize_session_repository,
            recover_session_repository,
            recover_session_repository_session,
            initialize_session_runtime_defaults,
            query_session_repository,
            load_session_repository_snapshot,
            execute_session_repository,
            clear_session_repository,
            delete_session_with_successor,
            create_session_branch,
            update_session_runtime_config,
            migrate_session_provider_profiles,
            append_session_journal_entry,
            delete_unreferenced_artifact_metadata,
            start_session_run,
            start_provider_request,
            receive_provider_response,
            start_tool_execution,
            finish_session_run,
            persist_session_message,
            save_session_checkpoint,
            save_session_turn_point,
            settle_session_run,
            transition_session_journal_entries,
            #[cfg(feature = "e2e")]
            e2e_runtime_fault_checkpoint,
            #[cfg(feature = "e2e")]
            e2e_register_workspace,
        ]);
    let builder = builder.setup(move |app| {
        // 数据根迁移（~/.axiom/）：必须在所有数据消费者（SQLite 打开、
        // workspace 恢复）之前完成；数据库三件套迁移失败 fail-closed 阻止启动。
        storage_paths::migrate_legacy_app_data(app.handle()).map_err(std::io::Error::other)?;
        // 文件读取授权的持久注册表恢复：注册表位于数据根，必须在数据根迁移
        // 之后、任何 read_authorized_text/list 命令之前完成（注册表损坏时
        // fail-soft 跳过，不阻塞启动）。
        file_access::restore_persistent_grants(app.handle()).map_err(std::io::Error::other)?;
        // 密钥存储绑定数据根：先于 connect 长连接与任何密钥命令（worker 首个请求）。
        app.state::<SecretState>()
            .bind_data_root(storage_paths::axiom_data_root(app.handle())?);
        // 终端原生键盘手势 monitor：在主线程捕获本 app 窗口按键，供 stdin 输入来源校验。
        terminal::install_gesture_monitor(app).map_err(std::io::Error::other)?;
        initialize_workspace_recovery(app.handle()).map_err(std::io::Error::other)?;
        // 「连接」远程操控：加载配置并拉起上次启用的平台长连接（无配置时为空操作）。
        connect::initialize(app.handle()).map_err(std::io::Error::other)?;
        #[cfg(feature = "e2e")]
        {
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Axiom")
                    .inner_size(1180.0, 780.0)
                    .min_inner_size(760.0, 560.0)
                    .resizable(true)
                    .data_store_identifier(e2e_data_store_identifier);
            let mut initialization_scripts = Vec::new();
            if e2e_reset_web_storage {
                initialization_scripts
                    .push("localStorage.clear(); sessionStorage.clear();".to_string());
            }
            if let Ok(checkpoint) = std::env::var("AXIOM_E2E_FAULT_CHECKPOINT") {
                let encoded = serde_json::to_string(&checkpoint)?;
                initialization_scripts.push(format!(
                    "window.__AXIOM_E2E_FAULT_CHECKPOINT__ = {encoded};"
                ));
            }
            if let Ok(raw) = std::env::var("AXIOM_E2E_RUNTIME_AUTOMATION") {
                if raw.len() > 64 * 1024 {
                    return Err(std::io::Error::other(
                        "AXIOM_E2E_RUNTIME_AUTOMATION exceeds 64 KiB",
                    )
                    .into());
                }
                let automation: serde_json::Value = serde_json::from_str(&raw)?;
                if matches!(
                    automation.get("scenario").and_then(serde_json::Value::as_str),
                    Some("intent_fsynced" | "profile_committed")
                ) {
                    let api_key = automation
                        .get("apiKey")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| std::io::Error::other("Provider Secret fault scenario requires apiKey"))?;
                    seed_e2e_legacy_provider_secret(
                        &app.state::<SecretState>(),
                        "provider.anthropic-compatible.api-key",
                        api_key,
                    )
                    .map_err(std::io::Error::other)?;
                    let legacy_profile = serde_json::json!({
                        "schemaVersion": 2,
                        "profileId": "builtin.minimax-m3",
                        "providerId": "minimax",
                        "apiFormat": "anthropic-compatible",
                        "endpoint": "https://api.minimaxi.com/anthropic/v1/messages",
                        "modelId": "MiniMax-M3",
                        "timeoutMs": 60000,
                        "maxOutputTokens": 4096,
                        "contextWindow": 128000,
                        "capabilities": { "toolReferences": false, "toolSearch": false },
                        "secretId": "provider.anthropic-compatible.api-key"
                    });
                    let encoded_profile = serde_json::to_string(&legacy_profile)?;
                    let encoded_storage_key = serde_json::to_string("axiom.provider.config.v1")?;
                    initialization_scripts.push(format!(
                        "localStorage.setItem({encoded_storage_key}, JSON.stringify({encoded_profile}));"
                    ));
                }
                let encoded = serde_json::to_string(&automation)?;
                initialization_scripts.push(format!(
                    "window.__AXIOM_E2E_RUNTIME_AUTOMATION__ = {encoded};"
                ));
            }
            let window = if initialization_scripts.is_empty() {
                window
            } else {
                window.initialization_script(initialization_scripts.join("\n"))
            };
            window.build()?;
        }
        Ok(())
    });
    #[cfg(feature = "e2e")]
    builder
        .build(context)
        .map_err(|error| format!("error while building Axiom E2E: {error}"))?
        .run(|app, event| handle_e2e_run_event(app, &event));
    #[cfg(not(feature = "e2e"))]
    builder
        .build(context)
        .map_err(|error| format!("error while running Axiom: {error}"))?
        .run(handle_run_event);
    Ok(())
}
