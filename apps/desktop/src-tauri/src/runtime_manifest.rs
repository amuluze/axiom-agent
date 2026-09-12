//! Runtime dependency manifest 校验与共享标识符校验。
//!
//! 此模块是 `session_repository` 与 `session_mutations` 共用的中立校验层,
//! 目的是切断两者之间的真实双向模块依赖。原先分散在两个文件中的重复
//! `validate_identifier`、以及仅被 `session_repository` 调用却定义在
//! `session_mutations` 的 `validate_runtime_manifest`,统一收敛到此处。

use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

pub(crate) const RUNTIME_DEPENDENCY_SCHEMA_VERSION: u64 = 4;

/// 单个 project Skill 名称格式（对齐 TS 侧 parser）：小写字母/数字/连字符，
/// 不能以 `-` 开头或结尾、不能连续 `--`，长度 1–64。
fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Runtime dependency manifest Skill name 长度无效".to_string());
    }
    let bytes = name.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return Err("Runtime dependency manifest Skill name 必须以小写字母或数字开头".to_string());
    }
    if !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit() {
        return Err("Runtime dependency manifest Skill name 不能以连字符结尾".to_string());
    }
    for pair in bytes.windows(2) {
        let left_ok = pair[0].is_ascii_lowercase() || pair[0].is_ascii_digit() || pair[0] == b'-';
        let right_ok = pair[1].is_ascii_lowercase() || pair[1].is_ascii_digit() || pair[1] == b'-';
        if !left_ok || !right_ok {
            return Err("Runtime dependency manifest Skill name 包含非法字符".to_string());
        }
        if pair[0] == b'-' && pair[1] == b'-' {
            return Err("Runtime dependency manifest Skill name 不能包含连续连字符".to_string());
        }
    }
    Ok(())
}

/// 校验 project Skill snapshot（manifest v4 新增）。责任边界与 TS decoder 一致：
/// 只校验字段 exact-fields、类型、文本上限、64 位小写 hex contentSha256、
/// name 唯一性、ASCII name 规范排序；不读取工作区文件、不解析 frontmatter、
/// 不重算 digest。
fn validate_skills(value: &Value) -> Result<(), String> {
    let snapshot = value
        .as_object()
        .ok_or_else(|| "Runtime dependency manifest skills 必须是对象".to_string())?;
    validate_exact_fields(snapshot, &["schemaVersion", "skills"], "Skills")?;
    if snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Runtime dependency manifest skills.schemaVersion 无效".to_string());
    }
    let skills = snapshot
        .get("skills")
        .and_then(Value::as_array)
        .ok_or_else(|| "Runtime dependency manifest skills 数组无效".to_string())?;
    if skills.len() > 32 {
        return Err("Runtime dependency manifest 项目 Skill 数量超过安全上限".to_string());
    }
    let mut previous_name: Option<&str> = None;
    for skill in skills {
        let skill_object = skill
            .as_object()
            .ok_or_else(|| "Runtime dependency manifest Skill 无效".to_string())?;
        validate_exact_fields(
            skill_object,
            &[
                "name",
                "description",
                "source",
                "relativePath",
                "baseRelativePath",
                "contentSha256",
                "disableModelInvocation",
            ],
            "Skill",
        )?;
        let name = required_non_empty_string(skill, "name")?;
        validate_skill_name(name)?;
        validate_bounded_text(
            "Runtime manifest Skill description",
            required_non_empty_string(skill, "description")?,
            1024,
            false,
        )?;
        let source = skill
            .get("source")
            .and_then(Value::as_object)
            .ok_or_else(|| "Runtime dependency manifest Skill source 无效".to_string())?;
        validate_exact_fields(source, &["kind", "root"], "Skill source")?;
        if required_non_empty_string(&Value::Object(source.clone()), "kind")? != "project"
            || required_non_empty_string(&Value::Object(source.clone()), "root")? != ".axiom/skills"
        {
            return Err("Runtime dependency manifest Skill source 非法".to_string());
        }
        validate_bounded_text(
            "Runtime manifest Skill relativePath",
            required_non_empty_string(skill, "relativePath")?,
            512,
            false,
        )?;
        validate_bounded_text(
            "Runtime manifest Skill baseRelativePath",
            required_non_empty_string(skill, "baseRelativePath")?,
            512,
            true,
        )?;
        let digest = required_non_empty_string(skill, "contentSha256")?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()) {
            return Err("Runtime dependency manifest Skill contentSha256 必须为 64 位小写十六进制".to_string());
        }
        if skill
            .get("disableModelInvocation")
            .and_then(Value::as_bool)
            .is_none()
        {
            return Err("Runtime dependency manifest Skill disableModelInvocation 必须是布尔值".to_string());
        }
        if let Some(previous) = previous_name {
            if previous >= name {
                return Err("Runtime dependency manifest Skill 未按 ASCII name 规范顺序排列".to_string());
            }
        }
        previous_name = Some(name);
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReasoningState {
    level: String,
    mode: Option<String>,
    budget_tokens: Option<u64>,
}

/// 校验标识符格式:非空、长度 ≤ 160、仅允许 `[A-Za-z0-9\-_:.]`。
///
/// 原本在 `session_repository` 与 `session_mutations` 各有一份完全相同的
/// 实现,现统一为单一来源。
pub(crate) fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(format!("{label} 格式无效"));
    }
    Ok(())
}

/// 文本边界校验:可配置是否允许为空、长度上限、禁止 NUL 字节。
pub(crate) fn validate_bounded_text(
    label: &str,
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<(), String> {
    if (!allow_empty && value.trim().is_empty()) || value.len() > max_bytes || value.contains('\0')
    {
        return Err(format!("{label} 格式无效或超过安全上限"));
    }
    Ok(())
}

pub(crate) fn required_non_empty_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Runtime dependency manifest 缺少有效的 {field}"))
}

pub(crate) fn validate_exact_fields(
    value: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> Result<(), String> {
    let unexpected = value
        .keys()
        .filter(|field| !allowed.contains(&field.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if unexpected.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Runtime dependency manifest {label} 包含未知字段：{}",
            unexpected.join(", ")
        ))
    }
}

pub(crate) fn validate_reasoning(value: &str) -> Result<(), String> {
    validate_bounded_text("Reasoning JSON", value, 16 * 1024, false)?;
    let reasoning: ReasoningState = serde_json::from_str(value)
        .map_err(|error| format!("Runtime mutation Reasoning JSON 无效：{error}"))?;
    if !matches!(
        reasoning.level.as_str(),
        "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) || reasoning
        .mode
        .as_deref()
        .is_some_and(|mode| !matches!(mode, "effort" | "enabled" | "adaptive"))
        || reasoning.budget_tokens == Some(0)
    {
        return Err("Runtime mutation Reasoning 状态无效".to_string());
    }
    Ok(())
}

/// 校验 Runtime dependency manifest JSON 并返回解析后的 `Value`。
///
/// 由 `session_repository`(`initialize_runtime_defaults` /
/// `update_runtime_config`)与 `session_mutations`(`validate_request`)
/// 共同调用,是原先循环依赖的唯一入口。
pub(crate) fn validate_runtime_manifest(
    value: &str,
    active_tool_names: &[String],
) -> Result<Value, String> {
    validate_bounded_text("Runtime manifest JSON", value, 256 * 1024, false)?;
    let manifest: Value = serde_json::from_str(value)
        .map_err(|error| format!("Runtime dependency manifest JSON 无效：{error}"))?;
    let object = manifest
        .as_object()
        .ok_or_else(|| "Runtime dependency manifest 必须是对象".to_string())?;
    validate_exact_fields(object, &["schemaVersion", "provider", "tools", "hooks", "skills"], "")?;
    if object.get("schemaVersion").and_then(Value::as_u64)
        != Some(RUNTIME_DEPENDENCY_SCHEMA_VERSION)
    {
        return Err("Runtime dependency manifest schemaVersion 无效".to_string());
    }
    let provider = object
        .get("provider")
        .and_then(Value::as_object)
        .ok_or_else(|| "Runtime dependency manifest Provider 无效".to_string())?;
    validate_exact_fields(
        provider,
        &["providerId", "apiFormat", "modelId", "transportVersion"],
        "Provider",
    )?;
    let provider = Value::Object(provider.clone());
    for (field, maximum) in [
        ("providerId", 128),
        ("apiFormat", 64),
        ("modelId", 256),
        ("transportVersion", 128),
    ] {
        validate_bounded_text(
            &format!("Runtime manifest Provider {field}"),
            required_non_empty_string(&provider, field)?,
            maximum,
            false,
        )?;
    }
    if !matches!(
        required_non_empty_string(&provider, "apiFormat")?,
        "demo" | "openai-compatible" | "openai-responses" | "anthropic-compatible"
    ) {
        return Err("Runtime dependency manifest apiFormat 无效".to_string());
    }

    let tools = object
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "Runtime dependency manifest tools 无效".to_string())?;
    if tools.len() > 256 {
        return Err("Runtime dependency manifest 工具数量超过安全上限".to_string());
    }
    let mut tool_names = HashSet::new();
    for tool in tools {
        let tool_object = tool
            .as_object()
            .ok_or_else(|| "Runtime dependency manifest 工具无效".to_string())?;
        validate_exact_fields(tool_object, &["name", "version", "recoveryPolicy"], "工具")?;
        let name = required_non_empty_string(tool, "name")?;
        validate_bounded_text("Runtime manifest 工具名称", name, 128, false)?;
        validate_bounded_text(
            "Runtime manifest 工具版本",
            required_non_empty_string(tool, "version")?,
            128,
            false,
        )?;
        if !matches!(
            required_non_empty_string(tool, "recoveryPolicy")?,
            "never" | "idempotent"
        ) {
            return Err("Runtime dependency manifest recoveryPolicy 无效".to_string());
        }
        if !tool_names.insert(name) {
            return Err("Runtime dependency manifest 包含重复工具".to_string());
        }
    }
    if active_tool_names
        .iter()
        .any(|name| !tool_names.contains(name.as_str()))
    {
        return Err("Runtime dependency manifest 缺少活动工具".to_string());
    }

    let hooks = object
        .get("hooks")
        .and_then(Value::as_array)
        .ok_or_else(|| "Runtime dependency manifest hooks 无效".to_string())?;
    if hooks.len() > 256 {
        return Err("Runtime dependency manifest Hook 数量超过安全上限".to_string());
    }
    let mut hook_ids = HashSet::new();
    for hook in hooks {
        let hook_object = hook
            .as_object()
            .ok_or_else(|| "Runtime dependency manifest Hook 无效".to_string())?;
        validate_exact_fields(hook_object, &["id", "version", "fingerprint"], "Hook")?;
        let id = required_non_empty_string(hook, "id")?;
        validate_bounded_text("Runtime manifest Hook ID", id, 128, false)?;
        validate_bounded_text(
            "Runtime manifest Hook 版本",
            required_non_empty_string(hook, "version")?,
            128,
            false,
        )?;
        validate_bounded_text(
            "Runtime manifest Hook fingerprint",
            required_non_empty_string(hook, "fingerprint")?,
            1024,
            false,
        )?;
        if !hook_ids.insert(id) {
            return Err("Runtime dependency manifest 包含重复 Hook".to_string());
        }
    }

    validate_skills(
        object
            .get("skills")
            .ok_or_else(|| "Runtime dependency manifest 缺少 skills".to_string())?,
    )?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 构造单个 project Skill 快照（满足校验的合法形态；digest 为 64 位小写 hex）。
    fn skill_json(name: &str) -> Value {
        json!({
            "name": name,
            "description": "desc",
            "source": { "kind": "project", "root": ".axiom/skills" },
            "relativePath": ".axiom/skills/".to_owned() + name + "/SKILL.md",
            "baseRelativePath": ".axiom/skills",
            "contentSha256": "a".repeat(64),
            "disableModelInvocation": false,
        })
    }

    /// 最小合法 manifest（无工具/Hook/Skill）。
    fn base_manifest() -> Value {
        json!({
            "schemaVersion": RUNTIME_DEPENDENCY_SCHEMA_VERSION,
            "provider": {
                "providerId": "demo",
                "apiFormat": "demo",
                "modelId": "demo",
                "transportVersion": "1",
            },
            "tools": [],
            "hooks": [],
            "skills": { "schemaVersion": 1, "skills": [] },
        })
    }

    #[test]
    fn skill_name_accepts_lowercase_digits_and_hyphens() {
        assert!(validate_skill_name("greeting").is_ok());
        assert!(validate_skill_name("my-skill-2").is_ok());
        assert!(validate_skill_name("a").is_ok());
        assert!(validate_skill_name(&"x".repeat(64)).is_ok());
    }

    #[test]
    fn skill_name_rejects_bad_shapes() {
        // 对齐 TS 侧 parser（frontmatter name 白名单）：空/超长/大写开头/
        // 首尾连字符/连续连字符/非法字符/非 ASCII。
        assert!(validate_skill_name("").is_err());
        assert!(validate_skill_name(&"x".repeat(65)).is_err());
        assert!(validate_skill_name("Upper").is_err());
        assert!(validate_skill_name("-lead").is_err());
        assert!(validate_skill_name("trail-").is_err());
        assert!(validate_skill_name("double--dash").is_err());
        assert!(validate_skill_name("under_score").is_err());
        assert!(validate_skill_name("has space").is_err());
        assert!(validate_skill_name("中文").is_err());
    }

    #[test]
    fn identifier_allows_alnum_and_separators() {
        assert!(validate_identifier("label", "m-abc_1:2.3").is_ok());
        assert!(validate_identifier("label", "run:abc-def").is_ok());
    }

    #[test]
    fn identifier_rejects_empty_long_and_illegal_chars() {
        assert!(validate_identifier("label", "").is_err());
        assert!(validate_identifier("label", &"x".repeat(161)).is_err());
        assert!(validate_identifier("label", "has space").is_err());
        assert!(validate_identifier("label", "含中文").is_err());
        assert!(validate_identifier("label", "slash/path").is_err());
    }

    #[test]
    fn bounded_text_enforces_empty_max_and_nul() {
        assert!(validate_bounded_text("t", "", 10, false).is_err());
        assert!(validate_bounded_text("t", "  ", 10, false).is_err());
        assert!(validate_bounded_text("t", "", 10, true).is_ok());
        assert!(validate_bounded_text("t", "abc", 2, false).is_err());
        assert!(validate_bounded_text("t", "a\0b", 10, false).is_err());
    }

    #[test]
    fn exact_fields_rejects_unknown_keys() {
        let dirty: Map<String, Value> =
            serde_json::from_str(r#"{"name":"x","extra":1}"#).unwrap();
        assert!(validate_exact_fields(&dirty, &["name"], "标签").is_err());
        let clean: Map<String, Value> = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert!(validate_exact_fields(&clean, &["name"], "标签").is_ok());
    }

    #[test]
    fn minimal_manifest_is_valid() {
        let manifest = base_manifest().to_string();
        assert!(validate_runtime_manifest(&manifest, &[]).is_ok());
    }

    #[test]
    fn manifest_rejects_wrong_schema_and_unknown_top_level() {
        let mut wrong_schema = base_manifest();
        wrong_schema["schemaVersion"] = json!(3);
        assert!(validate_runtime_manifest(&wrong_schema.to_string(), &[]).is_err());

        let mut unknown = base_manifest();
        unknown["extra"] = json!(1);
        assert!(validate_runtime_manifest(&unknown.to_string(), &[]).is_err());
    }

    #[test]
    fn manifest_rejects_illegal_provider_api_format() {
        let mut bad = base_manifest();
        bad["provider"]["apiFormat"] = json!("http-any");
        assert!(validate_runtime_manifest(&bad.to_string(), &[]).is_err());
    }

    #[test]
    fn manifest_rejects_duplicate_tool_missing_active_and_bad_policy() {
        let mut dup = base_manifest();
        dup["tools"] = json!([
            { "name": "read", "version": "1", "recoveryPolicy": "never" },
            { "name": "read", "version": "1", "recoveryPolicy": "never" },
        ]);
        assert!(validate_runtime_manifest(&dup.to_string(), &[]).is_err());

        let mut missing_active = base_manifest();
        missing_active["tools"] = json!([
            { "name": "read", "version": "1", "recoveryPolicy": "never" },
        ]);
        assert!(
            validate_runtime_manifest(&missing_active.to_string(), &["write".to_string()]).is_err()
        );

        let mut bad_policy = base_manifest();
        bad_policy["tools"] = json!([
            { "name": "read", "version": "1", "recoveryPolicy": "once" },
        ]);
        assert!(validate_runtime_manifest(&bad_policy.to_string(), &[]).is_err());
    }

    #[test]
    fn manifest_rejects_duplicate_hooks() {
        let mut dup = base_manifest();
        dup["hooks"] = json!([
            { "id": "h1", "version": "1", "fingerprint": "fp" },
            { "id": "h1", "version": "2", "fingerprint": "fp2" },
        ]);
        assert!(validate_runtime_manifest(&dup.to_string(), &[]).is_err());
    }

    #[test]
    fn skills_reject_bad_digest_out_of_order_and_overflow() {
        // 乱序（必须 ASCII name 升序）。
        let mut unordered = base_manifest();
        unordered["skills"] = json!({
            "schemaVersion": 1,
            "skills": [skill_json("b-skill"), skill_json("a-skill")],
        });
        assert!(validate_runtime_manifest(&unordered.to_string(), &[]).is_err());

        // contentSha256 非 64 位小写 hex。
        let mut bad_digest = base_manifest();
        let mut bad_skill = skill_json("a-skill");
        bad_skill["contentSha256"] = json!("ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789");
        bad_digest["skills"] = json!({ "schemaVersion": 1, "skills": [bad_skill] });
        assert!(validate_runtime_manifest(&bad_digest.to_string(), &[]).is_err());

        // 数量超过安全上限 32。
        let many: Vec<Value> = (0..33).map(|i| skill_json(&format!("skill-{i:02}"))).collect();
        let mut overflow = base_manifest();
        overflow["skills"] = json!({ "schemaVersion": 1, "skills": many });
        assert!(validate_runtime_manifest(&overflow.to_string(), &[]).is_err());
    }

    #[test]
    fn reasoning_rejects_illegal_levels_and_zero_budget() {
        assert!(validate_reasoning(r#"{"level":"medium"}"#).is_ok());
        assert!(validate_reasoning(r#"{"level":"insane"}"#).is_err());
        assert!(validate_reasoning(r#"{"level":"high","mode":"weird"}"#).is_err());
        assert!(validate_reasoning(r#"{"level":"high","budgetTokens":0}"#).is_err());
        assert!(validate_reasoning("not json").is_err());
    }
}



