import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

import { submitFeedback, type FeedbackSubmission } from './feedback'

describe('submitFeedback', () => {
  afterEach(() => {
    mocks.invoke.mockReset()
  })

  it('invokes submit_feedback with the camelCase request payload', async () => {
    mocks.invoke.mockResolvedValue({ ok: true, ref: '#AX-2481', deduped: false })
    const request: FeedbackSubmission = {
      kind: 'feature',
      title: '导出会话时保留完整的工具调用顺序',
      description: 'Markdown 导出把工具调用折叠成一行摘要。',
      contact: 'liang@example.com',
    }
    const response = await submitFeedback(request)
    expect(mocks.invoke).toHaveBeenCalledWith('submit_feedback', { request })
    expect(response).toEqual({ ok: true, ref: '#AX-2481', deduped: false })
  })

  it('propagates submission failures (Rust 权威错误文案直接进入弹窗横幅)', async () => {
    mocks.invoke.mockRejectedValue('反馈服务返回 500：internal error')
    await expect(
      submitFeedback({ kind: 'bug', title: 't', description: 'd', contact: 'c' }),
    ).rejects.toEqual('反馈服务返回 500：internal error')
  })
})
