/**
 * 工作区级扫描结果缓存的通用实现。
 *
 * 同一工作区在「新建会话 / 切换会话 / 启动恢复」之间会反复触发项目约定扫描
 * （AGENTS.md、`.specs` 文档索引、`.axiom/skills`）。这些扫描都要经宿主 IPC
 * 读取磁盘，在大项目里是会话准备阶段的主要成本；而同一份结果在纯切换窗口内
 * 不需要重新读取。
 *
 * 缓存只复用**同一次扫描的完整结果**（不做逐条拼接），因此不会出现多个镜像
 * 混装不同新鲜度的内容。
 *
 * 新鲜度边界：TTL 内的外部编辑不会立即反映；run 结束的重扫、显式刷新与技能
 * 重载都会 `invalidate` 并写回新结果，模型自己写入的文件因此仍在下一轮可见。
 * TTL 只覆盖「没有任何写操作、用户纯切换会话」的窗口，取值按「宁可晚一个窗口
 * 也不在每次切换时重扫」的交互口径设定。
 */
export interface WorkspaceScanCache<T> {
  get(workspacePath: string): T | undefined
  set(workspacePath: string, value: T): void
  invalidate(workspacePath: string): void
  clear(): void
}

export const createWorkspaceScanCache = <T>({
  ttlMs,
  now = Date.now,
}: {
  ttlMs: number
  now?: () => number
}): WorkspaceScanCache<T> => {
  const entries = new Map<string, { value: T; scannedAt: number }>()

  return {
    get(workspacePath) {
      const entry = entries.get(workspacePath)
      if (!entry) return undefined
      if (now() - entry.scannedAt > ttlMs) {
        entries.delete(workspacePath)
        return undefined
      }
      return entry.value
    },
    set(workspacePath, value) {
      entries.set(workspacePath, { value, scannedAt: now() })
    },
    invalidate(workspacePath) {
      entries.delete(workspacePath)
    },
    clear() {
      entries.clear()
    },
  }
}
