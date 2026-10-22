import type { AccessMode } from '@/agent/approval/ApprovalCoordinator'
import { setWorkspaceApprovalMode } from '@/platform/workspaceApproval'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from './sessionActions'

let pendingUpdate: Promise<void> = Promise.resolve()

const nativeMode = (mode: AccessMode): 'automatic' | 'interactive' =>
  mode === 'no-approval' ? 'automatic' : 'interactive'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 切换会话访问模式。返回 `null` 表示成功，非 null 为可直接展示给用户的失败原因
 * ——错误同时写入 `settingsError`（设置面板可见），返回值让发起处（Composer 的
 * 模式菜单）能在原地提示，不必要求用户跨页查看。
 */
export const setSessionAccessMode = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  sessionId: string,
  mode: AccessMode,
): Promise<string | null> => {
  const update = pendingUpdate.catch(() => undefined).then(async () => {
    const session = get().sessions.find((candidate) => candidate.id === sessionId)
    if (!session || (session.accessMode ?? 'standard') === mode) return null
    const priorMode = session.accessMode ?? 'standard'
    set({ accessModeChanging: true, settingsError: null })
    try {
      await setWorkspaceApprovalMode(sessionId, nativeMode(mode))
      try {
        await deps.getRepository().updateSessionAccessMode(sessionId, mode)
      } catch (error) {
        try {
          await setWorkspaceApprovalMode(sessionId, nativeMode(priorMode))
        } catch (rollbackError) {
          if (mode === 'no-approval') {
            set((state) => ({
              sessions: state.sessions.map((candidate) => (
                candidate.id === sessionId ? { ...candidate, accessMode: mode } : candidate
              )),
              ...(state.activeSessionId === sessionId ? { accessMode: mode } : {}),
            }))
          }
          throw new Error(`${errorMessage(error)}；原生访问模式回滚失败：${errorMessage(rollbackError)}`)
        }
        throw error
      }
      // 切到标准模式同样是降级：撤回该会话已入队的卡片。完全访问下 Automatic
      // 租约失败会回落逐次卡片，用户随后切回标准模式时，那张卡仍按「上一档权限」
      // 排队；点「允许一次」会走 interactive 签发路径成功拿到租约。切换到完全
      // 访问则无需撤回——卡片本就等价于标准模式下的逐次审批。
      if (mode === 'standard') {
        deps.cancelPendingApprovals(sessionId, '访问模式已变更，本次调用需重新发起')
      }
      set((state) => ({
        sessions: state.sessions.map((candidate) => (
          candidate.id === sessionId ? { ...candidate, accessMode: mode } : candidate
        )),
        ...(state.activeSessionId === sessionId ? { accessMode: mode } : {}),
      }))
      return null
    } catch (error) {
      const message = `切换访问模式失败：${errorMessage(error)}`
      set({ settingsError: message })
      return message
    } finally {
      set({ accessModeChanging: false })
    }
  })
  pendingUpdate = update.then(() => undefined, () => undefined)
  return update
}

export const resetSessionAccessMode = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  sessionId: string,
): Promise<boolean> => {
  const update = pendingUpdate.catch(() => undefined).then(async () => {
    const session = get().sessions.find((candidate) => candidate.id === sessionId)
    if (!session) return false
    set({ accessModeChanging: true, settingsError: null })
    try {
      await setWorkspaceApprovalMode(sessionId, 'interactive')
    } catch (error) {
      set({
        accessModeChanging: false,
        settingsError: `重置访问模式失败：${errorMessage(error)}`,
      })
      return false
    }
    // 降级已生效：撤回该会话已入队的审批卡片。卡片是按降级前状态排队的，
    // 用户点「允许一次」会走 interactive 签发路径——此刻 native 已是 Interactive，
    // 但若不撤回，用户看到的仍是「上一档权限下排的队」，且模式切换的语义是
    // 「此前未获批准的调用不再被批准」。
    deps.cancelPendingApprovals(sessionId, '访问模式已变更，本次调用需重新发起')
    set((state) => ({
      sessions: state.sessions.map((candidate) => (
        candidate.id === sessionId ? { ...candidate, accessMode: 'standard' } : candidate
      )),
      ...(state.activeSessionId === sessionId ? { accessMode: 'standard' as const } : {}),
    }))
    try {
      await deps.getRepository().updateSessionAccessMode(sessionId, 'standard')
    } catch (error) {
      set({ settingsError: `原生访问模式已重置，但会话记录更新失败：${errorMessage(error)}` })
    } finally {
      set({ accessModeChanging: false })
    }
    return true
  })
  pendingUpdate = update.then(() => undefined, () => undefined)
  return update
}
