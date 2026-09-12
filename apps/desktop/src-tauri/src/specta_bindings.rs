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
    use tauri_specta::{collect_commands, Builder, ErrorHandlingMode};

    fn export_bindings() -> Result<(), String> {
        let export_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/platform/bindings.ts");
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
            ])
            .export(Typescript::default(), export_path)
            .map_err(|error| format!("failed to export specta bindings: {error}"))
    }

    #[test]
    fn export_ts_bindings() {
        export_bindings().expect("specta bindings export must succeed");
    }
}
