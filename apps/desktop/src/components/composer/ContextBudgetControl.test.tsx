import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import type { AgentMessage } from '@/agent/core/types'
import {
  ContextBudgetPanel,
  ContextBudgetSummary,
  contextBudgetPercent,
  formatContextBytes,
  sddProgressFromHistory,
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
    sendManifest: null,
    onCompact: vi.fn(),
    ...overrides,
  }),
)

describe('context budget formatting', () => {
  it('renders the send manifest counts when a request has been sent', () => {
    const html = renderPanel({
      sendManifest: {
        requestId: 'r1',
        sessionId: 's1',
        providerId: 'demo',
        bytes: 4096,
        systemBytes: 100,
        toolCount: 7,
        toolBytes: 900,
        messageCount: 12,
        messageBytes: 3000,
        toolResultCount: 3,
        toolResultBytes: 1536,
        roleCounts: { user: 6, assistant: 6 },
        imageCount: 2,
        imageBytes: 1024,
        retryCount: 1,
        credentialScan: 'passed',
        summaryIncluded: true,
      },
    })
    expect(html).toContain('发送清单：12 条消息')
    expect(html).toContain('工具 7')
    expect(html).toContain('工具结果 3/2 KiB')
    expect(html).toContain('图片 2')
    expect(html).toContain('重试 1')
    expect(html).toContain('凭据扫描通过')
    expect(html).toContain('摘要已包含')
  })

  it('formats request bytes as KiB below 1 MiB and MiB beyond', () => {
    expect(formatContextBytes(1024 * 500)).toBe('500 KiB')
    expect(formatContextBytes(1024 * 1024 + 4096)).toBe('1.00 MiB')
  })

  it('derives the display percent from the higher of token/byte waterlines', () => {
    expect(contextBudgetPercent(usage)).toBe(45)
    expect(contextBudgetPercent({ ...usage, tokenPercent: 10, bytePercent: 80 })).toBe(80)
  })

  it('merges SDD progress only from messages after the checkpoint boundary', () => {
    const progress = sddProgressFromHistory({
      ...checkpoint,
      facts: {
        readFiles: [],
        modifiedFiles: [],
        sddReviews: [{ reviewer: 'review_subagent', verdict: 'pass' }],
      },
    }, [
      {
        id: 'old-review',
        role: 'tool',
        toolCallId: 'call-old',
        toolName: 'review_subagent',
        content: '旧结论',
        details: { verdict: 'fail' },
        createdAt: 1,
      },
      { id: 'm-1', role: 'user', content: '检查点边界', createdAt: 2 },
      {
        id: 'new-review',
        role: 'tool',
        toolCallId: 'call-new',
        toolName: 'examine_subagent',
        content: '新结论',
        details: { verdict: 'pass' },
        createdAt: 3,
      },
    ] as AgentMessage[])

    expect(progress.sddReviews).toEqual([
      { reviewer: 'review_subagent', verdict: 'pass' },
      { reviewer: 'examine_subagent', verdict: 'pass' },
    ])
  })
})

describe('ContextBudgetSummary', () => {
  it('renders the waterline with its token and byte limits', () => {
    const html = renderToStaticMarkup(createElement(ContextBudgetSummary, { usage }))
    expect(html).toContain('上下文预算')
    expect(html).toContain('45%')
    expect(html).toContain('90.0K / 200K tokens')
    expect(html).toContain('500 KiB / 2.00 MiB')
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

  it('shows deterministic SDD progress and warns about unresolved reviews', () => {
    const html = renderPanel({
      sddProgress: {
        loadedSkills: [
          { name: 'plan', source: 'builtin' },
          { name: 'implement', source: 'builtin' },
        ],
        sddReviews: [
          { reviewer: 'examine_subagent', verdict: 'pass' },
          { reviewer: 'review_subagent', verdict: 'unknown' },
        ],
      },
    })
    expect(html).toContain('SDD 进度')
    expect(html).toContain('已加载：plan → implement')
    expect(html).toContain('examine 审查：通过')
    expect(html).toContain('review 审查：未知')
    expect(html).toContain('存在未闭环审查')
  })
})
