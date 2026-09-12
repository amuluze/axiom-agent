import { describe, expect, it, vi } from 'vitest'
import { createProjectDocsRefreshScheduler } from './projectDocsRefresh'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

describe('createProjectDocsRefreshScheduler', () => {
  it('空闲时触发立即执行一轮，结束后回到空闲', async () => {
    const refresh = vi.fn(async () => undefined)
    const scheduler = createProjectDocsRefreshScheduler(refresh)
    scheduler.trigger()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(false))
  })

  it('在途触发合并为尾沿：当前轮结束后补扫一轮，不丢最后一次触发', async () => {
    const gate1 = deferred()
    const gate2 = deferred()
    const refresh = vi.fn()
      .mockImplementationOnce(() => gate1.promise)
      .mockImplementationOnce(() => gate2.promise)
    const scheduler = createProjectDocsRefreshScheduler(refresh)

    scheduler.trigger()
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(true))

    // 在途期间的两次触发合并为一个 pending：不丢弃（否则尾沿写入被漏扫），
    // 也不各自排队一轮（最终一致只需再扫一次最新磁盘）。
    scheduler.trigger()
    scheduler.trigger()
    gate1.resolve()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))

    gate2.resolve()
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(false))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('在途触发不产生并发轮（单飞）', async () => {
    const gate = deferred()
    const refresh = vi.fn().mockImplementationOnce(() => gate.promise)
    const scheduler = createProjectDocsRefreshScheduler(refresh)

    scheduler.trigger()
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(true))
    scheduler.trigger()
    scheduler.trigger()
    // 第 1 轮挂起期间，合并的触发不启动新轮
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(scheduler.inFlight).toBe(true)

    gate.resolve()
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(false))
  })

  it('单轮失败 fail-soft：不中断补扫轮', async () => {
    const gate = deferred()
    const refresh = vi.fn()
      .mockImplementationOnce(() => gate.promise.then(() => { throw new Error('boom') }))
      .mockImplementationOnce(async () => undefined)
    const scheduler = createProjectDocsRefreshScheduler(refresh)

    scheduler.trigger()
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(true))
    scheduler.trigger()
    gate.resolve()
    // 第 1 轮抛错后，被合并的尾沿触发仍得到补扫轮
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(false))
  })

  it('全部结束后再次触发会启动新一轮', async () => {
    const refresh = vi.fn(async () => undefined)
    const scheduler = createProjectDocsRefreshScheduler(refresh)
    scheduler.trigger()
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(false))
    scheduler.trigger()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  })
})
