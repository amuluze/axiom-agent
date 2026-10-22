import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type { AgentEnvironment, UiLocatorSpec } from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject } from './workspaceToolUtils'
import {
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

interface UiClickInput {
  tabId?: string
  ref?: number
  locator?: UiLocatorSpec
}

const asClickInput = (input: JsonValue): UiClickInput => {
  if (!isJsonObject(input)) throw new Error('Invalid ui_click arguments.')
  return {
    ...(typeof input.tabId === 'string' ? { tabId: input.tabId } : {}),
    ...(typeof input.ref === 'number' ? { ref: input.ref } : {}),
    ...(isJsonObject(input.locator) ? { locator: toUiLocator(input.locator) } : {}),
  }
}

/**
 * `ui_click`：点击一个目标元素（G1-3）。宿主按下述顺序执行：按 ref 取边界盒
 * 中心 → 派发 mousePressed/mouseReleased（不执行页面 JS）。
 *
 * 目标二选一：`ref` 是宿主定位解析签发的 backend node ref（整数 ≥1），只在当前步骤内
 * 有效；`locator` 是结构化定位器，先经只读通道 `resolveLocator` 解析出**唯一**候选的
 * ref 再点击——零匹配或歧义直接报错，宿主不会「就近猜一个元素」也不会取第一个候选。
 * 因此写入 TestSpec 时用 `locator`（跨运行可重放），探索期可继续用瞬态 `ref`。
 */
export const createUiClickTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_click',
  label: 'ui_click',
  promptSnippet: '点击浏览器页面中的元素（locator 或 ref 二选一，写动作，逐次审批）。',
  promptGuidelines: [
    '这是写动作：会真实触发页面交互（跳转、提交、展开下拉、打开弹窗），需要用户逐次批准；只用于探索，不承担正式回归。',
    UI_WRITE_REF_STALENESS_RULE,
    '目标二选一：locator（结构化定位器，先解析出唯一候选再点击）或 ref（上一步解析签发的瞬态节点）。要固化进 TestSpec 时用 locator；locator 零匹配或歧义会直接报错，不会取第一个候选。',
    '点击的后果不可预知（提交表单、下单、删除）：目标元素语义不明时先用 ui_snapshot/ui_assert 确认它是什么，再决定是否点击。',
    '一次调用只点一个元素；点击后页面可能进入新状态，先用 ui_snapshot 观察结果，不要连续盲点。',
  ],
  runtimeVersion: '2',
  recoveryPolicy: 'idempotent',
  executionMode: 'sequential',
  invalidatesPageState: true,
  requiresApproval: true,
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'ui_click:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    return `ui_click:${tabId}:${await uiTargetKeyPart(input)}`
  },
  description:
    'Click the element identified by a structured locator or an element ref in one Browser Rail tab. '
    + 'tabId is optional and defaults to the active tab. Provide exactly one of locator or ref: locator '
    + 'is resolved through the read-only resolveLocator channel in this step and only a UNIQUE match is '
    + 'clicked (zero matches or an ambiguous locator return an error, never the first candidate); ref is '
    + 'an ephemeral backend node ref from an earlier resolution. The host clicks the center of the target '
    + 'bounding box through input domain events (no page script runs). This is a page-changing action '
    + 'requiring per-call user approval: the click may navigate, submit a form or open a dialog, and it '
    + 'invalidates every ref, snapshot and assertion verdict from earlier steps — re-snapshot before the '
    + 'next action. Use locator (not ref) when the step must survive into a TestSpec.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      ref: REF_INPUT_SCHEMA,
      locator: UI_LOCATOR_SCHEMA,
    },
    oneOf: [{ required: ['ref'] }, { required: ['locator'] }],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'ref', 'locator'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId, ref, and locator.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    const targetError = validateUiTargetSelection(input.ref, input.locator)
    if (targetError) return { ok: false, error: targetError }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const { tabId, ref, locator } = asClickInput(input)
    const target = locator ? `定位器 ${describeUiLocator(locator)}` : `ref=${ref}`
    return {
      title: locator
        ? `点击定位器 ${describeUiLocator(locator)} 的元素？`
        : `点击元素 ref=${ref}？`,
      description: `Axiom 将在隔离浏览器的${describeUiTab(tabId)}中点击 ${target} 所指元素的中心。`
        + '点击会真实触发页面交互（可能跳转、提交表单、打开弹窗），且点击后旧 ref 与快照全部作废。'
        + 'ref 只在本步骤内有效，请确认它指向的正是预期元素。',
    }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const { tabId: requestedTab, ref, locator } = asClickInput(input)
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const tabId = await resolveUiTabId(environment, requestedTab?.trim())
    const targetRef = locator ? await resolveUniqueUiRef(environment, tabId, locator) : ref
    if (targetRef === undefined) throw new Error('Invalid ui_click arguments.')
    expectUiWriteResponse(await environment.browser.write({ action: 'click', tabId, ref: targetRef }), 'done')
    const target = locator ? `${describeUiLocator(locator)}（解析为 ref=${targetRef}）` : `ref=${targetRef}`
    return {
      content: [
        `已点击${describeUiTab(tabId)}中 ${target} 的元素。`,
        UI_WRITE_AFTER_NOTE,
      ].join('\n'),
      details: { tabId, ref: targetRef, ...(locator ? { locator: uiLocatorJson(locator) } : {}), applied: true },
    }
  },
})
