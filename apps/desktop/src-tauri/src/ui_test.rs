//! UI 读步骤（U1-3）的判定逻辑。首次 verdict 在这里产生，模型与 WebView 都不能覆盖。
//!
//! 取样（URL、定位结果、元素事实）在 `browser_session.rs` 完成；这里只做纯函数判定，
//! 因此每条断言语义都能脱离浏览器单测。`UiExpectation` 的 JSON 形状是外部标签的单键对象，
//! 与 `agent/testing/spec/types.ts` 的 `UiExpectation` 逐字一致。

use serde::{Deserialize, Serialize};

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};

use crate::artifacts::{register_artifact_metadata, write_image_artifact_at, ArtifactMetadata};
use crate::browser_locator::{LocatorResolution, LocatorSpec};
use crate::browser_session::{
    dispatch_browser_command, read_ui_snapshot, BrowserCommandRequest, BrowserCommandResponse,
    BrowserSessionState,
};
use crate::session_state::SessionRepositoryState;
use crate::test_target::{origin_of, TestTargetGrants};
use crate::workspace_access::{authorized_root, WorkspaceAccessState};

/// 元素事实：由 AX 树提取。`text` 为子树内静态文本拼接；无 AX 映射的 DOM 命中留空。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct UiElementFacts {
    pub(crate) role: String,
    pub(crate) name: String,
    pub(crate) text: String,
    pub(crate) value: Option<String>,
    pub(crate) disabled: bool,
    pub(crate) hidden: bool,
}

/// 单次取样结果。`match_count` 与 `resolution` 同源：NotFound=0、Unique=1、Ambiguous=total。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UiReadSnapshot {
    pub(crate) url: String,
    pub(crate) resolution: Option<LocatorResolution>,
    pub(crate) element: Option<UiElementFacts>,
}

impl UiReadSnapshot {
    pub(crate) fn match_count(&self) -> usize {
        match &self.resolution {
            None | Some(LocatorResolution::NotFound) => 0,
            Some(LocatorResolution::Unique { .. }) => 1,
            Some(LocatorResolution::Ambiguous { total, .. }) => *total,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UiExpectation {
    Exists(bool),
    Visible(bool),
    Enabled(bool),
    TextEquals(String),
    TextContains(String),
    ValueEquals(String),
    UrlEquals(String),
    UrlContains(String),
    Count(u64),
}

impl UiExpectation {
    /// 作用于元素的断言需要定位器；URL 断言不需要。
    pub(crate) fn needs_locator(&self) -> bool {
        !matches!(self, Self::UrlEquals(_) | Self::UrlContains(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub(crate) enum UiVerdict {
    /// 断言成立。
    Passed,
    /// 定位与环境正常，但断言不成立。
    Failed { message: String },
    /// 无法判定：定位歧义、定位失败（非 exists/count 断言）或取样失败。
    Error { message: String },
}

/// 折叠空白后比较文本，避免换行与缩进差异造成误判。
fn normalize_text(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 按断言求值。元素断言在定位歧义时一律返回 Error，绝不挑选第一个候选。
pub(crate) fn evaluate(expect: &UiExpectation, snapshot: &UiReadSnapshot) -> UiVerdict {
    match expect {
        UiExpectation::UrlEquals(expected) => {
            url_verdict(&snapshot.url == expected, &snapshot.url, expected, "等于")
        }
        UiExpectation::UrlContains(expected) => url_verdict(
            snapshot.url.contains(expected.as_str()),
            &snapshot.url,
            expected,
            "包含",
        ),
        UiExpectation::Exists(expected) => {
            let found = match &snapshot.resolution {
                None | Some(LocatorResolution::NotFound) => false,
                Some(LocatorResolution::Unique { .. }) => true,
                Some(LocatorResolution::Ambiguous { .. }) => {
                    return UiVerdict::Error {
                        message: "定位歧义，无法判定存在性".to_string(),
                    }
                }
            };
            if found == *expected {
                UiVerdict::Passed
            } else {
                UiVerdict::Failed {
                    message: format!("期望 exists={expected}，实际 exists={found}"),
                }
            }
        }
        UiExpectation::Count(expected) => {
            let actual = snapshot.match_count() as u64;
            if actual == *expected {
                UiVerdict::Passed
            } else {
                UiVerdict::Failed {
                    message: format!("期望匹配数 {expected}，实际 {actual}"),
                }
            }
        }
        _ => evaluate_element(expect, snapshot),
    }
}

fn url_verdict(matched: bool, actual: &str, expected: &str, relation: &str) -> UiVerdict {
    if matched {
        UiVerdict::Passed
    } else {
        UiVerdict::Failed {
            message: format!("URL 期望{relation} {expected}，实际 {actual}"),
        }
    }
}

fn evaluate_element(expect: &UiExpectation, snapshot: &UiReadSnapshot) -> UiVerdict {
    match &snapshot.resolution {
        None => {
            return UiVerdict::Error {
                message: "元素断言缺少定位器".to_string(),
            }
        }
        Some(LocatorResolution::NotFound) => {
            return UiVerdict::Error {
                message: "定位失败：零匹配".to_string(),
            }
        }
        Some(LocatorResolution::Ambiguous { total, .. }) => {
            return UiVerdict::Error {
                message: format!("定位歧义：{total} 个候选"),
            }
        }
        Some(LocatorResolution::Unique { .. }) => {}
    }
    let Some(element) = &snapshot.element else {
        return UiVerdict::Error {
            message: "定位成功但缺少元素事实".to_string(),
        };
    };
    let failed = |message: String| UiVerdict::Failed { message };
    match expect {
        UiExpectation::Visible(expected) => {
            let visible = !element.hidden;
            if visible == *expected {
                UiVerdict::Passed
            } else {
                failed(format!("期望 visible={expected}，实际 visible={visible}"))
            }
        }
        UiExpectation::Enabled(expected) => {
            let enabled = !element.disabled;
            if enabled == *expected {
                UiVerdict::Passed
            } else {
                failed(format!("期望 enabled={expected}，实际 enabled={enabled}"))
            }
        }
        UiExpectation::TextEquals(expected) => {
            let actual = normalize_text(&element.text);
            if actual == normalize_text(expected) {
                UiVerdict::Passed
            } else {
                failed(format!("文本期望等于「{expected}」，实际「{actual}」"))
            }
        }
        UiExpectation::TextContains(expected) => {
            let actual = normalize_text(&element.text);
            if actual.contains(&normalize_text(expected)) {
                UiVerdict::Passed
            } else {
                failed(format!("文本期望包含「{expected}」，实际「{actual}」"))
            }
        }
        UiExpectation::ValueEquals(expected) => {
            let actual = element.value.clone().unwrap_or_default();
            if actual == *expected {
                UiVerdict::Passed
            } else {
                failed(format!("value 期望「{expected}」，实际「{actual}」"))
            }
        }
        // 上面已分流，这里只为穷尽匹配；URL 与 exists/count 不会走到元素分支。
        UiExpectation::Exists(_)
        | UiExpectation::Count(_)
        | UiExpectation::UrlEquals(_)
        | UiExpectation::UrlContains(_) => UiVerdict::Error {
            message: "断言分流错误".to_string(),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UiReadMode {
    /// 单次判定：未满足即 failed/error，不等待。
    Assert,
    /// 轮询至满足或超时：未满足的定位与断言结果都视为"尚未命中"，只有授权/取样失败是终态。
    Wait,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiExtraction {
    source: String,
    #[serde(default)]
    sensitive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiExtractedTestValue {
    value: String,
    sensitive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiReadStepResult {
    #[serde(flatten)]
    verdict: UiVerdict,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    extracted: BTreeMap<String, UiExtractedTestValue>,
}

const DEFAULT_READ_TIMEOUT_MS: u64 = 5_000;
const MAX_READ_TIMEOUT_MS: u64 = 120_000;
const READ_POLL_INTERVAL_MS: u64 = 250;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiReadStepRequest {
    run_id: String,
    tab_id: String,
    #[serde(default)]
    locator: Option<LocatorSpec>,
    expect: UiExpectation,
    mode: UiReadMode,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    extract: BTreeMap<String, UiExtraction>,
}

/// 单次取样 → 授权校验 → 判定。返回 Err 表示授权或取样本身失败（终态，不因 wait 继续轮询）。
async fn sample_and_judge(
    app: &AppHandle,
    browser: &BrowserSessionState,
    workspace: &WorkspaceAccessState,
    grants: &TestTargetGrants,
    request: &UiReadStepRequest,
) -> Result<(UiVerdict, UiReadSnapshot), String> {
    if request.expect.needs_locator() && request.locator.is_none() {
        return Err("元素断言缺少定位器".to_string());
    }
    let snapshot =
        read_ui_snapshot(app, browser, &request.tab_id, request.locator.as_ref()).await?;
    verify_test_grant(
        workspace,
        grants,
        &request.run_id,
        &request.tab_id,
        &snapshot.url,
    )?;
    Ok((evaluate(&request.expect, &snapshot), snapshot))
}

fn extract_ui_values(
    extractions: &BTreeMap<String, UiExtraction>,
    snapshot: &UiReadSnapshot,
) -> Result<BTreeMap<String, UiExtractedTestValue>, String> {
    if extractions.is_empty() {
        return Ok(BTreeMap::new());
    }
    if extractions.len() > 64 || extractions.keys().any(|name| !valid_variable_name(name)) {
        return Err("UI 提取变量配置无效".to_string());
    }
    if !matches!(&snapshot.resolution, Some(LocatorResolution::Unique { .. })) {
        return Err("UI 变量提取需要唯一命中的元素".to_string());
    }
    let element = snapshot
        .element
        .as_ref()
        .ok_or_else(|| "UI 变量提取需要唯一命中的元素".to_string())?;
    let mut extracted = BTreeMap::new();
    for (name, extraction) in extractions {
        let value = match extraction.source.as_str() {
            "text" => normalize_text(&element.text),
            "value" => element
                .value
                .clone()
                .ok_or_else(|| format!("元素缺少 value，无法提取变量「{name}」"))?,
            _ => return Err("UI 变量提取来源无效".to_string()),
        };
        extracted.insert(
            name.clone(),
            UiExtractedTestValue {
                value,
                sensitive: extraction.sensitive,
            },
        );
    }
    Ok(extracted)
}

fn valid_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
        && name.len() <= 64
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// 每次取样后重新校验授权：origin 以当前 URL 为准，工作区代际以当前值为准（U1-2 故障即关闭）。
pub(crate) fn verify_test_grant(
    workspace: &WorkspaceAccessState,
    grants: &TestTargetGrants,
    run_id: &str,
    tab_id: &str,
    current_url: &str,
) -> Result<(), String> {
    let root = authorized_root(workspace)?;
    let generation = workspace.generation_for(&root);
    let origin = origin_of(current_url)?;
    grants.verify(run_id, tab_id, &origin, &root, generation)
}

/// 读步骤（ui.assert / ui.wait）。判定与超时语义在 Rust 内完成，WebView 只接收结论。
#[tauri::command]
pub async fn run_ui_read_step(
    app: AppHandle,
    browser: State<'_, BrowserSessionState>,
    workspace: State<'_, WorkspaceAccessState>,
    grants: State<'_, TestTargetGrants>,
    request: UiReadStepRequest,
) -> Result<UiReadStepResult, String> {
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_READ_TIMEOUT_MS)
        .clamp(1, MAX_READ_TIMEOUT_MS);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let (verdict, snapshot) =
            match sample_and_judge(&app, &browser, &workspace, &grants, &request).await {
                Ok(result) => result,
                Err(message) => {
                    return Ok(UiReadStepResult {
                        verdict: UiVerdict::Error { message },
                        extracted: BTreeMap::new(),
                    })
                }
            };
        if verdict == UiVerdict::Passed {
            return Ok(match extract_ui_values(&request.extract, &snapshot) {
                Ok(extracted) => UiReadStepResult { verdict, extracted },
                Err(message) => UiReadStepResult {
                    verdict: UiVerdict::Error { message },
                    extracted: BTreeMap::new(),
                },
            });
        }
        if request.mode == UiReadMode::Assert {
            return Ok(UiReadStepResult {
                verdict,
                extracted: BTreeMap::new(),
            });
        }
        if Instant::now() >= deadline {
            let detail = match verdict {
                UiVerdict::Failed { message } | UiVerdict::Error { message } => message,
                UiVerdict::Passed => String::new(),
            };
            return Ok(UiReadStepResult {
                verdict: UiVerdict::Failed {
                    message: format!("{timeout_ms} ms 内未满足断言：{detail}"),
                },
                extracted: BTreeMap::new(),
            });
        }
        tokio::time::sleep(Duration::from_millis(READ_POLL_INTERVAL_MS)).await;
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiScreenshotRequest {
    run_id: String,
    tab_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiEvidenceResult {
    artifact: ArtifactMetadata,
    width: u32,
    height: u32,
}

/// 截图证据：授权校验通过后截取整页，Rust 直接写入 image Artifact，WebView 只拿到引用。
#[tauri::command]
pub async fn capture_ui_evidence(
    app: AppHandle,
    browser: State<'_, BrowserSessionState>,
    workspace: State<'_, WorkspaceAccessState>,
    grants: State<'_, TestTargetGrants>,
    repository: State<'_, SessionRepositoryState>,
    request: UiScreenshotRequest,
) -> Result<UiEvidenceResult, String> {
    let url = read_ui_snapshot(&app, &browser, &request.tab_id, None)
        .await?
        .url;
    verify_test_grant(&workspace, &grants, &request.run_id, &request.tab_id, &url)?;
    let data_root = crate::storage_paths::axiom_data_root(&app)?;
    let shot = dispatch_browser_command(
        &app,
        &browser,
        BrowserCommandRequest::Screenshot {
            tab_id: request.tab_id.clone(),
            r#ref: None,
        },
        &data_root,
        Some(&app),
    )
    .await?;
    let BrowserCommandResponse::Screenshot {
        image_base64,
        mime_type,
        width,
        height,
        ..
    } = shot
    else {
        return Err("浏览器返回了非截图结果".to_string());
    };
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(0))
        .unwrap_or(0);
    let artifact = write_image_artifact_at(&data_root, image_base64, &mime_type, created_at)?;
    register_artifact_metadata(&repository, &artifact).await?;
    Ok(UiEvidenceResult {
        artifact,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_locator::LocatorCandidate;

    fn candidate(ref_id: i64) -> LocatorCandidate {
        LocatorCandidate {
            ref_id,
            role: "button".into(),
            name: "提交".into(),
            value: None,
            disabled: false,
        }
    }

    fn element() -> UiElementFacts {
        UiElementFacts {
            role: "generic".into(),
            name: String::new(),
            text: "应付金额\n  ¥240.00".into(),
            value: Some("SHOPAIM10".into()),
            disabled: false,
            hidden: false,
        }
    }

    fn unique_snapshot() -> UiReadSnapshot {
        UiReadSnapshot {
            url: "https://shop.test/checkout?step=2".into(),
            resolution: Some(LocatorResolution::Unique {
                candidate: candidate(9),
            }),
            element: Some(element()),
        }
    }

    #[test]
    fn text_comparison_collapses_whitespace() {
        let snapshot = unique_snapshot();
        assert_eq!(
            evaluate(
                &UiExpectation::TextContains("应付金额 ¥240.00".into()),
                &snapshot
            ),
            UiVerdict::Passed
        );
        assert!(matches!(
            evaluate(&UiExpectation::TextEquals("¥240.00".into()), &snapshot),
            UiVerdict::Failed { .. }
        ));
    }

    #[test]
    fn value_and_state_assertions_use_the_element_facts() {
        let mut snapshot = unique_snapshot();
        assert_eq!(
            evaluate(&UiExpectation::ValueEquals("SHOPAIM10".into()), &snapshot),
            UiVerdict::Passed
        );
        assert_eq!(
            evaluate(&UiExpectation::Enabled(true), &snapshot),
            UiVerdict::Passed
        );
        assert!(matches!(
            evaluate(&UiExpectation::Visible(false), &snapshot),
            UiVerdict::Failed { .. }
        ));
        if let Some(element) = snapshot.element.as_mut() {
            element.disabled = true;
        }
        assert!(matches!(
            evaluate(&UiExpectation::Enabled(true), &snapshot),
            UiVerdict::Failed { .. }
        ));
    }

    #[test]
    fn extracts_text_and_value_from_the_same_unique_snapshot() {
        let extracted = extract_ui_values(
            &BTreeMap::from([
                (
                    "totalText".to_string(),
                    UiExtraction {
                        source: "text".to_string(),
                        sensitive: false,
                    },
                ),
                (
                    "coupon".to_string(),
                    UiExtraction {
                        source: "value".to_string(),
                        sensitive: true,
                    },
                ),
            ]),
            &unique_snapshot(),
        )
        .unwrap();
        assert_eq!(extracted["totalText"].value, "应付金额 ¥240.00");
        assert_eq!(extracted["coupon"].value, "SHOPAIM10");
        assert!(extracted["coupon"].sensitive);
    }

    #[test]
    fn url_assertions_do_not_need_a_locator() {
        let snapshot = UiReadSnapshot {
            url: "https://shop.test/checkout".into(),
            resolution: None,
            element: None,
        };
        assert_eq!(
            evaluate(&UiExpectation::UrlContains("/checkout".into()), &snapshot),
            UiVerdict::Passed
        );
        assert!(!UiExpectation::UrlEquals("x".into()).needs_locator());
        assert!(matches!(
            evaluate(&UiExpectation::TextContains("x".into()), &snapshot),
            UiVerdict::Error { .. }
        ));
    }

    #[test]
    fn ambiguous_and_missing_targets_are_errors_not_failures() {
        let ambiguous = UiReadSnapshot {
            url: String::new(),
            resolution: Some(LocatorResolution::Ambiguous {
                total: 2,
                candidates: vec![],
            }),
            element: None,
        };
        assert!(matches!(
            evaluate(&UiExpectation::Visible(true), &ambiguous),
            UiVerdict::Error { .. }
        ));
        let missing = UiReadSnapshot {
            url: String::new(),
            resolution: Some(LocatorResolution::NotFound),
            element: None,
        };
        assert!(matches!(
            evaluate(&UiExpectation::Visible(true), &missing),
            UiVerdict::Error { .. }
        ));
    }

    #[test]
    fn exists_and_count_treat_absence_as_a_legitimate_answer() {
        let missing = UiReadSnapshot {
            url: String::new(),
            resolution: Some(LocatorResolution::NotFound),
            element: None,
        };
        assert_eq!(
            evaluate(&UiExpectation::Exists(false), &missing),
            UiVerdict::Passed
        );
        assert_eq!(
            evaluate(&UiExpectation::Count(0), &missing),
            UiVerdict::Passed
        );

        let ambiguous = UiReadSnapshot {
            url: String::new(),
            resolution: Some(LocatorResolution::Ambiguous {
                total: 3,
                candidates: vec![],
            }),
            element: None,
        };
        assert_eq!(
            evaluate(&UiExpectation::Count(3), &ambiguous),
            UiVerdict::Passed
        );
        assert!(matches!(
            evaluate(&UiExpectation::Exists(true), &ambiguous),
            UiVerdict::Error { .. }
        ));
    }

    #[test]
    fn expectation_json_matches_the_single_key_shape_of_the_spec() {
        let parsed: UiExpectation = serde_json::from_str(r#"{"textContains":"¥240.00"}"#).unwrap();
        assert_eq!(parsed, UiExpectation::TextContains("¥240.00".into()));
        let count: UiExpectation = serde_json::from_str(r#"{"count":2}"#).unwrap();
        assert_eq!(count, UiExpectation::Count(2));
        assert!(serde_json::from_str::<UiExpectation>(r#"{"unknown":true}"#).is_err());
    }
}
