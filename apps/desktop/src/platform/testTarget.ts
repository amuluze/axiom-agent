import { invoke } from '@tauri-apps/api/core'

/** 测试目标授权（U1-2）的 Rust 镜像：授权绑定 runId + tabId + origin + 工作区代际。 */
export interface TestTargetGrantInfo {
  runId: string
  tabId: string
  origin: string
  workspaceGeneration: number
  viewport: { width: number; height: number } | null
}

/**
 * 用户选定 Browser Rail tab 后签发授权。Rust 会再次读取 tab 当前 origin 与预期比对，
 * WebView 传入的 origin 只是期望值，不构成信任依据。
 */
export const issueTestTargetGrant = (request: {
  runId: string
  tabId: string
  expectedOrigin: string
  viewport?: { width: number; height: number }
  /**
   * 运行环境 ID（可选）：受信档（`approvalMode = trusted`）的放行作用域由 Rust 按
   * 环境记录在**授权时**算一次并冻结在本次运行的目标授权里。
   */
  environmentId?: string
}): Promise<TestTargetGrantInfo> =>
  invoke<TestTargetGrantInfo>('issue_test_target_grant', { request })

export const revokeTestTargetGrant = (runId: string): Promise<boolean> =>
  invoke<boolean>('revoke_test_target_grant', { runId })
