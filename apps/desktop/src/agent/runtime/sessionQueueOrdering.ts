import type { QueuePlacement } from './queueContracts'

/**
 * 队列显示序状态（A1 切片）：order Map、单调计数器与精度退化标记的**唯一所有者**。
 *
 * 显示序是三个队列按 order 归并后的顺序；`resolve` 在相邻项之间取中点，首次/末次
 * 取 ±1。中点不再严格介于两邻之间即 double 精度耗尽，置 `precisionDegraded`，
 * 由调用方先执行 `reindexPlan`（0..n-1）再重算。
 *
 * 纯内存状态，不读会话/队列实例；journal 与队列数组操作仍由 AgentSession 承担。
 */

export interface OrderedQueueItem {
  id: string
}

export class QueueOrderState {
  private readonly orders = new Map<string, number>()
  private next = 0
  private degraded = false

  reset(): void {
    this.orders.clear()
    this.next = 0
    this.degraded = false
  }

  delete(messageId: string): void {
    this.orders.delete(messageId)
  }

  orderOf(messageId: string): number {
    return this.orders.get(messageId) ?? Number.MAX_SAFE_INTEGER
  }

  /** 记录队列项位置并推进单调计数器；缺省 order 取当前计数器值。 */
  record(messageId: string, order?: number): number {
    const resolved = order ?? this.next
    this.orders.set(messageId, resolved)
    this.next = Math.max(this.next, resolved + 1)
    return resolved
  }

  get precisionDegraded(): boolean {
    return this.degraded
  }

  clearPrecisionDegraded(): void {
    this.degraded = false
  }

  /**
   * 以显示序解析目标位置：top/bottom 取边界 ±1；above/below 取相邻中点。
   * 锚点不存在返回 undefined；中点精度耗尽时置退化标记但仍返回该中点（由调用方重排）。
   */
  resolve(
    messageId: string,
    placement: QueuePlacement,
    displayOrder: readonly OrderedQueueItem[],
  ): number | undefined {
    const others = displayOrder.filter((message) => message.id !== messageId)
    if (placement.position === 'top') {
      return others.length === 0 ? this.orderOf(messageId) : this.orderOf(others[0].id) - 1
    }
    if (placement.position === 'bottom') {
      return others.length === 0
        ? this.orderOf(messageId)
        : this.orderOf(others[others.length - 1].id) + 1
    }
    const anchorIndex = others.findIndex((message) => message.id === placement.anchorId)
    if (anchorIndex < 0) return undefined
    const index = placement.position === 'above' ? anchorIndex : anchorIndex + 1
    const previous = others[index - 1]
    const next = others[index]
    if (!previous) return this.orderOf(next.id) - 1
    if (!next) return this.orderOf(previous.id) + 1
    const mid = (this.orderOf(previous.id) + this.orderOf(next.id)) / 2
    if (!(mid > this.orderOf(previous.id) && mid < this.orderOf(next.id))) {
      this.degraded = true
    }
    return mid
  }

  /** 整型重排计划：按显示序给 0..n-1，调用方负责 journal 与队列数组重建。 */
  reindexPlan(displayOrder: readonly OrderedQueueItem[]): Map<string, number> {
    return new Map(displayOrder.map((message, index) => [message.id, index]))
  }

  sort<T extends OrderedQueueItem>(messages: readonly T[]): T[] {
    return [...messages].sort((left, right) => this.orderOf(left.id) - this.orderOf(right.id))
  }
}
