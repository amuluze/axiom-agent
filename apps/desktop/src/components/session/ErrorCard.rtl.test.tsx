// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCard } from './ErrorCard'

const mocks = vi.hoisted(() => ({
  retryFailedAssistant: vi.fn(),
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      retryFailedAssistant: mocks.retryFailedAssistant,
    } as StoreState),
  }
})

afterEach(() => {
  mocks.retryFailedAssistant.mockClear()
})

describe('ErrorCard interactions', () => {
  it('retries the failed run in the current session', () => {
    render(<ErrorCard messageId="m-1" error="error decoding response body" />)
    screen.getByRole('button', { name: '重试' }).click()
    expect(mocks.retryFailedAssistant).toHaveBeenCalledOnce()
    expect(mocks.retryFailedAssistant).toHaveBeenCalledWith('m-1')
  })
})
