import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  ModelHttpRequest,
  ModelHttpResponseObserver,
  ModelProbeRequest,
  ModelProbeResult,
} from '@/agent/transport/modelHttpContract'
import { isTauriRuntime } from './environment'

export type {
  ModelHttpRequest,
  ModelHttpResponseMetadata,
  ModelHttpResponseObserver,
  ModelProbeRequest,
  ModelProbeResult,
} from '@/agent/transport/modelHttpContract'

interface ModelStreamPayload {
  requestId: string
  status?: number
  chunk?: number[]
  done: boolean
  error?: string
}

class AsyncPayloadQueue {
  private readonly pending: ModelStreamPayload[] = []
  private resolveNext?: (payload: ModelStreamPayload) => void

  push(payload: ModelStreamPayload): void {
    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = undefined
      resolve(payload)
    } else {
      this.pending.push(payload)
    }
  }

  async next(): Promise<ModelStreamPayload> {
    const pending = this.pending.shift()
    if (pending) return pending
    return new Promise<ModelStreamPayload>((resolve) => {
      this.resolveNext = resolve
    })
  }
}

const asErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const cancelModelHttp = async (requestId: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false
  return invoke<boolean>('cancel_model_http', { requestId })
}

export async function* modelHttpByteStream(
  request: ModelHttpRequest,
  signal: AbortSignal,
  onResponse?: ModelHttpResponseObserver,
): AsyncIterable<Uint8Array> {
  if (!isTauriRuntime()) throw new Error('真实模型连接仅在 Axiom 桌面应用中可用')
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const queue = new AsyncPayloadQueue()
  let terminalSeen = false
  let unlisten: UnlistenFn | undefined
  const abort = () => {
    void cancelModelHttp(request.requestId).catch(() => false)
    if (!terminalSeen) {
      queue.push({
        requestId: request.requestId,
        done: true,
        error: '模型请求已取消',
      })
    }
  }

  try {
    unlisten = await listen<ModelStreamPayload>('axiom:model-stream', (event) => {
      if (event.payload.requestId === request.requestId) queue.push(event.payload)
    })
    signal.addEventListener('abort', abort, { once: true })

    void invoke('stream_model_http', { request }).catch((error: unknown) => {
      if (!terminalSeen) {
        queue.push({
          requestId: request.requestId,
          done: true,
          error: asErrorMessage(error),
        })
      }
    })

    while (!terminalSeen) {
      const payload = await queue.next()
      if (payload.error) {
        terminalSeen = true
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        throw new Error(payload.error)
      }
      if (payload.status !== undefined) await onResponse?.({ status: payload.status })
      if (payload.chunk) yield Uint8Array.from(payload.chunk)
      if (payload.done) terminalSeen = true
    }
  } finally {
    const completed = terminalSeen
    terminalSeen = true
    signal.removeEventListener('abort', abort)
    unlisten?.()
    if (!completed || signal.aborted) {
      await cancelModelHttp(request.requestId).catch(() => false)
    }
  }
}

export const probeModelHttp = async (request: ModelProbeRequest): Promise<ModelProbeResult> => {
  if (!isTauriRuntime()) throw new Error('Provider 连通性验证仅在 Axiom 桌面应用中可用')
  return invoke<ModelProbeResult>('probe_model_http', { request })
}
