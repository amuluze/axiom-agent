use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_VERSIONS: usize = 20;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignDocumentVersion {
    pub(crate) sha256: String,
    size_bytes: u64,
    modified_ms: u64,
    page_count: Option<usize>,
    #[serde(skip)]
    modified_nanos: u128,
}

pub(crate) fn directory(data_root: &Path, workspace: &Path, document: &Path) -> PathBuf {
    let identity = serde_json::json!([workspace.to_string_lossy(), document.to_string_lossy()]);
    let digest = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
    data_root.join("design-history").join(digest)
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn validate_directory(directory: &Path) -> Result<(), String> {
    for candidate in [Some(directory), directory.parent()].into_iter().flatten() {
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err("design history directory must not be a symbolic link".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to inspect design history: {error}")),
        }
    }
    Ok(())
}

pub(crate) fn read(directory: &Path, sha256: &str) -> Result<Vec<u8>, String> {
    validate_directory(directory)?;
    if !valid_hash(sha256) {
        return Err("invalid design version identifier".into());
    }
    let file = directory.join(format!("{sha256}.ax"));
    let metadata = std::fs::symlink_metadata(&file)
        .map_err(|error| format!("failed to inspect design version: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("design version is not a regular file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&file)
        .map_err(|error| format!("failed to open design version: {error}"))?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read design version: {error}"))?;
    if bytes.len() as u64 > MAX_BYTES || format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err("design version integrity check failed".into());
    }
    Ok(bytes)
}

pub(crate) fn list(directory: &Path) -> Result<Vec<DesignDocumentVersion>, String> {
    validate_directory(directory)?;
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to list design versions: {error}")),
    };
    let mut versions = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to inspect design version: {error}"))?;
        let path = entry.path();
        let Some(hash) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if path.extension().and_then(|value| value.to_str()) != Some("ax") || !valid_hash(hash) {
            continue;
        }
        let bytes = read(directory, hash)?;
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map_err(|error| format!("failed to inspect design version time: {error}"))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("invalid design version time: {error}"))?;
        let modified_ms = modified.as_millis() as u64;
        let page_count = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("pages")
                    .and_then(|pages| pages.as_array())
                    .map(Vec::len)
            });
        versions.push(DesignDocumentVersion {
            sha256: hash.into(),
            size_bytes: bytes.len() as u64,
            modified_ms,
            page_count,
            modified_nanos: modified.as_nanos(),
        });
    }
    versions.sort_by(|left, right| {
        right
            .modified_nanos
            .cmp(&left.modified_nanos)
            .then_with(|| left.sha256.cmp(&right.sha256))
    });
    Ok(versions)
}

pub(crate) fn record(directory: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("design version exceeds 8 MiB".into());
    }
    validate_directory(directory)?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("failed to create design history: {error}"))?;
    crate::storage_paths::set_directory_permissions(directory)?;
    if let Some(parent) = directory.parent() {
        crate::storage_paths::set_directory_permissions(parent)?;
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    let target = directory.join(format!("{hash}.ax"));
    if target.exists() {
        read(directory, &hash)?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .map_err(|error| format!("failed to open design version: {error}"))?;
        file.set_modified(std::time::SystemTime::now())
            .map_err(|error| format!("failed to update design version time: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync design version time: {error}"))?;
        return Ok(hash);
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("failed to create design version: {error}"))?;
    crate::storage_paths::secure_owner_only_file(
        temporary.as_file(),
        "design version permissions",
    )?;
    temporary
        .write_all(bytes)
        .map_err(|error| format!("failed to write design version: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync design version: {error}"))?;
    temporary
        .persist(&target)
        .map_err(|error| format!("failed to persist design version: {}", error.error))?;
    crate::storage_paths::sync_directory(directory)
        .map_err(|error| format!("failed to sync design history: {error}"))?;
    Ok(hash)
}

pub(crate) fn record_imported(
    directory: &Path,
    bytes: &[u8],
    modified: std::time::SystemTime,
) -> Result<(), String> {
    let hash = format!("{:x}", Sha256::digest(bytes));
    validate_directory(directory)?;
    match std::fs::symlink_metadata(directory.join(format!("{hash}.ax"))) {
        Ok(_) => {
            read(directory, &hash)?;
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect imported design version: {error}"
            ))
        }
    }
    record(directory, bytes)?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(directory.join(format!("{hash}.ax")))
        .and_then(|file| {
            file.set_modified(modified)?;
            file.sync_all()
        })
        .map_err(|error| format!("failed to preserve imported design version time: {error}"))
}

pub(crate) fn observe(
    data_root: &Path,
    workspace: &Path,
    document: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    if !crate::design_access::is_design_document_path(document) {
        return Ok(());
    }
    let valid = serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .is_some_and(|value| {
            value.get("ax").is_some() && value.get("pages").is_some_and(|pages| pages.is_array())
        });
    if !valid {
        return Ok(());
    }
    #[cfg(unix)]
    crate::design_history_identity::adopt(data_root, workspace, document, bytes)?;
    let history = directory(data_root, workspace, document);
    let hash = format!("{:x}", Sha256::digest(bytes));
    validate_directory(&history)?;
    match std::fs::symlink_metadata(history.join(format!("{hash}.ax"))) {
        Ok(_) => {
            read(&history, &hash)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            record(&history, bytes)?;
        }
        Err(error) => {
            return Err(format!(
                "failed to inspect observed design version: {error}"
            ))
        }
    }
    prune(&history)?;
    #[cfg(unix)]
    crate::design_history_identity::remember(data_root, workspace, document, bytes)?;
    Ok(())
}

pub(crate) fn backup(
    data_root: &Path,
    workspace: &Path,
    document: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    if crate::design_access::is_design_document_path(document) {
        let history = directory(data_root, workspace, document);
        record(&history, bytes)?;
        prune(&history)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignHistoryMove {
    pub(crate) source: String,
    pub(crate) destination: String,
    versions: Vec<DesignHistoryMoveVersion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesignHistoryMoveVersion {
    sha256: String,
    modified_nanos: u128,
}

pub(crate) fn prepare_move(
    data_root: &Path,
    workspace: &Path,
    source: &Path,
    destination: &Path,
) -> Result<Vec<DesignHistoryMove>, String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("failed to inspect moved design: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Ok(Vec::new());
    }
    if metadata.is_dir() {
        let mut moves = Vec::new();
        for entry in std::fs::read_dir(source)
            .map_err(|error| format!("failed to inspect moved design directory: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("failed to inspect moved design entry: {error}"))?;
            moves.extend(prepare_move(
                data_root,
                workspace,
                &entry.path(),
                &destination.join(entry.file_name()),
            )?);
            if moves.len() > 128 {
                return Err("design history move exceeds 128 documents".into());
            }
        }
        return Ok(moves);
    }
    if !metadata.is_file()
        || !crate::design_access::is_design_document_path(source)
        || !crate::design_access::is_design_document_path(destination)
    {
        return Ok(Vec::new());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(source)
        .map_err(|error| format!("failed to open moved design: {error}"))?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read moved design: {error}"))?;
    backup(data_root, workspace, source, &bytes)?;
    let relative = |path: &Path| {
        path.strip_prefix(workspace)
            .map_err(|_| "moved design must remain inside the workspace".to_string())?
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "moved design path must be UTF-8".to_string())
    };
    Ok(vec![DesignHistoryMove {
        source: relative(source)?,
        destination: relative(destination)?,
        versions: list(&directory(data_root, workspace, source))?
            .into_iter()
            .map(|version| DesignHistoryMoveVersion {
                sha256: version.sha256,
                modified_nanos: version.modified_nanos,
            })
            .collect(),
    }])
}

#[cfg(unix)]
pub(crate) fn relocate_observed(
    data_root: &Path,
    workspace: &Path,
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    let relative = |path: &Path| {
        path.strip_prefix(workspace)
            .ok()
            .and_then(Path::to_str)
            .map(str::to_owned)
            .ok_or_else(|| "invalid relocated design path".to_string())
    };
    let movement = DesignHistoryMove {
        source: relative(source)?,
        destination: relative(destination)?,
        versions: list(&directory(data_root, workspace, source))?
            .into_iter()
            .map(|version| DesignHistoryMoveVersion {
                sha256: version.sha256,
                modified_nanos: version.modified_nanos,
            })
            .collect(),
    };
    transfer(data_root, workspace, &movement, None)
}

pub(crate) fn stage_moves(
    data_root: &Path,
    workspace: &Path,
    staging: &Path,
    moves: &[DesignHistoryMove],
) -> Result<(), String> {
    for movement in moves {
        let source = directory(data_root, workspace, &workspace.join(&movement.source));
        for version in &movement.versions {
            record(staging, &read(&source, &version.sha256)?)?;
        }
    }
    Ok(())
}

pub(crate) fn transfer(
    data_root: &Path,
    workspace: &Path,
    movement: &DesignHistoryMove,
    staging: Option<&Path>,
) -> Result<(), String> {
    if movement.versions.len() > MAX_VERSIONS {
        return Err("design history move exceeds version limit".into());
    }
    let source = directory(data_root, workspace, &workspace.join(&movement.source));
    let destination = directory(data_root, workspace, &workspace.join(&movement.destination));
    for version in movement.versions.iter().rev() {
        let bytes = read(staging.unwrap_or(&source), &version.sha256)?;
        validate_directory(&destination)?;
        let target = destination.join(format!("{}.ax", version.sha256));
        let existing_time = match std::fs::symlink_metadata(&target) {
            Ok(metadata) => {
                Some(metadata.modified().map_err(|error| {
                    format!("failed to inspect destination version time: {error}")
                })?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("failed to inspect destination version: {error}")),
        };
        let nanos: u64 = version
            .modified_nanos
            .try_into()
            .map_err(|_| "invalid moved design version time".to_string())?;
        let modified = std::time::UNIX_EPOCH
            .checked_add(std::time::Duration::from_nanos(nanos))
            .ok_or_else(|| "invalid moved design version time".to_string())?;
        record(&destination, &bytes)?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .map_err(|error| format!("failed to open transferred design version: {error}"))?;
        file.set_modified(existing_time.map_or(modified, |time| time.max(modified)))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("failed to sync transferred design version time: {error}"))?;
    }
    prune(&destination)
}

pub(crate) fn prune(directory: &Path) -> Result<(), String> {
    for version in list(directory)?.into_iter().skip(MAX_VERSIONS) {
        std::fs::remove_file(directory.join(format!("{}.ax", version.sha256)))
            .map_err(|error| format!("failed to prune design history: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_versions_deduplicate_without_reordering_and_reject_non_design_inputs() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let document = workspace.path().join("draft.ax");
        let before = br#"{"ax":"1.0","pages":[]}"#;
        std::fs::write(&document, before).unwrap();
        observe(data.path(), workspace.path(), &document, before).unwrap();
        let history = directory(data.path(), workspace.path(), &document);
        let first = list(&history).unwrap();
        observe(data.path(), workspace.path(), &document, before).unwrap();
        assert_eq!(
            list(&history).unwrap()[0].modified_nanos,
            first[0].modified_nanos
        );
        observe(data.path(), workspace.path(), &document, b"bad json").unwrap();
        assert_eq!(list(&history).unwrap().len(), 1);
        observe(
            data.path(),
            workspace.path(),
            &workspace.path().join("draft.pen"),
            before,
        )
        .unwrap();
        assert!(list(&directory(
            data.path(),
            workspace.path(),
            &workspace.path().join("draft.pen")
        ))
        .unwrap()
        .is_empty());
    }

    #[test]
    fn transferred_versions_merge_deduplicate_preserve_times_and_keep_latest_twenty() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("before.ax");
        let destination = workspace.path().join("after.ax");
        std::fs::write(&source, b"version-20").unwrap();
        let source_history = directory(data.path(), workspace.path(), &source);
        let destination_history = directory(data.path(), workspace.path(), &destination);
        for index in 0..20 {
            let hash = record(&destination_history, format!("version-{index}").as_bytes()).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(destination_history.join(format!("{hash}.ax")))
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(100 + index))
                .unwrap();
        }
        let hash = record(&source_history, b"version-19").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(source_history.join(format!("{hash}.ax")))
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(119))
            .unwrap();
        let movement = prepare_move(data.path(), workspace.path(), &source, &destination).unwrap();
        transfer(data.path(), workspace.path(), &movement[0], None).unwrap();
        let versions = list(&destination_history).unwrap();
        assert_eq!(versions.len(), 20);
        assert_eq!(versions[1].sha256, hash);
        assert_eq!(versions[1].modified_nanos, 119_000_000_000);
        assert!(!versions
            .iter()
            .any(|version| version.sha256 == format!("{:x}", Sha256::digest(b"version-0"))));
        transfer(data.path(), workspace.path(), &movement[0], None).unwrap();
        assert_eq!(
            list(&destination_history).unwrap()[0].modified_nanos,
            versions[0].modified_nanos
        );
    }

    #[cfg(unix)]
    #[test]
    fn moved_directories_do_not_archive_symlink_targets() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private.ax"), b"outside").unwrap();
        let source = workspace.path().join("draft");
        std::fs::create_dir(&source).unwrap();
        std::os::unix::fs::symlink(outside.path(), source.join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("private.ax"), source.join("linked.ax"))
            .unwrap();
        assert!(prepare_move(
            data.path(),
            workspace.path(),
            &source,
            &workspace.path().join("published")
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn versions_persist_and_are_content_addressed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let history = directory.path().join("history");
        let source = br#"{"ax":"1.3","pages":[{"id":"p1"}]}"#;
        let hash = record(&history, source).expect("record");
        assert_eq!(record(&history, source).expect("duplicate"), hash);
        assert_eq!(read(&history, &hash).expect("read"), source);
        let versions = list(&history).expect("list");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].page_count, Some(1));
    }

    #[test]
    fn workspace_and_document_identity_are_isolated() {
        let root = Path::new("/data");
        assert_ne!(
            directory(root, Path::new("/a"), Path::new("/a/design.ax")),
            directory(root, Path::new("/b"), Path::new("/b/design.ax"))
        );
        assert_ne!(
            directory(root, Path::new("/a"), Path::new("/a/design.ax")),
            directory(root, Path::new("/a"), Path::new("/a/other.ax"))
        );
    }

    #[test]
    fn malformed_identifiers_and_tampered_snapshots_are_rejected() {
        let directory = tempfile::tempdir().expect("tempdir");
        let history = directory.path().join("history");
        let hash = record(&history, b"{}").expect("record");
        assert!(read(&history, "../file").is_err());
        std::fs::write(history.join(format!("{hash}.ax")), b"tampered").expect("tamper");
        assert!(read(&history, &hash).is_err());
        assert!(list(&history).is_err());
    }

    #[test]
    fn retention_is_bounded() {
        let directory = tempfile::tempdir().expect("tempdir");
        let history = directory.path().join("history");
        for index in 0..25 {
            record(&history, format!("{{\"version\":{index}}}").as_bytes()).expect("record");
        }
        prune(&history).expect("prune");
        assert_eq!(list(&history).expect("list").len(), MAX_VERSIONS);
    }
}
