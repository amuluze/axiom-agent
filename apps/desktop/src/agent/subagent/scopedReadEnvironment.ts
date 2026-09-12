import type { AgentEnvironment, AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'
import { AgentEnvironmentError as EnvError } from '@/agent/environment/AgentEnvironment'
import type {
  AuthorizedReadFile,
  AuthorizedTextContent,
  WorkspaceFindResult,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
} from '@/agent/environment/AgentEnvironment'

/**
 * scope 是运行时强制边界：不能只把范围写进提示词，子环境必须拒绝范围外读取。
 *
 * 职责划分：TS facade 强制 scope；Rust workspace 边界继续强制父工作区授权。
 * scope 只能收窄父授权，不能扩大。
 */

/** 规范化单个相对路径：拒绝绝对路径、`..`、NUL、Windows 盘符、空项，移除 `.` 与尾随 `/`。 */
export const normalizeScopeEntry = (path: string): string | null => {
  if (!path) return null
  if (path.startsWith('/')) return null
  if (/^[a-z]:[\\/]/iu.test(path)) return null
  if (path.includes('\0')) return null
  const parts = path.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.some((part) => part === '..')) return null
  const normalized = parts.join('/')
  // `.`/`./` 规范化为空串：不是合法 scope entry，fail-closed 拒绝。若返回空串，
  // 会绕过四个内置委派工具的「任一条目非法即整体拒绝」防线（validate 只拦 null、
  // execute 纵深防御不触发），并让 scopedReadEnvironment 把 scope 静默降级为全工作区。
  return normalized.length > 0 ? normalized : null
}

/** 规范化 scope 清单：去重、排序。非法项保持不在 scope（fail-closed 拒绝访问）。 */
export const normalizeScope = (scope: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of scope) {
    const normalized = normalizeScopeEntry(entry)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result.sort()
}

/**
 * 相对路径是否落在 scope 内。空 scope 表示允许整个已授权工作区。
 * 前缀碰撞（`src/a` vs `src/ab`）用 `entry + '/'` 边界防止误放行。
 */
export const pathWithinScope = (relativePath: string, scope: string[]): boolean => {
  if (scope.length === 0) return true
  const normalized = normalizeScopeEntry(relativePath)
  if (!normalized) return false
  return scope.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`))
}

const outOfScope = (what: string): AgentEnvironmentError =>
  new EnvError('not_authorized', `路径不在 Explore 范围内：${what}`)

/**
 * 创建只读 facade：包裹父工作区 environment，强制 scope 边界。
 * 写/命令/审批相关能力在结构上不可用（直接抛错），authorizedFiles 绝对读取始终拒绝。
 */
export const createScopedReadEnvironment = (
  base: AgentEnvironment,
  scope: string[],
): AgentEnvironment => {
  const normalizedScope = normalizeScope(scope)

  const assertInScope = (relativePath: string): void => {
    if (!pathWithinScope(relativePath, normalizedScope)) throw outOfScope(relativePath)
  }

  const filterResults = <T extends { path: string }>(entries: T[]): T[] =>
    entries.filter((entry) => pathWithinScope(entry.path, normalizedScope))

  return {
    runtime: base.runtime,
    authorizedFiles: {
      // 不泄露工作区外绝对授权文件清单。
      list: async (): Promise<AuthorizedReadFile[]> => [],
      // 禁止读工作区外绝对授权文件。
      readText: async (): Promise<AuthorizedTextContent> => {
        throw outOfScope('authorizedFiles.readText')
      },
    },
    workspace: {
      list: async (path?: string, limit?: number): Promise<WorkspaceListResult> => {
        if (path !== undefined) assertInScope(path)
        const result = await base.workspace.list(path, limit)
        if (!pathWithinScope(result.directory, normalizedScope)) throw outOfScope(result.directory)
        return { ...result, entries: filterResults(result.entries) }
      },
      readText: async (
        path: string,
        offset?: number,
        limit?: number,
      ): Promise<WorkspaceReadResult> => {
        assertInScope(path)
        const result = await base.workspace.readText(path, offset, limit)
        if (!pathWithinScope(result.path, normalizedScope)) throw outOfScope(result.path)
        return result
      },
      searchText: async (
        request: WorkspaceSearchRequest,
        signal: AbortSignal,
      ): Promise<WorkspaceSearchResult> => {
        if (request.path !== undefined) assertInScope(request.path)
        const result = await base.workspace.searchText(request, signal)
        return { ...result, matches: filterResults(result.matches) }
      },
      find: async (request: {
        requestId: string
        pattern: string
        path?: string
        limit?: number
        signal: AbortSignal
      }): Promise<WorkspaceFindResult> => {
        // workspace.find 只接受单个 path（无 roots 语义）：path 必须落在 scope 内，多根请求由调用方拒绝。
        if (request.path !== undefined) assertInScope(request.path)
        const result = await base.workspace.find(request)
        if (!pathWithinScope(result.rootPath, normalizedScope)) throw outOfScope(result.rootPath)
        return { ...result, matches: filterResults(result.matches) }
      },
      createTextFile: async (): Promise<never> => {
        throw outOfScope('createTextFile')
      },
      editTextFile: async (): Promise<never> => {
        throw outOfScope('editTextFile')
      },
      applyChanges: async (): Promise<never> => {
        throw outOfScope('applyChanges')
      },
      restoreTrash: async (): Promise<never> => {
        throw outOfScope('restoreTrash')
      },
      runCommand: async (): Promise<never> => {
        throw outOfScope('runCommand')
      },
    },
    artifacts: {
      // 子 Agent 中间 ToolResult 不外化 Artifact（无 child externalizer）；
      // 仅最终父 ToolResult 可走父 externalizeToolResult。这里封死，纵深防御。
      writeToolResult: async (): Promise<never> => {
        throw outOfScope('writeToolResult')
      },
    },
    // web 只读能力直接透传父 environment：目标空间是公网而非工作区，没有
    // scope 可收窄；公网主机校验/体积上限由 Rust 权威执行，与主 Agent 同一策略。
    web: base.web,
    // 浏览器不透传：browser 是主 Agent 专用的有状态交互通道（tab/焦点/输入
    // 都跨调用共享），只读子 Agent 共享会互相踩踏会话状态（对齐 ZCode 的
    // main-agent-only Browser Use 边界）。结构性封死而非省略字段。
    browser: {
      command: async (): Promise<never> => {
        throw outOfScope('browser.command')
      },
    },
    // 电脑控制不透传：computer 操作的是真用户桌面（登录态、真实数据），
    // 爆炸半径远大于隔离 profile 的浏览器；子 Agent 不得代主 Agent 注入输入。
    computer: {
      command: async (): Promise<never> => {
        throw outOfScope('computer.command')
      },
    },
    // SSH 远程执行不透传：目标是用户新凭据可达的真实远程主机（生产环境），
    // 属主 Agent 专用的特权通道；审批与「会话内允许」授权也按主 Agent 会话
    // 锚定，子 Agent 无法也不应共享。
    ssh: {
      command: async (): Promise<never> => {
        throw outOfScope('ssh.command')
      },
    },
  }
}
