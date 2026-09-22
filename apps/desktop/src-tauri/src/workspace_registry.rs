//! 授权工作区注册表（Rust 独占持久层）。
//!
//! `authorize_workspace` 命令必须保留给「重启恢复既有授权」使用（WebView 从
//! localStorage 读回路径再调用它），但受陷渲染进程同样能调用它——若接受任意
//! 路径，渲染进程可把 `$HOME` 乃至 `/` 授权为工作区，令 seatbelt 的
//! 「写限工作区」退化为「写限全盘」，再借 SandboxSafe 免手势租约在沙箱内
//! 完成持久化（LaunchAgents / shell rc）。因此恢复授权只接受注册表中记录过的
//! 路径：注册表仅在用户亲手经原生目录选择器授权（pick_and_authorize_workspace）
//! 时写入、撤销时同步移除，WebView 没有任何直接读写面。
//!
//! 并发约定：所有读-改-写操作（insert / remove / seed）必须由调用方持有
//! `WorkspaceAccessState::registry_mutations` 锁串行化；`contains` 只读、无锁要求。
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

use crate::artifacts::axiom_data_root;

const REGISTRY_FILE_NAME: &str = "authorized_workspaces.json";
const REGISTRY_SCHEMA_VERSION: u32 = 1;
/// 注册表路径上限：与 authorize_impl 的 16 KiB 路径上限同源，防止无界膨胀。
const MAX_REGISTRY_PATHS: usize = 64;
/// 注册表文件读取上限：64 条 × 16 KiB + 元数据，超限视为损坏（fail-closed）。
const MAX_REGISTRY_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    schema_version: u32,
    paths: Vec<PathBuf>,
}

/// 注册表文件路径：应用数据目录（与 axiom.db 同级），由 Rust 独占管理。
pub(crate) fn registry_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(axiom_data_root(app)?.join(REGISTRY_FILE_NAME))
}

/// 拒绝符号链接：注册表目录属应用私有数据，出现 symlink 即视为被篡改。
/// SSH 主机注册表（ssh.rs）复用同一规则。
pub(crate) fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "authorized workspace registry must not be a symlink: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to inspect authorized workspace registry: {error}"
        )),
    }
}

/// 读取注册表全部路径。文件不存在视为空集（全新安装）；存在但损坏/超限/
/// 版本不识别则 fail-closed 返回 Err——恢复路径宁可要求用户重新选择目录，
/// 也不能静默放宽授权面。
pub(crate) fn registry_read(file: &Path) -> Result<HashSet<PathBuf>, String> {
    reject_symlink(file)?;
    let metadata = match fs::metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => {
            return Err(format!("failed to read authorized workspace registry: {error}"))
        }
    };
    if !metadata.is_file() {
        return Err(format!(
            "authorized workspace registry is not a regular file: {}",
            file.display()
        ));
    }
    if metadata.len() > MAX_REGISTRY_FILE_BYTES {
        return Err("authorized workspace registry exceeds the safe size limit".into());
    }
    let raw = fs::read_to_string(file)
        .map_err(|error| format!("failed to read authorized workspace registry: {error}"))?;
    let document: RegistryDocument = serde_json::from_str(&raw).map_err(|error| {
        format!("authorized workspace registry is corrupted: {error}")
    })?;
    if document.schema_version != REGISTRY_SCHEMA_VERSION {
        return Err(format!(
            "authorized workspace registry schema version {} is not supported (expected {REGISTRY_SCHEMA_VERSION})",
            document.schema_version
        ));
    }
    if document.paths.len() > MAX_REGISTRY_PATHS
        || document
            .paths
            .iter()
            .any(|path| path.as_os_str().len() > 16 * 1024)
    {
        return Err("authorized workspace registry exceeds the safe entry limits".into());
    }
    Ok(document.paths.into_iter().collect())
}

pub(crate) fn registry_contains(file: &Path, workspace: &Path) -> Result<bool, String> {
    Ok(registry_read(file)?.contains(workspace))
}

/// 原子写回：同目录临时文件 + persist，权限 0o600（与 Provider Secret
/// cleanup-intent 同标准——注册表等价于「下次启动可自动授权的目录清单」）。
fn registry_write(file: &Path, paths: &HashSet<PathBuf>) -> Result<(), String> {
    let Some(parent) = file.parent() else {
        return Err("authorized workspace registry has no parent directory".into());
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
        .map_err(|error| format!("failed to encode authorized workspace registry: {error}"))?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to stage authorized workspace registry: {error}"))?;
    crate::storage_paths::secure_owner_only_file(
        temporary.as_file(),
        "failed to secure authorized workspace registry",
    )?;
    temporary
        .write_all(&encoded)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("failed to sync authorized workspace registry: {error}"))?;
    temporary.persist(file).map(|_| ()).map_err(|error| {
        format!(
            "failed to commit authorized workspace registry: {}",
            error.error
        )
    })
}

/// 用户经原生选择器授权新目录时登记。写失败即返回 Err（调用方不得继续
/// 内存授权）：注册表是恢复授权的唯一依据，宁可拒绝授权也不留「本次可用、
/// 重启丢失」的静默降级。
pub(crate) fn registry_insert(file: &Path, workspace: &Path) -> Result<(), String> {
    let mut paths = registry_read(file)?;
    if paths.len() >= MAX_REGISTRY_PATHS && !paths.contains(workspace) {
        return Err("too many registered workspaces; revoke one before authorizing another".into());
    }
    paths.insert(workspace.to_path_buf());
    registry_write(file, &paths)
}

/// 撤销授权时移除。必须在内存 revoke 之前执行并成功：只要注册表仍含该路径，
/// 重启恢复就会重新授权它（localStorage/SQLite 残留即足以触发），撤销不具
/// 持久效力。
pub(crate) fn registry_remove(file: &Path, workspace: &Path) -> Result<(), String> {
    let mut paths = registry_read(file)?;
    if paths.remove(workspace) {
        registry_write(file, &paths)?;
    }
    Ok(())
}

/// 首次升级迁移：注册表文件不存在时，用 SQLite 中用户历史绑定过的工作区路径
/// 播种（DB 由 Rust 独占写入，workspace 均源自原生选择器，可信）。已存在
/// （含损坏）则不动——损坏场景交给 registry_read 的 fail-closed 处理。
/// 返回是否执行了播种。
pub(crate) fn registry_seed_if_absent(
    file: &Path,
    historical_workspaces: &[PathBuf],
) -> Result<bool, String> {
    if file.exists() {
        return Ok(false);
    }
    let paths: HashSet<PathBuf> = historical_workspaces
        .iter()
        .filter(|path| path.as_os_str().len() <= 16 * 1024)
        .take(MAX_REGISTRY_PATHS)
        .cloned()
        .collect();
    registry_write(file, &paths)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "axiom-workspace-registry-{}-{}",
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
    fn round_trips_insert_contains_and_remove() {
        let directory = temporary_directory();
        let file = directory.join(REGISTRY_FILE_NAME);
        let workspace = directory.join("project");

        assert!(!registry_contains(&file, &workspace).unwrap());
        registry_insert(&file, &workspace).unwrap();
        assert!(registry_contains(&file, &workspace).unwrap());
        // 重复 insert 幂等，不产生重复条目。
        registry_insert(&file, &workspace).unwrap();
        assert_eq!(registry_read(&file).unwrap().len(), 1);

        registry_remove(&file, &workspace).unwrap();
        assert!(!registry_contains(&file, &workspace).unwrap());
        // 移除不存在的路径是幂等 no-op。
        registry_remove(&file, &workspace).unwrap();

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn writes_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = temporary_directory();
        let file = directory.join(REGISTRY_FILE_NAME);
        registry_insert(&file, &directory.join("a")).unwrap();
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

        fs::write(
            &file,
            r#"{"schemaVersion":99,"paths":["/tmp"]}"#,
        )
        .unwrap();
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

    #[test]
    fn seeds_only_when_file_is_absent() {
        let directory = temporary_directory();
        let file = directory.join(REGISTRY_FILE_NAME);
        let historical = vec![directory.join("old-project")];

        assert!(registry_seed_if_absent(&file, &historical).unwrap());
        assert!(registry_contains(&file, &historical[0]).unwrap());
        // 已存在时不再播种，也不清空既有内容。
        assert!(!registry_seed_if_absent(&file, &[directory.join("other")]).unwrap());
        assert!(!registry_contains(&file, &directory.join("other")).unwrap());

        std::fs::remove_dir_all(directory).unwrap();
    }
}
