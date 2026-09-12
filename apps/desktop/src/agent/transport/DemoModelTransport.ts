import { createId } from '@/agent/core/id'
import type { AgentMessage, ModelRequest, ModelStreamEvent, ModelTransport } from '@/agent/core/types'

const lastMessage = (messages: AgentMessage[]): AgentMessage | undefined =>
  messages[messages.length - 1]

const textChunks = (content: string): string[] => {
  const chunks = content.match(/.{1,18}/gu)
  return chunks ?? [content]
}

export class DemoModelTransport implements ModelTransport {
  requestByteLength = (request: ModelRequest): number => new TextEncoder().encode(JSON.stringify(request)).byteLength

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    yield { type: 'start', responseId: createId('demo-response') }

    const message = lastMessage(request.messages)
    const userContent = message?.role === 'user' ? message.content : ''
    const response = userContent
      ? `这是 Axiom 自研 Agent Runtime 的本地演示响应。你刚才说：“${userContent}”。`
      : 'Axiom Agent Runtime 已准备就绪。'
    for (const delta of textChunks(response)) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      yield { type: 'text_delta', delta }
    }
    yield { type: 'done', stopReason: 'stop' }
  }
}
