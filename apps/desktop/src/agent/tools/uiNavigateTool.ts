import type { AgentTool, AgentToolResult } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject, sha256Text } from './workspaceToolUtils'
import {
  TAB_ID_INPUT,
  UI_WRITE_AFTER_NOTE,
  UI_WRITE_REF_STALENESS_RULE,
  describeUiTab,
  expectUiWriteResponse,
  resolveUiTabId,
  validateUiUrl,
} from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200

/**
 * `ui_navigate`：把标签页导航到指定 URL（G1-3 写探索工具之一）。
 *
 * 与只读工具的分界：本工具经 `browser.write`（`ui-test:write` 门控）发出写动作，
 * 页面会真实离开当前文档。`requiresApproval` 意味着每个 URL 都要用户逐次批准——
 * 导航可能携带当前登录态离开站点，且未提交的表单内容会丢失，故不提供「批量导航」。
 */
export const createUiNavigateTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_navigate',
  label: 'ui_navigate',
  promptSnippet: '把浏览器标签页导航到指定 URL（写动作，逐次审批）。',
  promptGuidelines: [
    '这是写动作：会真实改变页面所处的文档，需要用户逐次批准；只用于探索，不承担正式回归（固化为可重放测试请用稳定定位写测试文件）。',
    UI_WRITE_REF_STALENESS_RULE,
    '只接受绝对 http/https URL：file:/javascript:/data: 等协议与带 userinfo 凭据的 URL 由宿主权威拒绝，不要尝试变形绕过。',
    '导航会离开当前页面（未提交的表单内容可能丢失）——先确认用户确实要跳转，不要把它当只读检查用；跳转后用 ui_wait 等目标页面就绪再继续。',
  ],
  runtimeVersion: '1',
  recoveryPolicy: 'idempotent',
  executionMode: 'sequential',
  invalidatesPageState: true,
  requiresApproval: true,
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'ui_navigate:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    const url = typeof input.url === 'string' ? input.url : ''
    // URL 可长到 2048 字符，明文进键会顶穿 512 bytes 上限（工具调用会直接失败）：
    // 这里只保留内容摘要，既保幂等语义又不把 URL 明文写进审计键。
    return `ui_navigate:${tabId}:${await sha256Text(url)}`
  },
  description:
    'Navigate one Browser Rail tab to an http/https URL. tabId is optional and defaults to the active '
    + 'tab. The host re-validates the URL (absolute http/https, no userinfo credentials, length cap) and '
    + 'returns the resolved url plus page title. This is a page-changing action: it requires per-call '
    + 'user approval, it can leave the current site with the current session, and it invalidates every '
    + 'ref, snapshot and assertion verdict from earlier steps — re-snapshot before the next action.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      url: {
        type: 'string',
        minLength: 1,
        description: 'Absolute http/https URL to open. Only http and https are accepted.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'url'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId and url.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    const urlError = validateUiUrl(input.url)
    if (urlError) return { ok: false, error: urlError }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    if (!isJsonObject(input) || typeof input.url !== 'string') {
      throw new Error('Invalid ui_navigate arguments.')
    }
    const tabId = typeof input.tabId === 'string' ? input.tabId : undefined
    return {
      title: `导航到 ${input.url}？`,
      description: `Axiom 将在隔离浏览器的${describeUiTab(tabId)}中打开该 URL（宿主会重新校验：仅 http/https、`
        + '不得携带凭据）。导航会离开当前页面，未提交的表单内容可能丢失，导航后旧 ref 与快照全部作废。',
    }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input) || typeof input.url !== 'string') {
      throw new Error('Invalid ui_navigate arguments.')
    }
    const url = input.url
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const tabId = await resolveUiTabId(
      environment,
      typeof input.tabId === 'string' ? input.tabId.trim() : undefined,
    )
    const response = expectUiWriteResponse(
      await environment.browser.write({ action: 'navigate', tabId, url }),
      'navigated',
    )
    return {
      content: [
        `已在${describeUiTab(tabId)}导航到 ${response.url}`,
        `页面标题：${response.title || '(无标题)'}`,
        UI_WRITE_AFTER_NOTE,
      ].join('\n'),
      details: { tabId, url: response.url, title: response.title },
    }
  },
})
