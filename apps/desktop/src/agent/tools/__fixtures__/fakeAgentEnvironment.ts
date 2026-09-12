import { vi } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import type {
  WorkspaceChangeOperation,
  WorkspaceChangeRequest,
  WorkspaceChangeResult,
  WorkspaceFindResult,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
} from '@/platform/workspace'
import type { AuthorizedTextContent } from '@/platform/authorizedFiles'
import type { ArtifactReference } from '@/agent/core/types'
import type {
  BrowserCommandRequest,
  BrowserCommandResponse,
} from '@/platform/browserSession'
import type {
  ComputerCommandRequest,
  ComputerCommandResponse,
} from '@/platform/computerSession'
import type {
  SshAgentCommandRequest,
  SshAgentCommandResponse,
} from '@/platform/sshAgent'
import type { WebFetchResponse, WebSearchResponse } from '@/platform/webAccess'

/**
 * In-process AgentEnvironment for tests that exercise the execute() path
 * without spinning up Tauri / Rust. Every workspace primitive is overridable
 * per-test; the defaults return a sensible empty/success shape so the type
 * is satisfied and existing write-tool tests are unaffected.
 *
 * Modes:
 *  - 'success': returns a synthetic WorkspaceChangeResult. The fixture's
 *    applyChanges / restoreTrash can be overridden per-test to throw, to
 *    trigger an abort-after-resolve, or to return a custom result.
 *  - 'throw': the configured method rejects with the provided error before
 *    resolving. Use this to confirm `execute()` re-throws environment
 *    errors verbatim so the Runtime can mark the result as `isError`.
 *
 * Read-tool overrides (list/readText/searchText/find) default to empty
 * results so `read`/`ls`/`grep`/`find` execute paths can be tested by
 * injecting the matching Workspace*Result shape.
 */
export interface FakeAgentEnvironmentOptions {
  workspacePath?: string
  workspaceName?: string
  applyChanges?: (request: WorkspaceChangeRequest, approvalLease: string) => Promise<WorkspaceChangeResult>
  restoreTrash?: (recoveryId: string, approvalLease: string) => Promise<WorkspaceChangeResult>
  list?: (path?: string, limit?: number) => Promise<WorkspaceListResult>
  readText?: (path: string, offset?: number, limit?: number) => Promise<WorkspaceReadResult>
  searchText?: (request: WorkspaceSearchRequest, signal: AbortSignal) => Promise<WorkspaceSearchResult>
  find?: (request: { requestId: string; pattern: string; path?: string; limit?: number; signal: AbortSignal }) => Promise<WorkspaceFindResult>
  authorizedReadText?: (path: string) => Promise<AuthorizedTextContent>
  webSearch?: (request: { query: string; limit?: number }) => Promise<WebSearchResponse>
  webFetch?: (request: { url: string; maxBytes?: number }) => Promise<WebFetchResponse>
  browserCommand?: (request: BrowserCommandRequest) => Promise<BrowserCommandResponse>
  computerCommand?: (request: ComputerCommandRequest) => Promise<ComputerCommandResponse>
  sshAgentCommand?: (
    request: SshAgentCommandRequest,
    options?: { approvalLease?: string; workspacePath?: string },
  ) => Promise<SshAgentCommandResponse>
}

const defaultWorkspace = (path = '/workspace/repo', name = 'repo') => ({
  path,
  name,
  gitBranch: 'main',
})

const noopArtifact = (): ArtifactReference => ({
  id: 'artifact-test',
  kind: 'text',
  mediaType: 'application/json',
  relativePath: 'artifacts/apply-changes/test.json',
  contentHash: 'a'.repeat(64),
  sizeBytes: 0,
  createdAt: 0,
})

/**
 * Build a successful WorkspaceChangeResult that exercises every field the
 * tool layer is expected to thread through to the model-facing `details`
 * payload and the audit/artifact boundaries.
 */
export const buildSuccessResult = (
  request: WorkspaceChangeRequest,
  options: {
    includeArtifact?: boolean
    includeRecoveryId?: boolean
    recoveryId?: string
  } = {},
): WorkspaceChangeResult => {
  const { includeArtifact = true, includeRecoveryId = false, recoveryId } = options
  const summary = request.operations.map((operation: WorkspaceChangeOperation) => ({
    operation: operation.type,
    path: operation.type === 'move' ? operation.from : operation.path,
    ...(operation.type === 'move' ? { destination: operation.to } : {}),
    sha256: 'b'.repeat(64),
  }))
  const result: WorkspaceChangeResult = {
    workspace: defaultWorkspace(),
    requestId: request.requestId,
    changes: summary,
  }
  if (includeArtifact) result.auditArtifact = noopArtifact()
  if (includeRecoveryId) result.recoveryId = recoveryId ?? 'recovery-test-1'
  return result
}

export const createFakeAgentEnvironment = (
  options: FakeAgentEnvironmentOptions = {},
): AgentEnvironment => {
  const applyChanges = options.applyChanges
    ?? (async (request: WorkspaceChangeRequest, _lease: string) =>
      buildSuccessResult(request))
  const restoreTrash = options.restoreTrash
    ?? (async (recoveryId: string, _lease: string) => ({
      workspace: defaultWorkspace(),
      requestId: `restore-${recoveryId}`,
      changes: [
        { operation: 'restore' as const, path: 'src/main.ts', sha256: 'c'.repeat(64) },
      ],
    }))
  // Read primitives default to empty shapes; per-test overrides inject the
  // Workspace*Result the tool is expected to thread through. Defaulting to
  // success (rather than throwing) keeps existing write-tool tests working
  // and lets read-tool tests opt in via the option.
  const list = options.list
    ?? (async () => ({ workspace: defaultWorkspace(), directory: '.', entries: [], truncated: false }))
  const readText = options.readText
    ?? (async () => ({
      workspace: defaultWorkspace(),
      path: 'src/empty.txt',
      content: '',
      sha256: 'e'.repeat(64),
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
      nextOffset: undefined,
    }))
  const searchText = options.searchText
    ?? (async () => ({ workspace: defaultWorkspace(), matches: [], truncated: false }))
  const find = options.find
    ?? (async () => ({ workspace: defaultWorkspace(), pattern: '*', rootPath: '.', matches: [], truncated: false }))
  const authorizedReadText = options.authorizedReadText
    ?? (async () => { throw new Error('authorizedFiles.readText not used in this fixture') })
  // web 只读原语与 workspace 读原语同约定：默认空结果，按测试注入。
  const webSearch = options.webSearch
    ?? (async () => ({ query: '', results: [] }))
  const webFetch = options.webFetch
    ?? (async () => ({
      url: '',
      status: 200,
      contentType: 'text/plain',
      content: '',
      truncated: false,
      fetchedBytes: 0,
    }))
  // browser 原语默认返回最小成功形态（done），按测试注入具体响应。
  const browserCommand = options.browserCommand
    ?? (async () => ({ type: 'done' }) as BrowserCommandResponse)
  // computer 原语同款默认 done。
  const computerCommand = options.computerCommand
    ?? (async () => ({ type: 'done' }) as ComputerCommandResponse)
  // ssh 原语默认返回空主机清单（只读工具的最小成功形态）。
  const sshAgentCommand = options.sshAgentCommand
    ?? (async () => ({ type: 'hosts', hosts: [] }) as SshAgentCommandResponse)

  return {
    runtime: {
      getInfo: vi.fn(async () => ({
        appName: 'Axiom',
        appVersion: '0.0.0-test',
        operatingSystem: 'macos',
        architecture: 'arm64',
      })),
    },
    authorizedFiles: {
      list: vi.fn(async () => []),
      readText: vi.fn(async (path: string) => authorizedReadText(path)),
    },
    workspace: {
      list: vi.fn(async (path?: string, limit?: number) => list(path, limit)),
      readText: vi.fn(async (path: string, offset?: number, limit?: number) =>
        readText(path, offset, limit)),
      searchText: vi.fn(async (request: WorkspaceSearchRequest, signal: AbortSignal) =>
        searchText(request, signal)),
      createTextFile: vi.fn(async () => {
        throw new Error('workspace.createTextFile not used in this fixture')
      }),
      editTextFile: vi.fn(async () => {
        throw new Error('workspace.editTextFile not used in this fixture')
      }),
      applyChanges: vi.fn(async (request: WorkspaceChangeRequest, lease: string) =>
        applyChanges(request, lease)),
      restoreTrash: vi.fn(async (recoveryId: string, lease: string) =>
        restoreTrash(recoveryId, lease)),
      runCommand: vi.fn(async () => {
        throw new Error('workspace.runCommand not used in this fixture')
      }),
      find: vi.fn(async (request: { requestId: string; pattern: string; path?: string; limit?: number; signal: AbortSignal }) =>
        find(request)),
    },
    artifacts: {
      writeToolResult: vi.fn(async () => noopArtifact()),
    },
    web: {
      search: vi.fn(async (request: { query: string; limit?: number }) => webSearch(request)),
      fetch: vi.fn(async (request: { url: string; maxBytes?: number }) => webFetch(request)),
    },
    browser: {
      command: vi.fn(async (request: BrowserCommandRequest) => browserCommand(request)),
    },
    computer: {
      command: vi.fn(async (request: ComputerCommandRequest) => computerCommand(request)),
    },
    ssh: {
      command: vi.fn(
        async (
          request: SshAgentCommandRequest,
          options?: { approvalLease?: string; workspacePath?: string },
        ) => sshAgentCommand(request, options),
      ),
    },
  }
}