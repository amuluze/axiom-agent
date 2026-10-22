import type { AgentToolResult, JsonValue } from '@/agent/core/types'
import type { DesignComponentDetail } from '@/agent/design/componentInventoryHost'
import { designComponentDetail } from '@/agent/design/componentInventoryHost'
import type { AxNode } from '@/agent/design/axSchema'
import { emitAxPageToVue } from '@/agent/design/emitVuePage'
import { emitAxPageToTsx } from '@/agent/design/emitPage'
import {
  axComponentsUsed,
  axKindHistogram,
  axSymbolsUsed,
  countAxNodes,
  takeAxNodes,
  truncateToByteBudget,
} from '@/agent/design/designQueryProjection'
import {
  axPageIndex,
  inventoryOf,
  tokensOf,
  type AxModeContext,
} from '@/agent/design/designQueryContext'

/**
 * `.ax` 的读取模式（E4 切片）：summary / page / node / code。
 *
 * 全部为纯投影：只读 `AxModeContext`，payload 形状、预算截断与错误文案由
 * `designQueryTool.test.ts` 锁死。
 */

/** 某 symbol 在一棵页树里的实例数（summary 的使用计数）。 */
const axSymbolInstanceCount = (nodes: readonly AxNode[], symbolName: string): number => {
  let count = 0
  for (const node of nodes) {
    if (node.kind === 'component' && node.name === symbolName) count += 1
    if (node.children) count += axSymbolInstanceCount(node.children, symbolName)
    if (node.slot) count += axSymbolInstanceCount(node.slot, symbolName)
  }
  return count
}

export const executeAxSummaryMode = (context: AxModeContext): AgentToolResult => {
  const { axDoc, inventory, maxBytes } = context
  const symbols = axDoc.symbols ?? {}
  const hasSymbols = Object.keys(symbols).length > 0
  const pages = axDoc.pages.map((page, index) => ({
    index: index + 1,
    id: page.id,
    name: page.name ?? page.id,
    ...(page.group !== undefined ? { group: page.group } : {}),
    ...(page.state !== undefined ? { state: page.state } : {}),
    width: page.width ?? null,
    height: page.height ?? null,
    nodes: countAxNodes(page.tree),
    components: axComponentsUsed(page.tree, []),
    density: axKindHistogram(page.tree),
    ...(hasSymbols ? { symbols: axSymbolsUsed(page.tree, symbols) } : {}),
  }))
  const payload = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'summary',
    pages,
    // 组件清单：模型据此把设计稿里的组件名对到实现源码与 props 契约。
    components: inventory,
    componentInventorySource: context.componentInventorySource ?? 'project',
    ...(context.componentInventorySource === 'host'
      ? {
          componentInventoryNote:
            '本工作区没有 .axiom/design/components.json：以上清单来自 Axiom 宿主注册表（sourcePath 指向 Axiom 自身源码），不得用于本项目稿件与 codegen；本项目的稿只用 symbol / part / 原语。',
        }
      : {}),
    // 本地 symbol 清单（1.4）：契约 + body 规模 + 实例数——写实例前先看这里。
    ...(hasSymbols ? {
      symbols: Object.entries(symbols).map(([name, def]) => ({
        name,
        props: def.props ?? {},
        bodyNodes: countAxNodes(def.body),
        instances: axDoc.pages.reduce(
          (total, page) => total + axSymbolInstanceCount(page.tree, name),
          0,
        ),
      })),
    } : {}),
    tokens: Object.keys(axDoc.tokens).sort(),
    ...(context.diagnostics.length > 0 ? { diagnostics: context.diagnostics } : {}),
  }
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
  return {
    content,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'summary',
      pages: pages.length,
      truncated,
    },
  }
}

/** ── .ax code：该页的 TSX 骨架（组件恒等 + 原语 → CSS 变量） ───────────────── */
export const executeAxCodeMode = (
  context: AxModeContext,
  pageInput: string | number,
): AgentToolResult => {
  const { axDoc, inventory } = context
  const pageIndex = axPageIndex(axDoc, pageInput)
  const target = pageIndex >= 0 ? axDoc.pages[pageIndex] : undefined
  if (!target) {
    const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
    return {
      content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${context.file}. Pages: ${names.join(', ')}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  // 导入来源来自组件清单（注册表登记的 sourcePath）——模型不用猜路径。
  const componentImports: Record<string, { from: string; imported?: string }> = {}
  for (const entry of inventory) {
    const from = entry.sourcePath.replace(/\.tsx?$/, '').replace(/^src\//, '@/')
    componentImports[entry.name] = { from: entry.importSource ?? (from.startsWith('@/') ? from : `@/${from}`), imported: entry.exportName }
  }
  const componentDetails: Record<string, DesignComponentDetail> = {}
  for (const entry of inventory) {
    const detail = (context.componentDetail ?? designComponentDetail)(entry.name)
    if (detail) componentDetails[entry.name] = detail
  }
  const frameworks = new Set<string>()
  const visitFramework = (node: AxNode) => {
    if (node.kind === 'component') frameworks.add(componentDetails[typeof node.name === 'string' ? node.name : '']?.summary.framework ?? 'react')
    for (const child of node.children ?? []) visitFramework(child)
    for (const child of node.slot ?? []) visitFramework(child)
  }
  target.tree.forEach(visitFramework)
  if (frameworks.size > 1) return { content: 'design_query: 同一页混用了 React 与 Vue 组件，请先提供统一框架的展示包装。', details: { file: context.file, parsed: true, emitted: false } }
  const syntax = frameworks.has('vue') ? 'vue' : 'tsx'
  const emitted = (syntax === 'vue' ? emitAxPageToVue : emitAxPageToTsx)(axDoc, target.id, { componentImports, componentDetails })
  if (!emitted) {
    return {
      content: `design_query: cannot emit code for page ${target.id}（缺页尺寸或无节点）。`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const unresolvedLines = emitted.unresolved.map((item) => `- ${item.id} (${item.kind}): ${item.reason}`)
  const header = [
    `mode: code · page: ${target.name ?? target.id} (${pageIndex + 1}/${axDoc.pages.length})`
      + ` · nodes: ${emitted.counts.nodes} · components: ${emitted.counts.components}`,
    `生成组件名：${emitted.componentName}`,
    unresolvedLines.length > 0
      ? ['未映射（需人工接线）：', ...unresolvedLines].join('\n')
      : '未映射：无',
  ].join('\n')
  return {
    content: `${header}\n\n\`\`\`${syntax}\n${emitted.code}\`\`\`\n`,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'code',
      pageIndex: pageIndex + 1,
      syntax,
      componentName: emitted.componentName,
      counts: emitted.counts,
      unresolved: emitted.unresolved as unknown as JsonValue,
    },
  }
}

export const executeAxNodeMode = (context: AxModeContext, nodeId: string): AgentToolResult => {
  const { axDoc, inventory, maxBytes } = context
  const allNodes: AxNode[] = []
  const collectNodes = (nodes: readonly AxNode[]): void => {
    for (const node of nodes) {
      allNodes.push(node)
      collectNodes(node.children ?? [])
      if (node.slot) collectNodes(node.slot)
    }
  }
  axDoc.pages.forEach((page) => {
    collectNodes(page.tree)
  })
  // symbol body 节点也参与寻址（校验器保证 body id 全稿唯一，无歧义）——模型改
  // symbol 的某一行时可直接 nodeId 定位 body 子树；页树优先，二者 id 不可能冲突。
  const bodyOwner = new Map<string, string>()
  for (const [symbolName, def] of Object.entries(axDoc.symbols ?? {})) {
    const collectBody = (nodes: readonly AxNode[]): void => {
      for (const node of nodes) {
        bodyOwner.set(node.id, symbolName)
        collectBody(node.children ?? [])
        if (node.slot) collectBody(node.slot)
      }
    }
    collectBody(def.body)
    collectNodes(def.body)
  }
  const found = allNodes.find((node) => node.id === nodeId)
  if (!found) {
    return {
      content: `design_query: node "${nodeId}" not found in ${context.file}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const names = axComponentsUsed([found], [])
  const owner = bodyOwner.get(found.id)
  const payload = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'node',
    nodeId,
    node: found,
    ...(owner !== undefined ? { symbol: owner } : {}),
    components: inventoryOf(inventory, names),
    tokens: tokensOf(axDoc, [found]),
  }
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
  return {
    content,
    details: { file: context.file, sha256: context.sha256, format: 'ax', mode: 'node', found: true, truncated },
  }
}

/** ── .ax page：返回**已解析的规格**（token 字面值 + 作者视角的树 + 组件清单）── */
export const executeAxPageMode = (
  context: AxModeContext,
  pageInput: string | number,
): AgentToolResult => {
  const { axDoc, inventory, maxBytes } = context
  const pageIndex = axPageIndex(axDoc, pageInput)
  if (pageIndex < 0 || pageIndex >= axDoc.pages.length) {
    const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
    return {
      content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${context.file}. Pages: ${names.join(', ')}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const page = axDoc.pages[pageIndex]!
  const totalNodes = countAxNodes(page.tree)
  const componentsUsed = axComponentsUsed(page.tree, [])
  const payloadOf = (tree: AxNode[], truncated?: { keptNodes: number; omittedNodes: number }) => ({
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'page',
    page: {
      index: pageIndex + 1,
      id: page.id,
      name: page.name ?? page.id,
      ...(page.group !== undefined ? { group: page.group } : {}),
      ...(page.state !== undefined ? { state: page.state } : {}),
      ...(page.layout !== undefined ? { layout: page.layout } : {}),
      ...(page.gap !== undefined ? { gap: page.gap } : {}),
      ...(page.padding !== undefined ? { padding: page.padding } : {}),
      width: page.width ?? null,
      height: page.height ?? null,
      ...(page.background !== undefined ? { background: page.background } : {}),
    },
    components: inventoryOf(inventory, componentsUsed),
    // 本页用到的本地 symbol（与注册表组件分开列；summary 里有完整契约与实例计数）。
    ...(Object.keys(axDoc.symbols ?? {}).length > 0
      ? { symbols: axSymbolsUsed(page.tree, axDoc.symbols ?? {}) }
      : {}),
    tokens: tokensOf(axDoc, page.tree),
    tree,
    counts: { nodes: totalNodes, ...(truncated ? { keptNodes: truncated.keptNodes } : {}) },
    ...(truncated ? { truncated: { omittedNodes: truncated.omittedNodes } } : {}),
  })
  const full = JSON.stringify(payloadOf(page.tree), null, 2)
  if (new TextEncoder().encode(full).length <= maxBytes) {
    return {
      content: full,
      details: { file: context.file, sha256: context.sha256, format: 'ax', mode: 'page', pageIndex: pageIndex + 1, truncated: false },
    }
  }
  // 超预算：按**节点**收口（二分保留前 N 个），并显式标注省略数量——不静默收窄。
  let low = 1
  let high = totalNodes
  let best = 0
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = JSON.stringify(
      payloadOf(takeAxNodes(page.tree, { left: mid }), { keptNodes: mid, omittedNodes: totalNodes - mid }),
      null,
      2,
    )
    if (new TextEncoder().encode(candidate).length <= maxBytes) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  const keptNodes = takeAxNodes(page.tree, { left: best })
  const trimmed = JSON.stringify(
    payloadOf(keptNodes, { keptNodes: best, omittedNodes: totalNodes - best }),
    null,
    2,
  )
  return {
    content: trimmed,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'page',
      pageIndex: pageIndex + 1,
      truncated: true,
      omittedNodes: totalNodes - best,
    },
  }
}
