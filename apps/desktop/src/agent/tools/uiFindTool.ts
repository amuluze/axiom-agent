import type { AgentTool, AgentToolResult } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject, optionalInteger, sha256Text } from './workspaceToolUtils'
import {
  DEFAULT_UI_FIND_LIMIT,
  MAX_UI_FIND_LIMIT,
  TAB_ID_INPUT,
  resolveUiTabId,
} from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200
const MAX_NEEDLE_CHARS = 500

export const createUiFindTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_find',
  label: 'ui_find',
  promptSnippet: '在浏览器页面按文本检索可访问性树中的行（只读）。',
  promptGuidelines: [
    '定位元素优先用 ui_assert 的结构化定位器（testId / role+name）；本工具只做页面级文本检索，命中行不保证是你要的那个元素。',
    '检索词区分大小写、命中行已由宿主单行截断：命中过多时换更具体的词，而不是反复调大 limit。',
    '命中行来自页面可访问性树，可能含用户敏感数据：只引用必需片段，不要整段转述。',
  ],
  runtimeVersion: '1',
  recoveryPolicy: 'idempotent',
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'ui_find:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    // 检索词可长到 500 字符（CJK 逾 1 KB）：明文进键会顶穿 runtime 的 512 bytes
    // 上限，把工具调用直接判为 error。这里只保留内容摘要，既保幂等语义又不把
    // 页面检索明文写进审计键。
    const text = typeof input.text === 'string' ? await sha256Text(input.text) : ''
    const limit = typeof input.limit === 'number' ? String(input.limit) : ''
    return `ui_find:${tabId}:${text}:${limit}`
  },
  description:
    'Read-only full-page text search over the accessibility tree of one Browser Rail tab: returns the '
    + 'matching AX lines with their total count. tabId is optional and defaults to the active tab. '
    + 'Matching is case-sensitive; the host truncates each line and reports truncated when more matches '
    + 'exist than were returned. Use structured locators (ui_assert) when you need one specific element.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      text: {
        type: 'string',
        minLength: 1,
        description: 'Text to search for in the page accessibility tree (case-sensitive).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_UI_FIND_LIMIT,
        description: `Maximum returned lines. Default ${DEFAULT_UI_FIND_LIMIT}, max ${MAX_UI_FIND_LIMIT}.`,
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'text', 'limit'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId, text, and limit.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_NEEDLE_CHARS) {
      return { ok: false, error: `text must be a non-empty string of at most ${MAX_NEEDLE_CHARS} chars.` }
    }
    if (!optionalInteger(input.limit, 1, MAX_UI_FIND_LIMIT)) {
      return { ok: false, error: `limit must be an integer between 1 and ${MAX_UI_FIND_LIMIT}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input) || typeof input.text !== 'string') {
      throw new Error('Invalid ui_find arguments.')
    }
    const needle = input.text.trim()
    const tabId = await resolveUiTabId(
      environment,
      typeof input.tabId === 'string' ? input.tabId.trim() : undefined,
    )
    const response = await environment.browser.command({
      action: 'find',
      tabId,
      text: needle,
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    })
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (response.type !== 'found') {
      throw new Error(`浏览器返回了非检索结果：${response.type}`)
    }
    const lines = response.matches.length > 0 ? `\n${response.matches.join('\n')}` : ''
    const remaining = response.total - response.matches.length
    const tail = response.truncated && remaining > 0
      ? `\n\n[另有 ${remaining} 行未列出：换更具体的检索词，不要据此断定页面只有这些内容]`
      : ''
    const content = [
      `页面检索「${needle}」· ${response.title || '(无标题)'}`,
      `URL：${response.url}`,
      `命中 ${response.total} 行${response.matches.length > 0 ? `（列出前 ${response.matches.length} 行）` : ''}：${lines}${tail}`,
    ].join('\n')
    return {
      content,
      details: {
        tabId,
        url: response.url,
        title: response.title,
        total: response.total,
        listed: response.matches.length,
        truncated: response.truncated,
      },
    }
  },
})
