import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type { AgentEnvironment, UiLocatorSpec } from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject, sha256Text } from './workspaceToolUtils'
import {
  MAX_UI_INPUT_CHARS,
  REF_INPUT_SCHEMA,
  TAB_ID_INPUT,
  UI_LOCATOR_SCHEMA,
  UI_WRITE_AFTER_NOTE,
  UI_WRITE_REF_STALENESS_RULE,
  describeUiLocator,
  describeUiTab,
  expectUiWriteResponse,
  resolveUiTabId,
  resolveUniqueUiRef,
  toUiLocator,
  uiLocatorJson,
  uiTargetKeyPart,
  validateUiTargetSelection,
} from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200

interface UiInputInput {
  tabId?: string
  ref?: number
  locator?: UiLocatorSpec
  text: string
}

const asInputInput = (input: JsonValue): UiInputInput => {
  if (!isJsonObject(input) || typeof input.text !== 'string') {
    throw new Error('Invalid ui_input arguments.')
  }
  return {
    ...(typeof input.tabId === 'string' ? { tabId: input.tabId } : {}),
    ...(typeof input.ref === 'number' ? { ref: input.ref } : {}),
    ...(isJsonObject(input.locator) ? { locator: toUiLocator(input.locator) } : {}),
    text: input.text,
  }
}

/**
 * `ui_input`：把文本写进目标输入控件（映射宿主 `fill`）。
 *
 * 目标二选一：`locator` 先经只读通道 `resolveLocator` 解析出**唯一**候选的 ref 再写入
 * （零匹配/歧义直接报错，不取第一个候选），`ref` 沿用瞬态节点形式。写成 TestSpec 时用
 * `locator`（跨运行可重放）。
 *
 * `fill` 的语义是**替换**：宿主先全选 + Backspace 清空既有内容（Input 域原语，不执行
 * 页面 JS），再 `Input.insertText` 提交文本。因此空字符串表示「清空该字段」，
 * 而不是「什么都不做」——增量输入应由模型把完整目标值一次给全。
 */
export const createUiInputTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_input',
  label: 'ui_input',
  promptSnippet: '向浏览器页面的输入控件写入文本（locator 或 ref 二选一，写动作，逐次审批）。',
  promptGuidelines: [
    '这是写动作：会真实改变表单内容（可能触发校验或提交副作用），需要用户逐次批准；只用于探索，不承担正式回归。',
    UI_WRITE_REF_STALENESS_RULE,
    '目标二选一：locator（结构化定位器，先解析出唯一候选再写入）或 ref（上一步解析签发的瞬态节点）。要固化进 TestSpec 时用 locator；locator 零匹配或歧义会直接报错，不会取第一个候选。',
    'text 是**完整目标值**而不是增量：宿主会先清空该控件的既有内容再写入，空字符串即清空字段。',
    '不要用本工具提交机密：text 会进入会话记录与审计；需要凭据时让用户自己输入，或改用不经模型的宿主通道。',
    '写入后用 ui_snapshot/ui_assert 确认控件值（AX value）是否符合预期，不要凭「调用成功」推断表单状态。',
  ],
  runtimeVersion: '2',
  recoveryPolicy: 'idempotent',
  executionMode: 'sequential',
  invalidatesPageState: true,
  requiresApproval: true,
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'ui_input:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    // 文本用内容摘要而不是明文或长度：长度相同但内容不同的调用必须区分（否则崩溃恢复
    // 会把「另一个输入」当成同一次调用跳过），同时避免把用户文本落进审计键。
    const digest = typeof input.text === 'string' ? await sha256Text(input.text) : ''
    return `ui_input:${tabId}:${await uiTargetKeyPart(input)}:${digest}`
  },
  description:
    'Type text into the input control identified by a structured locator or an element ref (host action: '
    + 'fill). tabId is optional and defaults to the active tab. Provide exactly one of locator or ref: '
    + 'locator is resolved through the read-only resolveLocator channel in this step and only a UNIQUE '
    + 'match is filled (zero matches or an ambiguous locator return an error, never the first candidate); '
    + 'ref is an ephemeral backend node ref from an earlier resolution. fill REPLACES the existing value: '
    + 'the host selects all, deletes, then inserts the given text through input domain primitives without '
    + 'running page scripts, so text is the complete target value and an empty string clears the field. '
    + 'This is a page-changing action requiring per-call user approval; it invalidates every ref, snapshot '
    + 'and assertion verdict from earlier steps. Use locator (not ref) when the step must survive into a '
    + 'TestSpec.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      ref: REF_INPUT_SCHEMA,
      locator: UI_LOCATOR_SCHEMA,
      text: {
        type: 'string',
        description:
          'Complete value to write (the field is cleared first). Empty string clears the field. '
          + `At most ${MAX_UI_INPUT_CHARS} chars.`,
      },
    },
    oneOf: [
      { required: ['ref', 'text'] },
      { required: ['locator', 'text'] },
    ],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'ref', 'locator', 'text'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId, ref, locator, and text.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    const targetError = validateUiTargetSelection(input.ref, input.locator)
    if (targetError) return { ok: false, error: targetError }
    if (typeof input.text !== 'string' || input.text.length > MAX_UI_INPUT_CHARS) {
      return { ok: false, error: `text must be a string of at most ${MAX_UI_INPUT_CHARS} chars (empty string clears the field).` }
    }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const { tabId, ref, locator, text } = asInputInput(input)
    const target = locator ? `定位器 ${describeUiLocator(locator)}` : `ref=${ref}`
    return {
      title: locator
        ? `向定位器 ${describeUiLocator(locator)} 的控件写入 ${[...text].length} 个字符？`
        : `向元素 ref=${ref} 写入 ${[...text].length} 个字符？`,
      description: `Axiom 将在隔离浏览器的${describeUiTab(tabId)}中清空 ${target} 控件的既有内容并写入 ${[...text].length} 个字符`
        + '（不展示文本原文）。写入会真实改变表单内容，并作废该步骤之前的 ref 与快照。',
    }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const { tabId: requestedTab, ref, locator, text } = asInputInput(input)
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const tabId = await resolveUiTabId(environment, requestedTab?.trim())
    const targetRef = locator ? await resolveUniqueUiRef(environment, tabId, locator) : ref
    if (targetRef === undefined) throw new Error('Invalid ui_input arguments.')
    expectUiWriteResponse(
      await environment.browser.write({ action: 'fill', tabId, ref: targetRef, text }),
      'done',
    )
    const target = locator ? `${describeUiLocator(locator)}（解析为 ref=${targetRef}）` : `ref=${targetRef}`
    return {
      content: [
        `已向${describeUiTab(tabId)}中 ${target} 的控件写入 ${[...text].length} 个字符（覆盖原有内容${text ? '' : '：字段已清空'}）。`,
        UI_WRITE_AFTER_NOTE,
      ].join('\n'),
      details: { tabId, ref: targetRef, ...(locator ? { locator: uiLocatorJson(locator) } : {}), chars: [...text].length, applied: true },
    }
  },
})
