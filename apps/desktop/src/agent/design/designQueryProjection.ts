import type { JsonValue } from '@/agent/core/types'
import type { PenNodeUnion } from '@/agent/design/penParser'
import type { AxNode, AxSymbolDef } from '@/agent/design/axSchema'

/**
 * design_query 的读取/投影纯函数（E1 切片）。
 *
 * 不读宿主、不写状态：预算截断、节点查找/计数/切片、组件/symbol 收集与
 * token ↔ CSS 一致性核对。
 */

/** missingInCss 清单的回传上限（超出的只给计数，不撑爆输出预算）。 */
const MAX_MISSING_TOKENS_LISTED = 20

/** CSS 自定义属性声明的提取（token ↔ 实现样式表一致性核对用）。 */
const CSS_VAR_DECLARATION_PATTERN = /--([a-zA-Z0-9_-]+)\s*:/g

/**
 * 按字节预算截断 UTF-8 文本：json.length 是 UTF-16 code unit，CJK 实际字节
 * 可达 3 倍，按 length 切既超预算又可能切断多字节字符。回退到码点边界，
 * 避免解码出 U+FFFD 替换符。
 */
export const truncateToByteBudget = (text: string, maxBytes: number): { content: string; truncated: boolean } => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return { content: text, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  const slice = new TextDecoder().decode(bytes.subarray(0, end))
  return { content: `${slice}\n...[truncated at ${maxBytes} bytes]`, truncated: true }
}

/** 设计稿文件判定：`.pen`（导入源）与 `.ax`（自有格式）。 */
export const isDesignFile = (path: string): boolean => /\.(pen|ax)$/i.test(path)

/** 页名（`.pen` 的视图模型里页根可能是 component/part 节点，统一走 in 窄化）。 */
export const pageNameOf = (page: PenNodeUnion): string =>
  'name' in page && typeof page.name === 'string' ? page.name : page.id

/** 深度优先查找含 nodeId 的子树（含 ref 解析后的 children）。 */
export const findNode = (nodes: readonly PenNodeUnion[], nodeId: string): PenNodeUnion | undefined => {
  for (const node of nodes) {
    if (node.id === nodeId) return node
    const children = 'children' in node ? node.children : undefined
    if (children) {
      const hit = findNode(children, nodeId)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * `.ax` 的 token 引用收集：扫树里所有 `$name` 字符串（含渐变色标的 color），
 * 用于「把 token 解析成明暗两档字面值」随页返回。
 */
export const collectTokenRefs = (value: unknown, into: Set<string>): void => {
  if (typeof value === 'string') {
    if (value.startsWith('$') && value.length > 1) into.add(value.slice(1))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectTokenRefs(item, into)
    })
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => {
      collectTokenRefs(item, into)
    })
  }
}

/** `.ax` 树的节点计数与「保留前 N 个」切片（超预算时按节点收口，绝不静默）。 */
export const countAxNodes = (nodes: readonly AxNode[]): number =>
  nodes.reduce((total, node) => total + 1 + countAxNodes(node.children ?? []), 0)

/** 节点 kind 直方图（summary 的 pages[].density 字段来源）：递归 children + slot。 */
export const axKindHistogram = (
  nodes: readonly AxNode[],
): { text: number; frame: number; icon: number; rect: number; ellipse: number; path: number; image: number; component: number; part: number; overlay: number } => {
  const counts = { text: 0, frame: 0, icon: 0, rect: 0, ellipse: 0, path: 0, image: 0, component: 0, part: 0, overlay: 0 }
  const walk = (list: readonly AxNode[]): void => {
    for (const node of list) {
      switch (node.kind) {
        case 'text': counts.text += 1; break
        case 'frame': counts.frame += 1; break
        case 'icon': counts.icon += 1; break
        case 'rect': counts.rect += 1; break
        case 'ellipse': counts.ellipse += 1; break
        case 'path': counts.path += 1; break
        case 'image': counts.image += 1; break
        case 'component': counts.component += 1; break
        case 'part': counts.part += 1; break
        case 'overlay': counts.overlay += 1; break
      }
      if (node.children) walk(node.children)
      if (node.slot) walk(node.slot)
    }
  }
  walk(nodes)
  return counts
}

export const takeAxNodes = (nodes: readonly AxNode[], budget: { left: number }): AxNode[] => {
  const kept: AxNode[] = []
  for (const node of nodes) {
    if (budget.left <= 0) break
    budget.left -= 1
    kept.push({ ...node, ...(node.children ? { children: takeAxNodes(node.children, budget) } : {}) })
  }
  return kept
}

/** 页里用到的组件名（去重、按出现顺序）。 */
export const axComponentsUsed = (nodes: readonly AxNode[], into: string[]): string[] => {
  for (const node of nodes) {
    if (node.kind === 'component' && typeof node.name === 'string' && !into.includes(node.name)) into.push(node.name)
    if (node.children) axComponentsUsed(node.children, into)
    if (node.slot) axComponentsUsed(node.slot, into)
  }
  return into
}

/**
 * 页里用到的**本地 symbol** 名（component 节点命中文档 `symbols` 的实例，去重、按
 * 出现顺序）。与 `axComponentsUsed` 分开列——注册表组件与文档局部组件是两个来源，
 * 混列会让「组件名 → 真实源码路径」的注册表承诺失真。
 */
export const axSymbolsUsed = (
  nodes: readonly AxNode[],
  symbols: Record<string, AxSymbolDef>,
  into: string[] = [],
): string[] => {
  for (const node of nodes) {
    if (node.kind === 'component' && typeof node.name === 'string' && Object.hasOwn(symbols, node.name) && !into.includes(node.name)) {
      into.push(node.name)
    }
    if (node.children) axSymbolsUsed(node.children, symbols, into)
    if (node.slot) axSymbolsUsed(node.slot, symbols, into)
  }
  return into
}

/**
 * `.ax` tokens ↔ 实现样式表的一致性核对（B5）：`$name` 在实现侧落到 `var(--name)`，
 * 稿里声明而样式表没有同名变量的 token 会让「设计稿引用 → 实现接线」断链。
 * 这是**建议性**报告（设计系统的度量 token 不必然有 CSS 变量对应），不产生页级
 * fail/warn 判定；由调用方显式传 `tokensCss` 才参与（不同工作区的样式表路径不同）。
 */
export const tokenParityOf = (
  tokens: Record<string, unknown>,
  cssFile: string,
  cssText: string,
): JsonValue => {
  const cssVars = new Set<string>()
  for (const match of cssText.matchAll(CSS_VAR_DECLARATION_PATTERN)) cssVars.add(match[1] ?? '')
  cssVars.delete('')
  const names = Object.keys(tokens).sort()
  const missing = names.filter((name) => !cssVars.has(name))
  return {
    cssFile,
    cssVariables: cssVars.size,
    tokens: names.length,
    missingCount: missing.length,
    missingInCss: missing.slice(0, MAX_MISSING_TOKENS_LISTED),
    ...(missing.length > MAX_MISSING_TOKENS_LISTED
      ? { note: `另有 ${missing.length - MAX_MISSING_TOKENS_LISTED} 个未列出` }
      : {}),
  }
}
