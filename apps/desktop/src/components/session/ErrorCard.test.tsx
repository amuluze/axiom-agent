import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCard } from './ErrorCard'
import type { AssistantMessage } from '@/agent/core/types'

const mocks = vi.hoisted(() => ({
  retryFailedAssistant: vi.fn(),
  setRuntimeRailOpen: vi.fn(),
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

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      setRuntimeRailOpen: mocks.setRuntimeRailOpen,
    } as UiState),
  }
})

afterEach(() => {
  mocks.retryFailedAssistant.mockClear()
  mocks.setRuntimeRailOpen.mockClear()
})

describe('ErrorCard', () => {
  it('renders the 运行失败 header with the AlertTriangle icon', () => {
    const html = renderToStaticMarkup(createElement(ErrorCard, {
      messageId: 'm-1',
      error: 'npm test 退出码 1',
    }))
    expect(html).toContain('运行失败')
    expect(html).toContain('lucide-triangle-alert')
    expect(html).toContain('role="alert"')
  })

  it('renders the error body text', () => {
    const html = renderToStaticMarkup(createElement(ErrorCard, {
      messageId: 'm-1',
      error: 'npm test 退出码 1：3 个用例未通过',
    }))
    expect(html).toContain('npm test 退出码 1：3 个用例未通过')
  })

  it('renders the friendly userMessage headline above the technical detail', () => {
    const message = {
      id: 'm-1',
      createdAt: 1,
      role: 'assistant',
      content: '',
      toolCalls: [],
      stopReason: 'error',
      providerError: {
        kind: 'server',
        message: 'HTTP 503: Service is too busy. Please retry later.',
        status: 503,
        retryable: true,
        userMessage: '模型服务暂时不可用（HTTP 503），已自动重试仍失败，请稍后重试或切换其他模型',
      },
    } as const
    const html = renderToStaticMarkup(createElement(ErrorCard, {
      messageId: 'm-1',
      error: 'HTTP 503: Service is too busy. Please retry later.',
      message: message as unknown as AssistantMessage,
    }))
    expect(html).toContain('模型服务暂时不可用（HTTP 503），已自动重试仍失败，请稍后重试或切换其他模型')
    expect(html).toContain('session__error-card-message')
    expect(html).toContain('HTTP 503: Service is too busy. Please retry later.')
    expect(html).toContain('session__error-card-detail')
  })

  it('renders both 查看日志 and 重试 action buttons', () => {
    const html = renderToStaticMarkup(createElement(ErrorCard, {
      messageId: 'm-1',
      error: 'fail',
    }))
    expect(html).toContain('查看日志')
    expect(html).toContain('重试')
    expect(html).toMatch(/<button[^>]*>查看日志<\/button>/u)
  })

  it('uses the correct CSS classes for the error scaffold', () => {
    const html = renderToStaticMarkup(createElement(ErrorCard, {
      messageId: 'm-1',
      error: 'fail',
    }))
    expect(html).toContain('session__error-card')
    expect(html).toContain('session__error-card-head')
    expect(html).toContain('session__error-card-body')
    expect(html).toContain('session__error-card-actions')
  })
})
