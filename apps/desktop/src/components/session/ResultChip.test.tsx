import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResultChip } from './ResultChip'
import type { AgentMessage } from '@/agent/core/types'

const stubMessage = (overrides: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 'm',
  createdAt: 0,
  role: 'assistant',
  content: '',
  ...overrides,
}) as unknown as AgentMessage

describe('ResultChip', () => {
  it('renders the message content as the primary label', () => {
    const html = renderToStaticMarkup(createElement(ResultChip, {
      message: stubMessage({ content: '任务完成 · 3 处文件改动 · 全部测试通过' }),
    }))
    expect(html).toContain('任务完成 · 3 处文件改动 · 全部测试通过')
  })

  it('falls back to 任务完成 when the content is empty', () => {
    const html = renderToStaticMarkup(createElement(ResultChip, {
      message: stubMessage({ content: '' }),
    }))
    expect(html).toContain('任务完成')
  })

  it('renders a locale-formatted time from the message timestamp', () => {
    const html = renderToStaticMarkup(createElement(ResultChip, {
      message: stubMessage({ createdAt: new Date(2025, 0, 1, 12, 0, 0).getTime() }),
    }))
    expect(html).toContain('session__result-chip-meta')
  })

  it('has the CircleCheck icon and the status role', () => {
    const html = renderToStaticMarkup(createElement(ResultChip, {
      message: stubMessage(),
    }))
    expect(html).toContain('lucide-circle-check')
    expect(html).toContain('role="status"')
  })

  it('uses the correct CSS classes for the chip scaffold', () => {
    const html = renderToStaticMarkup(createElement(ResultChip, {
      message: stubMessage(),
    }))
    expect(html).toContain('session__result-chip')
    expect(html).toContain('session__result-chip-icon')
    expect(html).toContain('session__result-chip-meta')
  })
})