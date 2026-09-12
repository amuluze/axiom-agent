import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: mocks.check,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: mocks.relaunch,
}))

vi.mock('./environment', () => ({
  isTauriRuntime: mocks.isTauriRuntime,
}))

import {
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  relaunchApp,
  resetPendingUpdatesForTests,
  type UpdateProgress,
} from './updater'

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

const fakeUpdate = (
  version: string,
  events: DownloadEvent[],
) => ({
  version,
  currentVersion: '0.2.5',
  // 插件 Update 字段名：body（notes）、date（pubDate），并需可 close() 释放句柄。
  body: '改进与修复',
  date: '2026-08-31T00:00:00Z',
  close: vi.fn(async () => undefined),
  downloadAndInstall: vi.fn(async (onEvent: (event: DownloadEvent) => void) => {
    for (const event of events) onEvent(event)
  }),
})

beforeEach(() => {
  resetPendingUpdatesForTests()
  mocks.check.mockReset()
  mocks.relaunch.mockReset()
  mocks.isTauriRuntime.mockClear()
  mocks.isTauriRuntime.mockReturnValue(true)
})

afterEach(() => {
  resetPendingUpdatesForTests()
})

describe('checkForAppUpdate 结果分类', () => {
  it('非 Tauri 运行时返回 unavailable（浏览器 dev 模式）', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    expect(await checkForAppUpdate()).toEqual({ kind: 'unavailable' })
    expect(mocks.check).not.toHaveBeenCalled()
  })

  it('无更新返回 up-to-date', async () => {
    mocks.check.mockResolvedValue(null)
    expect(await checkForAppUpdate()).toEqual({ kind: 'up-to-date' })
  })

  it('有更新返回 available 且携带版本信息', async () => {
    mocks.check.mockResolvedValue(fakeUpdate('0.3.0', []))
    const outcome = await checkForAppUpdate()
    expect(outcome).toMatchObject({
      kind: 'available',
      update: { version: '0.3.0', notes: '改进与修复' },
    })
  })

  it('插件未注册（无 updater 配置构建）归类为 unconfigured', async () => {
    mocks.check.mockRejectedValue(new Error('Command plugin:updater|check not allowed. Plugin not found'))
    expect(await checkForAppUpdate()).toEqual({ kind: 'unconfigured' })
  })

  it('latest.json 缺当前架构条目归类为 unsupported-target', async () => {
    mocks.check.mockRejectedValue(new Error('target not found: darwin-x86_64'))
    expect(await checkForAppUpdate()).toEqual({ kind: 'unsupported-target' })
  })

  it('其他错误原样抛出', async () => {
    mocks.check.mockRejectedValue(new Error('网络超时'))
    await expect(checkForAppUpdate()).rejects.toThrow('网络超时')
  })
})

describe('downloadAndInstallAppUpdate 进度累计', () => {
  it('按 Started/Progress/Finished 累计字节并回传', async () => {
    const update = fakeUpdate('0.3.0', [
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 30 } },
      { event: 'Progress', data: { chunkLength: 20 } },
      { event: 'Finished' },
    ])
    mocks.check.mockResolvedValue(update)

    // 安装必须先经 check 登记（插件 Update 对象不跨出模块）。
    await checkForAppUpdate()
    const progress: UpdateProgress[] = []
    await downloadAndInstallAppUpdate('0.3.0', (p) => progress.push(p))

    expect(progress).toEqual([
      { downloadedBytes: 0, totalBytes: 100 },
      { downloadedBytes: 30, totalBytes: null },
      { downloadedBytes: 50, totalBytes: null },
      { downloadedBytes: 50, totalBytes: 50 },
    ])
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
    // 安装完成后登记被清除、句柄被释放。
    expect(update.close).toHaveBeenCalledTimes(1)
    await expect(downloadAndInstallAppUpdate('0.3.0')).rejects.toThrow('没有待安装的更新')
  })

  it('未检查过更新时直接安装会报错', async () => {
    await expect(downloadAndInstallAppUpdate('0.3.0')).rejects.toThrow('没有待安装的更新')
  })

  it('周期检查跨发布版本时释放旧 available 句柄', async () => {
    // 长开会话里旧 available 未安装、latest.json 已更新到更高版本：旧句柄在
    // UI 层已不可达，新检查必须回收，否则 Resource 泄漏到进程结束。
    const old = fakeUpdate('0.3.0', [])
    const next = fakeUpdate('0.4.0', [])
    mocks.check.mockResolvedValueOnce(old)
    mocks.check.mockResolvedValueOnce(next)
    await checkForAppUpdate()
    await checkForAppUpdate()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(next.close).not.toHaveBeenCalled()
    await expect(downloadAndInstallAppUpdate('0.3.0')).rejects.toThrow('没有待安装的更新')
    await downloadAndInstallAppUpdate('0.4.0')
  })
})

describe('relaunchApp', () => {
  it('委托 process 插件 relaunch', async () => {
    mocks.relaunch.mockResolvedValue(undefined)
    await relaunchApp()
    expect(mocks.relaunch).toHaveBeenCalledTimes(1)
  })
})
