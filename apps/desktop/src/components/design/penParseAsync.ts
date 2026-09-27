/**
 * .pen 解析调度：小文档主线程同步解析（省 worker 往返），大文档交给
 * penParse.worker.ts，worker 不可用（测试环境 / 加载失败 / CSP 拒绝）时
 * 无条件回退同步解析——正确性不依赖 worker，只影响是否阻塞主线程。
 *
 * docs/design-canvas.md §7 v0.3（原 §7 v0.1 把解析留在主线程的权衡）。
 */
import { parsePenDocument, type PenParseResult } from '@/agent/design/penParser'

/** 主线程同步解析门槛（UTF-16 长度代理）：axiom.pen 实际 ~1.3MB 走 worker。 */
export const WORKER_PARSE_THRESHOLD_CHARS = 2 * 1024 * 1024

interface PendingParse {
  resolve: (result: PenParseResult) => void
}

let worker: Worker | null = null
/** 加载失败后不再重试：worker 是可选加速，不是正确性依赖（避免每次解析都抛一遍）。 */
let workerUnavailable = false
let nextId = 0
const pending = new Map<number, PendingParse>()

const settleAllWith = (result: PenParseResult): void => {
  for (const entry of pending.values()) entry.resolve(result)
  pending.clear()
}

const ensureWorker = (): Worker | null => {
  if (worker) return worker
  if (workerUnavailable || typeof Worker === 'undefined') return null
  try {
    worker = new Worker(new URL('./penParse.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    workerUnavailable = true
    return null
  }
  worker.onmessage = (event: MessageEvent<{ id: number; result: PenParseResult }>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    entry.resolve(event.data.result)
  }
  worker.onerror = () => {
    // 回调里抛错会丢失调用方 Promise，统一以解析失败结果收口（画布显示错误卡片）。
    settleAllWith({ document: null, error: '设计稿解析线程异常终止，请重试或刷新' })
    worker = null
    workerUnavailable = true
  }
  return worker
}

export const parsePenDocumentAsync = (source: string, fileName: string): Promise<PenParseResult> => {
  if (source.length < WORKER_PARSE_THRESHOLD_CHARS) {
    return Promise.resolve(parsePenDocument(source, fileName))
  }
  const instance = ensureWorker()
  if (!instance) return Promise.resolve(parsePenDocument(source, fileName))
  nextId += 1
  const id = nextId
  return new Promise<PenParseResult>((resolve) => {
    pending.set(id, { resolve })
    try {
      instance.postMessage({ id, source, fileName })
    } catch {
      // postMessage 失败（结构不可克隆等）不阻断渲染：回退主线程解析。
      pending.delete(id)
      resolve(parsePenDocument(source, fileName))
    }
  })
}

/** 仅供测试重置模块级 worker 状态。 */
export const __resetParseWorkerForTests = (): void => {
  pending.clear()
  worker = null
  workerUnavailable = false
  nextId = 0
}
