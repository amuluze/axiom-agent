import { isTauriRuntime } from '@/platform/environment'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import type { StoredAgentSession } from '@/persistence/types'

const SESSION_METADATA_STORAGE_KEY = 'axiom.session.metadata.v1'

export interface SessionMetadata {
  workspace: AuthorizedWorkspace | null
  archivedAt: number | null
}

export type SessionMetadataById = Record<string, SessionMetadata>

const loadSessionMetadata = (): SessionMetadataById => {
  if (!isTauriRuntime()) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_METADATA_STORAGE_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const metadata: SessionMetadataById = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const candidate = value as Partial<SessionMetadata>
      // workspace 与 archivedAt 独立校验：任一字段不合法只丢弃该字段，
      // 避免旧 localStorage 条目因 workspace 形状异常而连带丢失 archivedAt。
      let workspace: AuthorizedWorkspace | null = null
      const rawWorkspace = candidate.workspace
      if (rawWorkspace !== null && rawWorkspace !== undefined) {
        const validWorkspace = typeof rawWorkspace.path === 'string' && rawWorkspace.path
          && typeof rawWorkspace.name === 'string' && rawWorkspace.name
          && (rawWorkspace.gitBranch === undefined
            || rawWorkspace.gitBranch === null
            || typeof rawWorkspace.gitBranch === 'string')
        if (validWorkspace) workspace = structuredClone(rawWorkspace)
      }
      let archivedAt: number | null = null
      if (candidate.archivedAt !== null && candidate.archivedAt !== undefined) {
        if (typeof candidate.archivedAt === 'number' && Number.isFinite(candidate.archivedAt)) {
          archivedAt = candidate.archivedAt
        }
      }
      metadata[sessionId] = { workspace, archivedAt }
    }
    return metadata
  } catch {
    return {}
  }
}

/**
 * 模块级可变单例:Session 元数据缓存。
 *
 * 通过 ES module live binding 导出,store action 中对它的直接读取
 * (`sessionMetadataById[id]?.workspace`)始终指向同一可变引用,
 * 与提取前在 agentStore 内的行为完全一致。
 */
export let sessionMetadataById = loadSessionMetadata()

const persistSessionMetadata = (): void => {
  if (isTauriRuntime()) {
    localStorage.setItem(SESSION_METADATA_STORAGE_KEY, JSON.stringify(sessionMetadataById))
  }
}

export const updateSessionMetadata = (
  sessionId: string,
  update: Partial<SessionMetadata>,
): SessionMetadata => {
  const previous = sessionMetadataById[sessionId] ?? { workspace: null, archivedAt: null }
  const next = {
    workspace: update.workspace === undefined ? previous.workspace : structuredClone(update.workspace),
    archivedAt: update.archivedAt === undefined ? previous.archivedAt : update.archivedAt,
  }
  sessionMetadataById = { ...sessionMetadataById, [sessionId]: next }
  persistSessionMetadata()
  return next
}

export const removeSessionMetadata = (sessionId: string): void => {
  if (!(sessionId in sessionMetadataById)) return
  const next = { ...sessionMetadataById }
  delete next[sessionId]
  sessionMetadataById = next
  persistSessionMetadata()
}

export const removeWorkspaceSessionMetadata = (path: string): void => {
  let changed = false
  const next = Object.fromEntries(Object.entries(sessionMetadataById).map(([sessionId, metadata]) => {
    if (metadata.workspace?.path !== path) return [sessionId, metadata]
    changed = true
    return [sessionId, { ...metadata, workspace: null }]
  }))
  if (!changed) return
  sessionMetadataById = next
  persistSessionMetadata()
}

/**
 * 按 sessionId 列表清空对应 session 元数据中的 workspace 字段。
 * 用于撤销工作目录时由 store 直接传入受影响 session 列表（来自
 * state.sessions），绕开 path 字符串精确比对；避免 localStorage
 * 残留 workspace 字段导致重启后 restoreAuthorizedWorkspaces
 * 重新把已撤销路径注入 authorizedWorkspaces。
 */
export const removeWorkspaceSessionMetadataForSessions = (sessionIds: string[]): void => {
  if (sessionIds.length === 0) return
  const idSet = new Set(sessionIds)
  let changed = false
  const next = Object.fromEntries(Object.entries(sessionMetadataById).map(([sessionId, metadata]) => {
    if (!idSet.has(sessionId) || metadata.workspace === null) return [sessionId, metadata]
    changed = true
    return [sessionId, { ...metadata, workspace: null }]
  }))
  if (!changed) return
  sessionMetadataById = next
  persistSessionMetadata()
}

export const persistedWorkspacePaths = (): string[] => [...new Set(
  Object.values(sessionMetadataById)
    .flatMap((metadata) => metadata.workspace?.path ? [metadata.workspace.path] : []),
)]

export const hydrateSessionMetadata = (stored: StoredAgentSession): StoredAgentSession => {
  const metadata = sessionMetadataById[stored.id]
  // Prefer DB-stored workspace over localStorage metadata (DB is authoritative)
  if (stored.workspace) {
    // DB has workspace info; ensure localStorage is in sync
    if (!metadata?.workspace
      || metadata.workspace.path !== stored.workspace.path
      || metadata.workspace.name !== stored.workspace.name) {
      updateSessionMetadata(stored.id, { workspace: stored.workspace })
    }
    // 兼容升级前残留：localStorage 中若曾记录 archivedAt，但 SQLite 的 archived_at 尚未落库
    // （例如旧版本写入但从未升级到 V14），这里叠加进 store 以便下次 archive 写入触发回填。
    if (stored.archivedAt == null && metadata?.archivedAt != null) {
      updateSessionMetadata(stored.id, { archivedAt: metadata.archivedAt })
      return { ...stored, archivedAt: metadata.archivedAt }
    }
    return stored
  }
  // Fall back to localStorage metadata if DB has no workspace
  return {
    ...stored,
    workspace: metadata?.workspace ? structuredClone(metadata.workspace) : null,
    archivedAt: metadata?.archivedAt ?? null,
  }
}

export const hydrateSessionsMetadata = (sessions: StoredAgentSession[]): StoredAgentSession[] =>
  sessions.map(hydrateSessionMetadata)
