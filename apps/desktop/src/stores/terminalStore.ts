import { create } from 'zustand'

export type TerminalStatus = 'idle' | 'spawning' | 'running' | 'exited'

/**
 * 单个工作区的终端条目。`terminalId` 是回调守卫的匹配键：撤销或重启后迟到的
 * PTY 事件不得写回已替换的条目（否则会复活已删条目或串台）。
 */
export interface WorkspaceTerminalEntry {
  terminalId: string
  status: TerminalStatus
}

interface TerminalState {
  /** workspacePath → 该工作区的终端条目（每工作区至多一个）。 */
  entries: Record<string, WorkspaceTerminalEntry>
  /** 幂等写入：同 terminalId 重复调用只更新状态，不重建条目。 */
  upsertEntry: (workspacePath: string, entry: WorkspaceTerminalEntry) => void
  /** 仅在条目当前 terminalId 匹配时更新状态；不匹配则整体忽略（丢失迟到事件）。 */
  setEntryStatus: (workspacePath: string, terminalId: string, status: TerminalStatus) => void
  /** 移除条目；传 terminalId 时仅在匹配时移除（撤销/重启的迟到事件不得复活条目）。 */
  removeEntry: (workspacePath: string, terminalId?: string) => void
}

/**
 * 终端状态投影：按工作区索引，键为工作区根目录（canonical 路径）。
 * 面板卸载/切视图不影响任何条目——终端生命周期与视图解耦（Domain 不变量 9），
 * 条目只随“用户显式结束 / shell 自行退出 / 撤销授权”变化。
 */
export const useTerminalStore = create<TerminalState>((set) => ({
  entries: {},
  upsertEntry: (workspacePath, entry) =>
    set((state) => ({ entries: { ...state.entries, [workspacePath]: entry } })),
  setEntryStatus: (workspacePath, terminalId, status) =>
    set((state) => {
      const current = state.entries[workspacePath]
      if (!current || current.terminalId !== terminalId) return state
      return { entries: { ...state.entries, [workspacePath]: { ...current, status } } }
    }),
  removeEntry: (workspacePath, terminalId) =>
    set((state) => {
      const current = state.entries[workspacePath]
      if (!current) return state
      if (terminalId && current.terminalId !== terminalId) return state
      const entries = { ...state.entries }
      delete entries[workspacePath]
      return { entries }
    }),
}))
