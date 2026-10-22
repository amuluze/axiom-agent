import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject } from './workspaceToolUtils'
import {
  MIN_UI_REF,
  TAB_ID_INPUT,
  UI_KEY_INPUT_SCHEMA,
  UI_WRITE_AFTER_NOTE,
  UI_WRITE_REF_STALENESS_RULE,
  describeUiTab,
  expectUiWriteResponse,
  resolveUiTabId,
  validateUiKey,
  validateUiRef,
} from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200

interface UiPressInput {
  tabId?: string
  key: string
  ref?: number
}

const asPressInput = (input: JsonValue): UiPressInput => {
  if (!isJsonObject(input) || typeof input.key !== 'string') {
    throw new Error('Invalid ui_press arguments.')
  }
  return {
    ...(typeof input.tabId === 'string' ? { tabId: input.tabId } : {}),
    ...(typeof input.ref === 'number' ? { ref: input.ref } : {}),
    key: input.key,
  }
}

/**
 * `ui_press`：向页面（或先聚焦到 ref 元素）派发一次按键（G1-3）。
 *
 * 与 `ui_input` 的分工：`ui_input` 用 Input 域原语整体写值（不经过键盘），本工具走真实
 * 键事件——用于 Enter 提交、Tab 移焦、Escape 关弹窗、方向键在列表/下拉中移动等
 * **键盘驱动**的交互。省略 ref 时按键发给当前焦点元素，因此通常先 ui_click/聚焦。
 */
export const createUiPressTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_press',
  label: 'ui_press',
  promptSnippet: '向页面派发按键（可选先聚焦到 ref 元素；写动作，逐次审批）。',
  promptGuidelines: [
    '这是写动作：按键会真实触发页面行为（Enter 可能提交、Escape 可能关闭弹窗），需要用户逐次批准；只用于探索，不承担正式回归。',
    UI_WRITE_REF_STALENESS_RULE,
    '本工具只支持白名单按键（Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space 或单个字符）：组合键（ctrl+a 等）不在白名单内，宿主会拒绝。',
    '按键发给当前焦点元素；需要指定目标时传 ref（宿主先聚焦再按键），否则先用 ui_click 把焦点放对位置。',
    '按键的后果取决于焦点所在控件，不要连按试探：每次按键后用 ui_snapshot 观察页面状态再决定下一步。',
  ],
  runtimeVersion: '1',
  recoveryPolicy: 'idempotent',
  executionMode: 'sequential',
  invalidatesPageState: true,
  requiresApproval: true,
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'ui_press:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    const key = typeof input.key === 'string' ? input.key : ''
    const ref = typeof input.ref === 'number' ? String(input.ref) : ''
    return `ui_press:${tabId}:${ref}:${key}`
  },
  description:
    'Press one keyboard key in a Browser Rail tab, optionally focusing an element ref first. tabId is '
    + 'optional and defaults to the active tab. Only the host key whitelist is accepted (Enter/Tab/'
    + 'Escape/Backspace/Delete/Arrow keys/Home/End/PageUp/PageDown/Space or a single character); '
    + 'modifier combinations such as ctrl+a are refused. Without ref the key is delivered to the currently '
    + 'focused element. This is a page-changing action requiring per-call user approval; it invalidates '
    + 'every ref, snapshot and assertion verdict from earlier steps.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      key: UI_KEY_INPUT_SCHEMA,
      ref: {
        type: 'integer',
        minimum: MIN_UI_REF,
        description:
          'Optional element ref to focus before pressing (from a locator resolution in this step). '
          + 'Omit to send the key to the currently focused element.',
      },
    },
    required: ['key'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'key', 'ref'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId, key, and ref.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    const keyError = validateUiKey(input.key)
    if (keyError) return { ok: false, error: keyError }
    const refError = validateUiRef(input.ref)
    if (refError) return { ok: false, error: refError }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const { tabId, key, ref } = asPressInput(input)
    return {
      title: `按下 ${key}${ref === undefined ? '' : `（先聚焦 ref=${ref}）`}？`,
      description: `Axiom 将在隔离浏览器的${describeUiTab(tabId)}中${ref === undefined ? '向当前焦点元素' : `先聚焦 ref=${ref} 再`}`
        + `派发按键 ${key}。按键会真实触发页面行为（可能提交表单或关闭弹窗），并作废该步骤之前的 ref 与快照。`,
    }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const { tabId: requestedTab, key, ref } = asPressInput(input)
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const tabId = await resolveUiTabId(environment, requestedTab?.trim())
    expectUiWriteResponse(
      await environment.browser.write({ action: 'press', tabId, key, ...(ref === undefined ? {} : { ref }) }),
      'done',
    )
    return {
      content: [
        `已在${describeUiTab(tabId)}中按下 ${key}${ref === undefined ? '' : `（先聚焦 ref=${ref}）`}。`,
        UI_WRITE_AFTER_NOTE,
      ].join('\n'),
      details: { tabId, key, ref: ref ?? null, applied: true },
    }
  },
})
