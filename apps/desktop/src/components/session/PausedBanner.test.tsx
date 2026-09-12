import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PausedBanner } from './PausedBanner'

const mocks = vi.hoisted(() => ({
  continueConversation: vi.fn(),
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      continueConversation: mocks.continueConversation,
    } as StoreState),
  }
})

afterEach(() => {
  mocks.continueConversation.mockClear()
})

describe('PausedBanner', () => {
  it('renders the 已暂停 · 等待你的指令 banner', () => {
    const html = renderToStaticMarkup(createElement(PausedBanner))
    expect(html).toContain('已暂停 · 等待你的指令')
    expect(html).toContain('role="status"')
  })

  it('renders the 继续 action button', () => {
    const html = renderToStaticMarkup(createElement(PausedBanner))
    expect(html).toContain('继续')
  })

  it('uses the correct CSS classes for the banner scaffold', () => {
    const html = renderToStaticMarkup(createElement(PausedBanner))
    expect(html).toContain('session__paused-banner')
    expect(html).toContain('session__paused-banner-title')
    expect(html).toContain('session__paused-banner-button')
  })
})