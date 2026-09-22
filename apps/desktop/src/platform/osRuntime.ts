import { getRuntimeInfo } from './runtimeInfo'

/**
 * 运行 OS 的同步事实源（UI 平台限制提示共用）。
 *
 * Rust 侧 `get_runtime_info` 用 `std::env::consts::OS` 上报真实系统
 * （'macos' | 'linux' | …，浏览器开发模式回落 navigator.platform）。
 * 探测是异步的而组件渲染是同步的：App 启动时经 `primeOperatingSystem`
 * 预热一次，成功后写入 uiStore（组件经 store 订阅重渲染）并把
 * `data-os` 挂到 `<html>`（CSS 平台分支消费，如 Linux 无交通灯安全区）。
 * 预热完成前按 'macos' 处理——默认平台宁后到，不误报限制提示。
 */

let operatingSystem = 'macos'

export const primeOperatingSystem = async (): Promise<string> => {
  try {
    operatingSystem = (await getRuntimeInfo()).operatingSystem
  } catch {
    // 探测失败保持默认（macOS）：限制提示宁缺勿误。
  }
  document.documentElement.dataset.os = operatingSystem
  return operatingSystem
}

export const currentOperatingSystem = (): string => operatingSystem

export const isLinuxRuntime = (): boolean => operatingSystem === 'linux'
