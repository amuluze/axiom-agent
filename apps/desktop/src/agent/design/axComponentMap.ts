/**
 * `.pen` 可复用组件 → 本仓真实组件 的**升级映射表**（docs/ax-format.md §6 P1，
 * 补 L1「`ref` 实例不在页树里」与 L5「几何 → 组件」的实例层）。
 *
 * 背景：`.pen` 里被标记 `reusable: true` 的根节点按 `component/` 前缀命名（pen.dev 惯例），
 * 页面通过 `ref` 实例化它们；解析器在展开实例时会保留组件根的 `name`（实例自身若带
 * `name` 则覆盖），`penParser` 另把 ref 来源记到 `refComponentName` 上——这就是本表
 * 的查找键。命中即把整棵实例子树升成 `.ax` 的 `component` 节点（真组件渲染、
 * 设计→代码恒等映射），未命中则留在 primitive 层并**逐条记账**（不静默）。
 *
 * 只登记**能忠实渲染**的映射，两条准入条件：
 * 1. 真实组件的渲染形状覆盖稿里那一块（不靠猜、不靠补 CSS）；
 * 2. 实例需要的 props 落在 `.ax` 现有值域内（字符串/数值/布尔/`$mock`/`$bind`）。
 *
 * 达不到的登记在 `AX_DEFERRED_PEN_COMPONENTS`：那里每个名字都带**具体原因**与解锁条件，
 * 让「升级面」是可数、可回归、可排期的，而不是一句「还没做」。
 */
import type { AxComponentDecl, AxPropValue } from '@/agent/design/axSchema'

/** 已升级实例的节点内容（`.ax` 值域内的 props + 预览态数据档案名）。 */
export interface AxPenComponentInstance {
  /** 注册表组件名（`.ax` 的 `component.name`，必须命中 `AX_COMPONENT_REGISTRY`）。 */
  component: string
  /** 写进本稿 `components` 词汇表的声明（规则 1 的校验源）。 */
  decl: AxComponentDecl
  /**
   * 节点 props：`$mock` 表示「稿里的字面量」（预览态直接取该值），
   * 与真实数据绑定 `$bind` 区分（规则 2）。
   */
  props?: Record<string, AxPropValue>
  /** 预览态数据档案（注册表 `fixtures` 键）：store 绑定组件的画布数据来源。 */
  fixture?: string
  /**
   * 已被 props **消费**的实例文案（逐字）。导入器用它算「有多少条文案不再进稿」
   * ——由映射显式声明而不是猜（`2.1 KB` 变成 `details.sizeBytes: 2150` 后，字符串
   * 本身当然不在 props 里，靠文本匹配判断必然误报）。
   */
  consumedTexts?: string[]
}

/** 升级发生时的实例上下文：稿里能给 props 的全部数据都在这里。 */
export interface AxPenInstanceContext {
  /** 组件定义名里 `·` 之后的部分（如 `Agent`、`zh-CN`）。 */
  variant?: string
  /** 实例子树里的全部文案（按遍历顺序）：props 的 mock 值只能从稿里来，不许编。 */
  texts: string[]
}

/**
 * 升级结果：给出实例内容，或**说明这一处为什么升不了**（调用方据此回落 primitive）。
 * 两种结果都带 `component`（目标注册表组件名）——这样映射面可以被**枚举**，
 * 一致性用例（映射表 ↔ 注册表）才能自动核对，不靠人工维护一份清单。
 */
export type AxPenComponentUpgrade = AxPenComponentInstance | { component: string; defer: string }

/**
 * 组件定义名 → `{ name, variant }`：`component/Message Actions · Agent` →
 * `{ name: 'Message Actions', variant: 'Agent' }`。非 `component/` 前缀返回 null
 * （pen 稿里的普通 frame 命名不在映射面上）。
 */
export const penComponentIdentityOf = (
  definitionName: string,
): { name: string; variant?: string } | null => {
  const match = /^component\/(.+)$/.exec(definitionName.trim())
  if (!match?.[1]) return null
  const [name, variant] = match[1].split('·').map((part) => part.trim())
  if (!name) return null
  return variant ? { name, variant } : { name }
}

/** 预览态工具调用 id：同一页里多张卡共用不影响渲染（各自在独立错误边界内）。 */
const PREVIEW_TOOL_CALL_ID = 'design-preview-tool'

/** `2.1 KB` / `512 B` / `1.4 MB` → 字节数（ToolCallCard 的 `details.sizeBytes` 口径）。 */
const sizeBytesOf = (text: string): number | undefined => {
  const match = /^([\d.]+)\s*(B|KB|MB)$/i.exec(text.trim())
  if (!match?.[1]) return undefined
  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (match[2] ?? 'B').toUpperCase()
  const scale = unit === 'MB' ? 1024 * 1024 : unit === 'KB' ? 1024 : 1
  return Math.round(value * scale)
}

/** `+128` / `−44`（半角或 U+2212 减号）→ 数值。 */
const signedNumber = (text: string, sign: '+' | '-'): number | undefined => {
  const pattern = sign === '+' ? /^\+\s*(\d+)/ : /^[-−]\s*(\d+)/
  const match = pattern.exec(text.trim())
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined
}

/**
 * 稿里的工具卡（`Tool Call Read`/`Edit`）：标题行是 `<Verb> <path>`，右侧是字节数或增删行数。
 * 从这些文案反推出 ToolCallCard 需要的 `call`/`result`（**不是编数据**：path/数字都取自稿），
 * 由此真实组件渲染出与稿同形的卡片（标题、字节数/增删行、完成勾）。
 * 认不出来（标题不合形）就 defer——宁可留 primitive，也不发出一张内容错的卡。
 */
const toolCallInstanceOf = (
  toolName: 'read' | 'edit',
  context: AxPenInstanceContext,
): AxPenComponentUpgrade => {
  const [titleText, ...rest] = context.texts
  const titleMatch = titleText ? /^([A-Z][a-z]+)\s+(.+)$/.exec(titleText.trim()) : null
  if (!titleMatch?.[2]) {
    return {
      component: 'ToolCallCard',
      defer: `标题文案不是 \`<动词> <路径>\` 形（实测「${titleText ?? '（无文案）'}」），反推不出工具参数`,
    }
  }
  const path = titleMatch[2].trim()
  const details: Record<string, number> = {}
  const sizeText = rest.find((text) => sizeBytesOf(text) !== undefined)
  const addedText = rest.find((text) => signedNumber(text, '+') !== undefined)
  const removedText = rest.find((text) => signedNumber(text, '-') !== undefined)
  const sizeBytes = sizeText !== undefined ? sizeBytesOf(sizeText) : undefined
  const added = addedText !== undefined ? signedNumber(addedText, '+') : undefined
  const removed = removedText !== undefined ? signedNumber(removedText, '-') : undefined
  if (toolName === 'read' && sizeBytes !== undefined) details.sizeBytes = sizeBytes
  if (toolName === 'edit' && added !== undefined) details.diffAdded = added
  if (toolName === 'edit' && removed !== undefined) details.diffRemoved = removed
  return {
    component: 'ToolCallCard',
    decl: { props: { toolName: 'read | edit', toolCallId: 'string', call: 'json', result: 'json' } },
    // 标题与数字文案都被 props 消费（path / sizeBytes / diffAdded / diffRemoved）。
    consumedTexts: [titleText, sizeText, addedText, removedText].filter((text): text is string => text !== undefined),
    props: {
      toolName: { $mock: toolName },
      toolCallId: { $mock: PREVIEW_TOOL_CALL_ID },
      // AssistantMessage / ToolResultMessage 的**最小可渲染子集**：ToolCallCard 只读
      // contentBlocks/toolCalls（取标题）、isError/details/content（取状态与数字）。
      call: {
        $mock: {
          id: PREVIEW_TOOL_CALL_ID,
          role: 'assistant',
          content: '',
          createdAt: 0,
          toolCalls: [{ id: PREVIEW_TOOL_CALL_ID, name: toolName, arguments: { path } }],
          contentBlocks: [{ type: 'tool_call', id: PREVIEW_TOOL_CALL_ID, name: toolName, arguments: { path } }],
        },
      },
      result: {
        $mock: {
          id: 'design-preview-result',
          role: 'tool',
          toolCallId: PREVIEW_TOOL_CALL_ID,
          isError: false,
          content: '',
          createdAt: 0,
          details,
        },
      },
    },
    fixture: 'minimal',
  }
}

/**
 * 升级映射：pen 组件名 → 实例内容。返回 null 表示「这个名字没登记」；返回 `{ defer }`
 * 表示「登记了，但这一处升不了」——两种情况调用方都回落 primitive 并记账。
 */
const AX_PEN_COMPONENT_MAP: Record<string, (context: AxPenInstanceContext) => AxPenComponentUpgrade | null> = {
  /**
   * 审批卡片：稿里那一块（Header/Command/Scope Note/Actions）与 `ApprovalCard` 的
   * 真实渲染逐段对应；卡片文案是 store 预览态数据，由 fixture 提供（动作 no-op）。
   */
  'Approval Card': () => ({
    component: 'ApprovalCard',
    decl: { props: {} },
    fixture: 'pending-command',
  }),
  /**
   * 消息操作行：稿里按 user/agent 两态画了图标按钮组（复制/编辑 vs 复制/分支/总结/重试），
   * 与 `MessageActions` 按 `role` 渲染的操作集合一致。
   */
  'Message Actions': ({ variant }) => {
    const role = variant === 'User' ? 'user' : variant === 'Agent' ? 'assistant' : undefined
    if (!role) return null
    return {
      component: 'MessageActions',
      decl: { props: { role: 'user | assistant' } },
      props: { role: { $mock: role } },
      fixture: role === 'user' ? 'user-message' : 'agent-message',
    }
  },
  /** 工具卡（读）：标题 + 字节数 → ToolCallCard 的 call/result。 */
  'Tool Call Read': (context) => toolCallInstanceOf('read', context),
  /** 工具卡（编辑）：标题 + 增删行数 → ToolCallCard 的 call/result。 */
  'Tool Call Edit': (context) => toolCallInstanceOf('edit', context),
  /**
   * 侧栏：store 绑定组件（agent/ui/connect 三 store 切片接缝，见 registry.tsx），
   * 数据全部来自预览态切片，props 只留组件自身的渲染形态开关。
   */
  Sidebar: () => ({
    component: 'Sidebar',
    decl: { props: { variant: "'default' | 'overlay'" } },
    fixture: 'default',
  }),
  /** 输入区：同侧栏，多 store 切片接缝；variant 由稿里的形态决定（缺省 session）。 */
  Composer: () => ({
    component: 'Composer',
    decl: { props: { variant: "'new-task' | 'session'", showAccessPicker: 'boolean' } },
    fixture: 'default',
  }),
}

/**
 * **未升级**的 pen 组件及其原因（按名字登记，`importPen` 据此产出带原因的记账）。
 * 每条都是「差什么就能解锁」，不是「暂时不做」——改动时同步 docs/ax-format.md §6 P2。
 *
 * 历史：Sidebar/Composer 曾因「跨 store 读取点无预览接缝」在此延后，多 store 切片
 * 接缝（registry.tsx 的 storePreview）落地后已升级；目前剩余的都是「实现侧尚未抽成
 * 可独立实例化的组件」与「画布浮层容纳未做」两类。
 */
export const AX_DEFERRED_PEN_COMPONENTS: Record<string, string> = {
  'Top Right Bar': '注册表暂无对应条目：该横条是会话头部的一部分，尚未抽成可独立实例化的真实组件',
  'Settings Nav': '注册表暂无对应条目：设置页导航尚未抽成可独立实例化的真实组件',
  'Settings Top Bar': '注册表暂无对应条目：设置页顶栏尚未抽成可独立实例化的真实组件',
  'Feedback Dialog': '画布容纳未做：真实组件根是 `position: fixed; inset: 0` 全屏 backdrop，直接进页会盖住整个画布视口（需要浮层容纳语义，见 docs/ax-format.md §6 P1）',
  'Summary Instructions Dialog': '画布容纳未做：真实组件根是 `position: fixed` 全屏 backdrop，需要浮层容纳语义',
  'Builtin Prompt Editor Dialog': '画布容纳未做：真实组件根是 `position: fixed; inset: 0` 全屏 backdrop，需要浮层容纳语义',
}

/** 该 pen 组件的升级实例内容；未登记或变体不认识时返回 null。 */
export const axInstanceOfPenComponent = (
  definitionName: string,
  context: AxPenInstanceContext,
): AxPenComponentUpgrade | null => {
  const identity = penComponentIdentityOf(definitionName)
  if (!identity) return null
  const factory = AX_PEN_COMPONENT_MAP[identity.name]
  if (!factory) return null
  return factory({ ...context, variant: identity.variant ?? context.variant })
}

/** 该 pen 组件未升级的原因（未登记则给通用文案）。 */
export const axDeferReasonOfPenComponent = (definitionName: string): string | undefined => {
  const identity = penComponentIdentityOf(definitionName)
  if (!identity) return undefined
  return AX_DEFERRED_PEN_COMPONENTS[identity.name]
}

/** 已登记的升级组件名（文档与用例用；也用于断言「映射表都在注册表里」）。 */
export const axMappedPenComponentNames = (): string[] => Object.keys(AX_PEN_COMPONENT_MAP)

/**
 * 映射面覆盖的**注册表组件名**（去重）：枚举每个登记项的解析结果（含 defer 分支——
 * 那里也带 `component`）。一致性用例据此核对映射表与注册表不漂移。
 */
export const axMappedRegistryComponentNames = (): string[] => {
  const names = new Set<string>()
  for (const name of Object.keys(AX_PEN_COMPONENT_MAP)) {
    const factory = AX_PEN_COMPONENT_MAP[name]
    if (!factory) continue
    for (const variant of [undefined, 'User', 'Agent']) {
      const result = factory({ texts: [], variant })
      if (result) names.add(result.component)
    }
  }
  return [...names].sort()
}

/** 已登记的延后组件名。 */
export const axDeferredPenComponentNames = (): string[] => Object.keys(AX_DEFERRED_PEN_COMPONENTS)
