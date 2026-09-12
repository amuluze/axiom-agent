use crate::{
    artifacts::{write_text_artifact_at, ArtifactMetadata},
    file_access::{is_supported_text_path, MAX_TEXT_FILE_BYTES},
    workspace_access::{
        authorized_root_for, set_workspace_recovery_blocked, workspace_summary,
        AuthorizedWorkspace, WorkspaceAccessState,
    },
    workspace_approval::WorkspaceApprovalState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt::Write as _,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tempfile::{Builder, NamedTempFile};

const MAX_CHANGE_OPERATIONS: usize = 32;
const MAX_RECEIPT_BYTES: u64 = 256 * 1024;
const MAX_TRANSACTION_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BATCH_CONTENT_BYTES: usize = 2 * 1024 * 1024;
const RECEIPT_VERSION: u32 = 1;
const TRANSACTION_VERSION: u32 = 1;
const RESTORE_VERSION: u32 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceChangeRequest {
    request_id: String,
    operations: Vec<WorkspaceChangeOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum WorkspaceChangeOperation {
    CreateFile {
        path: String,
        content: String,
    },
    PatchFile {
        path: String,
        expected_sha256: String,
        old_text: String,
        new_text: String,
    },
    CreateDirectory {
        path: String,
    },
    Move {
        from: String,
        to: String,
        expected_sha256: Option<String>,
    },
    Trash {
        path: String,
        expected_sha256: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceChangeSummary {
    operation: String,
    path: String,
    destination: Option<String>,
    sha256: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceChangeResult {
    workspace: AuthorizedWorkspace,
    request_id: String,
    changes: Vec<WorkspaceChangeSummary>,
    recovery_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audit_artifact: Option<ArtifactMetadata>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeReceipt {
    version: u32,
    request_id: String,
    workspace: String,
    restored: bool,
    changes: Vec<WorkspaceChangeSummary>,
    trash: Vec<TrashReceiptEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audit_artifact: Option<ArtifactMetadata>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashReceiptEntry {
    original_path: String,
    stored_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJournal {
    version: u32,
    request_id: String,
    workspace: String,
    status: TransactionStatus,
    actions: Vec<JournalAction>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum TransactionStatus {
    Applying,
    RollingBack,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum JournalAction {
    RemoveFile {
        path: String,
        created_sha256: String,
    },
    RestoreFile {
        path: String,
        backup_name: String,
        original_sha256: String,
        updated_sha256: String,
    },
    RemoveDirectory {
        path: String,
    },
    Move {
        source: String,
        destination: String,
        identity: SourceIdentity,
    },
    Trash {
        source: String,
        stored_name: String,
        identity: SourceIdentity,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreJournal {
    version: u32,
    request_id: String,
    workspace: String,
    status: RestoreStatus,
    actions: Vec<RestoreAction>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RestoreStatus {
    Restoring,
    RollingBack,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreAction {
    original_path: String,
    stored_name: String,
    identity: SourceIdentity,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRecoveryIssue {
    message: String,
    workspace: Option<String>,
    recovery_id: Option<String>,
    recovery_path: Option<String>,
}

#[derive(Default)]
pub(crate) struct WorkspaceRecoveryState {
    issue: Mutex<Option<WorkspaceRecoveryIssue>>,
}

enum PreparedChange {
    CreateFile {
        target: PathBuf,
        relative: String,
        content: Vec<u8>,
    },
    PatchFile {
        target: PathBuf,
        relative: String,
        expected_sha256: String,
        updated: Vec<u8>,
        permissions: std::fs::Permissions,
    },
    CreateDirectory {
        target: PathBuf,
        relative: String,
    },
    Move {
        source: PathBuf,
        destination: PathBuf,
        source_relative: String,
        destination_relative: String,
        identity: SourceIdentity,
    },
    Trash {
        source: PathBuf,
        relative: String,
        identity: SourceIdentity,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "sha256", rename_all = "kebab-case")]
enum SourceIdentity {
    TextFile(String),
    Directory(String),
}

fn validate_request_id(request_id: &str) -> Result<&str, String> {
    let request_id = request_id.trim();
    let valid = !request_id.is_empty()
        && request_id.len() <= 128
        && request_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    if !valid {
        return Err("workspace change request ID contains unsupported characters".into());
    }
    Ok(request_id)
}

fn validate_relative_path(raw_path: &str) -> Result<PathBuf, String> {
    let raw_path = raw_path.trim();
    if raw_path.is_empty() || raw_path.len() > 16 * 1024 {
        return Err("workspace change path must be a non-empty relative path".into());
    }
    let path = PathBuf::from(raw_path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("workspace changes only accept relative paths without '..'".into());
    }
    let normalized = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            Component::CurDir => None,
            _ => None,
        })
        .collect::<PathBuf>();
    if normalized.as_os_str().is_empty() {
        return Err("workspace root cannot be changed".into());
    }
    if normalized.components().any(|component| match component {
        // 大小写不敏感的文件系统下 `.GIT` 会解析到 `.git`：按 ASCII 小写比较。
        Component::Normal(value) => {
            let lowered = value.to_string_lossy().to_ascii_lowercase();
            lowered == ".git" || lowered == ".axiom"
        }
        _ => false,
    }) {
        return Err("workspace control directories cannot be changed".into());
    }
    Ok(normalized)
}

fn relative_display(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hash_os_value(hasher: &mut Sha256, value: &std::ffi::OsStr) {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let bytes = value.as_bytes();
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    #[cfg(not(unix))]
    {
        let value = value.to_string_lossy();
        let bytes = value.as_bytes();
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
}

fn hash_permissions(hasher: &mut Sha256, metadata: &std::fs::Metadata) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        hasher.update(metadata.permissions().mode().to_le_bytes());
    }
    #[cfg(not(unix))]
    hasher.update([u8::from(metadata.permissions().readonly())]);
}

fn hash_directory_contents(path: &Path, hasher: &mut Sha256) -> Result<(), String> {
    let mut entries = std::fs::read_dir(path)
        .map_err(|error| format!("failed to inspect workspace directory identity: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to inspect workspace directory entry: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        hash_os_value(hasher, &entry.file_name());
        let entry_path = entry.path();
        let metadata = std::fs::symlink_metadata(&entry_path)
            .map_err(|error| format!("failed to inspect workspace directory entry: {error}"))?;
        hash_permissions(hasher, &metadata);
        if metadata.is_dir() {
            hasher.update(b"directory");
            hash_directory_contents(&entry_path, hasher)?;
        } else if metadata.is_file() {
            hasher.update(b"file");
            hasher.update(metadata.len().to_le_bytes());
            let mut file = std::fs::File::open(&entry_path).map_err(|error| {
                format!("failed to read workspace directory file identity: {error}")
            })?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|error| {
                    format!("failed to read workspace directory file identity: {error}")
                })?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
        } else if metadata.file_type().is_symlink() {
            hasher.update(b"symlink");
            let destination = std::fs::read_link(&entry_path).map_err(|error| {
                format!("failed to inspect workspace directory symlink identity: {error}")
            })?;
            hash_os_value(hasher, destination.as_os_str());
        } else {
            hasher.update(b"special");
            hasher.update(metadata.len().to_le_bytes());
        }
    }
    Ok(())
}

fn directory_sha256(path: &Path) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect workspace directory identity: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("workspace change conflict: expected a directory".into());
    }
    let mut hasher = Sha256::new();
    hasher.update(b"axiom-workspace-directory-v1");
    hash_permissions(&mut hasher, &metadata);
    hash_directory_contents(path, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_expected_sha256(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expectedSha256 must contain 64 hexadecimal characters".into());
    }
    Ok(normalized)
}

fn workspace_fingerprint(root: &Path) -> String {
    sha256_bytes(root.to_string_lossy().as_bytes())[..24].to_string()
}

fn ensure_parent_inside_root(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let parent = relative.parent().unwrap_or_else(|| Path::new("."));
    let expected = root.join(parent);
    let canonical = std::fs::canonicalize(&expected)
        .map_err(|error| format!("failed to resolve workspace change parent: {error}"))?;
    if !canonical.starts_with(root) || canonical != expected {
        return Err("workspace change parent crosses a symlink or authorized root".into());
    }
    if !std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect workspace change parent: {error}"))?
        .is_dir()
    {
        return Err("workspace change parent is not a directory".into());
    }
    Ok(canonical)
}

fn resolve_new_path(root: &Path, raw_path: &str) -> Result<(PathBuf, PathBuf, String), String> {
    let relative = validate_relative_path(raw_path)?;
    let parent = ensure_parent_inside_root(root, &relative)?;
    let name = relative
        .file_name()
        .ok_or_else(|| "workspace change path has no file name".to_string())?;
    let target = parent.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(format!(
                "workspace change destination already exists: {raw_path}"
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect workspace change destination: {error}"
            ))
        }
    }
    let display = relative_display(&relative);
    Ok((target, relative, display))
}

fn resolve_existing_path(
    root: &Path,
    raw_path: &str,
) -> Result<(PathBuf, PathBuf, String, std::fs::Metadata), String> {
    let relative = validate_relative_path(raw_path)?;
    let requested = root.join(&relative);
    let link_metadata = std::fs::symlink_metadata(&requested)
        .map_err(|error| format!("failed to inspect workspace change source: {error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("workspace changes refuse to mutate symbolic links".into());
    }
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve workspace change source: {error}"))?;
    if !canonical.starts_with(root) || canonical != requested {
        return Err("workspace change source crosses a symlink or authorized root".into());
    }
    let display = relative_display(&relative);
    Ok((canonical, relative, display, link_metadata))
}

fn source_identity(
    path: &Path,
    metadata: &std::fs::Metadata,
    expected_sha256: Option<&str>,
) -> Result<SourceIdentity, String> {
    if metadata.is_dir() {
        if expected_sha256.is_some() {
            return Err("expectedSha256 is only valid for text files".into());
        }
        return Ok(SourceIdentity::Directory(directory_sha256(path)?));
    }
    if !metadata.is_file() || !is_supported_text_path(path) {
        return Err("workspace move/trash supports text files and directories only".into());
    }
    let expected = validate_expected_sha256(
        expected_sha256.ok_or_else(|| "expectedSha256 is required for text files".to_string())?,
    )?;
    let bytes = std::fs::read(path)
        .map_err(|error| format!("failed to read workspace change source: {error}"))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("workspace text file is larger than 1 MiB".into());
    }
    std::str::from_utf8(&bytes)
        .map_err(|_| "workspace change source is not valid UTF-8 text".to_string())?;
    let actual = sha256_bytes(&bytes);
    if actual != expected {
        return Err("workspace change conflict: expectedSha256 does not match".into());
    }
    Ok(SourceIdentity::TextFile(actual))
}

fn recovery_material_identity(
    path: &Path,
    original_path: &str,
    metadata: &std::fs::Metadata,
) -> Result<SourceIdentity, String> {
    if metadata.is_dir() {
        return Ok(SourceIdentity::Directory(directory_sha256(path)?));
    }
    if !metadata.is_file() || !is_supported_text_path(Path::new(original_path)) {
        return Err("workspace recovery material is not a supported text file or directory".into());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("failed to read workspace recovery material: {error}"))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("workspace recovery text file is larger than 1 MiB".into());
    }
    std::str::from_utf8(&bytes)
        .map_err(|_| "workspace recovery material is not valid UTF-8 text".to_string())?;
    Ok(SourceIdentity::TextFile(sha256_bytes(&bytes)))
}

fn verify_identity(path: &Path, identity: &SourceIdentity) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("workspace change conflict: source changed: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("workspace change conflict: source became a symbolic link".into());
    }
    match identity {
        SourceIdentity::Directory(expected) if metadata.is_dir() => {
            if &directory_sha256(path)? == expected {
                Ok(())
            } else {
                Err("workspace change conflict: directory changed".into())
            }
        }
        SourceIdentity::TextFile(expected) if metadata.is_file() => {
            let actual = sha256_bytes(
                &std::fs::read(path)
                    .map_err(|error| format!("failed to recheck workspace source: {error}"))?,
            );
            if &actual == expected {
                Ok(())
            } else {
                Err("workspace change conflict: source content changed".into())
            }
        }
        _ => Err("workspace change conflict: source kind changed".into()),
    }
}

fn reserve_path(paths: &mut Vec<PathBuf>, path: &Path) -> Result<(), String> {
    if paths.iter().any(|reserved| {
        reserved == path || reserved.starts_with(path) || path.starts_with(reserved)
    }) {
        return Err("workspace batch contains overlapping source or destination paths".into());
    }
    paths.push(path.to_path_buf());
    Ok(())
}

fn prepare_changes(
    root: &Path,
    operations: &[WorkspaceChangeOperation],
) -> Result<Vec<PreparedChange>, String> {
    if operations.is_empty() || operations.len() > MAX_CHANGE_OPERATIONS {
        return Err(format!(
            "workspace change batch must contain 1-{MAX_CHANGE_OPERATIONS} operations"
        ));
    }
    let mut content_bytes = 0usize;
    let mut reserved = Vec::new();
    let mut prepared = Vec::with_capacity(operations.len());

    for operation in operations {
        match operation {
            WorkspaceChangeOperation::CreateFile { path, content } => {
                content_bytes = content_bytes.saturating_add(content.len());
                if content.len() as u64 > MAX_TEXT_FILE_BYTES {
                    return Err("workspace create content is larger than 1 MiB".into());
                }
                let (target, _, relative) = resolve_new_path(root, path)?;
                if !is_supported_text_path(&target) {
                    return Err("workspace file type is not supported for text writing".into());
                }
                reserve_path(&mut reserved, &target)?;
                prepared.push(PreparedChange::CreateFile {
                    target,
                    relative,
                    content: content.as_bytes().to_vec(),
                });
            }
            WorkspaceChangeOperation::PatchFile {
                path,
                expected_sha256,
                old_text,
                new_text,
            } => {
                if old_text.is_empty() {
                    return Err("workspace patch oldText cannot be empty".into());
                }
                content_bytes = content_bytes.saturating_add(old_text.len() + new_text.len());
                let expected = validate_expected_sha256(expected_sha256)?;
                let (target, _, relative, metadata) = resolve_existing_path(root, path)?;
                if !metadata.is_file() || !is_supported_text_path(&target) {
                    return Err("workspace patch requires a supported text file".into());
                }
                let bytes = std::fs::read(&target)
                    .map_err(|error| format!("failed to read workspace patch file: {error}"))?;
                let actual = sha256_bytes(&bytes);
                if actual != expected {
                    return Err("workspace patch conflict: expectedSha256 does not match".into());
                }
                let content = String::from_utf8(bytes)
                    .map_err(|_| "workspace patch file is not valid UTF-8 text".to_string())?;
                let occurrences = content.match_indices(old_text).count();
                if occurrences != 1 {
                    return Err(format!(
                        "workspace patch oldText must occur exactly once; found {occurrences} matches"
                    ));
                }
                let updated = content.replacen(old_text, new_text, 1).into_bytes();
                if updated.len() as u64 > MAX_TEXT_FILE_BYTES {
                    return Err("workspace patched file would be larger than 1 MiB".into());
                }
                reserve_path(&mut reserved, &target)?;
                prepared.push(PreparedChange::PatchFile {
                    target,
                    relative,
                    expected_sha256: expected,
                    updated,
                    permissions: metadata.permissions(),
                });
            }
            WorkspaceChangeOperation::CreateDirectory { path } => {
                let (target, _, relative) = resolve_new_path(root, path)?;
                reserve_path(&mut reserved, &target)?;
                prepared.push(PreparedChange::CreateDirectory { target, relative });
            }
            WorkspaceChangeOperation::Move {
                from,
                to,
                expected_sha256,
            } => {
                let (source, _, source_relative, metadata) = resolve_existing_path(root, from)?;
                let (destination, _, destination_relative) = resolve_new_path(root, to)?;
                reserve_path(&mut reserved, &source)?;
                reserve_path(&mut reserved, &destination)?;
                prepared.push(PreparedChange::Move {
                    identity: source_identity(&source, &metadata, expected_sha256.as_deref())?,
                    source,
                    destination,
                    source_relative,
                    destination_relative,
                });
            }
            WorkspaceChangeOperation::Trash {
                path,
                expected_sha256,
            } => {
                let (source, _, relative, metadata) = resolve_existing_path(root, path)?;
                reserve_path(&mut reserved, &source)?;
                prepared.push(PreparedChange::Trash {
                    identity: source_identity(&source, &metadata, expected_sha256.as_deref())?,
                    source,
                    relative,
                });
            }
        }
    }
    if content_bytes > MAX_BATCH_CONTENT_BYTES {
        return Err("workspace change batch text exceeds 2 MiB".into());
    }
    Ok(prepared)
}

fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "workspace change target has no parent".to_string())?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync workspace change directory: {error}"))
}

fn write_atomic(
    target: &Path,
    bytes: &[u8],
    permissions: Option<std::fs::Permissions>,
    no_clobber: bool,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "workspace change target has no parent".to_string())?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create workspace change temporary file: {error}"))?;
    if let Some(permissions) = permissions {
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|error| format!("failed to preserve workspace file permissions: {error}"))?;
    }
    temporary
        .write_all(bytes)
        .map_err(|error| format!("failed to write workspace change temporary file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync workspace change temporary file: {error}"))?;
    if no_clobber {
        temporary.persist_noclobber(target).map_err(|error| {
            format!(
                "workspace change destination appeared concurrently: {}",
                error.error
            )
        })?;
    } else {
        temporary.persist(target).map_err(|error| {
            format!(
                "failed to atomically replace workspace file: {}",
                error.error
            )
        })?;
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "android"))]
fn rename_noclobber(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
fn rename_noclobber(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(to) {
        Ok(_) => Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::rename(from, to),
        Err(error) => Err(error),
    }
}

fn validate_backup_name(name: &str) -> Result<&str, String> {
    let prefix = name
        .strip_suffix(".original")
        .ok_or_else(|| "workspace transaction backup name is invalid".to_string())?;
    if prefix.parse::<usize>().is_err() || Path::new(name).components().count() != 1 {
        return Err("workspace transaction backup name is invalid".into());
    }
    Ok(name)
}

fn validate_trash_name(name: &str) -> Result<(), String> {
    let normalized = name
        .parse::<usize>()
        .map_err(|_| "workspace transaction trash name is invalid".to_string())?
        .to_string();
    if normalized != name || Path::new(name).components().count() != 1 {
        return Err("workspace transaction trash name is invalid".into());
    }
    Ok(())
}

fn read_bounded(path: &Path, maximum: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    if metadata.len() > maximum {
        return Err(format!("{label} exceeds safety limit"));
    }
    std::fs::read(path).map_err(|error| format!("failed to read {label}: {error}"))
}

fn validate_transaction_area(transaction: &Path, name: &str) -> Result<PathBuf, String> {
    let area = transaction.join(name);
    let metadata = std::fs::symlink_metadata(&area)
        .map_err(|error| format!("failed to inspect workspace transaction {name}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("workspace transaction {name} is invalid"));
    }
    Ok(area)
}

fn write_json_atomic<T: serde::Serialize>(
    path: &Path,
    value: &T,
    no_clobber: bool,
    label: &str,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to encode {label}: {error}"))?;
    if bytes.len() as u64 > MAX_TRANSACTION_BYTES {
        return Err(format!("{label} exceeds safety limit"));
    }
    write_atomic(path, &bytes, None, no_clobber)?;
    sync_parent(path)
}

fn read_json_bounded<T: serde::de::DeserializeOwned>(
    path: &Path,
    maximum: u64,
    label: &str,
) -> Result<T, String> {
    serde_json::from_slice(&read_bounded(path, maximum, label)?)
        .map_err(|error| format!("failed to decode {label}: {error}"))
}

fn write_transaction_journal(
    path: &Path,
    journal: &TransactionJournal,
    no_clobber: bool,
) -> Result<(), String> {
    write_json_atomic(path, journal, no_clobber, "workspace transaction journal")
}

fn read_transaction_journal(path: &Path) -> Result<TransactionJournal, String> {
    read_json_bounded(path, MAX_TRANSACTION_BYTES, "workspace transaction journal")
}

fn write_restore_journal(
    path: &Path,
    journal: &RestoreJournal,
    no_clobber: bool,
) -> Result<(), String> {
    write_json_atomic(path, journal, no_clobber, "workspace restore journal")
}

fn read_restore_journal(path: &Path) -> Result<RestoreJournal, String> {
    read_json_bounded(path, MAX_TRANSACTION_BYTES, "workspace restore journal")
}

fn append_journal_entry<J, A>(
    transaction: &Path,
    journal_file: &str,
    journal: &mut J,
    actions: impl Fn(&mut J) -> &mut Vec<A>,
    action: A,
    write: impl Fn(&Path, &J) -> Result<(), String>,
) -> Result<(), String> {
    actions(journal).push(action);
    if let Err(error) = write(&transaction.join(journal_file), journal) {
        actions(journal).pop();
        return Err(error);
    }
    Ok(())
}

fn discard_last_journal_entry<J, A>(
    transaction: &Path,
    journal_file: &str,
    journal: &mut J,
    actions: impl Fn(&mut J) -> &mut Vec<A>,
    write: impl Fn(&Path, &J) -> Result<(), String>,
) {
    actions(journal).pop();
    let _ = write(&transaction.join(journal_file), journal);
}

fn append_restore_action(
    transaction: &Path,
    journal: &mut RestoreJournal,
    action: RestoreAction,
) -> Result<(), String> {
    append_journal_entry(
        transaction,
        "restore.json",
        journal,
        |journal| &mut journal.actions,
        action,
        |path, journal| write_restore_journal(path, journal, false),
    )
}

fn discard_last_restore_action(transaction: &Path, journal: &mut RestoreJournal) {
    discard_last_journal_entry(
        transaction,
        "restore.json",
        journal,
        |journal| &mut journal.actions,
        |path, journal| write_restore_journal(path, journal, false),
    )
}

fn append_journal_action(
    transaction: &Path,
    journal: &mut TransactionJournal,
    action: JournalAction,
) -> Result<(), String> {
    append_journal_entry(
        transaction,
        "transaction.json",
        journal,
        |journal| &mut journal.actions,
        action,
        |path, journal| write_transaction_journal(path, journal, false),
    )
}

fn discard_last_journal_action(transaction: &Path, journal: &mut TransactionJournal) {
    discard_last_journal_entry(
        transaction,
        "transaction.json",
        journal,
        |journal| &mut journal.actions,
        |path, journal| write_transaction_journal(path, journal, false),
    )
}

fn resolve_recovery_path(root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(raw_path)?;
    let parent = ensure_parent_inside_root(root, &relative)?;
    Ok(parent.join(
        relative
            .file_name()
            .ok_or_else(|| "workspace recovery path has no file name".to_string())?,
    ))
}

fn identity_matches(path: &Path, identity: &SourceIdentity) -> Result<bool, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect workspace recovery identity: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("workspace recovery conflict: path became a symbolic link".into());
    }
    match identity {
        SourceIdentity::TextFile(expected) if metadata.is_file() => Ok(sha256_bytes(
            &std::fs::read(path)
                .map_err(|error| format!("failed to read workspace recovery identity: {error}"))?,
        ) == *expected),
        SourceIdentity::Directory(expected) if metadata.is_dir() => {
            Ok(directory_sha256(path)? == *expected)
        }
        _ => Ok(false),
    }
}

fn existing_identity(path: &Path, identity: &SourceIdentity) -> Result<Option<bool>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => identity_matches(path, identity).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "failed to inspect workspace recovery path: {error}"
        )),
    }
}

fn recover_rename(
    source: &Path,
    destination: &Path,
    identity: &SourceIdentity,
    label: &str,
) -> Result<(), String> {
    let source_state = existing_identity(source, identity)?;
    let destination_state = existing_identity(destination, identity)?;
    match (source_state, destination_state) {
        (Some(true), None) => Ok(()),
        (None, Some(true)) => {
            rename_noclobber(destination, source)
                .map_err(|error| format!("failed to recover workspace {label}: {error}"))?;
            sync_parent(source)?;
            sync_parent(destination)
        }
        (Some(false), None) => Err(format!(
            "workspace recovery conflict: {label} source identity changed"
        )),
        (None, Some(false)) => Err(format!(
            "workspace recovery conflict: {label} destination identity changed"
        )),
        (Some(_), Some(_)) => Err(format!(
            "workspace recovery conflict: {label} source and destination both exist"
        )),
        (None, None) => Err(format!(
            "workspace recovery conflict: {label} source and destination are both missing"
        )),
    }
}

fn recover_action(root: &Path, transaction: &Path, action: &JournalAction) -> Result<(), String> {
    match action {
        JournalAction::RemoveFile {
            path,
            created_sha256,
        } => {
            let target = resolve_recovery_path(root, path)?;
            let metadata = match std::fs::symlink_metadata(&target) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(format!(
                        "failed to inspect workspace recovery file: {error}"
                    ))
                }
            };
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || sha256_bytes(
                    &std::fs::read(&target).map_err(|error| {
                        format!("failed to read workspace recovery file: {error}")
                    })?,
                ) != *created_sha256
            {
                return Err(format!(
                    "workspace recovery conflict: created file changed: {path}"
                ));
            }
            std::fs::remove_file(&target)
                .map_err(|error| format!("failed to remove created workspace file: {error}"))?;
            sync_parent(&target)
        }
        JournalAction::RestoreFile {
            path,
            backup_name,
            original_sha256,
            updated_sha256,
        } => {
            let target = resolve_recovery_path(root, path)?;
            let backup = transaction
                .join("backups")
                .join(validate_backup_name(backup_name)?);
            let backup_metadata = std::fs::symlink_metadata(&backup)
                .map_err(|error| format!("workspace recovery backup is missing: {error}"))?;
            if backup_metadata.file_type().is_symlink() || !backup_metadata.is_file() {
                return Err("workspace recovery backup is invalid".into());
            }
            let backup_bytes = std::fs::read(&backup)
                .map_err(|error| format!("failed to read workspace recovery backup: {error}"))?;
            if sha256_bytes(&backup_bytes) != *original_sha256 {
                return Err("workspace recovery backup identity changed".into());
            }
            let target_metadata = std::fs::symlink_metadata(&target)
                .map_err(|error| format!("workspace recovery patch target is missing: {error}"))?;
            if target_metadata.file_type().is_symlink() || !target_metadata.is_file() {
                return Err("workspace recovery patch target is invalid".into());
            }
            let actual = sha256_bytes(&std::fs::read(&target).map_err(|error| {
                format!("failed to read workspace recovery patch target: {error}")
            })?);
            if actual == *original_sha256 {
                return Ok(());
            }
            if actual != *updated_sha256 {
                return Err(format!(
                    "workspace recovery conflict: patched file changed: {path}"
                ));
            }
            write_atomic(
                &target,
                &backup_bytes,
                Some(backup_metadata.permissions()),
                false,
            )?;
            sync_parent(&target)
        }
        JournalAction::RemoveDirectory { path } => {
            let target = resolve_recovery_path(root, path)?;
            let metadata = match std::fs::symlink_metadata(&target) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(format!(
                        "failed to inspect workspace recovery directory: {error}"
                    ))
                }
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "workspace recovery conflict: created directory changed: {path}"
                ));
            }
            if std::fs::read_dir(&target)
                .map_err(|error| format!("failed to inspect created directory: {error}"))?
                .next()
                .transpose()
                .map_err(|error| format!("failed to inspect created directory: {error}"))?
                .is_some()
            {
                return Err(format!(
                    "workspace recovery conflict: created directory is not empty: {path}"
                ));
            }
            std::fs::remove_dir(&target).map_err(|error| {
                format!("failed to remove created workspace directory: {error}")
            })?;
            sync_parent(&target)
        }
        JournalAction::Move {
            source,
            destination,
            identity,
        } => recover_rename(
            &resolve_recovery_path(root, source)?,
            &resolve_recovery_path(root, destination)?,
            identity,
            "move",
        ),
        JournalAction::Trash {
            source,
            stored_name,
            identity,
        } => {
            validate_trash_name(stored_name)?;
            recover_rename(
                &resolve_recovery_path(root, source)?,
                &transaction.join("trash").join(stored_name),
                identity,
                "trash",
            )
        }
    }
}

fn recover_reversed(
    count: usize,
    mut recover: impl FnMut(usize) -> Result<(), String>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for index in (0..count).rev() {
        if let Err(error) = recover(index) {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn recover_journal_actions(
    root: &Path,
    transaction: &Path,
    journal: &TransactionJournal,
) -> Result<(), String> {
    recover_reversed(journal.actions.len(), |index| {
        recover_action(root, transaction, &journal.actions[index])
    })
}

fn remove_transaction(transaction: &Path) -> Result<(), String> {
    let parent = transaction
        .parent()
        .ok_or_else(|| "workspace transaction has no parent".to_string())?;
    std::fs::remove_dir_all(transaction)
        .map_err(|error| format!("failed to clean workspace transaction: {error}"))?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync workspace transaction parent: {error}"))
}

fn cleanup_committed_transaction(transaction: &Path) -> Result<(), String> {
    let backups = transaction.join("backups");
    match std::fs::symlink_metadata(&backups) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir_all(&backups)
                .map_err(|error| format!("failed to clean workspace backups: {error}"))?;
        }
        Ok(_) => return Err("workspace transaction backup area is invalid".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect workspace backups: {error}")),
    }
    let journal_path = transaction.join("transaction.json");
    match std::fs::remove_file(&journal_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to clean workspace journal: {error}")),
    }
    std::fs::File::open(transaction)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync committed workspace transaction: {error}"))
}

fn rollback_journal<J>(
    transaction: &Path,
    journal_file: &str,
    journal: &mut J,
    mark_rolling_back: impl Fn(&mut J),
    write: impl Fn(&Path, &J) -> Result<(), String>,
    recover: impl Fn(&J) -> Result<(), String>,
    cleanup: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    mark_rolling_back(journal);
    let _ = write(&transaction.join(journal_file), journal);
    recover(journal)?;
    cleanup(transaction)
}

fn rollback_transaction(
    root: &Path,
    transaction: &Path,
    journal: &mut TransactionJournal,
) -> Result<(), String> {
    rollback_journal(
        transaction,
        "transaction.json",
        journal,
        |journal| journal.status = TransactionStatus::RollingBack,
        |path, journal| write_transaction_journal(path, journal, false),
        |journal| recover_journal_actions(root, transaction, journal),
        remove_transaction,
    )
}

fn recover_restore_action(
    root: &Path,
    transaction: &Path,
    action: &RestoreAction,
) -> Result<(), String> {
    validate_relative_path(&action.original_path)?;
    validate_trash_name(&action.stored_name)?;
    recover_rename(
        &transaction.join("trash").join(&action.stored_name),
        &resolve_recovery_path(root, &action.original_path)?,
        &action.identity,
        "trash restore",
    )
}

fn recover_restore_actions(
    root: &Path,
    transaction: &Path,
    journal: &RestoreJournal,
) -> Result<(), String> {
    recover_reversed(journal.actions.len(), |index| {
        recover_restore_action(root, transaction, &journal.actions[index])
    })
}

fn cleanup_restore_transaction(transaction: &Path, remove_trash: bool) -> Result<(), String> {
    if remove_trash {
        let trash = transaction.join("trash");
        match std::fs::symlink_metadata(&trash) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                std::fs::remove_dir_all(&trash).map_err(|error| {
                    format!("failed to clean workspace restore material: {error}")
                })?;
            }
            Ok(_) => return Err("workspace restore material area is invalid".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect workspace restore material: {error}"
                ))
            }
        }
    }
    let journal_path = transaction.join("restore.json");
    match std::fs::remove_file(&journal_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to clean workspace restore journal: {error}"
            ))
        }
    }
    std::fs::File::open(transaction)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync workspace restore transaction: {error}"))
}

fn rollback_restore_transaction(
    root: &Path,
    transaction: &Path,
    journal: &mut RestoreJournal,
) -> Result<(), String> {
    rollback_journal(
        transaction,
        "restore.json",
        journal,
        |journal| journal.status = RestoreStatus::RollingBack,
        |path, journal| write_restore_journal(path, journal, false),
        |journal| recover_restore_actions(root, transaction, journal),
        |transaction| cleanup_restore_transaction(transaction, false),
    )
}

fn restore_failure_after_rollback(
    error: String,
    root: &Path,
    transaction: &Path,
    journal: &mut RestoreJournal,
) -> String {
    match rollback_restore_transaction(root, transaction, journal) {
        Ok(()) => format!("{error}; all restored workspace paths were rolled back"),
        Err(rollback_error) => format!(
            "{error}; rollback was incomplete: {rollback_error}; recovery data remains at {}",
            transaction.display()
        ),
    }
}

fn write_receipt(path: &Path, receipt: &ChangeReceipt) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|error| format!("failed to encode workspace change receipt: {error}"))?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err("workspace change receipt exceeds safety limit".into());
    }
    write_atomic(path, &bytes, None, true)?;
    sync_parent(path)
}

pub(crate) fn audit_artifact_hashes(app_data: &Path) -> Result<Vec<String>, String> {
    let base = app_data.join("workspace-changes");
    match std::fs::symlink_metadata(&base) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err("workspace change receipt root is not a directory".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to inspect workspace receipt root: {error}")),
    }
    let mut hashes = Vec::new();
    for workspace in std::fs::read_dir(&base)
        .map_err(|error| format!("failed to scan workspace change receipts: {error}"))?
    {
        let workspace = workspace
            .map_err(|error| format!("failed to scan workspace change receipt entry: {error}"))?;
        if !workspace
            .file_type()
            .map_err(|error| format!("failed to read workspace receipt entry type: {error}"))?
            .is_dir()
        {
            continue;
        }
        for transaction in std::fs::read_dir(workspace.path())
            .map_err(|error| format!("failed to scan workspace transactions: {error}"))?
        {
            let transaction = transaction
                .map_err(|error| format!("failed to scan workspace transaction entry: {error}"))?;
            if !transaction
                .file_type()
                .map_err(|error| format!("failed to read workspace transaction type: {error}"))?
                .is_dir()
            {
                continue;
            }
            let receipt_path = transaction.path().join("receipt.json");
            let metadata = match std::fs::symlink_metadata(&receipt_path) {
                Ok(metadata) if metadata.file_type().is_file() => metadata,
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "failed to inspect workspace change receipt: {error}"
                    ));
                }
            };
            if metadata.len() > MAX_RECEIPT_BYTES {
                return Err("workspace change receipt exceeds safety limit".to_string());
            }
            let receipt: ChangeReceipt =
                serde_json::from_slice(&std::fs::read(&receipt_path).map_err(|error| {
                    format!("failed to read workspace change receipt: {error}")
                })?)
                .map_err(|error| format!("failed to decode workspace change receipt: {error}"))?;
            if let Some(artifact) = receipt.audit_artifact {
                hashes.push(artifact.content_hash);
            }
        }
    }
    Ok(hashes)
}

fn append_diff_block(output: &mut String, prefix: char, value: &str) {
    for line in value.split('\n') {
        writeln!(output, "{prefix} {line}").expect("writing to String cannot fail");
    }
}

fn workspace_change_audit(
    root: &Path,
    request_id: &str,
    operations: &[WorkspaceChangeOperation],
    result: &WorkspaceChangeResult,
) -> Result<String, String> {
    let mut output = String::from("# Axiom workspace change audit\n");
    writeln!(output, "requestId: {request_id}").expect("writing to String cannot fail");
    writeln!(output, "workspace: {}\n", root.to_string_lossy())
        .expect("writing to String cannot fail");
    for (index, operation) in operations.iter().enumerate() {
        writeln!(output, "## {}. {}", index + 1, operation.operation_name())
            .expect("writing to String cannot fail");
        match operation {
            WorkspaceChangeOperation::CreateFile { path, content } => {
                writeln!(output, "--- /dev/null\n+++ {path}")
                    .expect("writing to String cannot fail");
                append_diff_block(&mut output, '+', content);
            }
            WorkspaceChangeOperation::PatchFile {
                path,
                expected_sha256,
                old_text,
                new_text,
            } => {
                writeln!(
                    output,
                    "--- {path}\n+++ {path}\nexpected sha256 {expected_sha256}"
                )
                .expect("writing to String cannot fail");
                append_diff_block(&mut output, '-', old_text);
                append_diff_block(&mut output, '+', new_text);
            }
            WorkspaceChangeOperation::CreateDirectory { path } => {
                writeln!(output, "mkdir {path}").expect("writing to String cannot fail");
            }
            WorkspaceChangeOperation::Move {
                from,
                to,
                expected_sha256,
            } => {
                write!(output, "move {from} -> {to}").expect("writing to String cannot fail");
                if let Some(expected_sha256) = expected_sha256 {
                    write!(output, "\nexpected sha256 {expected_sha256}")
                        .expect("writing to String cannot fail");
                }
                output.push('\n');
            }
            WorkspaceChangeOperation::Trash {
                path,
                expected_sha256,
            } => {
                write!(output, "recoverable trash {path}").expect("writing to String cannot fail");
                if let Some(expected_sha256) = expected_sha256 {
                    write!(output, "\nexpected sha256 {expected_sha256}")
                        .expect("writing to String cannot fail");
                }
                output.push('\n');
            }
        }
        output.push('\n');
    }
    output.push_str("## Result\n");
    output.push_str(
        &serde_json::to_string_pretty(result)
            .map_err(|error| format!("failed to encode workspace audit result: {error}"))?,
    );
    Ok(output)
}

impl WorkspaceChangeOperation {
    fn operation_name(&self) -> &'static str {
        match self {
            Self::CreateFile { .. } => "create-file",
            Self::PatchFile { .. } => "patch-file",
            Self::CreateDirectory { .. } => "create-directory",
            Self::Move { .. } => "move",
            Self::Trash { .. } => "trash",
        }
    }
}

fn summarize_prepared(prepared: &[PreparedChange]) -> Vec<WorkspaceChangeSummary> {
    prepared
        .iter()
        .map(|change| match change {
            PreparedChange::CreateFile {
                relative, content, ..
            } => WorkspaceChangeSummary {
                operation: "create-file".into(),
                path: relative.clone(),
                destination: None,
                sha256: Some(sha256_bytes(content)),
            },
            PreparedChange::PatchFile {
                relative, updated, ..
            } => WorkspaceChangeSummary {
                operation: "patch-file".into(),
                path: relative.clone(),
                destination: None,
                sha256: Some(sha256_bytes(updated)),
            },
            PreparedChange::CreateDirectory { relative, .. } => WorkspaceChangeSummary {
                operation: "create-directory".into(),
                path: relative.clone(),
                destination: None,
                sha256: None,
            },
            PreparedChange::Move {
                source_relative,
                destination_relative,
                identity,
                ..
            } => WorkspaceChangeSummary {
                operation: "move".into(),
                path: source_relative.clone(),
                destination: Some(destination_relative.clone()),
                sha256: match identity {
                    SourceIdentity::TextFile(hash) => Some(hash.clone()),
                    SourceIdentity::Directory(_) => None,
                },
            },
            PreparedChange::Trash {
                relative, identity, ..
            } => WorkspaceChangeSummary {
                operation: "trash".into(),
                path: relative.clone(),
                destination: None,
                sha256: match identity {
                    SourceIdentity::TextFile(hash) => Some(hash.clone()),
                    SourceIdentity::Directory(_) => None,
                },
            },
        })
        .collect()
}

fn execute_prepared(
    root: &Path,
    recovery_base: &Path,
    app_data: &Path,
    request_id: &str,
    operations: &[WorkspaceChangeOperation],
    prepared: Vec<PreparedChange>,
) -> Result<WorkspaceChangeResult, String> {
    let transaction = recovery_base
        .join(workspace_fingerprint(root))
        .join(request_id);
    let transaction_parent = transaction
        .parent()
        .ok_or_else(|| "workspace change transaction has no parent".to_string())?;
    std::fs::create_dir_all(transaction_parent)
        .map_err(|error| format!("failed to create workspace recovery root: {error}"))?;
    match std::fs::symlink_metadata(&transaction) {
        Ok(_) => {
            return Err(
                "workspace change request was already applied or is still recoverable".into(),
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect workspace transaction: {error}")),
    }
    let initializing = Builder::new()
        .prefix(".initializing-")
        .tempdir_in(transaction_parent)
        .map_err(|error| format!("failed to create workspace transaction: {error}"))?;
    let initializing_backups = initializing.path().join("backups");
    let initializing_trash = initializing.path().join("trash");
    std::fs::create_dir(&initializing_backups)
        .map_err(|error| format!("failed to create workspace rollback area: {error}"))
        .and_then(|()| {
            std::fs::create_dir(&initializing_trash)
                .map_err(|error| format!("failed to create workspace trash area: {error}"))
        })?;
    std::fs::File::open(initializing.path())
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync workspace transaction: {error}"))?;

    let mut journal = TransactionJournal {
        version: TRANSACTION_VERSION,
        request_id: request_id.to_string(),
        workspace: root.to_string_lossy().into_owned(),
        status: TransactionStatus::Applying,
        actions: Vec::new(),
    };
    write_transaction_journal(
        &initializing.path().join("transaction.json"),
        &journal,
        true,
    )?;
    let initializing = initializing.keep();
    if let Err(error) = rename_noclobber(&initializing, &transaction) {
        let _ = std::fs::remove_dir_all(&initializing);
        return Err(format!("failed to publish workspace transaction: {error}"));
    }
    sync_parent(&transaction)?;
    let backups = transaction.join("backups");
    let trash_root = transaction.join("trash");

    let changes = summarize_prepared(&prepared);
    let recovery_id = changes
        .iter()
        .any(|change| change.operation == "trash")
        .then(|| request_id.to_string());
    let mut result = WorkspaceChangeResult {
        workspace: workspace_summary(root),
        request_id: request_id.to_string(),
        changes,
        recovery_id,
        audit_artifact: None,
    };
    let audit_result = (|| {
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("failed to resolve workspace audit timestamp: {error}"))?
            .as_millis()
            .try_into()
            .map_err(|_| "workspace audit timestamp exceeds supported range".to_string())?;
        write_text_artifact_at(
            app_data,
            workspace_change_audit(root, request_id, operations, &result)?,
            created_at,
        )
    })();
    result.audit_artifact = match audit_result {
        Ok(artifact) => Some(artifact),
        Err(error) => {
            let _ = remove_transaction(&transaction);
            return Err(format!(
                "failed to persist workspace audit before applying changes: {error}"
            ));
        }
    };

    let mut trash = Vec::new();
    let execution: Result<(), String> = (|| {
        for (index, change) in prepared.into_iter().enumerate() {
            match change {
                PreparedChange::CreateFile {
                    target,
                    relative,
                    content,
                } => {
                    append_journal_action(
                        &transaction,
                        &mut journal,
                        JournalAction::RemoveFile {
                            path: relative,
                            created_sha256: sha256_bytes(&content),
                        },
                    )?;
                    if let Err(error) = write_atomic(&target, &content, None, true) {
                        discard_last_journal_action(&transaction, &mut journal);
                        return Err(error);
                    }
                    sync_parent(&target)?;
                }
                PreparedChange::PatchFile {
                    target,
                    relative,
                    expected_sha256,
                    updated,
                    permissions,
                } => {
                    let current = std::fs::read(&target)
                        .map_err(|error| format!("failed to recheck workspace patch: {error}"))?;
                    if sha256_bytes(&current) != expected_sha256 {
                        return Err("workspace patch conflict: file changed after approval".into());
                    }
                    let backup_name = format!("{index}.original");
                    let backup = backups.join(&backup_name);
                    std::fs::copy(&target, &backup).map_err(|error| {
                        format!("failed to copy workspace rollback backup: {error}")
                    })?;
                    std::fs::File::open(&backup)
                        .and_then(|file| file.sync_all())
                        .map_err(|error| {
                            format!("failed to sync workspace rollback backup: {error}")
                        })?;
                    sync_parent(&backup)?;
                    append_journal_action(
                        &transaction,
                        &mut journal,
                        JournalAction::RestoreFile {
                            path: relative,
                            backup_name,
                            original_sha256: expected_sha256,
                            updated_sha256: sha256_bytes(&updated),
                        },
                    )?;
                    if let Err(error) =
                        write_atomic(&target, &updated, Some(permissions.clone()), false)
                    {
                        discard_last_journal_action(&transaction, &mut journal);
                        return Err(error);
                    }
                    sync_parent(&target)?;
                }
                PreparedChange::CreateDirectory { target, relative } => {
                    append_journal_action(
                        &transaction,
                        &mut journal,
                        JournalAction::RemoveDirectory { path: relative },
                    )?;
                    if let Err(error) = std::fs::create_dir(&target) {
                        discard_last_journal_action(&transaction, &mut journal);
                        return Err(format!("failed to create workspace directory: {error}"));
                    }
                    sync_parent(&target)?;
                }
                PreparedChange::Move {
                    source,
                    destination,
                    source_relative,
                    destination_relative,
                    identity,
                } => {
                    verify_identity(&source, &identity)?;
                    if std::fs::symlink_metadata(&destination).is_ok() {
                        return Err(
                            "workspace move conflict: destination appeared after approval".into(),
                        );
                    }
                    append_journal_action(
                        &transaction,
                        &mut journal,
                        JournalAction::Move {
                            source: source_relative,
                            destination: destination_relative,
                            identity: identity.clone(),
                        },
                    )?;
                    if let Err(error) = rename_noclobber(&source, &destination) {
                        discard_last_journal_action(&transaction, &mut journal);
                        return Err(format!("failed to move workspace path: {error}"));
                    }
                    sync_parent(&source)?;
                    sync_parent(&destination)?;
                }
                PreparedChange::Trash {
                    source,
                    relative,
                    identity,
                } => {
                    verify_identity(&source, &identity)?;
                    let stored_name = format!("{index}");
                    let stored = trash_root.join(&stored_name);
                    append_journal_action(
                        &transaction,
                        &mut journal,
                        JournalAction::Trash {
                            source: relative.clone(),
                            stored_name: stored_name.clone(),
                            identity,
                        },
                    )?;
                    if let Err(error) = rename_noclobber(&source, &stored) {
                        discard_last_journal_action(&transaction, &mut journal);
                        return Err(format!(
                            "failed to move workspace path into recoverable storage (same-volume recovery is required): {error}"
                        ));
                    }
                    sync_parent(&source)?;
                    sync_parent(&stored)?;
                    trash.push(TrashReceiptEntry {
                        original_path: relative.clone(),
                        stored_name,
                    });
                }
            }
            if index == 0 {
                crate::runtime_fault::checkpoint_if_configured("workspace_change_step_applied")?;
            }
        }

        let receipt = ChangeReceipt {
            version: RECEIPT_VERSION,
            request_id: request_id.to_string(),
            workspace: root.to_string_lossy().into_owned(),
            restored: false,
            changes: result.changes.clone(),
            trash,
            audit_artifact: result.audit_artifact.clone(),
        };
        write_receipt(&transaction.join("receipt.json"), &receipt)?;
        Ok(())
    })();

    if let Err(error) = execution {
        let rollback_result = rollback_transaction(root, &transaction, &mut journal);
        return match rollback_result {
            Ok(()) => Err(format!(
                "{error}; all applied workspace changes were rolled back"
            )),
            Err(rollback_error) => Err(format!(
                "{error}; rollback was incomplete: {rollback_error}; recovery data remains at {}",
                transaction.display()
            )),
        };
    }

    let _ = cleanup_committed_transaction(&transaction);
    Ok(result)
}

fn apply_impl(
    root: &Path,
    recovery_base: &Path,
    app_data: &Path,
    request: WorkspaceChangeRequest,
) -> Result<WorkspaceChangeResult, String> {
    let request_id = validate_request_id(&request.request_id)?.to_string();
    let prepared = prepare_changes(root, &request.operations)?;
    execute_prepared(
        root,
        recovery_base,
        app_data,
        &request_id,
        &request.operations,
        prepared,
    )
}

fn restore_impl(
    root: &Path,
    recovery_base: &Path,
    recovery_id: &str,
) -> Result<WorkspaceChangeResult, String> {
    let recovery_id = validate_request_id(recovery_id)?;
    let transaction = recovery_base
        .join(workspace_fingerprint(root))
        .join(recovery_id);
    let transaction_metadata = std::fs::symlink_metadata(&transaction)
        .map_err(|error| format!("failed to inspect workspace recovery transaction: {error}"))?;
    if transaction_metadata.file_type().is_symlink() || !transaction_metadata.is_dir() {
        return Err("workspace recovery transaction is invalid".into());
    }
    validate_transaction_area(&transaction, "trash")?;
    let receipt_path = transaction.join("receipt.json");
    let original_receipt = read_bounded(
        &receipt_path,
        MAX_RECEIPT_BYTES,
        "workspace recovery receipt",
    )?;
    let mut receipt: ChangeReceipt = serde_json::from_slice(&original_receipt)
        .map_err(|error| format!("invalid workspace recovery receipt: {error}"))?;
    if receipt.version != RECEIPT_VERSION
        || receipt.request_id != recovery_id
        || receipt.workspace != root.to_string_lossy()
        || receipt.restored
        || receipt.trash.is_empty()
    {
        return Err("workspace recovery receipt is not restorable".into());
    }
    cleanup_committed_transaction(&transaction)?;
    if path_is_regular_file(&transaction.join("restore.json"))? {
        return Err("workspace restore transaction is already recoverable".into());
    }

    let mut targets = HashSet::new();
    let mut prepared = Vec::new();
    for entry in &receipt.trash {
        let relative = validate_relative_path(&entry.original_path)?;
        let parent = ensure_parent_inside_root(root, &relative)?;
        let target = parent.join(
            relative
                .file_name()
                .ok_or_else(|| "workspace recovery target has no name".to_string())?,
        );
        if !targets.insert(target.clone()) {
            return Err("workspace recovery conflict: original path is no longer available".into());
        }
        match std::fs::symlink_metadata(&target) {
            Ok(_) => {
                return Err(
                    "workspace recovery conflict: original path is no longer available".into(),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect workspace recovery target: {error}"
                ))
            }
        }
        validate_trash_name(&entry.stored_name)?;
        let stored = transaction.join("trash").join(&entry.stored_name);
        let stored_metadata = std::fs::symlink_metadata(&stored)
            .map_err(|error| format!("workspace recovery material is missing: {error}"))?;
        if stored_metadata.file_type().is_symlink()
            || (!stored_metadata.is_file() && !stored_metadata.is_dir())
        {
            return Err("workspace recovery material is invalid".into());
        }
        prepared.push((
            RestoreAction {
                original_path: entry.original_path.clone(),
                stored_name: entry.stored_name.clone(),
                identity: recovery_material_identity(
                    &stored,
                    &entry.original_path,
                    &stored_metadata,
                )?,
            },
            stored,
            target,
        ));
    }

    let mut journal = RestoreJournal {
        version: RESTORE_VERSION,
        request_id: recovery_id.to_string(),
        workspace: root.to_string_lossy().into_owned(),
        status: RestoreStatus::Restoring,
        actions: Vec::new(),
    };
    write_restore_journal(&transaction.join("restore.json"), &journal, true)?;
    let mut restored_changes = Vec::new();
    for (index, (action, stored, target)) in prepared.into_iter().enumerate() {
        if let Err(error) = append_restore_action(&transaction, &mut journal, action.clone()) {
            return Err(restore_failure_after_rollback(
                error,
                root,
                &transaction,
                &mut journal,
            ));
        }
        if let Err(error) = rename_noclobber(&stored, &target) {
            discard_last_restore_action(&transaction, &mut journal);
            return Err(restore_failure_after_rollback(
                format!("failed to restore workspace trash: {error}"),
                root,
                &transaction,
                &mut journal,
            ));
        }
        if let Err(error) = sync_parent(&stored).and_then(|()| sync_parent(&target)) {
            return Err(restore_failure_after_rollback(
                format!("failed to sync restored workspace trash: {error}"),
                root,
                &transaction,
                &mut journal,
            ));
        }
        restored_changes.push(WorkspaceChangeSummary {
            operation: "restore".into(),
            path: action.original_path,
            destination: None,
            sha256: None,
        });
        if index == 0 {
            if let Err(error) = crate::runtime_fault::checkpoint_if_configured(
                "workspace_trash_restore_step_applied",
            ) {
                return Err(restore_failure_after_rollback(
                    error,
                    root,
                    &transaction,
                    &mut journal,
                ));
            }
        }
    }

    receipt.restored = true;
    let replacement = match serde_json::to_vec_pretty(&receipt) {
        Ok(replacement) => replacement,
        Err(error) => {
            return Err(restore_failure_after_rollback(
                format!("failed to encode restored workspace receipt: {error}"),
                root,
                &transaction,
                &mut journal,
            ))
        }
    };
    if replacement.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(restore_failure_after_rollback(
            "restored workspace receipt exceeds safety limit".into(),
            root,
            &transaction,
            &mut journal,
        ));
    }
    if let Err(error) = write_atomic(&receipt_path, &replacement, None, false) {
        return Err(restore_failure_after_rollback(
            format!("failed to finalize workspace recovery receipt: {error}"),
            root,
            &transaction,
            &mut journal,
        ));
    }
    if let Err(error) = sync_parent(&receipt_path) {
        return Err(format!(
            "workspace recovery commit marker was written but could not be synced: {error}; recovery data remains at {}",
            transaction.display()
        ));
    }
    let _ = cleanup_restore_transaction(&transaction, true);
    Ok(WorkspaceChangeResult {
        workspace: workspace_summary(root),
        request_id: recovery_id.to_string(),
        changes: restored_changes,
        recovery_id: None,
        audit_artifact: None,
    })
}

fn read_receipt(path: &Path) -> Result<ChangeReceipt, String> {
    read_json_bounded(path, MAX_RECEIPT_BYTES, "workspace change receipt")
}

fn validate_transaction_identity(
    workspace_directory: &Path,
    transaction: &Path,
    request_id: &str,
    workspace: &str,
    require_existing_workspace: bool,
) -> Result<Option<PathBuf>, String> {
    let validated_request_id = validate_request_id(request_id)?;
    if transaction.file_name().and_then(|name| name.to_str()) != Some(validated_request_id) {
        return Err("workspace transaction request ID does not match its directory".into());
    }
    let workspace_path = PathBuf::from(workspace);
    if !workspace_path.is_absolute() {
        return Err("workspace transaction root is not absolute".into());
    }
    let fingerprint = workspace_directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "workspace transaction fingerprint is invalid".to_string())?;
    if fingerprint.len() != 24
        || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        || workspace_fingerprint(&workspace_path) != fingerprint
    {
        return Err("workspace transaction fingerprint does not match its root".into());
    }
    if !require_existing_workspace {
        return Ok(None);
    }
    let canonical = std::fs::canonicalize(&workspace_path).map_err(|error| {
        format!("failed to resolve incomplete workspace transaction root: {error}")
    })?;
    if canonical != workspace_path
        || !std::fs::metadata(&canonical)
            .map_err(|error| format!("failed to inspect workspace transaction root: {error}"))?
            .is_dir()
    {
        return Err("incomplete workspace transaction root is no longer canonical".into());
    }
    Ok(Some(canonical))
}

fn validate_source_identity(identity: &SourceIdentity) -> Result<(), String> {
    match identity {
        SourceIdentity::TextFile(hash) | SourceIdentity::Directory(hash) => {
            validate_expected_sha256(hash).map(|_| ())
        }
    }
}

fn validate_transaction_journal(
    workspace_directory: &Path,
    transaction: &Path,
    journal: &TransactionJournal,
    require_existing_workspace: bool,
) -> Result<Option<PathBuf>, String> {
    if journal.version != TRANSACTION_VERSION || journal.actions.len() > MAX_CHANGE_OPERATIONS {
        return Err("workspace transaction journal version or action count is invalid".into());
    }
    let root = validate_transaction_identity(
        workspace_directory,
        transaction,
        &journal.request_id,
        &journal.workspace,
        require_existing_workspace,
    )?;
    if require_existing_workspace {
        validate_transaction_area(transaction, "backups")?;
        validate_transaction_area(transaction, "trash")?;
    }
    for action in &journal.actions {
        match action {
            JournalAction::RemoveFile {
                path,
                created_sha256,
            } => {
                validate_relative_path(path)?;
                validate_expected_sha256(created_sha256)?;
            }
            JournalAction::RestoreFile {
                path,
                backup_name,
                original_sha256,
                updated_sha256,
            } => {
                validate_relative_path(path)?;
                validate_backup_name(backup_name)?;
                validate_expected_sha256(original_sha256)?;
                validate_expected_sha256(updated_sha256)?;
            }
            JournalAction::RemoveDirectory { path } => {
                validate_relative_path(path)?;
            }
            JournalAction::Move {
                source,
                destination,
                identity,
            } => {
                validate_relative_path(source)?;
                validate_relative_path(destination)?;
                validate_source_identity(identity)?;
            }
            JournalAction::Trash {
                source,
                stored_name,
                identity,
            } => {
                validate_relative_path(source)?;
                validate_trash_name(stored_name)?;
                validate_source_identity(identity)?;
            }
        }
    }
    Ok(root)
}

fn validate_committed_receipt(
    workspace_directory: &Path,
    transaction: &Path,
    receipt: &ChangeReceipt,
) -> Result<(), String> {
    if receipt.version != RECEIPT_VERSION {
        return Err("workspace change receipt version is invalid".into());
    }
    validate_transaction_identity(
        workspace_directory,
        transaction,
        &receipt.request_id,
        &receipt.workspace,
        false,
    )?;
    Ok(())
}

fn validate_restore_journal(
    workspace_directory: &Path,
    transaction: &Path,
    journal: &RestoreJournal,
    receipt: &ChangeReceipt,
    require_existing_workspace: bool,
) -> Result<Option<PathBuf>, String> {
    if journal.version != RESTORE_VERSION
        || journal.actions.len() > MAX_CHANGE_OPERATIONS
        || journal.actions.len() > receipt.trash.len()
        || journal.request_id != receipt.request_id
        || journal.workspace != receipt.workspace
    {
        return Err("workspace restore journal is inconsistent with its receipt".into());
    }
    let root = validate_transaction_identity(
        workspace_directory,
        transaction,
        &journal.request_id,
        &journal.workspace,
        require_existing_workspace,
    )?;
    if require_existing_workspace {
        validate_transaction_area(transaction, "trash")?;
    }
    let mut paths = HashSet::new();
    let mut names = HashSet::new();
    for (index, action) in journal.actions.iter().enumerate() {
        let receipt_entry = receipt
            .trash
            .get(index)
            .ok_or_else(|| "workspace restore journal action is not in its receipt".to_string())?;
        if action.original_path != receipt_entry.original_path
            || action.stored_name != receipt_entry.stored_name
            || !paths.insert(action.original_path.clone())
            || !names.insert(action.stored_name.clone())
        {
            return Err("workspace restore journal action does not match its receipt".into());
        }
        validate_relative_path(&action.original_path)?;
        validate_trash_name(&action.stored_name)?;
        validate_source_identity(&action.identity)?;
    }
    Ok(root)
}

fn clean_initializing_transaction(
    workspace_directory: &Path,
    transaction: &Path,
) -> Result<(), String> {
    let mut journal = None;
    for entry in std::fs::read_dir(transaction)
        .map_err(|error| format!("failed to inspect initializing workspace transaction: {error}"))?
    {
        let entry = entry.map_err(|error| {
            format!("failed to inspect initializing workspace transaction entry: {error}")
        })?;
        let name = entry.file_name();
        if name == "transaction.json" {
            journal = Some(read_transaction_journal(&entry.path())?);
            continue;
        }
        if name != "backups" && name != "trash" {
            return Err("initializing workspace transaction contains an invalid entry".into());
        }
        let metadata = entry.file_type().map_err(|error| {
            format!("failed to inspect initializing workspace transaction area: {error}")
        })?;
        if !metadata.is_dir()
            || std::fs::read_dir(entry.path())
                .map_err(|error| {
                    format!("failed to inspect initializing workspace transaction area: {error}")
                })?
                .next()
                .transpose()
                .map_err(|error| {
                    format!("failed to inspect initializing workspace transaction area: {error}")
                })?
                .is_some()
        {
            return Err("initializing workspace transaction contains recovery material".into());
        }
    }
    if let Some(journal) = journal {
        if journal.version != TRANSACTION_VERSION
            || !journal.actions.is_empty()
            || validate_request_id(&journal.request_id).is_err()
        {
            return Err("initializing workspace transaction journal is invalid".into());
        }
        let workspace = PathBuf::from(&journal.workspace);
        let fingerprint = workspace_directory
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "workspace transaction fingerprint is invalid".to_string())?;
        if !workspace.is_absolute() || workspace_fingerprint(&workspace) != fingerprint {
            return Err("initializing workspace transaction root is invalid".into());
        }
    }
    remove_transaction(transaction)
}

fn path_is_regular_file(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(format!(
            "workspace transaction marker is invalid: {}",
            path.display()
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "failed to inspect workspace transaction marker: {error}"
        )),
    }
}

fn recover_workspace_change_transaction(
    workspace_directory: &Path,
    transaction: &Path,
    is_initializing: bool,
) -> Result<(), String> {
    if is_initializing {
        return clean_initializing_transaction(workspace_directory, transaction);
    }
    let journal_path = transaction.join("transaction.json");
    let receipt_path = transaction.join("receipt.json");
    let restore_path = transaction.join("restore.json");
    let has_journal = path_is_regular_file(&journal_path)?;
    let has_receipt = path_is_regular_file(&receipt_path)?;
    let has_restore = path_is_regular_file(&restore_path)?;
    if has_restore && !has_receipt {
        return Err("workspace restore transaction is missing its receipt".into());
    }
    if has_journal {
        let mut journal = read_transaction_journal(&journal_path)?;
        let root = validate_transaction_journal(
            workspace_directory,
            transaction,
            &journal,
            !has_receipt && !journal.actions.is_empty(),
        )?;
        if has_receipt {
            let receipt = read_receipt(&receipt_path)?;
            validate_committed_receipt(workspace_directory, transaction, &receipt)?;
            if receipt.request_id != journal.request_id || receipt.workspace != journal.workspace {
                return Err("workspace receipt does not match its transaction journal".into());
            }
            cleanup_committed_transaction(transaction)?;
        } else if journal.actions.is_empty() {
            return remove_transaction(transaction);
        } else {
            let root = root.ok_or_else(|| "workspace transaction root is missing".to_string())?;
            return rollback_transaction(&root, transaction, &mut journal);
        }
    }
    if !has_receipt {
        return Err("workspace transaction is missing its receipt".into());
    }
    let receipt = read_receipt(&receipt_path)?;
    validate_committed_receipt(workspace_directory, transaction, &receipt)?;
    cleanup_committed_transaction(transaction)?;
    if has_restore {
        let mut restore = read_restore_journal(&restore_path)?;
        let root = validate_restore_journal(
            workspace_directory,
            transaction,
            &restore,
            &receipt,
            !receipt.restored && !restore.actions.is_empty(),
        )?;
        if receipt.restored {
            cleanup_restore_transaction(transaction, true)?;
        } else if restore.actions.is_empty() {
            cleanup_restore_transaction(transaction, false)?;
        } else {
            let root =
                root.ok_or_else(|| "workspace restore transaction root is missing".to_string())?;
            rollback_restore_transaction(&root, transaction, &mut restore)?;
        }
    }
    Ok(())
}

fn recovery_workspace_hint(transaction: &Path) -> Option<String> {
    read_receipt(&transaction.join("receipt.json"))
        .ok()
        .map(|receipt| receipt.workspace)
        .or_else(|| {
            read_transaction_journal(&transaction.join("transaction.json"))
                .ok()
                .map(|journal| journal.workspace)
        })
        .or_else(|| {
            read_restore_journal(&transaction.join("restore.json"))
                .ok()
                .map(|journal| journal.workspace)
        })
}

fn workspace_recovery_issue(
    recovery_path: Option<&Path>,
    recovery_id: Option<String>,
    workspace: Option<String>,
    message: String,
) -> WorkspaceRecoveryIssue {
    WorkspaceRecoveryIssue {
        message,
        workspace,
        recovery_id,
        recovery_path: recovery_path.map(|path| path.to_string_lossy().into_owned()),
    }
}

fn transaction_recovery_issue(transaction: &Path, message: String) -> WorkspaceRecoveryIssue {
    workspace_recovery_issue(
        Some(transaction),
        transaction
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        recovery_workspace_hint(transaction),
        message,
    )
}

fn recover_workspace_change_transactions_at(
    recovery_base: &Path,
) -> Result<(), WorkspaceRecoveryIssue> {
    match std::fs::symlink_metadata(recovery_base) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(workspace_recovery_issue(
                Some(recovery_base),
                None,
                None,
                "workspace transaction root is invalid".into(),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(workspace_recovery_issue(
                Some(recovery_base),
                None,
                None,
                format!("failed to inspect workspace transaction root: {error}"),
            ))
        }
    }
    let mut workspace_directories = std::fs::read_dir(recovery_base)
        .map_err(|error| {
            workspace_recovery_issue(
                Some(recovery_base),
                None,
                None,
                format!("failed to scan workspace transactions: {error}"),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            workspace_recovery_issue(
                Some(recovery_base),
                None,
                None,
                format!("failed to scan workspace transaction entry: {error}"),
            )
        })?;
    workspace_directories.sort_by_key(|entry| entry.file_name());
    let mut transaction_count = 0usize;
    for workspace_directory in workspace_directories {
        let workspace_path = workspace_directory.path();
        if !workspace_directory
            .file_type()
            .map_err(|error| {
                workspace_recovery_issue(
                    Some(&workspace_path),
                    None,
                    None,
                    format!("failed to inspect workspace transaction group: {error}"),
                )
            })?
            .is_dir()
        {
            return Err(workspace_recovery_issue(
                Some(&workspace_path),
                None,
                None,
                "workspace transaction root contains an invalid entry".into(),
            ));
        }
        let mut transactions = std::fs::read_dir(&workspace_path)
            .map_err(|error| {
                workspace_recovery_issue(
                    Some(&workspace_path),
                    None,
                    None,
                    format!("failed to scan workspace transaction group: {error}"),
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                workspace_recovery_issue(
                    Some(&workspace_path),
                    None,
                    None,
                    format!("failed to scan workspace transaction: {error}"),
                )
            })?;
        transactions.sort_by_key(|entry| entry.file_name());
        for transaction_entry in transactions {
            let transaction = transaction_entry.path();
            let transaction_name = transaction_entry.file_name();
            let is_initializing = transaction_name
                .to_str()
                .map(|name| name.starts_with(".initializing-"))
                .unwrap_or(false);
            transaction_count += 1;
            if transaction_count > 1024 {
                return Err(transaction_recovery_issue(
                    &transaction,
                    "workspace transaction recovery exceeds safety limit".into(),
                ));
            }
            if !transaction_entry
                .file_type()
                .map_err(|error| {
                    transaction_recovery_issue(
                        &transaction,
                        format!("failed to inspect workspace transaction: {error}"),
                    )
                })?
                .is_dir()
            {
                return Err(transaction_recovery_issue(
                    &transaction,
                    "workspace transaction group contains an invalid entry".into(),
                ));
            }
            recover_workspace_change_transaction(&workspace_path, &transaction, is_initializing)
                .map_err(|error| transaction_recovery_issue(&transaction, error))?;
        }
    }
    Ok(())
}

fn recovery_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::storage_paths::axiom_data_root(app)?.join("workspace-changes"))
}

fn attempt_workspace_recovery(app: &tauri::AppHandle) -> Option<WorkspaceRecoveryIssue> {
    match recovery_base(app) {
        Ok(recovery_base) => recover_workspace_change_transactions_at(&recovery_base).err(),
        Err(error) => Some(workspace_recovery_issue(None, None, None, error)),
    }
}

pub(crate) fn initialize_workspace_recovery(app: &tauri::AppHandle) -> Result<(), String> {
    let issue = attempt_workspace_recovery(app);
    let recovery_state = app.state::<WorkspaceRecoveryState>();
    *recovery_state
        .issue
        .lock()
        .map_err(|_| "workspace recovery state lock is poisoned".to_string())? = issue.clone();
    set_workspace_recovery_blocked(&app.state::<WorkspaceAccessState>(), issue.is_some());
    Ok(())
}

#[tauri::command]
pub(crate) fn get_workspace_recovery_issue(
    state: tauri::State<'_, WorkspaceRecoveryState>,
) -> Result<Option<WorkspaceRecoveryIssue>, String> {
    state
        .issue
        .lock()
        .map_err(|_| "workspace recovery state lock is poisoned".to_string())
        .map(|issue| issue.clone())
}

#[tauri::command]
pub(crate) async fn retry_workspace_recovery(
    app: tauri::AppHandle,
) -> Result<Option<WorkspaceRecoveryIssue>, String> {
    // 恢复扫描必须独占恢复门（写锁）：等待全部工作区的在途写结束、并阻止新写
    // 开始，才能把恢复目录视为静止态扫描。与写路径的 per-workspace 并行不同，
    // 恢复天生是全局操作（扫描所有工作区指纹目录）；等待 + 目录扫描整体进
    // blocking 线程池，不占主线程/tokio worker。
    tauri::async_runtime::spawn_blocking(move || {
        let workspace_state = app.state::<WorkspaceAccessState>();
        let _recovery_gate = workspace_state
            .recovery_gate
            .write()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let issue = attempt_workspace_recovery(&app);
        let recovery_state = app.state::<WorkspaceRecoveryState>();
        *recovery_state
            .issue
            .lock()
            .map_err(|_| "workspace recovery state lock is poisoned".to_string())? = issue.clone();
        set_workspace_recovery_blocked(&workspace_state, issue.is_some());
        Ok(issue)
    })
    .await
    .map_err(|error| format!("workspace recovery task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn apply_workspace_changes(
    app: tauri::AppHandle,
    approval_lease: String,
    request: WorkspaceChangeRequest,
    workspace_path: Option<String>,
) -> Result<WorkspaceChangeResult, String> {
    // 多操作事务（journal 写入 + fsync + 逐文件备份 + 原子写）是写路径里最重的
    // 阻塞 I/O，且要等 per-workspace 写锁与恢复门——整体进 blocking 线程池。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let approval_state = app.state::<WorkspaceApprovalState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let write_lock = state.workspace_write_lock(&root);
        let _write_lock = write_lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        approval_state.consume(
            &approval_lease,
            "apply_workspace_changes",
            serde_json::json!({ "operations": &request.operations }),
            state.generation_for(&root),
            workspace_path.as_deref(),
        )?;
        let app_data = crate::storage_paths::axiom_data_root(&app)
            .map_err(|error| format!("failed to resolve workspace audit storage: {error}"))?;
        apply_impl(&root, &recovery_base(&app)?, &app_data, request)
    })
    .await
    .map_err(|error| format!("workspace apply task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn restore_workspace_trash(
    app: tauri::AppHandle,
    approval_lease: String,
    recovery_id: String,
    workspace_path: Option<String>,
) -> Result<WorkspaceChangeResult, String> {
    // 同 apply_workspace_changes：恢复事务的文件搬移整体进 blocking 线程池。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let approval_state = app.state::<WorkspaceApprovalState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let write_lock = state.workspace_write_lock(&root);
        let _write_lock = write_lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        approval_state.consume(
            &approval_lease,
            "restore_workspace_trash",
            serde_json::json!({ "recoveryId": recovery_id }),
            state.generation_for(&root),
            workspace_path.as_deref(),
        )?;
        restore_impl(&root, &recovery_base(&app)?, &recovery_id)
    })
    .await
    .map_err(|error| format!("workspace restore task failed: {error}"))?
}

#[cfg(test)]
#[path = "workspace_changes_tests.rs"]
mod tests;
