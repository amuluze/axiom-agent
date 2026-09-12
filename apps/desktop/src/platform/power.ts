import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './environment'

/**
 * 把设置页「保持电脑运行」同步到 Rust 侧 IOPMAssertion（PreventUserIdleSystemSleep，
 * 只阻止空闲休眠，手动睡眠/合盖休眠不受影响；assertion 随进程退出自动释放）。
 * Rust 侧幂等：重复开启/关闭为 no-op。浏览器开发模式静默降级。
 */
export const setIdleSleepPrevention = async (enabled: boolean): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('set_prevent_idle_sleep', { enabled })
}
