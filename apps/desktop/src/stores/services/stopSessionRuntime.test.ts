import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stopSessionRuntime } from './stopSessionRuntime'

const mocks = vi.hoisted(() => ({ native: true, retire: vi.fn() }))
vi.mock('@/platform/environment', () => ({ isTauriRuntime: () => mocks.native }))
// 停止走单条收口命令（held Automatic 模式 + 会话撤销代际同一次 Rust 调用），
// 不再是「撤销代际」与「降级模式」两段 IPC——降级失败保留更高权限即 fail-open。
vi.mock('@/platform/sessionAuthorization', () => ({ retireSessionAuthority: mocks.retire }))

const deferred = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('stopSessionRuntime', () => {
  beforeEach(() => {
    mocks.native = true
    mocks.retire.mockReset().mockResolvedValue(undefined)
  })

  it('先取消运行，同时收口目标会话权限，等待两边收口', async () => {
    const execution = deferred()
    const retirement = deferred()
    mocks.retire.mockReturnValue(retirement.promise)
    const abort = vi.fn(() => execution.promise)
    let settled = false
    const stopping = stopSessionRuntime({ id: 'background-session', abortAndWait: abort }, vi.fn())
      .then(() => { settled = true })
    expect(abort).toHaveBeenCalledOnce()
    await Promise.resolve()
    // 单次调用即完成权限收口：不存在「只撤销代际、模式降级失败」的中间态。
    expect(mocks.retire).toHaveBeenCalledTimes(1)
    expect(mocks.retire).toHaveBeenCalledWith('background-session')
    expect(settled).toBe(false)
    retirement.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    execution.resolve()
    await stopping
    expect(settled).toBe(true)
  })

  it('收口错误可见，同时仍等待运行取消', async () => {
    const error = new Error('原生通道不可用')
    mocks.retire.mockRejectedValue(error)
    const report = vi.fn()
    const execution = deferred()
    const stopping = stopSessionRuntime({ id: 's1', abortAndWait: () => execution.promise }, report)
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(error))
    execution.resolve()
    await stopping
  })

  it('非原生运行时只收口模型循环', async () => {
    mocks.native = false
    const abort = vi.fn().mockResolvedValue(undefined)
    await stopSessionRuntime({ id: 's1', abortAndWait: abort }, vi.fn())
    expect(abort).toHaveBeenCalledOnce()
    expect(mocks.retire).not.toHaveBeenCalled()
  })
})
