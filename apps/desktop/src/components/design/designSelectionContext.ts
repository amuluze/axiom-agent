import { AX_SYMBOL_ID_SEP, type AxNode } from '@/agent/design/axSchema'
import type { PenDocument, PenNodeUnion } from '@/agent/design/penParser'

const ancestryOf = (roots: readonly PenNodeUnion[], target: string, parents: string[] = []): string[] | null => {
  for (const node of roots) {
    const path = [...parents, node.id]
    if (node.id === target) return path
    const children = 'children' in node ? node.children : undefined
    const found = children && ancestryOf(children, target, path)
    if (found) return found
  }
  return null
}

const axNodeOf = (roots: readonly AxNode[], id: string): AxNode | null => {
  for (const node of roots) {
    if (node.id === id) return node
    const found = axNodeOf([...(node.children ?? []), ...(node.slot ?? [])], id)
    if (found) return found
  }
  return null
}

interface SelectionTarget {
  pageId: string
  /** 页名（供引用文案用；缺 name 时回退 pageId）。 */
  pageName: string
  /** authored 节点 id（symbol 展开节点、投影遮罩层已落回真实节点）。 */
  nodeId: string
}

/**
 * 把画布上的选中节点解析成「稿里的真实定位」：页 id、authored 节点 id、祖先链。
 * 「引用到会话」与「转为实现提示词」的范围头共用它——两处的定位口径必须一致，
 * 否则同一个选中范围会得到两个不同的 nodeId。
 */
const resolveSelectionTarget = (doc: PenDocument, node: PenNodeUnion): SelectionTarget => {
  const ancestry = ancestryOf(doc.pages, node.id) ?? [node.id]
  const pageId = ancestry[0]
  const page = doc.axDocument?.pages.find((item) => item.id === pageId)
  const sourceNode = node.id === pageId ? page : page ? axNodeOf(page.tree, node.id)
    ?? (node.id.endsWith('~scrim') ? axNodeOf(page.tree, node.id.slice(0, -6)) : null)
    // symbol 实例展开节点（投影派生 id `${实例id}~s:${bodyId}`）：按分隔符取回实例的
    // authored 节点——点选 symbol 内部即选中整个实例（与真组件点选任意处选中整卡同语义）。
    ?? (node.id.includes(AX_SYMBOL_ID_SEP)
      ? axNodeOf(page.tree, node.id.slice(0, node.id.indexOf(AX_SYMBOL_ID_SEP)))
      : null) : undefined
  const pageNode = doc.pages.find((item) => item.id === pageId)
  const pageName = pageNode && 'name' in pageNode && typeof pageNode.name === 'string' && pageNode.name.trim()
    ? pageNode.name
    : pageId
  return { pageId, pageName, nodeId: sourceNode?.id ?? node.id }
}

/**
 * 「引用到会话」的轻量引用：只写定位（稿路径 + 页 id/名称 + authored 节点 id），
 * 不内联素材。模型拿到引用后用 `design_query` 按需取**解析后的规格**（token 已解析成
 * 明暗字面值、symbol 已展开、带预算与显式截断）——这比在 Composer 里塞一棵可能陈旧的
 * authored 子树更准确，也不占会话上下文。
 */
export const buildDesignReferencePrompt = (doc: PenDocument, node: PenNodeUnion): string => {
  const target = resolveSelectionTarget(doc, node)
  const file = JSON.stringify(doc.fileName)
  const page = `页「${target.pageName}」（pageId: ${target.pageId}）`
  const scope = target.nodeId === target.pageId ? page : `${page}中的节点 ${target.nodeId}`
  const query = target.nodeId === target.pageId
    ? `design_query { file: ${file}, mode: "page", page: ${JSON.stringify(target.pageId)} }`
    : `design_query { file: ${file}, mode: "node", nodeId: ${JSON.stringify(target.nodeId)} }`
  return [
    `引用设计稿 ${doc.fileName} 的${scope}。`,
    `请先用 discover_agent_tools 激活 design_query（若尚未激活），再用 ${query} 读取当前规格，然后按我的要求操作；不要凭这条引用猜测页面内容，也不要改动引用范围之外的页。`,
  ].join('\n\n')
}

/**
 * 「转为实现提示词」的范围头：一行定位 + 一条可复核查询。结构树本身已含实现所需的
 * 层级/尺寸/布局/样式语义，不再重复内联 `ax-selection@1`（同一棵子树写两遍是纯冗余）。
 */
export const buildDesignScopeLine = (doc: PenDocument, node: PenNodeUnion): string => {
  const target = resolveSelectionTarget(doc, node)
  const page = `页「${target.pageName}」（pageId: ${target.pageId}）`
  const scope = target.nodeId === target.pageId ? page : `${page}中的节点 ${target.nodeId}`
  const query = target.nodeId === target.pageId
    ? { mode: 'page', page: target.pageId }
    : { mode: 'node', nodeId: target.nodeId }
  return `范围：${scope} · 复核：design_query ${JSON.stringify({ file: doc.fileName, ...query })}`
}
