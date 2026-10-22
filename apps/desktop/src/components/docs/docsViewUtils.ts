import { isValidElement, type MouseEvent, type ReactNode } from 'react'

/**
 * 文档页（DocsView）的纯数据形状与常量。
 *
 * 抽出的目的：985 行的组件应只剩「编排 + 渲染」，阅读态与编辑态的数据形状、
 * 存取键与去抖窗口属于纯声明，放在组件里会让任何一次拆分都要重读整个文件。
 * 这里**不允许**出现 React 状态或副作用。
 */

/** 每个工作区记忆的最后打开文档（localStorage 键后缀为工作区路径）。 */
export const SELECTED_PATH_STORAGE_KEY = 'axiom.docs.selected.v1'

/** 首次加载与「加载更多」的单次读取行数（对齐 read 工具的分页量级）。 */
export const DOC_READ_LINES = 400

/**
 * 宿主 `read` 对超长单行的占位提示（由 Rust `workspace_access.rs` 生成，不是文档内容）。
 * 阅读态直接把它当正文渲染会让用户误以为文档里真写了这段英文。
 */
export const OVERSIZED_LINE_PLACEHOLDER = /\[Line \d+ is \d+ bytes, exceeds the \d+ KiB read output limit\./u

/** run 结束/revision/focus 等自动触发源的短窗口去抖；手动「重新扫描」不走它。 */
export const AUTO_SCAN_DEBOUNCE_MS = 200

/** 阅读态：分页累积的正文与它对应的全文 revision。 */
export interface DocContentState {
  path: string
  chunks: string[]
  loadedLines: number
  totalLines: number
  /** 续读偏移（宿主 nextOffset 原值）；null 表示已读到 EOF。 */
  nextOffset: number | null
  /** 本次读取的全文 SHA-256：与索引 revision 比较，磁盘变化时触发重读。 */
  revision: string
  loading: boolean
  error: string | null
}

/** 编辑态草稿：进入编辑时整份载入，dirty 相对打开内容判定。 */
export interface DocEditState {
  path: string
  draft: string
  baseline: string
  baselineSha256: string
  saving: boolean
  error: string | null
}

/** 把 React 子节点拍平成纯文本（标题锚点用）。 */
export const textFromNode = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children)
  return ''
}

/** 标题 → 锚点 id（与 #fragment 链接一致的小写/去符号归一）。 */
export const headingId = (children: ReactNode): string => textFromNode(children)
  .trim()
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s+/gu, '-')
  .replace(/-+/gu, '-')

/** 相对 Markdown 链接 → 工作区相对路径；越界（.. 超出根）与绝对/协议链接返回 null。 */
export const resolveRelativeDocPath = (fromPath: string, href: string): string | null => {
  let rawPath: string
  try {
    rawPath = decodeURIComponent(href.split('#', 1)[0])
  } catch {
    return null
  }
  if (!rawPath || rawPath.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(rawPath)) return null
  const segments = [...fromPath.split('/').slice(0, -1), ...rawPath.split('/')]
  const normalized: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (normalized.length === 0) return null
      normalized.pop()
      continue
    }
    normalized.push(segment)
  }
  return normalized.join('/')
}

export const scrollToFragment = (fragment: string): void => {
  let id = fragment
  try {
    id = decodeURIComponent(fragment)
  } catch {
    id = fragment
  }
  window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView())
}

export const blockUnsupportedLink = (event: MouseEvent<HTMLAnchorElement>): void => {
  event.preventDefault()
}

export const isExternalHttpLink = (href: string): boolean => /^https?:\/\//u.test(href)

export const splitLink = (href: string): { path: string; fragment: string | null } => {
  const separator = href.indexOf('#')
  if (separator < 0) return { path: href, fragment: null }
  return { path: href.slice(0, separator), fragment: href.slice(separator + 1) }
}
