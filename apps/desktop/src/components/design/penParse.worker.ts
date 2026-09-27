/**
 * .pen 解析 worker（docs/design-canvas.md §7 v0.3 扩展）：大设计稿的
 * JSON.parse + 树归一化在主线程会阻塞渲染，超过阈值时改由本 worker 承担。
 *
 * 只做解析、不碰 DOM：penParser 是纯函数，输入源文本、输出可结构化克隆的
 * PenParseResult（无函数/类实例），因此可以直接 postMessage 回传。
 */
import { parsePenDocument, type PenParseResult } from '@/agent/design/penParser'

interface ParseRequest {
  id: number
  source: string
  fileName: string
}

// worker 全局的窄化类型：tsconfig 的 lib 面向 DOM，直接写 self.onmessage
// 会被当成 window 的签名（postMessage 重载不同）。
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null
  postMessage: (message: { id: number; result: PenParseResult }) => void
}

workerScope.onmessage = (event) => {
  const { id, source, fileName } = event.data
  workerScope.postMessage({ id, result: parsePenDocument(source, fileName) })
}
