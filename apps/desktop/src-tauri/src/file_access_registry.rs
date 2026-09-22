//! 授权文件读取注册表（Rust 独占持久层）。
//!
//! 用户经原生选择器登记的文件/目录引用写入此注册表，启动时恢复进
//! `FileAccessState`——与授权工作区注册表（workspace_registry.rs）同一模型：
//! 注册表唯一写入方是原生手势（选择器登记 / 撤销移除），WebView 没有任何
//! 直接读写面，受陷渲染进程无法伪造条目。读取面免审批后（对齐 codex 全盘读，
//! 敏感 deny 由 sandbox::sensitive_read_denied 在读取时判定），本注册表不再
//! 承担安全职能，仅作为引用列表（@ 提及候选 / 提示词注入）的持久化。
//!
//! 并发约定：与 workspace_registry 相同，读-改-写由调用方串行化（文件授权
//! 命令均为单点操作，Rust 侧经 `FileAccessState` 内部锁 + 命令本身的串行
//! 语义保证；启动恢复在 setup 中先于任何命令执行）。
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

use crate::artifacts::axiom_data_root;
use crate::workspace_registry::reject_symlink;

const REGISTRY_FILE_NAME: &str = "authorized_files.json";
const REGISTRY_SCHEMA_VERSION: u32 = 1;
/// 条目上限：文件粒度授权数量天然多于工作区，放宽到 128（单条 ≤ 16 KiB）。
const MAX_REGISTRY_PATHS: usize = 128;
/// 注册表文件读取上限：128 条 × 16 KiB + 元数据，超限视为损坏（fail-closed）。
const MAX_REGISTRY_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    schema_version: u32,
    paths: Vec<PathBuf>,
}

/// 注册表文件路径：应用数据根（~/.axiom/），由 Rust 独占管理。
pub(crate) fn registry_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(axiom_data_root(app)?.join(REGISTRY_FILE_NAME))
}

/// 读取注册表全部路径。文件不存在视为空集；损坏/超限/版本不识别 fail-closed
/// 返回 Err（启动恢复对此 fail-soft 跳过并提示重新授权，见 restore_persistent_grants）。
pub(crate) fn registry_read(file: &Path) -> Result<HashSet<PathBuf>, String> {
    reject_symlink(file)?;
    let metadata = match fs::metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => return Err(format!("failed to read authorized files registry: {error}")),
    };
    if !metadata.is_file() {
        return Err(format!(
            "authorized files registry is not a regular file: {}",
            file.display()
        ));
    }
    if metadata.len() > MAX_REGISTRY_FILE_BYTES {
        return Err("authorized files registry exceeds the safe size limit".into());
    }
    let raw = fs::read_to_string(file)
        .map_err(|error| format!("failed to read authorized files registry: {error}"))?;
    let document: RegistryDocument = serde_json::from_str(&raw).map_err(|error| {
        format!("authorized files registry is corrupted: {error}")
    })?;
    if document.schema_version != REGISTRY_SCHEMA_VERSION {
        return Err(format!(
            "authorized files registry schema version {} is not supported (expected {REGISTRY_SCHEMA_VERSION})",
            document.schema_version
        ));
    }
    if document.paths.len() > MAX_REGISTRY_PATHS
        || document
            .paths
            .iter()
            .any(|path| path.as_os_str().len() > 16 * 1024)
    {
        return Err("authorized files registry exceeds the safe entry limits".into());
    }
    Ok(document.paths.into_iter().collect())
}

/// 原子写回：同目录临时文件 + persist，权限 0o600（与工作区注册表同标准）。
fn registry_write(file: &Path, paths: &HashSet<PathBuf>) -> Result<(), String> {
    let Some(parent) = file.parent() else {
        return Err("authorized files registry has no parent directory".into());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create registry directory: {error}"))?;
    reject_symlink(file)?;
    let mut ordered: Vec<&PathBuf> = paths.iter().collect();
    ordered.sort();
    let document = RegistryDocument {
        schema_version: REGISTRY_SCHEMA_VERSION,
        paths: ordered.into_iter().cloned().collect(),
    };
    let encoded = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("failed to encode authorized files registry: {error}"))?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to stage authorized files registry: {error}"))?;
    crate::storage_paths::secure_owner_only_file(
        temporary.as_file(),
        "failed to secure authorized files registry",
    )?;
    temporary
        .write_all(&encoded)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("failed to sync authorized files registry: {error}"))?;
    temporary.persist(file).map(|_| ()).map_err(|error| {
        format!(
            "failed to commit authorized files registry: {}",
            error.error
        )
    })
}

/// 登记一条持久引用（选择器登记）。写失败即返回 Err，
/// 调用方不得先于注册表完成内存登记。
pub(crate) fn registry_insert(file: &Path, path: &Path) -> Result<(), String> {
    let mut paths = registry_read(file)?;
    if paths.len() >= MAX_REGISTRY_PATHS && !paths.contains(path) {
        return Err("too many registered files; revoke one before authorizing another".into());
    }
    paths.insert(path.to_path_buf());
    registry_write(file, &paths)
}

/// 撤销引用时移除。必须在内存移除之前执行并成功：只要注册表仍含该路径，
/// 重启恢复就会重新登记它，移除不具持久效力。
pub(crate) fn registry_remove(file: &Path, path: &Path) -> Result<(), String> {
    let mut paths = registry_read(file)?;
    if paths.remove(path) {
        registry_write(file, &paths)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "axiom-file-registry-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::canonicalize(path).unwrap()
    }

    #[test]
    fn round_trips_insert_and_remove() {
        let directory = temporary_directory();
        let file = directory.join(REGISTRY_FILE_NAME);
        let entry = directory.join("notes.md");

        assert!(!registry_read(&file).unwrap().contains(&entry));
        registry_insert(&file, &entry).unwrap();
        assert!(registry_read(&file).unwrap().contains(&entry));
        // 重复 insert 幂等，不产生重复条目。
        registry_insert(&file, &entry).unwrap();
        assert_eq!(registry_read(&file).unwrap().len(), 1);

        registry_remove(&file, &entry).unwrap();
        assert!(!registry_read(&file).unwrap().contains(&entry));
        // 移除不存在的路径是幂等 no-op。
        registry_remove(&file, &entry).unwrap();

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn writes_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = temporary_directory();
        let file = directory.join(REGISTRY_FILE_NAME);
        registry_insert(&file, &directory.join("a.ts")).unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_corrupted_and_unsupported_documents() {
        let directory = temporary_directory();
        let file = directory.join(REGISTRY_FILE_NAME);

        fs::write(&file, "not json").unwrap();
        assert!(registry_read(&file).is_err());

        fs::write(&file, r#"{"schemaVersion":99,"paths":["/tmp"]}"#).unwrap();
        assert!(registry_read(&file).is_err());

        fs::write(&file, r#"{"schemaVersion":1,"paths":[],"unexpected":true}"#).unwrap();
        assert!(registry_read(&file).is_err());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn rejects_symlinked_registry() {
        let directory = temporary_directory();
        let real = directory.join("real.json");
        fs::write(&real, r#"{"schemaVersion":1,"paths":[]}"#).unwrap();
        let link = directory.join("link.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(registry_read(&link).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
