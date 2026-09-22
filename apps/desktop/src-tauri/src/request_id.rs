//! 请求标识（requestId）的输入卫生校验。
//!
//! 四个命令域——工作区变更、工作区搜索、工作区命令、模型 HTTP——各自实现过一份
//! 形状相同的校验，且字符集已经漂移：两处允许 `.`，两处不允许。同一规则复制四份
//! 意味着任一处修补都可能漏掉其余三处，这里收敛为唯一实现。
//!
//! 字符集取并集中较宽的一侧（含 `.`）：requestId 只用于命令内的关联与取消匹配，
//! 不参与路径拼接或 SQL 构造，放宽一个标点不构成安全面；反之收紧会打断既有调用方
//! （前端已生成含点标识时会在运行时失败，而单测未必覆盖到）。

const MAX_REQUEST_ID_LEN: usize = 128;

/// 校验并返回去除首尾空白后的 requestId。
///
/// `domain` 仅用于错误消息，使调用方能定位是哪一个命令域拒收（保持与拆分前的
/// 提示文案一致）。
pub(crate) fn validate_request_id<'a>(domain: &str, request_id: &'a str) -> Result<&'a str, String> {
    let request_id = request_id.trim();
    let valid = !request_id.is_empty()
        && request_id.len() <= MAX_REQUEST_ID_LEN
        && request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'));
    if !valid {
        return Err(format!("{domain} request ID contains unsupported characters"));
    }
    Ok(request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_union_of_characters_the_split_copies_allowed() {
        assert_eq!(validate_request_id("t", " run-1.a_b ").unwrap(), "run-1.a_b");
    }

    #[test]
    fn rejects_empty_overlong_and_separator_characters() {
        assert!(validate_request_id("t", "   ").is_err());
        assert!(validate_request_id("t", &"a".repeat(129)).is_err());
        assert!(validate_request_id("t", "run/1").is_err());
        assert!(validate_request_id("t", "run 1").is_err());
    }

    #[test]
    fn error_message_carries_the_domain_label() {
        assert_eq!(
            validate_request_id("workspace search", "a/b").unwrap_err(),
            "workspace search request ID contains unsupported characters"
        );
    }
}
