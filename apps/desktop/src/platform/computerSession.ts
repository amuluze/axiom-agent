import { invoke } from '@tauri-apps/api/core'
import { getComputerSettings } from '@/config/computerSettings'

/**
 * computer 工具的平台封装：命令名以字面量出现在 `invoke` 调用中，供
 * `tauri-capability-audit` 做 handler ↔ capability ↔ 前端三向漂移审计。
 * 安全边界（macOS 双权限、会话级门 + 应用 allowlist、kill switch）全部由
 * Rust `computer_control.rs` 权威执行，本层只做类型化转发与启用门控。
 *
 * 请求/响应类型与 Rust 侧 `ComputerCommandRequest`/`ComputerCommandResponse`
 * 逐字镜像（serde tag=action/type + camelCase 字段），改任一侧必须同步另一侧。
 *
 * 会话门：控制类动作携带 sessionId（工具层从执行上下文注入）；面板/设置页
 * 只调用观察与管理类动作（status/requestAccess/allowApp/unallowApp/stop），
 * 不经会话门。开关门控在本层前置拦截（未启用直接报错），Rust 侧另有权限
 * fail-closed——双前置是浏览器工具同款分层。
 */

export type ComputerAccessKind = 'accessibility' | 'screenRecording'

export type ComputerCommandRequest =
  | { action: 'status' }
  | { action: 'requestAccess'; kind: ComputerAccessKind }
  | { action: 'listApps' }
  | { action: 'openApp'; sessionId: string; name?: string; bundleId?: string }
  | { action: 'listWindows'; pid?: number }
  | { action: 'appState'; pid?: number; bundleId?: string; includeScreenshot?: boolean }
  | { action: 'screenshot'; pid?: number }
  | {
      action: 'clickElement'
      sessionId: string
      stateToken: string
      elementId: number
    }
  | {
      action: 'setValue'
      sessionId: string
      stateToken: string
      elementId: number
      text: string
    }
  | {
      action: 'clickAt'
      sessionId: string
      x: number
      y: number
      button?: string
      clicks?: number
    }
  | {
      action: 'scrollAt'
      sessionId: string
      x: number
      y: number
      deltaX?: number
      deltaY?: number
    }
  | {
      action: 'typeText'
      sessionId: string
      text: string
      stateToken?: string
      elementId?: number
    }
  | {
      action: 'pressKey'
      sessionId: string
      key: string
      modifiers?: string[]
      stateToken?: string
      elementId?: number
    }
  | { action: 'stop'; sessionId?: string }
  | { action: 'allowApp'; bundleId: string; name: string }
  | { action: 'unallowApp'; bundleId: string }

export interface ComputerAppInfo {
  pid: number
  bundleId?: string
  name: string
  frontmost: boolean
}

export interface ComputerWindowInfo {
  windowId: number
  title: string
  focused: boolean
  bounds: [number, number, number, number]
}

export interface ComputerScreenshot {
  imageBase64: string
  mimeType: string
  width: number
  height: number
  resized: boolean
}

export interface ComputerGrantInfo {
  sessionId: string
  pid: number
  appName: string
}

export interface ComputerAllowedApp {
  bundleId: string
  name: string
}

export type ComputerCommandResponse =
  | {
      type: 'status'
      accessibility: boolean
      screenRecording: boolean
      grants: ComputerGrantInfo[]
      allowlist: ComputerAllowedApp[]
    }
  | { type: 'apps'; apps: ComputerAppInfo[] }
  | { type: 'appOpened'; app: ComputerAppInfo }
  | { type: 'windows'; windows: ComputerWindowInfo[] }
  | {
      type: 'state'
      stateToken: string
      app: ComputerAppInfo
      tree: string
      truncated: boolean
      screenshot?: ComputerScreenshot
    }
  | { type: 'screenshot' } & ComputerScreenshot
  | { type: 'done' }

/** 需要会话门 + 设置开关的控制类动作。 */
const CONTROL_ACTIONS = new Set<ComputerCommandRequest['action']>([
  'openApp',
  'clickElement',
  'setValue',
  'clickAt',
  'scrollAt',
  'typeText',
  'pressKey',
])

export const computerCommand = async (
  request: ComputerCommandRequest,
): Promise<ComputerCommandResponse> => {
  if (CONTROL_ACTIONS.has(request.action)) {
    const settings = getComputerSettings()
    if (!settings.enabled) {
      throw new Error('电脑控制未启用：请在 设置 → 电脑控制 打开开关并保存')
    }
  }
  return invoke<ComputerCommandResponse>('computer_command', { request })
}

// ---------------------------------------------------------------------------
// 设置页 / 面板消费的薄封装（观察与管理动作，不经会话门）
// ---------------------------------------------------------------------------

export const computerStatus = (): Promise<ComputerCommandResponse> =>
  invoke<ComputerCommandResponse>('computer_command', { request: { action: 'status' } })

export const requestComputerAccess = (
  kind: ComputerAccessKind,
): Promise<ComputerCommandResponse> =>
  invoke<ComputerCommandResponse>('computer_command', {
    request: { action: 'requestAccess', kind },
  })

export const stopComputerControl = (
  sessionId?: string,
): Promise<ComputerCommandResponse> =>
  invoke<ComputerCommandResponse>('computer_command', {
    request: { action: 'stop', ...(sessionId ? { sessionId } : {}) },
  })

export const allowComputerApp = (
  bundleId: string,
  name: string,
): Promise<ComputerCommandResponse> =>
  invoke<ComputerCommandResponse>('computer_command', {
    request: { action: 'allowApp', bundleId, name },
  })

export const unallowComputerApp = (bundleId: string): Promise<ComputerCommandResponse> =>
  invoke<ComputerCommandResponse>('computer_command', {
    request: { action: 'unallowApp', bundleId },
  })
