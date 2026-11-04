//! 项目文档的版本存储：文档页保存前的旧内容留档，支持回滚。
//!
//! 为什么需要它：文档页的保存是**整文件覆盖**（CAS 校验后原子替换），没有撤销。
//! 而 `.specs/tasks/` 与 `.plans/` 被 `.gitignore` 排除——一次误保存在那里
//! **没有任何恢复途径**（git 不管、回收站只有删除才进）。Agent 的 `write`/`edit`
//! 走同一形状的覆盖写，同样不可回滚；本模块给文档页补上这一层。
//!
//! 与 `design_history.rs` 的关系：两者是同一形状的两个领域（设计稿版本 vs 项目
//! 文档版本），但**刻意不共用**——设计稿历史带 `.ax` 扩展名、页数统计与 git 导入，
//! 项目文档是 `.md` 且无 git 侧历史；共用会把设计稿专属语义带进通用路径。
//!
//! 存储布局：`~/.axiom/document-history/<路径摘要>/<内容 sha256>.md`。
//! 内容寻址——同一份内容只存一次；回滚时按 sha 取回并校验完整性。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// 单份文档保留的历史版本数上限——超出的按时间淘汰最旧的。
const MAX_VERSIONS: usize = 20;
/// 单份历史版本的大小上限（与文档保存通道的 1 MiB 上限一致）。
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentVersion {
    pub(crate) sha256: String,
    size_bytes: u64,
    modified_ms: u64,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// 某份文档的历史目录：工作区根 + 相对路径的摘要——不同工作区的同名文档互不串扰。
pub(crate) fn directory(data_root: &Path, workspace: &Path, relative: &Path) -> PathBuf {
    let identity = serde_json::json!([workspace.to_string_lossy(), relative.to_string_lossy(),]);
    let digest = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
    data_root.join("document-history").join(digest)
}

fn validate_directory(directory: &Path) -> Result<(), String> {
    for candidate in [Some(directory), directory.parent()].into_iter().flatten() {
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("document history directory must not be a symbolic link".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to inspect document history: {error}")),
        }
    }
    Ok(())
}

/// 读回一份历史版本；内容与 sha 不符即拒绝（历史目录被篡改时不得当成可信版本）。
pub(crate) fn read(directory: &Path, sha256: &str) -> Result<Vec<u8>, String> {
    validate_directory(directory)?;
    if !valid_hash(sha256) {
        return Err("invalid document version identifier".into());
    }
    let file = directory.join(format!("{sha256}.md"));
    let metadata = std::fs::symlink_metadata(&file)
        .map_err(|error| format!("failed to inspect document version: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("document version is not a regular file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&file)
        .map_err(|error| format!("failed to open document version: {error}"))?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read document version: {error}"))?;
    if bytes.len() as u64 > MAX_BYTES || format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err("document version integrity check failed".into());
    }
    Ok(bytes)
}

/// 列出历史版本（新→旧）。
pub(crate) fn list(directory: &Path) -> Result<Vec<DocumentVersion>, String> {
    validate_directory(directory)?;
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to list document versions: {error}")),
    };
    let mut versions = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to inspect document version: {error}"))?;
        let path = entry.path();
        let Some(hash) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if path.extension().and_then(|value| value.to_str()) != Some("md") || !valid_hash(hash) {
            continue;
        }
        let bytes = read(directory, hash)?;
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map_err(|error| format!("failed to inspect document version time: {error}"))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "invalid document version time".to_string())?
            .as_millis() as u64;
        versions.push(DocumentVersion {
            sha256: hash.into(),
            size_bytes: bytes.len() as u64,
            modified_ms: modified,
        });
    }
    versions.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| left.sha256.cmp(&right.sha256))
    });
    Ok(versions)
}

/// 记入一份历史版本，返回其内容 sha256（同一内容重复记入只更新时间）。
pub(crate) fn record(directory: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("document version exceeds 1 MiB".into());
    }
    validate_directory(directory)?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("failed to create document history: {error}"))?;
    crate::storage_paths::set_directory_permissions(directory)?;
    if let Some(parent) = directory.parent() {
        crate::storage_paths::set_directory_permissions(parent)?;
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    let target = directory.join(format!("{hash}.md"));
    if target.exists() {
        read(directory, &hash)?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .map_err(|error| format!("failed to open document version: {error}"))?;
        file.set_modified(std::time::SystemTime::now())
            .map_err(|error| format!("failed to update document version time: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync document version time: {error}"))?;
        prune(directory)?;
        return Ok(hash);
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("failed to create document version: {error}"))?;
    crate::storage_paths::secure_owner_only_file(
        temporary.as_file(),
        "document version permissions",
    )?;
    temporary
        .write_all(bytes)
        .map_err(|error| format!("failed to write document version: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync document version: {error}"))?;
    temporary
        .persist(&target)
        .map_err(|error| format!("failed to persist document version: {}", error.error))?;
    crate::storage_paths::sync_directory(directory)
        .map_err(|error| format!("failed to sync document history: {error}"))?;
    prune(directory)?;
    Ok(hash)
}

/// 淘汰超出上限的最旧版本。
fn prune(directory: &Path) -> Result<(), String> {
    let versions = list(directory)?;
    if versions.len() <= MAX_VERSIONS {
        return Ok(());
    }
    for version in versions.iter().skip(MAX_VERSIONS) {
        let path = directory.join(format!("{}.md", version.sha256));
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to prune document version: {error}")),
        }
    }
    crate::storage_paths::sync_directory(directory)
        .map_err(|error| format!("failed to sync document history: {error}"))
}

/// 历史目录的来源标记文件名。目录名是 (工作区, 相对路径) 的摘要——不可逆，
/// 因此清理孤儿目录时必须靠这份标记才知道它属于谁。
const SOURCE_FILE: &str = "source.json";

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentSource {
    workspace: String,
    relative: String,
}

/// 记下这个历史目录属于哪份文档（幂等；已存在则原样保留）。
///
/// 为什么不把它塞进 `record`：`record` 只关心内容寻址，来源是清理用的元数据，
/// 两者生命周期不同（内容会裁剪，来源不会）。
pub(crate) fn remember_source(
    directory: &Path,
    workspace: &Path,
    relative: &Path,
) -> Result<(), String> {
    validate_directory(directory)?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("failed to create document history: {error}"))?;
    crate::storage_paths::set_directory_permissions(directory)?;
    let file = directory.join(SOURCE_FILE);
    if file.exists() {
        return Ok(());
    }
    let payload = serde_json::to_vec(&DocumentSource {
        workspace: workspace.to_string_lossy().into(),
        relative: relative.to_string_lossy().into(),
    })
    .map_err(|error| format!("failed to encode document source: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("failed to create document source: {error}"))?;
    crate::storage_paths::secure_owner_only_file(
        temporary.as_file(),
        "document source permissions",
    )?;
    temporary
        .write_all(&payload)
        .map_err(|error| format!("failed to write document source: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync document source: {error}"))?;
    temporary
        .persist(&file)
        .map_err(|error| format!("failed to persist document source: {}", error.error))?;
    crate::storage_paths::sync_directory(directory)
        .map_err(|error| format!("failed to sync document history: {error}"))
}

fn read_source(directory: &Path) -> Option<DocumentSource> {
    let bytes = std::fs::read(directory.join(SOURCE_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 清理孤儿历史目录：**只**处理满足全部条件的目录——
/// ① 属于 `workspace`（当前已授权的工作区，其他工作区一概不碰：授权是 per-process
///    的，重启后未授权不等于文档已被删除）；
/// ② 记录的相对路径在盘上已不存在（删除或改名）；
/// ③ 目录空闲时间超过 `retention`（改名后短期改回来还能拿回历史）。
///
/// 没有来源标记的目录一律跳过（来源未知就不该被自动删除）。
pub(crate) fn prune_orphans(
    data_root: &Path,
    workspace: &Path,
    retention: std::time::Duration,
) -> Result<usize, String> {
    let root = data_root.join("document-history");
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("failed to list document history: {error}")),
    };
    let workspace_label = workspace.to_string_lossy();
    let mut removed = 0;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to inspect document history: {error}"))?;
        let directory = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to inspect document history: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Some(source) = read_source(&directory) else {
            continue;
        };
        if source.workspace != workspace_label {
            continue;
        }
        if workspace.join(&source.relative).exists() {
            continue;
        }
        let idle = metadata
            .modified()
            .ok()
            .and_then(|time| time.elapsed().ok())
            .unwrap_or_default();
        if idle < retention {
            continue;
        }
        match std::fs::remove_dir_all(&directory) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to prune document history: {error}")),
        }
    }
    if removed > 0 {
        crate::storage_paths::sync_directory(&root)
            .map_err(|error| format!("failed to sync document history: {error}"))?;
    }
    Ok(removed)
}
