//! 用户级数据根（`~/.axiom/`）与旧版 Tauri app data 目录的一次性迁移。
//!
//! 所有本地数据（SQLite、授权注册表、artifacts、workspace 恢复材料、
//! secrets 迁移意图、seatbelt profile）统一收拢在 `~/.axiom/`（0700），WebView 不
//! 持有该路径、只经 Rust command 间接读写。历史上数据位于 Tauri 默认 app data
//! 目录（`~/Library/Application Support/<identifier>`），启动时按条目幂等迁移
//! （见 [`migrate_legacy_app_data`]）。

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 数据根目录名（`$HOME` 相对）。
const AXIOM_DATA_DIRECTORY_NAME: &str = ".axiom";

/// SQLite 三件套：迁移必须作为原子单元——db 与 WAL 分离会让 SQLite 在新位置打开
/// 「缺 WAL 的库」，静默丢失未 checkpoint 的事务数据。
const DATABASE_LEGACY_ENTRIES: &[&str] = &["axiom.db", "axiom.db-wal", "axiom.db-shm"];

/// 其余数据条目：迁移失败仅记录、不阻断启动（缺失只影响恢复材料，可重建）。
const DATA_LEGACY_ENTRIES: &[&str] = &[
    "authorized_workspaces.json",
    "artifacts",
    "workspace-changes",
    "provider-secret-migrations",
    "computer",
];

pub(crate) fn set_directory_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置数据目录权限失败：{error}"))?;
    }
    Ok(())
}

pub(crate) fn set_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("设置数据文件权限失败：{error}"))?;
    }
    Ok(())
}

/// 数据根：`$HOME/.axiom`，不存在时创建并置 0700。
///
/// 符号链接数据根视为被篡改（fail-closed 拒绝）——它可能指向任意位置（如共享
/// 目录），使 0700 与沙箱 `~/.axiom` deny 失效。存在性用 `symlink_metadata`
/// 判定，链接本身不会被视为有效目录。
pub(crate) fn axiom_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法定位用户主目录：{error}"))?;
    ensure_data_root_at(&home)
}

/// 按 home 构造并确保数据根（无 AppHandle 的纯路径场景，如沙箱 profile 目录）。
pub(crate) fn ensure_data_root_at(home: &Path) -> Result<PathBuf, String> {
    let root = home.join(AXIOM_DATA_DIRECTORY_NAME);
    match fs::symlink_metadata(&root) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(format!("数据根 {} 不是目录（拒绝符号链接或文件）", root.display()));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&root)
                .map_err(|error| format!("创建数据根 {} 失败：{error}", root.display()))?;
        }
        Err(error) => {
            return Err(format!("检查数据根 {} 失败：{error}", root.display()));
        }
    }
    set_directory_permissions(&root)?;
    Ok(root)
}

fn entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// 回滚一组已完成的 rename（from → to 还原为 to → from）。逐条 best-effort——
/// 回滚失败时返回聚合错误，调用方 fail-closed 阻止启动。
fn rollback_renames(moved: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (from, to) in moved.iter().rev() {
        if let Err(error) = fs::rename(to, from) {
            errors.push(format!("{} -> {}: {error}", to.display(), from.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("回滚已迁移条目失败：{}", errors.join("; ")))
    }
}

/// 迁移 SQLite 三件套（原子单元）。
///
/// - 任一条目在新位置已存在 → 三件套整体跳过（旧位置条目原样保留）：绝不把旧 WAL
///   搬到新 db 旁（跨代混搭即损坏），也绝不覆盖新位置的既有数据；
/// - rename 中途失败 → 回滚本次已搬条目并返回 Err，调用方阻止启动（fail-closed：
///   否则 SQLite 会在新位置建空库，静默丢全部会话数据）。
fn migrate_database_bundle(legacy: &Path, root: &Path) -> Result<Vec<String>, String> {
    if DATABASE_LEGACY_ENTRIES
        .iter()
        .any(|name| entry_exists(&root.join(name)))
    {
        return Ok(Vec::new());
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for name in DATABASE_LEGACY_ENTRIES {
        let from = legacy.join(name);
        if !entry_exists(&from) {
            continue;
        }
        let to = root.join(name);
        if let Err(error) = fs::rename(&from, &to) {
            let rollback = rollback_renames(&moved);
            return Err(format!(
                "迁移 SQLite 数据库条目 {name} 失败：{error}{}",
                rollback.err().map(|e| format!("（{e}）")).unwrap_or_default()
            ));
        }
        moved.push((from, to));
    }
    Ok(moved.into_iter().map(|(_, to)| {
        to.file_name().unwrap_or_default().to_string_lossy().into_owned()
    }).collect())
}

/// 把旧 Tauri app data 目录中的 Axiom 数据条目迁移到数据根。
///
/// 迁移规则：旧位置存在且新位置不存在 → rename（同卷原子）；新位置已存在 → 跳过
/// （保留新数据，旧条目原地保留不删）；逐条目独立、幂等可重入（中断后下次启动
/// 继续迁移剩余条目）。旧目录本身不删除（Tauri 自身状态可能残留其中）。
fn migrate_legacy_entries_at(legacy: &Path, root: &Path) -> Result<Vec<String>, String> {
    if !entry_exists(legacy) {
        return Ok(Vec::new());
    }
    let mut migrated = migrate_database_bundle(legacy, root)?;
    for name in DATA_LEGACY_ENTRIES {
        let from = legacy.join(name);
        let to = root.join(name);
        if !entry_exists(&from) || entry_exists(&to) {
            continue;
        }
        // best-effort：失败不阻断启动，下次启动幂等重试。
        if fs::rename(&from, &to).is_ok() {
            migrated.push((*name).to_string());
        }
    }
    Ok(migrated)
}

/// 启动迁移入口：必须在所有数据消费者（SQLite 打开、workspace 恢复）
/// 之前调用；数据库三件套迁移失败时返回 Err，setup 失败阻止启动。
pub(crate) fn migrate_legacy_app_data(app: &AppHandle) -> Result<Vec<String>, String> {
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位旧版应用数据目录：{error}"))?;
    let root = axiom_data_root(app)?;
    migrate_legacy_entries_at(&legacy, &root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn touch(path: &Path) {
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn migrates_all_entries_from_legacy_root() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy");
        let root = dir.path().join("root");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&root).unwrap();
        for name in DATABASE_LEGACY_ENTRIES {
            touch(&legacy.join(name));
        }
        for name in DATA_LEGACY_ENTRIES {
            let path = legacy.join(name);
            if name.ends_with(".json") {
                touch(&path);
            } else {
                fs::create_dir_all(path.join("inner")).unwrap();
            }
        }
        let migrated = migrate_legacy_entries_at(&legacy, &root).unwrap();
        assert_eq!(migrated.len(), DATABASE_LEGACY_ENTRIES.len() + DATA_LEGACY_ENTRIES.len());
        for name in DATABASE_LEGACY_ENTRIES.iter().chain(DATA_LEGACY_ENTRIES.iter()) {
            assert!(entry_exists(&root.join(name)), "新位置缺少 {name}");
            assert!(!entry_exists(&legacy.join(name)), "旧位置残留 {name}");
        }
    }

    #[test]
    fn migration_is_idempotent_on_rerun() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy");
        let root = dir.path().join("root");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&root).unwrap();
        touch(&legacy.join("axiom.db"));
        assert!(!migrate_legacy_entries_at(&legacy, &root).unwrap().is_empty());
        // 第二次：旧位置已空 → no-op
        assert!(migrate_legacy_entries_at(&legacy, &root).unwrap().is_empty());
        // 旧根整个不存在 → no-op
        assert!(migrate_legacy_entries_at(&dir.path().join("missing"), &root)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn existing_target_skips_whole_database_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy");
        let root = dir.path().join("root");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&root).unwrap();
        for name in DATABASE_LEGACY_ENTRIES {
            touch(&legacy.join(name));
        }
        // 新位置已有任一 db 条目 → 三件套整体跳过，旧位置原样保留
        touch(&root.join("axiom.db"));
        let migrated = migrate_legacy_entries_at(&legacy, &root).unwrap();
        assert!(migrated.is_empty());
        for name in DATABASE_LEGACY_ENTRIES {
            assert!(entry_exists(&legacy.join(name)), "旧位置不应被动：{name}");
        }
        assert!(!entry_exists(&root.join("axiom.db-wal")));
    }

    #[test]
    fn non_database_entry_conflict_keeps_both_sides() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy");
        let root = dir.path().join("root");
        fs::create_dir_all(legacy.join("workspace-changes")).unwrap();
        fs::create_dir_all(root.join("workspace-changes")).unwrap();
        let migrated = migrate_legacy_entries_at(&legacy, &root).unwrap();
        assert!(migrated.is_empty());
        // 新旧各自保留（不覆盖、不删除）
        assert!(entry_exists(&legacy.join("workspace-changes")));
        assert!(entry_exists(&root.join("workspace-changes")));
    }

    #[test]
    fn database_migration_failure_is_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy");
        let root = dir.path().join("root");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&root).unwrap();
        touch(&legacy.join("axiom.db"));
        touch(&legacy.join("axiom.db-wal"));
        // 数据根去写权限 → rename 失败 → Err（fail-closed）
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
        let result = migrate_legacy_entries_at(&legacy, &root);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err(), "数据库迁移失败必须阻止启动");
        // 失败后旧位置条目仍在（未丢数据）
        assert!(entry_exists(&legacy.join("axiom.db")));
        assert!(entry_exists(&legacy.join("axiom.db-wal")));
    }

    #[test]
    fn rollback_restores_moved_entries() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        touch(&a);
        fs::rename(&a, &b).unwrap();
        rollback_renames(&[(a.clone(), b.clone())]).unwrap();
        assert!(entry_exists(&a));
        assert!(!entry_exists(&b));
    }

    #[test]
    fn rejects_symlinked_data_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link-home");
        fs::create_dir_all(&real).unwrap();
        symlink(&real, &link).unwrap();
        // home 下 .axiom 若是符号链接 → fail-closed
        let target = real.join(".axiom");
        fs::create_dir_all(&target).unwrap();
        let home_with_link = dir.path().join("home2");
        fs::create_dir_all(&home_with_link).unwrap();
        symlink(&target, home_with_link.join(".axiom")).unwrap();
        assert!(ensure_data_root_at(&home_with_link).is_err());
        // 正常 home → 创建成功且幂等
        let clean = dir.path().join("home3");
        fs::create_dir_all(&clean).unwrap();
        assert!(ensure_data_root_at(&clean).unwrap().ends_with(".axiom"));
        assert!(ensure_data_root_at(&clean).is_ok());
    }
}
