import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { QueueModesSection } from './QueueModesSection'
import { buildQueueModesHook, stubContext } from './testFixtures'

describe('QueueModesSection', () => {
  it('disables 保存队列模式 when the draft is unchanged', () => {
    const html = renderToStaticMarkup(createElement(QueueModesSection, {
      hook: buildQueueModesHook(),
      context: stubContext,
      isSaved: true,
      onSave: vi.fn(),
    }))
    expect(html).toContain('保存队列模式')
    expect(html).toContain('disabled=""')
  })

  it('enables 保存队列模式 when the draft diverges from saved settings', () => {
    const hook = buildQueueModesHook({
      draft: { steering: 'all', followUp: 'all', autoDrain: true },
    })
    const html = renderToStaticMarkup(createElement(QueueModesSection, {
      hook,
      context: stubContext,
      isSaved: false,
      onSave: vi.fn(),
    }))
    expect(html).toContain('value="all"')
    expect(html).not.toContain('disabled=""')
  })
})
