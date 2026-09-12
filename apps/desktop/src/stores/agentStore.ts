import type {
  AgentEvent,
  AgentMessage,
  AgentMutationBatch,
  AgentMutationReceipt,
} from '@/agent/core/types'
import { createId } from '@/agent/core/id'
import type { ContextCheckpoint } from '@/agent/context/types'
import {
  createContextPolicy,
  normalizeContextPolicySettings,
  type ContextPolicySettings,
} from '@/agent/context/types'
import {
  ApprovalCoordinator,
  buildAccessModeBeforeToolCall,
  evaluateAccessModeToolCall,
} from '@/agent/approval/ApprovalCoordinator'
import type {
  BeforeToolCall,
  BeforeToolCallResult,
} from '@/agent/core/types'
import { useUiStore, getGitBranchPrefix, getProjectSkillsEnabled } from '@/stores/uiStore'
import {
  AgentHarness,
  AgentHarnessOperationCoordinator,
} from '@/agent/runtime/AgentHarness'
import type {
  AgentMutationJournal,
  AgentSessionJournalEntry,
} from '@/agent/runtime/mutationJournal'
import {
  registerProductRuntimeHooks,
} from '@/agent/runtime/productRuntimeHooks'
import { createProductToolRuntime, buildSystemPrompt } from '@/agent/runtime/productToolRuntime'
import { createSubAgentRuntime } from '@/agent/subagent/SubAgentRuntime'
import { createSubAgentObservationSink } from './services/subAgentObservability'
import { buildSessionBasePrompt } from '@/agent/prompt/systemPromptSections'
import { loadProjectContext } from '@/agent/prompt/projectContext'
import { loadProjectDocs, projectDocInventoryEqual, EMPTY_PROJECT_DOC_INVENTORY, type ProjectDocInventory } from '@/agent/prompt/projectDocs'
import { createProjectDocsRefreshScheduler } from './services/projectDocsRefresh'
import { ensureSshApprovalGrantMirror, sshHostGrantedForSession } from './services/sshApprovalGrants'
import { reconcileSessionPromptOnActivation } from './services/sessionPromptReconcile'
import { bindActiveProjectSkillSnapshot, getActiveProjectSkillSnapshot } from '@/agent/skills/activeProjectSkills'
import { loadProjectSkills } from '@/agent/skills/loadProjectSkills'
import { diffProjectSkills } from '@/agent/skills/diffProjectSkills'
import { formatAvailableSkills } from '@/agent/skills/formatAvailableSkills'
import { EMPTY_PROJECT_SKILL_INVENTORY } from '@/agent/skills/types'
import type { ProjectSkillInventorySnapshot, ProjectSkillSource, SkillDiagnostic } from '@/agent/skills/types'
import {
  BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS,
  type ProviderSecretMigrationReceipt,
} from '@/agent/transport/ProviderCredentialRuntime'
import {
  normalizeReasoningSettings,
  toModelReasoning,
  type ReasoningSettings,
} from '@/agent/runtime/reasoningSettings'
import type {
  AgentLimitsSettings,
} from '@/agent/runtime/agentLimitsSettings'
import {
  assertRuntimeDependenciesCompatible,
  createRuntimeDependencyManifest,
  runtimeDependencyManifestsEqual,
  type RuntimeDependencyManifest,
} from '@/agent/runtime/runtimeDependencyManifest'
import { RuntimeObservability } from '@/agent/runtime/observability'
import { RuntimeHookDiagnostics } from '@/agent/runtime/RuntimeHookRegistry'
import { wrapSlowHookDiagnostics } from './slowHookDiagnostics'
import {
  BUILTIN_PROVIDER_RUNTIME,
  createProviderSetupRequiredTransport,
  createProviderTransport,
  DEMO_PROVIDER_CONFIG,
  providerRequiresApiKey,
  resolvePromptModelName,
  resolveProviderModel,
  resolveSessionProviderConfig,
  type ProviderProfile,
} from '@/agent/transport/provider'
import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import { migrateToolName } from '@/agent/tools/toolNameMigrations'
import { bindProviderHost } from '@/agent/transport/providerHost'
import { createDesktopProviderHost } from '@/platform/providerHost'
import {
  listAuthorizedReadFiles,
  type AuthorizedReadFile,
} from '@/platform/authorizedFiles'
import { isTauriRuntime } from '@/platform/environment'
import { runtimeFaultCheckpoint } from '@/platform/runtimeFaultInjection'
import {
  bindAgentEnvironment,
  desktopAgentEnvironment,
} from '@/agent/environment/agentEnvironmentHost'
import { createDesktopAgentEnvironment } from '@/platform/desktopAgentEnvironment'
import {
  requestWorkspaceApprovalLease,
  setWorkspaceApprovalMode,
} from '@/platform/workspaceApproval'
import {
  activateAuthorizedWorkspace,
  restoreAuthorizedWorkspaces,
} from '@/platform/workspace'
import { createSessionRepository } from '@/persistence/createSessionRepository'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'
import type {
  SessionDefaults,
  SessionRepository,
  SessionSnapshot,
  StoredAgentSession,
} from '@/persistence/types'
import { create } from 'zustand'
import {
  hydrateSessionMetadata,
  hydrateSessionsMetadata,
  persistedWorkspacePaths,
} from './services/sessionMetadata'
import {
  loadProviderProfiles,
  loadProviderSelection,
  mergeProviderProfile,
  persistProviderConfig,
  persistProviderState,
} from './services/providerStorage'
import {
  activeContextPolicySettings,
  activeQueueModeSettings,
  activeReasoningSettings,
  activeAgentLimitsSettings,
  setActiveContextPolicySettings,
  setActiveReasoningSettings,
} from './settingsPersistence'
import {
  getRuntimeBasePrompt,
  getRuntimeProjection,
  getRuntimeProvider,
  getRuntimeSession,
  setRuntimeBasePrompt,
  setRuntimeProvider,
  setRuntimeProjection,
  setRuntimeSession,
  setRuntimeEvictionListener,
} from './runtimeCaches'
import {
  createMutationBindings,
  getRepository,
  recordRuntimeEvent,
  setRepository,
} from './repositoryCore'
import { applySessionActivationState, applySessionEvent, queuedMessageStateFor, type AgentCoreProjection } from './sessionActivationCore'
import {
  queuedMessageState as queuedMessageStateForSession,
  type StoreRuntimeDeps,
} from './sessionActions'
import {
  sessionWorkspacePaths,
} from './workspaceActions'
import { createStorageStatsSlice } from './storageStatsSlice'
import type {
  ActivateCachedRuntimeOptions,
  AgentState,
  CommittedProjectionResult,
  RestoredRuntimeState,
  SessionActivationOptions,
  SkillReloadPreview,
} from './agentStateTypes'
import { createAgentProviderSlice, initialProvider } from './slices/agentProviderSlice'
import { createAgentSessionManagementSlice } from './slices/agentSessionManagementSlice'
import { createAgentSessionSlice } from './slices/agentSessionSlice'
import { createAgentSettingsSlice } from './slices/agentSettingsSlice'
import { createAgentWorkspaceSlice } from './slices/agentWorkspaceSlice'
import {
  garbageCollectMigratedProviderSecrets,
  migrateProviderSecret,
  stageProviderSecretCleanupIntent,
  type ProviderSecretMigrationBindings,
} from './services/providerSecretMigration'

// Provider 传输运行时宿主接线：仅 Tauri 桌面环境绑定 Rust 权威宿主（解析经
// provider_profiles 强校验，密钥/网络走 Keychain 与 model_http）。非 Tauri（浏览器
// demo 与离线测试）不绑定，回退 providerHost.ts 的默认宿主（reference 解析器 +
// fail-closed 密钥/网络桩）。
if (isTauriRuntime()) bindProviderHost(createDesktopProviderHost())
if (isTauriRuntime()) bindAgentEnvironment(createDesktopAgentEnvironment())
// SSH 会话授权镜像：订阅 Rust「本会话内允许该主机」事件（免审批卡预检用，
// 权威校验仍在 Rust lease 签发路径）。
if (isTauriRuntime()) ensureSshApprovalGrantMirror()

/**
 * The Provider Secret migration service is a pure helper that does not import
 * the runtime-side migration singleton (the capability audit hard-locks that
 * import to this file). Bind the singleton once here and pass the resulting
 * bindings into every call site.
 */
const providerSecretMigrationBindings: ProviderSecretMigrationBindings = {
  migrate: (profile, migration) => BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS.migrate(profile, migration),
  retireSource: (receipt) => BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS.retireSource(receipt),
  retireLegacySource: (sourceSecretId) => BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS.retireLegacySource(sourceSecretId),
}

// 运行时缓存丢弃（LRU 逐出 / 删会话）时同步清理工作区映射：被丢弃的会话必然
// 已空闲且 harness 已 dispose，不会再发起审批，条目只占内存；重激活时经
// createRuntimeSession / activateCachedRuntimeSession 重建。经回调注册而非让
// runtimeCaches 直接 import workspaceActions——那会形成模块环（workspaceActions
// 已依赖 runtimeCaches）。删会话路径的显式 delete 保留（幂等，见红线 ①）。
setRuntimeEvictionListener((sessionId) => {
  sessionWorkspacePaths.delete(sessionId)
})

// 主 Agent 系统提示词：基准分节（人设/协作/工作流）+ 能力门控安全段 +
// 授权上下文段 + 工具发现说明，最后由 buildSystemPrompt 追加可用能力与工具准则段。
// 提示词文本集中在 src/agent/prompt/systemPromptSections.ts，上层只做能力→段落的映射。
// 会话提示词一律由 sessionDefaults / createRuntimeSession 按当前 ProviderProfile
// 动态组装（含 # 角色 中的模型身份行），不保留模块级静态提示词常量；绑定工作区或
// 存在授权文件的会话由 createRuntimeSession 用 buildSessionBasePrompt 重建，并把
// 同一份 basePrompt 传给 productRuntimeHooks 做工具准则回流。
const DESKTOP_TOOL_RUNTIME = createProductToolRuntime(
  RUNTIME_POLICY.toolCapabilities,
  desktopAgentEnvironment,
)
const REGISTERED_TOOLS = DESKTOP_TOOL_RUNTIME.tools
const DEFAULT_ACTIVE_TOOL_NAMES = DESKTOP_TOOL_RUNTIME.activeToolNames
// 产品 SubAgent 运行时：无状态精简工厂，delegate 每次构造独立子会话；父 run 累计
// ledger 由 AgentSession 按 prompt 调用维护并注入 binding。
const productSubAgentRuntime = createSubAgentRuntime()
// 子会话 Provider 观察 sink：归并到父 run 内存，不落 repository（首版空实现）。
const subAgentObservationSink = createSubAgentObservationSink()
// state.authorizedFiles 的模块级镜像：createRuntimeSession 在模块初始化阶段
// （useAgentStore 尚未创建）也要读取授权文件列表来组装会话提示词，因此不能
// 直接访问 store。所有写入 authorizedFiles 状态的位置必须同步更新此镜像。
let activeAuthorizedReadFiles: AuthorizedReadFile[] = []
// 已加载的工作区 AGENTS.md 正文镜像：与 activeAuthorizedReadFiles 同源——
// createRuntimeSession 同步消费它组装会话提示词的 # 项目上下文 段，而文件
// 读取是异步的，因此在每条工作区激活路径（初始化、会话切换、新建会话）中
// 调用 refreshProjectContext 异步刷新、bindSession 前确保就绪。无工作区或
// 文件缺失时为 null，提示词会省略 # 项目上下文 段。
let activeProjectContext: string | null = null
// 已扫描的工作区 SDD 文档索引镜像：refreshProjectContext 扫描 .specs/.plans/.docs
// 后更新，供 createRuntimeSession 组装 # 项目上下文 段的 <available_docs> 子块。
// 无工作区或目录缺失时为 EMPTY_PROJECT_DOC_INVENTORY（提示词省略该子块）。
let activeProjectDocs: ProjectDocInventory = EMPTY_PROJECT_DOC_INVENTORY
// 当前活动会话的 session-scoped 基准提示词（不含工具段）：createRuntimeSession
// 构建 sessionBasePrompt 后同步更新，productRuntimeHooks 的 getBasePrompt() 读取
// 最新值。reload（runtime_dependencies_update 提交新 systemPrompt）后必须更新本
// 镜像，否则 prepare_next_turn 用旧 basePrompt 重拼会静默冲掉新注入的
// `<available_skills>`（对齐 docs/skills-extension.md §6.1）。
let activeSessionBasePrompt = ''
// 当前活动会话的 Runtime dependency manifest 镜像：bindSession 构建 currentManifest
// 后同步更新；reload 用它作为 `runtime_dependencies_update` 的 previous 载荷。
let activeRuntimeManifest: RuntimeDependencyManifest | null = null

/**
 * 按给定工作区根目录异步加载 AGENTS.md 并扫描 SDD 文档索引，更新模块级镜像。
 * 必须在 bindSession → createRuntimeSession 重建会话提示词前调用，
 * 使 # 项目上下文 段（AGENTS.md 正文 + <available_docs>）反映当前会话绑定的
 * 工作区。无工作区时清空两镜像。仅 Tauri 运行时读取；浏览器开发模式静默降级。
 */
const refreshProjectContext = async (workspacePath?: string): Promise<void> => {
  const environment = workspacePath && isTauriRuntime()
    ? createDesktopAgentEnvironment(workspacePath)
    : null
  activeProjectContext = environment
    ? await loadProjectContext(environment)
    : null
  activeProjectDocs = environment
    ? await loadProjectDocs(environment)
    : EMPTY_PROJECT_DOC_INVENTORY
}
/**
 * 检查 formatAvailableSkills 的 32 KiB metadata 预算省略，为每个被省略的 skill
 * 生成 metadata_budget_exceeded 诊断（此前该 diagnostic code 声明了但无人 push）。
 */
const appendBudgetDiagnostics = (
  snapshot: ProjectSkillInventorySnapshot,
  diagnostics: SkillDiagnostic[],
): SkillDiagnostic[] => {
  const { omittedSkillNames } = formatAvailableSkills(snapshot)
  if (omittedSkillNames.length === 0) return diagnostics
  const ts = Date.now()
  const source: ProjectSkillSource = { kind: 'project', root: '.axiom/skills' }
  return [
    ...diagnostics,
    ...omittedSkillNames.map((name) => {
      const skill = snapshot.skills.find((s) => s.name === name)
      return {
        code: 'metadata_budget_exceeded' as const,
        source,
        relativePath: skill?.relativePath ?? name,
        message: `技能 metadata 因 32 KiB 注入预算被省略，未进入提示词清单；可通过 $${name} 手动指定`,
        timestamp: ts,
      }
    }),
  ]
}

// 当前会话 project Skill 快照的 store 镜像：refreshProjectSkills 扫描 .axiom/skills
// 后同时更新模块级宿主（供 load_skill 工具与 createRuntimeSession 同步消费）与
// store state（供设置-技能页读取）。扫描本身 fail-soft，绝不阻断会话激活。
const refreshProjectSkills = async (workspacePath?: string): Promise<void> => {
  const environment = workspacePath && isTauriRuntime()
    ? createDesktopAgentEnvironment(workspacePath)
    : null
  const result = environment
    ? await loadProjectSkills(environment)
    : { snapshot: EMPTY_PROJECT_SKILL_INVENTORY, diagnostics: [] }
  bindActiveProjectSkillSnapshot(result.snapshot)
  useAgentStore.setState({
    projectSkills: result.snapshot,
    skillDiagnostics: appendBudgetDiagnostics(result.snapshot, result.diagnostics),
  })
}

/**
 * 用给定 snapshot 原子应用技能 reload：会话 idle 时经 runtime_dependencies_update
 * 替换 live dependencies（systemPrompt + activeToolNames + manifest + checkpoint
 * 失效），commit 成功后更新 prompt source / manifest 镜像与 store 快照；忙碌或
 * 无会话时只更新 store 快照（后续新建/激活会话生效）。失败时维持旧状态（文档 §7.3 步骤 7）。
 */
const applyProjectSkillsToSession = async (
  result: { snapshot: ProjectSkillInventorySnapshot; diagnostics: SkillDiagnostic[] },
): Promise<void> => {
  const active = session
  if (active && !active.isRunning) {
    const previousManifest = activeRuntimeManifest
    if (!previousManifest) throw new Error('当前会话缺少 Runtime dependency manifest')
    const config = useAgentStore.getState().provider
    const workspacePath = useAgentStore.getState().authorizedWorkspace?.path
    const activeToolNames = Array.from(active.activeToolNames)
    const newBasePrompt = buildSessionBasePrompt({
      capabilities: RUNTIME_POLICY.toolCapabilities,
      workspacePath,
      authorizedFilePaths: activeAuthorizedReadFiles.map((file) => file.path),
      projectContext: activeProjectContext,
      projectSkills: result.snapshot,
      projectDocs: activeProjectDocs,
      modelName: resolvePromptModelName(config),
    })
    const newSystemPrompt = buildSystemPrompt({
      basePrompt: newBasePrompt,
      tools: REGISTERED_TOOLS,
      activeToolNames,
      gitBranchPrefix: getGitBranchPrefix(),
    })
    const currentManifest = createRuntimeDependencyManifest(
      config,
      REGISTERED_TOOLS,
      active.hooks.dependencies(),
      result.snapshot,
    )
    await active.updateRuntimeDependencies({
      previous: {
        systemPrompt: active.systemPrompt,
        activeToolNames,
        runtimeManifest: previousManifest,
      },
      current: {
        systemPrompt: newSystemPrompt,
        activeToolNames,
        runtimeManifest: currentManifest,
      },
    })
    activeSessionBasePrompt = newBasePrompt
    setRuntimeBasePrompt(active.id, newBasePrompt)
    activeRuntimeManifest = currentManifest
  }
  bindActiveProjectSkillSnapshot(result.snapshot)
  useAgentStore.setState({
    projectSkills: result.snapshot,
    skillDiagnostics: appendBudgetDiagnostics(result.snapshot, result.diagnostics),
  })
}

/**
 * 用重扫得到的文档索引更新 <available_docs> 镜像并按需重建会话提示词。
 * 与 {@link applyProjectSkillsToSession} 同构（idle 时经 runtime_dependencies_update
 * 替换 systemPrompt + manifest，忙碌时只更新镜像、后续会话构建生效），差别在于
 * 文档不进技能 snapshot——manifest 只依赖 skills，systemPrompt 才消费文档索引。
 */
const applyProjectDocsToSession = async (inventory: ProjectDocInventory): Promise<void> => {
  const previousDocs = activeProjectDocs
  activeProjectDocs = inventory
  const active = session
  if (!active || active.isRunning) return
  const previousManifest = activeRuntimeManifest
  if (!previousManifest) return
  const config = useAgentStore.getState().provider
  const workspacePath = useAgentStore.getState().authorizedWorkspace?.path
  const activeToolNames = Array.from(active.activeToolNames)
  const newBasePrompt = buildSessionBasePrompt({
    capabilities: RUNTIME_POLICY.toolCapabilities,
    workspacePath,
    authorizedFilePaths: activeAuthorizedReadFiles.map((file) => file.path),
    projectContext: activeProjectContext,
    projectSkills: getActiveProjectSkillSnapshot(),
    projectDocs: inventory,
    modelName: resolvePromptModelName(config),
  })
  const newSystemPrompt = buildSystemPrompt({
    basePrompt: newBasePrompt,
    tools: REGISTERED_TOOLS,
    activeToolNames,
    gitBranchPrefix: getGitBranchPrefix(),
  })
  const currentManifest = createRuntimeDependencyManifest(
    config,
    REGISTERED_TOOLS,
    active.hooks.dependencies(),
    getActiveProjectSkillSnapshot(),
  )
  try {
    await active.updateRuntimeDependencies({
      previous: {
        systemPrompt: active.systemPrompt,
        activeToolNames,
        runtimeManifest: previousManifest,
      },
      current: {
        systemPrompt: newSystemPrompt,
        activeToolNames,
        runtimeManifest: currentManifest,
      },
    })
  } catch (error) {
    // 提交失败回滚镜像：维持旧提示词与镜像一致，下次 run 结束重扫会再尝试。
    activeProjectDocs = previousDocs
    throw error
  }
  activeSessionBasePrompt = newBasePrompt
  setRuntimeBasePrompt(active.id, newBasePrompt)
  activeRuntimeManifest = currentManifest
}

/**
 * 激活边界对账的候选提示词：与 prepare_next_turn 回流（productRuntimeHooks）
 * 用同一输入构建——harness 当前的工具集与激活集、全局分支前缀设置。保持一致
 * 才能让「无漂移」时深比较相等（零副作用），也让对账结果与后续回流稳定同值。
 */
const buildReconcileCandidateSystemPrompt = (harness: AgentHarness, basePrompt: string): string =>
  buildSystemPrompt({
    basePrompt,
    tools: harness.runtimeContext.tools,
    activeToolNames: Array.from(harness.activeToolNames),
    gitBranchPrefix: getGitBranchPrefix(),
  })

/**
 * run 结束后的延迟文档索引刷新（单轮刷新体）：等待会话完全 idle 后重扫受管目录，
 * 索引有变化才重建提示词。覆盖所有写入路径（write/edit/apply_changes/restore_trash
 * 以及无法可靠解析参数的 bash），无需逐工具匹配参数——未变化时零副作用。
 * fail-soft：刷新失败只跳过该轮（会话激活路径仍会兜底刷新）。
 *
 * 每轮从当前激活会话起算：触发所属会话若已被切换走，刷新对当前会话自洽执行
 * （扫描当前授权工作区、应用到当前会话，深比较未变化即零副作用）——切换路径的
 * 会话激活本身会全量重扫，并由激活边界的提示词对账（reconcileSessionPromptOnActivation）
 * 把漂移写入 live 提示词，不依赖本刷新。
 */
const refreshProjectDocsOnce = async (): Promise<void> => {
  const active = session
  if (!active || active.isDisposed) return
  const boundSessionId = useAgentStore.getState().activeSessionId
  await active.waitForIdle()
  // 等待期间用户可能已切换会话：只为刷新开始时即为激活态的会话应用结果。
  if (useAgentStore.getState().activeSessionId !== boundSessionId) return
  const workspacePath = useAgentStore.getState().authorizedWorkspace?.path
  if (!workspacePath || !isTauriRuntime()) return
  const inventory = await loadProjectDocs(createDesktopAgentEnvironment(workspacePath))
  if (projectDocInventoryEqual(inventory, activeProjectDocs)) return
  await applyProjectDocsToSession(inventory)
}

/**
 * 调度器（尾沿合并单飞）：agent_end 连续触发（重试/队列排空）时，在途刷新期间
 * 到达的触发不丢弃而是合并为补扫轮——在途扫描可能已读过旧磁盘，丢弃尾沿会让
 * 索引停留在旧值直到下一次 agent_end/会话激活。
 */
const projectDocsRefreshScheduler = createProjectDocsRefreshScheduler(refreshProjectDocsOnce)
const approvalCoordinator = new ApprovalCoordinator((context) => {
  const workspacePath = sessionWorkspacePaths.get(context.sessionId)
  // 会话绑定的工作区已被撤销/未授权时提前给出友好提示，避免落到 Rust 侧
  // 「was not previously authorized」类通用错误（审批失败语义模糊）。
  if (workspacePath) {
    const authorized = useAgentStore.getState().authorizedWorkspaces
      .some((workspace) => workspace.path === workspacePath)
    if (!authorized) {
      throw new Error(`会话绑定的工作区「${workspacePath}」已撤销或未授权，无法执行需要审批的操作`)
    }
  }
  return requestWorkspaceApprovalLease(
    context,
    // sandboxSafe 分级（bash 无网络声明）走单层 UI 审批：Rust 签发时重新权威分类，
    // 命令确属沙箱级才接受，否则拒绝（fail-closed，见 docs/os-sandbox-plan.md §6.1）。
    context.tier === 'sandboxSafe' ? 'sandboxSafe' : 'interactive',
    workspacePath,
  )
})

const createAccessModeAwareToolCall = (): BeforeToolCall => {
  const inner: BeforeToolCall = buildAccessModeBeforeToolCall(
    approvalCoordinator,
    (context) => evaluateAccessModeToolCall(
      context,
      useUiStore.getState().accessMode,
      (automaticContext) => requestWorkspaceApprovalLease(
        automaticContext,
        'automatic',
        sessionWorkspacePaths.get(automaticContext.sessionId),
      ),
    ),
  )
  // SSH 远程执行的免卡片预检：会话已在原生对话框授权过该主机时直接以
  // sshSessionGranted 模式签发 lease（Rust 校验权威授权表）。镜像未命中或
  // Rust 校验失败（授权已回收/镜像伪造）一律回落原有审批链路重新确认。
  return async (context): Promise<BeforeToolCallResult> => {
    if (context.requiresApproval && context.toolName === 'ssh') {
      const host =
        typeof (context.input as { host?: unknown } | null)?.host === 'string'
          ? ((context.input as { host: string }).host.trim() ?? '')
          : ''
      if (host && sshHostGrantedForSession(context.sessionId, host)) {
        try {
          const approvalLease = await requestWorkspaceApprovalLease(
            context,
            'sshSessionGranted',
            sessionWorkspacePaths.get(context.sessionId),
          )
          return { decision: 'approved', approvalLease }
        } catch {
          // 授权在 Rust 侧已失效：回落审批卡（原生对话框对已授权主机会静默
          // 放行，用户只需点一次卡片「允许一次」）。
        }
      }
    }
    return inner(context)
  }
}
const runtimeObservability = new RuntimeObservability()
const runtimeHookDiagnostics = new RuntimeHookDiagnostics()
// 装饰诊断 sink：记录后观察 invocation 阶段成功 hook 的耗时，超阈值经 console.warn
// 告警。完全复用现有诊断通道，不改 RuntimeHookRegistry 源码，不触发 semanticDigest
// 审计。runtimeHookDiagnostics 本身仍是 getHookDiagnostics() 的返回值（保留 snapshot）。
const hookDiagnosticsWithSlowAlert = wrapSlowHookDiagnostics(runtimeHookDiagnostics)


const sessionDefaults = (
  config: ProviderProfile,
  // 默认用当前扫描快照；persistCanonical 传 persisted 冻结快照（§8.1），
  // 避免磁盘 Skill 变化在规范化阶段触发依赖不兼容。
  skills: ProjectSkillInventorySnapshot = getActiveProjectSkillSnapshot(),
): SessionDefaults => {
  const model = resolveProviderModel(config)
  return {
    // 按 config 组装默认提示词：把 ProviderProfile.modelName 注入 # 角色 段，
    // 使 DB 播种 / 新建 / 分支会话持久化的提示词第一轮起就带模型身份。
    // 无工作区/授权文件/项目上下文时结果与 createRuntimeSession 重建的
    // sessionBasePrompt 严格相等（都使用 RUNTIME_POLICY.toolCapabilities、
    // REGISTERED_TOOLS / DEFAULT_ACTIVE_TOOL_NAMES 与当前 gitBranchPrefix）。
    systemPrompt: buildSystemPrompt({
      basePrompt: buildSessionBasePrompt({
        capabilities: RUNTIME_POLICY.toolCapabilities,
        modelName: resolvePromptModelName(config),
      }),
      tools: REGISTERED_TOOLS,
      activeToolNames: DEFAULT_ACTIVE_TOOL_NAMES,
      gitBranchPrefix: getGitBranchPrefix(),
    }),
    modelProvider: config.providerId === 'demo' ? 'axiom' : config.providerId,
    modelId: config.modelId,
    reasoning: toModelReasoning(activeReasoningSettings, model) ?? null,
    activeToolNames: DEFAULT_ACTIVE_TOOL_NAMES.slice(),
    providerConfig: structuredClone(config),
    runtimeManifest: createRuntimeDependencyManifest(
      config,
      REGISTERED_TOOLS,
      session.hooks.dependencies(),
      skills,
    ),
  }
}

const reasoningSettingsForSession = (
  stored: Pick<StoredAgentSession, 'reasoning'>,
  config: ProviderProfile,
): ReasoningSettings => normalizeReasoningSettings({
  level: stored.reasoning?.level ?? 'off',
  mode: stored.reasoning?.mode ?? activeReasoningSettings.mode,
  budgetTokens: stored.reasoning?.budgetTokens ?? activeReasoningSettings.budgetTokens,
}, config.apiFormat, config.maxOutputTokens)

const restoredActiveToolNames = (restored?: Pick<StoredAgentSession, 'activeToolNames'>): string[] => {
  if (!restored?.activeToolNames.length) return DEFAULT_ACTIVE_TOOL_NAMES.slice()
  const registered = new Set(REGISTERED_TOOLS.map((tool) => tool.name))
  const migrated = restored.activeToolNames.map((name) => migrateToolName(name))
  const missing = migrated.filter((name) => !registered.has(name))
  if (missing.length > 0) {
    throw new Error(`Session 活动工具未注册：${missing.join(', ')}`)
  }
  const deduped = Array.from(new Set(migrated))
  for (const required of DEFAULT_ACTIVE_TOOL_NAMES) {
    if (!deduped.includes(required)) deduped.unshift(required)
  }
  return deduped
}

/**
 * 新会话默认激活工具：项目 Skills 启用时，`load_skill` 默认 active。内置 SDD 正文
 * Skill（builtinSkillBodies）恒存在，故不再依赖项目 snapshot 非空（对齐
 * docs/skills-extension.md §9.1 的双通道扩展）。恢复会话仍走持久化 activeToolNames，
 * 不因应用升级静默获得新工具。
 */
const defaultActiveToolNamesForSession = (): string[] => {
  const base = DEFAULT_ACTIVE_TOOL_NAMES.slice()
  if (getProjectSkillsEnabled()
    && REGISTERED_TOOLS.some((tool) => tool.name === 'load_skill')
    && !base.includes('load_skill')) {
    base.push('load_skill')
  }
  return base
}

const createRuntimeSession = (
  config: ProviderProfile,
  configuredKey: boolean,
  messages: AgentMessage[] = [],
  sessionId?: string,
  checkpoint?: ContextCheckpoint | null,
  restoredRuntime?: RestoredRuntimeState,
  commitMutationBatch?: (
    batch: AgentMutationBatch,
  ) => AgentMutationReceipt | void | Promise<AgentMutationReceipt | void>,
  journalEntries?: AgentSessionJournalEntry[],
  mutationJournal?: AgentMutationJournal,
  operationCoordinator?: AgentHarnessOperationCoordinator,
  contextPolicySettings: ContextPolicySettings = activeContextPolicySettings,
  agentLimitsSettings: AgentLimitsSettings = activeAgentLimitsSettings,
): AgentHarness => {
  const resolvedSessionId = sessionId ?? createId('session')
  const workspacePath = restoredRuntime?.workspace?.path
  const subAgentEnvironment = workspacePath
    ? createDesktopAgentEnvironment(workspacePath)
    : undefined
  const toolRuntime = workspacePath
    ? createProductToolRuntime(RUNTIME_POLICY.toolCapabilities, subAgentEnvironment)
    : DESKTOP_TOOL_RUNTIME
  const model = resolveProviderModel(config)
  const transport = providerRequiresApiKey(config.providerId) && !configuredKey
    ? createProviderSetupRequiredTransport(config.providerId)
    : createProviderTransport(config, configuredKey).transport
  // 端点绑定已下沉到 Rust 侧 provider_profiles::resolve_profile（stream/probe 时强校验），
  // 激活时不再需要前端主动登记 origin。
  if (workspacePath) sessionWorkspacePaths.set(resolvedSessionId, workspacePath)
  else sessionWorkspacePaths.delete(resolvedSessionId)
  // 按会话授权状态重建基准/完整提示词：授权上下文段（工作区根目录 + 已授权
  // 文件）+ 项目上下文段（AGENTS.md）+ 模型身份段（config.modelName）使安全
  // 边界、项目约定与底层模型身份如实可执行。无授权上下文、无项目上下文且
  // 模型身份一致时，结果与 sessionDefaults 的默认提示词严格相等。hooks 用
  // 同一份 basePrompt 做工具准则回流，保证重建候选与当前提示词可比。
  const sessionBasePrompt = buildSessionBasePrompt({
    capabilities: RUNTIME_POLICY.toolCapabilities,
    workspacePath,
    authorizedFilePaths: activeAuthorizedReadFiles.map((file) => file.path),
    projectContext: activeProjectContext,
    projectSkills: getActiveProjectSkillSnapshot(),
    projectDocs: activeProjectDocs,
    modelName: resolvePromptModelName(config),
  })
  activeSessionBasePrompt = sessionBasePrompt
  // per-session basePrompt 镜像：harness hook（prepareNextTurn 工具准则回流）按会话
  // 读取，避免后台会话被其他会话的激活/刷新覆盖（不同工作目录会话串台）。
  setRuntimeBasePrompt(resolvedSessionId, sessionBasePrompt)
  const sessionSystemPrompt = buildSystemPrompt({
    basePrompt: sessionBasePrompt,
    tools: toolRuntime.tools,
    activeToolNames: toolRuntime.activeToolNames,
    gitBranchPrefix: getGitBranchPrefix(),
  })
  const harness = new AgentHarness({
    sessionId: resolvedSessionId,
    systemPrompt: restoredRuntime?.systemPrompt ?? sessionSystemPrompt,
    model,
    transport,
    tools: toolRuntime.tools,
    activeToolNames: restoredRuntime
      ? restoredActiveToolNames(restoredRuntime)
      : defaultActiveToolNamesForSession(),
    reasoning: restoredRuntime
      ? restoredRuntime.reasoning ?? undefined
      : toModelReasoning(activeReasoningSettings, model),
    messages,
    beforeToolCall: createAccessModeAwareToolCall(),
    commitMutationBatch,
    journalEntries,
    mutationJournal,
    operationCoordinator,
    observability: runtimeObservability,
    hookDiagnostics: hookDiagnosticsWithSlowAlert,
    contextWindow: config.contextWindow,
    contextPolicy: createContextPolicy(
      config.contextWindow,
      contextPolicySettings,
      config.maxOutputTokens,
    ),
    limits: {
      maxTurns: agentLimitsSettings.maxTurns,
      maxToolCalls: agentLimitsSettings.maxToolCalls,
    },
    steeringMode: activeQueueModeSettings.steering,
    followUpMode: activeQueueModeSettings.followUp,
    checkpoint,
    externalizeToolResult: isTauriRuntime()
      ? desktopAgentEnvironment.artifacts.writeToolResult
      : undefined,
    subAgentRuntime: productSubAgentRuntime,
    subAgentEnvironment,
    subAgentWorkspacePath: workspacePath,
    subAgentObservation: subAgentObservationSink,
    onRuntimeCheckpoint: runtimeFaultCheckpoint,
  })
  harness.addCleanup(registerProductRuntimeHooks(harness.hooks, {
    sessionId: resolvedSessionId,
    discoveryToolName: toolRuntime.discoveryToolName,
    // 按会话读取 basePrompt 镜像：后台会话 hook 回流不得使用被其他会话覆盖的
    // 模块级 activeSessionBasePrompt（不同工作目录会话串台）。镜像在会话激活/文档
    // 或技能刷新时同步更新，语义上仍是「读取最新值」。
    getBasePrompt: () => getRuntimeBasePrompt(resolvedSessionId) ?? activeSessionBasePrompt,
    gitBranchPrefix: getGitBranchPrefix(),
  }))
  harness.hooks.seal()
  return harness
}

// 模块初始化用同步 fallback 播种（解析已下沉 Rust，无法同步解码持久化存储值）；
// 真实的存储 selection 在 initialize 中异步加载后覆盖。
const runtimeOperationCoordinator = new AgentHarnessOperationCoordinator()
let session = createRuntimeSession(
  initialProvider,
  false,
  [],
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  runtimeOperationCoordinator,
)
let initialization: Promise<void> | undefined
let activeStoreStructuralLease: symbol | undefined

const beginStoreStructuralOperation = (allowRunning = false): symbol | undefined => {
  const state = useAgentStore.getState()
  if (activeStoreStructuralLease
    || state.runtimeLifecycle !== 'ready'
    || (!allowRunning && state.running)
    || state.sessionBusy) return undefined
  const lease = Symbol('store-structural-operation')
  activeStoreStructuralLease = lease
  useAgentStore.setState({ sessionBusy: true })
  return lease
}

const endStoreStructuralOperation = (lease: symbol): void => {
  if (activeStoreStructuralLease !== lease) return
  activeStoreStructuralLease = undefined
  useAgentStore.setState({ sessionBusy: false })
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const bindSession = (
  config: ProviderProfile,
  configuredKey: boolean,
  messages: AgentMessage[],
  sessionId: string,
  checkpoint?: ContextCheckpoint | null,
  restoredRuntime?: RestoredRuntimeState,
  journalEntries: AgentSessionJournalEntry[] = [],
  contextPolicySettings: ContextPolicySettings = activeContextPolicySettings,
): void => {
  const activeToolNames = restoredActiveToolNames(restoredRuntime)
  const previousSession = session
  const previousRetained = getRuntimeSession(previousSession.id) === previousSession
  let currentManifest: RuntimeDependencyManifest | undefined
  const runtimeManifestForMutation = (): RuntimeDependencyManifest => {
    if (!currentManifest) throw new Error('Runtime dependency manifest 尚未就绪')
    return currentManifest
  }
  const bindings = createMutationBindings(sessionId, runtimeManifestForMutation)
  const nextSession = createRuntimeSession(
    config,
    configuredKey,
    messages,
    sessionId,
    checkpoint,
    restoredRuntime,
    bindings.commitMutationBatch,
    journalEntries,
    bindings.journal,
    new AgentHarnessOperationCoordinator(),
    contextPolicySettings,
  )
  try {
    currentManifest = createRuntimeDependencyManifest(
      config,
      REGISTERED_TOOLS,
      nextSession.hooks.dependencies(),
      // 会话冻结值（对齐 runtimeDependencyManifest.ts 注释与 docs/skills-extension.md §8.1）：
      // 恢复时 skills 取自 persisted manifest，不取当前磁盘/模块级快照——磁盘 Skill
      // 增删只应在 load_skill 时 fail-closed，不阻断会话激活。新会话用当前扫描快照。
      restoredRuntime?.runtimeManifest?.skills ?? getActiveProjectSkillSnapshot(),
    )
    activeRuntimeManifest = currentManifest
    if (restoredRuntime) {
      assertRuntimeDependenciesCompatible(
        restoredRuntime.runtimeManifest,
        currentManifest,
        activeToolNames,
      )
    }
  } catch (error) {
    void nextSession.dispose().catch(() => undefined)
    throw error
  }
  session = nextSession
  const boundSessionId = session.id
  setRuntimeSession(boundSessionId, nextSession)
  setRuntimeProvider(boundSessionId, config, configuredKey)
  setRuntimeProjection(boundSessionId, {
    activeTools: {},
    endReason: null,
    error: null,
    compactionRunning: false,
  })
  session.subscribeRuntime(async (event) => {
    // 持久化屏障 fail-closed 语义不变：写库失败错误继续上抛、run 失败关闭。
    // 但 UI 投影必须先推进——否则界面停在旧状态，无法反映错误终止。
    let persistenceError: unknown
    try {
      await recordRuntimeEvent(boundSessionId, event)
    } catch (error) {
      persistenceError = error
    }
    handleSessionEvent(event, boundSessionId, nextSession)
    // run 结束后延迟重扫 SDD 文档索引：会话内新写/删除的 .specs/.plans/.docs
    // 文档要在 <available_docs> 中可见，否则后续轮次（尤其压缩后）按陈旧索引
    // 误判「不存在对应 Spec」。放在 handleSessionEvent 之后、fail-soft 异步执行。
    if (event.type === 'agent_end') {
      projectDocsRefreshScheduler.trigger()
    }
    if (persistenceError !== undefined) throw persistenceError
  })
  if (previousRetained && previousSession.id !== boundSessionId) return
  void previousSession.dispose().catch((error) => {
    const detail = errorMessage(error)
    useAgentStore.setState((state) => ({
      error: state.error ?? `旧 Session 释放失败：${detail}`,
    }))
  })
}

interface PreparedSessionActivation {
  snapshot: SessionSnapshot
  sessions: StoredAgentSession[]
  config: ProviderProfile
  configuredKey: boolean
  contextPolicySettings: ContextPolicySettings
  reasoningSettings: ReasoningSettings
}

const persistCanonicalRuntimeManifest = async (
  targetRepository: SessionRepository,
  snapshot: SessionSnapshot,
  config: ProviderProfile,
): Promise<{ snapshot: SessionSnapshot; upgraded: boolean }> => {
  const activeToolNames = restoredActiveToolNames(snapshot.session)
  const defaults: SessionDefaults = {
    // 规范化阶段也使用 persisted 冻结 skill 快照（§8.1）：不因磁盘增删而改写/阻断。
    ...sessionDefaults(config, snapshot.session.runtimeManifest?.skills ?? getActiveProjectSkillSnapshot()),
    systemPrompt: snapshot.session.systemPrompt,
    reasoning: snapshot.session.reasoning,
    activeToolNames,
  }
  if (!defaults.runtimeManifest) throw new Error('Runtime dependency manifest 尚未就绪')
  if (runtimeDependencyManifestsEqual(snapshot.session.runtimeManifest, defaults.runtimeManifest)) {
    return { snapshot, upgraded: false }
  }
  assertRuntimeDependenciesCompatible(
    snapshot.session.runtimeManifest,
    defaults.runtimeManifest,
    activeToolNames,
  )
  await targetRepository.updateSessionModel(snapshot.session.id, defaults)
  const reloaded = await targetRepository.loadSession(snapshot.session.id)
  return {
    snapshot: { ...reloaded, session: hydrateSessionMetadata(reloaded.session) },
    upgraded: true,
  }
}

const prepareSessionActivation = async (
  options: SessionActivationOptions,
  snapshot: SessionSnapshot,
): Promise<PreparedSessionActivation> => {
  const hydratedSnapshot = {
    ...snapshot,
    session: hydrateSessionMetadata(snapshot.session),
  }
  const config = options.config ?? await resolveSessionProviderConfig(
    hydratedSnapshot.session,
    useAgentStore.getState().provider,
    RUNTIME_POLICY.allowDemoProvider,
  )
  const canonical = await persistCanonicalRuntimeManifest(options.repository, hydratedSnapshot, config)
  const [configuredKey, sessions] = await Promise.all([
    options.configuredKey !== undefined
      ? Promise.resolve(options.configuredKey)
      : config.providerId === 'demo'
        ? Promise.resolve(false)
        : BUILTIN_PROVIDER_RUNTIME.credentials.status(config).then((status) => status.configured),
    options.repository.listSessions().then(hydrateSessionsMetadata).catch((error) => {
      if (!options.fallbackSessions) throw error
      return hydrateSessionsMetadata(structuredClone(options.fallbackSessions))
    }),
    // 在 commitSessionActivation → bindSession → createRuntimeSession 同步消费
    // activeProjectContext / activeProjectSkills 之前，按当前快照绑定的工作区
    // 异步刷新 AGENTS.md 与 .axiom/skills 镜像。
    refreshProjectContext(canonical.snapshot.session.workspace?.path),
    refreshProjectSkills(canonical.snapshot.session.workspace?.path),
  ])
  return {
    snapshot: canonical.snapshot,
    sessions,
    config,
    configuredKey,
    contextPolicySettings: normalizeContextPolicySettings(
      activeContextPolicySettings,
      config.contextWindow,
      config.maxOutputTokens,
    ),
    reasoningSettings: reasoningSettingsForSession(hydratedSnapshot.session, config),
  }
}

const commitSessionActivation = async (
  prepared: PreparedSessionActivation,
  options: SessionActivationOptions,
): Promise<void> => {
  const previousContextPolicySettings = activeContextPolicySettings
  const previousReasoningSettings = activeReasoningSettings
  try {
    bindSession(
      prepared.config,
      prepared.configuredKey,
      prepared.snapshot.messages,
      prepared.snapshot.session.id,
      prepared.snapshot.checkpoint,
      prepared.snapshot.session,
      prepared.snapshot.journalEntries,
      prepared.contextPolicySettings,
    )
    // 激活边界提示词对账：bindSession 的 harness 用的是持久化提示词，而镜像刚按
    // 本会话工作区刷新——把漂移（后台 run 写入的文档、外部编辑、重启间隔的变更）
    // 在下一次模型调用之前写入 live 提示词。fail-soft：失败不阻断激活，轮次回流兜底。
    if (activeRuntimeManifest) {
      try {
        await reconcileSessionPromptOnActivation(
          session,
          activeRuntimeManifest,
          buildReconcileCandidateSystemPrompt(session, buildSessionBasePrompt({
            capabilities: RUNTIME_POLICY.toolCapabilities,
            workspacePath: prepared.snapshot.session.workspace?.path,
            authorizedFilePaths: activeAuthorizedReadFiles.map((file) => file.path),
            projectContext: activeProjectContext,
            projectSkills: getActiveProjectSkillSnapshot(),
            projectDocs: activeProjectDocs,
            modelName: resolvePromptModelName(prepared.config),
          })),
        )
      } catch (error) {
        console.warn('激活边界提示词对账失败，将由轮次回流兜底', error)
      }
    }
    setActiveContextPolicySettings(prepared.contextPolicySettings)
    setActiveReasoningSettings(prepared.reasoningSettings)
    const nextProviderProfiles = mergeProviderProfile(
      useAgentStore.getState().providerProfiles,
      prepared.config,
    )
    let providerPersistenceError: string | undefined
    if (options.persistProvider) {
      try {
        persistProviderState(nextProviderProfiles, prepared.config)
      } catch (error) {
        providerPersistenceError = `Provider 本地投影保存失败：${errorMessage(error)}`
      }
    }
    applySessionActivationState(
      prepared,
      nextProviderProfiles,
      queuedMessageStateForSession(session),
      session.getContextUsage(),
      providerRequiresApiKey(prepared.config.providerId)
        && !prepared.configuredKey,
      providerPersistenceError,
      options,
      { setState: (partial) => useAgentStore.setState(partial as unknown as Partial<AgentState>) },
    )
    // 切换激活会话后同步审批卡片：后台会话的审批不应继续占据前台卡片。
    syncApprovalState()
  } catch (error) {
    setActiveContextPolicySettings(previousContextPolicySettings)
    setActiveReasoningSettings(previousReasoningSettings)
    throw error
  }
}

const activateCommittedSessionSnapshot = async (
  options: SessionActivationOptions,
): Promise<CommittedProjectionResult> => {
  try {
    await activateSessionSnapshot(options)
    return { status: 'activated' }
  } catch (error) {
    return { status: 'projection_failed', error: errorMessage(error) }
  }
}

const projectedSessions = (
  snapshot: SessionSnapshot,
  removedSessionIds: string[] = [],
): StoredAgentSession[] => {
  const removed = new Set(removedSessionIds)
  return hydrateSessionsMetadata([
    snapshot.session,
    ...useAgentStore.getState().sessions.filter((stored) => (
      stored.id !== snapshot.session.id && !removed.has(stored.id)
    )),
  ]).sort((left, right) => right.updatedAt - left.updatedAt)
}

const activateSessionSnapshot = async (options: SessionActivationOptions): Promise<void> => {
  let activationError: unknown
  try {
    const prepared = await prepareSessionActivation(options, options.snapshot)
    await commitSessionActivation(prepared, options)
    return
  } catch (error) {
    activationError = error
  }

  try {
    const snapshot = await options.repository.loadSession(options.snapshot.session.id)
    const prepared = await prepareSessionActivation(options, snapshot)
    await commitSessionActivation(prepared, options)
  } catch (recoveryError) {
    throw new Error(
      `${errorMessage(activationError)}；Session 激活恢复失败：${errorMessage(recoveryError)}`,
    )
  }
}

const activateCachedRuntimeSession = async (
  options: ActivateCachedRuntimeOptions,
): Promise<void> => {
  const state = useAgentStore.getState()
  const providerState = getRuntimeProvider(options.snapshot.session.id)
  const config = providerState?.config ?? await resolveSessionProviderConfig(
    options.snapshot.session,
    state.provider,
    RUNTIME_POLICY.allowDemoProvider,
  )
  const configuredKey = providerState?.configuredKey ?? (config.providerId === 'demo'
    ? false
    : (await BUILTIN_PROVIDER_RUNTIME.credentials.status(config)).configured)
  const projection = getRuntimeProjection(options.snapshot.session.id) ?? {
    activeTools: {},
    endReason: null,
    error: null,
    compactionRunning: false,
  }
  const workspace = options.snapshot.session.workspace
  // 缓存激活不经过 createRuntimeSession，此处重建工作区映射：revokeWorkspace
  // 清理过被撤销工作区的映射后，切回该会话必须重新绑定原路径（即使已撤销也要
  // 保留），使审批继续 fail-closed 而非因缺少映射而 fallback 到其他工作区。
  if (workspace?.path) sessionWorkspacePaths.set(options.snapshot.session.id, workspace.path)
  else sessionWorkspacePaths.delete(options.snapshot.session.id)
  // 对齐 prepareSessionActivation（744-745）：cached 激活同样刷新 AGENTS.md 与
  // .axiom/skills 模块级镜像，并重建 basePrompt / runtimeManifest 镜像。否则切回
  // 缓存会话后 applyProjectSkillsToSession / prepareNextTurn 会用上一个工作区的
  // activeProjectContext / activeSessionBasePrompt 重建提示词（不同目录会话串台）。
  await Promise.all([
    refreshProjectContext(workspace?.path),
    refreshProjectSkills(workspace?.path),
  ])
  const sessionBasePrompt = buildSessionBasePrompt({
    capabilities: RUNTIME_POLICY.toolCapabilities,
    workspacePath: workspace?.path,
    authorizedFilePaths: activeAuthorizedReadFiles.map((file) => file.path),
    projectContext: activeProjectContext,
    projectSkills: getActiveProjectSkillSnapshot(),
    projectDocs: activeProjectDocs,
    modelName: resolvePromptModelName(config),
  })
  activeSessionBasePrompt = sessionBasePrompt
  setRuntimeBasePrompt(options.snapshot.session.id, sessionBasePrompt)
  activeRuntimeManifest = createRuntimeDependencyManifest(
    config,
    REGISTERED_TOOLS,
    options.runtime.hooks.dependencies(),
    getActiveProjectSkillSnapshot(),
  )
  // 激活边界提示词对账：cached 会话复用原 harness 的 live 提示词，后台/闲置期间的
  // 文档漂移（自己后台 run 写入、外部编辑）在此写入，否则要等下一次 run 的首个
  // turn_end 回流，首轮模型调用仍用旧 <available_docs>。manifest 取持久化冻结值
  // 优先：对账只换提示词，不把 skills 快照悄悄换成磁盘现状（削弱 load_skill 的
  // fail-closed 语义）。运行中的后台会话被切回时由回流在 turn_end 自愈，此处跳过。
  try {
    await reconcileSessionPromptOnActivation(
      options.runtime,
      options.snapshot.session.runtimeManifest ?? activeRuntimeManifest,
      buildReconcileCandidateSystemPrompt(options.runtime, sessionBasePrompt),
    )
  } catch (error) {
    console.warn('激活边界提示词对账失败，将由轮次回流兜底', error)
  }
  const authorizedWorkspace = workspace
    && state.authorizedWorkspaces.some((candidate) => candidate.path === workspace.path)
    ? await activateAuthorizedWorkspace(workspace.path)
    : null
  const sessions = await options.repository.listSessions()
    .then(hydrateSessionsMetadata)
    .catch((error) => {
      if (!options.fallbackSessions) throw error
      return hydrateSessionsMetadata(structuredClone(options.fallbackSessions))
    })
  const contextPolicySettings = normalizeContextPolicySettings(
    activeContextPolicySettings,
    config.contextWindow,
    config.maxOutputTokens,
  )
  const reasoningSettings = reasoningSettingsForSession(options.snapshot.session, config)
  session = options.runtime
  setActiveContextPolicySettings(contextPolicySettings)
  setActiveReasoningSettings(reasoningSettings)
  // 运行中的 harness.messages（historyMessages）要到 runAgentLoop 返回才合并本轮
  // 消息，期间只反映 run 前的历史；切走再切回若直接投影它会丢掉整轮已发生消息
  // （新会话则整个列表为空）。message_end 是持久化屏障、即时落库，因此运行中
  // 切回时 repository 快照才是完整视图；空闲会话两者一致，仍以 harness 为准。
  const projectedMessages = options.runtime.isRunning
    ? options.snapshot.messages
    : options.runtime.messages
  useAgentStore.setState({
    activeSessionId: options.snapshot.session.id,
    sessions,
    messages: projectedMessages,
    running: options.runtime.isRunning,
    activeTools: { ...projection.activeTools },
    endReason: projection.endReason,
    error: projection.error,
    compactionRunning: projection.compactionRunning,
    contextCheckpoint: options.runtime.checkpoint,
    contextUsage: options.runtime.getContextUsage(),
    provider: structuredClone(config),
    providerProfiles: mergeProviderProfile(state.providerProfiles, config),
    providerHasKey: configuredKey,
    providerSetupRequired: providerRequiresApiKey(config.providerId) && !configuredKey,
    contextPolicySettings,
    reasoningSettings,
    authorizedWorkspace,
    ...queuedMessageStateFor(options.runtime),
    streamingDraft: null,
  })
  // 切换激活会话后同步审批卡片：后台会话的审批不应继续占据前台卡片。
  syncApprovalState()
}

const activateCommittedCachedRuntimeSession = async (options: Parameters<
  typeof activateCachedRuntimeSession
>[0]): Promise<CommittedProjectionResult> => {
  try {
    await activateCachedRuntimeSession(options)
    return { status: 'activated' }
  } catch (error) {
    return { status: 'projection_failed', error: errorMessage(error) }
  }
}

/**
 * 模块级运行时装配的依赖注入束：拆分出的 action（sessionActions /
 * providerActions / workspaceActions）通过它取用 session、repository、
 * structural lease 与 activation helpers。session 会在 bindSession 时被
 * 替换，因此用 getter 而非捕获值；repository 同理来自 repositoryCore。
 */
const runtimeDeps: StoreRuntimeDeps = {
  getSession: () => session,
  getRepository,
  beginStructural: beginStoreStructuralOperation,
  endStructural: endStoreStructuralOperation,
  bindSession,
  projectedSessions,
  activateCommittedSessionSnapshot,
  activateSessionSnapshot,
  activateCachedRuntimeSession,
  activateCommittedCachedRuntimeSession,
  sessionDefaults,
  updateAuthorizedReadFiles: (files) => {
    activeAuthorizedReadFiles = files
  },
}

const storageStatsSlice = createStorageStatsSlice({
  get: () => useAgentStore.getState(),
  set: (partial) => useAgentStore.setState(partial as unknown as Partial<AgentState>),
  getRepository,
})

const handleSessionEvent = (event: AgentEvent, boundSessionId: string, boundRuntime: AgentHarness): void => {
  applySessionEvent(event, boundSessionId, boundRuntime, {
    setState: (reducer) => useAgentStore.setState(
      reducer as unknown as (state: AgentState) => Partial<AgentState>,
    ),
    getState: () => useAgentStore.getState() as unknown as AgentCoreProjection,
    getRegisteredTools: () => REGISTERED_TOOLS,
    buildRuntimeManifest: (provider, runtime) => createRuntimeDependencyManifest(
      provider,
      REGISTERED_TOOLS,
      runtime.hooks.dependencies(),
      getActiveProjectSkillSnapshot(),
    ),
  })
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  ...createAgentSessionSlice(set, get, runtimeDeps),
  ...createAgentSessionManagementSlice(set, get, runtimeDeps),
  ...createAgentProviderSlice(set, get, runtimeDeps),
  ...createAgentWorkspaceSlice(set, get, runtimeDeps),
  ...createAgentSettingsSlice(set, get, runtimeDeps),
  ...storageStatsSlice,
  settingsError: null,
  initializationError: null,
  runtimeLifecycle: 'initializing',
  storageStats: null,
  contextPolicySaving: false,
  projectSkills: EMPTY_PROJECT_SKILL_INVENTORY,
  skillDiagnostics: [],
  skillReloadPreview: null,
  previewSkillReload: async () => {
    const workspacePath = useAgentStore.getState().authorizedWorkspace?.path
    const environment = workspacePath && isTauriRuntime()
      ? createDesktopAgentEnvironment(workspacePath)
      : null
    const result = environment
      ? await loadProjectSkills(environment)
      : { snapshot: EMPTY_PROJECT_SKILL_INVENTORY, diagnostics: [] }
    const preview: SkillReloadPreview = {
      ...diffProjectSkills(useAgentStore.getState().projectSkills, result.snapshot),
      snapshot: result.snapshot,
      diagnostics: result.diagnostics,
    }
    useAgentStore.setState({ skillReloadPreview: preview })
    return preview
  },
  applySkillReload: async () => {
    const preview = useAgentStore.getState().skillReloadPreview
    if (!preview) throw new Error('请先重新扫描技能')
    // 失败时（会话 busy / CAS 拒绝）保持旧状态与 preview，用户可取消或重试。
    await applyProjectSkillsToSession(preview)
    useAgentStore.setState({ skillReloadPreview: null })
  },

  initialize: async () => {
    if (!initialization) {
      initialization = (async () => {
        // loadedProviderProfiles 需在 try 外声明：fallback 分支也要引用。
        // 若 loadProviderSelection / loadProviderProfiles 在 try 外抛错，
        // initialization 会永久 reject 且 runtimeLifecycle 停在 initializing，
        // retryInitialize 将因 `!== 'failed'` 提前返回而无法恢复。
        let loadedProviderProfiles: ProviderProfile[] = []
        try {
          // 持久化的 Provider selection 需经 Rust 权威解析（异步），在此加载后覆盖模块级 fallback。
          const initialProviderSelection = await loadProviderSelection()
          const config = initialProviderSelection.config
          loadedProviderProfiles = await loadProviderProfiles(
            config,
            !initialProviderSelection.requiresSetup,
          )
          set({ initializationError: null, runtimeLifecycle: 'initializing' })
          // 启动即把持久化的 access-mode 同步为 Rust 权威审批模式（fail-closed）
          await setWorkspaceApprovalMode(
            useUiStore.getState().accessMode === 'standard' ? 'interactive' : 'automatic',
          ).catch(() => undefined)
          setRepository(await createSessionRepository())
          const initialized = await getRepository().initialize(sessionDefaults(config))
          const providerProfileMigrations = await getRepository().prepareProviderProfileMigrations()
          await stageProviderSecretCleanupIntent(
            initialProviderSelection.secretMigration,
            providerProfileMigrations,
          )
          const migrationReceipts = new Map<string, ProviderSecretMigrationReceipt>()
          const initialMigrationReceipt = await migrateProviderSecret(
            providerSecretMigrationBindings,
            config,
            initialProviderSelection.secretMigration,
          )
          if (initialMigrationReceipt) {
            migrationReceipts.set(initialMigrationReceipt.sourceSecretId, initialMigrationReceipt)
          }
          for (const migration of providerProfileMigrations) {
            const migrationReceipt = await migrateProviderSecret(
              providerSecretMigrationBindings,
              migration.profile,
              migration.secretMigration,
            )
            if (migrationReceipt) {
              migrationReceipts.set(migrationReceipt.sourceSecretId, migrationReceipt)
            }
          }
          await getRepository().commitProviderProfileMigrations(providerProfileMigrations)
          if (initialProviderSelection.requiresPersistenceMigration) persistProviderConfig(config)
          await runtimeFaultCheckpoint('profile_committed')
          const secretCleanupWarning = await garbageCollectMigratedProviderSecrets(
            providerSecretMigrationBindings,
            getRepository(),
            migrationReceipts,
          )
          const [authorizedFiles, workspaceRestore] = isTauriRuntime()
            ? await Promise.all([
                listAuthorizedReadFiles(),
                restoreAuthorizedWorkspaces(persistedWorkspacePaths()),
              ])
            : [[], { workspaces: [], failedPaths: [] }]
          const authorizedWorkspaces = workspaceRestore.workspaces
          // 同步模块级镜像（见 activeAuthorizedReadFiles 声明处注释）：
          // 必须在下方 bindSession 重建会话提示词之前更新。
          activeAuthorizedReadFiles = authorizedFiles
          const activeConfig = await resolveSessionProviderConfig(
            initialized.active.session,
            config,
            RUNTIME_POLICY.allowDemoProvider,
          )
          const configuredKey = activeConfig.providerId === 'demo'
            ? false
            : (await BUILTIN_PROVIDER_RUNTIME.credentials.status(activeConfig)).configured
          const canonical = await persistCanonicalRuntimeManifest(
            getRepository(),
            initialized.active,
            activeConfig,
          )
          const initializedSessions = hydrateSessionsMetadata(canonical.upgraded
            ? await getRepository().listSessions()
            : initialized.sessions)
          const activeStored = hydrateSessionMetadata(canonical.snapshot.session)
          const authorizedWorkspace = activeStored.workspace
            && authorizedWorkspaces.some((workspace) => workspace.path === activeStored.workspace?.path)
            ? await activateAuthorizedWorkspace(activeStored.workspace.path)
            : null
          // 同步项目上下文镜像：在下方 bindSession 重建会话提示词之前，按当前
          // 会话绑定的工作区加载 AGENTS.md 与 project Skill（见镜像声明处注释）。
          await Promise.all([
            refreshProjectContext(authorizedWorkspace?.path),
            refreshProjectSkills(authorizedWorkspace?.path),
          ])
          setActiveContextPolicySettings(normalizeContextPolicySettings(
            activeContextPolicySettings,
            activeConfig.contextWindow,
            activeConfig.maxOutputTokens,
          ))
          setActiveReasoningSettings(reasoningSettingsForSession(canonical.snapshot.session, activeConfig))
          const storageStats = await getRepository().getStats().catch(() => null)
          const initializationWarnings = [
            initialized.artifactIntegrityWarning,
            secretCleanupWarning,
            workspaceRestore.failedPaths.length > 0
              ? `${workspaceRestore.failedPaths.length} 个已保存工作目录无法恢复授权`
              : undefined,
          ].filter((warning): warning is string => Boolean(warning))
          bindSession(
            activeConfig,
            configuredKey,
            canonical.snapshot.messages,
            canonical.snapshot.session.id,
            canonical.snapshot.checkpoint,
            activeStored,
            canonical.snapshot.journalEntries,
          )
          // 激活边界提示词对账：重启间隔内的外部文档变更在此写入 live 提示词，
          // 覆盖「恢复后第一次 run 首轮仍用旧索引」的窗口。fail-soft 同上。
          if (activeRuntimeManifest) {
            try {
              await reconcileSessionPromptOnActivation(
                session,
                activeRuntimeManifest,
                buildReconcileCandidateSystemPrompt(session, buildSessionBasePrompt({
                  capabilities: RUNTIME_POLICY.toolCapabilities,
                  workspacePath: authorizedWorkspace?.path,
                  authorizedFilePaths: activeAuthorizedReadFiles.map((file) => file.path),
                  projectContext: activeProjectContext,
                  projectSkills: getActiveProjectSkillSnapshot(),
                  projectDocs: activeProjectDocs,
                  modelName: resolvePromptModelName(activeConfig),
                })),
              )
            } catch (error) {
              console.warn('激活边界提示词对账失败，将由轮次回流兜底', error)
            }
          }
          set({
            providerReady: true,
            provider: activeConfig,
            providerProfiles: initialProviderSelection.requiresSetup && !configuredKey
              ? loadedProviderProfiles
              : mergeProviderProfile(loadedProviderProfiles, activeConfig),
            providerSetupRequired: providerRequiresApiKey(activeConfig.providerId) && !configuredKey,
            providerHasKey: configuredKey,
            authorizedFiles,
            authorizedWorkspace,
            authorizedWorkspaces,
            messages: canonical.snapshot.messages,
            sessions: initializedSessions,
            activeSessionId: canonical.snapshot.session.id,
            recoveredRuns: initialized.recoveredRuns,
            storageStats,
            contextUsage: session.getContextUsage(),
            contextCheckpoint: canonical.snapshot.checkpoint,
            contextPolicySettings: activeContextPolicySettings,
            reasoningSettings: activeReasoningSettings,
            ...queuedMessageStateForSession(session),
            settingsError: initializationWarnings.length > 0
              ? initializationWarnings.join('；')
              : null,
            initializationError: null,
            runtimeLifecycle: 'ready',
          })
        } catch (error) {
          const detail = errorMessage(error)
          if (RUNTIME_POLICY.allowInitializationFallback) {
            setRepository(new MemorySessionRepository())
            const fallback = await getRepository().initialize(sessionDefaults(DEMO_PROVIDER_CONFIG))
            const storageStats = await getRepository().getStats()
            setActiveReasoningSettings(normalizeReasoningSettings(
              activeReasoningSettings,
              'demo',
              DEMO_PROVIDER_CONFIG.maxOutputTokens,
            ))
            bindSession(
              { ...DEMO_PROVIDER_CONFIG },
              false,
              fallback.active.messages,
              fallback.active.session.id,
              fallback.active.checkpoint,
              fallback.active.session,
              fallback.active.journalEntries,
            )
            set({
              provider: { ...DEMO_PROVIDER_CONFIG },
              providerProfiles: mergeProviderProfile(loadedProviderProfiles, DEMO_PROVIDER_CONFIG),
              providerReady: true,
              providerSetupRequired: false,
              providerHasKey: false,
              messages: fallback.active.messages,
              sessions: fallback.sessions,
              activeSessionId: fallback.active.session.id,
              storageStats,
              contextUsage: session.getContextUsage(),
              reasoningSettings: activeReasoningSettings,
              contextCheckpoint: fallback.active.checkpoint,
              ...queuedMessageStateForSession(session),
              initializationError: null,
              runtimeLifecycle: 'ready',
              settingsError: `初始化桌面能力失败，开发模式已回退到 Demo：${detail}`,
            })
          } else {
            const message = `Axiom 桌面能力初始化失败：${detail}`
            set({
              providerReady: false,
              initializationError: message,
              runtimeLifecycle: 'failed',
              error: message,
              settingsError: message,
            })
          }
        }
      })()
    }
    await initialization
    if (get().initializationError) initialization = undefined
  },

  retryInitialize: async () => {
    if (get().running || get().runtimeLifecycle !== 'failed') return
    initialization = undefined
    set({
      providerReady: false,
      initializationError: null,
      runtimeLifecycle: 'initializing',
      error: null,
    })
    await get().initialize()
  },

  stop: () => session.abortAndWait(),

  // 后台会话停止入口：直接作用于目标会话的缓存 harness（含激活会话），与
  // stop()（模块级激活 harness）等价——多会话并行时侧栏可直接停后台 run，
  // 不必切换会话。
  stopSession: async (sessionId) => {
    const runtime = getRuntimeSession(sessionId)
    if (!runtime) return null
    return runtime.abortAndWait()
  },

  // 后台会话发送入口：不切换激活会话即可给后台 idle 会话发消息启动 run——
  // 多会话并行的最后一块操作面（对齐 ZCode 每 task 独立可操作）。与 send()
  // 的关键差异：不触碰任何前台投影（running/messages/error 均属激活会话），
  // agent_start/agent_settled/message_end 事件经该 harness 自身的订阅更新侧栏
  // sessions（status/messageCount/「新会话」标题兜底），run 内失败由 agent_end
  // 的 errorMessage 写入 per-session 投影（切回时可见）；此处只兜 prompt 同步
  // 抛出的错误（如 invalid_state）。标题生成不在此路径（首条消息即后台发送的
  // 场景保留创建时标题）。
  sendToSession: async (sessionId, content) => {
    const state = get()
    if (!sessionId || !content.trim()) return false
    if (state.runtimeLifecycle !== 'ready' || !state.providerReady) return false
    if (state.providerSetupRequired) return false
    const runtime = getRuntimeSession(sessionId)
    if (!runtime || runtime.isRunning) return false
    // 工作区绑定与 send() 同口径：会话必须绑定仍处授权集内的工作目录。
    const workspacePath = state.sessions
      .find((stored) => stored.id === sessionId)
      ?.workspace?.path
    if (
      !workspacePath
      || !state.authorizedWorkspaces.some((workspace) => workspace.path === workspacePath)
    ) {
      return false
    }
    try {
      await runtime.prompt(content)
      return true
    } catch (error) {
      const projection = getRuntimeProjection(sessionId)
      if (projection) {
        projection.error = error instanceof Error ? error.message : String(error)
        setRuntimeProjection(sessionId, projection)
      }
      return false
    }
  },

  approveToolCall: (toolCallId) => {
    return approvalCoordinator.respond(toolCallId, 'approved').then(() => undefined)
  },

  denyToolCall: (toolCallId) => {
    return approvalCoordinator.respond(toolCallId, 'denied').then(() => undefined)
  },

}))

/** Narrow test-only bridge for exercising a durable mutation during a real Agent run. */
export const appendRuntimeFaultAutomationMessage = async (content: string): Promise<void> => {
  const automation = window.__AXIOM_E2E_RUNTIME_AUTOMATION__
  if (!isTauriRuntime()
    || automation?.scenario !== 'mutation_batch_committed'
    || window.__AXIOM_E2E_FAULT_CHECKPOINT__ !== 'mutation_batch_committed') {
    throw new Error('Runtime fault mutation automation is unavailable')
  }
  await session.appendMessage({
    id: createId('e2e-mutation-message'),
    role: 'custom',
    customType: 'e2e-runtime-fault-mutation',
    content,
    createdAt: Date.now(),
  })
}

// 审批按激活会话分组展示：subscribe 回调与所有会话激活路径（activateCachedRuntimeSession /
// commitSessionActivation）都调用 sync，使 pendingApproval 始终是「当前激活会话的队首审批」；
// 后台会话的审批不抢占前台卡片，而是进入 backgroundApprovals 收件箱（respond 仍按
// toolCallId 全局定位，跨会话安全）——多会话并行时后台 run 不再静默阻塞在审批上
// 直到超时自动拒绝。awaitingApprovalSessionIds 同时覆盖后台会话：侧栏据此显示
// 「等待审批」标记。
const syncApprovalState = (): void => {
  const activeSessionId = useAgentStore.getState().activeSessionId
  const pendingApproval = activeSessionId
    ? approvalCoordinator.getPendingForSession(activeSessionId)
    : null
  const awaitingApprovalSessionIds = approvalCoordinator.pendingApprovalSessionIds()
  const backgroundApprovals = approvalCoordinator
    .pendingViews()
    .filter((view) => view.sessionId !== activeSessionId)
  useAgentStore.setState((state) => ({
    pendingApproval,
    // 引用稳定：集合未变化时保持旧数组，避免侧栏选择器无谓重渲染。
    awaitingApprovalSessionIds: awaitingApprovalSessionIds.length === state.awaitingApprovalSessionIds.length
      && awaitingApprovalSessionIds.every((id, index) => id === state.awaitingApprovalSessionIds[index])
      ? state.awaitingApprovalSessionIds
      : awaitingApprovalSessionIds,
    backgroundApprovals: backgroundApprovals.length === state.backgroundApprovals.length
      && backgroundApprovals.every(
        (view, index) => view.toolCallId === state.backgroundApprovals[index]?.toolCallId,
      )
      ? state.backgroundApprovals
      : backgroundApprovals,
  }))
}
approvalCoordinator.subscribe(syncApprovalState)

