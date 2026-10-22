import type { AgentTool, AgentToolResult } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject, optionalInteger, sha256Text } from './workspaceToolUtils'
import { MAX_UI_WAIT_MS, TAB_ID_INPUT, resolveUiTabId } from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200
const MAX_NEEDLE_CHARS = 500

export const createUiWaitTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_wait',
  label: 'ui_wait',
  promptSnippet: '等待浏览器页面出现指定文本或经过指定时长（只读）。',
  promptGuidelines: [
    'text 与 durationMs 至少给一个；两者都给时先等到文本出现（最多 15 秒上限），再补足时长。',
    '等待是节奏原语：textMatched=false 只说明在等待窗口内没出现，不代表页面永远不会有该文本——重新 ui_snapshot 看当前状态，或把长等待拆成多次短等待。',
    '最长等待 15 秒：更长的等待应由你拆步（先等待、再看快照、再决定），不要指望一次调用阻塞到页面就绪。',
  ],
  runtimeVersion: '1',
  recoveryPolicy: 'idempotent',
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'ui_wait:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    // 等待文本可长到 500 字符（CJK 逾 1 KB）：明文进键会顶穿 runtime 的 512 bytes
    // 上限，把工具调用直接判为 error。这里只保留内容摘要。
    const text = typeof input.text === 'string' ? await sha256Text(input.text) : ''
    const durationMs = typeof input.durationMs === 'number' ? String(input.durationMs) : ''
    return `ui_wait:${tabId}:${text}:${durationMs}`
  },
  description:
    'Read-only wait on one Browser Rail tab: wait until the given text appears in the page accessibility '
    + 'tree, and/or wait for a fixed duration. At least one of text and durationMs is required. tabId is '
    + 'optional and defaults to the active tab. The wait is capped at 15 seconds by the host; textMatched '
    + 'reports whether the text appeared inside that window and is not a promise that it never will.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      text: {
        type: 'string',
        minLength: 1,
        description: 'Text to wait for in the page accessibility tree.',
      },
      durationMs: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_UI_WAIT_MS,
        description: `Fixed wait in milliseconds (max ${MAX_UI_WAIT_MS}).`,
      },
    },
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'text', 'durationMs'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId, text, and durationMs.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    if (input.text === undefined && input.durationMs === undefined) {
      return { ok: false, error: 'Provide text, durationMs, or both.' }
    }
    if (input.text !== undefined
      && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_NEEDLE_CHARS)) {
      return { ok: false, error: `text must be a non-empty string of at most ${MAX_NEEDLE_CHARS} chars.` }
    }
    if (!optionalInteger(input.durationMs, 1, MAX_UI_WAIT_MS)) {
      return { ok: false, error: `durationMs must be an integer between 1 and ${MAX_UI_WAIT_MS}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input)) throw new Error('Invalid ui_wait arguments.')
    const text = typeof input.text === 'string' ? input.text.trim() : undefined
    const durationMs = typeof input.durationMs === 'number' ? input.durationMs : undefined
    const tabId = await resolveUiTabId(
      environment,
      typeof input.tabId === 'string' ? input.tabId.trim() : undefined,
    )
    const response = await environment.browser.command({
      action: 'wait',
      tabId,
      ...(text !== undefined ? { text } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    })
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (response.type !== 'waited') {
      throw new Error(`浏览器返回了非等待结果：${response.type}`)
    }
    const textVerdict = text === undefined
      ? '未要求等待文本'
      : response.textMatched
        ? `文本「${text}」已在等待窗口内出现`
        : `文本「${text}」在等待窗口内未出现（不代表之后不会出现）`
    return {
      content: [
        `等待完成：实际耗时 ${response.waitedMs} ms（tabId=${tabId}）`,
        textVerdict,
      ].join('\n'),
      details: {
        tabId,
        waitedMs: response.waitedMs,
        textMatched: response.textMatched,
        ...(text !== undefined ? { text } : {}),
      },
    }
  },
})
