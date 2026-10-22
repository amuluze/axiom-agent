import { applyStreamingEvent } from '@/agent/core/streamingDraft'
import { snapshotAgentMessage } from '@/agent/core/snapshots'
import type { AgentMessage, AssistantMessageEvent } from '@/agent/core/types'

/**
 * 会话级流式草稿状态（A3 切片）：当前 assistant 草稿、contentIndex 阴影与
 * 在途工具调用集合的唯一所有者。
 *
 * `AgentSession` 只转发事件：message_start/update/end、tool_execution_start/end。
 * 重放算法仍在 `core/streamingDraft.ts`（纯函数），本类只负责生命周期与快照隔离。
 */

export class StreamingDraftState {
  private message?: AgentMessage
  private contentIndexes: number[] = []
  private activeToolCalls = new Set<string>()

  reset(): void {
    this.message = undefined
    this.contentIndexes = []
    this.activeToolCalls = new Set()
  }

  /** message_end / agent_end：只清草稿，不影响仍在执行的工具集合。 */
  clearMessage(): void {
    this.message = undefined
    this.contentIndexes = []
  }

  start(message: AgentMessage): void {
    this.message = snapshotAgentMessage(message)
    this.contentIndexes = []
  }

  apply(event: AssistantMessageEvent): void {
    if (this.message?.role !== 'assistant') return
    const replayed = applyStreamingEvent(this.message, this.contentIndexes, event)
    this.message = replayed.message
    this.contentIndexes = replayed.contentIndexes
  }

  beginToolCall(toolCallId: string): void {
    this.activeToolCalls = new Set(this.activeToolCalls).add(toolCallId)
  }

  endToolCall(toolCallId: string): void {
    const pending = new Set(this.activeToolCalls)
    pending.delete(toolCallId)
    this.activeToolCalls = pending
  }

  messageSnapshot(): AgentMessage | undefined {
    return this.message ? snapshotAgentMessage(this.message) : undefined
  }

  pendingToolCalls(): ReadonlySet<string> {
    return new Set(this.activeToolCalls)
  }
}
