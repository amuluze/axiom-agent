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

interface UiSelectInput {
  tabId?: string
  ref?: number
  locator?: UiLocatorSpec
  text: string
}

const asSelectInput = (input: JsonValue): UiSelectInput => {
  if (!isJsonObject(input) || typeof input.text !== 'string') {
    throw new Error('Invalid ui_select arguments.')
  }
  return {
    ...(typeof input.tabId === 'string' ? { tabId: input.tabId } : {}),
    ...(typeof input.ref === 'number' ? { ref: input.ref } : {}),
    ...(isJsonObject(input.locator) ? { locator: toUiLocator(input.locator) } : {}),
    text: input.text,
  }
}

/**
 * `ui_select`：选中目标下拉控件中的一个选项（映射宿主 `selectOption`）。
 *
 * 目标二选一：`locator` 先经只读通道 `resolveLocator` 解析出**唯一**候选的 ref 再选择
 * （零匹配/歧义直接报错，不取第一个候选），`ref` 沿用瞬态节点形式。写成 TestSpec 时用
 * `locator`（跨运行可重放）。
 *
 * 宿主按选项的可见文本做 type-ahead 匹配，并**自校验**：回读该 ref 节点的 AX 值，
 * 与目标文本双向包含才算命中，否则以可读错误返回。因此「调用成功」意味着选项确实
 * 被选中，而不只是键事件发出去了；未命中时宿主不猜，报错由模型决定下一步。
 */
export const createUiSelectTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_select',
  label: 'ui_select',
  promptSnippet: '在下拉控件中选中一个选项（locator 或 ref 二选一，写动作，逐次审批）。',
  promptGuidelines: [
    '这是写动作：会真实改变表单选中项（可能触发联动或校验），需要用户逐次批准；只用于探索，不承担正式回归。',
    UI_WRITE_REF_STALENESS_RULE,
    '目标二选一：locator（结构化定位器，先解析出唯一候选再选择）或 ref（上一步解析签发的瞬态节点）。要固化进 TestSpec 时用 locator；locator 零匹配或歧义会直接报错，不会取第一个候选。',
    'text 是选项的**可见文本**（不是 value 属性）：先 ui_snapshot 确认选项的确切文案，命中失败时宿主会回读当前选中项并报错，据此换文案重试而不是盲改。',
    '宿主已自校验选中结果：返回成功即该 ref 的 AX 值已与目标文本匹配，无需再用 ui_assert 复核同一事实。',
  ],
  runtimeVersion: '2',
  recoveryPolicy: 'idempotent',
  executionMode: 'sequential',
  invalidatesPageState: true,
  requiresApproval: true,
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'ui_select:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    const digest = typeof input.text === 'string' ? await sha256Text(input.text) : ''
    return `ui_select:${tabId}:${await uiTargetKeyPart(input)}:${digest}`
  },
  description:
    'Select an option in the dropdown identified by a structured locator or an element ref (host action: '
    + 'selectOption). tabId is optional and defaults to the active tab. Provide exactly one of locator or '
    + 'ref: locator is resolved through the read-only resolveLocator channel in this step and only a UNIQUE '
    + 'match is used (zero matches or an ambiguous locator return an error, never the first candidate); ref '
    + 'is an ephemeral backend node ref from an earlier resolution. text is the option VISIBLE TEXT, not its '
    + 'value attribute. The host matches it through type-ahead and then reads back the AX value of the ref '
    + 'node, so a successful call means the option really got selected; a mismatch returns a readable error '
    + 'instead of guessing. This is a page-changing action requiring per-call user approval and it '
    + 'invalidates every ref, snapshot and assertion verdict from earlier steps. Use locator (not ref) when '
    + 'the step must survive into a TestSpec.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      ref: REF_INPUT_SCHEMA,
      locator: UI_LOCATOR_SCHEMA,
      text: {
        type: 'string',
        minLength: 1,
        description: `Visible text of the option to select. Non-empty, at most ${MAX_UI_INPUT_CHARS} chars.`,
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
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_UI_INPUT_CHARS) {
      return { ok: false, error: `text must be a non-empty string of at most ${MAX_UI_INPUT_CHARS} chars.` }
    }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const { tabId, ref, locator, text } = asSelectInput(input)
    const target = locator ? `定位器 ${describeUiLocator(locator)}` : `ref=${ref}`
    return {
      title: locator
        ? `在定位器 ${describeUiLocator(locator)} 的下拉控件中选中「${text.trim()}」？`
        : `在 ref=${ref} 中选中「${text.trim()}」？`,
      description: `Axiom 将在隔离浏览器的${describeUiTab(tabId)}中对 ${target} 的下拉控件按可见文本「${text.trim()}」`
        + '选择选项，并回读该节点确认选中结果。选择会真实改变表单状态，并作废该步骤之前的 ref 与快照。',
    }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const { tabId: requestedTab, ref, locator, text } = asSelectInput(input)
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const tabId = await resolveUiTabId(environment, requestedTab?.trim())
    const targetRef = locator ? await resolveUniqueUiRef(environment, tabId, locator) : ref
    if (targetRef === undefined) throw new Error('Invalid ui_select arguments.')
    expectUiWriteResponse(
      await environment.browser.write({ action: 'selectOption', tabId, ref: targetRef, text }),
      'done',
    )
    const target = locator ? `${describeUiLocator(locator)}（解析为 ref=${targetRef}）` : `ref=${targetRef}`
    return {
      content: [
        `已在${describeUiTab(tabId)}中把 ${target} 的选中项切换为「${text.trim()}」（宿主已回读该节点确认）。`,
        UI_WRITE_AFTER_NOTE,
      ].join('\n'),
      details: { tabId, ref: targetRef, ...(locator ? { locator: uiLocatorJson(locator) } : {}), option: text.trim(), applied: true },
    }
  },
})
