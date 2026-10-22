/**
 * `.ax` 幂等序列化（自 axParser 抽出的纯函数簇）。
 *
 * 同样输入必得同样字节：键序固定（KEY_ORDER + 递归排序 slot/children）、
 * 2 空格缩进、末尾换行——供模型打补丁与 git diff 稳定对账。
 */
import type { AxDocument, AxNode } from './axSchema'
import { AX_PAGE_KEYS } from './axSchema'

const KEY_ORDER: readonly string[] = [
  'id', 'kind', 'name', 'part', 'variant', 'props', 'fixture', 'slot', 'label', 'supporting', 'icon', 'size',
  'count', 'selected', 'state', 'text', 'layout', 'gap', 'padding', 'group', 'width', 'height', 'background',
  'justifyContent', 'alignItems', 'clip', 'theme', 'fontSize', 'fontWeight', 'fontFamily',
  'lineHeight', 'letterSpacing', 'textAlign', 'wrap', 'fill', 'stroke', 'strokeWidth',
  'cornerRadius', 'innerRadius', 'shadow', 'geometry', 'viewBox', 'asset', 'mode', 'anchor', 'offset',
  'scrim', 'children', 'tree', 'body',
]

const orderedRecord = (record: Record<string, unknown>): Record<string, unknown> => {
  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) ordered[key] = record[key]
  }
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(ordered, key) && record[key] !== undefined) ordered[key] = record[key]
  }
  return ordered
}

/** 节点键序：`slot`/`children` 递归排序，其余按 KEY_ORDER（幂等序列化的唯一实现）。 */
const orderedNode = (node: AxNode): Record<string, unknown> => {
  const { children, slot, ...rest } = node as AxNode & { children?: AxNode[]; slot?: AxNode[] }
  return orderedRecord({
    ...(rest as Record<string, unknown>),
    ...(slot ? { slot: slot.map(orderedNode) } : {}),
    ...(children ? { children: children.map(orderedNode) } : {}),
  })
}

/** 幂等序列化：同样输入必得同样字节（测试断言 parse→serialize→parse 等值）。 */
export const serializeAxDocument = (document: AxDocument): string => {
  const payload = {
    ax: document.ax,
    ...(document.name !== undefined ? { name: document.name } : {}),
    tokens: Object.fromEntries(
      Object.entries(document.tokens).map(([name, token]) => [name, orderedRecord(token as unknown as Record<string, unknown>)]),
    ),
    components: Object.fromEntries(
      Object.entries(document.components).map(([name, decl]) => [name, orderedRecord(decl as unknown as Record<string, unknown>)]),
    ),
    // symbols 为空不落键：存量稿（无 symbols）经 parse→serialize 往返字节不变。
    ...(document.symbols && Object.keys(document.symbols).length > 0 ? {
      symbols: Object.fromEntries(
        Object.entries(document.symbols).map(([name, def]) => [name, orderedRecord({
          ...(def.props !== undefined ? { props: def.props } : {}),
          body: def.body.map(orderedNode),
        })]),
      ),
    } : {}),
    pages: document.pages.map((page) => {
      // 页字段顺序由 AX_PAGE_KEYS 权威给出，不在本文件复述一份字面量——复述过的
      // 那份曾经把「漏写字段」与「字段顺序」两类错误混在一处（漏写 layout/gap/padding
      // 会让写盘的 .ax 读回来变成默认横向布局、渲染塌陷，design_import 产物即受此影响）。
      // 按 AX_PAGE_KEYS 遍历同时保证 tree 恒在末位。
      const record: Record<string, unknown> = {}
      for (const key of AX_PAGE_KEYS) {
        if (key === 'tree') continue
        const value = (page as unknown as Record<string, unknown>)[key]
        if (value !== undefined) record[key] = value
      }
      return { ...record, tree: page.tree.map(orderedNode) }
    }),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}
