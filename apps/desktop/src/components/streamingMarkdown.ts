/**
 * 流式 markdown 的稳定前缀切分：把正在增长的文本拆成「已闭合、可安全完整渲染」的
 * 稳定前缀与「可能未闭合、需轻量渲染」的尾部。
 *
 * 边界判定复用 {@link parseMessageContent} 的成对 code fence 语义：只有成对闭合的
 * 围栏才算稳定边界。取最后一个闭合围栏的结束位置，之前是 `stable`（围栏必成对），
 * 之后是 `tail`（可能含未闭合围栏 / 普通段落）。无闭合围栏时 `stable` 为空、`tail`
 * 为全文。纯函数、无 React 依赖，便于独立单测与流式增量渲染复用。
 */

export interface StreamingMarkdownSplit {
  /** 最后一个闭合 code fence 之前的完整文本，可安全整体渲染。 */
  stable: string
  /** 最后一个闭合 code fence 之后的文本，可能未闭合，需轻量渲染。 */
  tail: string
}

/** 成对 code fence，与 `MessageContent.parseMessageContent` 同一语义（非贪婪、含 g 标志）。 */
const FENCE_RE = /```[^\n`]*\r?\n[\s\S]*?```/gu

export const splitStreamingMarkdown = (text: string): StreamingMarkdownSplit => {
  let lastEnd = -1
  for (const match of text.matchAll(FENCE_RE)) {
    lastEnd = match.index + match[0].length
  }
  if (lastEnd < 0) return { stable: '', tail: text }
  return { stable: text.slice(0, lastEnd), tail: text.slice(lastEnd) }
}
