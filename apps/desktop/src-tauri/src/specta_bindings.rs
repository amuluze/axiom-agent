//! tauri-specta 绑定导出：以 Rust 侧类型为单一来源生成前端 TS invoke 绑定。
//
// 边界说明：这里只做类型/绑定导出（`Builder::export`），不接管
// `tauri::generate_handler!`，因此 `npm run test:capabilities` 对
// invoke handler 块与前端字面量命令名的审计保持不变。生成的
// `apps/desktop/src/platform/bindings.ts` 中命令名仍以字面量出现在
// `invoke('...')` 调用中，满足审计前端扫描。

#[cfg(test)]
mod tests {
    use specta_typescript::Typescript;
    use std::fs;
    use std::path::Path;
    use tauri_specta::{collect_commands, Builder, ErrorHandlingMode};

    fn render_bindings(path: &Path) -> Result<(), String> {
        Builder::new()
            .error_handling(ErrorHandlingMode::Throw)
            .commands(collect_commands![
                crate::get_runtime_info,
                crate::file_access::list_authorized_read_files,
                crate::file_access::revoke_authorized_read_file,
                crate::file_access::read_authorized_text,
                crate::workspace_access::get_authorized_workspace,
                crate::workspace_access::get_authorized_workspaces,
                crate::workspace_access::activate_authorized_workspace,
                crate::workspace_access::revoke_workspace,
                crate::workspace_access::list_workspace,
                crate::workspace_access::read_workspace_text,
                crate::browser_session::browser_command,
                crate::session_repository::save_session_checkpoint,
                crate::test_repository::list_test_environment_records,
                crate::test_repository::list_test_run_records,
                crate::test_repository::latest_test_batch_record,
                crate::test_repository::get_test_run_record,
            ])
            .export(Typescript::default(), path)
            .map_err(|error| format!("failed to export specta bindings: {error}"))
    }

    /// 生成物必须与 Rust 源同步：默认只比较、不写盘，避免 CI 静默改写工作区；
    /// 需要更新时设 `AXIOM_UPDATE_SPECTA_BINDINGS=1` 重跑本测试。
    #[test]
    fn export_ts_bindings() {
        let export_path = Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/platform/bindings.ts"
        ));
        let temp = tempfile::NamedTempFile::new().expect("create temp specta file");
        render_bindings(temp.path()).expect("specta bindings render must succeed");
        let generated = fs::read_to_string(temp.path()).expect("read generated specta bindings");
        if std::env::var("AXIOM_UPDATE_SPECTA_BINDINGS").as_deref() == Ok("1") {
            fs::write(export_path, &generated).expect("write specta bindings");
            return;
        }
        let current = fs::read_to_string(export_path).unwrap_or_default();
        assert_eq!(
            current,
            generated,
            "specta bindings are stale; run AXIOM_UPDATE_SPECTA_BINDINGS=1 cargo test specta_bindings::tests::export_ts_bindings"
        );
    }
}
