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
  if (path.startsWith('/') || path.includes('\\')) return null
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


export const normalizeScope = (scope: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of scope) {
    const normalized = normalizeScopeEntry(entry)
    if (!normalized) throw outOfScope(entry)
    if (seen.has(normalized)) continue
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
  if (scope.length === 0 && ['', '.', './'].includes(relativePath)) return true
  const normalized = normalizeScopeEntry(relativePath)
  if (!normalized) return false
  if (scope.length === 0) return true
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
  options: { allowedToolNames: readonly string[]; signal: AbortSignal },
): AgentEnvironment => {
  options = { ...options, allowedToolNames: [...options.allowedToolNames] }
  const normalizedScope = normalizeScope(scope)
  const assertLive = (): void => {
    if (options.signal.aborted) throw new EnvError('aborted', '子任务已取消')
  }
  const gate = <Args extends unknown[], Result>(
    name: string,
    operation: (...args: Args) => Promise<Result>,
  ) => async (...args: Args): Promise<Result> => {
    assertLive()
    if (!options.allowedToolNames.includes(name)) throw outOfScope(name)
    const result = await operation(...args)
    assertLive()
    return result
  }
  const queryPath = (path?: string): string | undefined => {
    if (path !== undefined && !['', '.', './'].includes(path)) {
      assertInScope(path)
      return path
    }
    if (normalizedScope.length === 0) return path
    if (normalizedScope.length === 1) return normalizedScope[0]
    throw outOfScope(`请指定一个委托路径：${normalizedScope.join(', ')}`)
  }

  const assertInScope = (relativePath: string): void => {
    if (!pathWithinScope(relativePath, normalizedScope)) throw outOfScope(relativePath)
  }

  const filterResults = <T extends { path: string }>(entries: T[]): T[] =>
    entries.filter((entry) => pathWithinScope(entry.path, normalizedScope))

  return {
    runtime: { getInfo: async (): Promise<never> => { throw outOfScope('runtime.getInfo') } },
    authorizedFiles: {
      // 不泄露工作区外绝对授权文件清单。
      list: async (): Promise<AuthorizedReadFile[]> => [],
      // 禁止读工作区外绝对授权文件。
      readText: async (): Promise<AuthorizedTextContent> => {
        throw outOfScope('authorizedFiles.readText')
      },
    },
    workspace: {
      list: gate('ls', async (path?: string, limit?: number): Promise<WorkspaceListResult> => {
        path = queryPath(path)
        const result = await base.workspace.list(path, limit)
        if (!pathWithinScope(result.directory, normalizedScope)) throw outOfScope(result.directory)
        return { ...result, entries: filterResults(result.entries) }
      }),
      readText: gate('read', async (
        path: string,
        offset?: number,
        limit?: number,
      ): Promise<WorkspaceReadResult> => {
        assertInScope(path)
        const result = await base.workspace.readText(path, offset, limit)
        if (!pathWithinScope(result.path, normalizedScope)) throw outOfScope(result.path)
        return result
      }),
      searchText: gate('grep', async (
        request: WorkspaceSearchRequest,
        signal: AbortSignal,
      ): Promise<WorkspaceSearchResult> => {
        const path = queryPath(request.path)
        const result = await base.workspace.searchText({ ...request, path }, signal)
        return { ...result, matches: filterResults(result.matches) }
      }),
      find: gate('find', async (request: {
        requestId: string
        pattern: string
        path?: string
        limit?: number
        maxDepth?: number
        signal: AbortSignal
      }): Promise<WorkspaceFindResult> => {
        // workspace.find 只接受单个 path（无 roots 语义）：path 必须落在 scope 内，多根请求由调用方拒绝。
        const path = queryPath(request.path)
        const result = await base.workspace.find({ ...request, path })
        if (!pathWithinScope(result.rootPath, normalizedScope)) throw outOfScope(result.rootPath)
        return { ...result, matches: filterResults(result.matches) }
      }),
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
      writeImage: async (): Promise<never> => {
        throw outOfScope('writeImage')
      },
    },
    // UI 探索通道对子代理结构性不可达：子代理无 ui-test:read / ui-test:write 授权，
    // 也不得观测/控制页面（设计 §14「子代理不可达 UI 控制和 API 出网」）。读、写
    // 两条通道都显式封死，与父会话能力门是两道独立防线。
    browser: {
      command: async (): Promise<never> => {
        throw outOfScope('browser.command')
      },
      write: async (): Promise<never> => {
        throw outOfScope('browser.write')
      },
    },
    // 设计稿读取不透传：scoped 子 Agent 的职责是限定范围内的文本/结构检索，
    // .pen 二进制设计稿查询是主 Agent 设计工作流的专用能力，保持收窄。
    design: {
      readDocument: async (): Promise<never> => {
        throw outOfScope('design.readDocument')
      },
    },
    // API 出网对子代理结构性不可达：子代理无 api-test:request 授权，也不得让外网请求
    // 由委派会话发起（设计 §14「子代理不可达 UI 控制和 API 出网」）。显式封死，
    // 与父会话能力门是两道独立防线。
    api: {
      runStep: async (): Promise<never> => {
        throw outOfScope('api.runStep')
      },
    },
  }
}
