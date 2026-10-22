import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/config/browserSettings', () => ({
  getBrowserSettings: () => ({ enabled: true }),
}))

import { resolveBrowserLocator } from './browserSession'

describe('resolveBrowserLocator', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('ensures the browser is running, then forwards the locator and returns the unique ref', async () => {
    mocks.invoke.mockImplementation(async (_command: string, args: { request: { action: string } }) =>
      args.request.action === 'ensureRunning'
        ? { type: 'status' }
        : {
            type: 'locatorResolved',
            resolution: {
              status: 'unique',
              candidate: { ref: 42, role: 'textbox', name: '优惠券代码', disabled: false },
            },
          })

    const resolution = await resolveBrowserLocator('tab-1', { role: 'textbox', name: '优惠券' })

    expect(resolution).toEqual({
      status: 'unique',
      candidate: { ref: 42, role: 'textbox', name: '优惠券代码', disabled: false },
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('browser_command', {
      request: { action: 'resolveLocator', tabId: 'tab-1', locator: { role: 'textbox', name: '优惠券' } },
    })
  })

  it('passes ambiguous results through without choosing a candidate', async () => {
    mocks.invoke.mockImplementation(async (_command: string, args: { request: { action: string } }) =>
      args.request.action === 'ensureRunning'
        ? { type: 'status' }
        : {
            type: 'locatorResolved',
            resolution: {
              status: 'ambiguous',
              total: 2,
              candidates: [
                { ref: 1, role: 'button', name: '删除', disabled: false },
                { ref: 2, role: 'button', name: '删除订单', disabled: false },
              ],
            },
          })

    const resolution = await resolveBrowserLocator('tab-1', { role: 'button', name: '删除' })

    expect(resolution).toMatchObject({ status: 'ambiguous', total: 2 })
  })

  it('rejects a response of another kind instead of guessing', async () => {
    mocks.invoke.mockImplementation(async (_command: string, args: { request: { action: string } }) =>
      args.request.action === 'ensureRunning' ? { type: 'status' } : { type: 'done' })

    await expect(resolveBrowserLocator('tab-1', { css: 'div' })).rejects.toThrow('非定位结果')
  })
})
