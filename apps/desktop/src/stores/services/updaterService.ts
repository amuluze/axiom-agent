import { useUiStore } from '@/stores/uiStore'
import { isTauriRuntime } from '@/platform/environment'
import {
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  relaunchApp,
  AppUpdateInstallError,
  type UpdateCheckOutcome,
  type UpdateInstallFailureStage,
} from '@/platform/updater'
import type { UpdateFailureState } from '@/stores/uiStore'

/**
 * 自更新服务：启动后延迟静默检查一次；此后按固定间隔周期静默复查，长开
 * 客户端也能自动发现新版本（侧栏更新徽标随 availableUpdate 即时点亮）；
 * 设置页「关于 & 更新」的检查/安装/重启也走这里的编排，保证多条入口共享
 * 同一份 uiStore 状态（不会并发下载）。
 *
 * 更新的获取、minisign 签名校验、替换与重启都由 Rust 侧 tauri-plugin-updater /
 * tauri-plugin-process 完成；本服务只做状态投影。无 updater 配置的构建（开发
 * 模式 / 无签名密钥）check 会返回 'disabled' 类结果，静默收场、不弹错误。
 */

// 启动延迟检查：避开初始化高峰（会话恢复/文档重扫），也不拖慢首帧。
const STARTUP_CHECK_DELAY_MS = 8_000

// 周期复查间隔：一次 check 只是 latest.json 小请求，1 小时让长开会话在发布
// 后也能及时收到提示；检查/下载/ready 态的重入由 checkForAppUpdateNow 门禁挡下。
export const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000
const UPDATE_FAILURE_STORAGE_KEY = 'axiom.updater.failure.v1'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const failureStageLabel = (stage: UpdateInstallFailureStage): string => ({
  download: '下载',
  signature: '签名校验',
  storage: '磁盘写入',
  replace: '应用替换',
  unknown: '安装',
})[stage]

const failureMessage = (failure: UpdateFailureState): string =>
  `更新在${failureStageLabel(failure.stage)}阶段失败：${failure.message}。未自动重启；重新检查后可手动重试。`

const persistUpdateFailure = (failure: UpdateFailureState | null): void => {
  if (typeof window === 'undefined') return
  if (failure) window.localStorage.setItem(UPDATE_FAILURE_STORAGE_KEY, JSON.stringify(failure))
  else window.localStorage.removeItem(UPDATE_FAILURE_STORAGE_KEY)
}

const loadUpdateFailure = (): UpdateFailureState | null => {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(UPDATE_FAILURE_STORAGE_KEY)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<UpdateFailureState>
    if (
      typeof value.version !== 'string'
      || typeof value.message !== 'string'
      || typeof value.failedAt !== 'string'
      || !['download', 'signature', 'storage', 'replace', 'unknown'].includes(value.stage ?? '')
    ) return null
    return value as UpdateFailureState
  } catch {
    return null
  }
}

const clearUpdateFailure = (): void => {
  persistUpdateFailure(null)
  useUiStore.getState().patchUpdater({ updateFailure: null })
}

const applyOutcome = (outcome: UpdateCheckOutcome): void => {
  clearUpdateFailure()
  const ui = useUiStore.getState()
  switch (outcome.kind) {
    case 'available':
      ui.patchUpdater({
        updatePhase: 'idle',
        availableUpdate: outcome.update,
        updateProgress: null,
        updateMessage: null,
        updateFailure: null,
      })
      break
    case 'up-to-date':
      ui.patchUpdater({
        updatePhase: 'uptodate',
        availableUpdate: null,
        updateProgress: null,
        updateMessage: null,
      })
      break
    case 'unconfigured':
      ui.patchUpdater({
        updatePhase: 'disabled',
        availableUpdate: null,
        updateProgress: null,
        updateMessage: '当前构建未启用自更新（开发模式或无签名凭据），请从官网下载新版本',
      })
      break
    case 'unsupported-target':
      ui.patchUpdater({
        updatePhase: 'disabled',
        availableUpdate: null,
        updateProgress: null,
        updateMessage: '当前架构暂无自动更新包（仅提供 Apple Silicon 版本），请从官网下载',
      })
      break
    case 'unavailable':
      ui.patchUpdater({
        updatePhase: 'disabled',
        availableUpdate: null,
        updateProgress: null,
        updateMessage: '更新检查仅在 Axiom 桌面版中可用',
      })
      break
  }
}

export type UpdateCheckStatus = 'available' | 'up-to-date' | 'disabled'

/**
 * 检查更新（设置页手动触发与启动静默检查共用）。
 * silent = 启动静默检查：失败不进 error 态（用户没有主动发起，不打扰），
 * 只回退到 idle；手动检查失败进 error 并抛出，供分区组件展示。
 */
export const checkForAppUpdateNow = async (
  options?: { silent?: boolean },
): Promise<UpdateCheckStatus> => {
  if (!isTauriRuntime()) {
    applyOutcome({ kind: 'unavailable' })
    return 'disabled'
  }
  const current = useUiStore.getState().updatePhase
  // 检查/下载进行中不允许重入：并发 check 与 downloadAndInstall 都没有意义。
  // ready（已下载待重启）同样短路：周期复查若覆盖 ready，会丢「重启生效」提示。
  if (current === 'checking' || current === 'downloading' || current === 'ready') {
    return useUiStore.getState().availableUpdate ? 'available' : 'disabled'
  }
  useUiStore.getState().patchUpdater({ updatePhase: 'checking', updateMessage: null })
  try {
    const outcome = await checkForAppUpdate()
    applyOutcome(outcome)
    if (outcome.kind === 'available') return 'available'
    if (outcome.kind === 'up-to-date') return 'up-to-date'
    return 'disabled'
  } catch (error) {
    if (options?.silent) {
      useUiStore.getState().patchUpdater({ updatePhase: 'idle', updateMessage: null })
      return 'disabled'
    }
    useUiStore.getState().patchUpdater({
      updatePhase: 'error',
      updateMessage: `检查更新失败：${errorMessage(error)}`,
    })
    throw error
  }
}

/** 下载并安装已发现的更新；完成后进入 ready（等待用户重启生效）。 */
export const installPendingUpdate = async (): Promise<void> => {
  const state = useUiStore.getState()
  const update = state.availableUpdate
  if (!update) return
  if (state.updateFailure?.version === update.version) {
    throw new Error(`更新 ${update.version} 上次安装失败，请先重新检查更新再手动重试`)
  }
  useUiStore.getState().patchUpdater({
    updatePhase: 'downloading',
    updateProgress: null,
    updateMessage: null,
    updateFailure: null,
  })
  try {
    await downloadAndInstallAppUpdate(update.version, (progress) => {
      useUiStore.getState().patchUpdater({ updateProgress: progress })
    })
    useUiStore.getState().patchUpdater({ updatePhase: 'ready', updateProgress: null })
  } catch (error) {
    const failure: UpdateFailureState = {
      version: update.version,
      stage: error instanceof AppUpdateInstallError ? error.stage : 'unknown',
      message: errorMessage(error),
      failedAt: new Date().toISOString(),
    }
    persistUpdateFailure(failure)
    useUiStore.getState().patchUpdater({
      updatePhase: 'error',
      updateMessage: failureMessage(failure),
      updateFailure: failure,
    })
    throw error
  }
}

/** 重启应用以完成更新（process 插件 restart，立即拉起新版本）。 */
export const relaunchAfterUpdate = async (): Promise<void> => {
  await relaunchApp()
}

let serviceStarted = false
let periodicTimer: ReturnType<typeof setInterval> | null = null

/** 幂等启动：main.tsx 渲染后调用一次，浏览器 dev 模式下为空操作。 */
export const initUpdaterService = (): void => {
  if (serviceStarted || !isTauriRuntime()) return
  serviceStarted = true
  const failure = loadUpdateFailure()
  if (failure) {
    useUiStore.getState().patchUpdater({
      updatePhase: 'error',
      updateMessage: failureMessage(failure),
      updateFailure: failure,
    })
  }
  setTimeout(() => {
    void checkForAppUpdateNow({ silent: true }).catch(() => undefined)
  }, STARTUP_CHECK_DELAY_MS)
  // 长开客户端的周期兜底：启动静默检查只覆盖一次，会话跨发布周期时由定时器
  // 继续发现新版本。失败静默回退 idle；重入/ready 由 checkForAppUpdateNow 挡下。
  periodicTimer = setInterval(() => {
    void checkForAppUpdateNow({ silent: true }).catch(() => undefined)
  }, PERIODIC_CHECK_INTERVAL_MS)
}

/** 测试专用：重置模块级状态（含周期定时器）。 */
export const resetUpdaterServiceForTests = (options?: { preserveFailure?: boolean }): void => {
  serviceStarted = false
  if (periodicTimer !== null) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
  if (!options?.preserveFailure) persistUpdateFailure(null)
}
