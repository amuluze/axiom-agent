//! git 配置执行面中和。
//!
//! 被克隆的恶意仓库可通过仓库级 `.git/config`（git 总是读取仓库本地配置）把可执行程序
//! 挂到某些 git 配置键上——模型运行 git 子命令时会在当前用户权限下触发，构成 RCE 面。
//! 经典例子是 `core.hooksPath`、`core.sshCommand` 以及各类"驱动类"键（credential helper、
//! external diff、filter driver 等）。
//!
//! 中和手段：`GIT_CONFIG_COUNT` 环境变量序列（`GIT_CONFIG_KEY_N` / `GIT_CONFIG_VALUE_N`）
//! 优先级**高于仓库配置**，且不触碰用户全局/系统配置。把关键执行键显式覆盖为安全值，
//! 恶意仓库配置即被压制。
//!
//! 已知残余面（无法用精确键中和，依赖上层约束）：
//! - `filter.<name>.clean/.smudge/.process`、`diff.<name>.textconv`、`pager.<cmd>` 是
//!   名字不可枚举的家族键，无法用 `GIT_CONFIG_COUNT` 逐个压制。它们在沙箱 tier 内受
//!   seatbelt 约束（网络禁用、仅工作区可写、凭据路径 deny）；network-required tier
//!   （clone/pull/push）无沙箱，残余风险由「用户显式授权该仓库」与 git 自身行为兜底，
//!   在 AGENTS.md「安全模型」中已文档化。

/// 精确键中和列表：`(key, value)`。值必须是无副作用的纯字符串。
/// 空字符串表示禁用对应机制（`credential.helper=`、`diff.external=` 等）。
pub(crate) fn git_config_neutralization() -> &'static [(&'static str, &'static str)] {
    &[
        // 执行面基础三件套（既有语义，保持不回归）
        ("core.hooksPath", "/dev/null"),
        ("core.fsmonitor", "false"),
        ("core.sshCommand", "ssh"),
        // 驱动类执行键：恶意仓库把可执行程序挂到这些键上会在 git 子命令运行时被触发
        ("credential.helper", ""),
        ("diff.external", ""),
        ("core.gitProxy", ""),
        ("core.askPass", ""),
        ("core.webCommand", ""),
        // 阻塞/交互面：不执行攻击者指定的编辑器或 pager（env `GIT_PAGER=cat` 之外的
        // 第二道防线；`pager.<cmd>` 家族键仍为文档化残余面）
        ("core.editor", "true"),
        ("core.pager", "cat"),
        // 探测面：ssh 变体自动探测会执行 `ssh -G`，固定为 simple 避免触发
        ("core.sshVariant", "simple"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn neutralizes_all_critical_execution_driving_keys() {
        let keys: HashSet<&str> = git_config_neutralization().iter().map(|(k, _)| *k).collect();
        // 最小必需集：缺失任一条即视为回归
        for critical in [
            "core.hooksPath",
            "core.fsmonitor",
            "core.sshCommand",
            "credential.helper",
            "diff.external",
            "core.gitProxy",
            "core.editor",
            "core.askPass",
        ] {
            assert!(keys.contains(critical), "缺少关键中和键: {critical}");
        }
    }

    #[test]
    fn keys_are_unique() {
        let mut seen = HashSet::new();
        for (key, _) in git_config_neutralization() {
            assert!(seen.insert(*key), "中和键重复: {key}");
        }
    }

    #[test]
    fn values_are_plain_and_safe() {
        // 值必须是纯字符串，不携带空格/引号/命令替换，避免自身引入解析面
        for (key, value) in git_config_neutralization() {
            assert!(
                !value.chars().any(|c| matches!(c, ' ' | '"' | '\'' | '$' | '`' | '\\' | ';' | '&' | '|' | '>' | '<')),
                "中和值 {key}={value} 含特殊字符",
            );
        }
    }

    #[test]
    fn count_matches_list_len() {
        assert_eq!(git_config_neutralization().len(), 11);
    }
}
