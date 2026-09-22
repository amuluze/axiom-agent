import { describe, expect, it } from 'vitest'
import type { AgentMessage, AssistantMessage, TokenUsage } from '@/agent/core/types'
import { cacheHitRate, formatHitRate, formatTokens, lastAssistantUsage } from './usageSummary'

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

describe('formatTokens', () => {
  it('keeps sub-kilo counts plain and abbreviates the rest', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(90_000)).toBe('90.0K')
    expect(formatTokens(123_456)).toBe('123K')
  })
})

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

describe('cacheHitRate', () => {
  it('divides reported cache reads by reported input tokens', () => {
    const usage: TokenUsage = {
      inputTokens: 1_000,
      outputTokens: 10,
      totalTokens: 1_010,
      cacheReadTokens: 250,
    }
    expect(cacheHitRate(usage)).toBe(25)
  })

  it('keeps a value above 100% untouched instead of normalizing providers', () => {
    // Anthropic 系：缓存读与上报输入并列，命中量可以超过未缓存输入。
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
      cacheReadTokens: 180,
    }
    expect(cacheHitRate(usage)).toBe(180)
  })

  it('treats a missing cache field or an empty reported input as unavailable', () => {
    expect(cacheHitRate({ inputTokens: 100, outputTokens: 5, totalTokens: 105 })).toBeUndefined()
    expect(cacheHitRate({
      inputTokens: 0,
      outputTokens: 5,
      totalTokens: 5,
      cacheReadTokens: 3,
    })).toBeUndefined()
  })
})

describe('formatHitRate', () => {
  it('renders one decimal, marks overflow, and falls back when unavailable', () => {
    expect(formatHitRate(25, '不可得')).toBe('25.0%')
    expect(formatHitRate(180, '不可得')).toBe('>100%')
    expect(formatHitRate(undefined, '不可得')).toBe('不可得')
  })
})
