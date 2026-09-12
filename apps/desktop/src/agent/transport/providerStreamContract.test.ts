/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ModelRequest, ModelStreamEvent } from '@/agent/core/types'
import type { ModelHttpStreamFactory } from './OpenAICompatibleTransport'
import { AnthropicCompatibleTransport } from './AnthropicCompatibleTransport'
import { OpenAIResponsesTransport } from './OpenAIResponsesTransport'

interface StreamContractFixture {
  name: string
  provider: 'anthropic-compatible' | 'openai-responses'
  endpoint: string
  frames: Array<Record<string, unknown>>
  expectedEvents: ModelStreamEvent[]
}

// 与 provider-stream-contract-v1.json 共享同一份黄金夹具，锁死「原始帧 → 归一化事件」契约。
const fixtures = (JSON.parse(readFileSync(
  new URL('../../../contracts/provider-stream-contract-v1.json', import.meta.url),
  'utf8',
)) as { fixtures: StreamContractFixture[] }).fixtures

const request: ModelRequest = {
  sessionId: 'session-contract',
  runId: 'run-contract',
  systemPrompt: 'Be careful',
  model: { provider: 'contract', model: 'contract-model' },
  messages: [{ id: 'u1', role: 'user', content: 'inspect', createdAt: 1 }],
  tools: [],
}

const encodeSse = (frames: Array<Record<string, unknown>>, withEventField: boolean): Uint8Array => {
  const encoder = new TextEncoder()
  const body = frames.map((frame) => {
    const eventField = withEventField ? `event: ${frame.type}\n` : ''
    return `${eventField}data: ${JSON.stringify(frame)}\n\n`
  }).join('')
  return encoder.encode(body)
}

const collect = async (events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> => {
  const output: ModelStreamEvent[] = []
  for await (const event of events) output.push(event)
  return output
}

describe('Provider 流式响应黄金契约（provider-stream-contract-v1.json）', () => {
  it.each(fixtures)('$name', async (fixture) => {
    const httpStream: ModelHttpStreamFactory = () => (async function* () {
      // Anthropic SSE 带 event 字段；OpenAI Responses 无 event 字段（仅 data）
      yield encodeSse(fixture.frames, fixture.provider === 'anthropic-compatible')
    })()
    const events = fixture.provider === 'anthropic-compatible'
      ? await collect(new AnthropicCompatibleTransport({
          providerId: 'contract-anthropic',
          endpoint: fixture.endpoint,
        }, httpStream).stream(request, new AbortController().signal))
      : await collect(new OpenAIResponsesTransport({
          providerId: 'contract-openai-responses',
          endpoint: fixture.endpoint,
        }, httpStream).stream(request, new AbortController().signal))
    expect(events).toEqual(fixture.expectedEvents)
  })
})
