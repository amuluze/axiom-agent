/**
 * 电脑控制设置的纯叶子模块（照 browserSettings 同款约定）：零 import 依赖、
 * localStorage 持久化 + 模块级 live binding，供 platform 层在控制动作前置
 * 门控时同步读取（非 React 消费方不经过 store）。
 *
 * 注意：这是「用户偏好层」的开关；真正的权限权威在 Rust（macOS 辅助功能/
 * 屏幕录制权限 + 会话级门 + allowlist 文件），开关关闭只是第一道前置拦截。
 */

export interface ComputerSettings {
  enabled: boolean
}

const STORAGE_KEY = 'axiom.computer.config.v1'

const DEFAULT_SETTINGS: ComputerSettings = {
  enabled: false,
}

let activeSettings: ComputerSettings = loadComputerSettings()

export function loadComputerSettings(): ComputerSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS }
    const candidate = parsed as Partial<ComputerSettings>
    return {
      enabled: candidate.enabled === true,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveComputerSettings(settings: ComputerSettings): void {
  activeSettings = { enabled: settings.enabled === true }
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(activeSettings))
  } catch {
    // 写入失败（隐私模式/配额）：live binding 仍生效，本次进程内行为一致。
  }
}

/** 非同步窗口的即时读取（platform 门控用）。 */
export function getComputerSettings(): ComputerSettings {
  return activeSettings
}
