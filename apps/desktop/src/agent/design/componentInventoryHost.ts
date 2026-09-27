/**
 * 组件清单的宿主接缝（docs/ax-format.md §4.5）：`design_query` 要告诉模型
 * 「设计稿里的 `ApprovalCard` 是哪份源码、有哪些 props」，但组件注册表在
 * `components/design/ax/`（依赖会话组件与 store），而 `agent/` 层不得反向依赖
 * `components/`、`stores/`。因此沿用本仓库既有的 host 接缝模式（对照
 * `agent/prompt/promptLocalizationHost.ts`）：**应用启动处注入实现，agent 层只消费**；
 * 未注入时返回空清单——工具照常工作，只是不带清单（测试与 hook-only 场景友好）。
 */
export interface DesignComponentPropSummary {
  name: string
  type: string
  required: boolean
  description: string
}

export interface DesignComponentSummary {
  name: string
  kind: 'presentational' | 'store-bound'
  /** 真实源码路径：模型据此把设计稿里的组件对到实现文件。 */
  sourcePath: string
  props: DesignComponentPropSummary[]
  /** 可用数据档案名（预览态 fixture）。 */
  fixtures: string[]
  /**
   * 各具名 fixture 打底的 props 键（presentational 的「fixture 打底 + 节点覆盖」合并
   * 口径）：校验器判「缺必填 props」时必须把 fixture 提供的键算作已满足，否则纯
   * fixture 驱动的节点（如 ResultChip 全靠 fixture 给 message）会被误报。store 绑定
   * 组件的 fixture 是预览态 store 数据而非 props，恒为空表。可选：手写摘要桩可省略。
   */
  fixtureProps?: Record<string, string[]>
  notes?: string
}

/** 单组件详单（`design_query` mode=component 的载荷）：写 component 节点前查一次即可。 */
export interface DesignComponentDetail {
  summary: DesignComponentSummary
  /**
   * 回调/句柄等无法在 `.ax` 里表达的固定 props（预览态一律 no-op）：模型无须也
   * 不应在稿里声明，声明了反而会报「未声明的 props」。
   */
  statics: string[]
  /**
   * 具名 fixture 的实际数据形状：json 型 props 的「最小可渲染子集」以此为准——
   * 结构化 `$mock` 直接照这个形状写（缺隐式前提如 assistant 消息的 toolCalls
   * 会在渲染期抛错，只有看到 fixture 形状才能写对）。
   */
  fixtures: Record<string, Record<string, unknown>>
}

type Provider = () => DesignComponentSummary[]

let provider: Provider | null = null

/** 应用启动处注入（main.tsx）；传 null 可清除（测试隔离用）。 */
export const setDesignComponentInventoryProvider = (next: Provider | null): void => {
  provider = next
}

/** 当前组件清单；未注入时为空数组。 */
export const designComponentInventory = (): DesignComponentSummary[] => provider?.() ?? []

type DetailProvider = (name: string) => DesignComponentDetail | null

let detailProvider: DetailProvider | null = null

/** 应用启动处注入（main.tsx，与清单 provider 同点）；传 null 可清除（测试隔离用）。 */
export const setDesignComponentDetailProvider = (next: DetailProvider | null): void => {
  detailProvider = next
}

/** 单组件详单；未注入或查无此名返回 null（调用方回落清单摘要或报错）。 */
export const designComponentDetail = (name: string): DesignComponentDetail | null =>
  detailProvider?.(name) ?? null
