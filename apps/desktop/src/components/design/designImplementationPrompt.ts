/**
 * 设计 → 代码桥（docs/design-canvas.md §7 v0.3）：把 .pen 的 frame/页子树压成
 * 一段结构化实现提示词，经既有 composerInsertionRequest 通道注入 Composer。
 *
 * 纯函数（无 React / 无宿主依赖）：布局树 + 文案 + 引用到的设计 token（含明暗
 * 取值）压成紧凑 Markdown，供任意编程模型按其技术栈实现——这是「设计稿直接驱动
 * 写代码」的最小可行形态，不做 codegen（保真度不可控），只产出提示词。
 */
import { axPartClassNames, axPartSpecOf } from '@/agent/design/axParts'
import type { PenDocument, PenNodeUnion, PenPaint, PenSize } from '@/agent/design/penParser'

/** 结构上限：提示词要有用而不是淹没上下文，超限截断并标注。 */
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_NODES = 120

export interface DesignPromptLabels {
  /** 开头说明与实现指令（含技术栈/约定要求）。 */
  intro: string
  /** 「结构」小节标题。 */
  structure: string
  /** 「设计 token」小节标题。 */
  tokens: string
  /** 截断标注。 */
  truncated: string
}

export interface DesignImplementationPromptInput {
  doc: PenDocument
  node: PenNodeUnion
  labels: DesignPromptLabels
  maxDepth?: number
  maxNodes?: number
}

const formatSize = (size: PenSize | undefined): string | undefined => {
  if (size === undefined) return undefined
  return typeof size === 'number' ? String(size) : size
}

/** 尺寸表达：320×64，fill 语义保留原名（fill_container / fit_content）。 */
const formatDimensions = (node: { width?: PenSize; height?: PenSize }): string | undefined => {
  const width = formatSize(node.width)
  const height = formatSize(node.height)
  if (width === undefined && height === undefined) return undefined
  return `${width ?? '?'}×${height ?? '?'}`
}

const formatLayout = (node: PenNodeUnion): string[] => {
  if (node.type === 'unknown') return [`不支持的节点类型 ${node.originalType}`]
  // 组件实例（`.ax` 的 component）：实现就是这一行 JSX——设计 → 代码的恒等层
  // （props 已由注册表契约校验过，无需推断）。
  if (node.type === 'component') {
    const props = Object.entries(node.props ?? {})
      .map(([key, value]) => `${key}={${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}}`)
      .join(' ')
    return [`<${node.name}${node.variant ? ` variant="${node.variant}"` : ''}${props ? ` ${props}` : ''}>`]
  }
  if (node.type === 'part') {
    // 部件：实现里对应词表登记的类名（见 agent/design/axParts），实现提示词直接给出。
    const spec = axPartSpecOf(node.part)
    return [
      `部件 ${node.part}`,
      spec ? `→ .${axPartClassNames(spec, node.variant).join('.')}` : '（词表未登记）',
      ...(node.label ? [`文案 "${node.label}"`] : []),
      ...(node.variant ? [`变体 ${node.variant}`] : []),
    ]
  }
  const parts: string[] = []
  if (node.layout) parts.push(node.layout === 'vertical' ? '列' : '行')
  if (node.gap !== undefined) parts.push(`gap:${String(node.gap)}`)
  if (node.padding?.length) parts.push(`padding:${node.padding.map(String).join('/')}`)
  if (node.justifyContent) parts.push(`justify:${node.justifyContent}`)
  if (node.alignItems) parts.push(`align:${node.alignItems}`)
  if (node.cornerRadius !== undefined) parts.push(`radius:${String(node.cornerRadius)}`)
  if (node.layoutPosition === 'absolute') {
    parts.push(`absolute:${node.x ?? 0},${node.y ?? 0}`)
  }
  return parts
}

/** 填充/描边表达：token 原样保留（$token），图片与渐变给语义名。 */
const formatPaint = (paint: PenPaint | undefined): string | undefined => {
  if (!paint) return undefined
  if (paint.kind === 'image') return `image(${paint.url})`
  if (paint.kind === 'gradient') return 'gradient'
  return paint.value
}

/** 收集子树引用到的 token 名（fill/stroke 的 $token 与渐变里的 var(--token)）。 */
const collectTokens = (node: PenNodeUnion, into: Set<string>): void => {
  if (node.type === 'unknown' || node.type === 'component' || node.type === 'part') return
  for (const paint of [node.fill, node.stroke]) {
    if (!paint) continue
    if (paint.kind === 'solid' && paint.value.startsWith('$')) {
      into.add(paint.value.slice(1))
    } else if (paint.kind === 'gradient') {
      for (const match of paint.css.matchAll(/var\(--([\w-]+)\)/g)) {
        if (match[1]) into.add(match[1])
      }
    }
  }
  for (const child of node.children ?? []) collectTokens(child, into)
}

interface WalkState {
  lines: string[]
  nodes: number
  truncated: boolean
}

const describeNode = (node: PenNodeUnion): string => {
  const name = 'name' in node && typeof node.name === 'string' ? node.name : undefined
  const label = name ? `"${name}"` : node.id
  const parts: string[] = [node.type, label]
  if (node.type !== 'component' && node.type !== 'part') {
    const dimensions = formatDimensions(node)
    if (dimensions) parts.push(dimensions)
  }
  parts.push(...formatLayout(node))
  if (node.type === 'component' || node.type === 'part') return parts.join(' · ')
  const fill = formatPaint(node.type === 'unknown' ? undefined : node.fill)
  if (fill) parts.push(`bg:${fill}`)
  const stroke = formatPaint(node.type === 'unknown' ? undefined : node.stroke)
  if (stroke) parts.push(`border:${stroke}`)
  if (node.type === 'text') {
    const font = [node.fontSize, node.fontWeight].filter((value) => value !== undefined).map(String)
    if (font.length) parts.push(`font:${font.join('/')}`)
    parts.push(`text:"${(node.content ?? '').replace(/\s+/gu, ' ').trim()}"`)
  }
  if (node.type === 'icon') parts.push(`icon:${node.icon ?? '?'}`)
  return parts.join(' ')
}

const walk = (node: PenNodeUnion, depth: number, state: WalkState, maxDepth: number, maxNodes: number): void => {
  if (state.nodes >= maxNodes) {
    state.truncated = true
    return
  }
  state.nodes += 1
  state.lines.push(`${'  '.repeat(depth)}- ${describeNode(node)}`)
  const children = node.type === 'unknown' || node.type === 'component' || node.type === 'part'
    ? undefined
    : node.children
  if (!children?.length) return
  if (depth + 1 > maxDepth) {
    state.truncated = true
    return
  }
  for (const child of children) walk(child, depth + 1, state, maxDepth, maxNodes)
}

/**
 * 生成实现提示词：结构树（缩进即层级）+ 引用到的 token 明暗取值 + 实现指令。
 * 省略 CSS 细节（渲染器才关心），只保留实现者需要的语义：层级、尺寸、布局方向、
 * 间距、填充 token、文案与图标名。
 */
export const buildDesignImplementationPrompt = ({
  doc,
  node,
  labels,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxNodes = DEFAULT_MAX_NODES,
}: DesignImplementationPromptInput): string => {
  const state: WalkState = { lines: [], nodes: 0, truncated: false }
  walk(node, 0, state, maxDepth, maxNodes)

  const tokens = new Set<string>()
  collectTokens(node, tokens)

  const sections: string[] = []
  sections.push(labels.intro)
  sections.push(`${doc.fileName} · ${doc.version ? `v${doc.version}` : 'v?'}`)
  sections.push('')
  sections.push(`## ${labels.structure}`)
  sections.push(...state.lines)
  if (state.truncated) sections.push(labels.truncated)
  if (tokens.size > 0) {
    sections.push('')
    sections.push(`## ${labels.tokens}`)
    for (const name of [...tokens].sort()) {
      const light = doc.modeVariables.light[name] ?? '?'
      const dark = doc.modeVariables.dark[name] ?? '?'
      sections.push(`- $${name}: light=${light} dark=${dark}`)
    }
  }
  return sections.join('\n')
}
