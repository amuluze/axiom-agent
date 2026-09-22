import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionUsageDetail, SessionUsageView } from './SessionUsageControl'

describe('SessionUsageDetail', () => {
  it('lists input, output, hit rate and the formula behind the rate', () => {
    const html = renderToStaticMarkup(createElement(SessionUsageDetail, {
      usage: {
        inputTokens: 64_000,
        outputTokens: 1_800,
        totalTokens: 65_800,
        cacheReadTokens: 63_700,
      },
    }))
    expect(html).toContain('最近一次模型响应用量')
    expect(html).toContain('输入 64.0K')
    expect(html).toContain('输出 1.8K')
    expect(html).toContain('缓存命中率 99.5%')
    expect(html).toContain('缓存读 63.7K / 输入 64.0K')
  })

  it('marks an unavailable rate and omits the formula', () => {
    const html = renderToStaticMarkup(createElement(SessionUsageDetail, {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }))
    expect(html).toContain('不可得')
    expect(html).not.toContain('缓存读')
  })
})

describe('SessionUsageView', () => {
  it('renders nothing without usage', () => {
    expect(renderToStaticMarkup(createElement(SessionUsageView, { usage: undefined }))).toBe('')
  })

  it('renders a hit-rate ring whose accessible name carries the full numbers', () => {
    const html = renderToStaticMarkup(createElement(SessionUsageView, {
      usage: {
        inputTokens: 64_000,
        outputTokens: 1_800,
        totalTokens: 65_800,
        cacheReadTokens: 63_700,
      },
    }))
    expect(html).toContain('composer__usage-ring')
    expect(html).toContain('--hit')
    expect(html).toContain('缓存命中率 99.5%')
    // 明细只在悬浮/聚焦后出现，默认渲染不带浮层。
    expect(html).not.toContain('composer__usage-popover')
  })
})
