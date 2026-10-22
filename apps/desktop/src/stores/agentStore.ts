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
import type { AccessMode } from '@/agent/approval/ApprovalCoordinator'
import type { QueuedMessageSnapshot } from '@/agent/runtime/AgentSession'
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
import { projectSessionActiveToolNames } from '@/agent/runtime/toolPermissionProjection'
import { createSubAgentRuntime } from '@/agent/subagent/SubAgentRuntime'
import { createSubAgentObservationSink } from './services/subAgentObservability'
import { stopSessionRuntime } from './services/stopSessionRuntime'
import { createApprovalWiring } from './services/approvalWiring'
import { backgroundRunCapacityError } from './services/backgroundRunPolicy'
import { revokeSessionAuthorization } from '@/platform/sessionAuthorization'
import { setSendManifestSink } from '@/platform/sendManifest'
import { buildSessionBasePrompt } from '@/agent/prompt/systemPromptSections'
import { loadProjectContext } from '@/agent/prompt/projectContext'
import {
  loadProjectAgents,
  projectAgentsInventoryEqual,
  EMPTY_PROJECT_AGENTS_INVENTORY,
  type ProjectAgentsInventory,
} from '@/agent/prompt/projectAgents'
import {
  loadProjectDocs,
  projectDocInventoryEqual,
  projectDocPromptInventoryEqual,
  EMPTY_PROJECT_DOC_INVENTORY,
  type ProjectDocInventory,
} from '@/agent/prompt/projectDocs'
import { createProjectDocsRefreshScheduler } from './services/projectDocsRefresh'
import { reconcileSessionPromptOnActivation } from './services/sessionPromptReconcile'
import { bindActiveProjectSkillSnapshot, getActiveProjectSkillSnapshot } from '@/agent/skills/activeProjectSkills'
import { loadProjectSkills } from '@/agent/skills/loadProjectSkills'
import { diffProjectSkills } from '@/agent/skills/diffProjectSkills'
import { formatAvailableSkills } from '@/agent/skills/formatAvailableSkills'
import { installPromptLocalizationHost, resolvePromptLanguage } from '@/agent/prompt/promptLocalizationHost'
import { getBuiltinPromptOverrides } from '@/config/builtinPromptOverrides'
import { detectSystemLanguage, resolveLanguage } from '@/i18n/locale'
import { EMPTY_PROJECT_SKILL_INVENTORY } from '@/agent/skills/types'
import type { ProjectSkillInventorySnapshot, ProjectSkillSource, SkillDiagnostic } from '@/agent/skills/types'
import {
  BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS,
  type ProviderSecretMigrationReceipt,
} from '@/agent/transport/ProviderCredentialRuntime'
import {
  DEFAULT_REASONING_SETTINGS,
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
import { createRuntimePolicy, RUNTIME_POLICY } from '@/config/runtimePolicy'
import { getRuntimeInfo } from '@/platform/runtimeInfo'
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
  getRuntimeProjectContext,
  getRuntimeProjection,
  getRuntimeProvider,
  getRuntimeSession,
  setRuntimeBasePrompt,
  setRuntimeProjectContext,
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
import { markPersistenceUnrelated } from '@/agent/core/persistenceBarrier'
import { applySessionActivationState, applySessionEvent, queuedMessageStateFor, withSessionQueueCount, type AgentCoreProjection } from './sessionActivationCore'
import {
  queuedMessageState as queuedMessageStateForSession,
  type StoreRuntimeDeps,
} from './sessionActions'
import {
  sessionWorkspacePaths,
} from './workspaceActions'
import { setProjectedWorkspacePathSource } from './services/sessionWorkspaceRegistry'
import { createStorageStatsSlice } from './storageStatsSlice'
import { resetSessionAccessMode } from './accessModeActions'
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
  sessionWorkspacePaths.forget(sessionId)
  if (isTauriRuntime()) void revokeSessionAuthorization(sessionId).catch((error: unknown) => {
    useAgentStore.setState({ error: error instanceof Error ? error.message : String(error) })
  })
})

// 提示词本地化宿主装配：agent 层不 import stores/i18n 运行时，此处注入
// 「UI 语言解析 + 内置提示词覆写」两个只读供给——load_skill 内置回退、
// <available_skills> 清单与 SubAgentRuntime 在执行期读取。必须在下方
// createSubAgentRuntime 之前安装（首次委派即读取）。语言解析对 store 形态
// 防御：组件测试常以 hook-only 形态 mock uiStore（无 getState），而本模块
// 求值期 createRuntimeSession 组装默认会话提示词就会走到这里——mock/异常时
// 回落系统语言解析（node SSR 无 navigator 时 resolveLanguage 自行回落 zh-CN）。
installPromptLocalizationHost({
  resolveLanguage: () => {
    try {
      return resolveLanguage(useUiStore.getState().language, detectSystemLanguage())
    } catch {
      return resolveLanguage('system', detectSystemLanguage())
    }
  },
  getOverrides: () => getBuiltinPromptOverrides(),
})

// 主 Agent 系统提示词：基准分节（人设/协作/工作流）+ 能力门控安全段 +
// 授权上下文段 + 工具发现说明，最后由 buildSystemPrompt 追加可用能力与工具准则段。
// 提示词文本集中在 src/agent/prompt/systemPromptSections.ts，上层只做能力→段落的映射。
// 会话提示词一律由 sessionDefaults / createRuntimeSession 按当前 ProviderProfile
// 动态组装（含 # 角色 中的模型身份行），不保留模块级静态提示词常量；绑定工作区或
// 存在授权文件的会话由 createRuntimeSession 用 buildSessionBasePrompt 重建，并把
// 同一份 basePrompt 传给 productRuntimeHooks 做工具准则回流。
let runtimeCapabilities = RUNTIME_POLICY.toolCapabilities
let DESKTOP_TOOL_RUNTIME = createProductToolRuntime(
  runtimeCapabilities,
  desktopAgentEnvironment,
  // H1-5 发布档（build-time 常量，不随 runtimeInfo 变化）：Agent 层不 import app config
  // 的值，故由这里注入；开发档让 api_request 只放行回环/本地目标。
  { testAutomation: RUNTIME_POLICY.testAutomation },
)
let REGISTERED_TOOLS = DESKTOP_TOOL_RUNTIME.tools
let DEFAULT_ACTIVE_TOOL_NAMES = DESKTOP_TOOL_RUNTIME.activeToolNames
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
// 嵌套 AGENTS.md 的路径索引镜像：根 AGENTS.md 是全局契约，子目录文件是它的局部
// 展开，只注路径不注正文（模型按需 read）。与 activeProjectContext 同批次扫描、
// 同批次刷新、同批次回滚——三者合成同一个 `# 项目上下文` 段，任何一面掉队都会
// 让提示词内部出现新鲜度不一致的拼装。
let activeProjectAgents: ProjectAgentsInventory = EMPTY_PROJECT_AGENTS_INVENTORY
// 已扫描的工作区 SDD 文档索引镜像：refreshProjectContext 扫描 .specs/.plans/.docs
// 后更新，供 createRuntimeSession 组装 # 项目上下文 段的 <available_docs> 子块。
// 无工作区或目录缺失时为 EMPTY_PROJECT_DOC_INVENTORY（提示词省略该子块）。
let activeProjectDocs: ProjectDocInventory = EMPTY_PROJECT_DOC_INVENTORY

/**
 * 通知 UI：某个会话的文档索引实际变化。DocsView 订阅该代数，后台会话在自身
 * run 里写入 Spec/Plan 后无需切换会话即可触发重扫；同一轮多次刷新由代数递增
 * 和 UI 侧单飞合并处理。
 */
const notifyProjectDocsChanged = (workspacePath?: string): void => {
  useAgentStore.setState((state) => ({
    projectDocsRevision: state.projectDocsRevision + 1,
    projectDocsWorkspacePath: workspacePath ?? null,
  }))
}

// 测试页会话上下文段镜像：仅在测试页激活时由页面发布（`setTestingPromptContext`），
// 离开测试页或切换会话即清空。与项目上下文三面镜像同级、同生命周期，
// 因此会话提示词重建（激活/刷新/回流）能拿到同一份值。
let activeTestingContext: string | null = null
// 当前活动会话的 session-scoped 基准提示词（不含工具段）：createRuntimeSession
// 构建 sessionBasePrompt 后同步更新，productRuntimeHooks 的 getBasePrompt() 读取
// 最新值。reload（runtime_dependencies_update 提交新 systemPrompt）后必须更新本
// 镜像，否则 prepare_next_turn 用旧 basePrompt 重拼会静默冲掉新注入的
// `<available_skills>`（对齐 docs/skills-extension.md §6.1）。
let activeSessionBasePrompt = ''
// 当前活动会话的 Runtime dependency manifest 镜像：bindSession 构建 currentManifest
// 后同步更新；reload 用它作为 `runtime_dependencies_update` 的 previous 载荷。
let activeRuntimeManifest: RuntimeDependencyManifest | null = null

const activeProjectContextSnapshot = () => ({
  projectContext: activeProjectContext,
  projectAgents: activeProjectAgents,
  projectDocs: activeProjectDocs,
  testingContext: activeTestingContext,
})

/**
 * 活动会话当前的访问模式，供提示词重建注入 `# 访问模式` 段。
 *
 * 不设模块级镜像：镜像需要每个写入点同步，而写入点分散（模式切换、会话激活、
 * 停止/归档/切换工作区…），漏一处就会让**另一个会话**的档位写进本会话提示词。
 * 改读 store 的权威投影——本函数只在 store 就绪后的路径上被调用（模式变更、
 * 技能/文档重载、run 结束），不受 createRuntimeSession 的模块求值期 TDZ 影响；
 * 会话创建走快照自带的 accessMode（见 createRuntimeSession）。
 */
const activeSessionAccessMode = (): AccessMode => {
  const state = useAgentStore.getState()
  return state.sessions.find((item) => item.id === state.activeSessionId)?.accessMode
    ?? 'standard'
}

/**
 * 按给定工作区根目录异步加载 AGENTS.md 并扫描 SDD 文档索引，更新模块级镜像。
 * 必须在 bindSession → createRuntimeSession 重建会话提示词前调用，
 * 使 # 项目上下文 段（AGENTS.md 正文 + <available_docs>）反映当前会话绑定的
 * 工作区。无工作区时清空两镜像。仅 Tauri 运行时读取；浏览器开发模式静默降级。
 *
 * 两条读取共用同一个 environment（无状态闭包，安全共享）且互无数据依赖，
 * 并发发起——文档扫描最坏要发 4 次目录列举加数十次读头，串行 await 会让单次
 * readText 的 AGENTS.md 读取被整趟扫描挡在后面。
 */
/**
 * 活动会话基准提示词的**唯一**构造点。
 *
 * 三面项目上下文镜像（AGENTS.md 正文 / 嵌套索引 / 文档索引）必须齐备传入：
 * 漏传一面等于把那一块从 live 提示词里删掉——接入嵌套索引时，技能重载与访问
 * 模式切换两处就漏传过，整块 `<available_agents>` 在用户切一次权限档后消失。
 * 收成一个函数后「齐备」由构造保证，而不是靠四个调用点各自自觉。
 *
 * `accessMode` 由调用方显式传入而非函数内读取：激活路径必须用会话快照自带的
 * 模式（此时 store 尚未投影 `activeSessionId`），其余路径才用 store 权威投影，
 * 两者语义不同，混用会让重建候选与实际提示词分叉。
 */
const buildSessionBasePromptFromContext = ({
  config,
  workspacePath,
  accessMode,
  projectSkills,
  projectContext,
  projectAgents,
  projectDocs,
  testingContext,
}: {
  config: ProviderProfile
  workspacePath: string | undefined
  accessMode: AccessMode
  projectSkills?: ProjectSkillInventorySnapshot | null
  projectContext: string | null
  projectAgents: ProjectAgentsInventory
  projectDocs: ProjectDocInventory
  testingContext: string | null
}): string => buildSessionBasePrompt({
  capabilities: runtimeCapabilities,
  workspacePath,
  authorizedFilePaths: activeAuthorizedReadFiles.map((file) => file.path),
  accessMode,
  projectContext,
  projectAgents,
  projectSkills: projectSkills ?? getActiveProjectSkillSnapshot(),
  projectDocs,
  testingContext,
  modelName: resolvePromptModelName(config),
})

const buildActiveSessionBasePrompt = (
  input: Omit<
    Parameters<typeof buildSessionBasePromptFromContext>[0],
    'projectContext' | 'projectAgents' | 'projectDocs' | 'testingContext'
  >,
): string => buildSessionBasePromptFromContext({ ...input, ...activeProjectContextSnapshot() })

const refreshProjectContext = async (workspacePath?: string): Promise<void> => {
  const environment = workspacePath && isTauriRuntime()
    ? createDesktopAgentEnvironment(workspacePath)
    : null
  if (!environment) {
    const docsChanged = !projectDocInventoryEqual(activeProjectDocs, EMPTY_PROJECT_DOC_INVENTORY)
    activeProjectContext = null
    activeProjectAgents = EMPTY_PROJECT_AGENTS_INVENTORY
    activeProjectDocs = EMPTY_PROJECT_DOC_INVENTORY
    activeTestingContext = null
    useAgentStore.setState({ projectDocs: EMPTY_PROJECT_DOC_INVENTORY })
    if (docsChanged) notifyProjectDocsChanged()
    return
  }
  const [contextLoad, scannedAgents, inventory] = await Promise.all([
    loadProjectContext(environment),
    loadProjectAgents(environment),
    loadProjectDocs(environment),
  ])
  // 激活路径一律以本次结果为准，**不沿用上一份**：切换工作区后旧内容属于另一个
  // 工作区，留着等于把 A 项目的约定注入 B 项目的会话。故 unavailable 与
  // absent 同样落空，差别只在可观测性（下次激活会重试）。
  if (contextLoad.kind === 'unavailable') {
    console.error('[项目上下文] 根 AGENTS.md 读取失败，激活时按无正文处理（不得沿用上一工作区的正文）')
  }
  activeProjectContext = contextLoad.kind === 'content' ? contextLoad.content : null
  if (scannedAgents === null) {
    console.error('[项目上下文] 嵌套 AGENTS.md 扫描失败，激活时按空清单处理（不得沿用上一工作区的索引）')
    activeProjectAgents = EMPTY_PROJECT_AGENTS_INVENTORY
  } else {
    activeProjectAgents = scannedAgents
  }
  const docsChanged = !projectDocInventoryEqual(activeProjectDocs, inventory)
  activeProjectDocs = inventory
  activeTestingContext = null
  useAgentStore.setState({ projectDocs: inventory })
  if (docsChanged) notifyProjectDocsChanged(workspacePath)
}
/**
 * 检查 formatAvailableSkills 的 32 KiB metadata 预算省略，为每个被省略的 skill
 * 生成 metadata_budget_exceeded 诊断（此前该 diagnostic code 声明了但无人 push）。
 */
const appendBudgetDiagnostics = (
  snapshot: ProjectSkillInventorySnapshot,
  diagnostics: SkillDiagnostic[],
): SkillDiagnostic[] => {
  // 与 buildSessionBasePrompt 同一本地化入参：清单字节随 description 语言/覆写变化，
  // 省略集合保持与实际注入一致。
  const { omittedSkillNames } = formatAvailableSkills(snapshot, {
    language: resolvePromptLanguage(),
    skillOverrides: getBuiltinPromptOverrides().skills,
  })
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
    const newBasePrompt = buildActiveSessionBasePrompt({
      config,
      workspacePath,
      accessMode: activeSessionAccessMode(),
      projectSkills: result.snapshot,
    })
    const newSystemPrompt = buildSystemPrompt({
      basePrompt: newBasePrompt,
      tools: active.runtimeContext.tools,
      activeToolNames,
      gitBranchPrefix: getGitBranchPrefix(),
    })
    const currentManifest = createRuntimeDependencyManifest(
      config,
      active.runtimeContext.tools,
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
 * 访问模式变更后重建活动会话提示词，使 `# 访问模式` 段如实反映当前档位。
 *
 * **顺序是这条函数的全部要点**：先更新 basePrompt 镜像，再按运行态决定是否提交
 * 重载。镜像更新必须先做——live systemPrompt 在 run 进行中不可热替换，而
 * `prepare_next_turn` 每轮末从 `getBasePrompt()` 重拼提示词，这是运行中唯一能
 * 生效的通道；若把镜像更新放在 `isRunning` 早退之后（原实现），运行中切换模式
 * 会连镜像都不更新，该会话**后续所有 run** 都停在旧档直到下次会话激活。
 *
 * idle 时再经 runtime_dependencies_update 原子替换 systemPrompt + manifest，
 * 使提示词立即对齐。
 */
const refreshSystemPromptForAccessMode = async (): Promise<void> => {
  const active = session
  if (!active) return
  const config = useAgentStore.getState().provider
  const workspacePath = useAgentStore.getState().authorizedWorkspace?.path
  const activeToolNames = Array.from(active.activeToolNames)
  const newBasePrompt = buildActiveSessionBasePrompt({
    config,
    workspacePath,
    accessMode: activeSessionAccessMode(),
  })
  // 提示词未变时不做任何事：避免无谓的 manifest 写入与 checkpoint 失效。
  if (newBasePrompt === (getRuntimeBasePrompt(active.id) ?? activeSessionBasePrompt)) return
  setRuntimeBasePrompt(active.id, newBasePrompt)
  if (useAgentStore.getState().activeSessionId === active.id) {
    activeSessionBasePrompt = newBasePrompt
  }
  if (active.isRunning) return
  const previousManifest = activeRuntimeManifest
  if (!previousManifest) return
  const newSystemPrompt = buildSystemPrompt({
    basePrompt: newBasePrompt,
    tools: active.runtimeContext.tools,
    activeToolNames,
    gitBranchPrefix: getGitBranchPrefix(),
  })
  const currentManifest = createRuntimeDependencyManifest(
    config,
    active.runtimeContext.tools,
    active.hooks.dependencies(),
    getActiveProjectSkillSnapshot(),
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
  activeRuntimeManifest = currentManifest
}

/**
 * run 结束后对齐活动会话提示词的访问模式段。
 *
 * 等 harness 真正空闲再调用 {@link refreshSystemPromptForAccessMode}——agent_end
 * 的发射时机未必已落回 idle，直接调用只会走到「仅更新镜像」的分支。等待期间用户
 * 可能切走会话：刷新作用于当时的活动会话，读的是它自己的档位，故切换后执行也无害。
 */
const refreshSystemPromptAfterIdle = async (): Promise<void> => {
  const active = session
  if (!active || active.isDisposed) return
  await active.waitForIdle()
  await refreshSystemPromptForAccessMode()
}

/**
 * 用重扫得到的项目上下文（AGENTS.md 正文 + 文档索引）更新两个镜像并按需重建
 * 会话提示词。与 {@link applyProjectSkillsToSession} 同构（idle 时经
 * runtime_dependencies_update 替换 systemPrompt + manifest，忙碌时只更新镜像、
 * 后续会话构建生效），差别在于上下文不进技能 snapshot——manifest 只依赖 skills，
 * systemPrompt 才消费上下文。
 *
 * 两面镜像必须在同一个动作里提交：只更新其中一面会让下一次提示词重建把
 * 「新的文档索引 + 陈旧的 AGENTS.md」混装进同一次提交——finish 阶段要求模型
 * 同步 AGENTS.md，若该改动要等到下次会话激活才可见，模型自己看不到自己刚写的
 * 内容。回滚同理两面一起回，否则提交失败后镜像与 live 提示词分叉。
 */
const applyProjectContextToSession = async (next: {
  projectContext: string | null
  projectAgents: ProjectAgentsInventory
  projectDocs: ProjectDocInventory
  testingContext: string | null
}): Promise<void> => {
  const previousContext = activeProjectContext
  const previousAgents = activeProjectAgents
  const previousDocs = activeProjectDocs
  const previousTesting = activeTestingContext
  const docsChanged = !projectDocInventoryEqual(previousDocs, next.projectDocs)
  activeProjectContext = next.projectContext
  activeProjectAgents = next.projectAgents
  activeProjectDocs = next.projectDocs
  activeTestingContext = next.testingContext
  useAgentStore.setState({ projectDocs: next.projectDocs })
  if (docsChanged) notifyProjectDocsChanged()
  const active = session
  if (!active || active.isRunning) return
  const previousManifest = activeRuntimeManifest
  if (!previousManifest) return
  const config = useAgentStore.getState().provider
  const workspacePath = useAgentStore.getState().authorizedWorkspace?.path
  const activeToolNames = Array.from(active.activeToolNames)
  // 镜像已在函数开头写入，故此处读到的就是 next 的三面值。
  const newBasePrompt = buildActiveSessionBasePrompt({
    config,
    workspacePath,
    accessMode: activeSessionAccessMode(),
  })
  const newSystemPrompt = buildSystemPrompt({
    basePrompt: newBasePrompt,
    tools: active.runtimeContext.tools,
    activeToolNames,
    gitBranchPrefix: getGitBranchPrefix(),
  })
  const currentManifest = createRuntimeDependencyManifest(
    config,
    active.runtimeContext.tools,
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
    // 提交失败回滚三面镜像：维持旧提示词与镜像一致，下次 run 结束重扫会再尝试。
    // 调度器会吞掉异常（单轮失败不中断补扫轮），故此处必须自行记日志，
    // 否则「上下文正在退化」在 UI 与日志里都无从发现。
    console.error('[项目上下文] runtime_dependencies_update 提交失败，已回滚三面镜像', error)
    activeProjectContext = previousContext
    activeProjectAgents = previousAgents
    activeProjectDocs = previousDocs
    activeTestingContext = previousTesting
    useAgentStore.setState({ projectDocs: previousDocs })
    throw error
  }
  activeSessionBasePrompt = newBasePrompt
  setRuntimeBasePrompt(active.id, newBasePrompt)
  activeRuntimeManifest = currentManifest
}

/**
 * 发布/清除测试页上下文段（测试页在挂载与数据变化时调用，卸载时传 null）。
 *
 * 与项目上下文共用同一个动作，因此同样是「镜像先更新、再提交 live 提示词」：
 * 运行中的会话保持当前提示词（镜像已变，下一轮生效），提交失败回滚镜像。
 *
 * **门放在调用点**：`agent/**` 只接收字符串，"是否在测试页"的判定完全由页面决定——
 * 没人在测试页时永远不发布，段自然不出现（也就不需要视图判定渗进 agent 层）。
 */
export const setTestingPromptContext = async (text: string | null): Promise<void> => {
  if (activeTestingContext === text) return
  try {
    await applyProjectContextToSession({
      projectContext: activeProjectContext,
      projectAgents: activeProjectAgents,
      projectDocs: activeProjectDocs,
      testingContext: text,
    })
  } catch (error) {
    // 提示词刷新失败不该把测试页打红：动作内已回滚镜像，下一轮激活/刷新会再对齐。
    console.error('[测试上下文] 会话提示词提交失败，已保留原值', error)
  }
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
 * 激活会话的基准提示词（不含工具段）：授权上下文 + 项目上下文 + 访问模式段。
 *
 * 三处激活路径（bindSession / cached 激活 / 重启恢复）原各自拼装同一组参数——
 * 参数一旦不同，对账候选与实际提示词就会分叉。收成一个函数后「同源」由构造保证。
 */
const buildActivationBasePrompt = (
  session: Pick<StoredAgentSession, 'accessMode' | 'workspace'> | undefined,
  config: ProviderProfile,
): string => buildActiveSessionBasePrompt({
  config,
  workspacePath: session?.workspace?.path,
  accessMode: session?.accessMode ?? 'standard',
})

/**
 * 激活边界的提示词对账，并在替换生效后同步 per-session basePrompt 镜像。
 *
 * **镜像必须与 live 提示词同源**：`prepare_next_turn` 每轮末从镜像重拼提示词
 * （`getBasePrompt()`），只替换 live 会让下一次回流把刚修掉的漂移带回——档位镜像
 * 曾因此掩盖过一次缺陷。这里把「替换 live + 同步镜像」绑成一个动作，使对账不再是
 * 唯一只改一半的路径。对账未生效（无漂移）时不动镜像。
 *
 * 异常不外吞：调用点记日志并依赖轮次回流兜底（fail-soft 策略归调用方）。
 */
const reconcileSessionPrompt = async (
  harness: AgentHarness,
  sessionId: string,
  basePrompt: string,
  manifest: RuntimeDependencyManifest,
): Promise<void> => {
  const applied = await reconcileSessionPromptOnActivation(
    harness,
    manifest,
    buildReconcileCandidateSystemPrompt(harness, basePrompt),
  )
  if (!applied) return
  setRuntimeBasePrompt(sessionId, basePrompt)
  activeSessionBasePrompt = basePrompt
}

/**
 * run 结束后的延迟项目上下文刷新（单轮刷新体）：等待会话完全 idle 后重扫
 * AGENTS.md 正文与受管目录索引，任一有变化才重建提示词。覆盖所有写入路径
 * （write/edit/apply_changes/restore_trash 以及无法可靠解析参数的 bash），
 * 无需逐工具匹配参数——未变化时零副作用。
 *
 * **AGENTS.md 与索引必须在同一轮里刷新**：finish 阶段的收口动作就是同步
 * AGENTS.md，若它要等到下次会话激活才对模型可见，模型改完看不到自己刚写的约定，
 * 而同一次重建里文档索引已是新的——两面新鲜度分叉比两者都旧更难排查。
 * AGENTS.md 是纯文本，直接比字符串即可，无需索引那样的结构化深比较。
 * fail-soft：刷新失败只跳过该轮（会话激活路径仍会兜底刷新）。
 *
 * 调度键是触发 `agent_end` 的会话 ID：前台会话沿用活动镜像的原子提交路径；
 * 后台缓存 harness 从 per-session 快照出发，扫描自己的绑定工作区并只更新自己。
 * 会话切换不会改变本轮归属，不同会话之间可并行刷新。
 */
const refreshBackgroundProjectContext = async (
  sessionId: string,
  target: AgentHarness,
): Promise<void> => {
  const state = useAgentStore.getState()
  const stored = state.sessions.find((item) => item.id === sessionId)
  const providerState = getRuntimeProvider(sessionId)
  const previousManifest = stored?.runtimeManifest
  const workspacePath = sessionWorkspacePaths.pathOf(sessionId) ?? stored?.workspace?.path
  const previous = getRuntimeProjectContext(sessionId)
  if (!stored || !providerState || !previousManifest || !workspacePath || !previous || !isTauriRuntime()) return
  const environment = createDesktopAgentEnvironment(workspacePath)
  const [contextLoad, scannedAgents, inventory] = await Promise.all([
    loadProjectContext(environment),
    loadProjectAgents(environment),
    loadProjectDocs(environment),
  ])
  if (contextLoad.kind === 'unavailable') {
    console.error(`[项目上下文] 后台会话 ${sessionId} 的根 AGENTS.md 读取失败，保留上一份正文`)
  }
  if (scannedAgents === null) {
    console.error(`[项目上下文] 后台会话 ${sessionId} 的嵌套 AGENTS.md 扫描失败，保留上一份索引`)
  }
  const projectContext = contextLoad.kind === 'content'
    ? contextLoad.content
    : contextLoad.kind === 'absent'
      ? null
      : previous.projectContext
  const projectAgents = scannedAgents ?? previous.projectAgents
  const docsChanged = !projectDocInventoryEqual(inventory, previous.projectDocs)
  const promptUnchanged = projectContext === previous.projectContext
    && projectAgentsInventoryEqual(projectAgents, previous.projectAgents)
    && projectDocPromptInventoryEqual(inventory, previous.projectDocs)
  if (target.isDisposed || target.isRunning) return
  // 后台会话与当前激活工作区相同时，把最新索引同步到全局投影，避免设置页
  // 的文档诊断停留在旧扫描；不同工作区互不影响。
  const mirrorsActiveWorkspace = useAgentStore.getState().authorizedWorkspace?.path === workspacePath
  if (promptUnchanged) {
    // 仅正文 revision 变化：后台会话的 live 提示词不变，但 DocsView 仍应重扫。
    if (!docsChanged) return
    setRuntimeProjectContext(sessionId, { ...previous, projectDocs: inventory })
    if (mirrorsActiveWorkspace) useAgentStore.setState({ projectDocs: inventory })
    notifyProjectDocsChanged(workspacePath)
    return
  }
  const projectSnapshot = {
    projectContext,
    projectAgents,
    projectDocs: inventory,
    testingContext: previous.testingContext,
  }
  const activeToolNames = Array.from(target.activeToolNames)
  const newBasePrompt = buildSessionBasePromptFromContext({
    config: providerState.config,
    workspacePath,
    accessMode: stored.accessMode ?? 'standard',
    projectSkills: previousManifest.skills,
    ...projectSnapshot,
  })
  const currentManifest = createRuntimeDependencyManifest(
    providerState.config,
    target.runtimeContext.tools,
    target.hooks.dependencies(),
    previousManifest.skills,
  )
  try {
    await target.updateRuntimeDependencies({
      previous: {
        systemPrompt: target.systemPrompt,
        activeToolNames,
        runtimeManifest: previousManifest,
      },
      current: {
        systemPrompt: buildSystemPrompt({
          basePrompt: newBasePrompt,
          tools: target.runtimeContext.tools,
          activeToolNames,
          gitBranchPrefix: getGitBranchPrefix(),
        }),
        activeToolNames,
        runtimeManifest: currentManifest,
      },
    })
  } catch (error) {
    console.error(`[项目上下文] 后台会话 ${sessionId} 的 runtime_dependencies_update 提交失败`, error)
    throw error
  }
  setRuntimeProjectContext(sessionId, projectSnapshot)
  setRuntimeBasePrompt(sessionId, newBasePrompt)
  if (docsChanged) {
    if (mirrorsActiveWorkspace) useAgentStore.setState({ projectDocs: inventory })
    notifyProjectDocsChanged(workspacePath)
  }
}

const refreshProjectContextOnce = async (sessionId: string): Promise<void> => {
  const target = getRuntimeSession(sessionId)
  if (!target || target.isDisposed) return
  await target.waitForIdle()
  if (getRuntimeSession(sessionId) !== target || target.isDisposed) return
  if (sessionId !== useAgentStore.getState().activeSessionId || target !== session) {
    await refreshBackgroundProjectContext(sessionId, target)
    return
  }
  const workspacePath = useAgentStore.getState().authorizedWorkspace?.path
  if (!workspacePath || !isTauriRuntime()) return
  const environment = createDesktopAgentEnvironment(workspacePath)
  const [contextLoad, scannedAgents, inventory] = await Promise.all([
    loadProjectContext(environment),
    loadProjectAgents(environment),
    loadProjectDocs(environment),
  ])
  // 读取/扫描失败一律保留上一份镜像，而不是提交空值：一次偶发的 IPC 或权限错误
  // 若被当成「确实没有」，整段正文与整块索引会被从 live 提示词删掉，退化窗口横跨
  // 一整个 run，其间模型可能在「以为项目没有这些约定」的状态下改代码。下轮自愈。
  if (contextLoad.kind === 'unavailable') {
    console.error('[项目上下文] 根 AGENTS.md 读取失败，保留上一份正文；下一个 run 结束会重试')
  }
  if (scannedAgents === null) {
    console.error('[项目上下文] 嵌套 AGENTS.md 扫描失败，保留上一份索引；下一个 run 结束会重试')
  }
  const projectContext = contextLoad.kind === 'content'
    ? contextLoad.content
    : contextLoad.kind === 'absent'
      ? null
      : activeProjectContext
  const projectAgents = scannedAgents ?? activeProjectAgents
  const docsChanged = !projectDocInventoryEqual(inventory, activeProjectDocs)
  const promptUnchanged = projectContext === activeProjectContext
    && projectAgentsInventoryEqual(projectAgents, activeProjectAgents)
    && projectDocPromptInventoryEqual(inventory, activeProjectDocs)
  if (promptUnchanged) {
    // 只有正文 revision 变化：不重建提示词/不失效 checkpoint，但要把新索引
    // 写回镜像与运行时快照，并通知 DocsView 重扫当前正文。
    if (!docsChanged) return
    activeProjectDocs = inventory
    useAgentStore.setState({ projectDocs: inventory })
    setRuntimeProjectContext(sessionId, {
      projectContext,
      projectAgents,
      projectDocs: inventory,
      testingContext: activeTestingContext,
    })
    notifyProjectDocsChanged()
    return
  }
  const nextSnapshot = {
    projectContext,
    projectAgents,
    projectDocs: inventory,
    testingContext: activeTestingContext,
  }
  await applyProjectContextToSession(nextSnapshot)
  setRuntimeProjectContext(sessionId, nextSnapshot)
}

/**
 * 调度器（尾沿合并单飞）：agent_end 连续触发（重试/队列排空）时，在途刷新期间
 * 到达的触发不丢弃而是合并为补扫轮——在途扫描可能已读过旧磁盘，丢弃尾沿会让
 * 上下文停留在旧值直到下一次 agent_end/会话激活。
 */
const projectContextRefreshScheduler = createProjectDocsRefreshScheduler(refreshProjectContextOnce)
const approvalWiring = createApprovalWiring({
  workspacePathOf: (sessionId) => sessionWorkspacePaths.pathOf(sessionId),
  isWorkspaceAuthorized: (workspacePath) => useAgentStore.getState().authorizedWorkspaces
    .some((workspace) => workspace.path === workspacePath),
  approvalTimeoutMs: () => activeAgentLimitsSettings.approvalTimeoutMs,
  accessModeOf: (sessionId) => useAgentStore.getState().sessions.find(
    (candidate) => candidate.id === sessionId,
  )?.accessMode ?? 'standard',
  onAutomaticFallback: (reason) => useAgentStore.setState({
    settingsError: `完全访问自动授权失败，已安全回落为本次逐次审批：${reason}`,
  }),
})
const approvalCoordinator = approvalWiring.coordinator
const createAccessModeAwareToolCall = approvalWiring.createBeforeToolCall

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
    // sessionBasePrompt 严格相等（都使用 runtimeCapabilities、
    // REGISTERED_TOOLS / DEFAULT_ACTIVE_TOOL_NAMES 与当前 gitBranchPrefix）。
    systemPrompt: buildSystemPrompt({
      basePrompt: buildSessionBasePrompt({
        capabilities: runtimeCapabilities,
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
  level: stored.reasoning?.level ?? DEFAULT_REASONING_SETTINGS.level,
  mode: stored.reasoning?.mode ?? activeReasoningSettings.mode,
  budgetTokens: stored.reasoning?.budgetTokens ?? activeReasoningSettings.budgetTokens,
}, config.apiFormat, config.maxOutputTokens)

const restoredActiveToolNames = (restored?: Pick<StoredAgentSession, 'activeToolNames'>): string[] => {
  return projectSessionActiveToolNames(restored?.activeToolNames, REGISTERED_TOOLS, DEFAULT_ACTIVE_TOOL_NAMES)
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
  const subAgentEnvironment = workspacePath || isTauriRuntime()
    ? createDesktopAgentEnvironment(workspacePath, resolvedSessionId)
    : undefined
  const toolRuntime = subAgentEnvironment
    ? createProductToolRuntime(runtimeCapabilities, subAgentEnvironment, {
      testAutomation: RUNTIME_POLICY.testAutomation,
    })
    : DESKTOP_TOOL_RUNTIME
  const model = resolveProviderModel(config)
  const transport = providerRequiresApiKey(config.providerId) && !configuredKey
    ? createProviderSetupRequiredTransport(config.providerId)
    : createProviderTransport(config, configuredKey).transport
  // 端点绑定已下沉到 Rust 侧 provider_profiles::resolve_profile（stream/probe 时强校验），
  // 激活时不再需要前端主动登记 origin。
  sessionWorkspacePaths.bind(resolvedSessionId, workspacePath)
  // 按会话授权状态重建基准/完整提示词：授权上下文段（工作区根目录 + 已授权
  // 文件）+ 项目上下文段（AGENTS.md）+ 模型身份段（config.modelName）使安全
  // 边界、项目约定与底层模型身份如实可执行。无授权上下文、无项目上下文且
  // 模型身份一致时，结果与 sessionDefaults 的默认提示词严格相等。hooks 用
  // 同一份 basePrompt 做工具准则回流，保证重建候选与当前提示词可比。
  const sessionBasePrompt = buildActivationBasePrompt(restoredRuntime, config)
  activeSessionBasePrompt = sessionBasePrompt
  // per-session basePrompt 镜像：harness hook（prepareNextTurn 工具准则回流）按会话
  // 读取，避免后台会话被其他会话的激活/刷新覆盖（不同工作目录会话串台）。
  setRuntimeBasePrompt(resolvedSessionId, sessionBasePrompt)
  setRuntimeProjectContext(resolvedSessionId, activeProjectContextSnapshot())
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
      maxTotalTokens: agentLimitsSettings.maxTotalTokens,
    },
    steeringMode: activeQueueModeSettings.steering,
    followUpMode: activeQueueModeSettings.followUp,
    autoDrain: activeQueueModeSettings.autoDrain,
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
    getBasePrompt: () => getRuntimeBasePrompt(resolvedSessionId) ?? (session.id === resolvedSessionId ? activeSessionBasePrompt : sessionBasePrompt),
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
    return createRuntimeDependencyManifest(
      getRuntimeProvider(sessionId)?.config ?? config,
      REGISTERED_TOOLS,
      nextSession.hooks.dependencies(),
      useAgentStore.getState().sessions.find((item) => item.id === sessionId)?.runtimeManifest?.skills ?? currentManifest.skills,
    )
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
    queuedMessages: [],
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
    let projectionError: unknown
    try {
      handleSessionEvent(event, boundSessionId, nextSession)
    } catch (error) {
      // 投影错误发生在写库成功之后：显式标记为与落库无关，否则 agent 层会按「消息未落库」
      // 回收——回滚已落库消息的内存边界（Save Point 与持久化边界失配），并把已 applied
      // 的队列消息重新入队（重复投递）。
      projectionError = markPersistenceUnrelated(error)
    }
    // run 结束后延迟重扫项目上下文：会话内新写/删除的 .specs/.plans/.docs
    // 文档要在 <available_docs> 中可见，否则后续轮次（尤其压缩后）按陈旧索引
    // 误判「不存在对应 Spec」；同一轮也重读 AGENTS.md，让 finish 阶段刚同步的
    // 项目约定立即对模型可见。放在 handleSessionEvent 之后、fail-soft 异步执行。
    if (event.type === 'agent_end') {
      projectContextRefreshScheduler.trigger(boundSessionId)
      // run 结束再对齐一次访问模式段：运行中切换模式时 live systemPrompt 无法热替换，
      // 只能先改 basePrompt 镜像、由 prepare_next_turn 在下一个 turn 边界生效；若切换
      // 发生在末段（此后没有新的 turn 边界），提示词会停在旧档。这里空闲后补一次完整
      // 重建——文档重扫有「索引未变即返回」的相等门，不能依赖它兜底。
      // 只对激活会话做：refreshSystemPromptForAccessMode 作用于模块级活动 harness。
      if (boundSessionId === useAgentStore.getState().activeSessionId) {
        void refreshSystemPromptAfterIdle()
      }
    }
    if (persistenceError !== undefined) throw persistenceError
    if (projectionError !== undefined) throw projectionError
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
        await reconcileSessionPrompt(
          session,
          prepared.snapshot.session.id,
          buildActivationBasePrompt(prepared.snapshot.session, prepared.config),
          activeRuntimeManifest,
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
    queuedMessages: [],
  }
  const workspace = options.snapshot.session.workspace
  // 缓存激活不经过 createRuntimeSession，此处按快照重建工作区绑定。
  // 撤销工作区时绑定与快照的 session.workspace 一并不保留（同源、同时失效）：
  // 被撤销的会话此处绑定为空，且其工作区为 null 使全局 authorizedWorkspace 也
  // 为 null → Composer 的 workspaceReady 为假，该会话在重新绑定工作区前不可运行。
  sessionWorkspacePaths.bind(options.snapshot.session.id, workspace?.path)
  // 对齐 prepareSessionActivation（744-745）：cached 激活同样刷新 AGENTS.md 与
  // .axiom/skills 模块级镜像，并重建 basePrompt / runtimeManifest 镜像。否则切回
  // 缓存会话后 applyProjectSkillsToSession / prepareNextTurn 会用上一个工作区的
  // activeProjectContext / activeSessionBasePrompt 重建提示词（不同目录会话串台）。
  await Promise.all([
    refreshProjectContext(workspace?.path),
    refreshProjectSkills(workspace?.path),
  ])
  // 会话绑定边界重建基准提示词：此处 store 尚未投影 activeSessionId，但快照自带
  // 模式与工作区，取用同一构建函数使镜像与 live 提示词同源。
  const sessionBasePrompt = buildActivationBasePrompt(options.snapshot.session, config)
  activeSessionBasePrompt = sessionBasePrompt
  setRuntimeBasePrompt(options.snapshot.session.id, sessionBasePrompt)
  setRuntimeProjectContext(options.snapshot.session.id, activeProjectContextSnapshot())
  activeRuntimeManifest = createRuntimeDependencyManifest(
    config,
    options.runtime.runtimeContext.tools,
    options.runtime.hooks.dependencies(),
    options.snapshot.session.runtimeManifest?.skills ?? getActiveProjectSkillSnapshot(),
  )
  // 激活边界提示词对账：cached 会话复用原 harness 的 live 提示词，后台/闲置期间的
  // 文档漂移（自己后台 run 写入、外部编辑）在此写入，否则要等下一次 run 的首个
  // turn_end 回流，首轮模型调用仍用旧 <available_docs>。manifest 取持久化冻结值
  // 优先：对账只换提示词，不把 skills 快照悄悄换成磁盘现状（削弱 load_skill 的
  // fail-closed 语义）。运行中的后台会话被切回时由回流在 turn_end 自愈，此处跳过。
  try {
    await reconcileSessionPrompt(
      options.runtime,
      options.snapshot.session.id,
      sessionBasePrompt,
      options.snapshot.session.runtimeManifest ?? activeRuntimeManifest,
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
  // 缓存 harness 不经 createRuntimeSession 重建，队列模式停留在创建时的全局设置值；
  // 切回时对齐当前设置，否则 Composer 的「自动逐条发送」开关与会话实际 drain 行为
  // 漂移。autoDrain 只在值确实变化时重设——setAutoDrain 会作废武装标记，无事切换
  // 不得丢失「已放行待注入」的即时反馈。
  const cachedModes = options.runtime.queueModes
  if (cachedModes.steering !== activeQueueModeSettings.steering
    || cachedModes.followUp !== activeQueueModeSettings.followUp) {
    options.runtime.setQueueModes(activeQueueModeSettings.steering, activeQueueModeSettings.followUp)
  }
  if (cachedModes.autoDrain !== activeQueueModeSettings.autoDrain) {
    options.runtime.setAutoDrain(activeQueueModeSettings.autoDrain)
  }
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
    accessMode: options.snapshot.session.accessMode ?? 'standard',
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
  cancelPendingApprovals: (sessionId, reason) =>
    approvalCoordinator.cancelForSession(sessionId, reason),
  refreshSystemPromptForAccessMode,
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
    getRegisteredTools: () => boundRuntime.runtimeContext.tools,
    buildRuntimeManifest: (provider, runtime) => createRuntimeDependencyManifest(
      provider,
      boundRuntime.runtimeContext.tools,
      runtime.hooks.dependencies(),
      useAgentStore.getState().sessions.find((item) => item.id === boundSessionId)?.runtimeManifest?.skills ?? getActiveProjectSkillSnapshot(),
    ),
  })
}

/** 后台 run 容量拒绝：写入该会话投影，切回会话时可见原因。 */
const reportBackgroundRunCapacity = (sessionId: string, message: string): void => {
  const projection = getRuntimeProjection(sessionId)
  if (projection) {
    projection.error = message
    setRuntimeProjection(sessionId, projection)
    return
  }
  setRuntimeProjection(sessionId, {
    activeTools: {},
    endReason: null,
    error: message,
    compactionRunning: false,
    queuedMessages: [],
  })
}

const backgroundRunCount = (sessions: AgentState['sessions'], excludedId: string): number =>
  sessions.filter((session) => session.id !== excludedId && session.status === 'running').length

export const useAgentStore = create<AgentState>()((set, get) => ({
  ...createAgentSessionSlice(set, get, runtimeDeps),
  ...createAgentSessionManagementSlice(set, get, runtimeDeps),
  ...createAgentProviderSlice(set, get, runtimeDeps),
  ...createAgentWorkspaceSlice(set, get, runtimeDeps),
  ...createAgentSettingsSlice(set, get, runtimeDeps),
  ...storageStatsSlice,
  settingsError: null,
  sendManifests: {},
  recordSendManifest: (manifest) => set((state) => ({
    sendManifests: {
      ...state.sendManifests,
      [manifest.sessionId ?? manifest.requestId]: manifest,
    },
  })),
  initializationError: null,
  runtimeLifecycle: 'initializing',
  storageStats: null,
  contextPolicySaving: false,
  projectSkills: EMPTY_PROJECT_SKILL_INVENTORY,
  skillDiagnostics: [],
  projectDocs: EMPTY_PROJECT_DOC_INVENTORY,
  projectDocsRevision: 0,
  projectDocsWorkspacePath: null,
  refreshActiveProjectContext: async () => {
    const sessionId = useAgentStore.getState().activeSessionId
    if (!sessionId) return
    // 走与 agent_end 相同的按会话单飞 + 尾沿合并：保存后直接调
    // refreshProjectContextOnce 会与在途的 run 结束刷新并发扫描，旧快照可能
    // 后提交。flush 会确保在途轮之后再补扫一轮并等待其结束。
    await projectContextRefreshScheduler.flush(sessionId)
  },
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
          const runtimeInfo = isTauriRuntime() ? await getRuntimeInfo().catch(() => null) : null
          runtimeCapabilities = createRuntimePolicy({
            development: RUNTIME_POLICY.mode === 'development',
            desktop: RUNTIME_POLICY.desktop,
            operatingSystem: runtimeInfo?.operatingSystem,
            sandboxAvailable: runtimeInfo?.sandboxAvailable === true,
          }).toolCapabilities
          DESKTOP_TOOL_RUNTIME = createProductToolRuntime(runtimeCapabilities, desktopAgentEnvironment, {
            testAutomation: RUNTIME_POLICY.testAutomation,
          })
          REGISTERED_TOOLS = DESKTOP_TOOL_RUNTIME.tools
          DEFAULT_ACTIVE_TOOL_NAMES = DESKTOP_TOOL_RUNTIME.activeToolNames
          // 持久化的 Provider selection 需经 Rust 权威解析（异步），在此加载后覆盖模块级 fallback。
          const initialProviderSelection = await loadProviderSelection()
          const config = initialProviderSelection.config
          loadedProviderProfiles = await loadProviderProfiles(
            config,
            !initialProviderSelection.requiresSetup,
          )
          set({ initializationError: null, runtimeLifecycle: 'initializing' })
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
              await reconcileSessionPrompt(
                session,
                canonical.snapshot.session.id,
                // 重启恢复：会话快照的 workspace 可能尚未回填到 store，用已恢复授权的
                // 工作区路径（与 createRuntimeSession 的取值一致，见 prepareSessionActivation）。
                buildActivationBasePrompt(
                  { ...canonical.snapshot.session, workspace: authorizedWorkspace ?? canonical.snapshot.session.workspace },
                  activeConfig,
                ),
                activeRuntimeManifest,
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
            accessMode: canonical.snapshot.session.accessMode ?? 'standard',
            recoveredRuns: initialized.recoveredRuns,
            recoverySummary: initialized.recoverySummary,
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
              accessMode: fallback.active.session.accessMode ?? 'standard',
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

  stop: async () => {
    const sessionId = session.id
    const result = await stopSessionRuntime(session, (error) => set({ settingsError: `停止时收口会话权限失败：${errorMessage(error)}` }))
    await resetSessionAccessMode(
      set,
      get,
      runtimeDeps,
      sessionId,
    )
    await refreshSystemPromptForAccessMode()
    return result
  },

  // 后台会话停止入口：直接作用于目标会话的缓存 harness（含激活会话），与
  // stop()（模块级激活 harness）等价——多会话并行时侧栏可直接停后台 run，
  // 不必切换会话。
  stopSession: async (sessionId) => {
    const runtime = getRuntimeSession(sessionId)
    if (!runtime) return null
    const result = await stopSessionRuntime(runtime, (error) => set({ settingsError: `停止时收口会话权限失败：${errorMessage(error)}` }))
    await resetSessionAccessMode(
      set,
      get,
      runtimeDeps,
      sessionId,
    )
    await refreshSystemPromptForAccessMode()
    return result
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
    if (!runtime) return false
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
    // 运行中的后台会话不再只能 stop：与前台同一语义排队 steering（在下一个 turn
    // 边界注入），队列投影随事件刷新到 per-session projection，侧栏据此显示条数。
    if (runtime.isRunning) {
      try {
        const acceptance = await runtime.steer(content)
        if (acceptance.accepted) {
          const queued = runtime.queuedMessages
          const projection = getRuntimeProjection(sessionId)
          if (projection) {
            projection.queuedMessages = queued
            setRuntimeProjection(sessionId, projection)
          }
          // 侧栏徽标立即反映本次后台投递（不等下一个事件）。
          set((current) => ({
            sessionQueueCounts: withSessionQueueCount(
              current.sessionQueueCounts,
              sessionId,
              queued.length,
            ),
          }))
        }
        return acceptance.accepted
      } catch (error) {
        const projection = getRuntimeProjection(sessionId)
        if (projection) {
          projection.error = error instanceof Error ? error.message : String(error)
          setRuntimeProjection(sessionId, projection)
        }
        return false
      }
    }
    const capacityError = backgroundRunCapacityError(backgroundRunCount(get().sessions, sessionId))
    if (capacityError) {
      reportBackgroundRunCapacity(sessionId, capacityError)
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

  // 后台会话队列放行入口：运行中放行队首（sendQueuedNow 武装注入），空闲时取出
  // 队首作为新 run 启动——与 sendToSession 的 gating / 投影错误处理同口径，
  // 使 autoDrain=false 的后台队列不必切到前台也能逐条消费。
  releaseQueuedForSession: async (sessionId) => {
    const state = get()
    if (!sessionId || state.runtimeLifecycle !== 'ready' || !state.providerReady) return false
    if (state.providerSetupRequired) return false
    const runtime = getRuntimeSession(sessionId)
    if (!runtime) return false
    const workspacePath = state.sessions
      .find((stored) => stored.id === sessionId)
      ?.workspace?.path
    if (
      !workspacePath
      || !state.authorizedWorkspaces.some((workspace) => workspace.path === workspacePath)
    ) {
      return false
    }
    if (runtime.isRunning) {
      try {
        const acceptance = await runtime.sendQueuedNow()
        if (acceptance.accepted) {
          const queued = runtime.queuedMessages
          const projection = getRuntimeProjection(sessionId)
          if (projection) {
            projection.queuedMessages = queued
            setRuntimeProjection(sessionId, projection)
          }
          set((current) => ({
            sessionQueueCounts: withSessionQueueCount(
              current.sessionQueueCounts,
              sessionId,
              queued.length,
            ),
          }))
        }
        return acceptance.accepted
      } catch (error) {
        const projection = getRuntimeProjection(sessionId)
        if (projection) {
          projection.error = error instanceof Error ? error.message : String(error)
          setRuntimeProjection(sessionId, projection)
        }
        return false
      }
    }
    const targetId = runtime.queuedMessages[0]?.id ?? runtime.recoveredMessages[0]?.id
    if (!targetId) return false
    // 容量检查必须在 restoreQueuedMessage 之前：restore 会把队首取出队列，
    // 若随后才拒绝，消息既没启动 run 也不在队列里，只能等恢复草稿兜底。
    const capacityError = backgroundRunCapacityError(backgroundRunCount(get().sessions, sessionId))
    if (capacityError) {
      reportBackgroundRunCapacity(sessionId, capacityError)
      return false
    }
    let snapshot: QueuedMessageSnapshot | undefined
    try {
      snapshot = await runtime.restoreQueuedMessage(targetId)
    } catch (error) {
      const projection = getRuntimeProjection(sessionId)
      if (projection) {
        projection.error = error instanceof Error ? error.message : String(error)
        setRuntimeProjection(sessionId, projection)
      }
      return false
    }
    if (!snapshot) return false
    try {
      await runtime.prompt(
        snapshot.content,
        snapshot.images?.length ? snapshot.images : undefined,
      )
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

// 工作区绑定自检的投影来源：在此注入（store 之后）而非模块顶部——
// createRuntimeSession 在模块求值期即绑定一次，那时 useAgentStore 尚不可用。
// 注入后每次 bind 都会比对运行时绑定与列表投影，分叉即记诊断。
setProjectedWorkspacePathSource((sessionId) => useAgentStore.getState().sessions
  .find((item) => item.id === sessionId)?.workspace?.path)

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

// 发送清单投递口：平台在真正发送前生成清单，经这里投影到本会话的最近一次请求。
setSendManifestSink((manifest) => useAgentStore.getState().recordSendManifest(manifest))
