import type { SessionRepository, StorageStats } from '@/persistence/types'

/**
 * 存储统计切片：设置页「会话与存储」的用量展示。仓库统计是唯一的
 * 数据源——历史 slice 上的备份/诊断导出已下线（命令删除），这里不再
 * 持有其它副作用依赖。
 */

export interface StorageStatsSlice {
  refreshStorageStats: () => Promise<void>
}

export interface StorageStatsDependencies {
  get: () => StorageStatsStateView
  set: (partial: Partial<StorageStatsStateView>) => void
  getRepository: () => SessionRepository
}

/**
 * Subset of `AgentState` read or written by this slice. Defined locally
 * so the slice can be type-checked without importing the full store
 * interface (which would pull in dozens of action functions irrelevant
 * to storage stats).
 */
export interface StorageStatsStateView {
  runtimeLifecycle: 'initializing' | 'ready' | 'failed'
  storageStats: StorageStats | null
  settingsError: string | null
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const createStorageStatsSlice = (
  deps: StorageStatsDependencies,
): StorageStatsSlice => ({
  refreshStorageStats: async () => {
    if (deps.get().runtimeLifecycle !== 'ready') return
    try {
      deps.set({ storageStats: await deps.getRepository().getStats() })
    } catch (error) {
      deps.set({ settingsError: errorMessage(error) })
    }
  },
})
