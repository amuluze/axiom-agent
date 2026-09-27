/**
 * `.ax` 的**部件词表与规范表**（docs/ax-format.md §3.2 规则 9、§4.1）。
 *
 * 部件（`part`）是三级节点里的中间层：**只写语义**（kind/variant/label/…），不含尺寸与
 * 内边距——度量由实现侧决定。因此这条规范表的做法是「**映射到真实实现的元素与类名**」，
 * 而不是再抄一份度量：类名指向本仓库样式表里已存在的部件类（BEM 基类 + 变体修饰符），
 * 于是
 * - 画布渲染的是实现的样子（不是照规范另画一遍，避免两套视觉）；
 * - 生成代码时同一个映射直接用（部件不再是 unresolved）；
 * - 映射是否失效可被测试守住（用例断言每个类名在样式表里存在）。
 *
 * 闭集：`kind` / `variant` / 可用字段都受校验器强制（fail-closed，与组件词表同口径）。
 */
export interface AxPartSpec {
  /** 部件说明（供设计 skill 与模型理解）。 */
  description: string
  /** BEM 基类（必须在样式表中存在，由用例守住）。 */
  className: string
  /** 变体闭集；首个为默认变体（不加修饰符类）。 */
  variants: readonly string[]
  /** 变体 → 修饰符类（默认变体不出现在此表）。 */
  variantClass?: Record<string, string>
  /** 该部件允许使用的字段（其余字段写了即报错）。 */
  fields: readonly AxPartField[]
  /** 文字子节点使用的类名（缺省表示文本直接作为元素内容）。 */
  textClassName?: string
  /**
   * 生成代码时的真实元素标签；**画布内一律以非交互元素渲染**（评审不得有副作用，
   * 例如按钮不应该是可点的真按钮）——两者类名相同，视觉一致。
   */
  element: 'div' | 'span' | 'section' | 'button'
  /** 图标类名（部件支持 icon 时；缺省用文字/图标直排）。 */
  iconClassName?: string
}

export type AxPartField = 'label' | 'supporting' | 'icon' | 'count' | 'selected' | 'state'

export const AX_PARTS: Record<string, AxPartSpec> = {
  statusTag: {
    description: '状态胶囊：运行中 / 已完成 / 已暂停 / 失败',
    className: 'session__status-tag',
    variants: ['running', 'completed', 'paused', 'failed'],
    variantClass: {
      completed: 'session__status-tag--completed',
      paused: 'session__status-tag--paused',
      failed: 'session__status-tag--error',
    },
    fields: ['label'],
    element: 'span',
  },
  divider: {
    description: '1px 分割线（分隔区段，不用矩形替代）',
    className: 'session__divider',
    variants: [],
    fields: [],
    element: 'div',
  },
  bubble: {
    description: '消息气泡：用户消息靠右着色，Agent 消息中性底',
    className: 'message-bubble',
    variants: ['assistant', 'user'],
    variantClass: { user: 'message-bubble--user' },
    fields: ['label'],
    element: 'div',
  },
  banner: {
    description: '提示横幅（暂停/状态类提示，含标题与可选图标）',
    className: 'session__paused-banner',
    textClassName: 'session__paused-banner-title',
    variants: [],
    fields: ['label', 'icon'],
    element: 'section',
  },
  actionButton: {
    description: '操作按钮：次要（默认）与主要两档；危险语义用 label 表达',
    className: 'approval-card__button',
    variants: ['secondary', 'primary'],
    variantClass: { primary: 'approval-card__button--primary' },
    fields: ['label', 'icon'],
    element: 'button',
  },
  mentionBadge: {
    description: '引用徽标（Composer 里的 @ 文件/目录胶囊）',
    className: 'composer__mention-badge',
    textClassName: 'composer__mention-badge-label',
    variants: [],
    fields: ['label'],
    element: 'span',
  },
}

/** 词表里的部件名（设计 skill 与错误信息共用）。 */
export const axPartKinds = (): string[] => Object.keys(AX_PARTS).sort()

export const axPartSpecOf = (kind: string | undefined): AxPartSpec | undefined =>
  kind === undefined ? undefined : AX_PARTS[kind]

/** 部件渲染/生成时使用的类名列表（基类 + 变体修饰符）。 */
export const axPartClassNames = (spec: AxPartSpec, variant: string | undefined): string[] => {
  const names = [spec.className]
  const modifier = variant !== undefined ? spec.variantClass?.[variant] : undefined
  if (modifier) names.push(modifier)
  if (spec.textClassName) names.push(spec.textClassName)
  return names
}
