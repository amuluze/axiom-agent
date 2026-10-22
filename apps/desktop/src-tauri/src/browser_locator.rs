//! 结构化 Locator 解析（U1-1）的纯逻辑部分：匹配规则、歧义判定与 testId 选择器转义。
//!
//! CDP 取数（AX 全树、DOM 查询）留在 `browser_session.rs`，这里只接收已取回的候选，
//! 因此匹配语义可以脱离浏览器单测。解析基于服务端完整树，与 snapshot 的截断预算无关。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 歧义时返回的候选摘要上限：足够定位问题，又不把整页内容塞进结果。
pub(crate) const MAX_LOCATOR_CANDIDATES: usize = 5;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocatorSpec {
    #[serde(default)]
    pub(crate) test_id: Option<String>,
    #[serde(default)]
    pub(crate) role: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) css: Option<String>,
    #[serde(default)]
    pub(crate) exact: bool,
}

impl LocatorSpec {
    pub(crate) fn has_dom_criteria(&self) -> bool {
        self.test_id.is_some() || self.css.is_some()
    }

    pub(crate) fn has_ax_criteria(&self) -> bool {
        self.role.is_some() || self.name.is_some() || self.label.is_some() || self.text.is_some()
    }

    /// 至少需要一个定位字段；空白字符串视为未提供，避免“匹配一切”的宽定位。
    pub(crate) fn validate(&self) -> Result<(), String> {
        let fields = [
            &self.test_id,
            &self.role,
            &self.name,
            &self.label,
            &self.text,
            &self.css,
        ];
        let mut any = false;
        for field in fields.into_iter().flatten() {
            if field.trim().is_empty() {
                return Err("定位字段不能为空白".to_string());
            }
            any = true;
        }
        if any {
            Ok(())
        } else {
            Err("定位器至少需要一个定位字段".to_string())
        }
    }
}

/// AX 树中一个可交互/可读节点的已提取字段。`backend_node_id` 即 ref。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AxCandidate {
    pub(crate) backend_node_id: i64,
    pub(crate) role: String,
    pub(crate) name: String,
    pub(crate) value: Option<String>,
    pub(crate) disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocatorCandidate {
    #[serde(rename = "ref")]
    #[specta(type = specta_typescript::Number)]
    pub(crate) ref_id: i64,
    pub(crate) role: String,
    pub(crate) name: String,
    pub(crate) value: Option<String>,
    pub(crate) disabled: bool,
}

impl From<&AxCandidate> for LocatorCandidate {
    fn from(candidate: &AxCandidate) -> Self {
        Self {
            ref_id: candidate.backend_node_id,
            role: candidate.role.clone(),
            name: candidate.name.clone(),
            value: candidate.value.clone(),
            disabled: candidate.disabled,
        }
    }
}

/// 解析结果。`Unique` 才允许执行动作；`Ambiguous` 禁止默认取第一个。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum LocatorResolution {
    NotFound,
    Unique {
        candidate: LocatorCandidate,
    },
    Ambiguous {
        #[specta(type = specta_typescript::Number)]
        total: usize,
        candidates: Vec<LocatorCandidate>,
    },
}

/// `testId` 与 `css` 经 DOM 域解析出的 backend node 集合；由调用方通过 CDP 取得。
pub(crate) fn test_id_selector(test_id: &str) -> Result<String, String> {
    if test_id.chars().any(char::is_control) {
        return Err("testId 不能包含控制字符".to_string());
    }
    let escaped = test_id.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("[data-testid=\"{escaped}\"]"))
}

fn matches_text(haystack: &str, needle: &str, exact: bool) -> bool {
    let haystack = haystack.trim();
    let needle = needle.trim();
    if exact {
        haystack == needle
    } else {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    }
}

/// 逐字段过滤 AX 候选：同一字段内的匹配规则由 `exact` 统一决定。
/// `text` 同时匹配可访问名称与控件值（例如输入框当前内容）。
fn ax_matches(spec: &LocatorSpec, candidate: &AxCandidate) -> bool {
    if let Some(role) = &spec.role {
        if !candidate.role.eq_ignore_ascii_case(role.trim()) {
            return false;
        }
    }
    // AX 树没有独立的 label 节点：表单控件的可访问名称即由 <label> 派生，因此 label 与 name 同义。
    for needle in [&spec.name, &spec.label].into_iter().flatten() {
        if !matches_text(&candidate.name, needle, spec.exact) {
            return false;
        }
    }
    if let Some(text) = &spec.text {
        let in_name = matches_text(&candidate.name, text, spec.exact);
        let in_value = candidate
            .value
            .as_deref()
            .is_some_and(|value| matches_text(value, text, spec.exact));
        if !in_name && !in_value {
            return false;
        }
    }
    true
}

/// 合并各来源的候选并判定唯一性。`dom_hits` 仅在规格含 testId/css 时由调用方提供。
pub(crate) fn resolve_locator(
    spec: &LocatorSpec,
    ax_candidates: &[AxCandidate],
    dom_hits: Option<&HashSet<i64>>,
) -> Result<LocatorResolution, String> {
    spec.validate()?;
    if spec.has_dom_criteria() && dom_hits.is_none() {
        return Err("缺少 DOM 域的命中结果".to_string());
    }

    let matched: Vec<&AxCandidate> = ax_candidates
        .iter()
        .filter(|candidate| {
            let in_dom = dom_hits.is_none_or(|hits| hits.contains(&candidate.backend_node_id));
            // 只有 DOM 型定位器时没有 AX 过滤条件，任何 AX 节点都可通过（由 DOM 命中决定）。
            let in_ax = !spec.has_ax_criteria() || ax_matches(spec, candidate);
            in_dom && in_ax
        })
        .collect();

    // 纯 DOM 定位器的命中可能不在 AX 树中（如无语义的 div），不能依赖 AX 候选取值：
    // 以 DOM 命中集合为准，AX 可用时补全角色与名称，否则留空。
    if !spec.has_ax_criteria() {
        let mut refs: Vec<i64> = dom_hits
            .map(|hits| hits.iter().copied().collect())
            .unwrap_or_default();
        refs.sort_unstable();
        let candidate_for =
            |ref_id: i64| match ax_candidates.iter().find(|c| c.backend_node_id == ref_id) {
                Some(candidate) => LocatorCandidate::from(candidate),
                None => LocatorCandidate {
                    ref_id,
                    role: String::new(),
                    name: String::new(),
                    value: None,
                    disabled: false,
                },
            };
        return Ok(match refs.len() {
            0 => LocatorResolution::NotFound,
            1 => LocatorResolution::Unique {
                candidate: candidate_for(refs[0]),
            },
            total => LocatorResolution::Ambiguous {
                total,
                candidates: refs
                    .iter()
                    .take(MAX_LOCATOR_CANDIDATES)
                    .map(|ref_id| candidate_for(*ref_id))
                    .collect(),
            },
        });
    }

    Ok(match matched.len() {
        0 => LocatorResolution::NotFound,
        1 => LocatorResolution::Unique {
            candidate: LocatorCandidate::from(matched[0]),
        },
        total => LocatorResolution::Ambiguous {
            total,
            candidates: matched
                .iter()
                .take(MAX_LOCATOR_CANDIDATES)
                .map(|candidate| LocatorCandidate::from(*candidate))
                .collect(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ax(id: i64, role: &str, name: &str, value: Option<&str>) -> AxCandidate {
        AxCandidate {
            backend_node_id: id,
            role: role.to_string(),
            name: name.to_string(),
            value: value.map(str::to_string),
            disabled: false,
        }
    }

    fn spec() -> LocatorSpec {
        LocatorSpec::default()
    }

    #[test]
    fn rejects_empty_and_blank_locators() {
        assert!(spec().validate().is_err());
        let blank = LocatorSpec {
            name: Some("   ".into()),
            ..spec()
        };
        assert_eq!(blank.validate(), Err("定位字段不能为空白".to_string()));
    }

    #[test]
    fn zero_matches_is_an_explicit_not_found() {
        let candidates = [ax(1, "button", "提交", None)];
        let spec = LocatorSpec {
            role: Some("textbox".into()),
            ..spec()
        };
        assert_eq!(
            resolve_locator(&spec, &candidates, None),
            Ok(LocatorResolution::NotFound)
        );
    }

    #[test]
    fn unique_match_returns_the_backend_node_as_ref() {
        let candidates = [
            ax(7, "textbox", "优惠券代码", None),
            ax(8, "button", "应用", None),
        ];
        let spec = LocatorSpec {
            role: Some("textbox".into()),
            name: Some("优惠券".into()),
            ..spec()
        };
        let resolution = resolve_locator(&spec, &candidates, None).unwrap();
        match resolution {
            LocatorResolution::Unique { candidate } => assert_eq!(candidate.ref_id, 7),
            other => panic!("expected unique, got {other:?}"),
        }
    }

    #[test]
    fn multiple_matches_are_ambiguous_and_never_pick_the_first() {
        let candidates = [
            ax(1, "button", "删除", None),
            ax(2, "button", "删除订单", None),
        ];
        let spec = LocatorSpec {
            role: Some("button".into()),
            name: Some("删除".into()),
            ..spec()
        };
        match resolve_locator(&spec, &candidates, None).unwrap() {
            LocatorResolution::Ambiguous { total, candidates } => {
                assert_eq!(total, 2);
                assert_eq!(candidates.len(), 2);
            }
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn exact_requires_equality_while_default_is_case_insensitive_containment() {
        let candidates = [ax(1, "button", "Submit Order", None)];
        let contains = LocatorSpec {
            name: Some("submit".into()),
            ..spec()
        };
        assert!(matches!(
            resolve_locator(&contains, &candidates, None),
            Ok(LocatorResolution::Unique { .. })
        ));
        let exact = LocatorSpec {
            name: Some("submit".into()),
            exact: true,
            ..spec()
        };
        assert_eq!(
            resolve_locator(&exact, &candidates, None),
            Ok(LocatorResolution::NotFound)
        );
    }

    #[test]
    fn text_matches_either_the_accessible_name_or_the_control_value() {
        let candidates = [ax(3, "textbox", "金额", Some("¥240.00"))];
        let spec = LocatorSpec {
            text: Some("¥240.00".into()),
            exact: true,
            ..spec()
        };
        assert!(matches!(
            resolve_locator(&spec, &candidates, None),
            Ok(LocatorResolution::Unique { .. })
        ));
    }

    #[test]
    fn dom_hits_intersect_with_accessibility_criteria() {
        let candidates = [ax(1, "button", "保存", None), ax(2, "button", "保存", None)];
        let hits: HashSet<i64> = [2].into_iter().collect();
        let spec = LocatorSpec {
            test_id: Some("save".into()),
            role: Some("button".into()),
            name: Some("保存".into()),
            ..spec()
        };
        match resolve_locator(&spec, &candidates, Some(&hits)).unwrap() {
            LocatorResolution::Unique { candidate } => assert_eq!(candidate.ref_id, 2),
            other => panic!("expected unique, got {other:?}"),
        }
    }

    #[test]
    fn dom_only_locators_count_hits_without_an_accessibility_entry() {
        let hits: HashSet<i64> = [40, 41].into_iter().collect();
        let spec = LocatorSpec {
            css: Some("div.row".into()),
            ..spec()
        };
        assert!(matches!(
            resolve_locator(&spec, &[], Some(&hits)),
            Ok(LocatorResolution::Ambiguous { total: 2, .. })
        ));
    }

    #[test]
    fn dom_criteria_without_hits_fail_closed() {
        let spec = LocatorSpec {
            test_id: Some("x".into()),
            ..spec()
        };
        assert!(resolve_locator(&spec, &[], None).is_err());
    }

    #[test]
    fn test_id_selector_escapes_quotes_and_backslashes() {
        assert_eq!(
            test_id_selector("a\"b\\c").unwrap(),
            "[data-testid=\"a\\\"b\\\\c\"]"
        );
        assert!(test_id_selector("a\nb").is_err());
    }

    #[test]
    fn a_unique_dom_hit_without_accessibility_entry_still_resolves() {
        let hits: HashSet<i64> = [55].into_iter().collect();
        let spec = LocatorSpec {
            test_id: Some("row-7".into()),
            ..spec()
        };
        match resolve_locator(&spec, &[], Some(&hits)).unwrap() {
            LocatorResolution::Unique { candidate } => {
                assert_eq!(candidate.ref_id, 55);
                assert!(candidate.role.is_empty());
            }
            other => panic!("expected unique, got {other:?}"),
        }
    }
}
