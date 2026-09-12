import {
  AgentEnvironmentError,
  type AgentEnvironment,
  type AgentEnvironmentErrorCode,
} from '@/agent/environment/AgentEnvironment'
import { listAuthorizedReadFiles, readAuthorizedText } from '@/platform/authorizedFiles'
import { getRuntimeInfo } from '@/platform/runtimeInfo'
import {
  applyWorkspaceChanges,
  createWorkspaceTextFile,
  editWorkspaceTextFile,
  findWorkspaceFiles,
  listWorkspace,
  readWorkspaceText,
  restoreWorkspaceTrash,
  searchWorkspaceText,
} from '@/platform/workspace'
import { runWorkspaceCommand } from '@/platform/workspaceCommand'
import { writeToolResultArtifact } from '@/platform/artifacts'
import { webFetch, webSearch } from '@/platform/webAccess'
import { browserCommand, notifyBrowserAgentActivity } from '@/platform/browserSession'
import { computerCommand } from '@/platform/computerSession'
import { sshAgentCommand } from '@/platform/sshAgent'

const errorCode = (error: unknown): AgentEnvironmentErrorCode => {
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted'
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('abort') || message.includes('取消')) return 'aborted'
  if (message.includes('授权') || message.includes('authorized')) return 'not_authorized'
  if (message.includes('路径') || message.includes('path') || message.includes('outside')) return 'invalid_path'
  if (message.includes('timeout') || message.includes('超时')) return 'timeout'
  if (message.includes('conflict') || message.includes('冲突') || message.includes('sha256')) return 'conflict'
  if (message.includes('不可用') || message.includes('仅在') || message.includes('unavailable')) return 'unavailable'
  return 'unknown'
}

const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AgentEnvironmentError) throw error
    throw new AgentEnvironmentError(
      errorCode(error),
      error instanceof Error ? error.message : String(error),
      error,
    )
  }
}

export const createDesktopAgentEnvironment = (workspacePath?: string): AgentEnvironment => ({
  runtime: {
    getInfo: () => guarded(getRuntimeInfo),
  },
  authorizedFiles: {
    list: () => guarded(listAuthorizedReadFiles),
    readText: (path) => guarded(() => readAuthorizedText(path)),
  },
  workspace: {
    list: (path, limit) => guarded(() => listWorkspace(path, limit, workspacePath)),
    readText: (path, offset, limit) => guarded(() =>
      readWorkspaceText(path, offset, limit, workspacePath)),
    searchText: (request, signal) => guarded(() =>
      searchWorkspaceText(request, signal, workspacePath)),
    createTextFile: (path, content, approvalLease) => guarded(() =>
      createWorkspaceTextFile(path, content, approvalLease, workspacePath)),
    editTextFile: (path, edits, approvalLease) => guarded(() =>
      editWorkspaceTextFile(path, edits, approvalLease, workspacePath)),
    applyChanges: (request, approvalLease) => guarded(() =>
      applyWorkspaceChanges(request, approvalLease, workspacePath)),
    restoreTrash: (recoveryId, approvalLease) => guarded(() =>
      restoreWorkspaceTrash(recoveryId, approvalLease, workspacePath)),
    runCommand: (request, signal, onProgress, approvalLease) => guarded(() =>
      runWorkspaceCommand(request, signal, onProgress, approvalLease, workspacePath)),
    find: (request) => guarded(() => findWorkspaceFiles({ ...request, workspacePath })),
  },
  artifacts: {
    writeToolResult: (request) => guarded(() => writeToolResultArtifact(request)),
  },
  web: {
    search: (request) => guarded(() => webSearch(request.query, request.limit)),
    fetch: (request) => guarded(() => webFetch(request.url, request.maxBytes)),
  },
  browser: {
    command: async (request) => {
      const response = await guarded(() => browserCommand(request))
      // Agent 通道活动通知（成功后触发）：面板服务据此在 Agent 开新页面时
      // 自动展示浏览器面板；面板自身操作不经此通道，不会误触发。
      notifyBrowserAgentActivity(request, response)
      return response
    },
  },
  computer: {
    command: (request) => guarded(() => computerCommand(request)),
  },
  ssh: {
    // workspacePath 透传与 workspace.runCommand 同一语义：lease 签发/消费两侧
    // 必须解析到同一授权根（多工作区并行时按会话工作区对齐）。
    command: (request, options) =>
      guarded(() => sshAgentCommand(request, {
        approvalLease: options?.approvalLease,
        workspacePath: options?.workspacePath ?? workspacePath,
      })),
  },
})

export const desktopAgentEnvironment: AgentEnvironment = createDesktopAgentEnvironment()
