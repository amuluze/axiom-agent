/**
 * `.ax` 的**组件注册表**（docs/ax-format.md §4.1）：`.ax` 里 `component.name` 的
 * 唯一解析来源——编译期固定集合，静态 import，命不中即显式报错（不静默降级）。
 *
 * 每条登记三样东西：
 * - `component`：真实组件（画布渲染的就是它，因此「所见即实现」是构造性的）；
 * - `props`：props 契约（**三处复用**：画布渲染校验、`design_query` 的组件清单摘要、
 *   codegen 的类型依据）。当前手写；`react-docgen` 从 TS 类型自动生成是后续优化；
 * - `fixtures`：具名数据档案。**props 驱动的组件靠它拿数据；store 绑定的组件靠它
 *   构造预览态数据**（配合 `previewContext` 的 no-op 动作）。
 *
 * 安全边界：`.ax` 里写的是**组件名**（本表的键），不是模块路径——不存在任意模块
 * 加载面；props 经本表契约校验，非法值不进入 DOM。
 */
import type { ComponentType } from 'react'
import type { PendingToolApproval } from '@/agent/approval/ApprovalCoordinator'
import type { AgentMessage } from '@/agent/core/types'
import type { useAgentStore } from '@/stores/agentStore'

/** agentStore 状态类型：fixture 与 preview 的数据字段直接取同名类型。 */
type AgentState = ReturnType<typeof useAgentStore.getState>
import { ErrorCard } from '@/components/session/ErrorCard'
import { PausedBanner } from '@/components/session/PausedBanner'
import { ResultChip } from '@/components/session/ResultChip'
import { ToolCallCard } from '@/components/session/ToolCallCard'
import { ApprovalCard } from '@/components/session/ApprovalCard'
import { BackgroundApprovals } from '@/components/session/BackgroundApprovals'
import { MessageActions } from '@/components/session/MessageActions'
import { SessionMessageStream } from '@/components/session/SessionMessageStream'
import { MessageContent, RichMessageContent } from '@/components/MessageContent'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { Composer } from '@/components/composer/Composer'
import type { ProviderProfile } from '@/agent/transport/providerProfile'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import type { DesignPreviewValue, DesignStoreSlices } from './previewContext'
import type {
  DesignComponentDetail,
  DesignComponentSummary,
} from '@/agent/design/componentInventoryHost'

export type AxPropType = 'string' | 'number' | 'boolean' | 'json'

export interface AxPropSpec {
  type: AxPropType
  required?: boolean
  description: string
}

/** 注册表条目：约束组件名、props 契约、数据档案与来源路径。 */
export interface AxComponentEntry {
  name: string
  /**
   * `presentational`：props 驱动，直接渲染；
   * `store-bound`：需要 `preview` 提供预览态数据与 no-op 动作（见 previewContext）。
   */
  kind: 'presentational' | 'store-bound'
  component: ComponentType<Record<string, unknown>>
  props: Record<string, AxPropSpec>
  fixtures: Record<string, Record<string, unknown>>
  /**
   * `store-bound` 专用：把 fixture 变成预览态数据（动作固定为 no-op）。
   * 命名字段形态——ApprovalCard/SessionMessageStream 等单 store 少量读取点的组件用。
   */
  preview?: (fixture: Record<string, unknown>) => DesignPreviewValue
  /**
   * `store-bound` 专用、**多 store 切片**形态：Sidebar/Composer 这类跨 agent/ui/
   * connect 三 store、读取点几十处的组件用。切片是该 store 状态的 Partial（数据给
   * 预览值、动作给 no-op），组件在读取点经 `useDesignAgentPreview` 等接缝消费。
   * 与 `preview` 二选一即可，两者同时存在时都会被套 Provider（互不干扰）。
   */
  storePreview?: (fixture: Record<string, unknown>) => DesignStoreSlices
  /**
   * 固定 props：回调/句柄等**无法在 `.ax` 里表达**、但组件渲染需要的值（预览态一律 no-op）。
   * 与 fixture/节点 props 合并时优先级最低（作者声明永远覆盖）。
   */
  statics?: Record<string, unknown>
  /** 真实源码路径（供 `design_query` 组件清单摘要与 codegen 引用）。 */
  sourcePath: string
  notes?: string
}

/** 把具体 props 类型的组件登记为注册表消费的松类型（唯一一处断言）。 */
const asEntryComponent = <P,>(component: ComponentType<P>): ComponentType<Record<string, unknown>> =>
  component as unknown as ComponentType<Record<string, unknown>>

/** 预览态 fixture 里的待审批示例：命令审批（与设计稿的「需要批准 · 执行项目代码」同形态）。 */
const pendingCommandApprovalFixture: PendingToolApproval = {
  sessionId: 'design-preview',
  runId: 'design-preview-run',
  toolCallId: 'design-preview-call',
  toolName: 'bash',
  toolLabel: 'bash',
  presentation: {
    category: 'workspace-command',
    title: '需要批准 · 执行项目代码',
    description: '本次批准仅对当前命令有效；后续操作仍会再次询问。',
    path: '/workspace/axiom',
    preview: 'npm test --workspace apps/desktop',
    danger: false,
  },
} as PendingToolApproval

// ---------------------------------------------------------------- Sidebar / Composer 的多 store 切片 fixture

/** 预览态工作目录（agent 切片的 authorizedWorkspace(s) 与 ui 的 recentWorkspacePaths 共用形状）。 */
const designPreviewWorkspace: AuthorizedWorkspace = {
  path: '/Users/demo/workspace/axiom',
  name: 'axiom',
  gitBranch: 'main',
}

/** 预览态会话列表（StoredAgentSession 只构造侧栏消费的字段，形状经一次断言收口）。 */
const designPreviewSessions = [
  {
    id: 'design-s1',
    title: '重构 sandbox deny 名单的读取面判定',
    status: 'running',
    updatedAt: 1_750_000_003_000,
    workspace: { path: designPreviewWorkspace.path, name: designPreviewWorkspace.name },
  },
  {
    id: 'design-s2',
    title: '设计助手侧栏 + 画布页展示优化',
    status: 'idle',
    updatedAt: 1_750_000_002_000,
    workspace: { path: designPreviewWorkspace.path, name: designPreviewWorkspace.name },
  },
  {
    id: 'design-s3',
    title: '官网部署物料直产',
    status: 'idle',
    archivedAt: 1_750_000_001_500,
    updatedAt: 1_750_000_001_000,
  },
] as unknown as AgentState['sessions']

/** 预览态队列项（Composer 的排队提示条与队列行）。 */
const designPreviewQueuedMessages = [
  { id: 'design-q1', kind: 'steering', content: '顺手把测试里的魔法数收敛成常量', images: [], createdAt: 1_750_000_003_000 },
  { id: 'design-q2', kind: 'follow-up', content: '完成后跑一遍全量门禁', images: [], createdAt: 1_750_000_003_500 },
] as unknown as AgentState['queuedMessages']

/** 预览态 Provider Profile（Composer 模型菜单与 isComposerAvailable 消费）。 */
const designPreviewProviderProfile: ProviderProfile = {
  schemaVersion: 4,
  profileId: 'design-preview-profile',
  providerId: 'demo',
  apiFormat: 'demo',
  endpoint: 'https://demo.invalid/v1',
  modelId: 'design-model',
  modelName: 'Design Model',
  timeoutMs: 60_000,
  maxOutputTokens: 8192,
  contextWindow: 200_000,
  capabilities: { toolReferences: true, toolSearch: false },
}

/**
 * 多 store 切片的**动作 no-op 束**：画布内点击一律零副作用。返回值只在点击路径被
 * 消费（`await sendToSession` 失败后保草稿之类），与渲染无关——逐字段精确返回类型
 * 不值得在此维护，装配点用一次断言收口（对照 asEntryComponent 的同类取舍）。
 */
const SIDEBAR_AGENT_NOOPS = {
  selectSession: async () => false,
  createNewSession: async () => null,
  addWorkspace: async () => undefined,
  activateWorkspace: async () => undefined,
  revokeWorkspace: async () => undefined,
  archiveSession: async () => undefined,
  stopSession: async () => null,
  sendToSession: async () => false,
  releaseQueuedForSession: async () => false,
} as unknown as NonNullable<DesignStoreSlices['agent']>

const COMPOSER_AGENT_NOOPS = {
  send: async () => undefined,
  stop: async () => undefined,
  // 队列类动作按契约的**拒绝分支**返回：Composer 会读 acceptance.accepted /
  // result.updated（undefined 会在点击路径抛未处理 rejection），拒绝分支既形状
  // 合法又语义诚实——预览态的运行时本来就「不接受」。
  queueSteering: async () => ({ accepted: false as const, reason: 'runtime-not-accepting' as const }),
  queueFollowUp: async () => ({ accepted: false as const, reason: 'runtime-not-accepting' as const }),
  clearQueuedMessages: () => undefined,
  // 恢复编辑走 falsy 早退（restored 为空即不动输入框），undefined 即安全的 no-op。
  restoreQueuedMessage: async () => undefined,
  editQueuedMessage: async () => ({ updated: false as const, reason: 'runtime-not-accepting' as const }),
  moveQueuedMessage: async () => ({ updated: false as const, reason: 'runtime-not-accepting' as const }),
  deleteQueuedMessage: async () => ({ updated: false as const, reason: 'runtime-not-accepting' as const }),
  sendQueuedNow: async () => ({ accepted: false as const, reason: 'runtime-not-accepting' as const }),
  saveQueueAutoDrain: async () => undefined,
  editUserMessage: async () => false,
  discardRecoveredMessage: () => undefined,
  cancelBranchSummary: () => undefined,
  authorizeFile: async () => undefined,
  authorizeDirectory: async () => undefined,
  addWorkspace: async () => undefined,
  activateWorkspace: async () => undefined,
  switchProviderProfile: async () => undefined,
} as unknown as NonNullable<DesignStoreSlices['agent']>

/** ui/connect 切片的共享 no-op 与预览数据（view 固定 'session'——'design' 会让侧栏整体换成设计助手面板）。 */
const SHARED_UI_SLICE = {
  view: 'session',
  sidebarWidth: 280,
  availableUpdate: null,
  connectPanelOpen: false,
  recentWorkspacePaths: [designPreviewWorkspace.path],
  toggleSidebar: () => undefined,
  setSidebarWidth: () => undefined,
  setView: () => undefined,
  setSettingsSection: () => undefined,
  closeSidebarOverlay: () => undefined,
  setConnectPanelOpen: () => undefined,
  setAccessMode: () => undefined,
  setMessageEditRequest: () => undefined,
  clearComposerInsertion: () => undefined,
} as unknown as NonNullable<DesignStoreSlices['ui']>

/** connect 切片：平台未连接态（底栏头像落回 CirclePlus 占位）。 */
const CONNECT_SLICE = {
  config: { workspacePath: designPreviewWorkspace.path, bindings: [], platforms: [] },
} as unknown as NonNullable<DesignStoreSlices['connect']>

/** Sidebar 的 agent 切片（数据受 Partial&lt;AgentState&gt; 校验，动作来自 no-op 束）。 */
const sidebarAgentSlice = (fixture: Record<string, unknown>): NonNullable<DesignStoreSlices['agent']> => ({
  sessions: fixture.sessions === 'empty' ? [] : designPreviewSessions,
  activeSessionId: 'design-s1',
  awaitingApprovalSessionIds: fixture.sessions === 'empty' ? [] : ['design-s2'],
  authorizedWorkspace: fixture.sessions === 'empty' ? null : designPreviewWorkspace,
  authorizedWorkspaces: fixture.sessions === 'empty' ? [] : [designPreviewWorkspace],
  sessionQueueCounts: fixture.sessions === 'empty' ? {} : { 'design-s2': 2 },
  ...SIDEBAR_AGENT_NOOPS,
})

/** Composer 的 agent 切片：provider 就绪 + 一个已授权工作区 + 两条排队项。 */
const composerAgentSlice = (fixture: Record<string, unknown>): NonNullable<DesignStoreSlices['agent']> => ({
  activeSessionId: 'design-preview',
  running: false,
  sessionBusy: false,
  compactionRunning: false,
  branchSummaryRunning: false,
  provider: designPreviewProviderProfile,
  providerProfiles: [designPreviewProviderProfile],
  providerSaving: false,
  providerReady: true,
  providerSetupRequired: false,
  authorizedWorkspace: designPreviewWorkspace,
  authorizedWorkspaces: [designPreviewWorkspace],
  pendingSteeringCount: fixture.queued === 'two' ? 1 : 0,
  pendingFollowUpCount: fixture.queued === 'two' ? 1 : 0,
  pendingNextTurnCount: 0,
  queuedMessages: fixture.queued === 'two' ? designPreviewQueuedMessages : [],
  recoveredQueuedMessages: [],
  armedQueueMessageId: null,
  queueModeSettings: { steering: 'one-at-a-time', followUp: 'one-at-a-time', autoDrain: true },
  ...COMPOSER_AGENT_NOOPS,
})

/** 消息流 fixture：两轮对话（首条 Agent 消息才有操作行——最后一条不给操作）。 */
const streamMessagesFixture = [
  { id: 'design-m1', role: 'user', content: '读一下 docs/ 里的实现计划，按现有循环落地。', createdAt: 1_750_000_000_000 },
  // assistant 消息必须带 toolCalls（消息流按它配对工具块，缺了会在渲染期抛错）。
  { id: 'design-m2', role: 'assistant', content: '我先扫一遍工作区文档，再把计划映射到现有 Agent 循环的各个阶段。', toolCalls: [], createdAt: 1_750_000_001_000 },
  { id: 'design-m3', role: 'user', content: '继续', createdAt: 1_750_000_002_000 },
] as unknown as AgentState['messages']

/** 结果消息示例：ResultChip 只读 content/createdAt。 */
const completedMessageFixture = {
  id: 'design-preview-result',
  role: 'assistant',
  content: '任务完成 · 3 处文件改动 · 全部测试通过',
  // assistant 消息必须带 toolCalls（块构建与 RichMessageContent 都会遍历它）。
  toolCalls: [],
  createdAt: 1_750_000_000_000,
} as unknown as AgentMessage

export const AX_COMPONENT_REGISTRY: Record<string, AxComponentEntry> = {
  ApprovalCard: {
    name: 'ApprovalCard',
    kind: 'store-bound',
    component: asEntryComponent(ApprovalCard),
    props: {},
    fixtures: { 'pending-command': { pendingApproval: pendingCommandApprovalFixture } },
    preview: (fixture) => ({
      pendingApproval: (fixture.pendingApproval as PendingToolApproval | undefined) ?? null,
    }),
    sourcePath: 'components/session/ApprovalCard.tsx',
    notes: '会话级审批卡片：数据来自 store，预览态由 fixture 提供（动作 no-op）。',
  },
  PausedBanner: {
    name: 'PausedBanner',
    kind: 'store-bound',
    component: asEntryComponent(PausedBanner),
    props: {},
    fixtures: { default: {} },
    preview: () => ({}),
    sourcePath: 'components/session/PausedBanner.tsx',
    notes: '暂停横幅：唯一依赖是「继续会话」动作，预览态为 no-op。',
  },
  ToolCallCard: {
    name: 'ToolCallCard',
    kind: 'presentational',
    component: asEntryComponent(ToolCallCard),
    props: {
      toolName: { type: 'string', required: true, description: '工具名（卡片标题用它）' },
      toolCallId: { type: 'string', description: '工具调用 id' },
      call: { type: 'json', description: '触发调用的助手消息（可选，缺省只渲染标题）' },
      result: { type: 'json', description: '工具结果消息（可选）' },
    },
    fixtures: { minimal: { toolName: 'bash', toolCallId: 'design-preview-tool' } },
    sourcePath: 'components/session/ToolCallCard.tsx',
  },
  ResultChip: {
    name: 'ResultChip',
    kind: 'presentational',
    component: asEntryComponent(ResultChip),
    props: { message: { type: 'json', required: true, description: '结果消息（读 content/createdAt）' } },
    fixtures: { completed: { message: completedMessageFixture } },
    sourcePath: 'components/session/ResultChip.tsx',
  },
  SessionMessageStream: {
    name: 'SessionMessageStream',
    kind: 'store-bound',
    component: asEntryComponent(SessionMessageStream),
    props: {
      scrollResetKey: { type: 'string', description: '贴底滚动的重置键（缺省跟随会话）' },
    },
    fixtures: { 'two-turn': { messages: streamMessagesFixture, running: false } },
    preview: (fixture) => ({
      messages: (fixture.messages as AgentState['messages'] | undefined) ?? [],
      endReason: (fixture.endReason as AgentState['endReason'] | undefined) ?? null,
      error: (fixture.error as string | undefined) ?? null,
      running: fixture.running === true,
      sessionBusy: fixture.sessionBusy === true,
      streamingDraft: (fixture.streamingDraft as AgentState['streamingDraft'] | undefined) ?? null,
    }),
    sourcePath: 'components/session/SessionMessageStream.tsx',
    notes: '会话消息流（画布内最大的一块可视区域）：fixture 提供消息与运行态，动作 all no-op。',
  },
  MessageActions: {
    name: 'MessageActions',
    kind: 'presentational',
    component: asEntryComponent(MessageActions),
    props: {
      role: { type: 'string', required: true, description: 'user 或 assistant（决定操作集合）' },
      text: { type: 'string', description: '复制的内容；空内容不渲染复制按钮' },
      busy: { type: 'boolean', description: '会话忙时禁用会改动会话的操作' },
      branchable: { type: 'boolean', description: '可分支' },
      summarizable: { type: 'boolean', description: '可总结后分支' },
      retryable: { type: 'boolean', description: '可重试' },
      editable: { type: 'boolean', description: '可编辑（用户消息）' },
    },
    // 四个回调在预览态一律 no-op（评审不得改动会话）。
    statics: {
      onBranch: () => undefined,
      onSummarizedBranch: () => undefined,
      onRetry: () => undefined,
      onEdit: () => undefined,
    },
    fixtures: {
      'agent-message': { role: 'assistant', text: '示例回复', busy: false, branchable: true },
      'user-message': { role: 'user', text: '示例提问', busy: false, editable: true },
    },
    sourcePath: 'components/session/MessageActions.tsx',
    notes: '消息操作行（hover 出现）：回调由 statics 提供 no-op。',
  },
  RichMessageContent: {
    name: 'RichMessageContent',
    kind: 'presentational',
    component: asEntryComponent(RichMessageContent),
    props: {
      message: { type: 'json', required: true, description: '消息（按 role 渲染文本/思考/工具调用块）' },
      renderToolCalls: { type: 'boolean', description: '是否渲染工具调用块（默认 true）' },
      streaming: { type: 'boolean', description: '是否流式草稿态' },
    },
    fixtures: { 'assistant-text': { message: completedMessageFixture } },
    sourcePath: 'components/MessageContent.tsx',
    notes: '富文本消息渲染（Markdown / 思考 / 工具调用块）。',
  },
  MessageContent: {
    name: 'MessageContent',
    kind: 'presentational',
    component: asEntryComponent(MessageContent),
    props: { content: { type: 'string', required: true, description: 'Markdown 文本' } },
    fixtures: { markdown: { content: '**加粗** 与 `code` 行\n\n- 列表项' } },
    sourcePath: 'components/MessageContent.tsx',
  },
  BackgroundApprovals: {
    name: 'BackgroundApprovals',
    kind: 'store-bound',
    component: asEntryComponent(BackgroundApprovals),
    props: {},
    fixtures: {
      'one-pending': {
        backgroundApprovals: [pendingCommandApprovalFixture],
        sessions: [{ id: 'design-preview', title: '后台会话示例' }],
      },
    },
    preview: (fixture) => ({
      backgroundApprovals: (fixture.backgroundApprovals as PendingToolApproval[] | undefined) ?? [],
      sessions: (fixture.sessions as ReturnType<typeof useAgentStore.getState>['sessions'] | undefined) ?? [],
    }),
    sourcePath: 'components/session/BackgroundApprovals.tsx',
    notes: '后台会话审批收件箱：数据来自 store，预览态由 fixture 提供（动作 no-op）。',
  },
  ErrorCard: {
    name: 'ErrorCard',
    kind: 'presentational',
    component: asEntryComponent(ErrorCard),
    props: {
      messageId: { type: 'string', required: true, description: '出错消息 id' },
      error: { type: 'string', required: true, description: '错误文本' },
      message: { type: 'json', description: '关联的助手消息（可选，用于友好文案）' },
    },
    fixtures: { provider: { messageId: 'design-preview-error', error: '连接被重置（ECONNRESET）' } },
    sourcePath: 'components/session/ErrorCard.tsx',
  },
  Sidebar: {
    name: 'Sidebar',
    kind: 'store-bound',
    component: asEntryComponent(Sidebar),
    props: {
      variant: { type: 'string', description: "渲染形态：'default'（带拖拽把手）或 'overlay'（移动浮层）" },
    },
    fixtures: { default: { sessions: 'list' }, empty: { sessions: 'empty' } },
    storePreview: (fixture) => ({
      agent: sidebarAgentSlice(fixture),
      ui: SHARED_UI_SLICE,
      connect: CONNECT_SLICE,
    }),
    sourcePath: 'components/sidebar/Sidebar.tsx',
    notes: '侧栏（导航/工作区分组/会话列表/底栏）：跨 agent/ui/connect 三 store，经切片接缝预览；撤销确认等原生手势已挡在预览态外。',
  },
  Composer: {
    name: 'Composer',
    kind: 'store-bound',
    component: asEntryComponent(Composer),
    props: {
      variant: { type: 'string', description: "'new-task'（欢迎页居中）或 'session'（会话底部）" },
      showAccessPicker: { type: 'boolean', description: '是否显示审批模式下拉（默认 true）' },
    },
    fixtures: { default: { queued: 'none' }, queued: { queued: 'two' } },
    storePreview: (fixture) => ({
      agent: composerAgentSlice(fixture),
      ui: SHARED_UI_SLICE,
      connect: CONNECT_SLICE,
    }),
    sourcePath: 'components/composer/Composer.tsx',
    notes: '输入区（工作区/审批模式/模型/预算菜单 + 队列管理）：跨 agent/ui 两 store、读取点 50+，经切片接缝预览；挂载抢焦点的副作用已挡在预览态外。',
  },
}

/** 单条目 → 清单摘要（清单与单组件详单共用，保证两处永不漂移）。 */
const summarizeEntry = (entry: AxComponentEntry): DesignComponentSummary => ({
  name: entry.name,
  kind: entry.kind,
  sourcePath: entry.sourcePath,
  props: Object.entries(entry.props).map(([name, spec]) => ({
    name,
    type: spec.type,
    required: spec.required === true,
    description: spec.description,
  })),
  fixtures: Object.keys(entry.fixtures),
  // presentational 的 fixture 打底进 props 合并；store 绑定的 fixture 是 store 数据，不进 props。
  fixtureProps: entry.kind === 'presentational'
    ? Object.fromEntries(
      Object.entries(entry.fixtures).map(([name, fixture]) => [name, Object.keys(fixture)]),
    )
    : {},
  ...(entry.notes ? { notes: entry.notes } : {}),
})

/**
 * 组件清单摘要（`design_query` 的「组件清单」数据源，经宿主接缝注入 agent 层）：
 * 模型据此知道设计稿里的组件名对应哪份源码、有哪些 props。
 */
export const axComponentInventorySummary = (): DesignComponentSummary[] =>
  Object.values(AX_COMPONENT_REGISTRY)
    .map(summarizeEntry)
    .sort((left, right) => left.name.localeCompare(right.name))

/**
 * 单组件详单（`design_query` mode=component 的数据源，经宿主接缝注入 agent 层）：
 * 除摘要外还给出 statics 与 fixture 数据形状——json 型 props 的结构化 `$mock`
 * 照 fixture 形状写，不必读组件源码反推隐式前提。
 */
export const axComponentDetailOf = (name: string): DesignComponentDetail | null => {
  const entry = AX_COMPONENT_REGISTRY[name]
  if (!entry) return null
  return {
    summary: summarizeEntry(entry),
    statics: Object.keys(entry.statics ?? {}),
    fixtures: entry.fixtures,
  }
}

/** 注册表的组件名清单（`.ax` 校验提示与错误信息共用）。 */
export const axComponentNames = (): string[] => Object.keys(AX_COMPONENT_REGISTRY).sort()

export interface AxPropValidation {
  ok: boolean
  errors: { field: string; message: string }[]
}

const matchesType = (type: AxPropType, value: unknown): boolean => {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'json':
      // 领域对象（消息/工具调用）在 `.ax` 里以 JSON 字面量给出。
      return typeof value === 'object' && value !== null
    default:
      return false
  }
}

/**
 * props 契约校验：**未知 prop 也报错**（与格式的严格口径一致——不静默忽略）。
 * 绑定值（`{$mock}`）在渲染前已解析为字面量，这里只校验解析后的值。
 */
export const validateAxProps = (
  entry: AxComponentEntry,
  props: Record<string, unknown>,
): AxPropValidation => {
  const errors: AxPropValidation['errors'] = []
  for (const [field, value] of Object.entries(props)) {
    if (!Object.hasOwn(entry.props, field)) {
      errors.push({ field, message: `组件 ${entry.name} 没有 props「${field}」` })
      continue
    }
    const spec = entry.props[field]
    if (!spec) continue
    if (!matchesType(spec.type, value)) {
      errors.push({ field, message: `props「${field}」应为 ${spec.type}` })
    }
  }
  for (const [field, spec] of Object.entries(entry.props)) {
    if (spec.required && props[field] === undefined) {
      errors.push({ field, message: `缺少必填 props「${field}」` })
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 取具名 fixture（缺省 `default`，再退化到第一条），组件缺省数据由此而来。 */
export const axFixtureOf = (
  entry: AxComponentEntry,
  fixture: string | undefined,
): Record<string, unknown> =>
  entry.fixtures[fixture ?? 'default']
  ?? entry.fixtures[Object.keys(entry.fixtures)[0] ?? '']
  ?? {}

/** 注册表条目的预览态数据（`presentational` 条目无预览值，返回 null）。 */
export const axPreviewValueOf = (
  entry: AxComponentEntry,
  fixture: string | undefined,
): DesignPreviewValue | null =>
  entry.kind === 'store-bound' ? (entry.preview?.(axFixtureOf(entry, fixture)) ?? {}) : null
