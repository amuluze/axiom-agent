import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import {
  ContextBudgetPanel,
  contextBudgetPercent,
  formatContextBytes,
  formatTokens,
} from './ContextBudgetControl'

const usage: ContextBudgetUsage = {
  estimatedTokens: 90_000,
  contextWindow: 200_000,
  tokenThreshold: 180_000,
  requestBytes: 1024 * 500,
  requestByteThreshold: 1024 * 1024,
  hardRequestByteLimit: 2 * 1024 * 1024,
  tokenPercent: 45,
  bytePercent: 24,
  needsCompaction: false,
}

const checkpoint = {
  id: 'cp-1',
  sessionId: 's-1',
  throughMessageId: 'm-1',
  summary: '保留恢复点约束',
  summaryHash: 'hash',
  reason: 'manual',
  tokensBefore: 1,
  estimatedTokensAfter: 1,
  requestBytesBefore: 1,
  requestBytesAfter: 1,
  modelProvider: 'demo',
  modelId: 'demo-v1',
  promptVersion: 1,
  excludedMessageIds: [],
  facts: { readFiles: [], modifiedFiles: [] },
  createdAt: 1,
} as ContextCheckpoint

const renderPanel = (overrides: Partial<Parameters<typeof ContextBudgetPanel>[0]> = {}) => renderToStaticMarkup(
  createElement(ContextBudgetPanel, {
    usage,
    checkpoint: null,
    busy: false,
    messageCount: 4,
    compactionRunning: false,
    onCompact: vi.fn(),
    ...overrides,
  }),
)

describe('context budget formatting', () => {
  it('keeps sub-kilo token counts plain and abbreviates the rest', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(90_000)).toBe('90.0K')
    expect(formatTokens(123_456)).toBe('123K')
  })

  it('formats request bytes as KiB below 1 MiB and MiB beyond', () => {
    expect(formatContextBytes(1024 * 500)).toBe('500 KiB')
    expect(formatContextBytes(1024 * 1024 + 4096)).toBe('1.00 MiB')
  })

  it('derives the display percent from the higher of token/byte waterlines', () => {
    expect(contextBudgetPercent(usage)).toBe(45)
    expect(contextBudgetPercent({ ...usage, tokenPercent: 10, bytePercent: 80 })).toBe(80)
  })
})

describe('ContextBudgetPanel', () => {
  it('renders the usage waterlines and token/byte stats', () => {
    const html = renderPanel()
    expect(html).toContain('上下文预算')
    expect(html).toContain('45%')
    expect(html).toContain('90.0K / 200K tokens')
    expect(html).toContain('500 KiB / 2.00 MiB')
    expect(html).toContain('width:45%')
  })

  it('shows the compaction entry enabled while no checkpoint exists yet', () => {
    const html = renderPanel()
    expect(html).toContain('尚未压缩')
    expect(html).toContain('手动压缩')
    expect(html).not.toMatch(/class="composer__budget-compact"[^>]*disabled/gu)
  })

  it('restores the checkpoint summary and disables compaction while busy', () => {
    const html = renderPanel({ checkpoint, busy: true })
    expect(html).toContain('已有检查点')
    expect(html).toContain('查看当前检查点摘要')
    expect(html).toContain('保留恢复点约束')
    expect(html).toMatch(/class="composer__budget-compact"[^>]*disabled/gu)
  })

  it('reflects a running compaction instead of the trigger label', () => {
    const html = renderPanel({ compactionRunning: true })
    expect(html).toContain('压缩中…')
  })
})
