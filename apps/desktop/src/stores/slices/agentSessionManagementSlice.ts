import {
  EMPTY_RECOVERY_SUMMARY,
  type RecoverySummary,
  type StoredAgentSession,
} from '@/persistence/types'
import {
  archiveSession as archiveSessionAction,
  deleteSession as deleteSessionAction,
  renameSession as renameSessionAction,
  restoreSession as restoreSessionAction,
  selectSession as selectSessionAction,
} from '../sessionManagementActions'
import { createNewSession as createNewSessionAction } from '../workspaceActions'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from '../sessionActions'
import type { AccessMode } from '@/agent/approval/ApprovalCoordinator'
import { setSessionAccessMode } from '../accessModeActions'

/**
 * 会话管理切片：会话列表、激活会话与新建/重命名/归档等管理动作。
 * 方法全部转发到 sessionManagementActions / workspaceActions 的显式
 * action 函数，经 StoreRuntimeDeps 取用模块级单例。
 */
export interface AgentSessionManagementSlice {
  sessions: StoredAgentSession[]
  activeSessionId: string | null
  accessMode: AccessMode
  accessModeChanging: boolean
  recoveredRuns: number
  /** 恢复摘要（启动全局恢复 + 会话级恢复的累计）。 */
  recoverySummary: RecoverySummary
  createNewSession: (workspacePath?: string) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<boolean>
  selectSession: (sessionId: string) => Promise<boolean>
  deleteSession: (sessionId: string) => Promise<boolean>
  archiveSession: (sessionId: string) => Promise<boolean>
  restoreSession: (sessionId: string) => Promise<boolean>
  /** 成功返回 null，失败返回可直接展示的原因（同时写入 settingsError）。 */
  setAccessMode: (mode: AccessMode) => Promise<string | null>
}

export const createAgentSessionManagementSlice = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): AgentSessionManagementSlice => ({
  sessions: [],
  activeSessionId: null,
  accessMode: 'standard',
  accessModeChanging: false,
  recoveredRuns: 0,
  recoverySummary: EMPTY_RECOVERY_SUMMARY,
  createNewSession: (workspacePath) => createNewSessionAction(set, get, deps, workspacePath),
  renameSession: (sessionId, title) => renameSessionAction(set, get, deps, sessionId, title),
  selectSession: (sessionId) => selectSessionAction(set, get, deps, sessionId),
  deleteSession: (sessionId) => deleteSessionAction(set, get, deps, sessionId),
  archiveSession: (sessionId) => archiveSessionAction(set, get, deps, sessionId),
  restoreSession: (sessionId) => restoreSessionAction(set, get, deps, sessionId),
  setAccessMode: async (mode) => {
    const sessionId = get().activeSessionId
    if (!sessionId) return null
    const error = await setSessionAccessMode(
      set,
      get,
      deps,
      sessionId,
      mode,
    )
    // 成功后才重建提示词：失败时模式未变，重建无意义且会掩盖真实状态。
    if (error === null) await deps.refreshSystemPromptForAccessMode()
    return error
  },
})
