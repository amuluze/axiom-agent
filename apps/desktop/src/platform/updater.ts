import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauriRuntime } from './environment'

/**
 * 自更新平台封装。updater HTTP 请求、签名校验与替换安装全部在 Rust
 * tauri-plugin-updater 内完成，前端只做「检查 → 下载安装 → 重启」的编排。
 *
 * 结果分类（不让调用方解析异常字符串）：
 * - 'unavailable'  非 Tauri 运行时（浏览器 dev 模式）
 * - 'unconfigured' 插件未注册（无 plugins.updater 配置的开发/无密钥构建），
 *   Rust 侧按需注册插件，未注册时 IPC 返回 "Plugin not found"
 */
export type UpdateCheckOutcome =
  | { kind: 'unavailable' }
  | { kind: 'unconfigured' }
  | { kind: 'up-to-date' }
  | { kind: 'unsupported-target' }
  | { kind: 'available'; update: AppUpdateInfo }

export interface AppUpdateInfo {
  version: string
  currentVersion: string
  notes: string | null
  /** latest.json 的 pub_date（ISO 8601），插件侧字段名为 date。 */
  pubDate: string | null
}

export interface UpdateProgress {
  /** 已下载字节数。 */
  downloadedBytes: number
  /** 总字节数；Content-Length 缺失时为 null。 */
  totalBytes: number | null
}

/** 插件 Update 对象不跨出本模块：以版本号为键登记，安装时按版本取回。 */
const pendingUpdates = new Map<string, Update>()

const releaseUpdate = (update: Update | undefined): void => {
  // Update 继承 Resource（Rust 侧句柄），不再引用时显式释放，避免句柄泄漏。
  void update?.close().catch(() => undefined)
}

const toAppUpdateInfo = (update: Update): AppUpdateInfo => ({
  version: update.version,
  currentVersion: update.currentVersion,
  notes: update.body ?? null,
  pubDate: update.date ?? null,
})

const isPluginMissing = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /plugin not found/i.test(message)
}

/** latest.json 未提供当前架构条目（如 Intel 构建经 Rosetta 运行）时插件报 TargetNotFound。 */
const isTargetMissing = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /target not found/i.test(message)
}

export const checkForAppUpdate = async (): Promise<UpdateCheckOutcome> => {
  if (!isTauriRuntime()) return { kind: 'unavailable' }
  try {
    const update = await check()
    if (!update) return { kind: 'up-to-date' }
    // 同版本重复检查会拿到新句柄：先释放旧句柄再登记，防止 Resource 泄漏。
    releaseUpdate(pendingUpdates.get(update.version))
    pendingUpdates.set(update.version, update)
    // 周期检查下会话可能跨发布版本：旧 available 未安装时，其句柄随本次检查
    // 在 UI 层已不可达（availableUpdate 被新版本覆盖），一并释放防泄漏。
    for (const [version, pending] of pendingUpdates) {
      if (version !== update.version) {
        releaseUpdate(pending)
        pendingUpdates.delete(version)
      }
    }
    return { kind: 'available', update: toAppUpdateInfo(update) }
  } catch (error) {
    if (isPluginMissing(error)) return { kind: 'unconfigured' }
    if (isTargetMissing(error)) return { kind: 'unsupported-target' }
    throw error
  }
}

/** 下载并安装更新；进度回调按字节上报（Rust 侧流式下载，逐块触发）。 */
export const downloadAndInstallAppUpdate = async (
  version: string,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> => {
  const update = pendingUpdates.get(version)
  if (!update) {
    throw new Error(`没有待安装的更新 ${version}（请先检查更新）`)
  }
  // Progress 事件只带本次分块大小，累计值在此维护。
  let downloadedBytes = 0
  await update.downloadAndInstall((event) => {
    if (!onProgress) return
    if (event.event === 'Started') {
      downloadedBytes = 0
      onProgress({ downloadedBytes: 0, totalBytes: event.data.contentLength ?? null })
    } else if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength
      onProgress({ downloadedBytes, totalBytes: null })
    } else {
      onProgress({ downloadedBytes, totalBytes: downloadedBytes })
    }
  })
  releaseUpdate(update)
  pendingUpdates.delete(version)
}

/** 安装完成后重启应用（tauri-plugin-process restart，立即拉起新版本）。 */
export const relaunchApp = async (): Promise<void> => {
  await relaunch()
}

/** 测试专用：清空模块内登记的待安装更新。 */
export const resetPendingUpdatesForTests = (): void => {
  pendingUpdates.clear()
}
