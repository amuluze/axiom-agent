//! 系统浏览器外链通道：会话输出中的 markdown 链接（如 PR 链接）经用户主动点击
//! 打开。协议校验（仅 http/https、无凭据、长度上限）在本层 fail-closed，经
//! 平台 opener（macOS `/usr/bin/open` / Linux `xdg-open` / Windows rundll32）
//! 交给系统默认浏览器——WebView 内不导航。
//! （原 web 只读 Agent 通道 web_access.rs 已随会话能力预设清理移除，本模块
//! 承接其中仍在使用的用户外链入口。）

use reqwest::Url;

const MAX_URL_CHARS: usize = 8192;

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    let (mut command, opener): (std::process::Command, &str) = if cfg!(target_os = "macos") {
        (std::process::Command::new("/usr/bin/open"), "/usr/bin/open")
    } else if cfg!(target_os = "linux") {
        (std::process::Command::new("xdg-open"), "xdg-open")
    } else {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        (command, "rundll32")
    };
    let status = command
        .arg(&url)
        .status()
        .map_err(|error| format!("failed to launch system browser ({opener}): {error}"))?;
    if !status.success() {
        return Err(format!("system browser exited with {status}"));
    }
    Ok(())
}

fn validate_external_url(raw_url: &str) -> Result<(), String> {
    if raw_url.chars().count() > MAX_URL_CHARS {
        return Err(format!(
            "web URL must not exceed {MAX_URL_CHARS} characters"
        ));
    }
    let url = Url::parse(raw_url).map_err(|error| format!("invalid web URL: {error}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials are not allowed in web URLs".into());
    }
    match url.scheme() {
        "http" | "https" => Ok(()),
        _ => Err("only http and https web URLs can be opened in the browser".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_validation_rejects_credentials_and_non_http_schemes() {
        assert!(validate_external_url("https://example.com/path?q=1").is_ok());
        assert!(validate_external_url("http://localhost:5173/").is_ok());
        assert!(validate_external_url("https://user:pass@example.com/").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }
}
