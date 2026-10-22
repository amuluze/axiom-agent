//! 文档页（DocsView）的文档读写通道。
//!
//! 保存由文档页「保存 ⌘S」按钮触发；macOS 上命令消费一个由原生鼠标点击或 ⌘S
//! 授予的单次手势配额（`user_gesture.rs`），受陷渲染进程不能在没有真实用户交互时
//! 静默写盘。真正的安全边界仍是授权工作区根、SDD 文档路径白名单（本模块
//! `is_workspace_document_path`，受管目录与 AGENTS.md/DESIGN.md 之外一律拒绝）
//! 与 CAS（`expected_sha256` 与盘上内容不一致即 fail-closed，防止旧快照盖掉会话/
//! 外部编辑器的新写入）。文档本身仍不是安全边界（`.specs/domain/sdd-workflow.md`
//! 不变量 9）：需要强制的规则必须落在代码里。
//! 写路径与 Agent 写工具共用 per-workspace 写锁与恢复门，不会与在途写事务交错。

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager as _;

use crate::file_access::MAX_TEXT_FILE_BYTES;
use crate::user_gesture::{
    current_operating_system, require_user_confirmation, ContentConfirm, UserGestureState,
};
use crate::workspace_access::{
    authorized_root_for, ensure_workspace_path_access, reject_reserved_write_components,
    validate_relative_path, WorkspaceAccessState,
};

/// 根级单文件文档（与 `projectDocs.ts::ROOT_DOC_FILES` + 根 AGENTS.md 同口径）。
/// 受管目录（.specs/domain、.specs/tasks、.plans、.docs）在
/// `is_workspace_document_path` 内联匹配，与 TS 侧 `DOC_ROOTS` 同一目录集合。
const ROOT_DOC_FILES: [&str; 2] = ["AGENTS.md", "DESIGN.md"];

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_markdown_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".md")
}

/// 文档页保存的路径白名单：只接受 SDD 文档结构的成员——根级 `AGENTS.md` /
/// `DESIGN.md`、四个受管目录内（含子目录）的 Markdown、任意目录下的 `AGENTS.md`
/// （嵌套项目指南，与提示词 `<available_agents>` 索引同一发现面）。其余路径
/// fail-closed，本命令不得成为任意文件写通道。
pub(crate) fn is_workspace_document_path(relative: &Path) -> bool {
    let Some(name) = relative.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let components: Vec<String> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    // 根级单文件：整条路径就是文件名本身。
    if components.len() == 1 {
        return ROOT_DOC_FILES.iter().any(|f| components[0] == *f);
    }
    if let (Some(first), Some(second)) = (components.first(), components.get(1)) {
        match (first.as_str(), second.as_str()) {
            (".specs", "domain") | (".specs", "tasks") | (".plans", _) | (".docs", _) => {
                return is_markdown_name(name)
            }
            _ => {}
        }
    }
    // 嵌套 AGENTS.md：任意目录深度（发现面见 projectAgents.ts 的 **/AGENTS.md）。
    name == "AGENTS.md"
}

fn read_capped(path: &Path, what: &str) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("failed to inspect {what}: {error}"))?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "{what} is larger than the {} byte limit",
            MAX_TEXT_FILE_BYTES
        ));
    }
    let bytes = std::fs::read(path).map_err(|error| format!("failed to read {what}: {error}"))?;
    // metadata 与 read 之间仍可能被外部追加；读后复查，避免把超大内容带进 IPC。
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "{what} is larger than the {} byte limit",
            MAX_TEXT_FILE_BYTES
        ));
    }
    Ok(bytes)
}

fn resolve_workspace_document(
    root: &Path,
    relative: &Path,
    mutation: bool,
) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(root.join(relative))
        .map_err(|error| format!("failed to resolve workspace document: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("workspace document resolves outside the authorized root".into());
    }
    let canonical_relative = canonical
        .strip_prefix(root)
        .map_err(|_| "workspace document resolves outside the authorized root".to_string())?;
    if !is_workspace_document_path(canonical_relative) {
        return Err("resolved target is not an SDD managed document or AGENTS.md file".into());
    }
    ensure_workspace_path_access(root, &canonical, mutation)?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect workspace document: {error}"))?;
    if !metadata.is_file() {
        return Err("workspace document path is not a regular file".into());
    }
    Ok(canonical)
}

fn resolve_workspace_document_for_write(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    resolve_workspace_document(root, relative, true)
}

fn resolve_workspace_document_for_read(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    resolve_workspace_document(root, relative, false)
}

fn read_workspace_document_impl(
    root: &Path,
    relative: &Path,
) -> Result<(Vec<u8>, PathBuf), String> {
    let canonical = resolve_workspace_document_for_read(root, relative)?;
    let bytes = read_capped(&canonical, "workspace document")?;
    Ok((bytes, canonical))
}

fn preserve_document_line_endings(current: &[u8], updated: &[u8]) -> Vec<u8> {
    let Ok(current) = std::str::from_utf8(current) else {
        return updated.to_vec();
    };
    if !current.contains("\r\n") {
        return updated.to_vec();
    }
    let remainder = current.replace("\r\n", "");
    if remainder.contains('\r') || remainder.contains('\n') {
        return updated.to_vec();
    }
    let Ok(updated) = std::str::from_utf8(updated) else {
        return updated.to_vec();
    };
    updated
        .replace("\r\n", "\n")
        .replace('\n', "\r\n")
        .into_bytes()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDocument {
    pub(crate) workspace_path: String,
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) sha256: String,
    pub(crate) size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedWorkspaceDocument {
    pub(crate) workspace_path: String,
    pub(crate) sha256: String,
    pub(crate) size_bytes: u64,
}

/// 原子写：临时文件 + `persist`（rename），保留原文件权限位，落盘后同步父目录
/// （与设计稿写通道同一实现形态）。
fn write_document_bytes(canonical: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = canonical
        .parent()
        .ok_or_else(|| "workspace document has no parent directory".to_string())?;
    let metadata = std::fs::metadata(canonical)
        .map_err(|error| format!("failed to inspect workspace document: {error}"))?;
    let temporary = tempfile::Builder::new()
        .prefix(".axiom-doc-write-")
        .tempfile_in(directory)
        .map_err(|error| format!("failed to create temp file for document write: {error}"))?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("failed to preserve document permissions: {error}"))?;
    temporary
        .as_file()
        .write_all(bytes)
        .map_err(|error| format!("failed to write document: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync document: {error}"))?;
    temporary
        .persist(canonical)
        .map_err(|error| format!("failed to save document: {}", error.error))?;
    crate::workspace_access::sync_parent_directory(canonical)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn read_workspace_document(
    app: tauri::AppHandle,
    path: String,
    workspace_path: Option<String>,
) -> Result<WorkspaceDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let relative = validate_relative_path(Some(&path))?;
        reject_reserved_write_components(&relative)?;
        if !is_workspace_document_path(&relative) {
            return Err(
                "document reading only accepts SDD managed documents and AGENTS.md files".into(),
            );
        }
        let (bytes, _canonical) = read_workspace_document_impl(&root, &relative)?;
        let content = String::from_utf8(bytes)
            .map_err(|_| "workspace document is not valid UTF-8 text".to_string())?;
        Ok(WorkspaceDocument {
            workspace_path: root.to_string_lossy().into(),
            path,
            sha256: sha256_hex(content.as_bytes()),
            size_bytes: content.len() as u64,
            content,
        })
    })
    .await
    .map_err(|error| format!("document read task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn save_workspace_document(
    app: tauri::AppHandle,
    gesture: tauri::State<'_, std::sync::Arc<UserGestureState>>,
    path: String,
    content_base64: String,
    expected_sha256: String,
    workspace_path: Option<String>,
) -> Result<SavedWorkspaceDocument, String> {
    // macOS：保存按钮点击 / ⌘S 已由原生 monitor 授予配额，没有真实手势直接拒绝。
    // 非 macOS：没有等价手势信号，降级为一次宿主原生确认对话框——受陷渲染进程
    // 无法自动确认对话框，因此同样不会出现「静默写盘」。
    let confirmed = require_user_confirmation(
        &app,
        gesture.inner().as_ref(),
        current_operating_system(),
        None,
        ContentConfirm {
            title: "确认保存文档",
            message: format!("即将保存项目文档：\n\n{}\n\n确认保存？", path),
            confirm_label: "保存",
        },
    )
    .await?;
    if !confirmed {
        return Err("用户取消了文档保存".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let relative = validate_relative_path(Some(&path))?;
        reject_reserved_write_components(&relative)?;
        if !is_workspace_document_path(&relative) {
            return Err(
                "document saving only accepts SDD managed documents and AGENTS.md files".into(),
            );
        }
        let bytes = BASE64
            .decode(content_base64.as_bytes())
            .map_err(|error| format!("invalid base64 document content: {error}"))?;
        if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
            return Err(format!(
                "document exceeds the {} byte limit",
                MAX_TEXT_FILE_BYTES
            ));
        }
        std::str::from_utf8(&bytes)
            .map_err(|_| "document content must be valid UTF-8 text".to_string())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let write_lock = state.workspace_write_lock(&root);
        let _write_lock = write_lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        authorized_root_for(&state, Some(&root.to_string_lossy()))?;
        let canonical = resolve_workspace_document_for_write(&root, &relative)?;
        let current = read_capped(&canonical, "workspace document")?;
        if sha256_hex(&current) != expected_sha256 {
            return Err("document changed on disk since it was loaded; refresh and retry".into());
        }
        let bytes = preserve_document_line_endings(&current, &bytes);
        if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
            return Err(format!(
                "document exceeds the {} byte limit",
                MAX_TEXT_FILE_BYTES
            ));
        }
        write_document_bytes(&canonical, &bytes)?;
        Ok(SavedWorkspaceDocument {
            workspace_path: root.to_string_lossy().into(),
            sha256: sha256_hex(&bytes),
            size_bytes: bytes.len() as u64,
        })
    })
    .await
    .map_err(|error| format!("document save task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn rel(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn document_path_whitelist_accepts_sdd_structure_only() {
        for accepted in [
            "AGENTS.md",
            "DESIGN.md",
            ".specs/domain/workspace-authorization.md",
            ".specs/tasks/add-providers.md",
            ".plans/terminal-per-workspace.md",
            ".docs/sdd-workflow-implementation.md",
            // 受管目录内的子目录也属于文档树成员。
            ".specs/domain/nested/deep-spec.md",
            // 嵌套 AGENTS.md：任意目录深度。
            "apps/desktop/AGENTS.md",
            "packages/pkg/sub/AGENTS.md",
        ] {
            assert!(
                is_workspace_document_path(&rel(accepted)),
                "{accepted} 应在文档保存白名单内"
            );
        }
        for rejected in [
            "README.md",
            "src/main.rs",
            "notes.txt",
            ".specs/domain/preview.png",
            ".specs/other/task.md",
            "axiom.ax",
            ".axiom/registry.json",
            "",
        ] {
            assert!(
                !is_workspace_document_path(&rel(rejected)),
                "{rejected} 不应进入文档保存白名单"
            );
        }
    }

    #[test]
    fn write_document_bytes_replaces_content_atomically() {
        let directory = tempfile::tempdir().expect("temp dir");
        let target = directory.path().join("spec.md");
        std::fs::write(&target, "# old\n").expect("seed document");
        let mode = std::fs::metadata(&target).expect("metadata").permissions();
        write_document_bytes(&target, b"# new\n").expect("write");
        assert_eq!(std::fs::read(&target).expect("reread"), b"# new\n");
        assert_eq!(
            std::fs::metadata(&target)
                .expect("metadata")
                .permissions()
                .mode(),
            mode.mode(),
            "权限位应在原子替换后保留"
        );
        // 临时文件不残留。
        let leftovers: Vec<_> = std::fs::read_dir(directory.path())
            .expect("list dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".axiom-doc-write-")
            })
            .collect();
        assert!(leftovers.is_empty(), "临时文件应已 persist，不残留");
    }

    #[test]
    fn document_save_preserves_uniform_crlf_line_endings() {
        assert_eq!(
            preserve_document_line_endings(b"# old\r\nbody\r\n", b"# new\nbody\n"),
            b"# new\r\nbody\r\n"
        );
        assert_eq!(
            preserve_document_line_endings(b"# old\nbody\n", b"# new\nbody\n"),
            b"# new\nbody\n"
        );
    }

    #[test]
    fn document_write_resolver_rejects_symlink_escape_and_non_document_target() {
        let workspace = tempfile::tempdir().expect("workspace");
        let outside = tempfile::tempdir().expect("outside");
        let root = std::fs::canonicalize(workspace.path()).expect("canonical workspace");
        std::fs::create_dir(root.join(".docs")).expect("create docs");
        std::fs::create_dir(root.join("src")).expect("create src");
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("seed source");
        std::os::unix::fs::symlink(root.join("src/main.rs"), root.join(".docs/source.md"))
            .expect("link to non-document");
        assert!(resolve_workspace_document_for_write(&root, Path::new(".docs/source.md")).is_err());

        std::fs::remove_dir(root.join(".docs")).expect_err("non-empty docs remains");
        std::fs::remove_file(root.join(".docs/source.md")).expect("remove file link");
        std::fs::remove_dir(root.join(".docs")).expect("remove docs");
        std::fs::write(outside.path().join("outside.md"), "# outside\n").expect("seed outside");
        std::os::unix::fs::symlink(outside.path(), root.join(".docs")).expect("link docs outside");
        assert!(
            resolve_workspace_document_for_write(&root, Path::new(".docs/outside.md")).is_err()
        );
    }

    #[test]
    fn document_read_returns_managed_document_bytes() {
        let workspace = tempfile::tempdir().expect("workspace");
        let root = std::fs::canonicalize(workspace.path()).expect("canonical workspace");
        std::fs::create_dir(root.join(".docs")).expect("create docs");
        std::fs::write(root.join(".docs/read.md"), "# Read\n\nbody\n").expect("seed document");
        let (bytes, canonical) = read_workspace_document_impl(&root, Path::new(".docs/read.md"))
            .expect("read managed document");
        assert_eq!(bytes, b"# Read\n\nbody\n");
        assert_eq!(canonical, root.join(".docs/read.md"));
        // 读取通道与保存通道共用同一份路径白名单。
        assert!(read_workspace_document_impl(&root, Path::new("README.md")).is_err());
    }

    #[test]
    fn document_read_rejects_oversized_document() {
        let workspace = tempfile::tempdir().expect("workspace");
        let root = std::fs::canonicalize(workspace.path()).expect("canonical workspace");
        std::fs::create_dir(root.join(".docs")).expect("create docs");
        let target = root.join(".docs/oversized.md");
        let file = std::fs::File::create(&target).expect("create oversized document");
        file.set_len(MAX_TEXT_FILE_BYTES + 1).expect("extend file");
        assert!(read_workspace_document_impl(&root, Path::new(".docs/oversized.md")).is_err());
    }
}
