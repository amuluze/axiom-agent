/**
 * 页内假 Tauri 宿主桥接脚本：由用例经 `page.addInitScript` 注入，在任何应用代码
 * 之前建立 `window.__TAURI_INTERNALS__`，使 `isTauriRuntime()` 为真——前端因此走
 * 完整桌面路径（工作区授权、审批、模型 HTTP 流），命令由 Node 假宿主实现。
 *
 * 必须自包含：Playwright 只序列化本函数体与参数。
 */
export interface BridgeOptions {
  hostBase: string
  clientId: string
}

export interface BridgeProbe {
  invokeCount: number
  lastCommand: string | null
}

export function installFakeTauriHost(options: BridgeOptions): void {
  const target = window as unknown as Record<string, unknown>
  const callbacks = new Map<number, (payload: unknown) => void>()
  let nextCallbackId = 1
  const probe: BridgeProbe = { invokeCount: 0, lastCommand: null }
  target.__AXIOM_E2E_BRIDGE__ = probe

  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    probe.invokeCount += 1
    probe.lastCommand = cmd
    // 事件订阅经宿主登记（宿主需要 event → handlerId 映射才能推送），
    // 回调本体留在页内 callbacks，由 /events 推送时按 handlerId 派发。
    if (cmd === 'plugin:event|emit') return null
    const response = await fetch(`${options.hostBase}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: options.clientId, cmd, args }),
    })
    const payload = (await response.json()) as { ok: boolean; value?: unknown; error?: string }
    if (!payload.ok) throw new Error(payload.error ?? `假宿主命令失败：${cmd}`)
    return payload.value ?? null
  }

  target.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback: (payload: unknown) => void, once = false) => {
      const id = nextCallbackId++
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id)
        callback(payload)
      })
      return id
    },
    unregisterCallback: (id: number) => {
      callbacks.delete(id)
    },
    convertFileSrc: (path: string, protocol = 'asset') =>
      `${protocol}://localhost/${encodeURIComponent(path)}`,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  }
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }

  // 宿主 → 页面的单向事件通道（模型流、工作区命令进度）。
  const events = new EventSource(`${options.hostBase}/events?client=${options.clientId}`)
  events.onmessage = (message) => {
    const envelope = JSON.parse(message.data) as { handler: number; event: string; payload: unknown }
    callbacks.get(envelope.handler)?.({
      event: envelope.event,
      id: envelope.handler,
      payload: envelope.payload,
    })
  }
}
