import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkForAppUpdate: vi.fn(),
  downloadAndInstallAppUpdate: vi.fn(),
  relaunchApp: vi.fn(),
}))

vi.mock('@/platform/updater', () => ({
  checkForAppUpdate: mocks.checkForAppUpdate,
  downloadAndInstallAppUpdate: mocks.downloadAndInstallAppUpdate,
  relaunchApp: mocks.relaunchApp,
}))

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: () => true,
}))

import { useUiStore, type UpdatePhase } from '@/stores/uiStore'
import {
  PERIODIC_CHECK_INTERVAL_MS,
  checkForAppUpdateNow,
  initUpdaterService,
  installPendingUpdate,
  relaunchAfterUpdate,
  resetUpdaterServiceForTests,
} from './updaterService'

const updaterState = () => {
  const state = useUiStore.getState()
  return {
    phase: state.updatePhase,
    available: state.availableUpdate,
    message: state.updateMessage,
    progress: state.updateProgress,
  }
}

const resetUpdaterSlice = () => {
  useUiStore.setState({
    updatePhase: 'idle' satisfies UpdatePhase,
    availableUpdate: null,
    updateProgress: null,
    updateMessage: null,
  })
}

beforeEach(() => {
  resetUpdaterSlice()
  resetUpdaterServiceForTests()
  vi.useFakeTimers()
  mocks.checkForAppUpdate.mockReset()
  mocks.downloadAndInstallAppUpdate.mockReset()
  mocks.relaunchApp.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('updaterService 检查更新', () => {
  it('发现新版本时写入 availableUpdate 并保持 idle（等待用户决定安装）', async () => {
    mocks.checkForAppUpdate.mockResolvedValue({
      kind: 'available',
      update: { version: '0.3.0', notes: '修复', pubDate: null },
    })
    const status = await checkForAppUpdateNow()
    expect(status).toBe('available')
    expect(updaterState()).toMatchObject({
      phase: 'idle',
      available: { version: '0.3.0' },
    })
  })

  it('已是最新版本时进入 uptodate', async () => {
    mocks.checkForAppUpdate.mockResolvedValue({ kind: 'up-to-date' })
    expect(await checkForAppUpdateNow()).toBe('up-to-date')
    expect(updaterState().phase).toBe('uptodate')
  })

  it('未配置 updater 时进入 disabled 并带指引文案', async () => {
    mocks.checkForAppUpdate.mockResolvedValue({ kind: 'unconfigured' })
    expect(await checkForAppUpdateNow()).toBe('disabled')
    expect(updaterState()).toMatchObject({
      phase: 'disabled',
      message: expect.stringContaining('未启用自更新'),
    })
  })

  it('检查失败进入 error 并抛出（手动入口可展示）', async () => {
    mocks.checkForAppUpdate.mockRejectedValue(new Error('网络不可达'))
    await expect(checkForAppUpdateNow()).rejects.toThrow('网络不可达')
    expect(updaterState()).toMatchObject({
      phase: 'error',
      message: '检查更新失败：网络不可达',
    })
  })

  it('checking/downloading 期间重入被拒绝（不并发检查）', async () => {
    let resolveCheck: (value: unknown) => void = () => undefined
    mocks.checkForAppUpdate.mockImplementation(
      () => new Promise((resolve) => {
        resolveCheck = resolve
      }),
    )
    const first = checkForAppUpdateNow()
    const second = await checkForAppUpdateNow()
    // 重入直接按当前 availableUpdate 归类，不再发起新检查。
    expect(second).toBe('disabled')
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1)
    resolveCheck({ kind: 'up-to-date' })
    await first
  })
})

describe('updaterService 安装与重启', () => {
  it('安装期间流式上报进度，完成后进入 ready', async () => {
    useUiStore.setState({
      availableUpdate: { version: '0.3.0', notes: null, pubDate: null },
    })
    mocks.downloadAndInstallAppUpdate.mockImplementation(
      async (_version: string, onProgress: (p: { downloadedBytes: number; totalBytes: number | null }) => void) => {
        onProgress({ downloadedBytes: 10, totalBytes: 100 })
        onProgress({ downloadedBytes: 55, totalBytes: 100 })
      },
    )
    await installPendingUpdate()
    expect(updaterState()).toMatchObject({
      phase: 'ready',
      progress: null,
    })
    expect(mocks.downloadAndInstallAppUpdate).toHaveBeenCalledWith(
      '0.3.0',
      expect.any(Function),
    )
  })

  it('安装失败进入 error 并抛出', async () => {
    useUiStore.setState({
      availableUpdate: { version: '0.3.0', notes: null, pubDate: null },
    })
    mocks.downloadAndInstallAppUpdate.mockRejectedValue(new Error('签名校验失败'))
    await expect(installPendingUpdate()).rejects.toThrow('签名校验失败')
    expect(updaterState()).toMatchObject({
      phase: 'error',
      message: '安装更新失败：签名校验失败',
    })
  })

  it('没有待安装更新时空操作', async () => {
    await installPendingUpdate()
    expect(mocks.downloadAndInstallAppUpdate).not.toHaveBeenCalled()
  })

  it('relaunchAfterUpdate 委托 process 插件', async () => {
    mocks.relaunchApp.mockResolvedValue(undefined)
    await relaunchAfterUpdate()
    expect(mocks.relaunchApp).toHaveBeenCalledTimes(1)
  })
})

describe('updaterService 启动静默检查', () => {
  it('init 后延迟检查一次，失败静默回退 idle 不抛出', async () => {
    initUpdaterService()
    expect(mocks.checkForAppUpdate).not.toHaveBeenCalled()
    mocks.checkForAppUpdate.mockRejectedValue(new Error('离线'))
    await vi.advanceTimersByTimeAsync(8_500)
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1)
    // 静默检查失败不打扰：不进 error 态，也不抛未处理 rejection。
    expect(updaterState().phase).toBe('idle')
  })

  it('重复 init 为空操作', async () => {
    initUpdaterService()
    initUpdaterService()
    mocks.checkForAppUpdate.mockResolvedValue({ kind: 'up-to-date' })
    await vi.advanceTimersByTimeAsync(8_500)
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('updaterService 周期静默检查', () => {
  it('init 后按间隔复查，长开客户端自动发现新版本并点亮侧栏徽标', async () => {
    mocks.checkForAppUpdate.mockResolvedValue({ kind: 'up-to-date' })
    initUpdaterService()
    await vi.advanceTimersByTimeAsync(8_500)
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1)
    // 会话跨发布周期：下一个间隔的复查发现新版本，经同一编排写入 availableUpdate。
    mocks.checkForAppUpdate.mockResolvedValue({
      kind: 'available',
      update: { version: '0.4.0', notes: null, pubDate: null },
    })
    await vi.advanceTimersByTimeAsync(PERIODIC_CHECK_INTERVAL_MS)
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(2)
    expect(updaterState()).toMatchObject({
      phase: 'idle',
      available: { version: '0.4.0' },
    })
  })

  it('ready（已下载待重启）态下复查被短路，不覆盖重启提示', async () => {
    useUiStore.setState({
      updatePhase: 'ready' satisfies UpdatePhase,
      availableUpdate: { version: '0.3.0', notes: null, pubDate: null },
    })
    initUpdaterService()
    // 启动检查与多个周期 tick 全部到达，ready 门禁均不放行。
    await vi.advanceTimersByTimeAsync(8_500 + 2 * PERIODIC_CHECK_INTERVAL_MS)
    expect(mocks.checkForAppUpdate).not.toHaveBeenCalled()
    expect(updaterState()).toMatchObject({
      phase: 'ready',
      available: { version: '0.3.0' },
    })
  })

  it('reset 清除周期定时器', async () => {
    mocks.checkForAppUpdate.mockResolvedValue({ kind: 'up-to-date' })
    initUpdaterService()
    await vi.advanceTimersByTimeAsync(8_500)
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1)
    resetUpdaterServiceForTests()
    await vi.advanceTimersByTimeAsync(2 * PERIODIC_CHECK_INTERVAL_MS)
    expect(mocks.checkForAppUpdate).toHaveBeenCalledTimes(1)
  })
})
