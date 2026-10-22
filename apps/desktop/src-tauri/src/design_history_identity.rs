use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const IDENTITY_FILE: &str = "identity.json";

#[derive(Deserialize, Serialize)]
struct Identity {
    workspace: std::path::PathBuf,
    document: std::path::PathBuf,
    device: u64,
    inode: u64,
    sha256: String,
    #[serde(default)]
    created_nanos: Option<u128>,
}

fn identity(workspace: &Path, document: &Path, bytes: &[u8]) -> Result<Identity, String> {
    let file = std::fs::File::open(document)
        .map_err(|error| format!("failed to inspect observed design identity: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("failed to inspect observed design identity: {error}"))?;
    let mut current = Vec::new();
    file.take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut current)
        .map_err(|error| format!("failed to verify observed design identity: {error}"))?;
    if current != bytes {
        return Err("设计稿在历史归档期间发生变更，请刷新重试".into());
    }
    Ok(Identity {
        workspace: workspace.into(),
        document: document.into(),
        device: metadata.dev(),
        inode: metadata.ino(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        created_nanos: metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_nanos()),
    })
}

fn read(directory: &Path) -> Result<Option<Identity>, String> {
    crate::design_history::validate_directory(directory)?;
    let path = directory.join(IDENTITY_FILE);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to inspect design history identity: {error}"
            ))
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("invalid design history identity".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(8193).read_to_end(&mut bytes))
        .map_err(|error| format!("failed to read design history identity: {error}"))?;
    if bytes.len() > 8192 {
        return Err("design history identity exceeds limit".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("invalid design history identity: {error}"))
}

pub(crate) fn remember(
    data_root: &Path,
    workspace: &Path,
    document: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let identity = identity(workspace, document, bytes)?;
    let directory = crate::design_history::directory(data_root, workspace, document);
    crate::design_history::validate_directory(&directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|error| format!("failed to create design identity: {error}"))?;
    crate::storage_paths::secure_owner_only_file(
        temporary.as_file(),
        "design identity permissions",
    )?;
    let bytes = serde_json::to_vec(&identity)
        .map_err(|error| format!("failed to encode design identity: {error}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("failed to write design identity: {error}"))?;
    temporary
        .persist(directory.join(IDENTITY_FILE))
        .map_err(|error| format!("failed to persist design identity: {}", error.error))?;
    crate::storage_paths::sync_directory(&directory)
        .map_err(|error| format!("failed to sync design identity: {error}"))
}

pub(crate) fn adopt(
    data_root: &Path,
    workspace: &Path,
    document: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let current = identity(workspace, document, bytes)?;
    let target = crate::design_history::directory(data_root, workspace, document);
    if read(&target)?.is_some_and(|previous| {
        previous.device == current.device
            && previous.inode == current.inode
            && previous.sha256 == current.sha256
    }) {
        return Ok(());
    }
    let base = data_root.join("design-history");
    crate::design_history::validate_directory(&base)?;
    let entries = match std::fs::read_dir(&base) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to inspect renamed design histories: {error}"
            ))
        }
    };
    let mut source = None;
    for (index, entry) in entries.enumerate() {
        if index >= 4096 {
            return Err("设计历史索引超过 4096 项，请清理存储后重试".into());
        }
        let entry =
            entry.map_err(|error| format!("failed to inspect design history entry: {error}"))?;
        if entry.path() == target {
            continue;
        }
        let Some(previous) = read(&entry.path())? else {
            continue;
        };
        if previous.workspace != workspace
            || previous.device != current.device
            || previous.inode != current.inode
            || match (previous.created_nanos, current.created_nanos) {
                (Some(previous), Some(current)) => previous != current,
                _ => previous.sha256 != current.sha256,
            }
        {
            continue;
        }
        let relative = previous
            .document
            .strip_prefix(workspace)
            .map_err(|_| "invalid design identity path".to_string())?;
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
            || !crate::design_access::is_design_document_path(relative)
            || crate::design_history::directory(data_root, workspace, &previous.document)
                != entry.path()
        {
            return Err("invalid design identity path".into());
        }
        match std::fs::symlink_metadata(&previous.document) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to inspect previous design path: {error}")),
        }
        if source.replace(previous.document).is_some() {
            return Err("重命名历史来源不唯一，未自动合并".into());
        }
    }
    if let Some(source) = source {
        crate::design_history::relocate_observed(data_root, workspace, &source, document)?;
        remember(data_root, workspace, document, bytes)?;
        std::fs::remove_file(
            crate::design_history::directory(data_root, workspace, &source).join(IDENTITY_FILE),
        )
        .map_err(|error| format!("failed to retire renamed design identity: {error}"))?;
        crate::storage_paths::sync_directory(&crate::design_history::directory(
            data_root, workspace, &source,
        ))
        .map_err(|error| format!("failed to sync retired design identity: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn external_directory_renames_keep_history_across_repeated_moves() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        let before = br#"{"ax":"1.0","pages":[{"id":"before"}]}"#;
        let current = br#"{"ax":"1.0","pages":[{"id":"current"}]}"#;
        std::fs::create_dir(root.join("draft")).unwrap();
        let source = root.join("draft/design.ax");
        std::fs::write(&source, current).unwrap();
        crate::design_history::backup(data.path(), &root, &source, before).unwrap();
        crate::design_history::observe(data.path(), &root, &source, current).unwrap();
        std::fs::rename(root.join("draft"), root.join("published")).unwrap();
        let moved = root.join("published/design.ax");
        crate::design_history::observe(data.path(), &root, &moved, current).unwrap();
        std::fs::rename(&moved, root.join("final.ax")).unwrap();
        let moved = root.join("final.ax");
        crate::design_history::observe(data.path(), &root, &moved, current).unwrap();
        let history = crate::design_history::directory(data.path(), &root, &moved);
        assert_eq!(crate::design_history::list(&history).unwrap().len(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn renamed_document_with_in_place_edits_retains_previous_observed_versions() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        let before = br#"{"ax":"1.0","pages":[]}"#;
        let current = br#"{"ax":"1.0","pages":[{"id":"edited"}]}"#;
        let source = root.join("before.ax");
        let destination = root.join("after.ax");
        std::fs::write(&source, before).unwrap();
        crate::design_history::observe(data.path(), &root, &source, before).unwrap();
        std::fs::rename(&source, &destination).unwrap();
        std::fs::write(&destination, current).unwrap();
        crate::design_history::observe(data.path(), &root, &destination, current).unwrap();
        assert_eq!(
            crate::design_history::list(&crate::design_history::directory(
                data.path(),
                &root,
                &destination
            ))
            .unwrap()
            .len(),
            2
        );
    }

    #[test]
    fn copies_and_live_hard_links_do_not_adopt_another_documents_history() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        let current = br#"{"ax":"1.0","pages":[]}"#;
        let source = root.join("source.ax");
        std::fs::write(&source, current).unwrap();
        crate::design_history::backup(data.path(), &root, &source, b"before").unwrap();
        crate::design_history::observe(data.path(), &root, &source, current).unwrap();
        for hard_link in [false, true] {
            let copy = root.join(if hard_link { "linked.ax" } else { "copy.ax" });
            if hard_link {
                std::fs::hard_link(&source, &copy).unwrap();
            } else {
                std::fs::copy(&source, &copy).unwrap();
            }
            crate::design_history::observe(data.path(), &root, &copy, current).unwrap();
            assert_eq!(
                crate::design_history::list(&crate::design_history::directory(
                    data.path(),
                    &root,
                    &copy
                ))
                .unwrap()
                .len(),
                1
            );
        }
    }
}
