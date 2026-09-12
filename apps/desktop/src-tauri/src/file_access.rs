use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::file_access_registry;
use crate::workspace_access::WorkspaceAccessState;

pub(crate) const MAX_TEXT_FILE_BYTES: u64 = 1024 * 1024;
const TEXT_EXTENSIONS: &[&str] = &[
    "bash", "c", "cc", "cfg", "cjs", "conf", "cpp", "css", "csv", "cts", "env", "fish", "go",
    "gql", "graphql", "h", "hpp", "html", "ini", "java", "js", "json", "jsonl", "jsx", "kt", "kts",
    "log", "markdown", "md", "mjs", "mts", "py", "rb", "rs", "scss", "sh", "sql", "swift", "toml",
    "ts", "tsv", "tsx", "txt", "xml", "yaml", "yml", "zsh",
];
const TEXT_FILE_NAMES: &[&str] = &[
    ".env",
    "dockerfile",
    "gemfile",
    "license",
    "makefile",
    "readme",
    "rakefile",
];

#[derive(Default)]
pub(crate) struct FileAccessState {
    /// 用户经引用列表登记的文件/目录（canonical 路径）。读取自免审改版起不再
    /// 按本集合判定——绝对路径全盘可读（敏感 deny 除外），集合仅作为引用列表
    /// 的数据源（@ 提及候选 / 提示词注入）；持久条目由 file_access_registry
    /// 落盘并在启动时恢复。
    authorized: Mutex<HashSet<PathBuf>>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizedReadFile {
    path: String,
    name: String,
    // specta 默认禁止导出 u64（精度丢失），文件字节数在 1 MiB 上限内，
    // 覆盖为 u32 导出为 TS number，运行时仍保持 u64 语义。
    #[specta(type = u32)]
    size_bytes: u64,
    is_directory: bool,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizedTextContent {
    file: AuthorizedReadFile,
    content: String,
}

pub(crate) fn is_supported_text_path(path: &Path) -> bool {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            let extension = value.to_ascii_lowercase();
            TEXT_EXTENSIONS.contains(&extension.as_str())
        })
        .unwrap_or(false)
    {
        return true;
    }

    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| {
            let file_name = value.to_ascii_lowercase();
            TEXT_FILE_NAMES.contains(&file_name.as_str())
        })
        .unwrap_or(false)
}

pub(crate) fn canonical_text_file(raw_path: &str) -> Result<(PathBuf, u64), String> {
    if raw_path.len() > 16 * 1024 {
        return Err("file path is too long".into());
    }
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|error| format!("failed to resolve selected file: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect selected file: {error}"))?;
    if !metadata.is_file() {
        return Err("selected path is not a file".into());
    }
    if !is_supported_text_path(&canonical) {
        return Err("selected file type is not supported for text reading".into());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("selected text file is larger than 1 MiB".into());
    }
    Ok((canonical, metadata.len()))
}

fn file_summary(path: &Path, size_bytes: u64, is_directory: bool) -> AuthorizedReadFile {
    AuthorizedReadFile {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        size_bytes,
        is_directory,
    }
}

fn lock_error(what: &str) -> String {
    format!("{what} state lock is poisoned")
}

fn authorize_impl(state: &FileAccessState, raw_path: &str) -> Result<AuthorizedReadFile, String> {
    let (canonical, size_bytes) = canonical_text_file(raw_path)?;
    state
        .authorized
        .lock()
        .map_err(|_| lock_error("file authorization"))?
        .insert(canonical.clone());
    Ok(file_summary(&canonical, size_bytes, false))
}

fn canonical_directory(raw_path: &str) -> Result<PathBuf, String> {
    if raw_path.len() > 16 * 1024 {
        return Err("directory path is too long".into());
    }
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|error| format!("failed to resolve selected directory: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect selected directory: {error}"))?;
    if !metadata.is_dir() {
        return Err("selected path is not a directory".into());
    }
    Ok(canonical)
}

fn authorize_directory_impl(
    state: &FileAccessState,
    raw_path: &str,
) -> Result<AuthorizedReadFile, String> {
    let canonical = canonical_directory(raw_path)?;
    state
        .authorized
        .lock()
        .map_err(|_| lock_error("file authorization"))?
        .insert(canonical.clone());
    Ok(file_summary(&canonical, 0, true))
}

fn list_impl(state: &FileAccessState) -> Result<Vec<AuthorizedReadFile>, String> {
    let paths = state
        .authorized
        .lock()
        .map_err(|_| lock_error("file authorization"))?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let mut files = paths
        .into_iter()
        .map(|path| {
            let (size_bytes, is_directory) = std::fs::metadata(&path)
                .map(|metadata| (metadata.len(), metadata.is_dir()))
                .unwrap_or((0, false));
            file_summary(&path, size_bytes, is_directory)
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn revoke_impl(state: &FileAccessState, raw_path: &str) -> Result<bool, String> {
    let requested = PathBuf::from(raw_path);
    let canonical = std::fs::canonicalize(&requested).ok();
    let mut authorized = state
        .authorized
        .lock()
        .map_err(|_| lock_error("file authorization"))?;
    let mut removed = authorized.remove(&requested);
    if let Some(canonical) = canonical {
        removed |= authorized.remove(&canonical);
    }
    Ok(removed)
}

async fn read_canonical_text(canonical: &Path) -> Result<AuthorizedTextContent, String> {
    let bytes = tokio::fs::read(canonical)
        .await
        .map_err(|error| format!("failed to read file: {error}"))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("text file grew beyond 1 MiB".into());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "file is not valid UTF-8 text".to_string())?;
    Ok(AuthorizedTextContent {
        file: file_summary(canonical, content.len() as u64, false),
        content,
    })
}

const SENSITIVE_READ_DENIED_MESSAGE: &str = "读取被运行时安全策略拒绝：该路径位于敏感目录（~/.ssh、~/.aws、~/.gnupg 等凭据载体或 ~/.axiom 数据目录）。此类路径不可读取、也不可经授权解除；请向用户说明，不要尝试其他路径绕过。";

/// 读取绝对路径的文本文件（工作区外 `read` 工具的唯一通道）。读取面免审批
/// （对齐 codex 的全盘读语义）：不要求逐文件授权，但保留与 bash 沙箱同一集合
/// 的敏感路径 deny（凭据载体 + `~/.axiom` 数据根）——read 不得成为绕过沙箱
/// 凭据保护的旁路。canonicalize 先于 deny 判定：symlink 置换指向 deny 目标
/// 同样被拒；路径位于任一授权工作区内时豁免（镜像沙箱「工作区位于 deny 目录
/// 内时跳过该目录」语义）。HOME 来源与沙箱 profile 一致（`$HOME` 环境变量），
/// 保证两侧 deny 集合判定在同一坐标系上。
#[tauri::command]
#[specta::specta]
pub(crate) async fn read_authorized_text(
    app: tauri::AppHandle,
    path: String,
) -> Result<AuthorizedTextContent, String> {
    // 先做类型/大小校验：无效路径（二进制、超限、不存在）直接报错，
    // 不进入 deny 判定。
    let (canonical, _) = canonical_text_file(&path)?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME environment variable is unavailable".to_string())?;
    let workspace_roots = {
        use tauri::Manager;
        crate::workspace_access::authorized_roots(&app.state::<WorkspaceAccessState>())
    };
    if crate::sandbox::sensitive_read_denied(&home, &canonical, &workspace_roots) {
        return Err(SENSITIVE_READ_DENIED_MESSAGE.into());
    }
    read_canonical_text(&canonical).await
}

/// 启动恢复：把注册表中仍存在且仍合法的文件/目录重新登记进内存引用集。
/// 注册表损坏时 fail-soft：跳过本次恢复并提示（用户经选择器重新登记即可
/// 自愈），不阻塞应用启动——引用列表丢失只影响便利性，不影响安全边界
/// （与工作区注册表恢复的 fail-closed 不同）。
pub(crate) fn restore_persistent_grants(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let registry_file = file_access_registry::registry_file_path(app)?;
    let entries = match file_access_registry::registry_read(&registry_file) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("axiom: skip restoring authorized files: {error}");
            return Ok(());
        }
    };
    regrant_entries(&app.state::<FileAccessState>(), entries).map(|_| ())
}

/// 注册表条目筛选与重新登记：已删除/已变为非法类型（二进制、超限）的条目
/// 跳过，其余重新进入内存引用集。symlink 置换无需在此防：读取不按集合成员
/// 判定，敏感 deny 在每次读取时按 canonical 实时判定（sensitive_read_denied）。
fn regrant_entries(
    state: &FileAccessState,
    entries: impl IntoIterator<Item = PathBuf>,
) -> Result<usize, String> {
    let mut authorized = state
        .authorized
        .lock()
        .map_err(|_| lock_error("file authorization"))?;
    let mut restored = 0;
    for path in entries {
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        let still_eligible = if metadata.is_dir() {
            true
        } else if metadata.is_file() {
            metadata.len() <= MAX_TEXT_FILE_BYTES && is_supported_text_path(&path)
        } else {
            false
        };
        if still_eligible {
            authorized.insert(path);
            restored += 1;
        }
    }
    Ok(restored)
}

/// 由 Rust 侧打开原生选择器，把文件登记进引用列表（@ 提及候选 / 提示词注入
/// 的数据源），路径直接来自系统对话框，不让 WebView 把任意绝对路径传成引用
/// 条目——对齐 `pick_and_authorize_workspace` 的手势门。读取本身已免审批
/// （sensitive_read_denied 管安全边界），本登记不再授予任何读取能力。
/// 取消时返回 Ok(None)。必须用非阻塞 `pick_file` + oneshot 等待；blocking
/// 变体在 macOS 上会阻塞 Tauri async runtime（同 pick_and_authorize_workspace
/// 的 rationale）。
#[tauri::command]
pub(crate) async fn pick_and_authorize_read_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, FileAccessState>,
) -> Result<Option<AuthorizedReadFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("添加引用文件")
        .add_filter("文本与代码文件", TEXT_EXTENSIONS)
        .pick_file(move |file| {
            let _ = sender.send(file);
        });
    let picked = receiver
        .await
        .map_err(|_| "file picker closed unexpectedly".to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("failed to resolve selected file path: {error}"))?;
    // 引用条目持久化：先注册表再内存（fail-closed），重启后经
    // restore_persistent_grants 恢复。
    let registry_file = file_access_registry::registry_file_path(&app)?;
    let canonical = canonical_text_file(&path.to_string_lossy())?.0;
    file_access_registry::registry_insert(&registry_file, &canonical)?;
    authorize_impl(&state, &path.to_string_lossy()).map(Some)
}

#[tauri::command]
pub(crate) async fn pick_and_authorize_read_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, FileAccessState>,
) -> Result<Option<AuthorizedReadFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("添加引用目录")
        .pick_folder(move |folder| {
            let _ = sender.send(folder);
        });
    let picked = receiver
        .await
        .map_err(|_| "directory picker closed unexpectedly".to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("failed to resolve selected directory path: {error}"))?;
    let registry_file = file_access_registry::registry_file_path(&app)?;
    let canonical = canonical_directory(&path.to_string_lossy())?;
    file_access_registry::registry_insert(&registry_file, &canonical)?;
    authorize_directory_impl(&state, &path.to_string_lossy()).map(Some)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_authorized_read_files(
    state: tauri::State<'_, FileAccessState>,
) -> Result<Vec<AuthorizedReadFile>, String> {
    list_impl(&state)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn revoke_authorized_read_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, FileAccessState>,
    path: String,
) -> Result<bool, String> {
    // 注册表移除必须先于且成功于内存移除（同 workspace revoke 顺序）：只要
    // 注册表仍含该路径，重启恢复就会重新登记它，移除不具持久效力。canonicalize
    // 仅在传入非 canonical 形态时兜底（文件已删除时退回原串，与 workspace revoke
    // 的 roots 匹配语义一致）。
    let registry_target = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| PathBuf::from(&path));
    file_access_registry::registry_remove(
        &file_access_registry::registry_file_path(&app)?,
        &registry_target,
    )?;
    revoke_impl(&state, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMPORARY_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temporary_directory() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEMPORARY_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "axiom-file-access-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn reads_absolute_text_files_without_per_file_approval() {
        let directory = temporary_directory();
        let file = directory.join("notes.md");
        std::fs::write(&file, "hello Axiom").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let state = FileAccessState::default();

        // 读取与引用集解耦：未登记的路径同样可读（敏感 deny 由
        // sandbox::sensitive_read_denied 在 command 层判定，另有单测覆盖）。
        let content = read_canonical_text(&canonical).await.unwrap();
        assert_eq!(content.content, "hello Axiom");
        assert_eq!(content.file.name, "notes.md");
        assert!(!content.file.is_directory);

        // revoke 只影响引用集（@ 提及候选 / 提示词注入），不影响读取。
        assert!(authorize_impl(&state, canonical.to_str().unwrap()).is_ok());
        assert!(revoke_impl(&state, canonical.to_str().unwrap()).unwrap());
        assert!(!revoke_impl(&state, canonical.to_str().unwrap()).unwrap());
        let again = read_canonical_text(&canonical).await.unwrap();
        assert_eq!(again.content, "hello Axiom");

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unsupported_and_oversized_files() {
        let directory = temporary_directory();
        let binary = directory.join("image.png");
        let oversized = directory.join("large.txt");
        std::fs::write(&binary, b"not really an image").unwrap();
        std::fs::write(&oversized, vec![b'x'; MAX_TEXT_FILE_BYTES as usize + 1]).unwrap();

        assert!(canonical_text_file(binary.to_str().unwrap()).is_err());
        assert!(canonical_text_file(oversized.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_regrants_existing_entries_and_skips_gone_or_invalid() {
        let directory = temporary_directory();
        let live = directory.join("live.md");
        std::fs::write(&live, "hello").unwrap();
        let gone = directory.join("gone.md");
        let binary = directory.join("image.png");
        std::fs::write(&binary, b"png").unwrap();
        let registry = directory.join("registry.json");
        file_access_registry::registry_insert(&registry, &live).unwrap();
        file_access_registry::registry_insert(&registry, &gone).unwrap();
        file_access_registry::registry_insert(&registry, &binary).unwrap();

        let state = FileAccessState::default();
        let restored =
            regrant_entries(&state, file_access_registry::registry_read(&registry).unwrap())
                .unwrap();
        assert_eq!(restored, 1);
        assert!(state.authorized.lock().unwrap().contains(&live));
        assert!(!state.authorized.lock().unwrap().contains(&gone));
        assert!(!state.authorized.lock().unwrap().contains(&binary));

        std::fs::remove_dir_all(directory).unwrap();
    }
}
