use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_BYTES: usize = 8 * 1024 * 1024;

fn run_git(root: &Path, arguments: &[&str], deadline: Instant) -> Result<Vec<u8>, String> {
    let inherited = std::env::var_os("PATH");
    let path = crate::workspace_command::sanitized_path_with_toolchain_fallback(
        root,
        inherited.as_deref(),
        None,
    )
    .ok_or_else(|| "Git 不可用，请配置系统 Git 的 PATH 后重试".to_string())?;
    let configuration = tempfile::NamedTempFile::new()
        .map_err(|error| format!("failed to prepare isolated Git configuration: {error}"))?;
    let mut command = Command::new("git");
    command
        .args(["--no-pager", "--literal-pathspecs"])
        .args(arguments)
        .current_dir(root)
        .env_clear()
        .env("PATH", path)
        .env("GIT_CONFIG_GLOBAL", configuration.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    for name in ["SYSTEMROOT", "WINDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env(
        "GIT_CONFIG_COUNT",
        crate::git_config::git_config_neutralization()
            .len()
            .to_string(),
    );
    for (index, (key, value)) in crate::git_config::git_config_neutralization()
        .iter()
        .enumerate()
    {
        command.env(format!("GIT_CONFIG_KEY_{index}"), key);
        command.env(format!("GIT_CONFIG_VALUE_{index}"), value);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Git 无法启动，请确认已安装系统 Git：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Git output pipe missing".to_string())?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => break Err("Git 历史读取超时，请稍后重试".to_string()),
            Err(error) => break Err(format!("failed to wait for Git history: {error}")),
        }
    };
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let output = reader
        .join()
        .map_err(|_| "Git history output reader failed".to_string())?
        .map_err(|error| format!("failed to read Git history: {error}"))?;
    if output.len() > MAX_BYTES {
        return Err("Git 设计稿或历史索引超过 8 MiB 上限".into());
    }
    if !status?.success() {
        return Err("无法读取 Git 历史，请确认项目是 Git 仓库且本地提交对象完整".into());
    }
    Ok(output)
}

pub(crate) fn import(data_root: &Path, root: &Path, document: &Path) -> Result<(), String> {
    let path = document
        .strip_prefix(root)
        .map_err(|_| "Git 设计稿必须位于当前工作区".to_string())?
        .to_str()
        .ok_or_else(|| "Git 设计稿路径必须是 UTF-8".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let top = run_git(root, &["rev-parse", "--show-toplevel"], deadline)?;
    let top = std::str::from_utf8(&top)
        .map_err(|_| "Git root must be UTF-8".to_string())?
        .trim_end_matches(['\r', '\n']);
    if std::fs::canonicalize(top).map_err(|error| format!("failed to resolve Git root: {error}"))?
        != root
    {
        return Err("请授权 Git 仓库根目录后再导入历史".into());
    }
    let output = run_git(
        root,
        &[
            "log",
            "--follow",
            "--no-ext-diff",
            "--no-textconv",
            "--format=%H%x00%ct",
            "--name-only",
            "-z",
            "--max-count=20",
            "--",
            path,
        ],
        deadline,
    )?;
    let fields: Vec<&[u8]> = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    if !fields.len().is_multiple_of(3) || fields.len() > 60 {
        return Err("Git 历史响应格式无效".into());
    }
    let history = crate::design_history::directory(data_root, root, document);
    for entry in fields.chunks_exact(3).rev() {
        let commit = std::str::from_utf8(entry[0]).map_err(|_| "invalid Git commit".to_string())?;
        if ![40, 64].contains(&commit.len()) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("invalid Git commit identifier".into());
        }
        let seconds = std::str::from_utf8(entry[1])
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| "invalid Git commit timestamp".to_string())?;
        let relative = std::str::from_utf8(entry[2])
            .map_err(|_| "Git 历史路径必须是 UTF-8".to_string())?
            .strip_prefix('\n')
            .ok_or_else(|| "invalid Git history path".to_string())?;
        if Path::new(relative).is_absolute()
            || Path::new(relative)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("invalid Git history path".into());
        }
        if !crate::design_access::is_design_document_path(Path::new(relative)) {
            continue;
        }
        let bytes = run_git(
            root,
            &[
                "show",
                "--no-ext-diff",
                "--no-textconv",
                &format!("{commit}:{relative}"),
            ],
            deadline,
        )?;
        let valid = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .is_some_and(|value| {
                value.get("ax").is_some()
                    && value.get("pages").is_some_and(|pages| pages.is_array())
            });
        if !valid {
            continue;
        }
        let modified = UNIX_EPOCH
            .checked_add(Duration::from_secs(seconds))
            .filter(|time| *time <= SystemTime::now())
            .ok_or_else(|| "invalid Git commit timestamp".to_string())?;
        crate::design_history::record_imported(&history, &bytes, modified)?;
    }
    crate::design_history::prune(&history)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn nested_workspace_cannot_read_git_objects_outside_its_authorized_root() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        git(&root, &["init", "-q"]);
        let nested = root.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let document = nested.join("draft.ax");
        std::fs::write(&document, br#"{"ax":"1.0","pages":[]}"#).unwrap();
        assert!(import(data.path(), &nested, &document)
            .unwrap_err()
            .contains("仓库根目录"));
        assert!(!data.path().join("design-history").exists());
    }

    #[test]
    fn imported_history_follows_renames_and_keeps_observed_version_time() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.name", "Design Test"]);
        git(&root, &["config", "user.email", "design@example.invalid"]);
        let before = br#"{"ax":"1.0","pages":[{"id":"before"}]}"#;
        let current = br#"{"ax":"1.0","pages":[{"id":"current"}]}"#;
        std::fs::write(root.join("old draft.ax"), before).unwrap();
        git(&root, &["add", "--", "old draft.ax"]);
        git(&root, &["commit", "-qm", "first"]);
        git(&root, &["mv", "old draft.ax", "new draft.ax"]);
        git(&root, &["commit", "-qm", "rename"]);
        std::fs::write(root.join("new draft.ax"), current).unwrap();
        git(&root, &["commit", "-qam", "update"]);
        let document = root.join("new draft.ax");
        let history = crate::design_history::directory(data.path(), &root, &document);
        crate::design_history::observe(data.path(), &root, &document, current).unwrap();
        let modified = serde_json::to_value(&crate::design_history::list(&history).unwrap()[0])
            .unwrap()["modifiedMs"]
            .clone();
        git(
            &root,
            &[
                "config",
                "diff.external",
                "nonexistent-axiom-history-external-diff",
            ],
        );
        git(
            &root,
            &[
                "config",
                "core.fsmonitor",
                "nonexistent-axiom-history-fsmonitor",
            ],
        );
        import(data.path(), &root, &document).unwrap();
        import(data.path(), &root, &document).unwrap();
        let versions = crate::design_history::list(&history).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            serde_json::to_value(&versions[0]).unwrap()["modifiedMs"],
            modified
        );
        assert!(versions.iter().any(|version| crate::design_history::read(
            &history,
            &version.sha256
        )
        .unwrap()
            == before));
    }
}
