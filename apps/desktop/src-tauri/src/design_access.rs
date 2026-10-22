//! 设计稿读取通道（设计画布 Design Canvas 的只读数据源，docs/design-canvas.md §7 v0.1）。
//! 复用工作区读取链的安全判定（相对路径校验 / canonicalize / starts_with root
//! 兜底），敏感路径由工作区读取政策强制保护。定点放行仅限：设计稿扩展名（8MiB 上限，对齐
//! artifact 存储）与同目录图片资产（沿用 read 工具图片分支的 1MiB 上限
//! 与魔数 mime 校验）——不放松其它约束；JSON 解析在前端，大小上限在 Rust 强制。
//!
//! `.ax` 是唯一可持久化设计稿格式；`.pen` 仅作为 pen.dev 迁移输入。两者读取
//! 共用路径解析与 8MiB 上限，写入、监听和历史版本只接受 `.ax`。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager as _};

use crate::image_detect::{detect_image_mime, is_supported_image_path};
use crate::user_gesture::{
    current_operating_system, require_user_confirmation, ContentConfirm, UserGestureState,
};
use crate::workspace_access::{authorized_root_for, validate_relative_path, WorkspaceAccessState};

/// 对齐 artifact 存储的 8MiB 上限，为增量演进留足余量。
const MAX_DESIGN_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
/// 图片资产与 read 工具图片分支同款 1MiB 上限。
const MAX_DESIGN_ASSET_BYTES: u64 = 1024 * 1024;

/// 设计稿写入扩展名白名单：仅 `.ax`；`.pen` 只保留导入读取。
const DESIGN_DOCUMENT_EXTENSIONS: [&str; 1] = ["ax"];

/// 路径是否为设计稿（按扩展名，大小写不敏感）。读、写、watch、资产四条通道共用。
pub(crate) fn is_design_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            DESIGN_DOCUMENT_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

/// 设计稿写路径定点放行判定（docs/design-canvas.md D1）：仅按扩展名识别，
/// 命中返回设计稿写入上限（8MiB，对齐 artifact 存储）。供 create/edit/apply
/// 写通道复用——Agent 经既有写工具链直接编辑设计稿，审批租赁、恢复事务、
/// sha-256 完整性全部原样生效，不新增工具契约面。

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignDocumentContent {
    content_base64: String,
    workspace_path: String,
    sha256: String,
    size_bytes: u64,
    modified_ms: Option<u64>,
    /// known_sha256 命中时为 true：内容未变，content_base64 为空串不重复传输。
    unchanged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignAssetContent {
    content_base64: String,
    media_type: String,
    sha256: String,
}

/// 在绑定的授权工作区根内解析设计稿相对路径，返回（canonical 路径, 所属根）。
/// 不遍历其它授权根；未传 workspace_path 时沿用当前工作区。
fn resolve_design_document(
    state: &tauri::State<'_, WorkspaceAccessState>,
    path: &str,
    workspace_path: Option<&str>,
) -> Result<(PathBuf, PathBuf), String> {
    let root = authorized_root_for(state, workspace_path)?;
    resolve_design_document_in_roots(&[root], path)
}

/// resolve 的可测内核（roots 切片直入，对抗用例见 tests 模块）。安全判定：
/// validate_relative_path 拒 `..`/绝对路径 → canonicalize 消解 symlink →
/// starts_with root 兜底 → canonical 文件名与请求一致（防 symlink 置换改扩展名）。
fn resolve_design_document_in_roots(
    roots: &[PathBuf],
    path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    if roots.len() != 1 {
        return Err("design document must be bound to exactly one workspace".into());
    }
    let relative = validate_relative_path(Some(path))?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| "design document path is empty".to_string())?;
    for root in roots {
        let target = root.join(&relative);
        let Ok(canonical) = std::fs::canonicalize(&target) else {
            continue;
        };
        if !canonical.starts_with(root) {
            continue;
        }
        crate::workspace_access::ensure_workspace_path_access(root, &canonical, false)?;
        if canonical.file_name() != Some(file_name) {
            // canonicalize 消解 symlink 后文件名可能被置换：以 canonical 名为准
            // 重查扩展名（相对段已在 validate_relative_path 拒绝 ..）。
            continue;
        }
        if !is_design_document_path(&canonical)
            && !canonical
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pen"))
        {
            return Err("design documents only accept .ax files; .pen is an import source".into());
        }
        return Ok((canonical, root.clone()));
    }
    Err(format!(
        "design document not found in any authorized workspace: {path}"
    ))
}

/// 写通道的 resolve 附加约束：保留目录（`.git`/`.axiom`）不可写入——与 Agent
/// 写路径（create/edit/apply）同口径，画布手势通道不扩大例外面。
fn resolve_design_document_for_write(
    roots: &[PathBuf],
    path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let relative = validate_relative_path(Some(path))?;
    crate::workspace_access::reject_reserved_write_components(&relative)?;
    if !is_design_document_path(&relative) {
        return Err(
            "design editing only accepts .ax files; use design_import to migrate .pen".into(),
        );
    }
    resolve_design_document_in_roots(roots, path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 返回路径的设计稿写入上限；非设计稿返回 None（调用方回退 1MiB 文本上限）。
pub(crate) fn design_document_write_limit(path: &Path) -> Option<u64> {
    is_design_document_path(path).then_some(MAX_DESIGN_DOCUMENT_BYTES)
}

pub(crate) fn design_document_transfer_limit(path: &Path) -> Option<u64> {
    design_document_write_limit(path).or_else(|| {
        path.extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pen"))
            .then_some(MAX_DESIGN_DOCUMENT_BYTES)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_name_of_reads_page_name_for_confirmation() {
        let doc = r#"{"pages":[{"id":"p1","name":"会话"},{"id":"p2"}]}"#.as_bytes();
        assert_eq!(page_name_of(doc, "p1").as_deref(), Some("会话"));
        // 缺 name 时回退页 id：确认框不能出现空文案。
        assert_eq!(page_name_of(doc, "p2").as_deref(), Some("p2"));
        let blank = r#"{"pages":[{"id":"p3","name":"   "}]}"#.as_bytes();
        assert_eq!(page_name_of(blank, "p3").as_deref(), Some("p3"));
        // 找不到页 / 坏 JSON：None，调用方据此在弹框前 fail-closed。
        assert_eq!(page_name_of(doc, "missing"), None);
        assert_eq!(page_name_of(b"not json", "p1"), None);
    }

    #[test]
    fn write_limit_accepts_design_document_extensions() {
        for path in ["designs/axiom.ax", "designs/AXIOM.AX"] {
            assert_eq!(
                design_document_write_limit(Path::new(path)),
                Some(MAX_DESIGN_DOCUMENT_BYTES),
                "{path} 应被视为设计稿"
            );
        }
        assert_eq!(design_document_write_limit(Path::new("notes.txt")), None);
        assert_eq!(design_document_write_limit(Path::new("a.pen")), None);
        assert_eq!(design_document_write_limit(Path::new("pen")), None);
        // 扩展名判定按段匹配：`x.axz` / `a.pen.bak` 不是设计稿。
        assert_eq!(design_document_write_limit(Path::new("x.axz")), None);
        assert_eq!(design_document_write_limit(Path::new("a.pen.bak")), None);
    }

    #[test]
    fn revoke_for_workspace_drops_only_matching_workspace_watchers() {
        let state = DesignWatchState::new();
        let entry = |workspace: &str, relative: &str| DesignWatchEntry {
            canonical: PathBuf::from("/data").join(relative),
            workspace: PathBuf::from(workspace),
            relative: relative.to_string(),
            _watcher: notify::recommended_watcher(|_| {}).expect("watcher"),
            subscribers: 1,
        };
        {
            let mut watchers = state.watchers.lock().expect("lock");
            watchers.push(entry("/ws-a", "design/home.ax"));
            watchers.push(entry("/ws-b", "design/home.ax"));
            watchers.push(entry("/ws-a", "design/other.ax"));
        }
        let removed = state
            .revoke_for_workspace(Path::new("/ws-a"))
            .expect("revoke purge should succeed");
        assert_eq!(removed, 2);
        let watchers = state.watchers.lock().expect("lock");
        assert_eq!(watchers.len(), 1);
        assert_eq!(watchers[0].workspace, PathBuf::from("/ws-b"));
    }

    #[test]
    fn write_bytes_persists_atomically_and_reports_sha256() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("a.ax");
        std::fs::write(&path, br#"{"children":[]}"#).expect("seed file");
        let content = br#"{"children":[{"id":"p1"}]}"#;
        let written =
            write_design_document_bytes(&path, content, None).expect("write should succeed");
        assert_eq!(written.size_bytes, content.len() as u64);
        assert_eq!(std::fs::read(&path).expect("read back"), content);
        // CAS 命中：携带上一轮返回的 sha256 可继续写。
        write_design_document_bytes(&path, br#"{"children":[]}"#, Some(&written.sha256))
            .expect("cas-matched write should succeed");
    }

    #[test]
    fn write_bytes_rejects_cas_mismatch_bad_json_and_oversize() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("a.ax");
        std::fs::write(&path, br#"{"children":[]}"#).expect("seed file");
        // CAS 失败：盘上内容已被外部（Agent/pen.dev）更新，旧快照拒绝落盘。
        let error = write_design_document_bytes(&path, br#"{"children":1}"#, Some("deadbeef"))
            .expect_err("stale snapshot must be rejected");
        assert!(error.contains("changed on disk"));
        assert_eq!(
            std::fs::read(&path).expect("read back"),
            br#"{"children":[]}"#,
            "rejected write must not touch the file"
        );
        // JSON 非法：写前拦截，不产生半损坏的设计稿。
        assert!(write_design_document_bytes(&path, b"not json", None).is_err());
        // 超上限：拒绝且不碰盘。
        let oversized = vec![b'a'; (MAX_DESIGN_DOCUMENT_BYTES + 1) as usize];
        assert!(write_design_document_bytes(&path, &oversized, None).is_err());
    }

    #[test]
    fn write_bytes_preserves_source_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("a.ax");
        std::fs::write(&path, br#"{"children":[]}"#).expect("seed file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("seed permissions");
        write_design_document_bytes(&path, br#"{"children":[1]}"#, None).expect("write");
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o640,
            "写盘后必须保留源文件权限（tempfile 默认 0600 不得泄漏）"
        );
    }

    #[test]
    fn page_deletion_accepts_only_the_requested_semantic_change() {
        let current = br#"{"ax":"1.5","pages":[{"id":"p1","name":"A"},{"id":"p2","name":"B"}],"tokens":{"x":1}}"#;
        let deleted = br#"{
          "tokens": {"x": 1},
          "pages": [{"name":"A","id":"p1"}],
          "ax": "1.5"
        }"#;
        validate_page_deletion(current, deleted, "p2").expect("exact page deletion");

        let changed = br#"{"ax":"1.5","pages":[{"id":"p1","name":"changed"}],"tokens":{"x":1}}"#;
        assert!(validate_page_deletion(current, changed, "p2").is_err());
        assert!(validate_page_deletion(current, deleted, "p1").is_err());
    }

    #[test]
    fn page_deletion_rejects_ambiguous_or_last_page() {
        let duplicate = br#"{"pages":[{"id":"p1"},{"id":"p1"}]}"#;
        assert!(validate_page_deletion(duplicate, br#"{"pages":[{"id":"p1"}]}"#, "p1").is_err());
        assert!(
            validate_page_deletion(br#"{"pages":[{"id":"p1"}]}"#, br#"{"pages":[]}"#, "p1")
                .is_err()
        );
    }

    /// roots 直入的 resolve 内核（tempdir 在 macOS 上经 /var → /private/var，先
    /// canonicalize 根目录再判定 starts_with，与命令路径同坐标系）。
    fn canonical_roots(dirs: &[&std::path::Path]) -> Vec<PathBuf> {
        dirs.iter()
            .map(|dir| std::fs::canonicalize(dir).expect("canonicalize root"))
            .collect()
    }

    #[test]
    fn resolve_rejects_traversal_absolute_and_missing() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("a.pen"), br#"{}"#).expect("seed");
        let roots = canonical_roots(&[directory.path()]);
        // `..` 与绝对路径在 validate_relative_path 一层即被拒。
        assert!(resolve_design_document_in_roots(&roots, "../escape.pen").is_err());
        assert!(resolve_design_document_in_roots(&roots, "/etc/passwd").is_err());
        assert!(resolve_design_document_in_roots(&roots, "missing.pen").is_err());
        // 命中：返回 canonical 路径与根。
        let (canonical, root) = resolve_design_document_in_roots(&roots, "a.pen").expect("resolve");
        assert!(canonical.ends_with("a.pen"));
        assert_eq!(root, roots[0]);
    }

    #[test]
    fn resolve_rejects_symlink_escape_and_extension_swap() {
        use std::os::unix::fs::symlink;

        let inside = tempfile::tempdir().expect("inside");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("evil.pen"), br#"{}"#).expect("outside target");
        std::fs::write(outside.path().join("axiom.pen"), br#"{}"#).expect("outside same-name");
        std::fs::write(inside.path().join("notes.txt"), b"not a design").expect("decoy");
        // 同名越界：canonical 落在根外（starts_with 兜底拦截）。
        symlink(
            outside.path().join("axiom.pen"),
            inside.path().join("axiom.pen"),
        )
        .expect("symlink same-name");
        // 异名越界：canonical 文件名与请求不一致（置换防御）+ 落在根外。
        symlink(
            outside.path().join("evil.pen"),
            inside.path().join("link.pen"),
        )
        .expect("symlink renamed");
        // 根内扩展名置换：x.pen → x.txt（canonical 文件名不一致即拒）。
        symlink(inside.path().join("notes.txt"), inside.path().join("x.pen"))
            .expect("symlink extension swap");
        let roots = canonical_roots(&[inside.path()]);
        for name in ["axiom.pen", "link.pen", "x.pen"] {
            assert!(
                resolve_design_document_in_roots(&roots, name).is_err(),
                "{name} 的 symlink 越界/置换必须被拒"
            );
        }
        // 真实存在但非设计稿扩展名：显式报错（而不是静默 not found）。
        let error = resolve_design_document_in_roots(&roots, "notes.txt")
            .expect_err("non-design extension must be rejected");
        assert!(error.contains("only accept .ax"));
    }

    #[test]
    fn resolve_binds_same_named_documents_to_one_workspace() {
        let first = tempfile::tempdir().expect("first");
        let second = tempfile::tempdir().expect("second");
        std::fs::write(first.path().join("shared.pen"), br#"{"first":true}"#).expect("seed first");
        std::fs::write(second.path().join("shared.pen"), br#"{"second":true}"#)
            .expect("seed second");
        let roots = canonical_roots(&[first.path(), second.path()]);
        assert!(resolve_design_document_in_roots(&roots, "shared.pen").is_err());
        for (index, expected) in [
            br#"{"first":true}"#.as_slice(),
            br#"{"second":true}"#.as_slice(),
        ]
        .iter()
        .enumerate()
        {
            let (canonical, root) =
                resolve_design_document_in_roots(&roots[index..index + 1], "shared.pen")
                    .expect("resolve bound root");
            assert_eq!(root, roots[index]);
            assert_eq!(std::fs::read(canonical).expect("read"), *expected);
        }
    }

    #[test]
    fn resolve_for_write_rejects_reserved_directories() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(directory.path().join(".git")).expect("mkdir .git");
        std::fs::write(directory.path().join(".git/hook.pen"), br#"{}"#).expect("seed");
        std::fs::write(directory.path().join("normal.pen"), br#"{}"#).expect("seed");
        let roots = canonical_roots(&[directory.path()]);
        // 保留目录内的设计稿：读通道可解析（只读），写通道拒绝（与 Agent 写路径同口径）。
        assert!(resolve_design_document_in_roots(&roots, ".git/hook.pen").is_ok());
        let error = resolve_design_document_for_write(&roots, ".git/hook.pen")
            .expect_err("reserved directory write must be rejected");
        assert!(error.contains("control directories"), "实际错误：{error}");
        // 大小写变体同样拒绝（APFS/HFS+ 大小写不敏感）。
        assert!(resolve_design_document_for_write(&roots, ".GIT/hook.pen").is_err());
        assert!(resolve_design_document_for_write(&roots, "normal.pen").is_err());
        std::fs::write(directory.path().join("normal.ax"), br#"{}"#).expect("seed ax");
        assert!(resolve_design_document_for_write(&roots, "normal.ax").is_ok());
    }

    #[test]
    fn history_backup_precedes_write_and_restore_keeps_current_version() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().join("workspace");
        std::fs::create_dir(&root).expect("workspace");
        let data = directory.path().join("data");
        let document = root.join("draft.ax");
        let original = br#"{"ax":"1.3","pages":[{"id":"p1"},{"id":"p2"}]}"#;
        let deleted = br#"{"ax":"1.3","pages":[{"id":"p1"}]}"#;
        std::fs::write(&document, original).expect("seed");
        let baseline = sha256_hex(original);
        let written =
            write_design_document_with_history(&document, &root, &data, deleted, Some(&baseline))
                .expect("delete");
        let history = crate::design_history::directory(&data, &root, &document);
        assert_eq!(
            crate::design_history::read(&history, &baseline).expect("backup"),
            original
        );
        let restored = write_design_document_with_history(
            &document,
            &root,
            &data,
            original,
            Some(&written.sha256),
        )
        .expect("restore");
        assert!(restored.history_warning.is_none());
        assert_eq!(std::fs::read(&document).expect("restored"), original);
        assert_eq!(
            crate::design_history::read(&history, &written.sha256).expect("reverse backup"),
            deleted
        );
        #[cfg(unix)]
        {
            let renamed = root.join("renamed.ax");
            std::fs::rename(&document, &renamed).expect("rename immediately after restore");
            crate::design_history::observe(&data, &root, &renamed, original)
                .expect("inherit restored identity without another read");
            let relocated = crate::design_history::directory(&data, &root, &renamed);
            assert_eq!(
                crate::design_history::read(&relocated, &written.sha256).expect("inherited backup"),
                deleted
            );
        }
    }

    #[test]
    fn stale_or_failed_backup_never_changes_the_document() {
        let directory = tempfile::tempdir().expect("tempdir");
        let document = directory.path().join("draft.ax");
        let original = br#"{"ax":"1.3","pages":[]}"#;
        std::fs::write(&document, original).expect("seed");
        let data = directory.path().join("data");
        assert!(write_design_document_with_history(
            &document,
            directory.path(),
            &data,
            b"{}",
            Some("stale")
        )
        .is_err());
        assert!(!data.exists());
        std::fs::write(&data, b"not a directory").expect("block history");
        assert!(write_design_document_with_history(
            &document,
            directory.path(),
            &data,
            b"{}",
            Some(&sha256_hex(original))
        )
        .is_err());
        assert_eq!(std::fs::read(&document).expect("unchanged"), original);
    }
}

/// 硬上限读取：metadata 长度预检与 fs::read 之间存在 TOCTOU 窗口（检查后被
/// 换大文件），读取时 take(limit+1) 再判长，超限拒绝且不完整加载。
fn read_capped(path: &Path, limit: u64, what: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file =
        std::fs::File::open(path).map_err(|error| format!("failed to open {what}: {error}"))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {what}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{what} exceeds the {} MiB limit",
            limit / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

fn modified_epoch_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

/// 读取设计稿文档：返回 base64 内容 + sha256 + 大小 + 修改时间。
/// 前端以 sha256 做轮询同步判定。known_sha256 与当前内容一致时返回
/// unchanged=true 且不回传 base64——慢轮询兜底的主要成本是 1.4MB 文件的
/// base64 IPC 传输（~1.9MB），内容比对短路后常态轮询只剩一次磁盘读。
#[tauri::command]
pub(crate) async fn read_design_document(
    app: tauri::AppHandle,
    path: String,
    known_sha256: Option<String>,
    workspace_path: Option<String>,
) -> Result<DesignDocumentContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let write_lock = state.workspace_write_lock(&root);
        let _write_lock = write_lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        let (canonical, root) = resolve_design_document(&state, &path, workspace_path.as_deref())?;
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("failed to stat design document: {error}"))?;
        if !metadata.is_file() {
            return Err("design document path is not a regular file".into());
        }
        let bytes = read_capped(&canonical, MAX_DESIGN_DOCUMENT_BYTES, "design document")?;
        let history_warning = crate::design_history::observe(
            &crate::storage_paths::axiom_data_root(&app)?,
            &root,
            &canonical,
            &bytes,
        )
        .err();
        let sha256 = sha256_hex(&bytes);
        if known_sha256.as_deref() == Some(sha256.as_str()) {
            return Ok(DesignDocumentContent {
                content_base64: String::new(),
                workspace_path: root.to_string_lossy().into_owned(),
                sha256,
                size_bytes: bytes.len() as u64,
                modified_ms: modified_epoch_ms(&canonical),
                unchanged: true,
                history_warning,
            });
        }
        Ok(DesignDocumentContent {
            content_base64: BASE64.encode(&bytes),
            workspace_path: root.to_string_lossy().into_owned(),
            sha256,
            size_bytes: bytes.len() as u64,
            modified_ms: modified_epoch_ms(&canonical),
            unchanged: false,
            history_warning,
        })
    })
    .await
    .map_err(|error| format!("design read task failed: {error}"))?
}

/// 设计稿文件监听池：canonical 路径 → watcher（drop 即停止监听）。
/// 独立于 WorkspaceAccessState：watcher 只读事件源，不参与写串行/恢复事务。
pub(crate) struct DesignWatchState {
    /// 线性表而非 HashMap：池上限内线性查找开销可忽略，且保留插入顺序便于逐出。
    watchers: Mutex<Vec<DesignWatchEntry>>,
}

struct DesignWatchEntry {
    canonical: PathBuf,
    workspace: PathBuf,
    relative: String,
    _watcher: RecommendedWatcher,
    subscribers: usize,
}

/// 监听池上限：画布同一时刻只 watch 当前选中的 .ax，多会话并行也不会超过。
const DESIGN_WATCH_POOL_LIMIT: usize = 8;

impl DesignWatchState {
    pub(crate) fn new() -> Self {
        Self {
            watchers: Mutex::new(Vec::new()),
        }
    }

    /// 撤销工作区时清空该工作区的全部监听条目（与 cancel_for_workspace /
    /// kill_for_workspace 同属撤销联动收口）。watcher 不参与安全判定，但撤销后
    /// 残留 watcher 会对已撤销工作区持续 emit 噪声事件（payload 仅路径无内容），
    /// 且逐出兜底要等池满 FIFO。毒锁传播而非吞掉：与撤销链其它联动步骤的
    /// `?` 语义一致，失败即整体失败、用户可重试。
    pub(crate) fn revoke_for_workspace(&self, target: &Path) -> Result<usize, String> {
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "design watch pool lock is poisoned".to_string())?;
        let before = watchers.len();
        watchers.retain(|entry| entry.workspace != target);
        Ok(before - watchers.len())
    }
}

/// 监听设计稿文件变更：路径复用 read 通道的 resolve 判定（授权根内设计稿），
/// 事件经 `design-document-changed` emit（payload 带原始相对 path）。
/// 替换前端 1.5s 全量读轮询：每次写入产生 base64+sha256 全量 I/O，而
/// 事件驱动只在真实变更时读一次。access 类事件（纯读）不触发。
#[tauri::command]
pub(crate) fn watch_design_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceAccessState>,
    watch_state: tauri::State<'_, DesignWatchState>,
    path: String,
    workspace_path: Option<String>,
) -> Result<bool, String> {
    let root = authorized_root_for(&state, workspace_path.as_deref())?;
    let (canonical, _) = resolve_design_document_for_write(std::slice::from_ref(&root), &path)?;
    let mut watchers = watch_state
        .watchers
        .lock()
        .map_err(|_| "design watch pool lock is poisoned".to_string())?;
    if let Some(entry) = watchers.iter_mut().find(|entry| {
        entry.canonical == canonical && entry.workspace == root && entry.relative == path
    }) {
        entry.subscribers += 1;
        return Ok(false);
    }
    let event_path = path.clone();
    let event_workspace = root.to_string_lossy().into_owned();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        // emit 失败（前端已关）静默忽略：watcher 池由 unwatch 清理，事件丢失由前端慢轮询兑底。
        if let Ok(event) = result {
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let _ = app.emit(
                "design-document-changed",
                serde_json::json!({ "path": event_path, "workspacePath": event_workspace }),
            );
        }
    })
    .map_err(|error| format!("failed to create design watcher: {error}"))?;
    watcher
        .watch(&canonical, RecursiveMode::NonRecursive)
        .map_err(|error| format!("failed to watch design document: {error}"))?;
    if watchers.len() >= DESIGN_WATCH_POOL_LIMIT {
        // 逐出最旧：前端正常按选中项成对 watch/unwatch，这里是防泄漏兑底。
        watchers.remove(0);
    }
    watchers.push(DesignWatchEntry {
        canonical,
        workspace: root,
        relative: path,
        _watcher: watcher,
        subscribers: 1,
    });
    Ok(true)
}

/// 取消监听：resolve 失败（文件已删）也视为成功——清理路径不反向受制于读判定。
#[tauri::command]
pub(crate) fn unwatch_design_document(
    state: tauri::State<'_, WorkspaceAccessState>,
    watch_state: tauri::State<'_, DesignWatchState>,
    path: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let root = match workspace_path {
        Some(path) => PathBuf::from(path),
        None => authorized_root_for(&state, None)?,
    };
    let mut watchers = watch_state
        .watchers
        .lock()
        .map_err(|_| "design watch pool lock is poisoned".to_string())?;
    if let Some(index) = watchers
        .iter()
        .position(|entry| entry.workspace == root && entry.relative == path)
    {
        if watchers[index].subscribers > 1 {
            watchers[index].subscribers -= 1;
        } else {
            watchers.remove(index);
        }
    }
    Ok(())
}

/// 读取设计稿同目录的相对图片资产（画布渲染的 fill 图片填充通道）。
/// 远程 URL 一律由前端拒绝（防外链泄密面，docs/design-canvas.md §8）。
#[tauri::command]
pub(crate) fn read_design_document_asset(
    state: tauri::State<'_, WorkspaceAccessState>,
    path: String,
    asset_path: String,
    workspace_path: Option<String>,
) -> Result<DesignAssetContent, String> {
    let (canonical, root) = resolve_design_document(&state, &path, workspace_path.as_deref())?;
    if !is_design_document_path(&canonical) {
        return Err("design assets only accept .ax documents".into());
    }
    let relative = validate_relative_path(Some(&asset_path))?;
    let base_dir = canonical
        .parent()
        .ok_or_else(|| "design document has no parent directory".to_string())?;
    let target = base_dir.join(&relative);
    let canonical_asset = std::fs::canonicalize(&target)
        .map_err(|error| format!("failed to resolve design asset: {error}"))?;
    if !canonical_asset.starts_with(&root) {
        return Err("design asset resolves outside the authorized root".into());
    }
    crate::workspace_access::ensure_workspace_path_access(&root, &canonical_asset, false)?;
    if !is_supported_image_path(&canonical_asset) {
        return Err("design assets only accept supported image files".into());
    }
    let metadata = std::fs::metadata(&canonical_asset)
        .map_err(|error| format!("failed to stat design asset: {error}"))?;
    if !metadata.is_file() {
        return Err("design asset must be a regular image file within 1 MiB".into());
    }
    let bytes = read_capped(&canonical_asset, MAX_DESIGN_ASSET_BYTES, "design asset")?;
    let media_type = detect_image_mime(&bytes)
        .ok_or_else(|| "design asset is not a recognizable image".to_string())?;
    Ok(DesignAssetContent {
        content_base64: BASE64.encode(&bytes),
        media_type: media_type.to_string(),
        sha256: sha256_hex(&bytes),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WrittenDesignDocument {
    sha256: String,
    size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_warning: Option<String>,
}

/// 设计稿写盘核心：大小上限 + JSON 合法性 + CAS + 原子落盘。独立于 Tauri
/// State 抽成纯函数供单测。落盘形态与 Agent 写路径同款：tempfile（**保留源
/// 文件权限**——tempfile 默认 0600，直接 persist 会把 0644 的设计稿改权限）
/// → write + sync_all → persist(rename) → 父目录 fsync（防崩溃产生「rename
/// 已入目录、数据未落盘」的空文件）。
fn write_design_document_bytes(
    canonical: &Path,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Result<WrittenDesignDocument, String> {
    use std::io::Write;

    if bytes.len() as u64 > MAX_DESIGN_DOCUMENT_BYTES {
        return Err(format!(
            "design document exceeds the {} MiB limit",
            MAX_DESIGN_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    // `.ax` 设计稿恒为 JSON：写前校验，避免前端错误持久化不可解析内容。
    // （毫秒级）快速失败，不让前端 bug 把设计稿写成不可解析文件。
    if serde_json::from_slice::<serde_json::Value>(bytes).is_err() {
        return Err("design document content is not valid JSON".into());
    }
    // CAS：携带 expected 时必须与盘上当前内容一致——用户编辑期间 Agent /
    // pen.dev 恰好保存过的话，旧快照不能盖掉新文件（fail-closed 提示刷新）。
    if let Some(expected) = expected_sha256 {
        let current = read_capped(canonical, MAX_DESIGN_DOCUMENT_BYTES, "design document")?;
        let current_sha = sha256_hex(&current);
        if current_sha != expected {
            return Err(
                "design document changed on disk since it was loaded; refresh and retry".into(),
            );
        }
    }
    let directory = canonical
        .parent()
        .ok_or_else(|| "design document has no parent directory".to_string())?;
    let metadata = std::fs::metadata(canonical)
        .map_err(|error| format!("failed to inspect design document: {error}"))?;
    let temporary = tempfile::Builder::new()
        .prefix(".axiom-ax-write-")
        .tempfile_in(directory)
        .map_err(|error| format!("failed to create temp file for design write: {error}"))?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("failed to preserve design document permissions: {error}"))?;
    temporary
        .as_file()
        .write_all(bytes)
        .map_err(|error| format!("failed to write design document: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync design document: {error}"))?;
    temporary
        .persist(canonical)
        .map_err(|error| format!("failed to save design document: {}", error.error))?;
    crate::workspace_access::sync_parent_directory(canonical)?;
    Ok(WrittenDesignDocument {
        sha256: sha256_hex(bytes),
        size_bytes: bytes.len() as u64,
        history_warning: None,
    })
}

fn write_design_document_with_history(
    canonical: &Path,
    root: &Path,
    data_root: &Path,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Result<WrittenDesignDocument, String> {
    let history = crate::design_history::directory(data_root, root, canonical);
    let current = read_capped(canonical, MAX_DESIGN_DOCUMENT_BYTES, "design document")?;
    if expected_sha256.is_some_and(|expected| sha256_hex(&current) != expected) {
        return Err(
            "design document changed on disk since it was loaded; refresh and retry".into(),
        );
    }
    if bytes.len() as u64 > MAX_DESIGN_DOCUMENT_BYTES
        || serde_json::from_slice::<serde_json::Value>(bytes).is_err()
    {
        return Err("design document content is invalid or exceeds 8 MiB".into());
    }
    crate::design_history::record(&history, &current)?;
    let mut written = write_design_document_bytes(canonical, bytes, expected_sha256)?;
    written.history_warning = crate::design_history::observe(data_root, root, canonical, bytes)
        .err()
        .or_else(|| crate::design_history::prune(&history).err());
    Ok(written)
}

/// 从设计稿字节里取某一页的展示名（删除确认框文案用）。缺 `name` 时回退 `page_id`；
/// 文档不可解析或找不到该页时返回 `None`（调用方据此在弹框前 fail-closed）。
fn page_name_of(current: &[u8], page_id: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(current).ok()?;
    let page = value
        .get("pages")?
        .as_array()?
        .iter()
        .find(|page| page.get("id").and_then(serde_json::Value::as_str) == Some(page_id))?;
    Some(
        page.get("name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(page_id)
            .to_string(),
    )
}

/// 删除确认框的预读：路径解析 + 读盘取页名。**不做**格式校验与 CAS——那是写锁内的
/// 权威路径。这里只决定「确认框该怎么写」，用户确认期间盘上内容变化会让写锁内那次
/// 校验失败，而不是让旧快照盖上去。
fn preview_page_deletion(
    state: &WorkspaceAccessState,
    path: &str,
    page_id: &str,
    workspace_path: Option<&str>,
) -> Result<String, String> {
    let root = authorized_root_for(state, workspace_path)?;
    let (canonical, _) = resolve_design_document_for_write(std::slice::from_ref(&root), path)?;
    let current = read_capped(&canonical, MAX_DESIGN_DOCUMENT_BYTES, "design document")?;
    page_name_of(&current, page_id)
        .ok_or_else(|| format!("design page {page_id:?} not found in the design document"))
}

fn validate_page_deletion(current: &[u8], candidate: &[u8], page_id: &str) -> Result<(), String> {
    let mut expected = serde_json::from_slice::<serde_json::Value>(current)
        .map_err(|_| "current design document is not valid JSON".to_string())?;
    let pages = expected
        .get_mut("pages")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "design document pages must be an array".to_string())?;
    if pages.len() <= 1 {
        return Err("design document must keep at least one page".into());
    }
    let matching = pages
        .iter()
        .enumerate()
        .filter_map(|(index, page)| {
            (page.get("id").and_then(serde_json::Value::as_str) == Some(page_id)).then_some(index)
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err("design page id must identify exactly one page".into());
    }
    pages.remove(matching[0]);
    let candidate = serde_json::from_slice::<serde_json::Value>(candidate)
        .map_err(|_| "design document content is not valid JSON".to_string())?;
    if candidate != expected {
        return Err("design page deletion may only remove the requested page".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn delete_design_document_page(
    app: tauri::AppHandle,
    path: String,
    page_id: String,
    content_base64: String,
    expected_sha256: String,
    workspace_path: Option<String>,
) -> Result<Option<WrittenDesignDocument>, String> {
    // ① 锁外预读页名：只为确认框展示 Rust 侧读到的真实页名（渲染进程无法伪造文案）。
    let preview_app = app.clone();
    let preview_path = path.clone();
    let preview_page = page_id.clone();
    let preview_workspace = workspace_path.clone();
    let page_name = tauri::async_runtime::spawn_blocking(move || {
        let state = preview_app.state::<WorkspaceAccessState>();
        preview_page_deletion(
            &state,
            &preview_path,
            &preview_page,
            preview_workspace.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("design preview task failed: {error}"))??;

    // ② 原生确认：评审面的整页删除是唯一免审批的写手势，这一步把它从「渲染进程说
    //    用户点了」升级为「宿主确认用户点了」——受陷渲染进程无法伪造原生对话框。
    //    E2E 构建（feature = "e2e"）由 confirm_native 直接放行。
    let message = format!(
        "将删除设计稿「{path}」中的页「{page_name}」。\n\n删除会立即写入文件；如需找回，可在该设计稿的版本历史中恢复删除前的内容。"
    );
    if !crate::native_confirm::confirm_native(&app, "删除设计稿页", &message, "删除", "取消")
        .await?
    {
        // 用户取消不是错误：返回 None，前端按「未写入」处理（不弹失败提示）。
        return Ok(None);
    }

    // ③ 权威写入路径：与确认前同一套校验在写锁内重做（CAS 基准仍在出队时读盘）。
    let written = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let (canonical, _) = resolve_design_document_for_write(std::slice::from_ref(&root), &path)?;
        let bytes = BASE64
            .decode(content_base64.as_bytes())
            .map_err(|error| format!("invalid base64 design content: {error}"))?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let write_lock = state.workspace_write_lock(&root);
        let _write_lock = write_lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        authorized_root_for(&state, Some(&root.to_string_lossy()))?;
        let current = read_capped(&canonical, MAX_DESIGN_DOCUMENT_BYTES, "design document")?;
        if sha256_hex(&current) != expected_sha256 {
            return Err(
                "design document changed on disk since it was loaded; refresh and retry".into(),
            );
        }
        validate_page_deletion(&current, &bytes, &page_id)?;
        let data_root = crate::storage_paths::axiom_data_root(&app)?;
        write_design_document_with_history(
            &canonical,
            &root,
            &data_root,
            &bytes,
            Some(&expected_sha256),
        )
    })
    .await
    .map_err(|error| format!("design write task failed: {error}"))??;
    Ok(Some(written))
}

#[tauri::command]
pub(crate) async fn list_design_document_versions(
    app: tauri::AppHandle,
    path: String,
    workspace_path: Option<String>,
    include_git: Option<bool>,
) -> Result<Vec<crate::design_history::DesignDocumentVersion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate is poisoned".to_string())?;
        let lock = state.workspace_write_lock(&root);
        let _write_lock = lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        authorized_root_for(&state, Some(&root.to_string_lossy()))?;
        let (canonical, _) = resolve_design_document_for_write(std::slice::from_ref(&root), &path)?;
        let data_root = crate::storage_paths::axiom_data_root(&app)?;
        if include_git.unwrap_or(false) {
            crate::design_git_history::import(&data_root, &root, &canonical)?;
        }
        crate::design_history::list(&crate::design_history::directory(
            &data_root, &root, &canonical,
        ))
    })
    .await
    .map_err(|error| format!("design history task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn read_design_document_version(
    app: tauri::AppHandle,
    path: String,
    sha256: String,
    workspace_path: Option<String>,
) -> Result<DesignDocumentContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let (canonical, _) = resolve_design_document_for_write(std::slice::from_ref(&root), &path)?;
        let data_root = crate::storage_paths::axiom_data_root(&app)?;
        let history = crate::design_history::directory(&data_root, &root, &canonical);
        let bytes = crate::design_history::read(&history, &sha256)?;
        Ok(DesignDocumentContent {
            content_base64: BASE64.encode(&bytes),
            workspace_path: root.to_string_lossy().into(),
            sha256,
            size_bytes: bytes.len() as u64,
            modified_ms: None,
            unchanged: false,
            history_warning: None,
        })
    })
    .await
    .map_err(|error| format!("design history task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn restore_design_document_version(
    app: tauri::AppHandle,
    gesture: tauri::State<'_, std::sync::Arc<UserGestureState>>,
    path: String,
    sha256: String,
    expected_sha256: String,
    workspace_path: Option<String>,
) -> Result<WrittenDesignDocument, String> {
    // 回滚是内容级写入：与「删除设计页」的原生确认、文档保存的门同属用户编辑通道。
    // macOS 要求真实原生手势；非 macOS 没有等价信号，降级为一次宿主原生确认
    // 对话框——受陷渲染进程不能把设计稿静默改回旧版本。
    let confirmed = require_user_confirmation(
        &app,
        gesture.inner().as_ref(),
        current_operating_system(),
        None,
        ContentConfirm {
            title: "确认恢复设计稿历史版本",
            message: format!(
                "即将把设计稿恢复为历史版本：\n\n文件：{}\n版本：{}\n\n确认恢复？",
                path,
                &sha256[..sha256.len().min(12)]
            ),
            confirm_label: "恢复",
        },
    )
    .await?;
    if !confirmed {
        return Err("用户取消了设计稿版本恢复".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate is poisoned".to_string())?;
        let lock = state.workspace_write_lock(&root);
        let _write_lock = lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        authorized_root_for(&state, Some(&root.to_string_lossy()))?;
        let (canonical, _) = resolve_design_document_for_write(std::slice::from_ref(&root), &path)?;
        let current = read_capped(&canonical, MAX_DESIGN_DOCUMENT_BYTES, "design document")?;
        if sha256_hex(&current) != expected_sha256 {
            return Err(
                "design document changed on disk since it was loaded; refresh and retry".into(),
            );
        }
        let data_root = crate::storage_paths::axiom_data_root(&app)?;
        let history = crate::design_history::directory(&data_root, &root, &canonical);
        let bytes = crate::design_history::read(&history, &sha256)?;
        write_design_document_with_history(
            &canonical,
            &root,
            &data_root,
            &bytes,
            Some(&expected_sha256),
        )
    })
    .await
    .map_err(|error| format!("design history restore task failed: {error}"))?
}
