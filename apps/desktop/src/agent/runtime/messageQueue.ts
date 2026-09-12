import type { AgentMessage } from '@/agent/core/types'
import type { QueueDeliveryMode } from './queueSettings'

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

  snapshot(): AgentMessage[] {
    return this.messages.slice()
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

  takeAll(): AgentMessage[] {
    const messages = this.messages
    this.messages = []
    return messages
  }
}
