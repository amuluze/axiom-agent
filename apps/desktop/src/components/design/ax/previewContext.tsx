/**
 * 真组件渲染的**预览 seam**（docs/ax-format.md §4.2）。
 *
 * 问题：真实组件挂在 zustand store 上，直接塞进设计画布会①读真实会话状态、②点击触发
 * 真实动作（发消息、签发审批）。方案：组件在**数据读取点**写成
 *
 *   const preview = useDesignPreview()
 *   const pending = preview ? preview.pendingApproval ?? null : useAgentStore((s) => s.pendingApproval)
 *
 * 三条不变式：
 * 1. **画布外逐字节不变**——没有 Provider 时 `preview` 为 null，取值与改写前完全一致；
 * 2. **画布内零副作用**——预览态的动作者一律 no-op（画布只用于评审）；
 * 3. **可断言**——`AxComponentHost` 的用例会点击预览态的审批按钮并断言真实动作零调用。
 *
 * 注意 hooks 规则：store 的 `useAgentStore(...)` 必须**无条件**调用，只在**取值**上分支
 * （见 ApprovalCard/PausedBanner 的写法），不能条件调用 hook。
 */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { PendingToolApproval } from '@/agent/approval/ApprovalCoordinator'
import type { useAgentStore } from '@/stores/agentStore'
import type { useUiStore } from '@/stores/uiStore'
import type { useConnectStore } from '@/stores/connectStore'

/** 会话列表的类型直接取自 store：三元素条件表达式两分支同型，组件侧无需窄化。 */
type StoreSessions = ReturnType<typeof useAgentStore.getState>['sessions']
/** agentStore 的状态类型：预览数据字段直接取 store 同名类型，避免三元分支类型不统一。 */
type AgentState = ReturnType<typeof useAgentStore.getState>
type UiState = ReturnType<typeof useUiStore.getState>
type ConnectState = ReturnType<typeof useConnectStore.getState>

export interface DesignPreviewValue {
  /** ApprovalCard：当前待审批项（null = 无，卡片自渲染为空）。 */
  pendingApproval?: PendingToolApproval | null
  /** BackgroundApprovals：后台会话审批列表。 */
  backgroundApprovals?: PendingToolApproval[]
  /** BackgroundApprovals：会话列表（用于把审批映射到会话标题）。 */
  sessions?: StoreSessions
  /** SessionMessageStream：消息列表与运行态。 */
  messages?: AgentState['messages']
  endReason?: AgentState['endReason']
  error?: AgentState['error']
  running?: boolean
  sessionBusy?: boolean
  streamingDraft?: AgentState['streamingDraft']
  /** SessionMessageStream：分支/重试/总结/编辑入口（预览态一律 no-op）。 */
  branchFromMessage?: (messageId: string) => void
  retryAssistant?: (messageId: string) => void
  setSummaryRequest?: (request: unknown) => void
  setMessageEditRequest?: (request: unknown) => void
  /** PausedBanner：继续会话动作。 */
  continueConversation?: () => void
  /** ApprovalCard：放行动作。 */
  approveToolCall?: (toolCallId: string) => void
  /** ApprovalCard：拒绝动作。 */
  denyToolCall?: (toolCallId: string) => void
}

const DesignPreviewContext = createContext<DesignPreviewValue | null>(null)

export const DesignPreviewProvider = ({
  value,
  children,
}: {
  value: DesignPreviewValue
  children: ReactNode
}) => (
  <DesignPreviewContext.Provider value={value}>{children}</DesignPreviewContext.Provider>
)

/** 预览态取值；画布外返回 null（调用方必须回落到 store）。 */
export const useDesignPreview = (): DesignPreviewValue | null => useContext(DesignPreviewContext)

/**
 * **多 store 切片预览**（Sidebar/Composer 这类跨 store 组件的接缝，docs/ax-format.md
 * §4.2 的推广形态）：按 store 拆三个切片，每个切片是该 store 状态的 Partial——数据字段
 * 给预览值，动作字段给 no-op。与命名字段的 `DesignPreviewValue` 相比，切片形态不用为
 * 几十个读取点逐个扩接口，新组件接入成本从「改接缝」降到「写 fixture」。
 *
 * 组件侧写法（与既有惯用法一致：store hook 无条件调用，只在取值上分支）：
 *
 *   const agentPreview = useDesignAgentPreview()
 *   const storeSend = useAgentStore((state) => state.send)
 *   const send = agentPreview?.send ?? storeSend
 *
 * 派生读取（如 `queueModeSettings.autoDrain`）缝在**父字段**上：预览提供完整的
 * `queueModeSettings` 对象，组件照常取 `.autoDrain`。
 */
export interface DesignStoreSlices {
  agent?: Partial<AgentState>
  ui?: Partial<UiState>
  connect?: Partial<ConnectState>
}

const DesignStorePreviewContext = createContext<DesignStoreSlices | null>(null)

export const DesignStorePreviewProvider = ({
  value,
  children,
}: {
  value: DesignStoreSlices
  children: ReactNode
}) => (
  <DesignStorePreviewContext.Provider value={value}>
    {children}
  </DesignStorePreviewContext.Provider>
)

/** 三个切片的预览态取值；画布外均为 null（调用方必须回落到对应 store）。 */
export const useDesignStorePreview = (): DesignStoreSlices | null => useContext(DesignStorePreviewContext)
export const useDesignAgentPreview = (): Partial<AgentState> | null => useContext(DesignStorePreviewContext)?.agent ?? null
export const useDesignUiPreview = (): Partial<UiState> | null => useContext(DesignStorePreviewContext)?.ui ?? null
export const useDesignConnectPreview = (): Partial<ConnectState> | null => useContext(DesignStorePreviewContext)?.connect ?? null

/**
 * 预览态动作：全部 no-op（画布评审不得触发真实副作用）。模块级常量——引用稳定，
 * 避免在画布内造成无意义重渲染。
 */
export const NOOP_PREVIEW_ACTIONS: Required<Pick<
  DesignPreviewValue,
  | 'approveToolCall' | 'denyToolCall' | 'continueConversation'
  | 'branchFromMessage' | 'retryAssistant' | 'setSummaryRequest' | 'setMessageEditRequest'
>> = {
  approveToolCall: () => undefined,
  denyToolCall: () => undefined,
  continueConversation: () => undefined,
  branchFromMessage: () => undefined,
  retryAssistant: () => undefined,
  setSummaryRequest: () => undefined,
  setMessageEditRequest: () => undefined,
}
