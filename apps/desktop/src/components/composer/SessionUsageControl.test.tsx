import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionUsageView, lastAssistantUsage } from './SessionUsageControl'
import type { AgentMessage, AssistantMessage, TokenUsage } from '@/agent/core/types'

const assistant = (usage?: TokenUsage): AssistantMessage => ({
  id: `assistant-${usage?.inputTokens ?? 0}`,
  createdAt: 1,
  role: 'assistant',
  content: 'done',
  toolCalls: [],
  stopReason: 'stop',
  ...(usage ? { usage } : {}),
})

const userMessage: AgentMessage = { id: 'user-1', createdAt: 0, role: 'user', content: 'hi' }

describe('lastAssistantUsage', () => {
  it('returns the usage of the last assistant message carrying one', () => {
    const usage: TokenUsage = { inputTokens: 12_345, outputTokens: 456, totalTokens: 12_801 }
    const messages: AgentMessage[] = [userMessage, assistant(), assistant(usage)]
    expect(lastAssistantUsage(messages)).toEqual(usage)
  })

  it('skips trailing messages without usage and returns undefined when none reports it', () => {
    expect(lastAssistantUsage([userMessage, assistant()])).toBeUndefined()
    expect(lastAssistantUsage([])).toBeUndefined()
  })
})

describe('SessionUsageView', () => {
  it('renders nothing without usage', () => {
    expect(renderToStaticMarkup(createElement(SessionUsageView, { usage: undefined }))).toBe('')
  })

  it('renders input/output tokens plus optional reasoning and cache detail', () => {
    const html = renderToStaticMarkup(createElement(SessionUsageView, {
      usage: {
        inputTokens: 12_345,
        outputTokens: 456,
        totalTokens: 12_801,
        cacheReadTokens: 2_000,
        reasoningTokens: 300,
      },
    }))
    expect(html).toContain('输入 12.3K')
    expect(html).toContain('输出 456')
    expect(html).toContain('思考 300')
    expect(html).toContain('缓存读 2.0K')
  })

  it('omits optional detail the provider did not report', () => {
    const html = renderToStaticMarkup(createElement(SessionUsageView, {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }))
    expect(html).not.toContain('缓存读')
    expect(html).not.toContain('缓存写')
    expect(html).not.toContain('思考')
  })
})
