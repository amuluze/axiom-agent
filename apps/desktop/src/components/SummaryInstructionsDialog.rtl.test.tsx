// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MAX_SUMMARY_INSTRUCTION_BYTES } from '@/agent/context/summaryInstructions'
import { SummaryInstructionsDialog } from './SummaryInstructionsDialog'

describe('SummaryInstructionsDialog (RTL)', () => {
  it('提交时把修剪后的自定义指令传给 onSubmit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<SummaryInstructionsDialog mode="compaction" onCancel={vi.fn()} onSubmit={onSubmit} />)
    await user.type(screen.getByPlaceholderText(/重点保留/), '  保留 checkpoint 决定  ')
    await user.click(screen.getByRole('button', { name: '开始压缩' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ customInstructions: '保留 checkpoint 决定' })
  })

  it('空指令提交时只传空对象，不附带 customInstructions', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<SummaryInstructionsDialog mode="compaction" onCancel={vi.fn()} onSubmit={onSubmit} />)
    await user.click(screen.getByRole('button', { name: '开始压缩' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({})
  })

  it('字节数超过上限时禁用提交按钮且不触发 onSubmit', async () => {
    const onSubmit = vi.fn()
    render(<SummaryInstructionsDialog mode="compaction" onCancel={vi.fn()} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByPlaceholderText(/重点保留/), {
      target: { value: 'a'.repeat(MAX_SUMMARY_INSTRUCTION_BYTES + 1) },
    })
    const submit = screen.getByRole('button', { name: '开始压缩' })
    expect(submit).toBeDisabled()
    expect(screen.getByText(/指令超过安全上限/)).toBeInTheDocument()
    fireEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('branch 模式下勾选替换复选框后提交带 replaceInstructions', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<SummaryInstructionsDialog mode="branch" onCancel={vi.fn()} onSubmit={onSubmit} />)
    const checkbox = screen.getByRole('checkbox', { name: /替换默认分支摘要指令/ })
    expect(checkbox).toBeDisabled()
    await user.type(screen.getByPlaceholderText(/重点保留/), '保留分支摘要')
    expect(checkbox).toBeEnabled()
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: '生成并分支' }))
    expect(onSubmit).toHaveBeenCalledWith({
      customInstructions: '保留分支摘要',
      replaceInstructions: true,
    })
  })

  it('按 Escape 触发 onCancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<SummaryInstructionsDialog mode="compaction" onCancel={onCancel} onSubmit={vi.fn()} />)
    screen.getByPlaceholderText(/重点保留/).focus()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
