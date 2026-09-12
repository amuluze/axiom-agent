use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

pub(crate) const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;
const HASH_LENGTH: usize = 64;
const UNREFERENCED_ARTIFACT_GRACE: Duration = Duration::from_secs(5 * 60);
const TRASH_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ArtifactKind {
    Text,
    Json,
    Image,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactRequest {
    content: String,
    encoding: String,
    kind: ArtifactKind,
    media_type: String,
    created_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactRequest {
    content_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashArtifactsRequest {
    content_hashes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileArtifactsRequest {
    referenced_hashes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMetadata {
    pub(crate) id: String,
    kind: ArtifactKind,
    pub(crate) media_type: String,
    pub(crate) relative_path: String,
    pub(crate) content_hash: String,
    pub(crate) size_bytes: u64,
    pub(crate) created_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    content_base64: String,
    content_hash: String,
    size_bytes: u64,
    recovered_from_trash: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReconcileResult {
    pub(crate) restored: usize,
    pub(crate) trashed: usize,
    pub(crate) purged: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactStorageStats {
    pub(crate) active_count: usize,
    pub(crate) active_bytes: u64,
    pub(crate) trash_count: usize,
    pub(crate) trash_bytes: u64,
}

/// 归档清理（GC）结果：reconcile 明细 + 清理前后活跃存储字节数（用于设置页展示释放量）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactGcResult {
    pub(crate) reconciled: ArtifactReconcileResult,
    pub(crate) active_bytes_before: u64,
    pub(crate) active_bytes_after: u64,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(HASH_LENGTH);
    for byte in digest {
        write!(&mut result, "{byte:02x}").expect("writing to String cannot fail");
    }
    result
}

fn validate_hash(content_hash: &str) -> Result<(), String> {
    if content_hash.len() != HASH_LENGTH
        || !content_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Artifact 哈希格式无效".to_string());
    }
    Ok(())
}

fn validate_media(kind: ArtifactKind, media_type: &str, bytes: &[u8]) -> Result<(), String> {
    if media_type.is_empty()
        || media_type.len() > 100
        || !media_type
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'"')
    {
        return Err("Artifact media type 无效".to_string());
    }
    match kind {
        ArtifactKind::Text => {
            if !media_type.starts_with("text/") || std::str::from_utf8(bytes).is_err() {
                return Err("文本 Artifact 必须是有效 UTF-8".to_string());
            }
        }
        ArtifactKind::Json => {
            if media_type != "application/json" {
                return Err("JSON Artifact 的 media type 无效".to_string());
            }
            serde_json::from_slice::<serde_json::Value>(bytes)
                .map_err(|_| "JSON Artifact 内容无效".to_string())?;
        }
        ArtifactKind::Image => {
            let valid = match media_type {
                "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
                "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
                "image/webp" => {
                    bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
                }
                _ => false,
            };
            if !valid {
                return Err("仅允许经过格式校验的 PNG、JPEG、GIF 或 WebP Artifact".to_string());
            }
        }
    }
    Ok(())
}

fn artifact_root(app_data: &Path) -> PathBuf {
    app_data.join("artifacts")
}

fn live_path(app_data: &Path, content_hash: &str) -> PathBuf {
    artifact_root(app_data)
        .join("sha256")
        .join(&content_hash[..2])
        .join(content_hash)
}

fn trash_path(app_data: &Path, content_hash: &str) -> PathBuf {
    artifact_root(app_data).join(".trash").join(content_hash)
}

fn relative_path(content_hash: &str) -> String {
    format!("artifacts/sha256/{}/{}", &content_hash[..2], content_hash)
}

fn ensure_managed_directory(app_data: &Path, directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| format!("创建 Artifact 目录失败：{error}"))?;
    let app_data =
        fs::canonicalize(app_data).map_err(|error| format!("校验 App Data 目录失败：{error}"))?;
    let root = fs::canonicalize(artifact_root(&app_data))
        .map_err(|error| format!("校验 Artifact 根目录失败：{error}"))?;
    let directory =
        fs::canonicalize(directory).map_err(|error| format!("校验 Artifact 目录失败：{error}"))?;
    if !root.starts_with(&app_data) || !directory.starts_with(&root) {
        return Err("Artifact 目录越过 App Data 安全边界".to_string());
    }
    Ok(())
}

fn read_verified(app_data: &Path, path: &Path, content_hash: &str) -> Result<Vec<u8>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("Artifact 文件不可用：{error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Artifact 路径不是普通文件".to_string());
    }
    let app_data =
        fs::canonicalize(app_data).map_err(|error| format!("校验 App Data 目录失败：{error}"))?;
    let root = fs::canonicalize(artifact_root(&app_data))
        .map_err(|error| format!("校验 Artifact 根目录失败：{error}"))?;
    if !root.starts_with(&app_data) {
        return Err("Artifact 根目录越过 App Data 安全边界".to_string());
    }
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("校验 Artifact 路径失败：{error}"))?;
    if !canonical.starts_with(root) {
        return Err("Artifact 文件越过 App Data 安全边界".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 Artifact 失败：{error}"))?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err("Artifact 超过 8 MiB 安全上限".to_string());
    }
    if sha256_hex(&bytes) != content_hash {
        return Err("Artifact SHA-256 校验失败，文件可能已损坏".to_string());
    }
    Ok(bytes)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("同步 Artifact 目录失败：{error}"))
}

fn write_artifact_at(
    app_data: &Path,
    request: WriteArtifactRequest,
) -> Result<ArtifactMetadata, String> {
    let bytes = match request.encoding.as_str() {
        "utf8" => request.content.into_bytes(),
        "base64" => BASE64
            .decode(request.content)
            .map_err(|_| "Artifact Base64 内容无效".to_string())?,
        _ => return Err("Artifact 编码无效".to_string()),
    };
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err("Artifact 超过 8 MiB 安全上限".to_string());
    }
    validate_media(request.kind, &request.media_type, &bytes)?;

    let content_hash = sha256_hex(&bytes);
    let target = live_path(app_data, &content_hash);
    let parent = target
        .parent()
        .ok_or_else(|| "Artifact 目标目录无效".to_string())?;
    ensure_managed_directory(app_data, parent)?;

    if target.exists() {
        read_verified(app_data, &target, &content_hash)?;
    } else {
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("创建 Artifact 临时文件失败：{error}"))?;
        temporary
            .write_all(&bytes)
            .and_then(|()| temporary.as_file().sync_all())
            .map_err(|error| format!("写入 Artifact 失败：{error}"))?;
        match temporary.persist_noclobber(&target) {
            Ok(_) => sync_directory(parent)?,
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                read_verified(app_data, &target, &content_hash)?;
            }
            Err(error) => return Err(format!("提交 Artifact 原子写入失败：{}", error.error)),
        }
    }

    Ok(ArtifactMetadata {
        id: format!("sha256:{content_hash}"),
        kind: request.kind,
        media_type: request.media_type,
        relative_path: relative_path(&content_hash),
        content_hash,
        size_bytes: bytes.len() as u64,
        created_at: request.created_at,
    })
}

pub(crate) fn write_text_artifact_at(
    app_data: &Path,
    content: String,
    created_at: u64,
) -> Result<ArtifactMetadata, String> {
    write_artifact_at(
        app_data,
        WriteArtifactRequest {
            content,
            encoding: "utf8".to_string(),
            kind: ArtifactKind::Text,
            media_type: "text/plain;charset=utf-8".to_string(),
            created_at,
        },
    )
}

fn verify_artifact_reference_at(
    app_data: &Path,
    content_hash: &str,
    expected_size: u64,
    kind: &str,
    media_type: &str,
) -> Result<(), String> {
    let kind = match kind {
        "text" => ArtifactKind::Text,
        "json" => ArtifactKind::Json,
        "image" => ArtifactKind::Image,
        _ => return Err("Artifact 类型无效".to_string()),
    };
    restore_from_trash(app_data, content_hash)?;
    let bytes = read_verified(app_data, &live_path(app_data, content_hash), content_hash)?;
    if bytes.len() as u64 != expected_size {
        return Err("Artifact 文件大小与消息元数据不一致".to_string());
    }
    validate_media(kind, media_type, &bytes)?;
    Ok(())
}

fn restore_from_trash(app_data: &Path, content_hash: &str) -> Result<bool, String> {
    let live = live_path(app_data, content_hash);
    if live.exists() {
        return Ok(false);
    }
    let trash = trash_path(app_data, content_hash);
    if !trash.exists() {
        return Ok(false);
    }
    read_verified(app_data, &trash, content_hash)?;
    let trash_root = trash
        .parent()
        .ok_or_else(|| "Artifact 回收目录无效".to_string())?;
    let parent = live
        .parent()
        .ok_or_else(|| "Artifact 目标目录无效".to_string())?;
    ensure_managed_directory(app_data, parent)?;
    fs::rename(&trash, &live).map_err(|error| format!("从回收区恢复 Artifact 失败：{error}"))?;
    sync_directory(parent)?;
    sync_directory(trash_root)?;
    Ok(true)
}

fn read_artifact_at(app_data: &Path, content_hash: &str) -> Result<ArtifactContent, String> {
    validate_hash(content_hash)?;
    let recovered_from_trash = restore_from_trash(app_data, content_hash)?;
    let bytes = read_verified(app_data, &live_path(app_data, content_hash), content_hash)?;
    Ok(ArtifactContent {
        content_base64: BASE64.encode(&bytes),
        content_hash: content_hash.to_string(),
        size_bytes: bytes.len() as u64,
        recovered_from_trash,
    })
}

fn move_to_trash(app_data: &Path, content_hash: &str) -> Result<bool, String> {
    validate_hash(content_hash)?;
    let live = live_path(app_data, content_hash);
    if !live.exists() {
        return Ok(false);
    }
    read_verified(app_data, &live, content_hash)?;
    let live_parent = live
        .parent()
        .ok_or_else(|| "Artifact 目标目录无效".to_string())?;
    let trash = trash_path(app_data, content_hash);
    let trash_root = trash
        .parent()
        .ok_or_else(|| "Artifact 回收目录无效".to_string())?;
    ensure_managed_directory(app_data, trash_root)?;
    if trash.exists() {
        read_verified(app_data, &trash, content_hash)?;
        fs::remove_file(&live).map_err(|error| format!("移除重复 Artifact 失败：{error}"))?;
    } else {
        fs::rename(&live, &trash).map_err(|error| format!("回收 Artifact 失败：{error}"))?;
        File::options()
            .write(true)
            .open(&trash)
            .and_then(|file| file.set_times(fs::FileTimes::new().set_modified(SystemTime::now())))
            .map_err(|error| format!("记录 Artifact 回收时间失败：{error}"))?;
    }
    sync_directory(trash_root)?;
    sync_directory(live_parent)?;
    Ok(true)
}

pub(crate) fn reconcile_at_time(
    app_data: &Path,
    referenced_hashes: Vec<String>,
    now: SystemTime,
) -> Result<ArtifactReconcileResult, String> {
    let mut referenced = referenced_hashes
        .into_iter()
        .map(|content_hash| {
            validate_hash(&content_hash)?;
            Ok(content_hash)
        })
        .collect::<Result<HashSet<_>, String>>()?;
    for content_hash in crate::workspace_changes::audit_artifact_hashes(app_data)? {
        validate_hash(&content_hash)?;
        referenced.insert(content_hash);
    }

    let mut restored = 0;
    for content_hash in &referenced {
        if restore_from_trash(app_data, content_hash)? {
            restored += 1;
        }
        read_verified(app_data, &live_path(app_data, content_hash), content_hash)?;
    }

    let mut trashed = 0;
    let live_root = artifact_root(app_data).join("sha256");
    if live_root.exists() {
        for prefix in
            fs::read_dir(&live_root).map_err(|error| format!("扫描 Artifact 目录失败：{error}"))?
        {
            let prefix = prefix.map_err(|error| format!("扫描 Artifact 目录失败：{error}"))?;
            if !prefix
                .file_type()
                .map_err(|error| format!("读取 Artifact 类型失败：{error}"))?
                .is_dir()
            {
                continue;
            }
            for entry in fs::read_dir(prefix.path())
                .map_err(|error| format!("扫描 Artifact 分片失败：{error}"))?
            {
                let entry = entry.map_err(|error| format!("扫描 Artifact 分片失败：{error}"))?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if validate_hash(&name).is_ok() && !referenced.contains(&name) {
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .map_err(|error| format!("读取 Artifact 写入时间失败：{error}"))?;
                    let old_enough = now
                        .duration_since(modified)
                        .is_ok_and(|elapsed| elapsed >= UNREFERENCED_ARTIFACT_GRACE);
                    if old_enough && move_to_trash(app_data, &name)? {
                        trashed += 1;
                    }
                }
            }
        }
    }
    let purged = purge_trash_at(app_data, now)?;
    Ok(ArtifactReconcileResult {
        restored,
        trashed,
        purged,
    })
}

pub(crate) fn reconcile_at(
    app_data: &Path,
    referenced_hashes: Vec<String>,
) -> Result<ArtifactReconcileResult, String> {
    reconcile_at_time(app_data, referenced_hashes, SystemTime::now())
}

fn purge_trash_at(app_data: &Path, now: SystemTime) -> Result<usize, String> {
    let trash_root = artifact_root(app_data).join(".trash");
    if !trash_root.exists() {
        return Ok(0);
    }
    ensure_managed_directory(app_data, &trash_root)?;
    let mut purged = 0;
    for entry in
        fs::read_dir(&trash_root).map_err(|error| format!("扫描 Artifact 回收区失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("扫描 Artifact 回收区失败：{error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if validate_hash(&name).is_err() {
            continue;
        }
        if !entry
            .file_type()
            .map_err(|error| format!("读取 Artifact 回收类型失败：{error}"))?
            .is_file()
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("读取 Artifact 回收时间失败：{error}"))?;
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata
            .modified()
            .map_err(|error| format!("读取 Artifact 回收时间失败：{error}"))?;
        let expired = now
            .duration_since(modified)
            .map(|elapsed| elapsed >= TRASH_RETENTION)
            .unwrap_or(false);
        if expired {
            fs::remove_file(entry.path())
                .map_err(|error| format!("清理过期 Artifact 失败：{error}"))?;
            purged += 1;
        }
    }
    if purged > 0 {
        sync_directory(&trash_root)?;
    }
    Ok(purged)
}

fn add_managed_file(stats: &mut (usize, u64), entry: fs::DirEntry) -> Result<(), String> {
    let name = entry.file_name().to_string_lossy().into_owned();
    if validate_hash(&name).is_err()
        || !entry
            .file_type()
            .map_err(|error| format!("读取 Artifact 文件类型失败：{error}"))?
            .is_file()
    {
        return Ok(());
    }
    let bytes = entry
        .metadata()
        .map_err(|error| format!("读取 Artifact 文件大小失败：{error}"))?
        .len();
    stats.0 += 1;
    stats.1 = stats.1.saturating_add(bytes);
    Ok(())
}

pub(crate) fn storage_stats_at(app_data: &Path) -> Result<ArtifactStorageStats, String> {
    let mut active = (0, 0);
    let live_root = artifact_root(app_data).join("sha256");
    if live_root.exists() {
        for prefix in
            fs::read_dir(&live_root).map_err(|error| format!("扫描 Artifact 目录失败：{error}"))?
        {
            let prefix = prefix.map_err(|error| format!("扫描 Artifact 目录失败：{error}"))?;
            if !prefix
                .file_type()
                .map_err(|error| format!("读取 Artifact 分片类型失败：{error}"))?
                .is_dir()
            {
                continue;
            }
            for entry in fs::read_dir(prefix.path())
                .map_err(|error| format!("扫描 Artifact 分片失败：{error}"))?
            {
                add_managed_file(
                    &mut active,
                    entry.map_err(|error| format!("扫描 Artifact 分片失败：{error}"))?,
                )?;
            }
        }
    }

    let mut trash = (0, 0);
    let trash_root = artifact_root(app_data).join(".trash");
    if trash_root.exists() {
        for entry in fs::read_dir(&trash_root)
            .map_err(|error| format!("扫描 Artifact 回收区失败：{error}"))?
        {
            add_managed_file(
                &mut trash,
                entry.map_err(|error| format!("扫描 Artifact 回收区失败：{error}"))?,
            )?;
        }
    }
    Ok(ArtifactStorageStats {
        active_count: active.0,
        active_bytes: active.1,
        trash_count: trash.0,
        trash_bytes: trash.1,
    })
}

/// Artifact 存储根的数据根解析（`~/.axiom/`，见 `storage_paths.rs`）。
pub(crate) fn axiom_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage_paths::axiom_data_root(app)
}

pub(crate) async fn verify_artifact_reference(
    app: AppHandle,
    content_hash: String,
    expected_size: u64,
    kind: String,
    media_type: String,
) -> Result<(), String> {
    let root = axiom_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        verify_artifact_reference_at(&root, &content_hash, expected_size, &kind, &media_type)
    })
    .await
    .map_err(|error| format!("Artifact 校验任务失败：{error}"))?
}

#[tauri::command]
pub async fn write_artifact(
    app: AppHandle,
    request: WriteArtifactRequest,
) -> Result<ArtifactMetadata, String> {
    let root = axiom_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_artifact_at(&root, request))
        .await
        .map_err(|error| format!("Artifact 写入任务失败：{error}"))?
}

#[tauri::command]
pub async fn read_artifact(
    app: AppHandle,
    request: ReadArtifactRequest,
) -> Result<ArtifactContent, String> {
    let root = axiom_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_artifact_at(&root, &request.content_hash))
        .await
        .map_err(|error| format!("Artifact 读取任务失败：{error}"))?
}

#[tauri::command]
pub async fn trash_artifacts(
    app: AppHandle,
    request: TrashArtifactsRequest,
) -> Result<usize, String> {
    let root = axiom_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut count = 0;
        for content_hash in request.content_hashes {
            if move_to_trash(&root, &content_hash)? {
                count += 1;
            }
        }
        Ok(count)
    })
    .await
    .map_err(|error| format!("Artifact 回收任务失败：{error}"))?
}

#[tauri::command]
pub async fn reconcile_artifacts(
    app: AppHandle,
    request: ReconcileArtifactsRequest,
) -> Result<ArtifactReconcileResult, String> {
    let root = axiom_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || reconcile_at(&root, request.referenced_hashes))
        .await
        .map_err(|error| format!("Artifact 恢复任务失败：{error}"))?
}

#[tauri::command]
pub async fn get_artifact_storage_stats(app: AppHandle) -> Result<ArtifactStorageStats, String> {
    let root = axiom_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || storage_stats_at(&root))
        .await
        .map_err(|error| format!("Artifact 统计任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_request(content: &str) -> WriteArtifactRequest {
        WriteArtifactRequest {
            content: content.to_string(),
            encoding: "utf8".to_string(),
            kind: ArtifactKind::Text,
            media_type: "text/plain;charset=utf-8".to_string(),
            created_at: 1,
        }
    }

    #[test]
    fn writes_deduplicates_verifies_and_recovers_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let first = write_artifact_at(directory.path(), text_request("complete output")).unwrap();
        let second = write_artifact_at(directory.path(), text_request("complete output")).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(
            read_artifact_at(directory.path(), &first.content_hash)
                .unwrap()
                .size_bytes,
            15
        );

        assert!(move_to_trash(directory.path(), &first.content_hash).unwrap());
        let stats = storage_stats_at(directory.path()).unwrap();
        assert_eq!(stats.active_count, 0);
        assert_eq!(stats.trash_count, 1);
        assert_eq!(stats.trash_bytes, 15);
        let restored = read_artifact_at(directory.path(), &first.content_hash).unwrap();
        assert!(restored.recovered_from_trash);
    }

    #[test]
    fn verifies_message_artifact_metadata_against_the_durable_file() {
        let directory = tempfile::tempdir().unwrap();
        let artifact =
            write_artifact_at(directory.path(), text_request("verified output")).unwrap();

        assert!(move_to_trash(directory.path(), &artifact.content_hash).unwrap());

        verify_artifact_reference_at(
            directory.path(),
            &artifact.content_hash,
            artifact.size_bytes,
            "text",
            &artifact.media_type,
        )
        .unwrap();
        assert!(live_path(directory.path(), &artifact.content_hash).exists());
        assert!(!trash_path(directory.path(), &artifact.content_hash).exists());
        assert!(verify_artifact_reference_at(
            directory.path(),
            &artifact.content_hash,
            artifact.size_bytes + 1,
            "text",
            &artifact.media_type,
        )
        .unwrap_err()
        .contains("大小"));
        assert!(verify_artifact_reference_at(
            directory.path(),
            &artifact.content_hash,
            artifact.size_bytes,
            "json",
            "application/json",
        )
        .is_err());
    }

    #[test]
    fn rejects_tampered_and_active_content_images() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = write_artifact_at(directory.path(), text_request("trusted")).unwrap();
        fs::write(
            live_path(directory.path(), &artifact.content_hash),
            "tampered",
        )
        .unwrap();
        assert!(read_artifact_at(directory.path(), &artifact.content_hash)
            .unwrap_err()
            .contains("SHA-256"));

        let svg = WriteArtifactRequest {
            content: BASE64.encode(b"<svg><script/></svg>"),
            encoding: "base64".to_string(),
            kind: ArtifactKind::Image,
            media_type: "image/svg+xml".to_string(),
            created_at: 1,
        };
        assert!(write_artifact_at(directory.path(), svg).is_err());
    }

    #[test]
    fn reconciliation_protects_fresh_writes_then_trashes_only_stale_unreferenced_content() {
        let directory = tempfile::tempdir().unwrap();
        let kept = write_artifact_at(directory.path(), text_request("kept")).unwrap();
        let orphan = write_artifact_at(directory.path(), text_request("orphan")).unwrap();
        let now = SystemTime::now();
        let fresh =
            reconcile_at_time(directory.path(), vec![kept.content_hash.clone()], now).unwrap();
        assert_eq!(fresh.trashed, 0);
        assert!(live_path(directory.path(), &orphan.content_hash).exists());

        let result = reconcile_at_time(
            directory.path(),
            vec![kept.content_hash.clone()],
            now + UNREFERENCED_ARTIFACT_GRACE + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(result.trashed, 1);
        assert_eq!(result.purged, 0);
        assert!(live_path(directory.path(), &kept.content_hash).exists());
        assert!(trash_path(directory.path(), &orphan.content_hash).exists());
    }

    #[test]
    fn reconciliation_rejects_missing_or_tampered_referenced_content() {
        let directory = tempfile::tempdir().unwrap();
        let missing = "a".repeat(HASH_LENGTH);
        assert!(reconcile_at(directory.path(), vec![missing]).is_err());

        let artifact = write_artifact_at(directory.path(), text_request("trusted")).unwrap();
        fs::write(
            live_path(directory.path(), &artifact.content_hash),
            b"tampered",
        )
        .unwrap();
        assert!(reconcile_at(directory.path(), vec![artifact.content_hash]).is_err());
    }

    #[test]
    fn purges_only_after_the_recovery_window() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = write_artifact_at(directory.path(), text_request("expired")).unwrap();
        assert!(move_to_trash(directory.path(), &artifact.content_hash).unwrap());
        assert_eq!(
            purge_trash_at(directory.path(), SystemTime::now()).unwrap(),
            0
        );
        assert_eq!(
            purge_trash_at(
                directory.path(),
                SystemTime::now() + TRASH_RETENTION + Duration::from_secs(1),
            )
            .unwrap(),
            1
        );
        assert!(!trash_path(directory.path(), &artifact.content_hash).exists());
    }
}
