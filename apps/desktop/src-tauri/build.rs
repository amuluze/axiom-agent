const APP_COMMANDS: &[&str] = &[
    "get_runtime_info",
    "write_artifact",
    "read_artifact",
    "trash_artifacts",
    "reconcile_artifacts",
    "gc_artifacts",
    "get_artifact_storage_stats",
    "save_secret",
    "has_secret",
    "migrate_secret",
    "delete_secret",
    "load_provider_secret_cleanup_intent",
    "persist_provider_secret_cleanup_intent",
    "stream_model_http",
    "cancel_model_http",
    "probe_model_http",
    "query_provider_usage",
    "web_search",
    "web_fetch",
    "open_external_url",
    "submit_feedback",
    "browser_command",
    "computer_command",
    "ssh_command",
    "ssh_agent_command",
    "get_connect_config",
    "save_connect_platform_config",
    "clear_connect_platform_config",
    "connect_platform",
    "disconnect_platform",
    "set_connect_workspace",
    "create_connect_pairing_code",
    "unpair_connect_binding",
    "connect_reply_message",
    "start_wechat_login",
    "poll_wechat_login",
    "decode_provider_profile",
    "normalize_provider_profile_draft",
    "is_provider_secret_compatible",
    "is_legacy_provider_secret_compatible",
    "is_known_legacy_provider_secret",
    "pick_and_authorize_read_file",
    "pick_and_authorize_read_directory",
    "list_authorized_read_files",
    "revoke_authorized_read_file",
    "read_authorized_text",
    "authorize_workspace",
    "pick_and_authorize_workspace",
    "activate_authorized_workspace",
    "get_authorized_workspace",
    "get_authorized_workspaces",
    "revoke_workspace",
    "request_workspace_approval_lease",
    "set_workspace_approval_mode",
    "set_prevent_idle_sleep",
    "list_workspace",
    "read_workspace_text",
    "create_workspace_text_file",
    "edit_workspace_text_file",
    "search_workspace_text",
    "cancel_workspace_search",
    "apply_workspace_changes",
    "restore_workspace_trash",
    "get_workspace_recovery_issue",
    "retry_workspace_recovery",
    "run_workspace_command",
    "cancel_workspace_command",
    "spawn_terminal",
    "write_terminal_stdin",
    "resize_terminal",
    "kill_terminal",
    "set_terminal_focus",
    "commit_session_mutation_batch",
    "initialize_session_repository",
    "recover_session_repository",
    "recover_session_repository_session",
    "initialize_session_runtime_defaults",
    "query_session_repository",
    "load_session_repository_snapshot",
    "execute_session_repository",
    "find_workspace_files",
    "clear_session_repository",
    "delete_session_with_successor",
    "create_session_branch",
    "update_session_runtime_config",
    "migrate_session_provider_profiles",
    "append_session_journal_entry",
    "delete_unreferenced_artifact_metadata",
    "start_session_run",
    "start_provider_request",
    "receive_provider_response",
    "start_tool_execution",
    "finish_session_run",
    "persist_session_message",
    "save_session_checkpoint",
    "save_session_turn_point",
    "settle_session_run",
    "transition_session_journal_entries",
];

const E2E_APP_COMMANDS: &[&str] = &["e2e_runtime_fault_checkpoint", "e2e_register_workspace"];

fn main() {
    let mut app_commands = APP_COMMANDS.to_vec();
    let e2e_enabled = std::env::var_os("CARGO_FEATURE_E2E").is_some();
    if e2e_enabled {
        app_commands.extend_from_slice(E2E_APP_COMMANDS);
    }
    let app_commands = Box::leak(app_commands.into_boxed_slice());
    let app_manifest = tauri_build::AppManifest::new().commands(app_commands);
    let mut attributes = tauri_build::Attributes::new().app_manifest(app_manifest);
    if !e2e_enabled {
        // 非 e2e 构建只加载顶层 capabilities/*.json（default）。
        // e2e capability 移到 capabilities/e2e/ 子目录，glob 的 `*` 不跨目录，
        // 非 e2e 时不会加载引用未注册 e2e 命令的 runtime-fault.json
        // （tauri_build 默认扫描 capabilities/**/* 会在非 e2e 干净环境下因权限缺失失败）。
        attributes = attributes.capabilities_path_pattern("capabilities/*.json");
    }
    tauri_build::try_build(attributes)
        .expect("failed to build Axiom with its explicit application command manifest");
}
