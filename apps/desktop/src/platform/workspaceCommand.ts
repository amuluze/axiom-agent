import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriRuntime } from './environment'

export type WorkspaceCommandStream = 'stdout' | 'stderr'

export interface WorkspaceCommandRequest {
  requestId: string
  command: string
  cwd?: string
  timeoutMs?: number
}

export interface WorkspaceCommandProgress {
  stream: WorkspaceCommandStream
  capturedStdoutBytes: number
  capturedStderrBytes: number
}

export interface WorkspaceCommandResult {
  exitCode?: number
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  stdout: string
  stderr: string
  truncated: boolean
  cancelled: boolean
  timedOut: boolean
  /** 本命令进程组内的 seatbelt deny 条目（仅沙箱执行且非空时存在）。 */
  sandboxDenials?: string[]
  /** 本命令是否在 seatbelt 沙箱内执行；false 表示沙箱不可用、以常规用户权限回退执行。 */
  sandboxed?: boolean
}

export interface WorkspaceCommandPayload {
  requestId: string
  stream?: WorkspaceCommandStream
  chunk?: number[]
  done: boolean
  exitCode?: number
  durationMs?: number
  stdoutBytes?: number
  stderrBytes?: number
  truncated?: boolean
  cancelled?: boolean
  timedOut?: boolean
  sandboxDenials?: string[]
  sandboxed?: boolean
  error?: string
}

class AsyncPayloadQueue {
  private readonly pending: WorkspaceCommandPayload[] = []
  private resolveNext?: (payload: WorkspaceCommandPayload) => void

  push(payload: WorkspaceCommandPayload): void {
    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = undefined
      resolve(payload)
    } else {
      this.pending.push(payload)
    }
  }

  async next(): Promise<WorkspaceCommandPayload> {
    const pending = this.pending.shift()
    if (pending) return pending
    return new Promise<WorkspaceCommandPayload>((resolve) => {
      this.resolveNext = resolve
    })
  }
}

const asErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const cancelWorkspaceCommand = async (requestId: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false
  return invoke<boolean>('cancel_workspace_command', { requestId })
}

export const runWorkspaceCommand = async (
  request: WorkspaceCommandRequest,
  signal: AbortSignal,
  onProgress: ((progress: WorkspaceCommandProgress) => void) | undefined,
  approvalLease: string,
  workspacePath?: string,
): Promise<WorkspaceCommandResult> => {
  if (!isTauriRuntime()) throw new Error('工作区命令仅能在 Axiom 桌面应用中执行')
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const queue = new AsyncPayloadQueue()
  const stdoutDecoder = new TextDecoder()
  const stderrDecoder = new TextDecoder()
  const stdout: string[] = []
  const stderr: string[] = []
  let capturedStdoutBytes = 0
  let capturedStderrBytes = 0
  let terminalSeen = false
  let unlisten: UnlistenFn | undefined
  const abort = () => {
    void cancelWorkspaceCommand(request.requestId).catch(() => false)
    if (!terminalSeen) {
      queue.push({
        requestId: request.requestId,
        done: true,
        cancelled: true,
        error: '工作区命令已取消',
      })
    }
  }

  try {
    unlisten = await listen<WorkspaceCommandPayload>('axiom:workspace-command', (event) => {
      if (event.payload.requestId === request.requestId) queue.push(event.payload)
    })
    signal.addEventListener('abort', abort, { once: true })

    void invoke('run_workspace_command', {
      request,
      approvalLease,
      ...(workspacePath ? { workspacePath } : {}),
    }).catch((error: unknown) => {
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
        if (signal.aborted || payload.cancelled) throw new DOMException('Aborted', 'AbortError')
        throw new Error(payload.error)
      }
      if (payload.chunk && payload.stream) {
        const bytes = Uint8Array.from(payload.chunk)
        if (payload.stream === 'stdout') {
          capturedStdoutBytes += bytes.byteLength
          stdout.push(stdoutDecoder.decode(bytes, { stream: true }))
        } else {
          capturedStderrBytes += bytes.byteLength
          stderr.push(stderrDecoder.decode(bytes, { stream: true }))
        }
        onProgress?.({
          stream: payload.stream,
          capturedStdoutBytes,
          capturedStderrBytes,
        })
      }
      if (!payload.done) continue
      terminalSeen = true
      stdout.push(stdoutDecoder.decode())
      stderr.push(stderrDecoder.decode())
      return {
        exitCode: payload.exitCode,
        durationMs: payload.durationMs ?? 0,
        stdoutBytes: payload.stdoutBytes ?? capturedStdoutBytes,
        stderrBytes: payload.stderrBytes ?? capturedStderrBytes,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        truncated: payload.truncated ?? false,
        cancelled: payload.cancelled ?? false,
        timedOut: payload.timedOut ?? false,
        sandboxDenials: payload.sandboxDenials,
        sandboxed: payload.sandboxed,
      }
    }
    throw new Error('工作区命令在终止事件前关闭')
  } finally {
    const completed = terminalSeen
    terminalSeen = true
    signal.removeEventListener('abort', abort)
    unlisten?.()
    if (!completed || signal.aborted) {
      await cancelWorkspaceCommand(request.requestId).catch(() => false)
    }
  }
}
