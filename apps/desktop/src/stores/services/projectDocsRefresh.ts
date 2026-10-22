/**
 * agent_end 后文档索引重扫的调度器：单飞（同一时刻至多一轮刷新在执行）+
 * 尾沿合并（trailing-edge merge）。
 *
 * 为什么不是「在途时丢弃触发」：在途刷新可能已经读过旧磁盘状态，若被丢弃的
 * 触发恰好对应最后一批文档写入，索引会停留在旧值，直到下一次 agent_end 或
 * 会话激活才兜底——留下一个可观测的陈旧窗口。尾沿合并保证「最后一次触发
 * 对应的磁盘状态」最终被一轮重新扫描消费：执行期间到达的触发只置 pending，
 * 当前轮结束后若 pending 仍置位则补扫一轮。
 *
 * run() 的异常由调用方语义决定：本调度器对异常 fail-soft（与刷新路径一致，
 * 会话激活仍会兜底全量重扫），补扫轮照常进行。
 */
export interface ProjectDocsRefreshScheduler {
  /** 请求一轮刷新；在途时合并为尾沿（不丢弃）。 */
  trigger(sessionId: string): void
  /**
   * 触发并等待该会话的当前轮（含在途时合并出的补扫轮）结束。
   * 用于保存后必须确认本轮扫描已消费最新磁盘的调用方；单轮失败同样 resolve。
   */
  flush(sessionId: string): Promise<void>
  /** 是否有刷新轮在执行（诊断用）。 */
  readonly inFlight: boolean
}

export const createProjectDocsRefreshScheduler = (
  refresh: (sessionId: string) => Promise<void>,
): ProjectDocsRefreshScheduler => {
  const states = new Map<string, { pending: boolean }>()
  const waiters = new Map<string, Set<() => void>>()
  const resolveWaiters = (sessionId: string): void => {
    const pending = waiters.get(sessionId)
    if (!pending) return
    waiters.delete(sessionId)
    for (const resolve of pending) resolve()
  }
  const waitForEnd = (sessionId: string): Promise<void> => new Promise((resolve) => {
    const pending = waiters.get(sessionId) ?? new Set<() => void>()
    pending.add(resolve)
    waiters.set(sessionId, pending)
  })
  const run = async (sessionId: string, state: { pending: boolean }): Promise<void> => {
    try {
      do {
        state.pending = false
        try {
          await refresh(sessionId)
        } catch {
          // 单轮失败 fail-soft（与刷新路径一致）：不中断循环，被合并的尾沿
          // 触发仍应得到补扫轮；会话激活路径兜底全量重扫。
        }
      } while (state.pending)
    } finally {
      states.delete(sessionId)
      resolveWaiters(sessionId)
    }
  }
  const start = (sessionId: string): void => {
    const state = { pending: false }
    states.set(sessionId, state)
    void run(sessionId, state).catch(() => undefined)
  }
  return {
    trigger: (sessionId): void => {
      const existing = states.get(sessionId)
      if (existing) {
        existing.pending = true
        return
      }
      start(sessionId)
    },
    flush: (sessionId): Promise<void> => {
      const existing = states.get(sessionId)
      if (existing) {
        // 在途轮可能已读过保存前的磁盘；置 pending 保证保存后的状态被补扫。
        existing.pending = true
        return waitForEnd(sessionId)
      }
      start(sessionId)
      return waitForEnd(sessionId)
    },
    get inFlight(): boolean {
      return states.size > 0
    },
  }
}
