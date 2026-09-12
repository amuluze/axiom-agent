import type { ToolResultArtifactRequest, ArtifactReference } from '@/agent/core/types'
import type { AuthorizedReadFile, AuthorizedTextContent } from '@/platform/authorizedFiles'
import type { RuntimeInfo } from '@/platform/runtimeInfo'
import type {
  BrowserCommandRequest,
  BrowserCommandResponse,
  BrowserTabInfo,
} from '@/platform/browserSession'
import type {
  ComputerCommandRequest,
  ComputerCommandResponse,
} from '@/platform/computerSession'
import type {
  SshAgentCommandRequest,
  SshAgentCommandResponse,
  SshAgentHost,
} from '@/platform/sshAgent'
import type { WebFetchResponse, WebSearchResponse } from '@/platform/webAccess'
import type {
  WorkspaceChangeOperation,
  WorkspaceChangeRequest,
  WorkspaceChangeResult,
  WorkspaceEditOp,
  WorkspaceFindResult,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
  WorkspaceWriteResult,
} from '@/platform/workspace'
import type {
  WorkspaceCommandProgress,
  WorkspaceCommandRequest,
  WorkspaceCommandResult,
} from '@/platform/workspaceCommand'

/**
 * Re-exported so the Agent tool layer can depend solely on the
 * `AgentEnvironment` abstraction without importing `@/platform/*` directly.
 * Tools consume these types via `import type { ... } from '@/agent/environment/AgentEnvironment'`.
 */
export type {
  AuthorizedReadFile,
  AuthorizedTextContent,
  BrowserCommandRequest,
  BrowserCommandResponse,
  BrowserTabInfo,
  ComputerCommandRequest,
  ComputerCommandResponse,
  RuntimeInfo,
  SshAgentCommandRequest,
  SshAgentCommandResponse,
  SshAgentHost,
  WebFetchResponse,
  WebSearchResponse,
  WorkspaceChangeOperation,
  WorkspaceChangeRequest,
  WorkspaceChangeResult,
  WorkspaceCommandProgress,
  WorkspaceCommandRequest,
  WorkspaceCommandResult,
  WorkspaceEditOp,
  WorkspaceFindResult,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
  WorkspaceWriteResult,
}

export type AgentEnvironmentErrorCode =
  | 'aborted'
  | 'not_authorized'
  | 'invalid_path'
  | 'timeout'
  | 'conflict'
  | 'unavailable'
  | 'unknown'

export class AgentEnvironmentError extends Error {
  constructor(
    public readonly code: AgentEnvironmentErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AgentEnvironmentError'
  }
}

/**
 * Capability-scoped host boundary for the Agent Runtime. It deliberately does
 * not expose Tauri invoke, absolute-path filesystem access, or a shell string.
 */
export interface AgentEnvironment {
  runtime: {
    getInfo(): Promise<RuntimeInfo>
  }
  authorizedFiles: {
    list(): Promise<AuthorizedReadFile[]>
    readText(path: string): Promise<AuthorizedTextContent>
  }
  workspace: {
    list(path?: string, limit?: number): Promise<WorkspaceListResult>
    readText(path: string, offset?: number, limit?: number): Promise<WorkspaceReadResult>
    searchText(request: WorkspaceSearchRequest, signal: AbortSignal): Promise<WorkspaceSearchResult>
    createTextFile(path: string, content: string, approvalLease: string): Promise<WorkspaceWriteResult>
    editTextFile(path: string, edits: WorkspaceEditOp[], approvalLease: string): Promise<WorkspaceWriteResult>
    applyChanges(request: WorkspaceChangeRequest, approvalLease: string): Promise<WorkspaceChangeResult>
    restoreTrash(recoveryId: string, approvalLease: string): Promise<WorkspaceChangeResult>
    runCommand(
      request: WorkspaceCommandRequest,
      signal: AbortSignal,
      onProgress: ((progress: WorkspaceCommandProgress) => void) | undefined,
      approvalLease: string,
    ): Promise<WorkspaceCommandResult>
    find(request: { requestId: string; pattern: string; path?: string; limit?: number; signal: AbortSignal }): Promise<WorkspaceFindResult>
  }
  artifacts: {
    writeToolResult(request: ToolResultArtifactRequest): Promise<ArtifactReference>
  }
  /**
   * web 只读访问（web_search / web_fetch 工具的宿主能力）。公网主机校验、
   * 体积/输出上限与 HTML 转文本由 Rust 权威执行；未授予 web:read 能力的
   * 会话不会注册对应工具，本节方法只服务已授权会话。
   */
  web: {
    search(request: { query: string; limit?: number }): Promise<WebSearchResponse>
    fetch(request: { url: string; maxBytes?: number }): Promise<WebFetchResponse>
  }
  /**
   * 浏览器自动化（browser 工具的宿主能力）。可执行文件 allowlist、隔离
   * profile、回环 CDP、URL/输出上限由 Rust 权威执行；主 Agent 专用——
   * 只读子 Agent 的 scoped environment 不透传本节（有状态交互通道不共享）。
   */
  browser: {
    command(request: BrowserCommandRequest): Promise<BrowserCommandResponse>
  }
  /**
   * 电脑控制（computer 工具的宿主能力）。macOS 双权限、会话级门 + 应用
   * allowlist、kill switch 由 Rust 权威执行；主 Agent 专用——只读子 Agent
   * 的 scoped environment 结构性封死本节（真用户桌面的爆炸半径远大于浏览器）。
   */
  computer: {
    command(request: ComputerCommandRequest): Promise<ComputerCommandResponse>
  }
  /**
   * SSH 远程执行（ssh / ssh_hosts 工具的宿主能力）。主机门禁（只接受 config
   * 别名/注册表 hostId）、lease 绑定 {host, command}、首连原生三选一审批与会话
   * 授权表、超时与输出上限由 Rust 权威执行；凭据（私钥/密码）不进入模型上下文。
   * 主 Agent 专用——只读子 Agent 的 scoped environment 结构性封死本节（真实
   * 远程主机的特权通道不共享）。
   */
  ssh: {
    command(
      request: SshAgentCommandRequest,
      options?: { approvalLease?: string; workspacePath?: string },
    ): Promise<SshAgentCommandResponse>
  }
}
