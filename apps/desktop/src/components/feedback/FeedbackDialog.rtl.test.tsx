// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedbackDialog } from './FeedbackDialog'

const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn(),
  closeFeedback: vi.fn(),
}))

vi.mock('@/platform/feedback', () => ({
  submitFeedback: mocks.submitFeedback,
}))

vi.mock('@/stores/uiStore', () => ({
  useUiStore: Object.assign(
    (selector: (state: { closeFeedback: () => void }) => () => void) =>
      selector({ closeFeedback: mocks.closeFeedback }),
    { getState: () => ({ closeFeedback: mocks.closeFeedback }) },
  ),
}))

import type { FeedbackRequest } from '@/stores/uiStore'

const request: FeedbackRequest = { kind: 'feature' }

afterEach(() => {
  mocks.submitFeedback.mockReset()
  mocks.closeFeedback.mockReset()
})

/**
 * 渲染并等待一帧 rAF 落定。useDialogFocus 经 requestAnimationFrame 延迟一帧
 * 聚焦首控件；全量套件高负载下这一帧可能插进 user.type 打字中途，把焦点从
 * 输入框抢走并吞掉后续按键（表现为计数器少字符）。rAF 回调按排队顺序执行，
 * 组件的聚焦回调先于这里等待的帧回调，落定后交互即无竞态。
 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

const renderDialog = async (): Promise<void> => {
  render(<FeedbackDialog request={request} />)
  await nextFrame()
}

describe('FeedbackDialog (RTL)', () => {
  it('渲染默认态：预选类型、四项字段与「全部为必填项」提示', async () => {
    await renderDialog()
    expect(screen.getByRole('dialog', { name: '需求 / 问题反馈' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /功能需求/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /缺陷问题/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('全部为必填项')).toBeInTheDocument()
    expect(screen.getByText('0 / 2000')).toBeInTheDocument()
  })

  it('空表单提交：显示逐项错误与「请修正 3 处问题」，不发起提交', async () => {
    const user = userEvent.setup()
    await renderDialog()
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(screen.getByText('请填写标题')).toBeInTheDocument()
    expect(screen.getByText('请填写描述')).toBeInTheDocument()
    expect(screen.getByText('请填写联系方式')).toBeInTheDocument()
    expect(screen.getByText('请修正 3 处问题')).toBeInTheDocument()
    expect(mocks.submitFeedback).not.toHaveBeenCalled()
  })

  it('类型卡可再点一次取消选中，出现「请选择反馈类型」错误', async () => {
    const user = userEvent.setup()
    await renderDialog()
    await user.click(screen.getByRole('button', { name: /功能需求/ }))
    expect(screen.getByRole('button', { name: /功能需求/ })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(screen.getByText('请选择反馈类型')).toBeInTheDocument()
    expect(screen.getByText('请修正 4 处问题')).toBeInTheDocument()
  })

  it('填写完整后提交成功：显示回执与单号，可「再提一条」', async () => {
    const user = userEvent.setup()
    mocks.submitFeedback.mockResolvedValue({ ok: true, ref: '#AX-2481', deduped: false })
    await renderDialog()
    await user.type(screen.getByPlaceholderText(/一句话概括/), '导出会话时保留完整的工具调用顺序')
    await user.type(screen.getByPlaceholderText(/补充背景/), 'Markdown 导出把工具调用折叠成一行摘要。')
    await user.type(screen.getByPlaceholderText(/邮箱 \/ 微信 \/ 飞书/), 'liang@example.com')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(mocks.submitFeedback).toHaveBeenCalledWith({
      kind: 'feature',
      title: '导出会话时保留完整的工具调用顺序',
      description: 'Markdown 导出把工具调用折叠成一行摘要。',
      contact: 'liang@example.com',
    })
    await waitFor(() => {
      expect(screen.getByText('反馈已提交')).toBeInTheDocument()
    })
    expect(screen.getByText('单号 #AX-2481')).toBeInTheDocument()
    expect(screen.getByText(/我们会通过 liang@example.com 回复/)).toBeInTheDocument()
    // 成功态头部隐藏、按钮切换为「再提一条 / 完成」。
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再提一条' })).toBeInTheDocument()
    // 再提一条回到空白表单（保留入口预选类型）。
    await user.click(screen.getByRole('button', { name: '再提一条' }))
    expect(screen.getByPlaceholderText(/一句话概括/)).toHaveValue('')
    expect(screen.getByText('全部为必填项')).toBeInTheDocument()
  })

  it('成功态点击「完成」或按 Escape 关闭弹窗', async () => {
    const user = userEvent.setup()
    mocks.submitFeedback.mockResolvedValue({ ok: true, ref: '#AX-9', deduped: false })
    await renderDialog()
    await user.type(screen.getByPlaceholderText(/一句话概括/), 't')
    await user.type(screen.getByPlaceholderText(/补充背景/), 'd')
    await user.type(screen.getByPlaceholderText(/邮箱 \/ 微信 \/ 飞书/), 'c')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => {
      expect(screen.getByText('反馈已提交')).toBeInTheDocument()
    })
    // 回归：完成按钮曾是 type=submit，成功态点击被 submit 处理器吞掉。
    await user.click(screen.getByRole('button', { name: '完成' }))
    expect(mocks.closeFeedback).toHaveBeenCalledTimes(1)
  })

  it('提交失败：横幅展示原因、主按钮变「重试」，重试成功后进入成功态', async () => {
    const user = userEvent.setup()
    mocks.submitFeedback
      .mockRejectedValueOnce('网络连接异常，请检查网络后重试')
      .mockResolvedValueOnce({ ok: true, ref: '#AX-7', deduped: false })
    await renderDialog()
    await user.type(screen.getByPlaceholderText(/一句话概括/), 't')
    await user.type(screen.getByPlaceholderText(/补充背景/), 'd')
    await user.type(screen.getByPlaceholderText(/邮箱 \/ 微信 \/ 飞书/), 'c')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        '提交失败：网络连接异常，请检查网络后重试',
      )
    })
    expect(screen.getByText('提交失败，请重试')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/一句话概括/)).toHaveValue('t')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.submitFeedback).toHaveBeenCalledTimes(2)
    await waitFor(() => {
      expect(screen.getByText('单号 #AX-7')).toBeInTheDocument()
    })
  })

  it('提交中：按钮禁用且 label 切换为提交中，Escape 不再关闭', async () => {
    const user = userEvent.setup()
    let resolveSubmit: (value: { ok: boolean; ref: string | null; deduped: boolean }) => void = () => {}
    mocks.submitFeedback.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve
      }),
    )
    await renderDialog()
    await user.type(screen.getByPlaceholderText(/一句话概括/), 't')
    await user.type(screen.getByPlaceholderText(/补充背景/), 'd')
    await user.type(screen.getByPlaceholderText(/邮箱 \/ 微信 \/ 飞书/), 'c')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(screen.getByText('正在提交，请勿关闭窗口')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(mocks.closeFeedback).not.toHaveBeenCalled()
    resolveSubmit({ ok: true, ref: null, deduped: true })
    await waitFor(() => {
      expect(screen.getByText(/已合并到既有反馈/)).toBeInTheDocument()
    })
  })

  it('编辑态按 Escape 关闭弹窗', async () => {
    const user = userEvent.setup()
    await renderDialog()
    screen.getByPlaceholderText(/一句话概括/).focus()
    await user.keyboard('{Escape}')
    expect(mocks.closeFeedback).toHaveBeenCalledTimes(1)
  })

  it('描述字数计数器随输入更新，maxLength 限制 2000 字', async () => {
    const user = userEvent.setup()
    await renderDialog()
    const description = screen.getByPlaceholderText(/补充背景/)
    expect(description).toHaveAttribute('maxlength', '2000')
    await user.type(description, 'abc')
    expect(screen.getByText('3 / 2000')).toBeInTheDocument()
  })
})
