import { isTauriRuntime } from '@/platform/environment'

export type AgentCapability =
  | 'filesystem:read'
  | 'workspace:read'
  | 'workspace:write'
  | 'workspace:execute'
  | 'subagent:explore'
  | 'subagent:review'
  | 'web:read'
  | 'web:browser'
  | 'computer:control'
  | 'ssh:remote'

export interface RuntimePolicy {
  mode: 'development' | 'production'
  desktop: boolean
  allowDemoProvider: boolean
  allowInitializationFallback: boolean
  requireConfiguredProvider: boolean
  toolCapabilities: AgentCapability[]
}

export interface RuntimePolicyEnvironment {
  development: boolean
  desktop: boolean
}

export const createRuntimePolicy = ({
  development,
  desktop,
}: RuntimePolicyEnvironment): RuntimePolicy => ({
  mode: development ? 'development' : 'production',
  desktop,
  allowDemoProvider: development,
  allowInitializationFallback: development,
  requireConfiguredProvider: !development,
  toolCapabilities: [
    ...(desktop
      ? [
          'filesystem:read' as const,
          'workspace:read' as const,
          'workspace:write' as const,
          'workspace:execute' as const,
          // SubAgent 委派：desktop 默认授予两类只读委派能力。注册由
          // workspace:read + 各自 capability 共同控制（createToolRegistry），
          // discover-gated 不进入默认激活集。
          'subagent:explore' as const,
          'subagent:review' as const,
          // web 只读访问（web_search / web_fetch）：desktop 默认授予，公网
          // 主机白名单校验由 Rust 权威执行；工具 discover-gated 不默认激活。
          'web:read' as const,
          // browser 工具（CDP 驱动的隔离浏览器）：desktop 默认授予；实际放行由
          // 设置页开关（localStorage）+ Rust 侧 spawn fail-closed 共同控制，
          // 注册仅看 capability 以保证旧会话恢复安全。
          'web:browser' as const,
          // computer 工具（macOS 电脑控制）：desktop 默认授予；实际放行由
          // 设置页开关 + Rust 会话门/allowlist fail-closed 共同控制，注册仅看
          // capability 以保证旧会话恢复安全。
          'computer:control' as const,
          // ssh 工具（Agent 远程执行）：desktop 默认授予；实际放行由逐次审批
          // （lease 绑定 {host, command}）+ Rust 会话授权表 fail-closed 共同
          // 控制，注册仅看 capability。discover-gated 不进默认激活集。
          'ssh:remote' as const,
        ]
      : []),
  ],
})

export const RUNTIME_POLICY = createRuntimePolicy({
  development: import.meta.env.DEV,
  desktop: isTauriRuntime(),
})
