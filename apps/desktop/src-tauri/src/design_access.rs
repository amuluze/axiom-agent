//! 设计稿读取通道（设计画布 Design Canvas 的只读数据源，docs/design-canvas.md §7 v0.1）。
//! 复用工作区读取链的安全判定（相对路径校验 / canonicalize / starts_with root
//! 兜底），敏感 deny 由「文件必在授权工作区根内」天然豁免（sensitive_read_denied
//! 对授权根内路径返回 false）。定点放行仅限：设计稿扩展名（8MiB 上限，对齐
//! artifact 存储）与同目录图片资产（沿用 read 工具图片分支的 1MiB 上限
//! 与魔数 mime 校验）——不放松其它约束；JSON 解析在前端，大小上限在 Rust 强制。
//!
//! 两种格式：`.pen`（pen.dev 格式，作为导入源）与 `.ax`（Axiom 自有格式，
//! docs/ax-format.md）——**同一信任档**：同一套路径解析、同一 8MiB 上限、同一
//! CAS 写语义。识别只按扩展名，不含格式内容判定（内容校验在 TS 侧校验器）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager as _};

use crate::image_detect::{detect_image_mime, is_supported_image_path};
use crate::workspace_access::{authorized_roots, validate_relative_path, WorkspaceAccessState};

/// 对齐 artifact 存储的 8MiB 上限：axiom.pen 实际 ~1.3MB，为增量演进留足余量。
const MAX_DESIGN_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
/// 图片资产与 read 工具图片分支同款 1MiB 上限。
const MAX_DESIGN_ASSET_BYTES: u64 = 1024 * 1024;

/// 设计稿扩展名白名单：`.pen`（导入源）/ `.ax`（自有格式）。两者同信任档，
/// 因此是同一份放行判定，不做格式内容区分。
const DESIGN_DOCUMENT_EXTENSIONS: [&str; 2] = ["pen", "ax"];

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
    sha256: String,
    size_bytes: u64,
    modified_ms: Option<u64>,
    /// known_sha256 命中时为 true：内容未变，content_base64 为空串不重复传输。
    unchanged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignAssetContent {
    content_base64: String,
    media_type: String,
    sha256: String,
}

/// 在全部授权工作区根内解析设计稿相对路径，返回（canonical 路径, 所属根）。
/// 任一根命中即返回；多根同名文件按授权顺序取首个（与 read_workspace_text
/// 的 workspace_path 消歧不同，设计稿文件名本身即天然命名空间）。
fn resolve_design_document(
    state: &tauri::State<'_, WorkspaceAccessState>,
    path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    resolve_design_document_in_roots(&authorized_roots(state), path)
}

/// resolve 的可测内核（roots 切片直入，对抗用例见 tests 模块）。安全判定：
/// validate_relative_path 拒 `..`/绝对路径 → canonicalize 消解 symlink →
/// starts_with root 兜底 → canonical 文件名与请求一致（防 symlink 置换改扩展名）。
fn resolve_design_document_in_roots(
    roots: &[PathBuf],
    path: &str,
) -> Result<(PathBuf, PathBuf), String> {
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
        if canonical.file_name() != Some(file_name) {
            // canonicalize 消解 symlink 后文件名可能被置换：以 canonical 名为准
            // 重查扩展名（相对段已在 validate_relative_path 拒绝 ..）。
            continue;
        }
        if !is_design_document_path(&canonical) {
            return Err("design documents only accept .pen or .ax files".into());
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
    resolve_design_document_in_roots(roots, path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 返回路径的设计稿写入上限；非设计稿返回 None（调用方回退 1MiB 文本上限）。
pub(crate) fn design_document_write_limit(path: &Path) -> Option<u64> {
    is_design_document_path(path).then_some(MAX_DESIGN_DOCUMENT_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_limit_accepts_design_document_extensions() {
        for path in [
            "designs/axiom.pen",
            "designs/AXIOM.PEN",
            "designs/axiom.ax",
            "designs/AXIOM.AX",
        ] {
            assert_eq!(
                design_document_write_limit(Path::new(path)),
                Some(MAX_DESIGN_DOCUMENT_BYTES),
                "{path} 应被视为设计稿"
            );
        }
        assert_eq!(design_document_write_limit(Path::new("notes.txt")), None);
        assert_eq!(design_document_write_limit(Path::new("pen")), None);
        // 扩展名判定按段匹配：`x.axz` / `a.pen.bak` 不是设计稿。
        assert_eq!(design_document_write_limit(Path::new("x.axz")), None);
        assert_eq!(design_document_write_limit(Path::new("a.pen.bak")), None);
    }

    #[test]
    fn write_bytes_persists_atomically_and_reports_sha256() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("a.pen");
        std::fs::write(&path, br#"{"children":[]}"#).expect("seed file");
        let content = br#"{"children":[{"id":"p1"}]}"#;
        let written = write_design_document_bytes(&path, content, None).expect("write should succeed");
        assert_eq!(written.size_bytes, content.len() as u64);
        assert_eq!(std::fs::read(&path).expect("read back"), content);
        // CAS 命中：携带上一轮返回的 sha256 可继续写。
        write_design_document_bytes(&path, br#"{"children":[]}"#, Some(&written.sha256))
            .expect("cas-matched write should succeed");
    }

    #[test]
    fn write_bytes_rejects_cas_mismatch_bad_json_and_oversize() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("a.pen");
        std::fs::write(&path, br#"{"children":[]}"#).expect("seed file");
        // CAS 失败：盘上内容已被外部（Agent/pen.dev）更新，旧快照拒绝落盘。
        let error =
            write_design_document_bytes(&path, br#"{"children":1}"#, Some("deadbeef"))
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
        let path = directory.path().join("a.pen");
        std::fs::write(&path, br#"{"children":[]}"#).expect("seed file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("seed permissions");
        write_design_document_bytes(&path, br#"{"children":[1]}"#, None).expect("write");
        let mode = std::fs::metadata(&path)
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o640, "写盘后必须保留源文件权限（tempfile 默认 0600 不得泄漏）");
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
        let (canonical, root) =
            resolve_design_document_in_roots(&roots, "a.pen").expect("resolve");
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
        symlink(
            inside.path().join("notes.txt"),
            inside.path().join("x.pen"),
        )
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
        assert!(error.contains("only accept .pen or .ax"));
    }

    #[test]
    fn resolve_prefers_first_root_on_multi_root_hit() {
        let first = tempfile::tempdir().expect("first");
        let second = tempfile::tempdir().expect("second");
        std::fs::write(first.path().join("shared.pen"), br#"{"first":true}"#).expect("seed first");
        std::fs::write(second.path().join("shared.pen"), br#"{"second":true}"#).expect("seed second");
        let roots = canonical_roots(&[first.path(), second.path()]);
        let (canonical, root) =
            resolve_design_document_in_roots(&roots, "shared.pen").expect("resolve");
        assert_eq!(root, roots[0], "多根同名按授权顺序取首个");
        assert_eq!(
            std::fs::read(&canonical).expect("read"),
            br#"{"first":true}"#
        );
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
        assert!(resolve_design_document_for_write(&roots, "normal.pen").is_ok());
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
pub(crate) fn read_design_document(
    state: tauri::State<'_, WorkspaceAccessState>,
    path: String,
    known_sha256: Option<String>,
) -> Result<DesignDocumentContent, String> {
    let (canonical, _) = resolve_design_document(&state, &path)?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to stat design document: {error}"))?;
    if !metadata.is_file() {
        return Err("design document path is not a regular file".into());
    }
    let bytes = read_capped(&canonical, MAX_DESIGN_DOCUMENT_BYTES, "design document")?;
    let sha256 = sha256_hex(&bytes);
    if known_sha256.as_deref() == Some(sha256.as_str()) {
        return Ok(DesignDocumentContent {
            content_base64: String::new(),
            sha256,
            size_bytes: bytes.len() as u64,
            modified_ms: modified_epoch_ms(&canonical),
            unchanged: true,
        });
    }
    Ok(DesignDocumentContent {
        content_base64: BASE64.encode(&bytes),
        sha256,
        size_bytes: bytes.len() as u64,
        modified_ms: modified_epoch_ms(&canonical),
        unchanged: false,
    })
}

/// 设计稿文件监听池：canonical 路径 → watcher（drop 即停止监听）。
/// 独立于 WorkspaceAccessState：watcher 只读事件源，不参与写串行/恢复事务。
pub(crate) struct DesignWatchState {
    /// 线性表而非 HashMap：池上限内线性查找开销可忽略，且保留插入顺序便于逐出。
    watchers: Mutex<Vec<(PathBuf, RecommendedWatcher)>>,
}

/// 监听池上限：画布同一时刻只 watch 当前选中的 .pen，多会话并行也不会超过。
const DESIGN_WATCH_POOL_LIMIT: usize = 8;

impl DesignWatchState {
    pub(crate) fn new() -> Self {
        Self {
            watchers: Mutex::new(Vec::new()),
        }
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
) -> Result<bool, String> {
    let (canonical, _) = resolve_design_document(&state, &path)?;
    let mut watchers = watch_state
        .watchers
        .lock()
        .map_err(|_| "design watch pool lock is poisoned".to_string())?;
    if watchers.iter().any(|(key, _)| *key == canonical) {
        return Ok(false);
    }
    let event_path = path.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        // emit 失败（前端已关）静默忽略：watcher 池由 unwatch 清理，事件丢失由前端慢轮询兑底。
        if let Ok(event) = result {
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let _ = app.emit("design-document-changed", serde_json::json!({ "path": event_path }));
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
    watchers.push((canonical, watcher));
    Ok(true)
}

/// 取消监听：resolve 失败（文件已删）也视为成功——清理路径不反向受制于读判定。
#[tauri::command]
pub(crate) fn unwatch_design_document(
    state: tauri::State<'_, WorkspaceAccessState>,
    watch_state: tauri::State<'_, DesignWatchState>,
    path: String,
) -> Result<(), String> {
    let mut watchers = watch_state
        .watchers
        .lock()
        .map_err(|_| "design watch pool lock is poisoned".to_string())?;
    if let Ok((canonical, _)) = resolve_design_document(&state, &path) {
        watchers.retain(|(key, _)| *key != canonical);
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
) -> Result<DesignAssetContent, String> {
    let (canonical, root) = resolve_design_document(&state, &path)?;
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
    // 设计稿恒为 JSON（.pen/.ax 皆然）：坏内容对渲染器与 pen.dev 都不可读，写前校验一次
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
        .prefix(".axiom-pen-write-")
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
    })
}

/// 写设计稿（画布直接操控的写回通道，docs/design-canvas.md §11）：路径复用读
/// 通道的 resolve（仅授权工作区根内的 `.pen`/`.ax`）+ 保留目录拒绝，8MiB 硬上限 +
/// JSON 合法性 + CAS（expected_sha256 与盘上不一致即拒绝）。这是用户亲手操控画布的
/// 手势通道（与终端 stdin 同一信任模型）：爆炸半径收敛在授权工作区的设计稿文件，
/// 不为 WebView 打开任意写面。
///
/// CAS 是 check-then-act：必须与 Agent 写路径（apply_workspace_changes 等）在
/// 同一把 per-workspace 写锁下全序化，否则窗口内 Agent 落盘的更新会被画布
/// persist 静默覆盖（丢更新），反向亦然。锁序沿用写路径约定：
/// `recovery_gate.read → per-workspace 写锁`（与撤销链不反向取锁，无死环）；
/// 锁等待与文件 I/O 整体进 blocking 线程池，不占 tokio worker。
#[tauri::command]
pub(crate) async fn write_design_document(
    app: tauri::AppHandle,
    path: String,
    content_base64: String,
    expected_sha256: Option<String>,
) -> Result<WrittenDesignDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let (canonical, root) =
            resolve_design_document_for_write(&authorized_roots(&state), &path)?;
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
        write_design_document_bytes(&canonical, &bytes, expected_sha256.as_deref())
    })
    .await
    .map_err(|error| format!("design write task failed: {error}"))?
}
