import type { AgentAbortSettlement } from '@/agent/runtime/AgentSession'
import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import type { ProviderProfile } from '@/agent/transport/provider'
import type {
  SessionRepository,
  SessionSnapshot,
  StorageStats,
  StoredAgentSession,
} from '@/persistence/types'
import type { ProjectSkillInventorySnapshot, SkillDiagnostic } from '@/agent/skills/types'
import type { ProjectSkillDiff } from '@/agent/skills/diffProjectSkills'
import type { StorageStatsSlice } from './storageStatsSlice'

/** 设置-技能页的 reload 预览：diff 摘要 + 待应用的新快照与诊断（docs §7.3）。 */
export interface SkillReloadPreview extends ProjectSkillDiff {
  snapshot: ProjectSkillInventorySnapshot
  diagnostics: SkillDiagnostic[]
}
import type { AgentProviderSlice } from './slices/agentProviderSlice'
import type { AgentSessionManagementSlice } from './slices/agentSessionManagementSlice'
import type { AgentSessionSlice } from './slices/agentSessionSlice'
import type { AgentSettingsSlice } from './slices/agentSettingsSlice'
import type { AgentWorkspaceSlice } from './slices/agentWorkspaceSlice'

/**
 * 单一 store 的状态契约。按领域切片组合（见 slices/ 目录）：每个切片接口
 * 声明自己领域的字段与方法，agentStore 作为组合根把各切片工厂的返回值
 * spread 进同一个 zustand store。跨切片协调统一走 setState 的部分更新与
 * 显式 action 函数，不互相直接调用 store 方法。
 */
export interface AgentState extends
  AgentSessionSlice,
  AgentSessionManagementSlice,
  AgentProviderSlice,
  AgentWorkspaceSlice,
  AgentSettingsSlice,
  StorageStatsSlice {
  settingsError: string | null
  initializationError: string | null
  runtimeLifecycle: 'initializing' | 'ready' | 'failed'
  storageStats: StorageStats | null
  contextPolicySaving: boolean
  /** 当前激活工作区扫描出的 project Skill 冻结快照（供设置-技能页与提示词注入）。 */
  projectSkills: ProjectSkillInventorySnapshot
  /** 技能扫描/解析的独立诊断（不含正文；与 Hook 诊断分离）。 */
  skillDiagnostics: SkillDiagnostic[]
  /** reload 预览（重新扫描后、应用前）；null 表示无待确认的预览。 */
  skillReloadPreview: SkillReloadPreview | null
  /** 重新扫描 .axiom/skills 并生成 diff 预览（不替换 live 运行时）。 */
  previewSkillReload: () => Promise<SkillReloadPreview>
  /** 用预览快照原子应用 reload（runtime_dependencies_update）；无预览时报错。 */
  applySkillReload: () => Promise<void>
  initialize: () => Promise<void>
  retryInitialize: () => Promise<void>
  stop: () => Promise<AgentAbortSettlement>
  /** 停止指定会话的 run（含后台会话）：从运行时缓存取 harness 直接 abort，
   *  无缓存（已释放/未知 id）时返回 null。多会话并行时无需切换会话。 */
  stopSession: (sessionId: string) => Promise<AgentAbortSettlement | null>
  /** 向指定后台会话发送消息启动 run，无需切换激活会话。gating 与 send() 同口径
   *  （provider 就绪、会话绑定已授权工作区、目标 harness 空闲）；成功发起返回
   *  true。不触碰前台投影——run 状态经该会话事件订阅更新侧栏，错误写入
   *  per-session 投影。 */
  sendToSession: (sessionId: string, content: string) => Promise<boolean>
  approveToolCall: (toolCallId: string) => Promise<void>
  denyToolCall: (toolCallId: string) => Promise<void>
}

export type ProviderSaveResult =
  | { saved: false }
  | { saved: true; ready: boolean }

export type RestoredRuntimeState = Pick<
  StoredAgentSession,
  'systemPrompt' | 'reasoning' | 'activeToolNames' | 'runtimeManifest' | 'workspace'
>

export interface SessionActivationOptions {
  repository: SessionRepository
  snapshot: SessionSnapshot
  config?: ProviderProfile
  configuredKey?: boolean
  persistProvider?: boolean
  /** 激活投影的字段覆盖（如新建会话给 providerMessage）；缺省按快照默认投影。 */
  state?: Partial<AgentState>
  fallbackSessions?: StoredAgentSession[]
}

export type CommittedProjectionResult =
  | { status: 'activated' }
  | { status: 'projection_failed'; error: string }

export interface ActivateCachedRuntimeOptions {
  repository: SessionRepository
  snapshot: SessionSnapshot
  runtime: AgentHarness
  fallbackSessions?: StoredAgentSession[]
}
