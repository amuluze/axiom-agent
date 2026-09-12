import type { StoredAgentSession } from '@/persistence/types'
import {
  archiveSession as archiveSessionAction,
  deleteSession as deleteSessionAction,
  renameSession as renameSessionAction,
  restoreSession as restoreSessionAction,
  selectSession as selectSessionAction,
} from '../sessionManagementActions'
import { createNewSession as createNewSessionAction } from '../workspaceActions'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from '../sessionActions'

/**
 * 会话管理切片：会话列表、激活会话与新建/重命名/归档等管理动作。
 * 方法全部转发到 sessionManagementActions / workspaceActions 的显式
 * action 函数，经 StoreRuntimeDeps 取用模块级单例。
 */
export interface AgentSessionManagementSlice {
  sessions: StoredAgentSession[]
  activeSessionId: string | null
  recoveredRuns: number
  createNewSession: (workspacePath?: string) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<boolean>
  selectSession: (sessionId: string) => Promise<boolean>
  deleteSession: (sessionId: string) => Promise<boolean>
  archiveSession: (sessionId: string) => Promise<boolean>
  restoreSession: (sessionId: string) => Promise<boolean>
}

export const createAgentSessionManagementSlice = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): AgentSessionManagementSlice => ({
  sessions: [],
  activeSessionId: null,
  recoveredRuns: 0,
  createNewSession: (workspacePath) => createNewSessionAction(set, get, deps, workspacePath),
  renameSession: (sessionId, title) => renameSessionAction(set, get, deps, sessionId, title),
  selectSession: (sessionId) => selectSessionAction(set, get, deps, sessionId),
  deleteSession: (sessionId) => deleteSessionAction(set, get, deps, sessionId),
  archiveSession: (sessionId) => archiveSessionAction(set, get, deps, sessionId),
  restoreSession: (sessionId) => restoreSessionAction(set, get, deps, sessionId),
})
