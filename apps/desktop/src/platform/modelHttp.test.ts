import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./environment', () => ({ isTauriRuntime: mocks.isTauriRuntime }))

import {
  cancelModelHttp,
  modelHttpByteStream,
  probeModelHttp,
} from './modelHttp'

interface StreamPayload {
  requestId: string
  status?: number
  chunk?: number[]
  done: boolean
  error?: string
}

interface StreamHandle {
  handler: (payload: StreamPayload) => void
  unlisten: ReturnType<typeof vi.fn>
}

const request = {
  requestId: 'req-1',
  providerId: 'test',
  url: 'https://api.example.com/v1/messages',
  apiFormat: 'anthropic-compatible' as const,
  body: '{"stream":true}',
  secretId: 'provider.generic-anthropic-compatible.api-key',
}

const installStream = (): StreamHandle => {
  const handle: StreamHandle = {
    handler: () => undefined,
    unlisten: vi.fn(),
  }
  mocks.listen.mockImplementationOnce(async (_event: string, callback: (event: { payload: StreamPayload }) => void) => {
    handle.handler = (payload: StreamPayload) => callback({ payload })
    return handle.unlisten
  })
  return handle
}

beforeEach(() => {
  mocks.isTauriRuntime.mockReturnValue(true)
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
  mocks.listen.mockReset()
})

describe('modelHttpByteStream', () => {
  it('streams chunks, reports response metadata, and unlistens on completion', async () => {
    const stream = installStream()
    const controller = new AbortController()
    const onResponse = vi.fn()

    const iterator = modelHttpByteStream(request, controller.signal, onResponse)[Symbol.asyncIterator]()
    const firstPromise = iterator.next()
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled())

    stream.handler({ requestId: 'req-1', status: 200, chunk: [104, 105], done: false })
    const first = await firstPromise
    expect(first.value).toEqual(Uint8Array.from([104, 105]))

    const secondPromise = iterator.next()
    stream.handler({ requestId: 'req-1', done: true })
    expect((await secondPromise).done).toBe(true)

    expect(onResponse).toHaveBeenCalledWith({ status: 200 })
    expect(stream.unlisten).toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith('stream_model_http', { request })
  })

  it('propagates a native payload error as a thrown Error', async () => {
    const stream = installStream()
    const iterator = modelHttpByteStream(request, new AbortController().signal)[Symbol.asyncIterator]()
    const nextPromise = iterator.next()
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled())

    stream.handler({ requestId: 'req-1', error: 'connection refused', done: true })
    await expect(nextPromise).rejects.toThrow('connection refused')
  })

  it('forwards an invoke failure as a terminal stream error', async () => {
    installStream()
    mocks.invoke.mockRejectedValueOnce(new Error('native spawn failed'))
    const iterator = modelHttpByteStream(request, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('native spawn failed')
  })

  it('cancels the native request and rejects with AbortError on abort', async () => {
    const controller = new AbortController()
    const iterator = modelHttpByteStream(request, controller.signal)[Symbol.asyncIterator]()
    const nextPromise = iterator.next()
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled())

    controller.abort()
    await expect(nextPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_model_http', { requestId: 'req-1' })
  })

  it('rejects before streaming outside the desktop runtime or when already aborted', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(modelHttpByteStream(
      request,
      new AbortController().signal,
    )[Symbol.asyncIterator]().next()).rejects.toThrow('仅在 Axiom 桌面应用中可用')

    mocks.isTauriRuntime.mockReturnValue(true)
    const aborted = new AbortController()
    aborted.abort()
    await expect(modelHttpByteStream(request, aborted.signal)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('modelHttp helpers', () => {
  it('short-circuits cancel and probe outside the desktop runtime', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(cancelModelHttp('req-1')).resolves.toBe(false)
    await expect(probeModelHttp(request)).rejects.toThrow('仅在 Axiom 桌面应用中可用')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('forwards cancel and probe IPC inside the desktop runtime', async () => {
    mocks.invoke.mockResolvedValueOnce(true)
    await expect(cancelModelHttp('req-1')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_model_http', { requestId: 'req-1' })

    mocks.invoke.mockResolvedValueOnce({ ok: true, status: 200, message: 'ok' })
    await expect(probeModelHttp(request)).resolves.toEqual({ ok: true, status: 200, message: 'ok' })
    expect(mocks.invoke).toHaveBeenCalledWith('probe_model_http', { request })
  })
})
