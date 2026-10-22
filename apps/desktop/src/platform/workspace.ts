import type { ToolApprovalScope } from '@/agent/core/approvalScope'
import type { ArtifactReference } from '@/agent/core/types'
import { AgentEnvironmentError, type AgentEnvironmentErrorCode } from '@/agent/environment/AgentEnvironment'
import { invoke } from '@tauri-apps/api/core'
import { commands } from './bindings'
import { isTauriRuntime } from './environment'

export interface AuthorizedWorkspace {
  path: string
  name: string
  gitBranch?: string | null
}

export interface WorkspaceEntry {
  path: string
  name: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
  sizeBytes: number
  /** 文件 mtime（Unix epoch ms）；宿主拿不到时缺省。文档索引用它复用 revision 缓存。 */
  modifiedMs?: number
}

export interface WorkspaceListResult {
  workspace: AuthorizedWorkspace
  directory: string
  entries: WorkspaceEntry[]
  truncated: boolean
}

export interface WorkspaceReadImage {
  mimeType: string
  dataBase64: string
  originalWidth?: number
  originalHeight?: number
  resized: boolean
}

export interface WorkspaceReadResult {
  workspace: AuthorizedWorkspace
  path: string
  content: string
  sha256: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  nextOffset?: number
  image?: WorkspaceReadImage
}

export interface WorkspaceSearchContextLine {
  lineNumber: number
  line: string
  isMatch: boolean
}

export interface WorkspaceSearchMatch {
  path: string
  lineNumber: number
  line: string
  contextLines?: WorkspaceSearchContextLine[]
}

export interface WorkspaceSearchResult {
  workspace: AuthorizedWorkspace
  matches: WorkspaceSearchMatch[]
  truncated: boolean
}

export interface WorkspaceWriteResult {
  workspace: AuthorizedWorkspace
  path: string
  sizeBytes: number
  sha256: string
}

export interface WorkspaceEditOp {
  oldText: string
  newText: string
}

export interface WorkspaceFindResult {
  workspace: AuthorizedWorkspace
  pattern: string
  rootPath: string
  matches: WorkspaceEntry[]
  truncated: boolean
}

export interface WorkspaceSearchRequest {
  requestId: string
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  limit?: number
  context?: number
}

export type WorkspaceChangeOperation =
  | { type: 'create-file'; path: string; content: string }
  | {
      type: 'patch-file'
      path: string
      expectedSha256: string
      oldText: string
      newText: string
    }
  | { type: 'create-directory'; path: string }
  | { type: 'move'; from: string; to: string; expectedSha256?: string }
  | { type: 'trash'; path: string; expectedSha256?: string }

export interface WorkspaceChangeRequest {
  requestId: string
  operations: WorkspaceChangeOperation[]
}

export interface WorkspaceChangeSummary {
  operation: WorkspaceChangeOperation['type'] | 'restore'
  path: string
  destination?: string
  sha256?: string
}

export interface WorkspaceChangeResult {
  workspace: AuthorizedWorkspace
  requestId: string
  changes: WorkspaceChangeSummary[]
  recoveryId?: string
  auditArtifact?: ArtifactReference
  historyWarning?: string
}

export interface WorkspaceRecoveryIssue {
  message: string
  workspace: string | null
  recoveryId: string | null
  recoveryPath: string | null
}

const requireTauri = (): void => {
  if (!isTauriRuntime()) throw new Error('工作区授权仅在 Axiom 桌面应用中可用')
}

export const selectAndAuthorizeWorkspace = async (): Promise<AuthorizedWorkspace | null> => {
  requireTauri()
  // 原生目录选择器在 Rust 侧打开并直接授权，WebView 不再传递任意绝对路径；
  // 取消时返回 null。
  return invoke<AuthorizedWorkspace | null>('pick_and_authorize_workspace')
}

export const getAuthorizedWorkspace = async (): Promise<AuthorizedWorkspace | null> => {
  requireTauri()
  return commands.getAuthorizedWorkspace()
}

export const getAuthorizedWorkspaces = async (): Promise<AuthorizedWorkspace[]> => {
  requireTauri()
  return commands.getAuthorizedWorkspaces()
}

export interface WorkspaceAuthorizationRestoreResult {
  workspaces: AuthorizedWorkspace[]
  failedPaths: string[]
}

export const restoreAuthorizedWorkspaces = async (
  paths: readonly string[],
): Promise<WorkspaceAuthorizationRestoreResult> => {
  requireTauri()
  const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
  const failedPaths: string[] = []
  for (const path of uniquePaths) {
    try {
      await invoke<AuthorizedWorkspace>('authorize_workspace', { path })
    } catch {
      failedPaths.push(path)
    }
  }
  return {
    workspaces: await getAuthorizedWorkspaces(),
    failedPaths,
  }
}

export const activateAuthorizedWorkspace = async (path: string): Promise<AuthorizedWorkspace> => {
  requireTauri()
  return commands.activateAuthorizedWorkspace(path)
}

export const revokeWorkspace = async (path?: string): Promise<boolean> => {
  requireTauri()
  return commands.revokeWorkspace(path ?? null)
}

export const listWorkspace = async (
  path?: string,
  limit?: number,
  workspacePath?: string,
): Promise<WorkspaceListResult> => {
  requireTauri()
  const result = await commands.listWorkspace(path ?? null, limit ?? null, workspacePath ?? null)
  return {
    ...result,
    entries: result.entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      kind: entry.kind as WorkspaceEntry['kind'],
      sizeBytes: entry.sizeBytes,
      ...(entry.modifiedMs !== undefined && entry.modifiedMs !== null
        ? { modifiedMs: entry.modifiedMs }
        : {}),
    })),
  }
}

/**
 * macOS screenshot and accented filenames often differ from what a user types:
 * a narrow no-break space (U+202F) precedes AM/PM, names are stored in NFD
 * decomposed form, and French locales use U+2019 instead of a straight quote.
 * These variants mirror pi's `path-utils.ts` fallback chain.
 */
const macOSPathVariants = (path: string): string[] => {
  const variants: string[] = []
  // Narrow no-break space before AM/PM (e.g. "Screenshot 2024 AM.").
  const ampm = path.replace(/ (AM|PM)\./giu, '\u202F$1.')
  if (ampm !== path) variants.push(ampm)
  // NFD decomposed form (macOS HFS+/APFS stores names decomposed).
  const nfd = path.normalize('NFD')
  if (nfd !== path) variants.push(nfd)
  // Curly quote U+2019 (e.g. French "Capture d'écran").
  const curly = path.replace(/'/gu, '\u2019')
  if (curly !== path) variants.push(curly)
  // NFD + curly quote combined.
  const nfdCurly = nfd.replace(/'/gu, '\u2019')
  if (nfdCurly !== path && nfdCurly !== nfd && nfdCurly !== curly) variants.push(nfdCurly)
  return variants
}

export const readWorkspaceText = async (
  path: string,
  offset?: number,
  limit?: number,
  workspacePath?: string,
): Promise<WorkspaceReadResult> => {
  requireTauri()
  const read = async (candidate: string): Promise<WorkspaceReadResult> => {
    const result = await commands.readWorkspaceText(
      candidate,
      offset ?? null,
      limit ?? null,
      workspacePath ?? null,
    )
    return {
      ...result,
      nextOffset: result.nextOffset ?? undefined,
      ...(result.image
        ? {
            image: {
              ...result.image,
              originalWidth: result.image.originalWidth ?? undefined,
              originalHeight: result.image.originalHeight ?? undefined,
            },
          }
        : { image: undefined }),
    }
  }
  try {
    return await read(path)
  } catch (originalError) {
    // Try macOS filename variants (NFD, curly quotes, narrow NBSP) before
    // giving up — the canonical filename may differ from what was typed.
    for (const variant of macOSPathVariants(path)) {
      try {
        return await read(variant)
      } catch {
        // Continue to the next variant.
      }
    }
    throw originalError
  }
}

export const createWorkspaceTextFile = async (
  path: string,
  content: string,
  approvalLease: string,
  workspacePath?: string,
  approvalScope?: ToolApprovalScope,
): Promise<WorkspaceWriteResult> => {
  requireTauri()
  return invoke<WorkspaceWriteResult>('create_workspace_text_file', {
    path,
    content,
    approvalLease,
    ...(approvalScope ? { approvalScope } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  })
}

export const editWorkspaceTextFile = async (
  path: string,
  edits: WorkspaceEditOp[],
  approvalLease: string,
  workspacePath?: string,
  approvalScope?: ToolApprovalScope,
): Promise<WorkspaceWriteResult> => {
  requireTauri()
  return invoke<WorkspaceWriteResult>('edit_workspace_text_file', {
    request: { path, edits },
    approvalLease,
    ...(approvalScope ? { approvalScope } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  })
}

export const applyWorkspaceChanges = async (
  request: WorkspaceChangeRequest,
  approvalLease: string,
  workspacePath?: string,
  approvalScope?: ToolApprovalScope,
): Promise<WorkspaceChangeResult> => {
  requireTauri()
  return invoke<WorkspaceChangeResult>('apply_workspace_changes', {
    request,
    approvalLease,
    ...(approvalScope ? { approvalScope } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  })
}

export const restoreWorkspaceTrash = async (
  recoveryId: string,
  approvalLease: string,
  workspacePath?: string,
  approvalScope?: ToolApprovalScope,
): Promise<WorkspaceChangeResult> => {
  requireTauri()
  return invoke<WorkspaceChangeResult>('restore_workspace_trash', {
    recoveryId,
    approvalLease,
    ...(approvalScope ? { approvalScope } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  })
}

export const getWorkspaceRecoveryIssue = async (): Promise<WorkspaceRecoveryIssue | null> =>
  invoke<WorkspaceRecoveryIssue | null>('get_workspace_recovery_issue')

export const retryWorkspaceRecovery = async (): Promise<WorkspaceRecoveryIssue | null> =>
  invoke<WorkspaceRecoveryIssue | null>('retry_workspace_recovery')

export const cancelWorkspaceSearch = async (requestId: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false
  return invoke<boolean>('cancel_workspace_search', { requestId })
}

export const searchWorkspaceText = async (
  request: WorkspaceSearchRequest,
  signal: AbortSignal,
  workspacePath?: string,
): Promise<WorkspaceSearchResult> => {
  requireTauri()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const abort = () => {
    void cancelWorkspaceSearch(request.requestId).catch(() => false)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await invoke<WorkspaceSearchResult>('search_workspace_text', {
      request: { ...request },
      ...(workspacePath ? { workspacePath } : {}),
    })
  } finally {
    signal.removeEventListener('abort', abort)
    if (signal.aborted) await cancelWorkspaceSearch(request.requestId).catch(() => false)
  }
}

export const findWorkspaceFiles = async (request: {
  requestId: string
  pattern: string
  path?: string
  limit?: number
  /** 只遍历到指定深度（1 = 工作区顶层）；缺省不限。 */
  maxDepth?: number
  signal: AbortSignal
  workspacePath?: string
}): Promise<WorkspaceFindResult> => {
  if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError')
  requireTauri()
  let result: WorkspaceFindResult
  try {
    result = await invoke<WorkspaceFindResult>('find_workspace_files', {
      request: {
        pattern: request.pattern,
        ...(request.path !== undefined ? { path: request.path } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
      },
      ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
    })
  } catch (error) {
    throw workspaceCommandError(error)
  }
  if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return result
}

/**
 * `find_workspace_files` 的错误信封（`{ code, message }`）→ `AgentEnvironmentError`。
 *
 * 命令侧对「目录不存在」已短路为空结果，因此这里的 code 只承载真实故障
 * （not_authorized / unavailable / unknown）。调用方按 code 判定，不再读 message 文案；
 * 非信封错误（旧宿主或 IPC 层错误）原样抛出，保留 message 供诊断。
 */
const ENVELOPE_CODES: ReadonlySet<string> = new Set<AgentEnvironmentErrorCode>([
  'not_authorized',
  'not_found',
  'invalid_path',
  'unavailable',
  'unknown',
])

const workspaceCommandError = (error: unknown): Error => {
  if (error instanceof AgentEnvironmentError) return error
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (
      typeof candidate.code === 'string'
      && ENVELOPE_CODES.has(candidate.code)
      && typeof candidate.message === 'string'
    ) {
      return new AgentEnvironmentError(
        candidate.code as AgentEnvironmentErrorCode,
        candidate.message,
        error,
      )
    }
  }
  return error instanceof Error ? error : new Error(String(error))
}
