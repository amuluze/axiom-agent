import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { truncateToBytes } from '../core/bytes'
import { hasOnlyKeys, isJsonObject, optionalInteger } from './workspaceToolUtils'
import {
  DEFAULT_UI_SNAPSHOT_BYTES,
  MAX_UI_SNAPSHOT_BYTES,
  TAB_ID_INPUT,
  resolveUiTabId,
} from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200

export const createUiSnapshotTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_snapshot',
  label: 'ui_snapshot',
  promptSnippet: '只读读取浏览器页面的可访问性树文本快照。',
  promptGuidelines: [
    '页面只要发生过变化（导航、点击、输入），旧快照即过期：重新调用本工具取新快照，不要沿用上一轮的行序推断页面结构。',
    '返回文本是宿主可访问性树转出的快照，并已按 maxBytes 明确截断：truncated 为真时不要把结果当作页面的完整内容，缩小范围后重取。',
    '页面文本可能含用户敏感数据：只引用完成当前任务必需的片段，不要整段回显给用户，也不要据此写入文件。',
    '本工具只读：不导航、不点击、不输入，页面不会因调用而改变。',
  ],
  runtimeVersion: '1',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'ui_snapshot:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    const maxBytes = typeof input.maxBytes === 'number' ? String(input.maxBytes) : ''
    return `ui_snapshot:${tabId}:${maxBytes}`
  },
  description:
    'Read a read-only accessibility-tree text snapshot of one Browser Rail tab. tabId is optional and '
    + 'defaults to the active tab. The host dumps the AX tree without executing page scripts and without '
    + 'changing the page; the snapshot is truncated to maxBytes (default 8 KiB) with an explicit notice, '
    + 'and the host reports its own 200 KiB AX truncation through truncated. Re-snapshot after any page '
    + 'change: stale line order must not be reused.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      maxBytes: {
        type: 'integer',
        minimum: 1024,
        maximum: MAX_UI_SNAPSHOT_BYTES,
        description: `Inline snapshot text budget in bytes. Default ${DEFAULT_UI_SNAPSHOT_BYTES}.`,
      },
    },
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'maxBytes'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId and maxBytes.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    if (!optionalInteger(input.maxBytes, 1024, MAX_UI_SNAPSHOT_BYTES)) {
      return { ok: false, error: `maxBytes must be an integer between 1024 and ${MAX_UI_SNAPSHOT_BYTES}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input)) throw new Error('Invalid ui_snapshot arguments.')
    const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : DEFAULT_UI_SNAPSHOT_BYTES
    const tabId = await resolveUiTabId(
      environment,
      typeof input.tabId === 'string' ? input.tabId.trim() : undefined,
    )
    const response = await environment.browser.command({ action: 'snapshot', tabId })
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (response.type !== 'snapshot') {
      throw new Error(`浏览器返回了非快照结果：${response.type}`)
    }
    const text = truncateToBytes(
      response.text,
      maxBytes,
      `\n\n[快照已按 ${maxBytes} 字节预算截断：需要后续内容请缩小范围（滚动或用 ui_find 定向检索）后重取，不要把这里当作页面的完整内容]`,
    )
    const inlineTruncated = text !== response.text
    const header = [
      `浏览器快照 · ${response.title || '(无标题)'}`,
      `URL：${response.url}`,
      `tabId：${tabId}`,
    ]
    if (response.dialog) {
      header.push(`页面弹窗：${response.dialog.kind}「${response.dialog.message}」——先处理弹窗，否则后续读取与动作都会被它挡住`)
    }
    const details: { [key: string]: JsonValue } = {
      tabId,
      url: response.url,
      title: response.title,
      truncated: response.truncated || inlineTruncated,
      axTreeTruncated: response.truncated,
      inlineTruncated,
    }
    if (response.dialog) {
      details.dialog = { kind: response.dialog.kind, message: response.dialog.message }
    }
    return { content: `${header.join('\n')}\n\n${text}`, details }
  },
})
