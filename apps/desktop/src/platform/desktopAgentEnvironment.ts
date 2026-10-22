import type { ToolApprovalScope } from '@/agent/core/approvalScope'
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
import { browserCommand, notifyBrowserAgentActivity } from '@/platform/browserSession'
import { writeImageArtifact, writeToolResultArtifact } from '@/platform/artifacts'
import { NativeApprovalCanceledError, runApiTestStepWithLease } from '@/platform/apiTestAutomation'
import { readDesignDocument } from '@/platform/designDocument'

interface PlatformErrorEnvelope {
  code: AgentEnvironmentErrorCode
  message: string
}

const ERROR_CODES: ReadonlySet<string> = new Set<AgentEnvironmentErrorCode>([
  'aborted',
  'not_authorized',
  'not_found',
  'invalid_path',
  'timeout',
  'conflict',
  'unavailable',
  'unknown',
])

const platformErrorEnvelope = (error: unknown): PlatformErrorEnvelope | null => {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; message?: unknown }
  if (typeof candidate.code !== 'string' || !ERROR_CODES.has(candidate.code)) return null
  if (typeof candidate.message !== 'string') return null
  return { code: candidate.code as AgentEnvironmentErrorCode, message: candidate.message }
}

const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AgentEnvironmentError) throw error
    const envelope = platformErrorEnvelope(error)
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    throw new AgentEnvironmentError(
      envelope?.code ?? (aborted ? 'aborted' : 'unknown'),
      envelope?.message ?? (error instanceof Error ? error.message : String(error)),
      error,
    )
  }
}

export const createDesktopAgentEnvironment = (
  workspacePath?: string,
  sessionId?: string,
): AgentEnvironment => {
  const boundScope = (scope?: ToolApprovalScope): ToolApprovalScope => {
    if (!sessionId || !scope || scope.sessionId !== sessionId) {
      throw new AgentEnvironmentError('not_authorized', '写入和执行必须绑定当前会话的审批调用身份')
    }
    return { ...scope, sessionId }
  }
  return {
    runtime: {
      getInfo: () => guarded(getRuntimeInfo),
    },
    authorizedFiles: {
      list: () => guarded(listAuthorizedReadFiles),
      readText: (path) => guarded(() => readAuthorizedText(path)),
    },
    workspace: {
      list: (path, limit) => guarded(() => listWorkspace(path, limit, workspacePath)),
      readText: (path, offset, limit) => guarded(() => readWorkspaceText(path, offset, limit, workspacePath)),
      searchText: (request, signal) => guarded(() => searchWorkspaceText(request, signal, workspacePath)),
      createTextFile: (path, content, approvalLease, scope) =>
        guarded(() =>
          createWorkspaceTextFile(path, content, approvalLease, workspacePath, boundScope(scope)),
        ),
      editTextFile: (path, edits, approvalLease, scope) =>
        guarded(() => editWorkspaceTextFile(path, edits, approvalLease, workspacePath, boundScope(scope))),
      applyChanges: (request, approvalLease, scope) =>
        guarded(() => applyWorkspaceChanges(request, approvalLease, workspacePath, boundScope(scope))),
      restoreTrash: (recoveryId, approvalLease, scope) =>
        guarded(() => restoreWorkspaceTrash(recoveryId, approvalLease, workspacePath, boundScope(scope))),
      runCommand: (request, signal, onProgress, approvalLease, scope) =>
        guarded(() =>
          runWorkspaceCommand(request, signal, onProgress, approvalLease, workspacePath, boundScope(scope)),
        ),
      find: (request) => guarded(() => findWorkspaceFiles({ ...request, workspacePath })),
    },
    artifacts: {
      writeToolResult: (request) => guarded(() => writeToolResultArtifact(request)),
      writeImage: (request) => guarded(() => writeImageArtifact(request)),
    },
    browser: {
      // 探索通道：转发宿主 browser_command 并通知面板自动展示。通知只在本
      // 接口成功返回后发出——面板自身的操作不走本接口，不会误触发。
      // command = 只读子集；write = 写子集（G1-3），两者在类型上分列，宿主侧
      // 同一条 browser_command 由 Rust 权威执行。
      command: (request) => guarded(async () => {
        const response = await browserCommand(request)
        notifyBrowserAgentActivity(request, response)
        return response
      }),
      write: (request) => guarded(async () => {
        const response = await browserCommand(request)
        notifyBrowserAgentActivity(request, response)
        return response
      }),
    },
    api: {
      // API 测试步骤通道：复用 A1 Rust Driver（租约 → 运行 → abort 时取消），
      // 只把目标工作区环境与「Agent run 身份」映射成 Driver 的 runId/stepId。
      // 带 Secret 的步骤可能被原生内容确认框拒绝：转成 rejected 结果，而不是
      // 让 guarded 把取消包装成 unknown 错误。
      runStep: (request, signal) => guarded(async () => {
        try {
          return await runApiTestStepWithLease(
            {
              runId: request.runId,
              ...(request.environmentId ? { environmentId: request.environmentId } : {}),
            },
            request.step,
            signal,
          )
        } catch (error) {
          if (error instanceof NativeApprovalCanceledError) {
            return {
              verdict: 'not_evaluated' as const,
              runnerVerdict: 'rejected' as const,
              transport: 'canceled' as const,
              message: '用户在原生确认中取消了本 API 请求',
              evidenceContentHash: '',
              statusCode: null,
              elapsedMs: 0,
              extracted: {},
            }
          }
          throw error
        }
      }),
    },
    design: {
      readDocument: (path) => guarded(() => readDesignDocument(path, undefined, workspacePath)),
    },
  }
}

export const desktopAgentEnvironment: AgentEnvironment = createDesktopAgentEnvironment()
