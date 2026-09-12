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
  trigger(): void
  /** 是否有刷新轮在执行（诊断用）。 */
  readonly inFlight: boolean
}

export const createProjectDocsRefreshScheduler = (
  refresh: () => Promise<void>,
): ProjectDocsRefreshScheduler => {
  let inFlight = false
  let pending = false
  const run = async (): Promise<void> => {
    try {
      do {
        pending = false
        try {
          await refresh()
        } catch {
          // 单轮失败 fail-soft（与刷新路径一致）：不中断循环，被合并的尾沿
          // 触发仍应得到补扫轮；会话激活路径兜底全量重扫。
        }
      } while (pending)
    } finally {
      inFlight = false
    }
  }
  return {
    trigger: (): void => {
      if (inFlight) {
        pending = true
        return
      }
      inFlight = true
      void run().catch(() => undefined)
    },
    get inFlight(): boolean {
      return inFlight
    },
  }
}
