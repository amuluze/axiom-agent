import { describe, expect, it } from 'vitest'
import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage } from '@/agent/core/types'
import type { SolidifyDraft, SolidifyOptions } from '@/agent/testing/spec/solidify'
import {
  buildSolidifyPayload,
  countDraftSteps,
  prepareSolidifyDraft,
  solidifySpecId,
} from './testSolidify'

const options: SolidifyOptions = { id: 'checkout', name: '结算流程', target: {} }

const draftWith = (issues: SolidifyDraft['issues']): SolidifyDraft => ({
  spec: {
    kind: 'axiom.test',
    version: 1,
    id: 'checkout',
    name: '结算流程',
    target: {},
    cases: [{
      id: 'main',
      name: '探索固化',
      steps: [
        { id: 'step-1-ui-navigate', action: 'ui.navigate', url: 'https://shop.test/' },
        { id: 'step-2-ui-click', action: 'ui.click', locator: { role: 'unknown', name: '待补充定位器' } },
      ],
    }],
  },
  issues,
})

const assistant = (toolCalls: Array<Partial<ToolCall>>, id = 'a1'): AssistantMessage => ({
  id,
  createdAt: 0,
  role: 'assistant',
  content: '',
  stopReason: 'tool_use',
  toolCalls: toolCalls.map((call) => ({
    id: 'call',
    name: 'ui_click',
    arguments: {},
    rawArguments: '{}',
    ...call,
  })),
})

const toolResult = (overrides: Partial<ToolResultMessage> & { toolCallId: string }): ToolResultMessage => ({
  id: `result-${overrides.toolCallId}`,
  createdAt: 0,
  role: 'tool',
  toolName: 'ui_click',
  content: '',
  isError: false,
  ...overrides,
})

describe('solidifySpecId', () => {
  it('slugifies ascii titles', () => {
    expect(solidifySpecId('Checkout Flow!', 'session-1')).toBe('checkout-flow')
  })

  it('falls back to a session-derived id for non-ascii titles', () => {
    expect(solidifySpecId('结算流程', 'session-ABCD-1234')).toBe('spec-session-abcd-1234')
  })

  it('falls back to a constant when nothing slug-safe remains', () => {
    expect(solidifySpecId('', '###')).toBe('explored-spec')
  })
})

describe('countDraftSteps', () => {
  it('sums steps across cases', () => {
    expect(countDraftSteps(draftWith([]))).toBe(2)
  })
})

describe('buildSolidifyPayload', () => {
  it('renders spec identity, step list, review entries and the write instruction', () => {
    const payload = buildSolidifyPayload(draftWith([{
      stepIndex: 1,
      toolName: 'ui_click',
      code: 'locator-unavailable',
      message: '需要补充稳定定位器',
    }]))

    expect(payload).toContain('Spec ID: checkout')
    expect(payload).toContain('名称: 结算流程')
    expect(payload).toContain('tests/checkout.testspec.json')
    expect(payload).toContain('- step-1-ui-navigate: ui.navigate · https://shop.test/')
    expect(payload).toContain('- #1 ui_click [locator-unavailable] 需要补充稳定定位器')
    expect(payload).toContain('用例数: 1 · 步骤数: 2 · 待人工确认: 1')
    expect(payload).toContain('调用 write 工具写入')
    expect(payload).toContain('"kind": "axiom.test"')
  })

  it('stays valid when there are no review issues', () => {
    const payload = buildSolidifyPayload(draftWith([]))
    expect(payload).toContain('待人工确认: 0')
    expect(payload).toContain('待人工确认步骤（needsReview）：\n- 无')
  })

  it('labels spec-level issues with the spec marker', () => {
    const payload = buildSolidifyPayload(draftWith([{
      stepIndex: -1,
      toolName: 'spec',
      code: 'compile-failed',
      message: '/cases/0: 缺少 target',
    }]))
    expect(payload).toContain('- spec spec [compile-failed] /cases/0: 缺少 target')
  })

  it('is deterministic for the same draft', () => {
    const draft = draftWith([])
    expect(buildSolidifyPayload(draft)).toBe(buildSolidifyPayload(draft))
  })

  it('honours an explicit spec path', () => {
    expect(buildSolidifyPayload(draftWith([]), { specPath: 'tests/custom.testspec.json' }))
      .toContain('目标文件: tests/custom.testspec.json')
  })

  it('labels the actual protocol version and requires test point traceability', () => {
    const draft = draftWith([])
    draft.spec.version = 2
    const payload = buildSolidifyPayload(draft)
    expect(payload).toContain('草稿 Spec（v2，尚缺 testPoints/verifies，按第 3 条补齐后才是合法文件）')
    expect(payload).toContain('testPoints[]')
    expect(payload).toContain('verifies')
  })
})

describe('prepareSolidifyDraft', () => {
  it('reports an empty trajectory without throwing', async () => {
    await expect(prepareSolidifyDraft([], options)).resolves.toEqual({
      status: 'empty-trajectory',
      stepCount: 0,
    })
  })

  it('reports no-explorer-steps when the session used no exploration tool', async () => {
    const messages: AgentMessage[] = [
      assistant([{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }]),
      toolResult({ toolCallId: 'c1', toolName: 'read', content: 'file' }),
    ]
    await expect(prepareSolidifyDraft(messages, options)).resolves.toEqual({
      status: 'no-explorer-steps',
      stepCount: 0,
    })
  })

  it('builds a draft from a valid exploration trajectory', async () => {
    const messages: AgentMessage[] = [
      assistant([{ id: 'c1', name: 'ui_navigate', arguments: { url: 'https://shop.test/' } }]),
      toolResult({ toolCallId: 'c1', toolName: 'ui_navigate', content: 'ok' }),
    ]
    const result = await prepareSolidifyDraft(messages, options)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.stepCount).toBe(1)
    expect(result.draft.spec.id).toBe('checkout')
    expect(result.draft.spec.cases[0]?.steps[0]).toEqual({
      id: 'step-1-ui-navigate',
      action: 'ui.navigate',
      url: 'https://shop.test/',
    })
  })
})
