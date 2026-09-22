import type { AgentMessage } from '@/agent/core/types'
import type { QueueDeliveryMode } from './queueSettings'

const clampIndex = (index: number, length: number): number =>
  Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : 0, length))

/**
 * 会话运行期的消息队列：steering / follow-up 按队列模式逐条或全量出队，
 * next-turn 队列始终整批消费。从 AgentSession 抽出以隔离队列语义。
 */
export class MessageQueue {
  private messages: AgentMessage[] = []

  constructor(private mode: QueueDeliveryMode) {}

  enqueue(message: AgentMessage): void {
    this.messages.push(message)
  }

  get size(): number {
    return this.messages.length
  }

  setMode(mode: QueueDeliveryMode): void {
    this.mode = mode
  }

  get deliveryMode(): QueueDeliveryMode {
    return this.mode
  }

  snapshot(): AgentMessage[] {
    return this.messages.slice()
  }

  find(messageId: string): AgentMessage | undefined {
    return this.messages.find((message) => message.id === messageId)
  }

  drain(): AgentMessage[] {
    if (this.mode === 'all') {
      const drained = this.messages.slice()
      this.messages = []
      return drained
    }
    const message = this.messages.shift()
    return message ? [message] : []
  }

  /**
   * 无论模式出队一条：手动放行（sendQueuedNow）的语义是「只发这一条」，
   * 模式 `all` 的批量语义属于自动出队，不适用于逐条放行。
   */
  drainOne(): AgentMessage[] {
    const message = this.messages.shift()
    return message ? [message] : []
  }

  peekDrain(): AgentMessage[] {
    return this.mode === 'all' ? this.messages.slice() : this.messages.slice(0, 1)
  }

  clear(): void {
    this.messages = []
  }

  remove(messageId: string): AgentMessage | undefined {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index < 0) return undefined
    return this.messages.splice(index, 1)[0]
  }

  prepend(messages: AgentMessage[]): void {
    this.messages = [...messages, ...this.messages]
  }

  /** 插入到指定位置（越界收敛到边界）：跨队列移动的落点。 */
  insertAt(message: AgentMessage, index: number): void {
    const next = this.messages.slice()
    next.splice(clampIndex(index, next.length), 0, message)
    this.messages = next
  }

  /** 把已有消息移动到指定位置；未知 id 返回 false（不改动队列）。 */
  reorder(messageId: string, index: number): boolean {
    const current = this.messages.findIndex((message) => message.id === messageId)
    if (current < 0) return false
    const next = this.messages.slice()
    const [message] = next.splice(current, 1)
    next.splice(clampIndex(index, next.length), 0, message)
    this.messages = next
    return true
  }

  takeAll(): AgentMessage[] {
    const messages = this.messages
    this.messages = []
    return messages
  }
}
