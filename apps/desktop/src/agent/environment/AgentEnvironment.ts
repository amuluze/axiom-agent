import type { ToolApprovalScope } from '@/agent/core/approvalScope'
import type { ToolResultArtifactRequest, ArtifactReference } from '@/agent/core/types'
import type { ApiStepSpec } from '@/agent/testing/spec/types'
import type { ApiTestStepResult } from '@/platform/apiTestAutomation'
import type { ImageArtifactRequest } from '@/platform/artifacts'
import type { AuthorizedReadFile, AuthorizedTextContent } from '@/platform/authorizedFiles'
import type {
  BrowserCommandRequest,
  BrowserCommandResponse,
  BrowserTabInfo,
  BrowserWriteCommandRequest,
  LocatorCandidate,
  LocatorResolution,
  UiLocatorSpec,
} from '@/platform/browserSession'
import type { DesignDocumentContent } from '@/platform/designDocument'
import type { RuntimeInfo } from '@/platform/runtimeInfo'
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
  ApiTestStepResult,
  AuthorizedReadFile,
  AuthorizedTextContent,
  BrowserCommandRequest,
  BrowserCommandResponse,
  BrowserTabInfo,
  DesignDocumentContent,
  ImageArtifactRequest,
  LocatorCandidate,
  LocatorResolution,
  RuntimeInfo,
  UiLocatorSpec,
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
  | 'not_found'
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
 * 只读探索通道可用的动作子集（G1-2）。导航/点击/输入/坐标手势等写动作**不在**联合里，
 * 因此 Agent 层结构上无法经本通道改动页面——「只读」是由类型强制的边界，而不只是约定。
 * 页面写动作在 {@link BrowserWriteCommandRequest}（G1-3 另开的 `browser.write` 通道，
 * 逐次审批）：本通道永不扩张。
 */
export type BrowserReadCommandRequest =
  | { action: 'tabs' }
  | { action: 'snapshot'; tabId: string }
  | { action: 'screenshot'; tabId: string; ref?: number }
  | { action: 'find'; tabId: string; text: string; limit?: number }
  | { action: 'wait'; tabId: string; durationMs?: number; text?: string }
  | { action: 'resolveLocator'; tabId: string; locator: UiLocatorSpec }

/**
 * 写入探索通道可用的动作子集（G1-3）。与 {@link BrowserReadCommandRequest} **分列**：
 * 只读路径（`browser.command`）结构上看不到这些动作，写路径（`browser.write`）也
 * 只能发出这些动作——「哪些动作会改页面」由类型而非约定强制。
 *
 * 定义在 `@/platform/browserSession`（从宿主请求联合 `Extract` 出写动作变体，与 Rust
 * 逐字段同步是结构性的），此处只做 type-only 再导出，让工具层无需直接依赖 platform。
 * 每个动作都对应宿主 `browser_command` 既有变体（navigate/click/fill/selectOption/
 * typeText/press），不新增 Rust 能力。由 `scopeAgentEnvironment` 按 `ui-test:write`
 * 门控；每个工具另有 Agent 层的 `requiresApproval` 逐次审批；子代理环境结构性无此通道。
 *
 * `ref` 是宿主定位解析签发的 backend node ref（整数 ≥1），**只在当前步骤内有效**：
 * 任何写动作完成后旧 ref 立即作废，下一步必须重新快照/重新解析。
 */
export type { BrowserWriteCommandRequest }

/**
 * 一次 API 测试步骤的执行请求（G1-4 探索工具的宿主输入）。字段与 Rust
 * `ApiTestStepRequest` 逐字段对应：`runId`/`stepId` 是租约绑定与取消的键，
 * `environmentId` 省略时宿主按「无环境」处理（不注入环境 Header、不授权任何
 * Secret、不允许回环/私网），`step` 是 `api.request` 步骤本身。
 *
 * 这里是**复用** A1 Rust Driver 的接缝：不新增 Rust 命令，也不在 Agent 层实现第二套
 * HTTP 客户端；网络策略、Secret 注入、脱敏证据全部由 Rust 权威执行。
 */
export interface ApiTestStepRequest {
  runId: string
  stepId: string
  environmentId?: string
  step: ApiStepSpec
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
    createTextFile(path: string, content: string, approvalLease: string, scope?: ToolApprovalScope): Promise<WorkspaceWriteResult>
    editTextFile(path: string, edits: WorkspaceEditOp[], approvalLease: string, scope?: ToolApprovalScope): Promise<WorkspaceWriteResult>
    applyChanges(request: WorkspaceChangeRequest, approvalLease: string, scope?: ToolApprovalScope): Promise<WorkspaceChangeResult>
    restoreTrash(recoveryId: string, approvalLease: string, scope?: ToolApprovalScope): Promise<WorkspaceChangeResult>
    runCommand(
      request: WorkspaceCommandRequest,
      signal: AbortSignal,
      onProgress: ((progress: WorkspaceCommandProgress) => void) | undefined,
      approvalLease: string,
      scope?: ToolApprovalScope,
    ): Promise<WorkspaceCommandResult>
    find(request: { requestId: string; pattern: string; path?: string; limit?: number; maxDepth?: number; signal: AbortSignal }): Promise<WorkspaceFindResult>
  }
  artifacts: {
    writeToolResult(request: ToolResultArtifactRequest): Promise<ArtifactReference>
    /**
     * 图片 Artifact 写入口（F0-2 平台层 `writeImageArtifact` 的 Agent 面）。
     * 图片魔数仍由 Rust `validate_media` 权威校验，这里只做格式/体积快速失败。
     * 子代理环境（`scopedReadEnvironment`）封死本方法——只读委派不得写 Artifact。
     */
    writeImage(request: ImageArtifactRequest): Promise<ArtifactReference>
  }
  /**
   * 只读浏览器通道（`ui_snapshot` / `ui_find` / `ui_wait` / `ui_assert` / `ui_screenshot`）。
   *
   * 类型化转发宿主 `browser_command` 的**只读动作子集**（{@link BrowserReadCommandRequest}）：
   * 可执行文件 allowlist、隔离 profile、回环 CDP、URL/输出上限与页面访问全部由 Rust
   * 权威执行，本通道不新增能力。由 `scopeAgentEnvironment` 按 `ui-test:read` 门控；
   * 子代理环境结构性无此通道。
   */
  browser: {
    command(request: BrowserReadCommandRequest): Promise<BrowserCommandResponse>
    /**
     * UI 写探索通道（`ui_navigate` / `ui_click` / `ui_input` / `ui_select` / `ui_press`）。
     *
     * 类型化转发宿主 `browser_command` 的**写动作子集**（{@link BrowserWriteCommandRequest}）：
     * URL/输出上限、隔离 profile、回环 CDP 全部由 Rust 权威执行，本通道不新增能力。
     * 由 `scopeAgentEnvironment` 按 `ui-test:write` 门控（与只读通道的 `ui-test:read`
     * 分列）；每个写工具另有 Agent 层逐次审批；子代理环境结构性无此通道。
     */
    write(request: BrowserWriteCommandRequest): Promise<BrowserCommandResponse>
  }
  /**
   * API 测试步骤通道（`api_request` 工具）。复用 A1 Rust Driver：宿主内签发一次性
   * 租约 → 运行步骤 → 运行期取消（abort 时按 runId 主动取消宿主请求），本通道不新增
   * Rust 能力，也不让 Agent 层接触 `@/platform/*`。
   *
   * 网络策略（公网 HTTPS 允许、公网明文 HTTP 恒拒、回环/私网需测试环境显式授权）、
   * Secret 注入与脱敏证据都由 Rust 权威执行；本通道只是把「发一个 API 测试步骤」这件事
   * 接到既有 Driver 上。由 `scopeAgentEnvironment` 按 `api-test:request` 门控；
   * 子代理环境结构性无此通道（设计 §14：子代理不可达 API 出网）。
   */
  api: {
    runStep(request: ApiTestStepRequest, signal: AbortSignal): Promise<ApiTestStepResult>
  }
  /**
   * `.pen` 设计稿读取（design_query 工具的宿主能力）。走 Rust read_design_document
   * 通道（8MiB / base64+sha256），绕开 workspace.readText 的 128KiB 输出截断。
   */
  design: {
    readDocument(path: string): Promise<DesignDocumentContent>
  }
}
