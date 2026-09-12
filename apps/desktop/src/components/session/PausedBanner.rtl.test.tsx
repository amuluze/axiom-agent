// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PausedBanner } from './PausedBanner'

const mocks = vi.hoisted(() => ({
  continueConversation: vi.fn<() => Promise<void>>(),
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T =>
      selector({
        ...original.useAgentStore.getState(),
        continueConversation: mocks.continueConversation,
      } as StoreState),
  }
})

describe('PausedBanner (RTL)', () => {
  it('点击继续按钮调用 continueConversation', async () => {
    const user = userEvent.setup()
    render(<PausedBanner />)
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(mocks.continueConversation).toHaveBeenCalledTimes(1)
  })
})
