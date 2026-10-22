use crate::design_access::{design_document_write_limit, DesignWatchState};
use crate::{
    file_access::{
        canonical_text_file, canonical_text_file_diagnostic, is_supported_text_path,
        CanonicalTextFileError, CanonicalTextFileErrorCode, MAX_TEXT_FILE_BYTES,
    },
    fuzzy_match::{
        apply_replacements_preserving_lines, count_occurrences_normalized, fuzzy_find,
        TextReplacement,
    },
    image_detect::{detect_image_mime, is_supported_image_path, resize_image},
    terminal::TerminalState,
    workspace_approval::WorkspaceApprovalState,
    workspace_command::WorkspaceCommandState,
    workspace_registry,
};
use globset::{Glob, GlobMatcher};
use ignore::{DirEntry, WalkBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    time::UNIX_EPOCH,
};
use tauri::Manager;
use tempfile::NamedTempFile;

const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 1_000;
const DEFAULT_READ_LIMIT: usize = 200;
const MAX_READ_LIMIT: usize = 1_000;
const MAX_READ_OUTPUT_BYTES: usize = 128 * 1024;
const DEFAULT_SEARCH_LIMIT: usize = 100;
const MAX_SEARCH_LIMIT: usize = 500;
const MAX_SEARCH_OUTPUT_BYTES: usize = 128 * 1024;
const MAX_SEARCH_PATTERN_BYTES: usize = 1_024;
const MAX_SEARCH_LINE_CHARS: usize = 500;
const MAX_SEARCH_CONTEXT_LINES: usize = 10;
const DEFAULT_FIND_LIMIT: usize = 1_000;
const MAX_FIND_LIMIT: usize = 1_000;

/// 撤销授权时按工作区归集取消：搜索注册表除取消句柄外还记录所属工作区
/// 根目录，`revoke_impl` 只取消被撤销工作区的搜索，不动其他工作区的在途搜索。
struct WorkspaceSearchRegistration {
    cancellation: Arc<AtomicBool>,
    workspace_root: PathBuf,
}

#[derive(Default)]
pub(crate) struct WorkspaceAccessState {
    root: Mutex<Option<PathBuf>>,
    roots: Mutex<HashSet<PathBuf>>,
    /// 每个授权工作区独立的代际：授权/撤销该工作区时 +1，用于审批租赁的
    /// per-workspace 漂移检测（授权 A 不影响 B 的 pending lease）。单调递增，
    /// 撤销后不删 key，保证「撤销后重新授权」的 generation 继续累加、旧 lease
    /// 一定失效。
    generations: Mutex<HashMap<PathBuf, u64>>,
    searches: Mutex<HashMap<String, WorkspaceSearchRegistration>>,
    /// 注册表（authorized_workspaces.json）读-改-写与授权生命周期（pick /
    /// 恢复授权 / 撤销 / 启动播种）的全局串行锁。只罩住注册表文件操作与内存
    /// 授权集迁移，不覆盖任何工作区文件 I/O——多工作区并行运行时注册表是
    /// 唯一的真全局资源。
    pub(crate) registry_mutations: Mutex<()>,
    /// per-workspace 写串行锁：同工作区的写工具（create / edit / apply_changes /
    /// restore_trash）互斥，不同工作区的写并行——「不同工作目录的会话并行
    /// 运行」的关键分片。key 为 canonical root；值经 Arc 返回，在 map 锁外持有。
    write_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    /// 恢复门：写操作全程持读锁（共享——写与写互不阻塞），恢复扫描持写锁
    /// （独占——必须等全部在途写结束、且新写无法开始，才能看到「无在途
    /// 事务」的静止态去扫描恢复目录）。
    pub(crate) recovery_gate: RwLock<()>,
    recovery_blocked: AtomicBool,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorizedWorkspace {
    path: String,
    name: String,
    git_branch: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEntry {
    path: String,
    name: String,
    kind: String,
    #[specta(type = specta_typescript::Number)]
    size_bytes: u64,
    /// 文件 mtime（Unix epoch ms）。文档索引用它配合 size 复用 revision 缓存，
    /// 避免每次扫描都整文件重读计算 SHA；拿不到时缺省，前端必须回退到实际读取。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    modified_ms: Option<u64>,
}

fn modified_epoch_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceListResult {
    workspace: AuthorizedWorkspace,
    directory: String,
    entries: Vec<WorkspaceEntry>,
    truncated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
enum WorkspaceCommandErrorCode {
    NotAuthorized,
    NotFound,
    InvalidPath,
    Unavailable,
    Unknown,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCommandError {
    code: WorkspaceCommandErrorCode,
    message: String,
}

impl WorkspaceCommandError {
    fn new(code: WorkspaceCommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn from_io(context: &str, error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => WorkspaceCommandErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => WorkspaceCommandErrorCode::NotAuthorized,
            _ => WorkspaceCommandErrorCode::Unknown,
        };
        Self::new(code, format!("{context}: {error}"))
    }
}

impl From<CanonicalTextFileError> for WorkspaceCommandError {
    fn from(error: CanonicalTextFileError) -> Self {
        let code = match error.code {
            CanonicalTextFileErrorCode::NotAuthorized => WorkspaceCommandErrorCode::NotAuthorized,
            CanonicalTextFileErrorCode::NotFound => WorkspaceCommandErrorCode::NotFound,
            CanonicalTextFileErrorCode::InvalidPath => WorkspaceCommandErrorCode::InvalidPath,
            CanonicalTextFileErrorCode::Unavailable => WorkspaceCommandErrorCode::Unavailable,
            CanonicalTextFileErrorCode::Unknown => WorkspaceCommandErrorCode::Unknown,
        };
        Self::new(code, error.message)
    }
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceImage {
    mime_type: String,
    data_base64: String,
    original_width: Option<u32>,
    original_height: Option<u32>,
    resized: bool,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceReadResult {
    workspace: AuthorizedWorkspace,
    path: String,
    content: String,
    sha256: String,
    #[specta(type = specta_typescript::Number)]
    start_line: usize,
    #[specta(type = specta_typescript::Number)]
    end_line: usize,
    #[specta(type = specta_typescript::Number)]
    total_lines: usize,
    truncated: bool,
    #[specta(type = Option<specta_typescript::Number>)]
    next_offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<WorkspaceImage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWriteResult {
    workspace: AuthorizedWorkspace,
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchContextLine {
    line_number: usize,
    line: String,
    is_match: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchMatch {
    path: String,
    line_number: usize,
    line: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_lines: Option<Vec<WorkspaceSearchContextLine>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchResult {
    workspace: AuthorizedWorkspace,
    matches: Vec<WorkspaceSearchMatch>,
    truncated: bool,
}

struct SearchOptions {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    ignore_case: bool,
    literal: bool,
    limit: usize,
    context: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchRequest {
    request_id: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    ignore_case: Option<bool>,
    literal: Option<bool>,
    limit: Option<usize>,
    context: Option<usize>,
}

enum SearchMatcher {
    Literal { pattern: String, ignore_case: bool },
    Regex(Regex),
}

impl SearchMatcher {
    fn is_match(&self, line: &str) -> bool {
        match self {
            Self::Literal {
                pattern,
                ignore_case,
            } => {
                if *ignore_case {
                    line.to_lowercase().contains(pattern)
                } else {
                    line.contains(pattern)
                }
            }
            Self::Regex(regex) => regex.is_match(line),
        }
    }
}

fn git_directory(root: &Path) -> Option<PathBuf> {
    let marker = root.join(".git");
    if marker.is_dir() {
        return Some(marker);
    }
    if marker.is_file() {
        let raw = std::fs::read_to_string(marker).ok()?;
        if raw.len() > 16 * 1024 {
            return None;
        }
        let value = raw.trim().strip_prefix("gitdir:")?.trim();
        if value.is_empty() {
            return None;
        }
        let candidate = PathBuf::from(value);
        return Some(if candidate.is_absolute() {
            candidate
        } else {
            root.join(candidate)
        });
    }
    if root.join("HEAD").is_file() && root.join("objects").is_dir() {
        return Some(root.to_path_buf());
    }
    None
}

fn git_branch(root: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git_directory(root)?.join("HEAD")).ok()?;
    if head.len() > 16 * 1024 {
        return None;
    }
    let head = head.trim();
    if let Some(branch) = head.strip_prefix("ref: refs/heads/") {
        if !branch.is_empty() && branch.len() <= 512 {
            return Some(branch.to_string());
        }
        return None;
    }
    if (7..=64).contains(&head.len()) && head.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Some(format!("detached@{}", &head[..head.len().min(8)]));
    }
    None
}

pub(crate) fn workspace_summary(root: &Path) -> AuthorizedWorkspace {
    AuthorizedWorkspace {
        path: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        git_branch: git_branch(root),
    }
}

pub(crate) fn ensure_workspace_recovery_ready(state: &WorkspaceAccessState) -> Result<(), String> {
    if state.recovery_blocked.load(Ordering::SeqCst) {
        Err("workspace access is blocked until startup recovery succeeds".into())
    } else {
        Ok(())
    }
}

pub(crate) fn set_workspace_recovery_blocked(state: &WorkspaceAccessState, blocked: bool) {
    state.recovery_blocked.store(blocked, Ordering::SeqCst);
}

impl WorkspaceAccessState {
    pub(crate) fn generation_for(&self, path: &Path) -> u64 {
        self.generations
            .lock()
            .map(|generations| generations.get(path).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    /// 取指定工作区的写锁句柄。map 锁只罩住 get-or-insert 并立即返回 Arc 克隆，
    /// 真正的 lock() 在 map 锁外进行——短锁不会被长写拖住。锁序约定：写路径
    /// 统一为 recovery_gate.read → per-workspace 写锁；撤销为 registry_mutations
    /// → per-workspace 写锁。两条链都不反向取锁（写路径不取注册表锁），无死环。
    pub(crate) fn workspace_write_lock(&self, root: &Path) -> Arc<Mutex<()>> {
        // map 临界区只做条目查找/插入，不会 panic；中毒时恢复内部数据继续服务。
        let mut locks = self
            .write_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.entry(root.to_path_buf()).or_default().clone()
    }
}

pub(crate) fn authorized_root(state: &WorkspaceAccessState) -> Result<PathBuf, String> {
    ensure_workspace_recovery_ready(state)?;
    state
        .root
        .lock()
        .map_err(|_| "workspace authorization state lock is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "no workspace has been authorized for this Axiom process".to_string())
}

pub(crate) fn authorized_root_for(
    state: &WorkspaceAccessState,
    workspace_path: Option<&str>,
) -> Result<PathBuf, String> {
    ensure_workspace_recovery_ready(state)?;
    let Some(workspace_path) = workspace_path else {
        return authorized_root(state);
    };
    if workspace_path.is_empty() || workspace_path.len() > 16 * 1024 {
        return Err("workspace path is invalid".into());
    }
    let requested = PathBuf::from(workspace_path);
    let roots = state
        .roots
        .lock()
        .map_err(|_| "workspace authorization set lock is poisoned".to_string())?;
    roots
        .get(&requested)
        .cloned()
        .ok_or_else(|| "workspace is not authorized for this Axiom process".to_string())
}

/// 全部已授权工作区根（canonical），用于隐私目录项目子根的窄范围判定。
/// 凭据与应用数据不得豁免；锁中毒时返回空集，沿 fail-closed 方向退化。
pub(crate) fn authorized_roots(state: &WorkspaceAccessState) -> Vec<PathBuf> {
    state
        .roots
        .lock()
        .map(|roots| roots.iter().cloned().collect())
        .unwrap_or_default()
}

/// 解析并校验待授权目录：长度上限 + canonicalize（消解 symlink/相对段）+
/// 必须是真实目录。原生选择器授权与重启恢复授权共用。
fn resolve_workspace_directory(raw_path: &str) -> Result<PathBuf, String> {
    if raw_path.len() > 16 * 1024 {
        return Err("workspace path is too long".into());
    }
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|error| format!("failed to resolve selected workspace: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect selected workspace: {error}"))?;
    if !metadata.is_dir() {
        return Err("selected workspace is not a directory".into());
    }
    Ok(canonical)
}

/// 将已解析的目录登记进进程内授权集（roots / 活跃 root / generation）。
fn authorize_root_in_memory(
    state: &WorkspaceAccessState,
    canonical: &Path,
) -> Result<AuthorizedWorkspace, String> {
    let inserted = state
        .roots
        .lock()
        .map_err(|_| "workspace authorization set lock is poisoned".to_string())?
        .insert(canonical.to_path_buf());
    *state
        .root
        .lock()
        .map_err(|_| "workspace authorization state lock is poisoned".to_string())? =
        Some(canonical.to_path_buf());
    if inserted {
        if let Ok(mut generations) = state.generations.lock() {
            *generations.entry(canonical.to_path_buf()).or_insert(0) += 1;
        }
    }
    Ok(workspace_summary(canonical))
}

/// 未经注册表校验的直接内存授权：仅测试使用（生产路径必须经 pick 的
/// registry_insert 或恢复的 registry_contains，见 workspace_registry.rs）。
#[cfg(test)]
fn authorize_impl(
    state: &WorkspaceAccessState,
    raw_path: &str,
) -> Result<AuthorizedWorkspace, String> {
    authorize_root_in_memory(state, &resolve_workspace_directory(raw_path)?)
}

/// 重启恢复授权（authorize_workspace 命令）专用：只接受注册表登记过的目录。
/// 注册表的唯一写入方是原生目录选择器与撤销移除（见 workspace_registry.rs
/// 模块注释）；受陷渲染进程传入未登记路径（如 `$HOME`、`/`）在此
/// fail-closed 拒绝，防止其借 SandboxSafe 免手势租约把 seatbelt 的
/// 「写限工作区」扩张成「写限全盘」。
fn authorize_restore_impl(
    state: &WorkspaceAccessState,
    registry_file: &Path,
    raw_path: &str,
) -> Result<AuthorizedWorkspace, String> {
    authorize_restore_with_home(
        state,
        registry_file,
        raw_path,
        &crate::sandbox::policy_home()?,
    )
}

fn authorize_restore_with_home(
    state: &WorkspaceAccessState,
    registry_file: &Path,
    raw_path: &str,
    home: &Path,
) -> Result<AuthorizedWorkspace, String> {
    let canonical = resolve_workspace_directory(raw_path)?;
    if !workspace_registry::registry_contains(registry_file, &canonical)? {
        return Err(format!(
            "workspace {} was not previously authorized via the folder picker; authorize it again from the picker",
            canonical.display()
        ));
    }
    if let Some(scope) = crate::sandbox::workspace_sensitive_scope(home, &canonical)? {
        if !workspace_registry::registry_sensitive_scope_matches(registry_file, &canonical, &scope)?
        {
            return Err(
                "该工作区位于隐私目录，需要重新通过原生目录选择器确认精确子目录范围。".into(),
            );
        }
    }
    authorize_root_in_memory(state, &canonical)
}

/// 内存撤销：只作用于目标工作区。搜索取消同样按工作区归集——撤销 A 不再
/// 误杀 B 的在途搜索（调用方 `revoke_workspace` 负责注册表移除与命令/终端
/// 的同范围取消，并在本函数前持有目标工作区的写锁以等出在途写）。
fn revoke_impl(state: &WorkspaceAccessState, target: &Path) -> Result<bool, String> {
    let removed = state
        .roots
        .lock()
        .map_err(|_| "workspace authorization set lock is poisoned".to_string())?
        .remove(target);
    if removed {
        let replacement = state
            .roots
            .lock()
            .map_err(|_| "workspace authorization set lock is poisoned".to_string())?
            .iter()
            .next()
            .cloned();
        let mut active = state
            .root
            .lock()
            .map_err(|_| "workspace authorization state lock is poisoned".to_string())?;
        if active.as_deref() == Some(target) {
            *active = replacement;
        }
        if let Ok(mut generations) = state.generations.lock() {
            *generations.entry(target.to_path_buf()).or_insert(0) += 1;
        }
    }
    let mut searches = state
        .searches
        .lock()
        .map_err(|_| "workspace search state lock is poisoned".to_string())?;
    let stale: Vec<String> = searches
        .iter()
        .filter(|(_, registration)| registration.workspace_root == target)
        .map(|(request_id, _)| request_id.clone())
        .collect();
    for request_id in stale {
        if let Some(registration) = searches.remove(&request_id) {
            registration.cancellation.store(true, Ordering::Relaxed);
        }
    }
    Ok(removed)
}

/// 写操作路径作用域。`root` 始终是会话授权工作区（敏感策略豁免、事务指纹、
/// receipt 身份与设计稿历史目录都以它为锚）；仅「目标是否必须落在 root 内」
/// 随 `confined` 切换。写工具（write/edit/apply_changes/restore_trash）共用
/// 本类型，保证「完全访问放开工作区包含限制」在所有写入口上是同一判据。
#[derive(Clone, Copy)]
pub(crate) struct MutationScope<'a> {
    pub(crate) root: &'a Path,
    pub(crate) confined: bool,
}

impl<'a> MutationScope<'a> {
    /// 标准模式：只接受相对路径，且必须落在授权工作区内。
    pub(crate) fn workspace(root: &'a Path) -> Self {
        Self {
            root,
            confined: true,
        }
    }

    /// 完全访问：接受绝对路径，不受工作区包含限制（保护路径仍由
    /// `SensitivePathPolicy` 拒绝，与本类型无关）。
    pub(crate) fn unrestricted(root: &'a Path) -> Self {
        Self {
            root,
            confined: false,
        }
    }

    /// 按事务记录的作用域重建。旧事务没有该字段，读出 `false` 即沿用工作区
    /// 包含规则重放（fail-closed），行为与放开前逐字一致。
    pub(crate) fn from_record(root: &'a Path, unconfined: bool) -> Self {
        Self {
            root,
            confined: !unconfined,
        }
    }

    /// 完全访问档的路径形状校验：接受绝对路径，仍拒绝 `..` 与空路径。
    /// `.git`/`.axiom` 段不由路径层拒绝（工作区外写 `.git` 是正常操作），
    /// Axiom 数据根由敏感路径策略统一覆盖。
    pub(crate) fn validate_unrestricted_path(raw_path: &str) -> Result<PathBuf, String> {
        let raw_path = raw_path.trim();
        if raw_path.is_empty() || raw_path.len() > 16 * 1024 {
            return Err("workspace change path must be a non-empty path".into());
        }
        let path = PathBuf::from(raw_path);
        if path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("workspace changes do not accept '..' in paths".into());
        }
        let normalized = path
            .components()
            .filter_map(|part| match part {
                Component::Normal(value) => Some(value),
                Component::CurDir => None,
                Component::RootDir => Some(std::ffi::OsStr::new("/")),
                _ => None,
            })
            .collect::<PathBuf>();
        if normalized.as_os_str().is_empty() {
            return Err("workspace change path has no file name".into());
        }
        Ok(normalized)
    }
}

/// 审批租约携带的档位 → 写作用域。只有完全访问签发的租约是 `Unrestricted`
/// （档位由 Rust 签发侧分类，渲染进程无法自报），因此该判定与 bash 同源。
pub(crate) fn mutation_scope_for<'a>(
    root: &'a Path,
    tier: Option<crate::sandbox::CommandTier>,
) -> MutationScope<'a> {
    match tier {
        Some(crate::sandbox::CommandTier::Unrestricted) => MutationScope::unrestricted(root),
        _ => MutationScope::workspace(root),
    }
}

pub(crate) fn validate_relative_path(raw_path: Option<&str>) -> Result<PathBuf, String> {
    let raw_path = raw_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(".");
    if raw_path.len() > 16 * 1024 {
        return Err("workspace-relative path is too long".into());
    }
    let path = PathBuf::from(raw_path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("workspace tools only accept relative paths without '..'".into());
    }
    Ok(path)
}

/// Single-file writes must not touch repository/app control directories,
/// matching the batch apply_workspace_changes policy.
/// 拒保留目录（`.git`/`.axiom`）写入：按 ASCII 小写比较（APFS/HFS+ 默认大小写
/// 不敏感，`.GIT`/`.Git` 会解析到真实的 `.git`）。设计稿画布写通道同口径复用。
pub(crate) fn reject_reserved_write_components(relative: &Path) -> Result<(), String> {
    if relative.components().any(|component| match component {
        // APFS/HFS+ 默认大小写不敏感：`.GIT`、`.Git` 会解析到真实的 `.git`，
        // 因此按 ASCII 小写比较，避免大小写变体绕过保留目录。
        Component::Normal(value) => {
            let lowered = value.to_string_lossy().to_ascii_lowercase();
            lowered == ".git" || lowered == ".axiom"
        }
        _ => false,
    }) {
        return Err("workspace control directories cannot be changed".into());
    }
    Ok(())
}

pub(crate) fn workspace_path_policy(
    root: &Path,
) -> Result<crate::sandbox::SensitivePathPolicy, String> {
    Ok(crate::sandbox::SensitivePathPolicy::new(
        &crate::sandbox::policy_home()?,
        &[root.to_path_buf()],
    ))
}

pub(crate) fn ensure_workspace_path_access(
    root: &Path,
    path: &Path,
    mutation: bool,
) -> Result<(), String> {
    ensure_path_access(&workspace_path_policy(root)?, path, mutation)
}

pub(crate) fn ensure_path_access(
    policy: &crate::sandbox::SensitivePathPolicy,
    path: &Path,
    mutation: bool,
) -> Result<(), String> {
    if if mutation {
        policy.mutation_denied(path)
    } else {
        policy.read_denied(path)
    } {
        return Err("工作区授权不能解除敏感路径保护：凭据和 Axiom 数据不可读取或改名；隐私目录只开放经原生确认的项目子目录。".into());
    }
    Ok(())
}

fn resolve_workspace_path_with_policy(
    root: &Path,
    raw_path: Option<&str>,
    policy: &crate::sandbox::SensitivePathPolicy,
) -> Result<PathBuf, String> {
    let relative = validate_relative_path(raw_path)?;
    let canonical = std::fs::canonicalize(root.join(relative))
        .map_err(|error| format!("failed to resolve workspace path: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("workspace path resolves outside the authorized root".into());
    }
    ensure_path_access(policy, &canonical, false)?;
    Ok(canonical)
}

/// 父目录不存在时，逐级创建缺失的目录。安全边界与既有父目录解析一致：
/// 标准模式下，最近的存在祖先必须落在授权根内（这一条同时拦住了「经符号链接把目录
/// 建到根外」），且只做单级 `create_dir`（`create_dir_all` 会跟随符号链接，故不用）；
/// 完全访问不限制父目录位置，敏感路径保护由调用方后续的 `ensure_workspace_path_access` 生效。
/// 崩溃语义：目录可能已建而文件尚未落盘，遗留的是**空目录**（文件写盘本身仍由
/// `NamedTempFile::persist_noclobber` 原子完成），不丢数据、可安全忽略。
fn ensure_parent_directories(
    scope: MutationScope<'_>,
    expected_parent: &Path,
) -> Result<(), String> {
    if expected_parent.exists() {
        return Ok(());
    }
    let mut existing = expected_parent;
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| "workspace file parent has no name".to_string())?;
        missing.push(name);
        existing = existing
            .parent()
            .ok_or_else(|| "workspace file parent has no existing ancestor".to_string())?;
    }
    missing.reverse();
    let mut cursor = if scope.confined {
        let canonical_ancestor = std::fs::canonicalize(existing)
            .map_err(|error| format!("failed to resolve workspace parent ancestor: {error}"))?;
        if !canonical_ancestor.starts_with(scope.root) {
            return Err("workspace file parent crosses the authorized root".into());
        }
        canonical_ancestor
    } else {
        existing.to_path_buf()
    };
    for name in missing {
        cursor = cursor.join(name);
        match std::fs::create_dir(&cursor) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("failed to create workspace file parent: {error}")),
        }
    }
    Ok(())
}

/// 按写作用域解析新文件目标。标准模式只接受工作区内相对路径；完全访问接受
/// 绝对路径（父目录同样可落在工作区外），敏感路径保护在两种档位下一致生效。
fn resolve_new_workspace_file(scope: MutationScope<'_>, raw_path: &str) -> Result<PathBuf, String> {
    let relative = if scope.confined {
        let relative = validate_relative_path(Some(raw_path))?;
        reject_reserved_write_components(&relative)?;
        if relative.as_os_str() == "." {
            return Err("workspace file path cannot be empty".into());
        }
        relative
    } else {
        MutationScope::validate_unrestricted_path(raw_path)?
    };
    let file_name = relative
        .file_name()
        .ok_or_else(|| "workspace file path must include a file name".to_string())?;
    let parent = relative.parent().unwrap_or_else(|| Path::new("."));
    let expected_parent = if relative.is_absolute() {
        parent.to_path_buf()
    } else {
        scope.root.join(parent)
    };
    // 父目录可能尚不存在（例如空仓库里写 `tests/x.testspec.json`）：在授权根内自动创建缺失的
    // 父目录。标准模式只允许授权根内的相对父路径，完全访问允许绝对路径的父目录——
    // 敏感路径判定由下面的 `ensure_workspace_path_access` 兜底。
    ensure_parent_directories(scope, &expected_parent)?;
    let canonical_parent = std::fs::canonicalize(&expected_parent)
        .map_err(|error| format!("failed to resolve workspace file parent: {error}"))?;
    if scope.confined && !canonical_parent.starts_with(scope.root) {
        return Err("workspace file parent resolves outside the authorized root".into());
    }
    let metadata = std::fs::metadata(&canonical_parent)
        .map_err(|error| format!("failed to inspect workspace file parent: {error}"))?;
    if !metadata.is_dir() {
        return Err("workspace file parent is not a directory".into());
    }
    let target = canonical_parent.join(file_name);
    ensure_workspace_path_access(scope.root, &target, true)?;
    // `.ax` 设计稿定点放行：不经文本扩展白名单（8MiB 上限由写入侧按 limit 生效）。
    if design_document_write_limit(&target).is_none() && !is_supported_text_path(&target) {
        return Err("workspace file type is not supported for text writing".into());
    }
    Ok(target)
}

fn validate_write_content(content: &str, max_bytes: u64) -> Result<(), String> {
    if content.len() as u64 > max_bytes {
        return Err(format!(
            "workspace text file would be larger than {} MiB",
            max_bytes / (1024 * 1024)
        ));
    }
    Ok(())
}

/// A single oldText -> newText replacement requested for one file.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEditOp {
    old_text: String,
    new_text: String,
}

/// Request payload for `edit_workspace_text_file`. Supports one or more
/// non-overlapping replacements in a single approval.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEditRequest {
    path: String,
    edits: Vec<WorkspaceEditOp>,
}

/// Normalize lone CR / CRLF to LF for matching, mirroring pi's `normalizeToLF`.
fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn not_found_error(path: &str, edit_index: usize, total_edits: usize) -> String {
    if total_edits == 1 {
        format!("Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines.")
    } else {
        format!("Could not find edits[{edit_index}] in {path}. The oldText must match exactly including all whitespace and newlines.")
    }
}

fn duplicate_error(
    path: &str,
    edit_index: usize,
    total_edits: usize,
    occurrences: usize,
) -> String {
    if total_edits == 1 {
        format!("Found {occurrences} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique.")
    } else {
        format!("Found {occurrences} occurrences of edits[{edit_index}] in {path}. Each oldText must be unique. Please provide more context to make it unique.")
    }
}

fn empty_old_text_error(path: &str, edit_index: usize, total_edits: usize) -> String {
    if total_edits == 1 {
        format!("oldText must not be empty in {path}.")
    } else {
        format!("edits[{edit_index}].oldText must not be empty in {path}.")
    }
}

fn no_change_error(path: &str, total_edits: usize) -> String {
    if total_edits == 1 {
        format!("No changes made to {path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.")
    } else {
        format!("No changes made to {path}. The replacements produced identical content.")
    }
}

/// rename 持久化后再 fsync 父目录：否则崩溃时可产生「rename 已记入目录、数据
/// 未落盘」的空文件。设计稿画布写通道与 Agent 写路径共用同一收口。
pub(crate) fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "workspace file has no parent directory".to_string())?;
    crate::storage_paths::sync_directory(parent)
        .map_err(|error| format!("failed to sync workspace directory: {error}"))
}

fn create_text_file_impl(
    scope: MutationScope<'_>,
    raw_path: &str,
    content: &str,
) -> Result<WorkspaceWriteResult, String> {
    let root = scope.root;
    let target = resolve_new_workspace_file(scope, raw_path)?;
    validate_write_content(
        content,
        design_document_write_limit(&target).unwrap_or(MAX_TEXT_FILE_BYTES),
    )?;
    match std::fs::symlink_metadata(&target) {
        Ok(_) => return Err("workspace create refuses to overwrite an existing path".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect workspace create path: {error}")),
    }
    let parent = target
        .parent()
        .ok_or_else(|| "workspace file has no parent directory".to_string())?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create workspace temporary file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("failed to write workspace temporary file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync workspace temporary file: {error}"))?;
    temporary.persist_noclobber(&target).map_err(|error| {
        format!(
            "workspace create refuses to overwrite an existing path: {}",
            error.error
        )
    })?;
    sync_parent_directory(&target)?;
    Ok(WorkspaceWriteResult {
        workspace: workspace_summary(root),
        path: scoped_path_display(scope, &target),
        size_bytes: content.len() as u64,
        sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
    })
}

/// 结果里的路径展示：标准模式给出工作区相对路径，完全访问的目标可能落在工作区
/// 外，此时原样返回绝对路径（与 workspace_changes 的 relative_display 同口径）。
fn scoped_path_display(scope: MutationScope<'_>, target: &Path) -> String {
    if scope.confined || !target.is_absolute() {
        relative_display(scope.root, target)
    } else {
        target.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
fn edit_text_file_impl(
    root: &Path,
    path: &str,
    edits: &[WorkspaceEditOp],
) -> Result<WorkspaceWriteResult, String> {
    edit_text_file_with_history_impl(MutationScope::workspace(root), path, edits, None)
}

fn edit_text_file_with_history_impl(
    scope: MutationScope<'_>,
    raw_path: &str,
    edits: &[WorkspaceEditOp],
    data_root: Option<&Path>,
) -> Result<WorkspaceWriteResult, String> {
    let root = scope.root;
    let total_edits = edits.len();
    if total_edits == 0 {
        return Err("workspace edit requires at least one edit".into());
    }
    // 标准模式只接受工作区内相对路径并拒保留目录；完全访问接受绝对路径，
    // `.git`/`.axiom` 段交由敏感路径策略判定（Axiom 数据根始终拒绝）。
    let relative = if scope.confined {
        let relative = validate_relative_path(Some(raw_path))?;
        reject_reserved_write_components(&relative)?;
        relative
    } else {
        MutationScope::validate_unrestricted_path(raw_path)?
    };
    let requested = if relative.is_absolute() {
        relative.clone()
    } else {
        root.join(&relative)
    };
    // `.ax` 设计稿定点放行：不经 canonical_text_file 的文本扩展白名单与 1MiB
    // 上限，改按设计稿上限（containment / is_file / UTF-8 校验全部保留）。
    let write_limit = design_document_write_limit(&requested).unwrap_or(MAX_TEXT_FILE_BYTES);
    for (index, edit) in edits.iter().enumerate() {
        if edit.old_text.is_empty() {
            return Err(empty_old_text_error(raw_path, index, total_edits));
        }
        if edit.old_text.len() as u64 > write_limit || edit.new_text.len() as u64 > write_limit {
            return Err(format!(
                "workspace edit text is larger than {} MiB",
                write_limit / (1024 * 1024)
            ));
        }
    }
    let canonical = if write_limit == MAX_TEXT_FILE_BYTES {
        let (canonical, _) = canonical_text_file(&requested.to_string_lossy())?;
        if scope.confined && !canonical.starts_with(root) {
            return Err("workspace file resolves outside the authorized root".into());
        }
        canonical
    } else {
        let canonical = std::fs::canonicalize(&requested)
            .map_err(|error| format!("failed to resolve workspace path: {error}"))?;
        if scope.confined && !canonical.starts_with(root) {
            return Err("workspace file resolves outside the authorized root".into());
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("failed to inspect workspace text file: {error}"))?;
        if !metadata.is_file() {
            return Err("workspace edit requires a regular text file".into());
        }
        if metadata.len() > write_limit {
            return Err(format!(
                "workspace text file is larger than {} MiB",
                write_limit / (1024 * 1024)
            ));
        }
        canonical
    };
    ensure_workspace_path_access(root, &canonical, true)?;
    let bytes = std::fs::read(&canonical)
        .map_err(|error| format!("failed to read workspace text file: {error}"))?;
    let original = String::from_utf8(bytes)
        .map_err(|_| "workspace file is not valid UTF-8 text".to_string())?;

    // Normalize only line endings for the match space. Character-level
    // normalization (smart quotes/dashes/etc.) happens on demand via fuzzy_find.
    let normalized = normalize_to_lf(&original);

    // Resolve each edit against the normalized content: find, uniqueness-check
    // (in the normalized match space), and record where it lands.
    struct ResolvedEdit {
        replacement: TextReplacement,
        new_text: String,
        edit_index: usize,
    }
    let mut resolved: Vec<ResolvedEdit> = Vec::with_capacity(total_edits);
    let mut any_fuzzy = false;
    for (index, edit) in edits.iter().enumerate() {
        let lf_old = normalize_to_lf(&edit.old_text);
        let Some(found) = fuzzy_find(&normalized, &lf_old) else {
            return Err(not_found_error(raw_path, index, total_edits));
        };
        let occurrences = count_occurrences_normalized(&normalized, &lf_old);
        if occurrences > 1 {
            return Err(duplicate_error(raw_path, index, total_edits, occurrences));
        }
        any_fuzzy = any_fuzzy || found.used_fuzzy;
        resolved.push(ResolvedEdit {
            replacement: TextReplacement {
                match_index: found.index,
                match_length: found.match_length,
            },
            new_text: normalize_to_lf(&edit.new_text),
            edit_index: index,
        });
    }

    // Detect overlapping edits (sort by match_index; touching ranges are allowed).
    resolved.sort_by_key(|item| item.replacement.match_index);
    for window in resolved.windows(2) {
        let prev = &window[0];
        let cur = &window[1];
        let prev_end = prev
            .replacement
            .match_index
            .saturating_add(prev.replacement.match_length);
        if prev_end > cur.replacement.match_index {
            return Err(format!(
                "edits[{}] and edits[{}] overlap in {}. Merge them into one edit or target disjoint regions.",
                prev.edit_index, cur.edit_index, raw_path
            ));
        }
    }

    let replacements: Vec<TextReplacement> = resolved.iter().map(|item| item.replacement).collect();
    let new_texts: Vec<String> = resolved.iter().map(|item| item.new_text.clone()).collect();
    let updated = if any_fuzzy {
        // Fuzzy edits matched against the normalized form: realign onto the
        // original line-normalized content so untouched lines keep their bytes.
        let base = crate::fuzzy_match::normalize_for_fuzzy_match(&normalized);
        apply_replacements_preserving_lines(&normalized, &base, &replacements, &new_texts)?
    } else {
        // Exact matches: splice directly into the LF-normalized content.
        apply_in_place(&normalized, &replacements, &new_texts)
    };

    if updated == normalized {
        return Err(no_change_error(raw_path, total_edits));
    }
    validate_write_content(
        &updated,
        design_document_write_limit(&canonical).unwrap_or(MAX_TEXT_FILE_BYTES),
    )?;

    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect workspace text file: {error}"))?;
    let parent = canonical
        .parent()
        .ok_or_else(|| "workspace file has no parent directory".to_string())?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create workspace temporary file: {error}"))?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("failed to preserve workspace file permissions: {error}"))?;
    temporary
        .write_all(updated.as_bytes())
        .map_err(|error| format!("failed to write workspace temporary file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync workspace temporary file: {error}"))?;
    if let Some(data_root) = data_root {
        crate::design_history::backup(data_root, root, &canonical, original.as_bytes())?;
    }
    temporary.persist(&canonical).map_err(|error| {
        format!(
            "failed to atomically replace workspace file: {}",
            error.error
        )
    })?;
    sync_parent_directory(&canonical)?;
    Ok(WorkspaceWriteResult {
        workspace: workspace_summary(root),
        path: scoped_path_display(scope, &canonical),
        size_bytes: updated.len() as u64,
        sha256: format!("{:x}", Sha256::digest(updated.as_bytes())),
    })
}

/// Apply exact (non-fuzzy) replacements to `content` in reverse index order.
fn apply_in_place(content: &str, replacements: &[TextReplacement], new_texts: &[String]) -> String {
    let mut result = content.to_string();
    let mut order: Vec<usize> = (0..replacements.len()).collect();
    order.sort_by(|&a, &b| {
        replacements[b]
            .match_index
            .cmp(&replacements[a].match_index)
    });
    for &i in &order {
        let r = replacements[i];
        let end = r.match_index.saturating_add(r.match_length);
        if end > result.len() {
            continue;
        }
        result.replace_range(r.match_index..end, &new_texts[i]);
    }
    result
}

fn relative_display(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if relative.as_os_str().is_empty() {
        return ".".into();
    }
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn list_impl(
    root: &Path,
    raw_path: Option<&str>,
    limit: Option<usize>,
) -> Result<WorkspaceListResult, WorkspaceCommandError> {
    let policy = workspace_path_policy(root).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::Unavailable, message)
    })?;
    list_impl_with_policy(root, raw_path, limit, &policy)
}

fn list_impl_with_policy(
    root: &Path,
    raw_path: Option<&str>,
    limit: Option<usize>,
    policy: &crate::sandbox::SensitivePathPolicy,
) -> Result<WorkspaceListResult, WorkspaceCommandError> {
    let relative = validate_relative_path(raw_path).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::InvalidPath, message)
    })?;
    let directory = std::fs::canonicalize(root.join(relative)).map_err(|error| {
        WorkspaceCommandError::from_io("failed to resolve workspace path", error)
    })?;
    if !directory.starts_with(root) {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            "workspace path resolves outside the authorized root",
        ));
    }
    ensure_path_access(policy, &directory, false).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::NotAuthorized, message)
    })?;
    if !std::fs::metadata(&directory)
        .map_err(|error| {
            WorkspaceCommandError::from_io("failed to inspect workspace directory", error)
        })?
        .is_dir()
    {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            "workspace list path is not a directory",
        ));
    }
    let effective_limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let mut raw_entries = std::fs::read_dir(&directory)
        .map_err(|error| {
            WorkspaceCommandError::from_io("failed to read workspace directory", error)
        })?
        .filter_map(Result::ok)
        .filter(|entry| !policy.read_denied(&entry.path()))
        .collect::<Vec<_>>();
    raw_entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    let truncated = raw_entries.len() > effective_limit;
    let mut entries = Vec::new();
    for entry in raw_entries.into_iter().take(effective_limit) {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let kind = if file_type.is_dir() {
            "directory"
        } else if file_type.is_file() {
            "file"
        } else if file_type.is_symlink() {
            "symlink"
        } else {
            "other"
        };
        let metadata = entry.metadata().ok();
        let size_bytes = if file_type.is_file() {
            metadata
                .as_ref()
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        } else {
            0
        };
        entries.push(WorkspaceEntry {
            path: relative_display(root, &entry.path()),
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.into(),
            size_bytes,
            modified_ms: metadata.as_ref().and_then(modified_epoch_ms),
        });
    }
    Ok(WorkspaceListResult {
        workspace: workspace_summary(root),
        directory: relative_display(root, &directory),
        entries,
        truncated,
    })
}

fn read_impl(
    root: &Path,
    raw_path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<WorkspaceReadResult, WorkspaceCommandError> {
    let policy = workspace_path_policy(root).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::Unavailable, message)
    })?;
    read_impl_with_policy(root, raw_path, offset, limit, &policy)
}

fn read_impl_with_policy(
    root: &Path,
    raw_path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    policy: &crate::sandbox::SensitivePathPolicy,
) -> Result<WorkspaceReadResult, WorkspaceCommandError> {
    let relative = validate_relative_path(Some(raw_path)).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::InvalidPath, message)
    })?;
    ensure_path_access(policy, &root.join(&relative), false).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::NotAuthorized, message)
    })?;

    // Image branch: bypass the text-only extension whitelist and return a
    // base64 image payload (resized to fit provider limits) instead of text.
    if is_supported_image_path(&root.join(&relative)) {
        return read_image_impl(root, &relative, policy);
    }

    let requested = root.join(relative);
    let canonical = if let Some(max_bytes) = design_document_write_limit(&requested) {
        let canonical = std::fs::canonicalize(&requested).map_err(|error| {
            WorkspaceCommandError::from_io("failed to resolve workspace path", error)
        })?;
        if !canonical.starts_with(root) {
            return Err(WorkspaceCommandError::new(
                WorkspaceCommandErrorCode::InvalidPath,
                "workspace file resolves outside the authorized root",
            ));
        }
        let metadata = std::fs::metadata(&canonical).map_err(|error| {
            WorkspaceCommandError::from_io("failed to inspect workspace text file", error)
        })?;
        if !metadata.is_file() {
            return Err(WorkspaceCommandError::new(
                WorkspaceCommandErrorCode::InvalidPath,
                "workspace read requires a regular text file",
            ));
        }
        if metadata.len() > max_bytes {
            return Err(WorkspaceCommandError::new(
                WorkspaceCommandErrorCode::Unavailable,
                format!(
                    "workspace text file is larger than {} MiB",
                    max_bytes / (1024 * 1024)
                ),
            ));
        }
        canonical
    } else {
        canonical_text_file_diagnostic(&requested.to_string_lossy())?.0
    };
    if !canonical.starts_with(root) {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            "workspace file resolves outside the authorized root",
        ));
    }
    ensure_path_access(policy, &canonical, false).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::NotAuthorized, message)
    })?;
    let bytes = std::fs::read(&canonical).map_err(|error| {
        WorkspaceCommandError::from_io("failed to read workspace text file", error)
    })?;
    let content = String::from_utf8(bytes).map_err(|_| {
        WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            "workspace file is not valid UTF-8 text",
        )
    })?;
    let lines = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let total_lines = lines.len();
    let start_line = offset.unwrap_or(1).max(1);
    if start_line > total_lines {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            format!("workspace read offset {start_line} is beyond the file's {total_lines} lines"),
        ));
    }
    let requested_limit = limit.unwrap_or(DEFAULT_READ_LIMIT).clamp(1, MAX_READ_LIMIT);
    let start_index = start_line - 1;
    let requested_end = (start_index + requested_limit).min(total_lines);
    let mut output_lines = Vec::new();
    let mut output_bytes = 0usize;
    for line in &lines[start_index..requested_end] {
        let additional = line.len() + usize::from(!output_lines.is_empty());
        if output_bytes.saturating_add(additional) > MAX_READ_OUTPUT_BYTES {
            break;
        }
        output_bytes += additional;
        output_lines.push(*line);
    }
    if output_lines.is_empty() {
        // The very first line exceeds the byte budget: instead of dead-ending
        // with an error, surface an actionable hint so the model can choose a
        // strategy (narrow the offset/limit, or use a controlled command).
        let first_line_bytes = lines[start_index].len();
        let limit_kb = MAX_READ_OUTPUT_BYTES / 1024;
        return Ok(WorkspaceReadResult {
            workspace: workspace_summary(root),
            path: relative_display(root, &canonical),
            content: format!(
                "[Line {start_line} is {first_line_bytes} bytes, exceeds the {limit_kb} KiB read output limit. \
                 Use a narrower offset/limit or bash with a safe text slicer to inspect this line.]"
            ),
            sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
            start_line,
            end_line: start_line,
            total_lines,
            truncated: true,
            next_offset: (start_line < total_lines).then_some(start_line + 1),
            image: None,
        });
    }
    let end_line = start_index + output_lines.len();
    let truncated = end_line < total_lines;
    Ok(WorkspaceReadResult {
        workspace: workspace_summary(root),
        path: relative_display(root, &canonical),
        content: output_lines.join("\n"),
        sha256: format!("{:x}", Sha256::digest(content.as_bytes())),
        start_line,
        end_line,
        total_lines,
        truncated,
        next_offset: truncated.then_some(end_line + 1),
        image: None,
    })
}

/// Read an image file, resize it to fit provider limits, and return a base64
/// payload alongside a human-readable note in `content`.
fn read_image_impl(
    root: &Path,
    relative: &Path,
    policy: &crate::sandbox::SensitivePathPolicy,
) -> Result<WorkspaceReadResult, WorkspaceCommandError> {
    let requested = root.join(relative);
    let canonical = std::fs::canonicalize(&requested).map_err(|error| {
        WorkspaceCommandError::from_io("failed to resolve workspace image path", error)
    })?;
    if !canonical.starts_with(root) {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            "workspace file resolves outside the authorized root",
        ));
    }
    // 读入内存前先按 metadata 检查尺寸，避免超大图片先整读进内存再拒绝（OOM）。
    // 读后仍保留 bytes.len() 复查，兜住 metadata 与 read 之间的 TOCTOU 窗口。
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        WorkspaceCommandError::from_io("failed to inspect workspace image file", error)
    })?;
    if !metadata.is_file() {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            "workspace image path is not a file",
        ));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::Unavailable,
            "workspace image file is larger than 1 MiB",
        ));
    }
    ensure_path_access(policy, &canonical, false).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::NotAuthorized, message)
    })?;
    let bytes = std::fs::read(&canonical).map_err(|error| {
        WorkspaceCommandError::from_io("failed to read workspace image file", error)
    })?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::Unavailable,
            "workspace image file is larger than 1 MiB",
        ));
    }
    let mime_type = detect_image_mime(&bytes).ok_or_else(|| {
        WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::InvalidPath,
            "workspace file is not a supported image format",
        )
    })?;
    let resized = resize_image(&bytes).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::Unavailable, message)
    })?;
    let note = match (
        resized.original_width,
        resized.original_height,
        resized.resized,
    ) {
        (Some(w), Some(h), true) => {
            format!("[Image: {mime_type}, original {w}x{h}, resized to fit limits.]")
        }
        _ => format!("[Image: {mime_type}.]"),
    };
    Ok(WorkspaceReadResult {
        workspace: workspace_summary(root),
        path: relative_display(root, &canonical),
        content: note,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        start_line: 1,
        end_line: 1,
        total_lines: 1,
        truncated: false,
        next_offset: None,
        image: Some(WorkspaceImage {
            mime_type: resized.mime_type.to_string(),
            data_base64: resized.data_base64,
            original_width: resized.original_width,
            original_height: resized.original_height,
            resized: resized.resized,
        }),
    })
}

fn build_search_matcher(options: &SearchOptions) -> Result<SearchMatcher, String> {
    let pattern = options.pattern.trim();
    if pattern.is_empty() {
        return Err("workspace search pattern cannot be empty".into());
    }
    if pattern.len() > MAX_SEARCH_PATTERN_BYTES {
        return Err("workspace search pattern is too long".into());
    }
    if options.literal {
        return Ok(SearchMatcher::Literal {
            pattern: if options.ignore_case {
                pattern.to_lowercase()
            } else {
                pattern.to_string()
            },
            ignore_case: options.ignore_case,
        });
    }
    RegexBuilder::new(pattern)
        .case_insensitive(options.ignore_case)
        .build()
        .map(SearchMatcher::Regex)
        .map_err(|error| format!("invalid workspace search regex: {error}"))
}

fn build_glob_matcher(glob: Option<&str>) -> Result<Option<GlobMatcher>, String> {
    let Some(glob) = glob.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if glob.len() > 512 {
        return Err("workspace search glob is too long".into());
    }
    Glob::new(glob)
        .map(|glob| Some(glob.compile_matcher()))
        .map_err(|error| format!("invalid workspace search glob: {error}"))
}

fn should_walk_entry(entry: &DirEntry) -> bool {
    if !entry
        .file_type()
        .is_some_and(|file_type| file_type.is_dir())
    {
        return true;
    }
    !matches!(
        entry.file_name().to_string_lossy().as_ref(),
        ".git" | "node_modules" | "target" | "dist" | ".next" | ".cache"
    )
}

fn truncate_line(line: &str) -> String {
    let mut chars = line.chars();
    let prefix = chars
        .by_ref()
        .take(MAX_SEARCH_LINE_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn search_impl(
    root: &Path,
    options: SearchOptions,
    cancellation: &AtomicBool,
) -> Result<WorkspaceSearchResult, String> {
    search_impl_with_policy(root, options, cancellation, &workspace_path_policy(root)?)
}

fn search_impl_with_policy(
    root: &Path,
    options: SearchOptions,
    cancellation: &AtomicBool,
    policy: &crate::sandbox::SensitivePathPolicy,
) -> Result<WorkspaceSearchResult, String> {
    let search_root = resolve_workspace_path_with_policy(root, options.path.as_deref(), policy)?;
    let search_metadata = std::fs::metadata(&search_root)
        .map_err(|error| format!("failed to inspect workspace search path: {error}"))?;
    if !search_metadata.is_dir() && !search_metadata.is_file() {
        return Err("workspace search path is neither a file nor a directory".into());
    }
    // 单文件路径：WalkBuilder 对文件根直接产出该文件的 File 事件，无需目录遍历。
    // 显式指定某个文件时应始终搜索它（即使被 gitignore 覆盖），故此处不强制目录。
    let matcher = build_search_matcher(&options)?;
    let glob = build_glob_matcher(options.glob.as_deref())?;
    let effective_limit = options.limit.clamp(1, MAX_SEARCH_LIMIT);
    let walk_policy = policy.clone();
    let mut builder = WalkBuilder::new(&search_root);
    builder
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(MAX_TEXT_FILE_BYTES))
        .filter_entry(move |entry| {
            should_walk_entry(entry) && !walk_policy.read_denied(entry.path())
        });

    let mut matches = Vec::new();
    let mut output_bytes = 0usize;
    let mut truncated = false;
    'walk: for entry in builder.build().filter_map(Result::ok) {
        if cancellation.load(Ordering::Relaxed) {
            return Err("workspace search cancelled".into());
        }
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
            || !is_supported_text_path(entry.path())
        {
            continue;
        }
        let relative = relative_display(root, entry.path());
        if glob.as_ref().is_some_and(|glob| !glob.is_match(&relative)) {
            continue;
        }
        if policy.read_denied(entry.path()) {
            continue;
        }
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let lines: Vec<&str> = content.lines().collect();
        let total_file_lines = lines.len();
        // First pass: collect 0-indexed match line numbers.
        let mut hit_indices: Vec<usize> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if cancellation.load(Ordering::Relaxed) {
                return Err("workspace search cancelled".into());
            }
            if matcher.is_match(line) {
                hit_indices.push(index);
            }
        }
        for hit_index in hit_indices {
            let line_number = hit_index + 1;
            let matched_line = truncate_line(lines[hit_index]);
            let context_lines = if options.context > 0 {
                let start = hit_index.saturating_sub(options.context);
                let end = (hit_index + options.context + 1).min(total_file_lines);
                let mut block = Vec::with_capacity(end - start);
                for (offset, line) in lines[start..end].iter().enumerate() {
                    let current = start + offset;
                    if current == hit_index {
                        continue;
                    }
                    block.push(WorkspaceSearchContextLine {
                        line_number: current + 1,
                        line: truncate_line(line),
                        is_match: false,
                    });
                }
                Some(block)
            } else {
                None
            };
            let match_bytes = relative.len()
                + matched_line.len()
                + context_lines
                    .as_ref()
                    .map(|block| block.iter().map(|item| item.line.len() + 16).sum::<usize>())
                    .unwrap_or(0)
                + 32;
            if matches.len() >= effective_limit
                || output_bytes.saturating_add(match_bytes) > MAX_SEARCH_OUTPUT_BYTES
            {
                truncated = true;
                break 'walk;
            }
            output_bytes += match_bytes;
            matches.push(WorkspaceSearchMatch {
                path: relative.clone(),
                line_number,
                line: matched_line,
                context_lines,
            });
        }
    }
    Ok(WorkspaceSearchResult {
        workspace: workspace_summary(root),
        matches,
        truncated,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFindRequest {
    pattern: String,
    path: Option<String>,
    limit: Option<usize>,
    /// 只遍历到指定深度（1 = 工作区顶层）：提及弹层的空查询用它做
    /// 「当前目录列举」。缺省 None = 不限深度（find 工具的递归语义）。
    #[serde(default)]
    max_depth: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFindResult {
    workspace: AuthorizedWorkspace,
    pattern: String,
    root_path: String,
    matches: Vec<WorkspaceEntry>,
    truncated: bool,
}

/// Walk the workspace once and keep entries whose relative path matches the
/// glob. Mirrors `search_impl`'s `WalkBuilder` configuration so find and grep
/// share identical traversal semantics (gitignore, hidden files, skipped dirs).
fn find_impl(
    root: &Path,
    pattern: &str,
    raw_path: Option<&str>,
    limit: Option<usize>,
    max_depth: Option<usize>,
) -> Result<WorkspaceFindResult, String> {
    find_impl_with_policy(
        root,
        pattern,
        raw_path,
        limit,
        max_depth,
        &workspace_path_policy(root)?,
    )
}

fn find_impl_with_policy(
    root: &Path,
    pattern: &str,
    raw_path: Option<&str>,
    limit: Option<usize>,
    max_depth: Option<usize>,
    policy: &crate::sandbox::SensitivePathPolicy,
) -> Result<WorkspaceFindResult, String> {
    let trimmed_pattern = pattern.trim();
    if trimmed_pattern.is_empty() {
        return Err("workspace find pattern cannot be empty".into());
    }
    if trimmed_pattern.len() > 512 {
        return Err("workspace find pattern is too long".into());
    }
    // 目标目录不存在 = 0 个匹配（新项目首次扫描 tests/ 的常态），不是错误：宿主直接
    // 返回结构化空结果，调用方不必从错误文案推断 not_found（TS 侧因此不需要任何
    // 字符串匹配）。越界（`..` / 绝对路径）与保护路径仍由下方的
    // resolve_workspace_path_with_policy 拒绝——这里只对「工作区内、合法相对路径、
    // 且目标确实不存在或非目录」短路，且不读取目标内容。
    if let Some(raw) = raw_path {
        let relative = validate_relative_path(Some(raw))?;
        let target = root.join(&relative);
        let absent = std::fs::symlink_metadata(&target)
            .map(|metadata| !metadata.is_dir())
            .unwrap_or(true);
        if absent && !policy.read_denied(&target) {
            return Ok(WorkspaceFindResult {
                workspace: workspace_summary(root),
                pattern: trimmed_pattern.to_string(),
                root_path: relative_display(root, &target),
                matches: Vec::new(),
                truncated: false,
            });
        }
    }
    let search_root = resolve_workspace_path_with_policy(root, raw_path, policy)?;
    if !std::fs::metadata(&search_root)
        .map_err(|error| format!("failed to inspect workspace find path: {error}"))?
        .is_dir()
    {
        return Err("workspace find path is not a directory".into());
    }
    let glob_matcher = Glob::new(trimmed_pattern)
        .map(|glob| glob.compile_matcher())
        .map_err(|error| format!("invalid workspace find glob: {error}"))?;
    let effective_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).clamp(1, MAX_FIND_LIMIT);
    let root_path = relative_display(root, &search_root);

    let walk_policy = policy.clone();
    let mut builder = WalkBuilder::new(&search_root);
    builder
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            should_walk_entry(entry) && !walk_policy.read_denied(entry.path())
        });
    // 深度受限时（顶层列举）不进入子目录：glob 的 `*` 跨分隔符，
    // 仅靠 pattern 无法把结果限制在顶层。
    if let Some(depth) = max_depth {
        builder.max_depth(Some(depth));
    }

    let mut matches = Vec::new();
    let mut truncated = false;
    for entry in builder.build().filter_map(Result::ok) {
        // The walker yields the root directory itself as the first entry; skip it.
        if entry.path() == search_root {
            continue;
        }
        if policy.read_denied(entry.path()) {
            continue;
        }
        let relative = relative_display(root, entry.path());
        if !glob_matcher.is_match(&relative) {
            continue;
        }
        if matches.len() >= effective_limit {
            truncated = true;
            break;
        }
        let file_type = entry.file_type();
        let metadata = entry.metadata().ok();
        let (kind, size_bytes) = match file_type {
            Some(ft) if ft.is_dir() => ("directory".to_string(), 0),
            Some(ft) if ft.is_symlink() => ("symlink".to_string(), 0),
            Some(ft) if ft.is_file() => {
                let size = metadata
                    .as_ref()
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                ("file".to_string(), size)
            }
            _ => ("other".to_string(), 0),
        };
        let name = entry.file_name().to_string_lossy().to_string();
        matches.push(WorkspaceEntry {
            path: relative,
            name,
            kind,
            size_bytes,
            modified_ms: metadata.as_ref().and_then(modified_epoch_ms),
        });
    }
    Ok(WorkspaceFindResult {
        workspace: workspace_summary(root),
        pattern: trimmed_pattern.to_string(),
        root_path,
        matches,
        truncated,
    })
}

#[tauri::command]
pub(crate) fn authorize_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceAccessState>,
    command_state: tauri::State<'_, WorkspaceCommandState>,
    terminal_state: tauri::State<'_, TerminalState>,
    path: String,
) -> Result<AuthorizedWorkspace, String> {
    let _ = (&command_state, &terminal_state);
    let _registry = state
        .registry_mutations
        .lock()
        .map_err(|_| "workspace registry mutation lock is poisoned".to_string())?;
    ensure_workspace_recovery_ready(&state)?;
    let registry_file = workspace_registry::registry_file_path(&app)?;
    authorize_restore_impl(&state, &registry_file, &path)
}

async fn confirm_sensitive_workspace(
    app: &tauri::AppHandle,
    root: &Path,
    scope: &Path,
) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut dialog = app.dialog().message(format!(
        "所选项目位于隐私保护目录：{}\n\n只开放项目子目录：{}\n父目录及其他子目录仍受保护，凭据和 Axiom 数据不会开放。授权范围会记录在本机安全审计中。",
        scope.display(), root.display())).title("确认敏感位置的工作区")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("仅授权此子目录".into(), "取消".into()));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.show(move |confirmed| {
        let _ = sender.send(confirmed);
    });
    if !receiver
        .await
        .map_err(|_| "敏感工作区确认对话框意外关闭".to_string())?
    {
        return Err("用户取消了敏感工作区授权，目录未登记。".into());
    }
    Ok(())
}

/// 由 Rust 侧打开原生目录选择器并授权，路径直接来自系统对话框，
/// 不再让 WebView 把任意绝对路径作为"已授权工作区"传入。
/// 取消时返回 Ok(None)。`authorize_workspace` 仅供启动恢复既有授权路径，
/// 且只接受此处登记进注册表的目录（见 workspace_registry.rs）。
/// 注意：必须用非阻塞 `pick_folder` + oneshot 等待；`blocking_pick_folder`
/// 在 macOS 上会阻塞 Tauri async runtime / 主线程上下文，导致应用无响应。
#[tauri::command]
pub(crate) async fn pick_and_authorize_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceAccessState>,
    command_state: tauri::State<'_, WorkspaceCommandState>,
    terminal_state: tauri::State<'_, TerminalState>,
) -> Result<Option<AuthorizedWorkspace>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = sender.send(folder);
    });
    let picked = receiver
        .await
        .map_err(|_| "workspace picker closed unexpectedly".to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("failed to resolve selected workspace path: {error}"))?;
    let canonical = resolve_workspace_directory(&path.to_string_lossy())?;
    let home = crate::sandbox::policy_home()?;
    let sensitive_scope = crate::sandbox::workspace_sensitive_scope(&home, &canonical)?;
    if let Some(scope) = &sensitive_scope {
        confirm_sensitive_workspace(&app, &canonical, scope).await?;
    }
    let _ = (&command_state, &terminal_state);
    let _registry = state
        .registry_mutations
        .lock()
        .map_err(|_| "workspace registry mutation lock is poisoned".to_string())?;
    ensure_workspace_recovery_ready(&state)?;
    if resolve_workspace_directory(&path.to_string_lossy())? != canonical
        || crate::sandbox::workspace_sensitive_scope(&home, &canonical)? != sensitive_scope
    {
        return Err("确认期间工作区路径或保护范围已变化，请重新选择目录。".into());
    }
    workspace_registry::registry_insert_with_scope(
        &workspace_registry::registry_file_path(&app)?,
        &canonical,
        sensitive_scope.as_deref(),
    )?;
    Ok(Some(authorize_root_in_memory(&state, &canonical)?))
}

/// E2E 构建专属：无人值守地登记并授权一个确实存在的目录。runtime fault 自动化
/// 需要为会话绑定工作区（send 的授权门禁），而 authorize_workspace 恢复专用、
/// pick 流程依赖原生手势，两者都无法自动化。生产构建编译期不存在此命令。
#[cfg(feature = "e2e")]
#[tauri::command]
pub(crate) fn e2e_register_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceAccessState>,
    command_state: tauri::State<'_, WorkspaceCommandState>,
    terminal_state: tauri::State<'_, TerminalState>,
    path: String,
) -> Result<AuthorizedWorkspace, String> {
    if std::env::var("AXIOM_E2E_RUNTIME_AUTOMATION").is_err() {
        return Err(
            "E2E workspace registration requires the runtime automation environment".into(),
        );
    }
    let _ = (&command_state, &terminal_state);
    let _registry = state
        .registry_mutations
        .lock()
        .map_err(|_| "workspace registry mutation lock is poisoned".to_string())?;
    ensure_workspace_recovery_ready(&state)?;
    let canonical = resolve_workspace_directory(&path)?;
    if crate::sandbox::workspace_sensitive_scope(&crate::sandbox::policy_home()?, &canonical)?
        .is_some()
    {
        return Err("E2E registration cannot grant sensitive workspace exceptions".into());
    }
    workspace_registry::registry_insert(
        &workspace_registry::registry_file_path(&app)?,
        &canonical,
    )?;
    authorize_root_in_memory(&state, &canonical)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_authorized_workspace(
    state: tauri::State<'_, WorkspaceAccessState>,
) -> Result<Option<AuthorizedWorkspace>, String> {
    Ok(state
        .root
        .lock()
        .map_err(|_| "workspace authorization state lock is poisoned".to_string())?
        .as_deref()
        .map(workspace_summary))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_authorized_workspaces(
    state: tauri::State<'_, WorkspaceAccessState>,
) -> Result<Vec<AuthorizedWorkspace>, String> {
    let mut workspaces = state
        .roots
        .lock()
        .map_err(|_| "workspace authorization set lock is poisoned".to_string())?
        .iter()
        .map(|root| workspace_summary(root))
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(workspaces)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn activate_authorized_workspace(
    state: tauri::State<'_, WorkspaceAccessState>,
    path: String,
) -> Result<AuthorizedWorkspace, String> {
    let root = authorized_root_for(&state, Some(&path))?;
    *state
        .root
        .lock()
        .map_err(|_| "workspace authorization state lock is poisoned".to_string())? =
        Some(root.clone());
    Ok(workspace_summary(&root))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn revoke_workspace(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<bool, String> {
    // 撤销要等出目标工作区的在途写（per-workspace 写锁）并做注册表文件 I/O，
    // 可能长于主线程可接受窗口；整体进 blocking 线程池（同写命令 rationale）。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let command_state = app.state::<WorkspaceCommandState>();
        let terminal_state = app.state::<TerminalState>();
        let watch_state = app.state::<DesignWatchState>();
        // TS 传入的即 pick 时返回的 canonical 字符串；canonicalize 仅在渲染
        // 进程传入非 canonical 形态时兜底（目录已被删除时退回原串，与 revoke_impl
        // 的 roots 匹配语义一致）。
        let registry_target = if let Some(path) = path.as_deref() {
            Some(std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)))
        } else {
            state
                .root
                .lock()
                .map_err(|_| "workspace authorization state lock is poisoned".to_string())?
                .clone()
        };
        // 无目标（既无显式路径也无激活工作区）时是一次 no-op 撤销：不再像过去
        // 那样先取消全部命令/终端。
        let Some(target) = registry_target.as_ref() else {
            return Ok(false);
        };
        // 撤销的作用域只限目标工作区：只取消/杀死挂载在该工作区下的命令、终端与
        // 搜索，其他工作区并行运行的会话不受影响（多工作区并行的互不干扰边界）。
        terminal_state.kill_for_workspace(target)?;
        revoke_workspace_core(
            &state,
            &command_state,
            &watch_state,
            &workspace_registry::registry_file_path(&app)?,
            target,
        )
    })
    .await
    .map_err(|error| format!("workspace revoke task failed: {error}"))?
}

/// 撤销核心：注册表移除 → 写锁临界区内（命令取消 + 内存撤销）。抽出为独立函数
/// 以支撑「命令取消发生在写锁临界区内」的并发回归测试。
///
/// 命令取消必须在写锁内：命令侧（`run_workspace_command`）的 consume→register
/// 同处该锁。锁外先行取消会漏掉「已 consume、尚未 register」窗口内登记的命令——
/// 此刻 generation bump 还没发生，租约代际校验也拦不住它，命令会在已撤销的
/// 工作区里跑完。两侧都持锁后，两种交错被全序化：撤销先到则命令 consume 的
/// 代际复查拒绝；命令先到则此处的 cancel_for_workspace 必能看到已登记的命令。
fn revoke_workspace_core(
    state: &WorkspaceAccessState,
    command_state: &WorkspaceCommandState,
    watch_state: &DesignWatchState,
    registry_path: &Path,
    target: &Path,
) -> Result<bool, String> {
    let _registry = state
        .registry_mutations
        .lock()
        .map_err(|_| "workspace registry mutation lock is poisoned".to_string())?;
    // 注册表移除必须先于且成功于内存 revoke：注册表仍含该路径时，重启恢复
    // （authorize_workspace）会重新授权它——localStorage/SQLite 任一残留都足以
    // 触发恢复，撤销必须落到 Rust 侧持久层才具效力。移除失败即整体失败
    // （fail-closed），内存授权集保持不变，用户可重试。
    workspace_registry::registry_remove(registry_path, target)?;
    // 等出该工作区在途写再内存撤销：与写路径共用 per-workspace 写锁，保证
    // revoke 返回后不再有面向该工作区的文件写在进行中（其后的新写会因
    // generation bump 在审批租赁 consume 处被拒）。锁序 registry → 写锁与
    // 写路径（gate.read → 写锁，不取 registry）无环。
    let write_lock = state.workspace_write_lock(target);
    let _write_lock = write_lock
        .lock()
        .map_err(|_| "workspace write lock is poisoned".to_string())?;
    command_state.cancel_for_workspace(target)?;
    // 设计稿监听池同在临界区内清理：与命令/终端/搜索同属「撤销作用域只限目标
    // 工作区」的联动收口，撤销返回后该工作区不再产生任何事件。
    watch_state.revoke_for_workspace(target)?;
    revoke_impl(state, target)
}

fn command_authorized_root(
    state: &WorkspaceAccessState,
    workspace_path: Option<&str>,
) -> Result<PathBuf, WorkspaceCommandError> {
    ensure_workspace_recovery_ready(state).map_err(|message| {
        WorkspaceCommandError::new(WorkspaceCommandErrorCode::Unavailable, message)
    })?;
    if let Some(workspace_path) = workspace_path {
        if workspace_path.is_empty() || workspace_path.len() > 16 * 1024 {
            return Err(WorkspaceCommandError::new(
                WorkspaceCommandErrorCode::InvalidPath,
                "workspace path is invalid",
            ));
        }
        let requested = PathBuf::from(workspace_path);
        return state
            .roots
            .lock()
            .map_err(|_| {
                WorkspaceCommandError::new(
                    WorkspaceCommandErrorCode::Unknown,
                    "workspace authorization set lock is poisoned",
                )
            })?
            .get(&requested)
            .cloned()
            .ok_or_else(|| {
                WorkspaceCommandError::new(
                    WorkspaceCommandErrorCode::NotAuthorized,
                    "workspace is not authorized for this Axiom process",
                )
            });
    }
    state
        .root
        .lock()
        .map_err(|_| {
            WorkspaceCommandError::new(
                WorkspaceCommandErrorCode::Unknown,
                "workspace authorization state lock is poisoned",
            )
        })?
        .clone()
        .ok_or_else(|| {
            WorkspaceCommandError::new(
                WorkspaceCommandErrorCode::NotAuthorized,
                "no workspace has been authorized for this Axiom process",
            )
        })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_workspace(
    state: tauri::State<'_, WorkspaceAccessState>,
    path: Option<String>,
    limit: Option<u32>,
    workspace_path: Option<String>,
) -> Result<WorkspaceListResult, WorkspaceCommandError> {
    let root = command_authorized_root(&state, workspace_path.as_deref())?;
    list_impl(&root, path.as_deref(), limit.map(|value| value as usize))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn read_workspace_text(
    state: tauri::State<'_, WorkspaceAccessState>,
    path: String,
    offset: Option<u32>,
    limit: Option<u32>,
    workspace_path: Option<String>,
) -> Result<WorkspaceReadResult, WorkspaceCommandError> {
    let root = command_authorized_root(&state, workspace_path.as_deref())?;
    read_impl(
        &root,
        &path,
        offset.map(|value| value as usize),
        limit.map(|value| value as usize),
    )
}

#[tauri::command]
pub(crate) async fn create_workspace_text_file(
    app: tauri::AppHandle,
    approval_lease: String,
    approval_scope: crate::workspace_approval::ApprovalScope,
    path: String,
    content: String,
    workspace_path: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    // 写路径含阻塞文件 I/O，且 per-workspace 写锁可能等出同工作区的在途写：
    // 整体移入 blocking 线程池——同步 command 会在主线程执行这段（UI 卡顿、
    // 阻塞其他 IPC），async command 直接内联又会占住 tokio worker。
    // State 经 AppHandle 在 blocking 闭包内解析（非 'static，不能捕获捕获期借用）。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let approval_state = app.state::<WorkspaceApprovalState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let write_lock = state.workspace_write_lock(&root);
        let _write_lock = write_lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        let tier = approval_state.consume_scoped(
            &approval_lease,
            "create_workspace_file",
            serde_json::json!({ "path": path, "content": content }),
            state.generation_for(&root),
            workspace_path.as_deref(),
            (
                &approval_scope,
                &app.state::<crate::session_authorization::SessionAuthorizationState>(),
            ),
        )?;
        create_text_file_impl(mutation_scope_for(&root, tier), &path, &content)
    })
    .await
    .map_err(|error| format!("workspace write task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn edit_workspace_text_file(
    app: tauri::AppHandle,
    approval_lease: String,
    approval_scope: crate::workspace_approval::ApprovalScope,
    request: WorkspaceEditRequest,
    workspace_path: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    // 同 create_workspace_text_file：阻塞 I/O + 写锁等待整体进 blocking 线程池。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        let approval_state = app.state::<WorkspaceApprovalState>();
        let root = authorized_root_for(&state, workspace_path.as_deref())?;
        let _recovery = state
            .recovery_gate
            .read()
            .map_err(|_| "workspace recovery gate lock is poisoned".to_string())?;
        let write_lock = state.workspace_write_lock(&root);
        let _write_lock = write_lock
            .lock()
            .map_err(|_| "workspace write lock is poisoned".to_string())?;
        let tier = approval_state.consume_scoped(
            &approval_lease,
            "edit_workspace_file",
            serde_json::json!({ "path": request.path, "edits": request.edits }),
            state.generation_for(&root),
            workspace_path.as_deref(),
            (
                &approval_scope,
                &app.state::<crate::session_authorization::SessionAuthorizationState>(),
            ),
        )?;
        authorized_root_for(&state, Some(&root.to_string_lossy()))?;
        let data_root = crate::storage_paths::axiom_data_root(&app)?;
        edit_text_file_with_history_impl(
            mutation_scope_for(&root, tier),
            &request.path,
            &request.edits,
            Some(&data_root),
        )
    })
    .await
    .map_err(|error| format!("workspace write task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn search_workspace_text(
    state: tauri::State<'_, WorkspaceAccessState>,
    request: WorkspaceSearchRequest,
    workspace_path: Option<String>,
) -> Result<WorkspaceSearchResult, String> {
    let request_id =
        crate::request_id::validate_request_id("workspace search", &request.request_id)?
            .to_string();
    let root = authorized_root_for(&state, workspace_path.as_deref())?;
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut searches = state
            .searches
            .lock()
            .map_err(|_| "workspace search state lock is poisoned".to_string())?;
        if let Some(previous) = searches.insert(
            request_id.clone(),
            WorkspaceSearchRegistration {
                cancellation: cancellation.clone(),
                workspace_root: root.clone(),
            },
        ) {
            previous.cancellation.store(true, Ordering::Relaxed);
        }
    }
    let options = SearchOptions {
        pattern: request.pattern,
        path: request.path,
        glob: request.glob,
        ignore_case: request.ignore_case.unwrap_or(false),
        literal: request.literal.unwrap_or(false),
        limit: request.limit.unwrap_or(DEFAULT_SEARCH_LIMIT),
        context: request.context.unwrap_or(0).min(MAX_SEARCH_CONTEXT_LINES),
    };
    let cancellation_for_search = cancellation.clone();
    let result = match tauri::async_runtime::spawn_blocking(move || {
        search_impl(&root, options, &cancellation_for_search)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("workspace search task failed: {error}")),
    };
    if let Ok(mut searches) = state.searches.lock() {
        if searches
            .get(&request_id)
            .is_some_and(|registration| Arc::ptr_eq(&registration.cancellation, &cancellation))
        {
            searches.remove(&request_id);
        }
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_workspace_search(
    state: tauri::State<'_, WorkspaceAccessState>,
    request_id: String,
) -> Result<bool, String> {
    let request_id = crate::request_id::validate_request_id("workspace search", &request_id)?;
    let registration = state
        .searches
        .lock()
        .map_err(|_| "workspace search state lock is poisoned".to_string())?
        .remove(request_id);
    if let Some(registration) = registration {
        registration.cancellation.store(true, Ordering::Relaxed);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) async fn find_workspace_files(
    app: tauri::AppHandle,
    request: WorkspaceFindRequest,
    workspace_path: Option<String>,
) -> Result<WorkspaceFindResult, WorkspaceCommandError> {
    // 检索要遍历工作区（query 无匹配时走完整棵树）：同步 command 在主线程执行
    // 会卡 UI——Composer 提及弹层的防抖查询也走这条命令；整体移入 blocking
    // 线程池，State 经 AppHandle 在闭包内解析（非 'static，不能捕获捕获期借用）。
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceAccessState>();
        // 结构化错误信封（`{code,message}`）：调用方按 code 判定，不再从文案推断
        // not_found。目录不存在已由 `find_impl_with_policy` 短路为空结果，故这里的
        // Err 一律是真实故障（未授权 / 无效路径 / 遍历失败）。
        let root = authorized_root_for(&state, workspace_path.as_deref()).map_err(|message| {
            WorkspaceCommandError::new(WorkspaceCommandErrorCode::NotAuthorized, message)
        })?;
        find_impl(
            &root,
            &request.pattern,
            request.path.as_deref(),
            request.limit,
            request.max_depth,
        )
        .map_err(|message| WorkspaceCommandError::new(WorkspaceCommandErrorCode::Unknown, message))
    })
    .await
    .map_err(|error| {
        WorkspaceCommandError::new(
            WorkspaceCommandErrorCode::Unavailable,
            format!("workspace find task failed: {error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMPORARY_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temporary_directory() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEMPORARY_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "axiom-workspace-access-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::canonicalize(path).unwrap()
    }

    #[test]
    fn lists_and_reads_only_workspace_relative_text() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "one\ntwo\nthree\nfour").unwrap();
        let state = WorkspaceAccessState::default();
        authorize_impl(&state, root.to_str().unwrap()).unwrap();

        let listed = list_impl(&root, None, None).unwrap();
        assert_eq!(listed.entries[0].name, "src");
        assert_eq!(listed.entries[0].kind, "directory");

        let read = read_impl(&root, "src/lib.rs", Some(2), Some(2)).unwrap();
        assert_eq!(read.content, "two\nthree");
        assert_eq!(read.next_offset, Some(4));
        assert!(read.truncated);
        assert!(read_impl(&root, "../outside.txt", None, None).is_err());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exposes_stable_structured_codes_for_workspace_read_and_list_errors() {
        let root = temporary_directory();

        let missing_file = read_impl(&root, "missing.md", None, None).unwrap_err();
        assert_eq!(missing_file.code, WorkspaceCommandErrorCode::NotFound);
        assert_eq!(
            serde_json::to_value(&missing_file).unwrap()["code"],
            "not_found"
        );

        let missing_directory = list_impl(&root, Some("missing"), None).unwrap_err();
        assert_eq!(missing_directory.code, WorkspaceCommandErrorCode::NotFound);
        assert_eq!(
            serde_json::to_value(&missing_directory).unwrap()["code"],
            "not_found"
        );

        let invalid_path = read_impl(&root, "../outside.md", None, None).unwrap_err();
        assert_eq!(invalid_path.code, WorkspaceCommandErrorCode::InvalidPath);

        let state = WorkspaceAccessState::default();
        let unauthorized =
            command_authorized_root(&state, Some(root.to_str().unwrap())).unwrap_err();
        assert_eq!(unauthorized.code, WorkspaceCommandErrorCode::NotAuthorized);
        set_workspace_recovery_blocked(&state, true);
        let unavailable = command_authorized_root(&state, None).unwrap_err();
        assert_eq!(unavailable.code, WorkspaceCommandErrorCode::Unavailable);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_image_files_as_resized_base64_payloads() {
        let root = temporary_directory();
        // Write a small PNG.
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(20, 20));
        let mut buf: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        std::fs::write(root.join("pic.png"), &buf).unwrap();

        let result = read_impl(&root, "pic.png", None, None).unwrap();
        let image_payload = result.image.expect("image payload present");
        assert_eq!(image_payload.mime_type, "image/png");
        assert!(!image_payload.data_base64.is_empty());
        assert!(!image_payload.resized, "small image not resized");
        assert!(result.content.starts_with("[Image: image/png"));
        // sha256 is computed over the raw bytes.
        assert!(!result.sha256.is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_oversized_workspace_images_before_reading_them() {
        let root = temporary_directory();
        // Sparse file: declared length exceeds the 1 MiB cap without allocating real bytes.
        // 回归：此前 read_image_impl 先 std::fs::read 整读才验大小，超大文件会先 OOM。
        let image = root.join("huge.png");
        let file = std::fs::File::create(&image).unwrap();
        file.set_len(MAX_TEXT_FILE_BYTES + 1).unwrap();
        drop(file);

        let result = read_impl(&root, "huge.png", None, None);
        let error = result.expect_err("oversized image must be rejected");
        assert!(
            error.message.contains("larger than 1 MiB"),
            "unexpected error: {:?}",
            error
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_explicit_reads_bound_to_the_requested_authorized_workspace() {
        let first = temporary_directory();
        let second = temporary_directory();
        std::fs::write(first.join("identity.txt"), "first").unwrap();
        std::fs::write(second.join("identity.txt"), "second").unwrap();
        let state = WorkspaceAccessState::default();
        authorize_impl(&state, first.to_str().unwrap()).unwrap();
        authorize_impl(&state, second.to_str().unwrap()).unwrap();

        let first_root = authorized_root_for(&state, first.to_str()).unwrap();
        let second_root = authorized_root_for(&state, second.to_str()).unwrap();
        assert_eq!(
            read_impl(&first_root, "identity.txt", None, None)
                .unwrap()
                .content,
            "first"
        );
        assert_eq!(
            read_impl(&second_root, "identity.txt", None, None)
                .unwrap()
                .content,
            "second"
        );
        assert!(authorized_root_for(&state, Some("/not-authorized")).is_err());

        std::fs::remove_dir_all(first).unwrap();
        std::fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn generation_is_tracked_per_authorized_workspace() {
        let first = temporary_directory();
        let second = temporary_directory();
        let state = WorkspaceAccessState::default();

        assert_eq!(state.generation_for(&first), 0);
        assert_eq!(state.generation_for(&second), 0);

        authorize_impl(&state, first.to_str().unwrap()).unwrap();
        assert_eq!(state.generation_for(&first), 1);
        assert_eq!(state.generation_for(&second), 0);

        // 授权 second 不影响 first 的 generation（消除全局 generation 的过度失效）
        authorize_impl(&state, second.to_str().unwrap()).unwrap();
        assert_eq!(state.generation_for(&first), 1);
        assert_eq!(state.generation_for(&second), 1);

        // 重复授权（已存在）不改变 generation
        authorize_impl(&state, first.to_str().unwrap()).unwrap();
        assert_eq!(state.generation_for(&first), 1);

        // 撤销 first → first 的 generation +1（单调递增，旧 lease 失效），second 不变
        revoke_impl(&state, &first).unwrap();
        assert_eq!(state.generation_for(&first), 2);
        assert_eq!(state.generation_for(&second), 1);

        // 撤销后重新授权 → generation 继续累加（不重置，旧 lease 一定失效）
        authorize_impl(&state, first.to_str().unwrap()).unwrap();
        assert_eq!(state.generation_for(&first), 3);

        std::fs::remove_dir_all(first).unwrap();
        std::fs::remove_dir_all(second).unwrap();
    }

    /// 并发回归：撤销的命令取消必须发生在 per-workspace 写锁临界区内。
    /// 持锁线程模拟「命令侧 consume+register 临界段在途」——撤销在此期间不得
    /// 完成取消或代际提升；锁释放后撤销收口（命令被取消 + generation bump）。
    /// 若取消被移回锁外（回归），撤销会在持锁期间完成取消，断言失败。
    #[test]
    fn revoke_cancels_commands_inside_the_write_lock_section() {
        let state = WorkspaceAccessState::default();
        let root = temporary_directory();
        authorize_impl(&state, root.to_str().unwrap()).unwrap();

        let command_state = WorkspaceCommandState::default();
        let cancellation = command_state.register("req-revoke-race", &root).unwrap();
        let watch_state = DesignWatchState::new();

        // 撤销核心要求注册表条目先被移除：种子一个真实注册表文件
        let registry_dir = temporary_directory();
        let registry_file = registry_dir.join("authorized_workspaces.json");
        workspace_registry::registry_insert(&registry_file, &root).unwrap();

        // 持有该工作区写锁 = 命令侧临界段在途，撤销必须阻塞在写锁上
        let lock = state.workspace_write_lock(&root);
        let held = lock.lock().unwrap();

        std::thread::scope(|scope| {
            let handle = scope.spawn(|| {
                revoke_workspace_core(&state, &command_state, &watch_state, &registry_file, &root)
                    .unwrap()
            });
            // 给撤销线程时间走到（并阻塞在）写锁；若取消在锁外先行发生，
            // 此处 cancellation 已翻转为 true → 断言失败（回归信号）
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(
                !*cancellation.borrow(),
                "写锁被命令临界段持有时，撤销不得先行完成命令取消"
            );
            assert_eq!(
                state.generation_for(&root),
                1,
                "写锁被持有时，撤销不得先行提升代际"
            );
            drop(held);
            assert!(handle.join().unwrap(), "撤销应成功");
        });

        assert!(*cancellation.borrow(), "锁释放后撤销应取消已登记命令");
        assert_eq!(state.generation_for(&root), 2, "撤销后代际应 +1");
        assert!(
            !workspace_registry::registry_contains(&registry_file, &root).unwrap(),
            "注册表条目应已被移除"
        );
    }

    #[test]
    fn write_locks_are_per_workspace_and_the_recovery_gate_excludes_writes() {
        let state = WorkspaceAccessState::default();
        let first = PathBuf::from("/tmp/axiom-lock-workspace-a");
        let second = PathBuf::from("/tmp/axiom-lock-workspace-b");

        // 同工作区串行：first 的写锁被持有时，另一线程对 first 的 try_lock 失败。
        let first_guard = state.workspace_write_lock(&first);
        let held = first_guard.lock().unwrap();
        let first_again = state.workspace_write_lock(&first);
        let first_blocked = std::thread::scope(|scope| {
            let handle = scope.spawn(move || first_again.try_lock().is_err());
            handle.join().unwrap()
        });
        assert!(first_blocked);

        // 跨工作区并行：first 持锁不影响 second 立即拿锁。
        let second_guard = state.workspace_write_lock(&second);
        let second_free = std::thread::scope(|scope| {
            let handle = scope.spawn(move || second_guard.try_lock().is_ok());
            handle.join().unwrap()
        });
        assert!(second_free);

        // 恢复门：写（读锁）彼此共享共存；恢复（写锁）在任何写在途时无法开始。
        let gate_read = state.recovery_gate.read().unwrap();
        let gate = &state.recovery_gate;
        let read_shared =
            std::thread::scope(|scope| scope.spawn(|| gate.try_read().is_ok()).join().unwrap());
        assert!(read_shared);
        let write_blocked =
            std::thread::scope(|scope| scope.spawn(|| gate.try_write().is_err()).join().unwrap());
        assert!(write_blocked);
        drop(gate_read);
        drop(held);
    }

    #[test]
    fn revoke_cancels_only_the_target_workspaces_searches() {
        let first = temporary_directory();
        let second = temporary_directory();
        let state = WorkspaceAccessState::default();
        authorize_impl(&state, first.to_str().unwrap()).unwrap();
        authorize_impl(&state, second.to_str().unwrap()).unwrap();

        let first_search = Arc::new(AtomicBool::new(false));
        let second_search = Arc::new(AtomicBool::new(false));
        state.searches.lock().unwrap().insert(
            "search-a".into(),
            WorkspaceSearchRegistration {
                cancellation: first_search.clone(),
                workspace_root: first.clone(),
            },
        );
        state.searches.lock().unwrap().insert(
            "search-b".into(),
            WorkspaceSearchRegistration {
                cancellation: second_search.clone(),
                workspace_root: second.clone(),
            },
        );

        // 撤销 first：只取消/移除 first 的搜索，second 的在途搜索不受影响。
        assert!(revoke_impl(&state, &first).unwrap());
        assert!(first_search.load(Ordering::Relaxed));
        assert!(!second_search.load(Ordering::Relaxed));
        {
            let searches = state.searches.lock().unwrap();
            assert!(!searches.contains_key("search-a"));
            assert!(searches.contains_key("search-b"));
        }

        std::fs::remove_dir_all(first).unwrap();
        std::fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn reports_the_current_git_branch_without_executing_git() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/feat-new-ui\n").unwrap();

        assert_eq!(
            workspace_summary(&root).git_branch.as_deref(),
            Some("feat-new-ui")
        );

        std::fs::write(
            root.join(".git/HEAD"),
            "eb9c672f92d44133bd65a453d35adca698c7ba12\n",
        )
        .unwrap();
        assert_eq!(
            workspace_summary(&root).git_branch.as_deref(),
            Some("detached@eb9c672f")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_worktree_git_directory_markers() {
        let root = temporary_directory();
        let metadata = temporary_directory();
        std::fs::write(metadata.join("HEAD"), "ref: refs/heads/worktree-branch\n").unwrap();
        std::fs::write(
            root.join(".git"),
            format!("gitdir: {}\n", metadata.to_string_lossy()),
        )
        .unwrap();

        assert_eq!(
            workspace_summary(&root).git_branch.as_deref(),
            Some("worktree-branch"),
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(metadata).unwrap();
    }

    #[test]
    fn blocks_authorized_workspace_access_until_startup_recovery_succeeds() {
        let root = temporary_directory();
        let state = WorkspaceAccessState::default();
        authorize_impl(&state, root.to_str().unwrap()).unwrap();

        set_workspace_recovery_blocked(&state, true);
        assert!(authorized_root(&state)
            .unwrap_err()
            .contains("startup recovery succeeds"));

        set_workspace_recovery_blocked(&state, false);
        assert_eq!(authorized_root(&state).unwrap(), root);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searches_text_with_gitignore_glob_and_limits() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.ts\n").unwrap();
        std::fs::write(
            root.join("src/main.ts"),
            "const Axiom = true\nconst other = 1\n",
        )
        .unwrap();
        std::fs::write(root.join("ignored.ts"), "Axiom should not appear\n").unwrap();
        let result = search_impl(
            &root,
            SearchOptions {
                pattern: "axiom".into(),
                path: None,
                glob: Some("**/*.ts".into()),
                ignore_case: true,
                literal: true,
                limit: 10,
                context: 0,
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "src/main.ts");
        assert_eq!(result.matches[0].line_number, 1);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searches_a_single_file_when_path_is_a_regular_file() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/main.ts"),
            "const Axiom = true\nconst other = 1\n",
        )
        .unwrap();
        std::fs::write(root.join("src/other.ts"), "const Axiom = false\n").unwrap();
        // 显式指定单个文件：只搜索该文件，不遍历整个目录
        let result = search_impl(
            &root,
            SearchOptions {
                pattern: "axiom".into(),
                path: Some("src/main.ts".into()),
                glob: None,
                ignore_case: true,
                literal: true,
                limit: 10,
                context: 0,
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "src/main.ts");
        assert_eq!(result.matches[0].line_number, 1);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn supports_regex_and_cancellation() {
        let root = temporary_directory();
        std::fs::write(root.join("notes.txt"), "AX-123\nAX-nope\n").unwrap();
        let options = || SearchOptions {
            pattern: r"AX-\d+".into(),
            path: None,
            glob: None,
            ignore_case: false,
            literal: false,
            limit: 10,
            context: 0,
        };
        let result = search_impl(&root, options(), &AtomicBool::new(false)).unwrap();
        assert_eq!(result.matches.len(), 1);

        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            search_impl(&root, options(), &cancelled),
            Err(message) if message == "workspace search cancelled"
        ));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searches_collect_context_lines_around_matches() {
        let root = temporary_directory();
        std::fs::write(root.join("ctx.txt"), "line1\nline2\nHIT\nline4\nline5\n").unwrap();
        let result = search_impl(
            &root,
            SearchOptions {
                pattern: "HIT".into(),
                path: None,
                glob: None,
                ignore_case: false,
                literal: true,
                limit: 10,
                context: 1,
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.matches.len(), 1);
        let m = &result.matches[0];
        assert_eq!(m.line_number, 3);
        assert_eq!(m.line, "HIT");
        let ctx = m.context_lines.as_ref().expect("context lines present");
        // One line before (line 2) and one after (line 4), match line excluded.
        assert_eq!(ctx.len(), 2);
        assert_eq!(ctx[0].line_number, 2);
        assert_eq!(ctx[0].line, "line2");
        assert!(!ctx[0].is_match);
        assert_eq!(ctx[1].line_number, 4);
        assert_eq!(ctx[1].line, "line4");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_without_context_omits_context_lines() {
        let root = temporary_directory();
        std::fs::write(root.join("noc.txt"), "a\nb\nc\n").unwrap();
        let result = search_impl(
            &root,
            SearchOptions {
                pattern: "b".into(),
                path: None,
                glob: None,
                ignore_case: false,
                literal: true,
                limit: 10,
                context: 0,
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.matches.len(), 1);
        assert!(result.matches[0].context_lines.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_files_by_glob_and_respects_gitignore() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.ts"), "a").unwrap();
        std::fs::write(root.join("src/util.ts"), "b").unwrap();
        std::fs::write(root.join("README.md"), "c").unwrap();
        // ignored.ts is gitignored and must not appear.
        std::fs::write(root.join(".gitignore"), "ignored.ts\n").unwrap();
        std::fs::write(root.join("ignored.ts"), "d").unwrap();

        let result = find_impl(&root, "**/*.ts", None, None, None).unwrap();
        let paths: Vec<&str> = result.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"src/main.ts"));
        assert!(paths.contains(&"src/util.ts"));
        assert!(!paths.contains(&"ignored.ts"));
        assert!(!paths.contains(&"README.md"));

        // Directories are distinguishable by kind.
        let dirs = find_impl(&root, "src", None, None, None).unwrap();
        assert_eq!(dirs.matches.len(), 1);
        assert_eq!(dirs.matches[0].kind, "directory");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn find_returns_empty_result_for_absent_relative_directory() {
        // 新项目首次扫描 `tests/` 的冷启动路径：目录不存在必须返回空结果而不是错误，
        // 否则调用方只能靠错误文案猜 not_found（首屏退化成「扫描失败」的隐式耦合）。
        let root = std::fs::canonicalize(temporary_directory()).unwrap();
        let result = find_impl(&root, "*.testspec.json", Some("tests"), None, None).unwrap();
        assert!(result.matches.is_empty());
        assert!(!result.truncated);
        // 非目录目标（指向一个文件）同样是 0 个匹配。
        std::fs::write(root.join("notes.txt"), "x").unwrap();
        let file_target = find_impl(&root, "*", Some("notes.txt"), None, None).unwrap();
        assert!(file_target.matches.is_empty());
        // 越界路径仍然拒绝：短路不得放宽 `..` 校验。
        assert!(find_impl(&root, "*", Some("../escape"), None, None).is_err());
    }

    #[test]
    fn find_caps_results_at_the_limit() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("data")).unwrap();
        for i in 0..10 {
            std::fs::write(root.join(format!("data/file{i}.txt")), "x").unwrap();
        }
        let result = find_impl(&root, "**/*.txt", None, Some(3), None).unwrap();
        assert_eq!(result.matches.len(), 3);
        assert!(result.truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn find_segment_glob_matches_any_depth_and_is_case_insensitive_via_classes() {
        // Composer 提及弹层的检索契约：`**/*[aA][pP][pP]*` 形态的 pattern
        // （useWorkspaceFileCandidates 生成）必须命中任意深度的段名包含匹配，
        // `**/` 前缀要能匹配零层目录（顶层文件不被漏掉），字符类实现大小写无关。
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("nested/deep")).unwrap();
        std::fs::write(root.join("App.tsx"), "a").unwrap();
        std::fs::write(root.join("nested/mapP.txt"), "b").unwrap();
        std::fs::write(root.join("nested/deep/unrelated.md"), "c").unwrap();

        let result = find_impl(&root, "**/*[aA][pP][pP]*", None, None, None).unwrap();
        let paths: Vec<&str> = result.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"App.tsx"));
        assert!(paths.contains(&"nested/mapP.txt"));
        assert_eq!(paths.len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn returns_an_actionable_hint_when_a_single_line_exceeds_the_limit() {
        let root = temporary_directory();
        std::fs::write(root.join("long.txt"), "x".repeat(MAX_READ_OUTPUT_BYTES + 1)).unwrap();
        // Previously this returned an error; now it returns a guidance payload
        // so the model is not left without options.
        let result = read_impl(&root, "long.txt", None, None).unwrap();
        assert!(result.truncated);
        assert!(result
            .content
            .contains("exceeds the 128 KiB read output limit"));
        // File has only one line, so there is no next offset to continue from.
        assert_eq!(result.next_offset, None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory();
        let outside = temporary_directory();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("escape.txt")).unwrap();
        assert!(read_impl(&root, "escape.txt", None, None).is_err());

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn auto_created_parents_never_cross_a_symlink_out_of_the_root() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory();
        let outside = temporary_directory();
        std::fs::create_dir_all(outside.join("real")).unwrap();
        // root/escape → outside/real：父目录「不存在」只是因为子目录还没建，
        // 但路径本身经符号链接指到根外——自动建目录时必须在这里拒绝。
        symlink(outside.join("real"), root.join("escape")).unwrap();
        assert!(create_text_file_impl(
            MutationScope::workspace(&root),
            "escape/sub/file.txt",
            "sneak",
        )
        .is_err());
        assert!(!outside.join("real/sub").exists());
        assert!(!outside.join("real/sub/file.txt").exists());

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn creates_new_text_files_without_overwriting_existing_paths() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join("notes")).unwrap();

        let created = create_text_file_impl(
            MutationScope::workspace(&root),
            "notes/axiom.md",
            "hello Axiom",
        )
        .unwrap();
        assert_eq!(created.path, "notes/axiom.md");
        assert_eq!(created.size_bytes, 11);
        assert_eq!(
            std::fs::read_to_string(root.join("notes/axiom.md")).unwrap(),
            "hello Axiom"
        );
        assert!(create_text_file_impl(
            MutationScope::workspace(&root),
            "notes/axiom.md",
            "overwrite"
        )
        .is_err());
        // 父目录不存在时自动创建（write 工具的父目录语义，见 task `write-parent-directory`）。
        let created_in_missing = create_text_file_impl(
            MutationScope::workspace(&root),
            "missing/file.txt",
            "no directory",
        )
        .unwrap();
        assert_eq!(created_in_missing.path, "missing/file.txt");
        assert_eq!(
            std::fs::read_to_string(root.join("missing/file.txt")).unwrap(),
            "no directory"
        );
        assert!(
            create_text_file_impl(MutationScope::workspace(&root), "../outside.txt", "escape")
                .is_err()
        );
        assert!(
            create_text_file_impl(MutationScope::workspace(&root), "notes/legacy.pen", "{}")
                .is_err()
        );
        assert!(
            create_text_file_impl(MutationScope::workspace(&root), "notes/design.ax", "{}").is_ok()
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_editing_pen_import_sources() {
        let root = temporary_directory();
        std::fs::write(root.join("legacy.pen"), r#"{"children":[]}"#).unwrap();
        let result = edit_text_file_impl(
            &root,
            "legacy.pen",
            &[WorkspaceEditOp {
                old_text: "children".into(),
                new_text: "pages".into(),
            }],
        );
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("legacy.pen")).unwrap(),
            r#"{"children":[]}"#
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn vue_sources_use_the_existing_text_read_and_edit_boundary() {
        let workspace = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        let file = root.join("Button.vue");
        let source = "<script setup lang=\"ts\">defineProps<{ label: string }>()</script>";
        std::fs::write(&file, source).unwrap();
        let read = read_impl(&root, "Button.vue", Some(1), Some(1)).unwrap();
        assert_eq!(read.content, source);
        assert_eq!(
            read.sha256,
            format!("{:x}", Sha256::digest(source.as_bytes()))
        );
        edit_text_file_impl(
            &root,
            "Button.vue",
            &[WorkspaceEditOp {
                old_text: "label".into(),
                new_text: "title".into(),
            }],
        )
        .unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("title"));
        std::fs::write(&file, vec![b'a'; MAX_TEXT_FILE_BYTES as usize + 1]).unwrap();
        assert!(read_impl(&root, "Button.vue", Some(1), Some(1)).is_err());
    }

    #[test]
    fn reads_test_specs_through_the_workspace_text_boundary() {
        let workspace = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        std::fs::create_dir(root.join("tests")).unwrap();
        let content = r#"{"kind":"axiom.test","version":1}"#;
        std::fs::write(root.join("tests/api.testspec.json"), content).unwrap();

        let read = read_impl(&root, "tests/api.testspec.json", Some(1), Some(1)).unwrap();
        assert_eq!(read.content, content);
        assert_eq!(
            read.sha256,
            format!("{:x}", Sha256::digest(content.as_bytes()))
        );
    }

    #[test]
    fn agent_design_edit_saves_old_version_and_backup_failure_preserves_document() {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        let file = root.join("draft.ax");
        let before = r#"{"ax":"1.0","pages":[{"id":"before"}]}"#;
        std::fs::write(&file, before).unwrap();
        let edits = vec![WorkspaceEditOp {
            old_text: "before".into(),
            new_text: "after".into(),
        }];
        edit_text_file_with_history_impl(
            MutationScope::workspace(&root),
            "draft.ax",
            &edits,
            Some(data.path()),
        )
        .unwrap();
        let history = crate::design_history::directory(data.path(), &root, &file);
        let versions = crate::design_history::list(&history).unwrap();
        assert_eq!(
            crate::design_history::read(&history, &versions[0].sha256).unwrap(),
            before.as_bytes()
        );
        let broken = tempfile::tempdir().unwrap();
        std::fs::write(broken.path().join("design-history"), "not a directory").unwrap();
        let updated = std::fs::read(&file).unwrap();
        assert!(edit_text_file_with_history_impl(
            MutationScope::workspace(&root),
            "draft.ax",
            &[WorkspaceEditOp {
                old_text: "after".into(),
                new_text: "lost".into()
            }],
            Some(broken.path())
        )
        .is_err());
        assert_eq!(std::fs::read(&file).unwrap(), updated);
    }

    #[test]
    fn edits_only_a_unique_match_and_preserves_permissions() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let root = temporary_directory();
        let file = root.join("notes.txt");
        std::fs::write(&file, "before\nunique value\nafter\n").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();

        let edited = edit_text_file_impl(
            &root,
            "notes.txt",
            &[WorkspaceEditOp {
                old_text: "unique value".into(),
                new_text: "updated".into(),
            }],
        )
        .unwrap();
        assert_eq!(edited.path, "notes.txt");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "before\nupdated\nafter\n"
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );

        std::fs::write(&file, "same same").unwrap();
        assert!(edit_text_file_impl(
            &root,
            "notes.txt",
            &[WorkspaceEditOp {
                old_text: "same".into(),
                new_text: "other".into(),
            }]
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "same same");
        assert!(edit_text_file_impl(
            &root,
            "notes.txt",
            &[WorkspaceEditOp {
                old_text: "missing".into(),
                new_text: "other".into(),
            }]
        )
        .is_err());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edits_match_fuzzily_when_exact_text_differs() {
        let root = temporary_directory();
        let file = root.join("notes.md");
        // File uses smart quotes; the model provided straight quotes.
        std::fs::write(&file, "keep\nconst s = \u{201C}hello\u{201D}\ntail\n").unwrap();
        let _edited = edit_text_file_impl(
            &root,
            "notes.md",
            &[WorkspaceEditOp {
                old_text: "\"hello\"".into(),
                new_text: "\"world\"".into(),
            }],
        )
        .unwrap();
        // The replaced line is normalized (smart quotes collapsed) but the
        // untouched lines keep their original bytes.
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "keep\nconst s = \"world\"\ntail\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edits_apply_multiple_disjoint_replacements_in_one_call() {
        let root = temporary_directory();
        let file = root.join("multi.txt");
        std::fs::write(&file, "alpha\nbeta\ngamma\n").unwrap();
        edit_text_file_impl(
            &root,
            "multi.txt",
            &[
                WorkspaceEditOp {
                    old_text: "alpha".into(),
                    new_text: "ALPHA".into(),
                },
                WorkspaceEditOp {
                    old_text: "gamma".into(),
                    new_text: "GAMMA".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "ALPHA\nbeta\nGAMMA\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edits_reject_overlapping_replacements() {
        let root = temporary_directory();
        let file = root.join("overlap.txt");
        std::fs::write(&file, "abcdef").unwrap();
        let result = edit_text_file_impl(
            &root,
            "overlap.txt",
            &[
                WorkspaceEditOp {
                    old_text: "abcd".into(),
                    new_text: "ABCD".into(),
                },
                WorkspaceEditOp {
                    old_text: "cdef".into(),
                    new_text: "CDEF".into(),
                },
            ],
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "abcdef");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edits_reject_empty_edits_payload() {
        let root = temporary_directory();
        std::fs::write(root.join("x.txt"), "hi").unwrap();
        assert!(edit_text_file_impl(&root, "x.txt", &[]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_oversized_workspace_writes() {
        let root = temporary_directory();
        let oversized = "x".repeat(MAX_TEXT_FILE_BYTES as usize + 1);
        assert!(
            create_text_file_impl(MutationScope::workspace(&root), "large.txt", &oversized)
                .is_err()
        );
        std::fs::write(root.join("small.txt"), "replace me").unwrap();
        assert!(edit_text_file_impl(
            &root,
            "small.txt",
            &[WorkspaceEditOp {
                old_text: "replace me".into(),
                new_text: oversized.clone(),
            }]
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("small.txt")).unwrap(),
            "replace me"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_workspace_writes_through_escaping_symlinks() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory();
        let outside = temporary_directory();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, root.join("outside-dir")).unwrap();
        symlink(outside.join("secret.txt"), root.join("outside-file.txt")).unwrap();

        assert!(create_text_file_impl(
            MutationScope::workspace(&root),
            "outside-dir/new.txt",
            "escape"
        )
        .is_err());
        assert!(edit_text_file_impl(
            &root,
            "outside-file.txt",
            &[WorkspaceEditOp {
                old_text: "secret".into(),
                new_text: "changed".into(),
            }]
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "secret"
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    /// 完全访问档：写工具与 bash/apply_changes 同源放开工作区包含限制——
    /// write/edit 消费租约 tier 后接受工作区外绝对路径，标准模式仍拒。
    #[test]
    fn full_access_scope_lets_write_and_edit_target_absolute_paths_outside_workspace() {
        let root = temporary_directory();
        let outside = temporary_directory();

        let created = create_text_file_impl(
            MutationScope::unrestricted(&root),
            outside.join("new.txt").to_str().unwrap(),
            "hello",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.join("new.txt")).unwrap(),
            "hello"
        );
        // 工作区外目标按绝对路径回报，不伪造工作区相对路径。
        assert_eq!(created.path, outside.join("new.txt").to_str().unwrap());

        let edited = edit_text_file_with_history_impl(
            MutationScope::unrestricted(&root),
            outside.join("new.txt").to_str().unwrap(),
            &[WorkspaceEditOp {
                old_text: "hello".into(),
                new_text: "world".into(),
            }],
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.join("new.txt")).unwrap(),
            "world"
        );
        assert_eq!(edited.path, outside.join("new.txt").to_str().unwrap());

        // 同一绝对路径在标准档仍被工作区包含限制拒绝。
        assert!(create_text_file_impl(
            MutationScope::workspace(&root),
            outside.join("blocked.txt").to_str().unwrap(),
            "x"
        )
        .is_err());
        assert!(edit_text_file_impl(
            &root,
            outside.join("new.txt").to_str().unwrap(),
            &[WorkspaceEditOp {
                old_text: "world".into(),
                new_text: "nope".into(),
            }]
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("new.txt")).unwrap(),
            "world"
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    /// 放开工作区包含限制不等于放开敏感路径保护：Axiom 数据根与凭据祖先在
    /// 完全访问档下同样不可写（不变量 9）。
    #[test]
    fn full_access_scope_still_refuses_protected_paths() {
        let root = temporary_directory();
        let home = crate::sandbox::policy_home().unwrap();
        let data_root = home.join(".axiom");
        let error = create_text_file_impl(
            MutationScope::unrestricted(&root),
            data_root.join("probe.txt").to_str().unwrap(),
            "x",
        )
        .unwrap_err();
        assert!(
            error.contains("敏感路径保护"),
            "expected sensitive path refusal, got {error}"
        );
        assert!(!data_root.join("probe.txt").exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_writes_to_reserved_control_directories() {
        let root = temporary_directory();
        std::fs::create_dir_all(root.join(".git/hooks")).unwrap();
        std::fs::write(root.join(".git/hooks/pre-commit.sh"), "echo old").unwrap();
        std::fs::create_dir_all(root.join(".axiom")).unwrap();

        assert!(create_text_file_impl(
            MutationScope::workspace(&root),
            ".git/hooks/pre-push.sh",
            "echo pwned"
        )
        .is_err());
        assert!(
            create_text_file_impl(MutationScope::workspace(&root), ".axiom/notes.md", "notes")
                .is_err()
        );
        assert!(edit_text_file_impl(
            &root,
            ".git/hooks/pre-commit.sh",
            &[WorkspaceEditOp {
                old_text: "old".into(),
                new_text: "pwned".into(),
            }]
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(".git/hooks/pre-commit.sh")).unwrap(),
            "echo old"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_case_variant_reserved_control_directories() {
        // APFS/HFS+ 默认大小写不敏感：`.GIT` / `.Git` 变体解析到真实的 `.git`，
        // 纯组件级校验必须按 ASCII 小写拒绝，否则保留目录不变量可被绕过。
        assert!(reject_reserved_write_components(Path::new(".GIT/hooks/pre-commit.sh")).is_err());
        assert!(reject_reserved_write_components(Path::new(".Git/hooks/pre-commit.sh")).is_err());
        assert!(reject_reserved_write_components(Path::new(".Axiom/notes.md")).is_err());
        assert!(reject_reserved_write_components(Path::new("src/.GiT/config")).is_err());
        assert!(reject_reserved_write_components(Path::new("src/main.ts")).is_ok());
        assert!(reject_reserved_write_components(Path::new("src/.gittool/readme.md")).is_ok());
        assert!(reject_reserved_write_components(Path::new("src/.axiombox/spec.md")).is_ok());
    }

    #[test]
    fn restore_authorization_requires_registry_membership() {
        // 攻击链回归：受陷渲染进程直接调 authorize_workspace 传入任意绝对路径
        // （如 $HOME），配合 SandboxSafe 免手势租约可把 seatbelt 的写范围扩张到
        // 全盘。恢复授权必须只接受注册表（原生选择器写入）登记过的目录。
        let directory = temporary_directory();
        let registry_file = directory.join("authorized_workspaces.json");
        let attacker_root = temporary_directory();
        let legit_root = temporary_directory();
        workspace_registry::registry_insert(&registry_file, &legit_root).unwrap();

        let state = WorkspaceAccessState::default();
        let error = authorize_restore_impl(&state, &registry_file, attacker_root.to_str().unwrap())
            .expect_err("unregistered path must be rejected");
        assert!(
            error.contains("was not previously authorized"),
            "unexpected error: {error}"
        );
        assert!(authorized_root_for(&state, Some(attacker_root.to_str().unwrap())).is_err());

        // 登记过的目录可正常恢复授权。
        authorize_restore_impl(&state, &registry_file, legit_root.to_str().unwrap()).unwrap();
        assert_eq!(
            authorized_root_for(&state, Some(legit_root.to_str().unwrap())).unwrap(),
            legit_root
        );

        std::fs::remove_dir_all(attacker_root).unwrap();
        std::fs::remove_dir_all(legit_root).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_authorization_is_denied_after_registry_removal() {
        // 撤销链回归：revoke 先移除注册表条目，随后同路径的重启恢复必须被拒绝，
        // 保证「撤销」跨重启有效（localStorage/SQLite 残留不足以复活授权）。
        let directory = temporary_directory();
        let registry_file = directory.join("authorized_workspaces.json");
        let root = temporary_directory();
        workspace_registry::registry_insert(&registry_file, &root).unwrap();
        let state = WorkspaceAccessState::default();
        authorize_restore_impl(&state, &registry_file, root.to_str().unwrap()).unwrap();

        // 模拟 revoke_workspace 命令的顺序：注册表移除成功后才内存 revoke。
        workspace_registry::registry_remove(&registry_file, &root).unwrap();
        revoke_impl(&state, &root).unwrap();

        assert!(authorize_restore_impl(&state, &registry_file, root.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn restore_authorization_fails_closed_on_corrupted_registry() {
        let directory = temporary_directory();
        let registry_file = directory.join("authorized_workspaces.json");
        let root = temporary_directory();
        std::fs::write(&registry_file, "corrupted").unwrap();

        let state = WorkspaceAccessState::default();
        assert!(authorize_restore_impl(&state, &registry_file, root.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn workspace_read_list_search_and_find_filter_protected_paths() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(home.join(".axiom")).unwrap();
        std::fs::write(home.join("main.txt"), "needle normal").unwrap();
        std::fs::write(home.join(".ssh/key.txt"), "needle credential").unwrap();
        std::fs::write(home.join(".axiom/data.txt"), "needle database").unwrap();
        std::fs::write(home.join(".npmrc"), "needle token").unwrap();
        std::fs::write(home.join(".ssh/image.png"), b"invalid-image-stub").unwrap();
        let root = std::fs::canonicalize(home).unwrap();
        let policy = crate::sandbox::SensitivePathPolicy::new(&root, std::slice::from_ref(&root));
        let normal = read_impl_with_policy(&root, "main.txt", None, None, &policy).unwrap();
        assert_eq!(normal.content, "needle normal");
        for path in [
            ".ssh/key.txt",
            ".axiom/data.txt",
            ".npmrc",
            ".ssh/image.png",
        ] {
            assert!(read_impl_with_policy(&root, path, None, None, &policy)
                .unwrap_err()
                .message
                .contains("敏感路径"));
        }
        let listed = list_impl_with_policy(&root, None, None, &policy).unwrap();
        assert_eq!(
            listed
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["main.txt"]
        );
        assert!(list_impl_with_policy(&root, Some(".ssh"), None, &policy).is_err());
        let found = find_impl_with_policy(&root, "**", None, None, None, &policy).unwrap();
        assert_eq!(
            found
                .matches
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["main.txt"]
        );
        let searched = search_impl_with_policy(
            &root,
            SearchOptions {
                pattern: "needle".into(),
                path: None,
                glob: None,
                ignore_case: false,
                literal: true,
                limit: 10,
                context: 0,
            },
            &AtomicBool::new(false),
            &policy,
        )
        .unwrap();
        assert_eq!(
            searched
                .matches
                .iter()
                .map(|entry| entry.line.as_str())
                .collect::<Vec<_>>(),
            ["needle normal"]
        );
        assert!(ensure_path_access(&policy, &root.join(".ssh"), true).is_err());
        assert!(ensure_path_access(&policy, &root.join("main.txt"), true).is_ok());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn restore_sensitive_workspaces_requires_matching_native_scope_and_never_grants_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        #[cfg(target_os = "macos")]
        let boundary = home.join("Library/Mail");
        #[cfg(target_os = "linux")]
        let boundary = home.join(".local/share/Trash");
        let workspace = boundary.join("project");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(home.join(".ssh/project")).unwrap();
        let workspace = std::fs::canonicalize(workspace).unwrap();
        let boundary = std::fs::canonicalize(boundary).unwrap();
        let file = dir.path().join("registry.json");
        let state = WorkspaceAccessState::default();
        workspace_registry::registry_insert(&file, &workspace).unwrap();
        assert!(
            authorize_restore_with_home(&state, &file, &workspace.to_string_lossy(), &home)
                .is_err()
        );
        assert!(authorized_roots(&state).is_empty());
        workspace_registry::registry_insert_with_scope(&file, &workspace, Some(&boundary)).unwrap();
        assert!(
            authorize_restore_with_home(&state, &file, &workspace.to_string_lossy(), &home).is_ok()
        );
        let credential = std::fs::canonicalize(home.join(".ssh/project")).unwrap();
        workspace_registry::registry_insert(&file, &credential).unwrap();
        assert!(
            authorize_restore_with_home(&state, &file, &credential.to_string_lossy(), &home)
                .is_err()
        );
        assert_eq!(authorized_roots(&state), [workspace]);
    }
}
