//! UI/API 测试运行的持久化（R1-2 / R1-3）。
//!
//! 状态转移表与 `agent/testing/runner/runState.ts` 逐条一致，由本文件的单测锁定；
//! 写路径全部走 `BEGIN IMMEDIATE`，「校验当前状态 + 写入」在并发写者下原子。
//! 命令入口尚未暴露给 WebView（Runner 接线属于 U1），因此非测试构建允许未使用。
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::api_test_policy::contains_plaintext_credential;
use crate::session_state::SessionRepositoryState;
use crate::user_gesture::{
    current_operating_system, require_user_confirmation, ContentConfirm, UserGestureState,
};
use crate::workspace_access::{authorized_root, WorkspaceAccessState};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TestStatus {
    Queued,
    Running,
    WaitingApproval,
    Passed,
    Failed,
    Error,
    Rejected,
    Skipped,
    Canceled,
    Interrupted,
}

impl TestStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingApproval => "waiting_approval",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Error => "error",
            Self::Rejected => "rejected",
            Self::Skipped => "skipped",
            Self::Canceled => "canceled",
            Self::Interrupted => "interrupted",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        [
            Self::Queued,
            Self::Running,
            Self::WaitingApproval,
            Self::Passed,
            Self::Failed,
            Self::Error,
            Self::Rejected,
            Self::Skipped,
            Self::Canceled,
            Self::Interrupted,
        ]
        .into_iter()
        .find(|status| status.as_str() == value)
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use TestStatus::*;
        matches!(
            (self, next),
            (Queued, Running | Skipped | Canceled)
                | (
                    Running,
                    WaitingApproval | Passed | Failed | Error | Rejected | Canceled | Interrupted
                )
                | (WaitingApproval, Running | Rejected | Canceled | Interrupted)
        )
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewTestStep {
    pub(crate) id: String,
    pub(crate) step_id: String,
    pub(crate) action: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewTestCase {
    pub(crate) id: String,
    pub(crate) case_id: String,
    pub(crate) case_name: String,
    pub(crate) steps: Vec<NewTestStep>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewTestRun {
    pub(crate) id: String,
    /// 由命令层以授权根覆盖；WebView 传入的非空值必须与授权根一致，否则拒绝。
    #[serde(default)]
    pub(crate) workspace_path: String,
    pub(crate) spec_path: String,
    pub(crate) spec_hash: String,
    /// 指向 artifacts.content_hash 的稳定引用；写入前在同一事务内校验存在性。
    pub(crate) plan_content_hash: Option<String>,
    pub(crate) source_session_id: Option<String>,
    pub(crate) environment_id: Option<String>,
    /// 套件运行的分组键（一次套件运行里的每个 spec 各一条 run）：报告按它聚合。
    #[serde(default)]
    pub(crate) batch_id: Option<String>,
    /// 本次实际使用的环境与探针事实（T1-4 写入），JSON。
    #[serde(default)]
    pub(crate) env_facts_json: Option<String>,
    pub(crate) started_at: i64,
    pub(crate) cases: Vec<NewTestCase>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveTestEnvironment {
    pub(crate) id: String,
    pub(crate) name: String,
    /// 环境档类型：`local` 带起停配方，`remote` 只做只读校验（T1-1）。缺省按既有
    /// 语义写成 `remote`——升级前的环境面板只能填地址，本来就等价于远程档。
    #[serde(default)]
    pub(crate) kind: Option<String>,
    #[serde(default)]
    pub(crate) recipe_json: Option<String>,
    pub(crate) web_base_url: Option<String>,
    pub(crate) api_base_url: Option<String>,
    pub(crate) viewport_width: Option<i64>,
    pub(crate) viewport_height: Option<i64>,
    pub(crate) allow_private_network: bool,
    pub(crate) headers_json: String,
    pub(crate) secret_ids_json: String,
    pub(crate) updated_at: i64,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestEnvironment {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) recipe_json: Option<String>,
    pub(crate) web_base_url: Option<String>,
    pub(crate) api_base_url: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub(crate) viewport_width: Option<i64>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub(crate) viewport_height: Option<i64>,
    pub(crate) allow_private_network: bool,
    pub(crate) headers_json: String,
    pub(crate) secret_ids_json: String,
    #[specta(type = specta_typescript::Number)]
    pub(crate) created_at: i64,
    #[specta(type = specta_typescript::Number)]
    pub(crate) updated_at: i64,
}

#[derive(Serialize)]
pub(crate) struct TestEnvironmentAccess {
    pub(crate) allow_private_network: bool,
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) secret_ids: BTreeSet<String>,
    /// Secret 注入的同源边界（见 `api_test::prepare_request`）：环境未配置 API Base URL
    /// 时，使用 Secret 引用的请求一律拒绝，避免把凭据发往任意公网地址。
    pub(crate) api_base_url: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestRunSummary {
    pub(crate) id: String,
    pub(crate) spec_path: String,
    pub(crate) spec_hash: String,
    pub(crate) environment_id: Option<String>,
    /// 套件运行分组键（T3-1）；单文件运行可以是 `None`。
    pub(crate) batch_id: Option<String>,
    /// 本次实际环境与探针事实（T1-4），未记录时为 `None`。
    pub(crate) env_facts_json: Option<String>,
    pub(crate) status: TestStatus,
    #[specta(type = specta_typescript::Number)]
    pub(crate) started_at: i64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub(crate) finished_at: Option<i64>,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestStepDetail {
    pub(crate) id: String,
    pub(crate) step_id: String,
    pub(crate) action: String,
    pub(crate) status: TestStatus,
    #[specta(type = Option<specta_typescript::Number>)]
    pub(crate) started_at: Option<i64>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub(crate) finished_at: Option<i64>,
    pub(crate) details_json: Option<String>,
    pub(crate) evidence_content_hash: Option<String>,
    pub(crate) evidence_artifact: Option<TestArtifactReference>,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestArtifactReference {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) media_type: String,
    pub(crate) relative_path: String,
    pub(crate) content_hash: String,
    #[specta(type = specta_typescript::Number)]
    pub(crate) size_bytes: i64,
    #[specta(type = specta_typescript::Number)]
    pub(crate) created_at: i64,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestCaseDetail {
    pub(crate) id: String,
    pub(crate) case_id: String,
    pub(crate) case_name: String,
    pub(crate) status: TestStatus,
    #[specta(type = Option<specta_typescript::Number>)]
    pub(crate) started_at: Option<i64>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub(crate) finished_at: Option<i64>,
    pub(crate) failure_kind: Option<String>,
    /// 宿主客观归因（`environment` / `approval` / `driver` / `assertion`，T3-2 写入）。
    /// 与 `failure_kind`（来自运行状态）并列：前者说明「哪一类问题」，后者说明「什么状态」。
    pub(crate) failure_origin: Option<String>,
    pub(crate) steps: Vec<TestStepDetail>,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestRunDetail {
    pub(crate) summary: TestRunSummary,
    pub(crate) plan_content_hash: Option<String>,
    pub(crate) cases: Vec<TestCaseDetail>,
}

/// 「校验 + 写入」共用的写锁先行事务。手工 COMMIT/ROLLBACK：sqlx 的 begin() 只有 DEFERRED。
async fn begin_immediate(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|error| format!("无法开始测试运行事务：{error}"))
}

async fn end_immediate<T>(
    connection: &mut SqliteConnection,
    outcome: Result<T, String>,
) -> Result<T, String> {
    match outcome {
        Ok(value) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| value)
            .map_err(|error| format!("无法提交测试运行事务：{error}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

fn validate_new_run(run: &NewTestRun) -> Result<(), String> {
    let bounded = |value: &str| !value.is_empty() && value.len() <= 256;
    if !bounded(&run.id) || !bounded(&run.spec_hash) || !bounded(&run.spec_path) {
        return Err("测试运行标识或规格字段无效".to_string());
    }
    if let Some(batch) = &run.batch_id {
        if !bounded(batch) {
            return Err("测试运行批次标识无效".to_string());
        }
    }
    if let Some(facts) = &run.env_facts_json {
        if facts.len() > 16 * 1024 || serde_json::from_str::<serde_json::Value>(facts).is_err() {
            return Err("测试运行环境事实必须是大小受限的 JSON".to_string());
        }
    }
    if run.cases.is_empty() {
        return Err("测试运行至少需要一个用例".to_string());
    }
    for case in &run.cases {
        if !bounded(&case.id) || !bounded(&case.case_id) || case.steps.is_empty() {
            return Err("测试用例快照无效".to_string());
        }
        for step in &case.steps {
            if !bounded(&step.id) || !bounded(&step.step_id) || !bounded(&step.action) {
                return Err("测试步骤快照无效".to_string());
            }
        }
    }
    Ok(())
}

fn validate_optional_base_url(value: Option<&str>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty() || value.len() > 2048 {
        return Err("测试环境 URL 长度无效".to_string());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| "测试环境 URL 无法解析".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("测试环境 URL 必须是无凭据的 HTTP(S) 地址".to_string());
    }
    Ok(())
}

fn validate_test_environment(environment: &SaveTestEnvironment) -> Result<(), String> {
    if environment.id.is_empty() || environment.id.len() > 256 {
        return Err("测试环境 ID 无效".to_string());
    }
    let name = environment.name.trim();
    if name.is_empty() || name.len() > 120 {
        return Err("测试环境名称无效".to_string());
    }
    // 只校验类型与大小：环境档的语义规则（local 必须有就绪判据、remote 不得带起停）
    // 属于环境档解析器（T1-1），落库层不重复定义第二套语义。
    match environment.kind.as_deref() {
        None | Some("remote") | Some("local") => {}
        Some(_) => return Err("测试环境类型只支持 local 或 remote".to_string()),
    }
    if let Some(recipe) = &environment.recipe_json {
        if recipe.len() > 16 * 1024 || serde_json::from_str::<serde_json::Value>(recipe).is_err() {
            return Err("测试环境起停配方必须是大小受限的 JSON".to_string());
        }
    }
    validate_optional_base_url(environment.web_base_url.as_deref())?;
    validate_optional_base_url(environment.api_base_url.as_deref())?;
    match (environment.viewport_width, environment.viewport_height) {
        (None, None) => {}
        (Some(width), Some(height))
            if (320..=3840).contains(&width) && (240..=2160).contains(&height) => {}
        _ => return Err("测试环境 viewport 必须成对提供且在允许范围内".to_string()),
    }
    let headers: serde_json::Value = serde_json::from_str(&environment.headers_json)
        .map_err(|_| "测试环境 Headers 不是合法 JSON".to_string())?;
    let valid_headers = headers.as_object().is_some_and(|headers| {
        headers.len() <= 64
            && headers.iter().all(|(name, value)| {
                let lowered = name.to_ascii_lowercase();
                !matches!(
                    lowered.as_str(),
                    "authorization" | "proxy-authorization" | "cookie" | "set-cookie" | "x-api-key"
                ) && !name.is_empty()
                    && name.len() <= 128
                    && value.as_str().is_some_and(|value| {
                        value.len() <= 4096 && !contains_plaintext_credential(value)
                    })
            })
    });
    if !valid_headers || environment.headers_json.len() > 16 * 1024 {
        return Err("测试环境 Headers 必须是大小受限的 JSON 对象".to_string());
    }
    let secret_ids: serde_json::Value = serde_json::from_str(&environment.secret_ids_json)
        .map_err(|_| "测试环境 Secret 引用不是合法 JSON".to_string())?;
    let valid_secret_ids = secret_ids.as_array().is_some_and(|values| {
        values.len() <= 64
            && values.iter().all(|value| {
                value
                    .as_str()
                    .is_some_and(|id| id.starts_with("apitest.") && id.len() <= 256)
            })
    });
    if !valid_secret_ids || environment.secret_ids_json.len() > 16 * 1024 {
        return Err("测试环境 Secret 引用必须是大小受限的字符串数组".to_string());
    }
    Ok(())
}

pub(crate) async fn save_test_environment(
    connection: &mut SqliteConnection,
    workspace_path: &str,
    environment: &SaveTestEnvironment,
) -> Result<(), String> {
    validate_test_environment(environment)?;
    begin_immediate(connection).await?;
    let outcome = async {
        let existing_id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM test_environments WHERE workspace_path = ? AND logical_id = ?",
        )
            .bind(workspace_path)
            .bind(&environment.id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验测试环境归属：{error}"))?;
        let storage_id = existing_id.unwrap_or_else(|| {
            let digest = Sha256::digest(format!("{workspace_path}\0{}", environment.id).as_bytes());
            let encoded = digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("env-{encoded}")
        });
        sqlx::query(
            "INSERT INTO test_environments (
               id, logical_id, workspace_path, name, kind, recipe_json, web_base_url, api_base_url, viewport_width, viewport_height,
               allow_private_network, headers_json, secret_ids_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, kind = excluded.kind, recipe_json = excluded.recipe_json,
               web_base_url = excluded.web_base_url,
               api_base_url = excluded.api_base_url, viewport_width = excluded.viewport_width,
               viewport_height = excluded.viewport_height,
               allow_private_network = excluded.allow_private_network, headers_json = excluded.headers_json,
               secret_ids_json = excluded.secret_ids_json, updated_at = excluded.updated_at",
        )
        .bind(storage_id)
        .bind(&environment.id)
        .bind(workspace_path)
        .bind(environment.name.trim())
        .bind(environment.kind.as_deref().unwrap_or("remote"))
        .bind(&environment.recipe_json)
        .bind(&environment.web_base_url)
        .bind(&environment.api_base_url)
        .bind(environment.viewport_width)
        .bind(environment.viewport_height)
        .bind(environment.allow_private_network)
        .bind(&environment.headers_json)
        .bind(&environment.secret_ids_json)
        .bind(environment.updated_at)
        .bind(environment.updated_at)
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|error| format!("无法保存测试环境：{error}"))
    }
    .await;
    end_immediate(connection, outcome).await
}

pub(crate) async fn list_test_environments(
    connection: &mut SqliteConnection,
    workspace_path: &str,
) -> Result<Vec<TestEnvironment>, String> {
    let rows = sqlx::query(
        "SELECT logical_id AS id, name, kind, recipe_json, web_base_url, api_base_url, viewport_width, viewport_height,
         allow_private_network, headers_json, secret_ids_json, created_at, updated_at FROM test_environments
         WHERE workspace_path = ? ORDER BY updated_at DESC, logical_id DESC",
    )
    .bind(workspace_path)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法查询测试环境：{error}"))?;
    rows.iter()
        .map(|row| {
            Ok(TestEnvironment {
                id: row.try_get("id").map_err(|error| error.to_string())?,
                name: row.try_get("name").map_err(|error| error.to_string())?,
                kind: row.try_get("kind").map_err(|error| error.to_string())?,
                recipe_json: row
                    .try_get("recipe_json")
                    .map_err(|error| error.to_string())?,
                web_base_url: row
                    .try_get("web_base_url")
                    .map_err(|error| error.to_string())?,
                api_base_url: row
                    .try_get("api_base_url")
                    .map_err(|error| error.to_string())?,
                viewport_width: row
                    .try_get("viewport_width")
                    .map_err(|error| error.to_string())?,
                viewport_height: row
                    .try_get("viewport_height")
                    .map_err(|error| error.to_string())?,
                allow_private_network: row
                    .try_get("allow_private_network")
                    .map_err(|error| error.to_string())?,
                headers_json: row
                    .try_get("headers_json")
                    .map_err(|error| error.to_string())?,
                secret_ids_json: row
                    .try_get("secret_ids_json")
                    .map_err(|error| error.to_string())?,
                created_at: row
                    .try_get("created_at")
                    .map_err(|error| error.to_string())?,
                updated_at: row
                    .try_get("updated_at")
                    .map_err(|error| error.to_string())?,
            })
        })
        .collect()
}

pub(crate) async fn load_test_environment_access(
    connection: &mut SqliteConnection,
    workspace_path: &str,
    environment_id: Option<&str>,
) -> Result<TestEnvironmentAccess, String> {
    let Some(environment_id) = environment_id else {
        return Ok(TestEnvironmentAccess {
            allow_private_network: false,
            headers: BTreeMap::new(),
            secret_ids: BTreeSet::new(),
            api_base_url: None,
        });
    };
    let row = sqlx::query(
        "SELECT allow_private_network, headers_json, secret_ids_json, api_base_url FROM test_environments
         WHERE logical_id = ? AND workspace_path = ?",
    )
    .bind(environment_id)
    .bind(workspace_path)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法读取 API 测试环境：{error}"))?
    .ok_or_else(|| "API 测试环境不存在或不属于当前工作区".to_string())?;
    let headers_json: String = row
        .try_get("headers_json")
        .map_err(|error| error.to_string())?;
    let secret_ids_json: String = row
        .try_get("secret_ids_json")
        .map_err(|error| error.to_string())?;
    let api_base_url: Option<String> = row
        .try_get("api_base_url")
        .map_err(|error| error.to_string())?;
    let headers = serde_json::from_str(&headers_json)
        .map_err(|_| "API 测试环境 Headers 已损坏".to_string())?;
    let secret_ids = serde_json::from_str::<Vec<String>>(&secret_ids_json)
        .map_err(|_| "API 测试环境 Secret 引用已损坏".to_string())?
        .into_iter()
        .collect();
    Ok(TestEnvironmentAccess {
        allow_private_network: row
            .try_get("allow_private_network")
            .map_err(|error| error.to_string())?,
        headers,
        secret_ids,
        api_base_url,
    })
}

/// 环境保存前用于原生确认的边界快照。只比较会改变运行/凭据出网面的字段；
/// 名称、档位、视口等展示/资源配置不在确认摘要里。
#[derive(Debug, PartialEq)]
struct EnvironmentFields {
    api_base_url: Option<String>,
    web_base_url: Option<String>,
    secret_ids: BTreeSet<String>,
    allow_private_network: bool,
    headers: serde_json::Value,
}

async fn load_environment_fields(
    connection: &mut SqliteConnection,
    workspace_path: &str,
    environment_id: &str,
) -> Result<Option<EnvironmentFields>, String> {
    let row = sqlx::query(
        "SELECT api_base_url, web_base_url, secret_ids_json, allow_private_network, headers_json \
         FROM test_environments WHERE workspace_path = ? AND logical_id = ?",
    )
    .bind(workspace_path)
    .bind(environment_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法读取测试环境变更快照：{error}"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let secret_ids_json: String = row
        .try_get("secret_ids_json")
        .map_err(|error| error.to_string())?;
    let headers_json: String = row
        .try_get("headers_json")
        .map_err(|error| error.to_string())?;
    Ok(Some(EnvironmentFields {
        api_base_url: row
            .try_get("api_base_url")
            .map_err(|error| error.to_string())?,
        web_base_url: row
            .try_get("web_base_url")
            .map_err(|error| error.to_string())?,
        secret_ids: serde_json::from_str::<Vec<String>>(&secret_ids_json)
            .map_err(|_| "API 测试环境 Secret 引用已损坏".to_string())?
            .into_iter()
            .collect(),
        allow_private_network: row
            .try_get("allow_private_network")
            .map_err(|error| error.to_string())?,
        headers: serde_json::from_str(&headers_json)
            .map_err(|_| "API 测试环境 Headers 已损坏".to_string())?,
    }))
}

fn display_env_url(value: Option<&str>) -> &str {
    value.unwrap_or("未设置")
}

/// 生成原生确认框的中文变更摘要；空数组表示只需要手势门（名称/档位等变更）。
fn describe_environment_changes(
    existing: Option<&EnvironmentFields>,
    incoming: &SaveTestEnvironment,
) -> Result<Vec<String>, String> {
    let incoming_secret_ids = serde_json::from_str::<Vec<String>>(&incoming.secret_ids_json)
        .map_err(|_| "测试环境 Secret 引用不是合法 JSON".to_string())?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let incoming_headers: serde_json::Value = serde_json::from_str(&incoming.headers_json)
        .map_err(|_| "测试环境 Headers 不是合法 JSON".to_string())?;
    let mut changes = Vec::new();
    let Some(existing) = existing else {
        if incoming.api_base_url.is_some() {
            changes.push(format!(
                "API Base：未设置 → {}",
                display_env_url(incoming.api_base_url.as_deref())
            ));
        }
        if incoming.web_base_url.is_some() {
            changes.push(format!(
                "Web Base：未设置 → {}",
                display_env_url(incoming.web_base_url.as_deref())
            ));
        }
        if incoming.allow_private_network {
            changes.push("私网访问：关闭 → 开启".to_string());
        }
        if !incoming_secret_ids.is_empty() {
            changes.push(format!(
                "Secret 名单：新增 {}",
                incoming_secret_ids
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if incoming_headers
            .as_object()
            .is_some_and(|headers| !headers.is_empty())
        {
            changes.push("非敏感 Headers：新增".to_string());
        }
        return Ok(changes);
    };

    if existing.api_base_url != incoming.api_base_url {
        changes.push(format!(
            "API Base：{} → {}",
            display_env_url(existing.api_base_url.as_deref()),
            display_env_url(incoming.api_base_url.as_deref()),
        ));
    }
    if existing.web_base_url != incoming.web_base_url {
        changes.push(format!(
            "Web Base：{} → {}",
            display_env_url(existing.web_base_url.as_deref()),
            display_env_url(incoming.web_base_url.as_deref()),
        ));
    }
    if existing.allow_private_network != incoming.allow_private_network {
        changes.push(format!(
            "私网访问：{} → {}",
            if existing.allow_private_network {
                "开启"
            } else {
                "关闭"
            },
            if incoming.allow_private_network {
                "开启"
            } else {
                "关闭"
            },
        ));
    }
    let added = incoming_secret_ids
        .difference(&existing.secret_ids)
        .cloned()
        .collect::<Vec<_>>();
    let removed = existing
        .secret_ids
        .difference(&incoming_secret_ids)
        .cloned()
        .collect::<Vec<_>>();
    if !added.is_empty() || !removed.is_empty() {
        let mut parts = Vec::new();
        if !added.is_empty() {
            parts.push(format!("新增 {}", added.join(", ")));
        }
        if !removed.is_empty() {
            parts.push(format!("移除 {}", removed.join(", ")));
        }
        changes.push(format!("Secret 名单：{}", parts.join("；")));
    }
    if existing.headers != incoming_headers {
        changes.push("非敏感 Headers 有变化".to_string());
    }
    Ok(changes)
}

pub(crate) async fn delete_test_environment(
    connection: &mut SqliteConnection,
    workspace_path: &str,
    environment_id: &str,
) -> Result<bool, String> {
    let result =
        sqlx::query("DELETE FROM test_environments WHERE logical_id = ? AND workspace_path = ?")
            .bind(environment_id)
            .bind(workspace_path)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法删除测试环境：{error}"))?;
    Ok(result.rows_affected() == 1)
}

async fn artifact_exists(
    connection: &mut SqliteConnection,
    content_hash: &str,
) -> Result<bool, String> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM artifacts WHERE content_hash = ?")
        .bind(content_hash)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("无法校验测试证据引用：{error}"))?;
    Ok(found.is_some())
}

async fn create_test_run_locked(
    connection: &mut SqliteConnection,
    run: &NewTestRun,
) -> Result<(), String> {
    if let Some(hash) = &run.plan_content_hash {
        if !artifact_exists(connection, hash).await? {
            return Err("测试计划快照 Artifact 不存在".to_string());
        }
    }
    let environment_storage_id = if let Some(environment_id) = &run.environment_id {
        Some(
            sqlx::query_scalar::<_, String>(
                "SELECT id FROM test_environments WHERE workspace_path = ? AND logical_id = ?",
            )
            .bind(&run.workspace_path)
            .bind(environment_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法校验测试环境：{error}"))?
            .ok_or_else(|| "测试环境不存在或不属于当前工作区".to_string())?,
        )
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO test_runs (id, workspace_path, spec_path, spec_hash, plan_content_hash, \
         source_session_id, environment_id, batch_id, env_facts_json, status, started_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
    )
    .bind(&run.id)
    .bind(&run.workspace_path)
    .bind(&run.spec_path)
    .bind(&run.spec_hash)
    .bind(&run.plan_content_hash)
    .bind(&run.source_session_id)
    .bind(&environment_storage_id)
    .bind(&run.batch_id)
    .bind(&run.env_facts_json)
    .bind(run.started_at)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("无法创建测试运行：{error}"))?;

    for (case_position, case) in run.cases.iter().enumerate() {
        sqlx::query(
            "INSERT INTO test_case_runs (id, run_id, position, case_id, case_name, status) \
             VALUES (?, ?, ?, ?, ?, 'queued')",
        )
        .bind(&case.id)
        .bind(&run.id)
        .bind(i64::try_from(case_position).map_err(|_| "用例数量超出范围".to_string())?)
        .bind(&case.case_id)
        .bind(&case.case_name)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法创建测试用例记录：{error}"))?;
        for (step_position, step) in case.steps.iter().enumerate() {
            sqlx::query(
                "INSERT INTO test_step_runs (id, case_run_id, position, step_id, action, status) \
                 VALUES (?, ?, ?, ?, ?, 'queued')",
            )
            .bind(&step.id)
            .bind(&case.id)
            .bind(i64::try_from(step_position).map_err(|_| "步骤数量超出范围".to_string())?)
            .bind(&step.step_id)
            .bind(&step.action)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法创建测试步骤记录：{error}"))?;
        }
    }
    Ok(())
}

/// 计划快照与全部 case/step 行在同一事务内落库，中途失败不留下半截运行。
pub(crate) async fn create_test_run(
    connection: &mut SqliteConnection,
    run: &NewTestRun,
) -> Result<(), String> {
    validate_new_run(run)?;
    begin_immediate(connection).await?;
    let outcome = create_test_run_locked(connection, run).await;
    end_immediate(connection, outcome).await
}

async fn read_status(
    connection: &mut SqliteConnection,
    table: &'static str,
    id: &str,
) -> Result<TestStatus, String> {
    let query = match table {
        "test_runs" => "SELECT status FROM test_runs WHERE id = ?",
        "test_case_runs" => "SELECT status FROM test_case_runs WHERE id = ?",
        "test_step_runs" => "SELECT status FROM test_step_runs WHERE id = ?",
        _ => return Err("未知的测试记录类型".to_string()),
    };
    let raw: Option<String> = sqlx::query_scalar(query)
        .bind(id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("无法读取测试状态：{error}"))?;
    let raw = raw.ok_or_else(|| "测试记录不存在".to_string())?;
    TestStatus::parse(&raw).ok_or_else(|| "数据库中存在未知测试状态".to_string())
}

fn ensure_transition(current: TestStatus, next: TestStatus) -> Result<(), String> {
    if current.can_transition_to(next) {
        Ok(())
    } else {
        Err(format!(
            "非法测试状态转移：{} → {}",
            current.as_str(),
            next.as_str()
        ))
    }
}

pub(crate) async fn transition_test_run(
    connection: &mut SqliteConnection,
    run_id: &str,
    next: TestStatus,
    finished_at: Option<i64>,
    summary_json: Option<&str>,
) -> Result<(), String> {
    begin_immediate(connection).await?;
    let outcome = async {
        ensure_transition(read_status(connection, "test_runs", run_id).await?, next)?;
        sqlx::query(
            "UPDATE test_runs SET status = ?, finished_at = COALESCE(?, finished_at), \
             summary_json = COALESCE(?, summary_json) WHERE id = ?",
        )
        .bind(next.as_str())
        .bind(finished_at)
        .bind(summary_json)
        .bind(run_id)
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|error| format!("无法更新测试运行状态：{error}"))
    }
    .await;
    end_immediate(connection, outcome).await
}

pub(crate) async fn transition_test_case(
    connection: &mut SqliteConnection,
    case_run_id: &str,
    next: TestStatus,
    now: i64,
    failure_kind: Option<&str>,
    failure_origin: Option<&str>,
) -> Result<(), String> {
    begin_immediate(connection).await?;
    let outcome = async {
        ensure_transition(read_status(connection, "test_case_runs", case_run_id).await?, next)?;
        // failure_origin 与 failure_kind 并列：前者是宿主对"哪一类问题"的客观归因
        // （environment/approval/driver/assertion，CHECK 强制白名单），后者来自运行状态。
        // 两者都用 COALESCE 保留首次写入值，重复结算不会把它们冲成 NULL。
        sqlx::query(
            "UPDATE test_case_runs SET status = ?, started_at = COALESCE(started_at, ?), \
             finished_at = CASE WHEN ? IN ('running', 'waiting_approval') THEN finished_at ELSE ? END, \
             failure_kind = COALESCE(?, failure_kind), failure_origin = COALESCE(?, failure_origin) \
             WHERE id = ?",
        )
        .bind(next.as_str())
        .bind(now)
        .bind(next.as_str())
        .bind(now)
        .bind(failure_kind)
        .bind(failure_origin)
        .bind(case_run_id)
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|error| format!("无法更新测试用例状态：{error}"))
    }
    .await;
    end_immediate(connection, outcome).await
}

/// 步骤结算与证据引用原子提交。证据 hash 必须已存在于 artifacts，否则整体回滚。
pub(crate) async fn transition_test_step(
    connection: &mut SqliteConnection,
    step_run_id: &str,
    next: TestStatus,
    now: i64,
    details_json: Option<&str>,
    evidence_content_hash: Option<&str>,
) -> Result<(), String> {
    begin_immediate(connection).await?;
    let outcome = async {
        ensure_transition(read_status(connection, "test_step_runs", step_run_id).await?, next)?;
        if let Some(hash) = evidence_content_hash {
            if !artifact_exists(connection, hash).await? {
                return Err("测试证据 Artifact 不存在".to_string());
            }
        }
        sqlx::query(
            "UPDATE test_step_runs SET status = ?, started_at = COALESCE(started_at, ?), \
             finished_at = CASE WHEN ? IN ('running', 'waiting_approval') THEN finished_at ELSE ? END, \
             details_json = COALESCE(?, details_json), \
             evidence_content_hash = COALESCE(?, evidence_content_hash) WHERE id = ?",
        )
        .bind(next.as_str())
        .bind(now)
        .bind(next.as_str())
        .bind(now)
        .bind(details_json)
        .bind(evidence_content_hash)
        .bind(step_run_id)
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|error| format!("无法结算测试步骤：{error}"))
    }
    .await;
    end_immediate(connection, outcome).await
}

/// 启动恢复（R1-3）：遗留的非终态运行整体标记为 interrupted。正在执行或等待审批的步骤
/// 无法确认副作用是否已发生，因此记为 interrupted 且不自动重放；尚未开始的排队项只能跳过。
pub(crate) async fn interrupt_active_test_runs(
    connection: &mut SqliteConnection,
    now: i64,
) -> Result<u64, String> {
    begin_immediate(connection).await?;
    let outcome = interrupt_active_locked(connection, now).await;
    end_immediate(connection, outcome).await
}

async fn interrupt_active_locked(
    connection: &mut SqliteConnection,
    now: i64,
) -> Result<u64, String> {
    let run_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM test_runs WHERE status IN ('queued', 'running', 'waiting_approval')",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法枚举遗留测试运行：{error}"))?;

    for run_id in &run_ids {
        sqlx::query(
            "UPDATE test_step_runs SET \
               status = CASE WHEN status IN ('running', 'waiting_approval') THEN 'interrupted' ELSE 'skipped' END, \
               finished_at = COALESCE(finished_at, ?) \
             WHERE status IN ('queued', 'running', 'waiting_approval') \
               AND case_run_id IN (SELECT id FROM test_case_runs WHERE run_id = ?)",
        )
        .bind(now)
        .bind(run_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法中断测试步骤：{error}"))?;
        sqlx::query(
            "UPDATE test_case_runs SET \
               status = CASE WHEN status IN ('running', 'waiting_approval') THEN 'interrupted' ELSE 'skipped' END, \
               finished_at = COALESCE(finished_at, ?) \
             WHERE status IN ('queued', 'running', 'waiting_approval') AND run_id = ?",
        )
        .bind(now)
        .bind(run_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("无法中断测试用例：{error}"))?;
        sqlx::query("UPDATE test_runs SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE id = ?")
            .bind(now)
            .bind(run_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("无法中断测试运行：{error}"))?;
    }
    Ok(run_ids.len() as u64)
}

fn parse_status_column(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<TestStatus, String> {
    let raw: String = row
        .try_get(column)
        .map_err(|error| format!("无法读取状态列：{error}"))?;
    TestStatus::parse(&raw).ok_or_else(|| "数据库中存在未知测试状态".to_string())
}

/// GC 权威引用集的测试侧来源（R1-4）：运行计划快照与步骤证据。两者都是报告的一部分，
/// 必须在源文件修改、会话删除后依然可读，因此不能被 reconcile 当作未引用对象回收。
pub(crate) async fn collect_test_artifact_hashes(
    connection: &mut SqliteConnection,
) -> Result<Vec<String>, String> {
    let hashes: Vec<String> = sqlx::query_scalar(
        "SELECT plan_content_hash FROM test_runs WHERE plan_content_hash IS NOT NULL \
         UNION \
         SELECT evidence_content_hash FROM test_step_runs WHERE evidence_content_hash IS NOT NULL",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法收集测试 Artifact 引用：{error}"))?;
    Ok(hashes)
}

fn test_run_summary_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<TestRunSummary, String> {
    Ok(TestRunSummary {
        id: row.try_get("id").map_err(|error| error.to_string())?,
        spec_path: row
            .try_get("spec_path")
            .map_err(|error| error.to_string())?,
        spec_hash: row
            .try_get("spec_hash")
            .map_err(|error| error.to_string())?,
        environment_id: row
            .try_get("environment_id")
            .map_err(|error| error.to_string())?,
        batch_id: row.try_get("batch_id").map_err(|error| error.to_string())?,
        env_facts_json: row
            .try_get("env_facts_json")
            .map_err(|error| error.to_string())?,
        status: parse_status_column(row, "status")?,
        started_at: row
            .try_get("started_at")
            .map_err(|error| error.to_string())?,
        finished_at: row
            .try_get("finished_at")
            .map_err(|error| error.to_string())?,
    })
}

pub(crate) async fn list_test_runs(
    connection: &mut SqliteConnection,
    workspace_path: &str,
    limit: i64,
) -> Result<Vec<TestRunSummary>, String> {
    let rows = sqlx::query(
        "SELECT runs.id, runs.spec_path, runs.spec_hash, environments.logical_id AS environment_id, \
                runs.batch_id, runs.env_facts_json, runs.status, runs.started_at, runs.finished_at \
         FROM test_runs runs \
         LEFT JOIN test_environments environments ON environments.id = runs.environment_id \
         WHERE runs.workspace_path = ? ORDER BY runs.started_at DESC, runs.id DESC LIMIT ?",
    )
    .bind(workspace_path)
    .bind(limit.clamp(1, 200))
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法查询测试运行列表：{error}"))?;
    rows.iter().map(test_run_summary_from_row).collect()
}

/// 单次批次查询的硬上限（防御性，不参与「最近批次」发现）：远超正常套件文件数，
/// 超出时用 `truncated` 如实告知，而不是静默少返回。
const LATEST_BATCH_LIMIT: i64 = 1_000;

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestBatchSummary {
    pub(crate) batch_id: String,
    pub(crate) runs: Vec<TestRunSummary>,
    pub(crate) truncated: bool,
}

/// 最近一个批次及其全部 run。此前 UI 只能从「最近 50 条运行」里找批次，
/// 批次文件数超过列表上限时摘要会缺文件；按 batch_id 直接回读消除了这个发现上限。
pub(crate) async fn latest_test_batch(
    connection: &mut SqliteConnection,
    workspace_path: &str,
) -> Result<Option<TestBatchSummary>, String> {
    let batch_id: Option<String> = sqlx::query_scalar(
        "SELECT batch_id FROM test_runs \
         WHERE workspace_path = ? AND batch_id IS NOT NULL \
         ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace_path)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法查询最近测试批次：{error}"))?;
    let Some(batch_id) = batch_id else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT runs.id, runs.spec_path, runs.spec_hash, environments.logical_id AS environment_id, \
                runs.batch_id, runs.env_facts_json, runs.status, runs.started_at, runs.finished_at \
         FROM test_runs runs \
         LEFT JOIN test_environments environments ON environments.id = runs.environment_id \
         WHERE runs.workspace_path = ? AND runs.batch_id = ? \
         ORDER BY runs.started_at DESC, runs.id DESC LIMIT ?",
    )
    .bind(workspace_path)
    .bind(&batch_id)
    .bind(LATEST_BATCH_LIMIT + 1)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法查询最近测试批次：{error}"))?;
    let truncated = rows.len() as i64 > LATEST_BATCH_LIMIT;
    let runs = rows
        .iter()
        .take(LATEST_BATCH_LIMIT as usize)
        .map(test_run_summary_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(TestBatchSummary {
        batch_id,
        runs,
        truncated,
    }))
}

pub(crate) async fn get_test_run(
    connection: &mut SqliteConnection,
    run_id: &str,
) -> Result<Option<TestRunDetail>, String> {
    let run = sqlx::query(
        "SELECT runs.id, runs.spec_path, runs.spec_hash, environments.logical_id AS environment_id, \
                runs.batch_id, runs.env_facts_json, runs.status, runs.started_at, \
                runs.finished_at, runs.plan_content_hash \
         FROM test_runs runs \
         LEFT JOIN test_environments environments ON environments.id = runs.environment_id \
         WHERE runs.id = ?",
    )
    .bind(run_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| format!("无法读取测试运行：{error}"))?;
    let Some(run) = run else {
        return Ok(None);
    };
    let summary = TestRunSummary {
        id: run.try_get("id").map_err(|error| error.to_string())?,
        spec_path: run
            .try_get("spec_path")
            .map_err(|error| error.to_string())?,
        spec_hash: run
            .try_get("spec_hash")
            .map_err(|error| error.to_string())?,
        environment_id: run
            .try_get("environment_id")
            .map_err(|error| error.to_string())?,
        batch_id: run.try_get("batch_id").map_err(|error| error.to_string())?,
        env_facts_json: run
            .try_get("env_facts_json")
            .map_err(|error| error.to_string())?,
        status: parse_status_column(&run, "status")?,
        started_at: run
            .try_get("started_at")
            .map_err(|error| error.to_string())?,
        finished_at: run
            .try_get("finished_at")
            .map_err(|error| error.to_string())?,
    };
    let plan_content_hash = run
        .try_get("plan_content_hash")
        .map_err(|error| error.to_string())?;

    let case_rows = sqlx::query(
        "SELECT id, case_id, case_name, status, started_at, finished_at, failure_kind, failure_origin \
         FROM test_case_runs \
         WHERE run_id = ? ORDER BY position",
    )
    .bind(run_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| format!("无法读取测试用例：{error}"))?;
    let mut cases = Vec::with_capacity(case_rows.len());
    for case in &case_rows {
        let case_id: String = case.try_get("id").map_err(|error| error.to_string())?;
        let step_rows = sqlx::query(
            "SELECT s.id, s.step_id, s.action, s.status, s.started_at, s.finished_at, \
                    s.details_json, s.evidence_content_hash, \
                    a.id AS evidence_id, a.kind AS evidence_kind, a.media_type AS evidence_media_type, \
                    a.relative_path AS evidence_relative_path, a.size_bytes AS evidence_size_bytes, \
                    a.created_at AS evidence_created_at \
             FROM test_step_runs s LEFT JOIN artifacts a ON a.content_hash = s.evidence_content_hash \
             WHERE s.case_run_id = ? ORDER BY s.position",
        )
        .bind(&case_id)
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| format!("无法读取测试步骤：{error}"))?;
        let steps = step_rows
            .iter()
            .map(|step| {
                let evidence_id: Option<String> = step
                    .try_get("evidence_id")
                    .map_err(|error| error.to_string())?;
                let evidence_artifact = evidence_id
                    .map(|id| -> Result<TestArtifactReference, String> {
                        Ok(TestArtifactReference {
                            id,
                            kind: step
                                .try_get("evidence_kind")
                                .map_err(|error| error.to_string())?,
                            media_type: step
                                .try_get("evidence_media_type")
                                .map_err(|error| error.to_string())?,
                            relative_path: step
                                .try_get("evidence_relative_path")
                                .map_err(|error| error.to_string())?,
                            content_hash: step
                                .try_get("evidence_content_hash")
                                .map_err(|error| error.to_string())?,
                            size_bytes: step
                                .try_get("evidence_size_bytes")
                                .map_err(|error| error.to_string())?,
                            created_at: step
                                .try_get("evidence_created_at")
                                .map_err(|error| error.to_string())?,
                        })
                    })
                    .transpose()?;
                Ok(TestStepDetail {
                    id: step.try_get("id").map_err(|error| error.to_string())?,
                    step_id: step.try_get("step_id").map_err(|error| error.to_string())?,
                    action: step.try_get("action").map_err(|error| error.to_string())?,
                    status: parse_status_column(step, "status")?,
                    started_at: step
                        .try_get("started_at")
                        .map_err(|error| error.to_string())?,
                    finished_at: step
                        .try_get("finished_at")
                        .map_err(|error| error.to_string())?,
                    details_json: step
                        .try_get("details_json")
                        .map_err(|error| error.to_string())?,
                    evidence_content_hash: step
                        .try_get("evidence_content_hash")
                        .map_err(|error| error.to_string())?,
                    evidence_artifact,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        cases.push(TestCaseDetail {
            id: case_id,
            case_id: case.try_get("case_id").map_err(|error| error.to_string())?,
            case_name: case
                .try_get("case_name")
                .map_err(|error| error.to_string())?,
            status: parse_status_column(case, "status")?,
            started_at: case
                .try_get("started_at")
                .map_err(|error| error.to_string())?,
            finished_at: case
                .try_get("finished_at")
                .map_err(|error| error.to_string())?,
            failure_kind: case
                .try_get("failure_kind")
                .map_err(|error| error.to_string())?,
            failure_origin: case
                .try_get("failure_origin")
                .map_err(|error| error.to_string())?,
            steps,
        });
    }
    Ok(Some(TestRunDetail {
        summary,
        plan_content_hash,
        cases,
    }))
}

fn authorized_root_string(workspace: &WorkspaceAccessState) -> Result<String, String> {
    authorized_root(workspace).map(|root| root.to_string_lossy().into_owned())
}

#[derive(Clone, Copy)]
enum TestRecordKind {
    Run,
    Case,
    Step,
}

async fn ensure_test_record_workspace(
    connection: &mut SqliteConnection,
    kind: TestRecordKind,
    record_id: &str,
    workspace_path: &str,
) -> Result<(), String> {
    let statement = match kind {
        TestRecordKind::Run => "SELECT workspace_path FROM test_runs WHERE id = ?",
        TestRecordKind::Case => {
            "SELECT runs.workspace_path FROM test_case_runs cases JOIN test_runs runs ON runs.id = cases.run_id WHERE cases.id = ?"
        }
        TestRecordKind::Step => {
            "SELECT runs.workspace_path FROM test_step_runs steps JOIN test_case_runs cases ON cases.id = steps.case_run_id JOIN test_runs runs ON runs.id = cases.run_id WHERE steps.id = ?"
        }
    };
    let owner: Option<String> = sqlx::query_scalar(statement)
        .bind(record_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("无法校验测试记录归属：{error}"))?;
    if owner
        .as_deref()
        .is_some_and(|owner| owner != workspace_path)
    {
        return Err("不能修改其它工作区的测试运行".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn save_test_environment_record(
    app: AppHandle,
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    gesture: State<'_, Arc<UserGestureState>>,
    environment: SaveTestEnvironment,
) -> Result<bool, String> {
    validate_test_environment(&environment)?;
    let root = authorized_root_string(&workspace)?;
    // 读完变更快照即归还连接：原生确认框可能停留很久，不能占着池连接等用户。
    let existing = {
        let mut connection = state.acquire().await?;
        load_environment_fields(&mut connection, &root, &environment.id).await?
    };
    let changes = describe_environment_changes(existing.as_ref(), &environment)?;
    // 任何环境保存都要求一次用户在场证明；边界字段变化再叠加原生内容确认，
    // 展示 Rust 侧计算的字段差异，避免渲染进程静默改道/扩权。
    // macOS 消费原生手势配额；非 macOS 没有等价信号，降级为宿主原生确认对话框
    // （有边界变化时复用那一次内容确认，没有时补一次通用确认）。
    let content = if changes.is_empty() {
        None
    } else {
        Some(ContentConfirm {
            title: "确认测试环境变更",
            message: format!(
                "保存测试环境「{}」会改变运行边界：\n\n{}\n\n确认写入？",
                environment.name.trim(),
                changes.join("\n")
            ),
            confirm_label: "保存",
        })
    };
    let confirmed = require_user_confirmation(
        &app,
        gesture.inner().as_ref(),
        current_operating_system(),
        content,
        ContentConfirm {
            title: "确认保存测试环境",
            message: format!(
                "即将保存测试环境「{}」。\n\n确认写入？",
                environment.name.trim()
            ),
            confirm_label: "保存",
        },
    )
    .await?;
    if !confirmed {
        return Ok(false);
    }
    let mut connection = state.acquire().await?;
    save_test_environment(&mut connection, &root, &environment).await?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub async fn list_test_environment_records(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
) -> Result<Vec<TestEnvironment>, String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    list_test_environments(&mut connection, &root).await
}

#[tauri::command]
pub async fn delete_test_environment_record(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    environment_id: String,
) -> Result<bool, String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    delete_test_environment(&mut connection, &root, &environment_id).await
}

/// 命令层：工作区路径只取授权根，WebView 不能为其它目录登记运行。
#[tauri::command]
pub async fn create_test_run_record(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    mut run: NewTestRun,
) -> Result<(), String> {
    let root = authorized_root_string(&workspace)?;
    if !run.workspace_path.is_empty() && run.workspace_path != root {
        return Err("测试运行的工作区与当前授权目录不一致".to_string());
    }
    run.workspace_path = root;
    let mut connection = state.acquire().await?;
    create_test_run(&mut connection, &run).await
}

#[tauri::command]
pub async fn transition_test_run_record(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    run_id: String,
    status: TestStatus,
    finished_at: Option<i64>,
    summary_json: Option<String>,
) -> Result<(), String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    ensure_test_record_workspace(&mut connection, TestRecordKind::Run, &run_id, &root).await?;
    transition_test_run(
        &mut connection,
        &run_id,
        status,
        finished_at,
        summary_json.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn transition_test_case_record(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    case_run_id: String,
    status: TestStatus,
    now: i64,
    failure_kind: Option<String>,
    failure_origin: Option<String>,
) -> Result<(), String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    ensure_test_record_workspace(&mut connection, TestRecordKind::Case, &case_run_id, &root)
        .await?;
    transition_test_case(
        &mut connection,
        &case_run_id,
        status,
        now,
        failure_kind.as_deref(),
        failure_origin.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn transition_test_step_record(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    step_run_id: String,
    status: TestStatus,
    now: i64,
    details_json: Option<String>,
    evidence_content_hash: Option<String>,
) -> Result<(), String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    ensure_test_record_workspace(&mut connection, TestRecordKind::Step, &step_run_id, &root)
        .await?;
    transition_test_step(
        &mut connection,
        &step_run_id,
        status,
        now,
        details_json.as_deref(),
        evidence_content_hash.as_deref(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_test_run_records(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    limit: Option<u32>,
) -> Result<Vec<TestRunSummary>, String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    list_test_runs(
        &mut connection,
        &root,
        limit.map_or(50, |value| value as i64),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn latest_test_batch_record(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
) -> Result<Option<TestBatchSummary>, String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    latest_test_batch(&mut connection, &root).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_test_run_record(
    state: State<'_, SessionRepositoryState>,
    workspace: State<'_, WorkspaceAccessState>,
    run_id: String,
) -> Result<Option<TestRunDetail>, String> {
    let root = authorized_root_string(&workspace)?;
    let mut connection = state.acquire().await?;
    let owner: Option<String> =
        sqlx::query_scalar("SELECT workspace_path FROM test_runs WHERE id = ?")
            .bind(&run_id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("无法读取测试运行归属：{error}"))?;
    // 只返回当前授权工作区的运行，避免跨工作区读取历史报告；归属不一致与不存在同样返回 None。
    if owner.as_deref() != Some(root.as_str()) {
        return Ok(None);
    }
    get_test_run(&mut connection, &run_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_schema::{create_options, migrate};
    use sqlx::Connection;

    async fn database() -> (tempfile::TempDir, SqliteConnection) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test-runs.db");
        let mut connection = SqliteConnection::connect_with(&create_options(&path))
            .await
            .unwrap();
        migrate(&mut connection).await.unwrap();
        (directory, connection)
    }

    fn sample_run(id: &str) -> NewTestRun {
        NewTestRun {
            id: id.to_string(),
            workspace_path: "/ws".to_string(),
            spec_path: "tests/checkout.testspec.json".to_string(),
            spec_hash: "hash-1".to_string(),
            plan_content_hash: None,
            source_session_id: None,
            environment_id: None,
            batch_id: None,
            env_facts_json: None,
            started_at: 10,
            cases: vec![NewTestCase {
                id: format!("{id}-case"),
                case_id: "coupon".to_string(),
                case_name: "优惠券".to_string(),
                steps: vec![
                    NewTestStep {
                        id: format!("{id}-step-1"),
                        step_id: "open".to_string(),
                        action: "ui.navigate".to_string(),
                    },
                    NewTestStep {
                        id: format!("{id}-step-2"),
                        step_id: "apply".to_string(),
                        action: "ui.click".to_string(),
                    },
                ],
            }],
        }
    }

    fn sample_environment(id: &str) -> SaveTestEnvironment {
        SaveTestEnvironment {
            id: id.to_string(),
            name: "本地开发".to_string(),
            // 缺省即 `remote`：升级前的环境面板只能填地址，不发这个字段。
            kind: None,
            recipe_json: None,
            web_base_url: Some("http://localhost:5173".to_string()),
            api_base_url: Some("http://localhost:8080".to_string()),
            viewport_width: Some(1280),
            viewport_height: Some(800),
            allow_private_network: false,
            headers_json: "{}".to_string(),
            secret_ids_json: "[]".to_string(),
            updated_at: 10,
        }
    }

    async fn insert_artifact(connection: &mut SqliteConnection, hash: &str) {
        sqlx::query(
            "INSERT INTO artifacts (id, kind, media_type, relative_path, content_hash, size_bytes, created_at) \
             VALUES (?, 'image', 'image/png', ?, ?, 10, 1)",
        )
        .bind(format!("artifact-{hash}"))
        .bind(format!("artifacts/{hash}"))
        .bind(hash)
        .execute(&mut *connection)
        .await
        .unwrap();
    }

    #[test]
    fn transition_table_matches_the_typescript_runner() {
        use TestStatus::*;
        assert!(Queued.can_transition_to(Running));
        assert!(Running.can_transition_to(WaitingApproval));
        assert!(WaitingApproval.can_transition_to(Rejected));
        assert!(!WaitingApproval.can_transition_to(Passed));
        assert!(!Passed.can_transition_to(Running));
        assert!(!Queued.can_transition_to(Failed));
    }

    #[test]
    fn environment_change_summary_lists_boundary_fields() {
        let existing = EnvironmentFields {
            api_base_url: Some("http://localhost:8080".to_string()),
            web_base_url: Some("http://localhost:5173".to_string()),
            secret_ids: BTreeSet::from(["apitest.old".to_string()]),
            allow_private_network: false,
            headers: serde_json::json!({"x-a": "1"}),
        };
        let mut incoming = sample_environment("env-1");
        incoming.api_base_url = Some("https://api.example.com".to_string());
        incoming.web_base_url = Some("https://shop.example.com".to_string());
        incoming.secret_ids_json = "[\"apitest.new\"]".to_string();
        incoming.allow_private_network = true;
        incoming.headers_json = "{\"x-b\":\"2\"}".to_string();
        assert_eq!(
            describe_environment_changes(Some(&existing), &incoming).unwrap(),
            vec![
                "API Base：http://localhost:8080 → https://api.example.com",
                "Web Base：http://localhost:5173 → https://shop.example.com",
                "私网访问：关闭 → 开启",
                "Secret 名单：新增 apitest.new；移除 apitest.old",
                "非敏感 Headers 有变化",
            ]
        );

        let mut unchanged = sample_environment("env-1");
        unchanged.api_base_url = existing.api_base_url.clone();
        unchanged.web_base_url = existing.web_base_url.clone();
        unchanged.secret_ids_json = "[\"apitest.old\"]".to_string();
        unchanged.headers_json = "{\"x-a\":\"1\"}".to_string();
        assert!(describe_environment_changes(Some(&existing), &unchanged)
            .unwrap()
            .is_empty());

        let mut fresh = sample_environment("env-2");
        fresh.api_base_url = None;
        fresh.web_base_url = None;
        fresh.secret_ids_json = "[]".to_string();
        fresh.headers_json = "{}".to_string();
        assert!(describe_environment_changes(None, &fresh)
            .unwrap()
            .is_empty());
        fresh.api_base_url = Some("https://api.example.com".to_string());
        assert_eq!(
            describe_environment_changes(None, &fresh).unwrap(),
            vec!["API Base：未设置 → https://api.example.com"]
        );
    }

    #[tokio::test]
    async fn saves_lists_updates_and_deletes_workspace_environments() {
        let (_directory, mut connection) = database().await;
        let mut environment = sample_environment("env-1");
        save_test_environment(&mut connection, "/ws", &environment)
            .await
            .unwrap();
        environment.name = "本地预览".to_string();
        environment.updated_at = 11;
        save_test_environment(&mut connection, "/ws", &environment)
            .await
            .unwrap();

        let environments = list_test_environments(&mut connection, "/ws")
            .await
            .unwrap();
        assert_eq!(environments.len(), 1);
        assert_eq!(environments[0].name, "本地预览");
        assert_eq!(environments[0].created_at, 10);
        assert_eq!(environments[0].updated_at, 11);
        assert!(list_test_environments(&mut connection, "/other")
            .await
            .unwrap()
            .is_empty());
        assert!(!delete_test_environment(&mut connection, "/other", "env-1")
            .await
            .unwrap());
        assert!(delete_test_environment(&mut connection, "/ws", "env-1")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn rejects_invalid_environments_and_scopes_logical_ids_by_workspace() {
        let (_directory, mut connection) = database().await;
        let mut environment = sample_environment("env-2");
        save_test_environment(&mut connection, "/ws", &environment)
            .await
            .unwrap();
        environment.viewport_height = None;
        assert!(save_test_environment(&mut connection, "/ws", &environment)
            .await
            .is_err());
        environment.viewport_height = Some(800);
        save_test_environment(&mut connection, "/other", &environment)
            .await
            .unwrap();
        assert_eq!(
            list_test_environments(&mut connection, "/ws")
                .await
                .unwrap()[0]
                .id,
            "env-2"
        );
        assert_eq!(
            list_test_environments(&mut connection, "/other")
                .await
                .unwrap()[0]
                .id,
            "env-2"
        );
        environment.id = "env-3".to_string();
        environment.headers_json = r#"{"Authorization":"Bearer plaintext"}"#.to_string();
        assert!(save_test_environment(&mut connection, "/ws", &environment)
            .await
            .is_err());
        environment.headers_json = r#"{"X-Custom-Auth":"Bearer plaintext"}"#.to_string();
        assert!(save_test_environment(&mut connection, "/ws", &environment)
            .await
            .is_err());
        environment.headers_json = "{}".to_string();
        environment.secret_ids_json = r#"["provider.openai.key"]"#.to_string();
        assert!(save_test_environment(&mut connection, "/ws", &environment)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn creates_a_queued_snapshot_and_reads_it_back() {
        let (_directory, mut connection) = database().await;
        create_test_run(&mut connection, &sample_run("run-1"))
            .await
            .unwrap();
        let detail = get_test_run(&mut connection, "run-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.status, TestStatus::Queued);
        assert_eq!(detail.cases.len(), 1);
        assert_eq!(detail.cases[0].steps.len(), 2);
        assert_eq!(detail.cases[0].steps[0].step_id, "open");
    }

    #[tokio::test]
    async fn state_transitions_are_scoped_to_the_owning_workspace() {
        let (_directory, mut connection) = database().await;
        create_test_run(&mut connection, &sample_run("run-owned"))
            .await
            .unwrap();
        for (kind, id) in [
            (TestRecordKind::Run, "run-owned"),
            (TestRecordKind::Case, "run-owned-case"),
            (TestRecordKind::Step, "run-owned-step-1"),
        ] {
            assert!(
                ensure_test_record_workspace(&mut connection, kind, id, "/ws")
                    .await
                    .is_ok()
            );
            assert!(
                ensure_test_record_workspace(&mut connection, kind, id, "/other")
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn rejects_a_plan_reference_to_a_missing_artifact_without_partial_rows() {
        let (_directory, mut connection) = database().await;
        let mut run = sample_run("run-2");
        run.plan_content_hash = Some("missing".to_string());
        assert!(create_test_run(&mut connection, &run).await.is_err());
        assert!(get_test_run(&mut connection, "run-2")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn settles_a_step_once_and_attaches_existing_evidence_atomically() {
        let (_directory, mut connection) = database().await;
        insert_artifact(&mut connection, "shot-hash").await;
        create_test_run(&mut connection, &sample_run("run-3"))
            .await
            .unwrap();

        transition_test_step(
            &mut connection,
            "run-3-step-1",
            TestStatus::Running,
            11,
            None,
            None,
        )
        .await
        .unwrap();
        transition_test_step(
            &mut connection,
            "run-3-step-1",
            TestStatus::Passed,
            12,
            Some("{\"ok\":true}"),
            Some("shot-hash"),
        )
        .await
        .unwrap();

        let second = transition_test_step(
            &mut connection,
            "run-3-step-1",
            TestStatus::Passed,
            13,
            None,
            None,
        )
        .await;
        assert!(second.is_err(), "重复 settle 必须拒绝");

        let detail = get_test_run(&mut connection, "run-3")
            .await
            .unwrap()
            .unwrap();
        let step = &detail.cases[0].steps[0];
        assert_eq!(step.status, TestStatus::Passed);
        assert_eq!(step.started_at, Some(11));
        assert_eq!(step.finished_at, Some(12));
        assert_eq!(step.evidence_content_hash.as_deref(), Some("shot-hash"));
        assert_eq!(
            step.evidence_artifact
                .as_ref()
                .map(|artifact| artifact.media_type.as_str()),
            Some("image/png")
        );
    }

    #[tokio::test]
    async fn rolls_back_settlement_when_evidence_is_missing() {
        let (_directory, mut connection) = database().await;
        create_test_run(&mut connection, &sample_run("run-4"))
            .await
            .unwrap();
        transition_test_step(
            &mut connection,
            "run-4-step-1",
            TestStatus::Running,
            11,
            None,
            None,
        )
        .await
        .unwrap();
        let result = transition_test_step(
            &mut connection,
            "run-4-step-1",
            TestStatus::Passed,
            12,
            None,
            Some("no-such-artifact"),
        )
        .await;
        assert!(result.is_err());
        let detail = get_test_run(&mut connection, "run-4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            detail.cases[0].steps[0].status,
            TestStatus::Running,
            "失败的结算必须整体回滚，保留此前已提交的 running"
        );
    }

    #[tokio::test]
    async fn records_the_objective_failure_origin_alongside_the_failure_kind() {
        let (_directory, mut connection) = database().await;
        create_test_run(&mut connection, &sample_run("run-8"))
            .await
            .unwrap();
        transition_test_case(
            &mut connection,
            "run-8-case",
            TestStatus::Running,
            11,
            None,
            None,
        )
        .await
        .unwrap();
        // 归因与 failure_kind 并列写入；CHECK 只放行四类。
        transition_test_case(
            &mut connection,
            "run-8-case",
            TestStatus::Error,
            12,
            Some("environment"),
            Some("environment"),
        )
        .await
        .unwrap();
        let detail = get_test_run(&mut connection, "run-8")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            detail.cases[0].failure_origin.as_deref(),
            Some("environment")
        );
        assert_eq!(detail.cases[0].failure_kind.as_deref(), Some("environment"));
    }

    #[tokio::test]
    async fn rejects_a_failure_origin_outside_the_whitelist() {
        let (_directory, mut connection) = database().await;
        create_test_run(&mut connection, &sample_run("run-9"))
            .await
            .unwrap();
        transition_test_case(
            &mut connection,
            "run-9-case",
            TestStatus::Running,
            11,
            None,
            None,
        )
        .await
        .unwrap();
        let error = transition_test_case(
            &mut connection,
            "run-9-case",
            TestStatus::Error,
            12,
            None,
            Some("vibes"),
        )
        .await
        .unwrap_err();
        assert!(error.contains("无法更新测试用例状态"), "{error}");
    }

    #[tokio::test]
    async fn interrupts_in_flight_work_without_resuming_and_skips_queued_steps() {
        let (_directory, mut connection) = database().await;
        create_test_run(&mut connection, &sample_run("run-5"))
            .await
            .unwrap();
        transition_test_run(&mut connection, "run-5", TestStatus::Running, None, None)
            .await
            .unwrap();
        transition_test_case(
            &mut connection,
            "run-5-case",
            TestStatus::Running,
            11,
            None,
            None,
        )
        .await
        .unwrap();
        transition_test_step(
            &mut connection,
            "run-5-step-1",
            TestStatus::Running,
            12,
            None,
            None,
        )
        .await
        .unwrap();

        let interrupted = interrupt_active_test_runs(&mut connection, 99)
            .await
            .unwrap();
        assert_eq!(interrupted, 1);
        let detail = get_test_run(&mut connection, "run-5")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.status, TestStatus::Interrupted);
        assert_eq!(detail.cases[0].status, TestStatus::Interrupted);
        assert_eq!(detail.cases[0].steps[0].status, TestStatus::Interrupted);
        assert_eq!(detail.cases[0].steps[1].status, TestStatus::Skipped);

        assert_eq!(
            interrupt_active_test_runs(&mut connection, 100)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn interrupts_cleanup_waiting_for_approval_instead_of_replaying_it() {
        // 崩溃落在 cleanup 的审批卡片上：用户从未确认过副作用，重启后只能记为
        // interrupted（而不是自动补跑），同 run 内尚未开始的 cleanup 步骤记为 skipped。
        let (_directory, mut connection) = database().await;
        let mut run = sample_run("run-6");
        run.cases.push(NewTestCase {
            id: "run-6-afterall".to_string(),
            case_id: "$afterAll".to_string(),
            case_name: "afterAll".to_string(),
            steps: vec![
                NewTestStep {
                    id: "run-6-cleanup-1".to_string(),
                    step_id: "cleanup-paid".to_string(),
                    action: "api.request".to_string(),
                },
                NewTestStep {
                    id: "run-6-cleanup-2".to_string(),
                    step_id: "cleanup-log".to_string(),
                    action: "api.request".to_string(),
                },
            ],
        });
        create_test_run(&mut connection, &run).await.unwrap();
        transition_test_run(&mut connection, "run-6", TestStatus::Running, None, None)
            .await
            .unwrap();
        transition_test_case(
            &mut connection,
            "run-6-afterall",
            TestStatus::Running,
            11,
            None,
            None,
        )
        .await
        .unwrap();
        transition_test_step(
            &mut connection,
            "run-6-cleanup-1",
            TestStatus::Running,
            12,
            None,
            None,
        )
        .await
        .unwrap();
        transition_test_step(
            &mut connection,
            "run-6-cleanup-1",
            TestStatus::WaitingApproval,
            13,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            interrupt_active_test_runs(&mut connection, 99)
                .await
                .unwrap(),
            1
        );
        let detail = get_test_run(&mut connection, "run-6")
            .await
            .unwrap()
            .unwrap();
        let cleanup = detail
            .cases
            .iter()
            .find(|test_case| test_case.case_id == "$afterAll")
            .expect("cleanup case run");
        assert_eq!(cleanup.status, TestStatus::Interrupted);
        assert_eq!(cleanup.steps[0].status, TestStatus::Interrupted);
        assert_eq!(cleanup.steps[1].status, TestStatus::Skipped);
        assert_eq!(detail.summary.status, TestStatus::Interrupted);
        // 二次中断不再命中：崩溃恢复没有补跑入口，重复调用只读不写。
        assert_eq!(
            interrupt_active_test_runs(&mut connection, 120)
                .await
                .unwrap(),
            0
        );
        let after_second = get_test_run(&mut connection, "run-6")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after_second.cases, detail.cases);
    }

    #[tokio::test]
    async fn lists_runs_for_one_workspace_newest_first() {
        let (_directory, mut connection) = database().await;
        create_test_run(&mut connection, &sample_run("run-a"))
            .await
            .unwrap();
        let mut later = sample_run("run-b");
        later.started_at = 20;
        create_test_run(&mut connection, &later).await.unwrap();
        let mut other = sample_run("run-c");
        other.workspace_path = "/other".to_string();
        create_test_run(&mut connection, &other).await.unwrap();

        let runs = list_test_runs(&mut connection, "/ws", 50).await.unwrap();
        assert_eq!(
            runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
            vec!["run-b", "run-a"]
        );
    }

    #[tokio::test]
    async fn returns_the_latest_batch_with_all_of_its_runs() {
        let (_directory, mut connection) = database().await;
        let mut first = sample_run("batch-a");
        first.batch_id = Some("batch-1".to_string());
        first.started_at = 10;
        create_test_run(&mut connection, &first).await.unwrap();
        let mut second = sample_run("batch-b");
        second.batch_id = Some("batch-1".to_string());
        second.started_at = 20;
        create_test_run(&mut connection, &second).await.unwrap();
        // 更晚的单文件运行没有 batch_id：它不应把最近批次挤掉。
        let mut single = sample_run("single");
        single.started_at = 30;
        create_test_run(&mut connection, &single).await.unwrap();
        // 其它工作区的批次不能被读到。
        let mut other = sample_run("other-batch");
        other.batch_id = Some("batch-2".to_string());
        other.workspace_path = "/other".to_string();
        create_test_run(&mut connection, &other).await.unwrap();

        let batch = latest_test_batch(&mut connection, "/ws")
            .await
            .unwrap()
            .expect("latest batch");
        assert_eq!(batch.batch_id, "batch-1");
        assert!(!batch.truncated);
        assert_eq!(
            batch
                .runs
                .iter()
                .map(|run| run.id.as_str())
                .collect::<Vec<_>>(),
            vec!["batch-b", "batch-a"]
        );

        assert!(latest_test_batch(&mut connection, "/missing")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn gc_reference_set_includes_plan_snapshots_and_step_evidence() {
        let (_directory, mut connection) = database().await;
        insert_artifact(&mut connection, "plan-hash").await;
        insert_artifact(&mut connection, "shot-hash").await;
        let mut run = sample_run("run-gc");
        run.plan_content_hash = Some("plan-hash".to_string());
        create_test_run(&mut connection, &run).await.unwrap();
        transition_test_step(
            &mut connection,
            "run-gc-step-1",
            TestStatus::Running,
            11,
            None,
            None,
        )
        .await
        .unwrap();
        transition_test_step(
            &mut connection,
            "run-gc-step-1",
            TestStatus::Passed,
            12,
            None,
            Some("shot-hash"),
        )
        .await
        .unwrap();

        let mut hashes = collect_test_artifact_hashes(&mut connection).await.unwrap();
        hashes.sort();
        assert_eq!(
            hashes,
            vec!["plan-hash".to_string(), "shot-hash".to_string()]
        );
    }

    /// T0-2（§19）：v19 新增的字段必须经仓储 API 往返，并且拒绝面在落库前生效。
    /// 迁移语义（旧行默认值 / CHECK）由 `npm run test:migrations` 覆盖，见
    /// `session_repository_tests.rs::v19_upgrade_defaults_test_automation_columns`。
    #[tokio::test]
    async fn round_trips_environment_kind_and_run_batch_metadata() {
        let (_directory, mut connection) = database().await;

        // 缺省 kind 写成 remote（既有 UI 不发该字段），显式 local 档与配方原样往返。
        save_test_environment(&mut connection, "/ws", &sample_environment("env-default"))
            .await
            .unwrap();
        let mut local = sample_environment("env-local");
        local.kind = Some("local".to_string());
        local.recipe_json = Some(
            r#"{"start":["docker compose up -d"],"readiness":["curl -fsS http://127.0.0.1:8080/health"]}"#
                .to_string(),
        );
        save_test_environment(&mut connection, "/ws", &local)
            .await
            .unwrap();
        let environments = list_test_environments(&mut connection, "/ws")
            .await
            .unwrap();
        let saved_default = environments
            .iter()
            .find(|environment| environment.id == "env-default")
            .unwrap();
        assert_eq!(saved_default.kind, "remote", "缺省 kind 必须写成 remote");
        let saved_local = environments
            .iter()
            .find(|environment| environment.id == "env-local")
            .unwrap();
        assert_eq!(saved_local.kind, "local");
        assert_eq!(saved_local.recipe_json, local.recipe_json);

        // 批次与环境事实随运行落库并在详情里可读；用例归因列为空（写入方是 T3-2）。
        let mut run = sample_run("run-batch");
        run.environment_id = Some("env-local".to_string());
        run.batch_id = Some("batch-1".to_string());
        run.env_facts_json =
            Some(r#"{"environmentId":"env-local","preparedBy":"user"}"#.to_string());
        create_test_run(&mut connection, &run).await.unwrap();
        let detail = get_test_run(&mut connection, "run-batch")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.environment_id.as_deref(), Some("env-local"));
        assert_eq!(detail.summary.batch_id.as_deref(), Some("batch-1"));
        assert_eq!(detail.summary.env_facts_json, run.env_facts_json);
        assert_eq!(detail.cases[0].failure_origin, None);

        // 拒绝面：未知环境档类型与非法环境事实 JSON 都在落库前拦下。
        let mut invalid_environment = sample_environment("env-invalid");
        invalid_environment.kind = Some("cluster".to_string());
        assert!(
            save_test_environment(&mut connection, "/ws", &invalid_environment)
                .await
                .is_err(),
            "未知环境档类型必须被拒绝"
        );
        let mut invalid_run = sample_run("run-invalid");
        invalid_run.env_facts_json = Some("not-json".to_string());
        assert!(
            create_test_run(&mut connection, &invalid_run)
                .await
                .is_err(),
            "环境事实必须是合法 JSON"
        );
    }
}
