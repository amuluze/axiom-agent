// @vitest-environment jsdom
import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageActions, type MessageActionRole } from './MessageActions'

const writeText = vi.fn<(text: string) => Promise<void>>()

const stubClipboard = () => {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

interface RenderOptions {
  role?: MessageActionRole
  text?: string
  busy?: boolean
  branchable?: boolean
  summarizable?: boolean
  retryable?: boolean
  editable?: boolean
}

const renderActions = (options: RenderOptions = {}) => {
  const onBranch = vi.fn()
  const onSummarizedBranch = vi.fn()
  const onRetry = vi.fn()
  const onEdit = vi.fn()
  const view = render(createElement(MessageActions, {
    role: options.role ?? 'assistant',
    text: options.text ?? '内容',
    busy: options.busy ?? false,
    branchable: options.branchable ?? false,
    summarizable: options.summarizable ?? false,
    retryable: options.retryable ?? false,
    editable: options.editable ?? false,
    onBranch,
    onSummarizedBranch,
    onRetry,
    onEdit,
  }))
  return { ...view, onBranch, onSummarizedBranch, onRetry, onEdit }
}

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  stubClipboard()
})

afterEach(() => {
  // 只替换了 clipboard 属性，删除桩避免泄漏到其它测试文件。
  delete (window.navigator as { clipboard?: unknown }).clipboard
})

describe('MessageActions', () => {
  it('renders only copy and edit for a user message', () => {
    renderActions({ role: 'user', editable: true })

    expect(screen.getByLabelText('复制消息')).toBeTruthy()
    expect(screen.getByLabelText('编辑这条用户消息并重发')).toBeTruthy()
    expect(screen.queryByLabelText('从这条回答消息创建分支')).toBeNull()
    expect(screen.queryByLabelText('在新分支重试这条回答')).toBeNull()
  })

  it('renders only the branch actions that are available for an agent message', () => {
    renderActions({ branchable: true, summarizable: false, retryable: true })

    expect(screen.getByLabelText('从这条回答消息创建分支')).toBeTruthy()
    expect(screen.getByLabelText('在新分支重试这条回答')).toBeTruthy()
    expect(screen.queryByLabelText('总结后从这条回答消息创建分支')).toBeNull()
    expect(screen.queryByLabelText('编辑这条用户消息并重发')).toBeNull()
  })

  it('invokes the matching handler for each agent action', () => {
    const actions = renderActions({ branchable: true, summarizable: true, retryable: true })

    fireEvent.click(screen.getByLabelText('从这条回答消息创建分支'))
    fireEvent.click(screen.getByLabelText('总结后从这条回答消息创建分支'))
    fireEvent.click(screen.getByLabelText('在新分支重试这条回答'))

    expect(actions.onBranch).toHaveBeenCalledTimes(1)
    expect(actions.onSummarizedBranch).toHaveBeenCalledTimes(1)
    expect(actions.onRetry).toHaveBeenCalledTimes(1)
  })

  it('writes the message text to the clipboard and flips to the copied label', async () => {
    renderActions({ role: 'user' })
    fireEvent.click(screen.getByLabelText('复制消息'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('内容'))
    expect(screen.getByLabelText('已复制')).toBeTruthy()
  })

  it('falls back to the failed label when the clipboard rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    renderActions({ role: 'user' })
    fireEvent.click(screen.getByLabelText('复制消息'))
    await waitFor(() => expect(screen.getByLabelText('复制失败')).toBeTruthy())
  })

  it('resets the feedback label after two seconds', async () => {
    vi.useFakeTimers()
    try {
      renderActions({ role: 'user' })
      fireEvent.click(screen.getByLabelText('复制消息'))
      // flush copy() 的 await 链并让 React 提交状态更新。
      await act(async () => { await Promise.resolve() })
      expect(screen.getByLabelText('已复制')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(2000) })
      expect(screen.getByLabelText('复制消息')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders no copy button for blank content', () => {
    renderActions({ role: 'user', text: '   ', editable: true })

    expect(screen.queryByLabelText('复制消息')).toBeNull()
    expect(screen.getByLabelText('编辑这条用户消息并重发')).toBeTruthy()
  })

  it('disables session-mutating actions while the session is busy', () => {
    renderActions({ role: 'user', editable: true, busy: true })

    expect(screen.getByLabelText('会话忙，暂时无法编辑这条用户消息')).toBeDisabled()
  })

  it('explains why editing is unavailable without a branch boundary', () => {
    renderActions({ role: 'user', editable: false })

    expect(screen.getByLabelText('这条用户消息之前没有安全的分支边界，无法编辑')).toBeDisabled()
  })
})
