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
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(app_manifest)
        // 应用/测试 manifest 统一由下方 embed-resource 嵌入（覆盖所有 rustc
        // 目标）：tauri-winres 自带的 manifest 只进 bin 目标，cargo test 的
        // lib 测试 harness 不带 manifest 时，tao/wry 序号导入的 comctl32
        // v6-only 符号（TaskDialogIndirect 等）会让测试进程加载期即
        // ENTRYPOINT_NOT_FOUND（外部 .manifest 受 PreferExternalManifest
        // 默认关闭影响不可靠，必须编译进二进制）。
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if !e2e_enabled {
        // 非 e2e 构建只加载顶层 capabilities/*.json（default）。
        // e2e capability 移到 capabilities/e2e/ 子目录，glob 的 `*` 不跨目录，
        // 非 e2e 时不会加载引用未注册 e2e 命令的 runtime-fault.json
        // （tauri_build 默认扫描 capabilities/**/* 会在非 e2e 干净环境下因权限缺失失败）。
        attributes = attributes.capabilities_path_pattern("capabilities/*.json");
    }
    // 必须先于 try_build：tauri-build 会校验 bundle.resources 路径存在。
    let target_os_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if target_os_windows {
        stage_webview2_loader();
    }
    tauri_build::try_build(attributes)
        .expect("failed to build Axiom with its explicit application command manifest");
    // 见上方 windows_attributes 注释：全目标统一嵌入应用 manifest。
    if target_os_windows {
        // .rc 只引用 .manifest 文件：manifest 内容变化必须显式触发重嵌。
        println!("cargo:rerun-if-changed=windows-app-manifest.rc");
        println!("cargo:rerun-if-changed=windows-app.manifest");
        let _ = embed_resource::compile_for_everything(
            "windows-app-manifest.rc",
            embed_resource::NONE,
        );
    }
}

/// 把 `WebView2Loader.dll` 收进 `resources/`（tauri.windows.conf.json 的
/// bundle.resources 引用，NSIS 打进安装根）：windows-gnu 下 webview2-com-sys
/// 动态链接 loader（MSVC 才有静态库），bundler 不自动收集该 DLL，缺失时安装
/// 后应用加载 WebView2 即崩。构建期从两处取（均由 webview2-com-sys 产出）：
/// target profile 根（gnu 场景自动复制）或其 OUT_DIR 的 x64/ 原件（MSVC 场景
/// 兜底，静态链接下多打包一份 DLL 无害）。
fn stage_webview2_loader() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let target_dir = std::env::var("CARGO_TARGET_DIR")
        .unwrap_or_else(|_| format!("{manifest_dir}/target"));
    let build_root = format!("{target_dir}/{profile}/build");
    let mut candidates = vec![format!("{target_dir}/{profile}/WebView2Loader.dll")];
    if let Ok(entries) = std::fs::read_dir(&build_root) {
        let mut sys_dirs: Vec<_> = entries
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("webview2-com-sys-"))
            .map(|entry| entry.path())
            .collect();
        // 新产物优先（hash 变化后旧目录残留）。
        sys_dirs.sort_by_key(|path| {
            path.metadata().and_then(|meta| meta.modified()).ok()
        });
        if let Some(latest) = sys_dirs.pop() {
            candidates.push(latest.join("out/x64/WebView2Loader.dll").to_string_lossy().into_owned());
        }
    }
    let staged_dir = format!("{manifest_dir}/resources");
    let staged = format!("{staged_dir}/WebView2Loader.dll");
    let Some(source) = candidates.iter().find(|candidate| {
        std::fs::metadata(candidate).map(|meta| meta.is_file()).unwrap_or(false)
    }) else {
        // 找不到不阻断编译：打包阶段 resources 缺失会显式报错，此处多为
        // `cargo check` 等未编译依赖的浅路径。
        println!("cargo:warning=WebView2Loader.dll not found; skip staging (bundle step will fail if packaging)");
        return;
    };
    std::fs::create_dir_all(&staged_dir).expect("create resources staging dir");
    std::fs::copy(source, &staged).expect("stage WebView2Loader.dll");
    println!("cargo:rerun-if-changed=resources/WebView2Loader.dll");
}
