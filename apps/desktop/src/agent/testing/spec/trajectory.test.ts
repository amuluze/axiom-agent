import { describe, expect, it } from 'vitest'
import { extractExplorerSteps, extractWrittenSpecFiles, isExplorerToolName, normalizeSpecPath } from './trajectory'
import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage } from '../../core/types'

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

describe('isExplorerToolName', () => {
  it('accepts every exploration tool and rejects read-only helpers', () => {
    expect(isExplorerToolName('ui_navigate')).toBe(true)
    expect(isExplorerToolName('api_request')).toBe(true)
    expect(isExplorerToolName('ui_snapshot')).toBe(false)
    expect(isExplorerToolName('read')).toBe(false)
  })
})

describe('extractExplorerSteps', () => {
  it('keeps exploration calls in order and pairs results by toolCallId', () => {
    const messages: AgentMessage[] = [
      assistant([
        { id: 'c1', name: 'ui_navigate', arguments: { url: 'https://shop.test/' } },
        { id: 'c2', name: 'read', arguments: { path: 'a.ts' } },
        { id: 'c3', name: 'ui_click', arguments: { ref: 7 } },
      ]),
      toolResult({ toolCallId: 'c1', toolName: 'ui_navigate', content: 'ok',
        details: { url: 'https://shop.test/', title: 'Shop' } }),
      toolResult({ toolCallId: 'c2', toolName: 'read', content: 'file contents' }),
      toolResult({ toolCallId: 'c3', toolName: 'ui_click', content: 'clicked', details: { applied: true } }),
    ]

    const steps = extractExplorerSteps(messages)

    expect(steps.map((step) => step.toolName)).toEqual(['ui_navigate', 'ui_click'])
    expect(steps[0]?.input).toEqual({ url: 'https://shop.test/' })
    expect(steps[0]?.result?.details).toEqual({ url: 'https://shop.test/', title: 'Shop' })
    expect(steps[0]?.result?.isError).toBe(false)
    expect(steps[1]?.toolCallId).toBe('c3')
    expect(steps[1]?.result?.content).toBe('clicked')
  })

  it('leaves a truncated call without a paired result', () => {
    const steps = extractExplorerSteps([
      assistant([
        { id: 'c1', name: 'ui_wait', arguments: { durationMs: 500 } },
        { id: 'c2', name: 'ui_press', arguments: { key: 'Enter' } },
      ]),
      toolResult({ toolCallId: 'c1', toolName: 'ui_wait', content: 'waited' }),
    ])

    expect(steps).toHaveLength(2)
    expect(steps[0]?.result).toBeDefined()
    expect(steps[1]?.result).toBeUndefined()
  })

  it('ignores results that do not match any exploration call', () => {
    const steps = extractExplorerSteps([
      toolResult({ toolCallId: 'orphan', toolName: 'ui_click', content: 'cliked' }),
      assistant([{ id: 'c1', name: 'ui_assert', arguments: { expect: { exists: true } } }]),
    ])

    expect(steps).toHaveLength(1)
    expect(steps[0]?.toolCallId).toBe('c1')
    expect(steps[0]?.result).toBeUndefined()
  })

  it('records the error flag from a failed result', () => {
    const steps = extractExplorerSteps([
      assistant([{ id: 'c1', name: 'ui_input', arguments: { ref: 3, text: 'x' } }]),
      toolResult({ toolCallId: 'c1', toolName: 'ui_input', content: 'boom', isError: true }),
    ])

    expect(steps[0]?.result?.isError).toBe(true)
  })

  it('keeps the first result when the same call id resolves twice', () => {
    const steps = extractExplorerSteps([
      assistant([{ id: 'c1', name: 'ui_screenshot', arguments: {} }]),
      toolResult({ toolCallId: 'c1', toolName: 'ui_screenshot', content: 'first' }),
      toolResult({ toolCallId: 'c1', toolName: 'ui_screenshot', content: 'second' }),
    ])

    expect(steps).toHaveLength(1)
    expect(steps[0]?.result?.content).toBe('first')
  })

  it('is robust to malformed assistant message shapes', () => {
    const malformed = [
      { id: 'a1', createdAt: 0, role: 'assistant', content: '', stopReason: 'stop' },
      { id: 'u1', createdAt: 0, role: 'user', content: 'hello' },
    ] as unknown as AgentMessage[]

    expect(extractExplorerSteps(malformed)).toEqual([])
  })
})

describe('normalizeSpecPath', () => {
  it('accepts workspace-relative and absolute case paths, rejects everything else', () => {
    expect(normalizeSpecPath('tests/a.testspec.json')).toBe('tests/a.testspec.json')
    expect(normalizeSpecPath('tests/nested/deep/b.testspec.json')).toBe('tests/nested/deep/b.testspec.json')
    expect(normalizeSpecPath('/Users/me/repo/tests/c.testspec.json')).toBe('tests/c.testspec.json')
    expect(normalizeSpecPath(' tests/d.testspec.json ')).toBe('tests/d.testspec.json')

    // 只认用例文件：其它 .ax（设计稿 / 环境档）与产品源码都不算用例产物。
    expect(normalizeSpecPath('tests/notes.ax')).toBeNull()
    expect(normalizeSpecPath('tests/environments/a.env.ax')).toBeNull()
    expect(normalizeSpecPath('.pen/page.ax')).toBeNull()
    expect(normalizeSpecPath('src/foo.ts')).toBeNull()
    expect(normalizeSpecPath('tests/')).toBeNull()
    expect(normalizeSpecPath('')).toBeNull()
  })
})

describe('extractWrittenSpecFiles', () => {
  it('records successful writes to case files and ignores other paths', () => {
    const messages: AgentMessage[] = [
      assistant([
        { id: 'w1', name: 'write', arguments: { path: 'tests/checkout.testspec.json', content: '{}' } },
        { id: 'w2', name: 'write', arguments: { path: 'src/checkout.ts', content: 'export {}' } },
        { id: 'r1', name: 'read', arguments: { path: 'tests/other.testspec.json' } },
      ]),
      toolResult({ toolCallId: 'w1', toolName: 'write' }),
      toolResult({ toolCallId: 'w2', toolName: 'write' }),
      toolResult({ toolCallId: 'r1', toolName: 'read' }),
    ]

    expect(extractWrittenSpecFiles(messages)).toEqual([
      { path: 'tests/checkout.testspec.json', toolName: 'write', isError: false },
    ])
  })

  it('normalises absolute paths and covers apply_changes moves on both ends', () => {
    const messages: AgentMessage[] = [
      assistant([
        { id: 'e1', name: 'edit', arguments: { path: '/repo/tests/edited.testspec.json', edits: [] } },
        {
          id: 'a1',
          name: 'apply_changes',
          arguments: {
            changes: [
              { type: 'create-file', path: 'tests/created.testspec.json', content: '{}' },
              { type: 'move', from: 'tests/old.testspec.json', to: 'tests/new.testspec.json' },
              { type: 'create-file', path: 'src/nope.ts', content: '' },
            ],
          },
        },
      ]),
      toolResult({ toolCallId: 'e1', toolName: 'edit' }),
      toolResult({ toolCallId: 'a1', toolName: 'apply_changes' }),
    ]

    expect(extractWrittenSpecFiles(messages).map((file) => file.path)).toEqual([
      'tests/edited.testspec.json',
      'tests/created.testspec.json',
      'tests/old.testspec.json',
      'tests/new.testspec.json',
    ])
  })

  it('treats a path as produced once any write succeeded', () => {
    const messages: AgentMessage[] = [
      assistant([
        { id: 'f1', name: 'write', arguments: { path: 'tests/retry.testspec.json', content: '{}' } },
        { id: 'f2', name: 'write', arguments: { path: 'tests/retry.testspec.json', content: '{}' } },
        { id: 'f3', name: 'write', arguments: { path: 'tests/failed.testspec.json', content: '{}' } },
      ]),
      toolResult({ toolCallId: 'f1', toolName: 'write', isError: true, content: '审批被拒绝' }),
      toolResult({ toolCallId: 'f2', toolName: 'write' }),
      toolResult({ toolCallId: 'f3', toolName: 'write', isError: true, content: '路径已存在' }),
    ]

    expect(extractWrittenSpecFiles(messages)).toEqual([
      { path: 'tests/retry.testspec.json', toolName: 'write', isError: false },
      { path: 'tests/failed.testspec.json', toolName: 'write', isError: true },
    ])
  })

  it('keeps unpaired writes as undefined and never throws on malformed arguments', () => {
    const messages: AgentMessage[] = [
      assistant([
        { id: 'p1', name: 'write', arguments: { path: 'tests/unpaired.testspec.json', content: '{}' } },
        { id: 'p2', name: 'write', arguments: 'not-an-object' },
        { id: 'p3', name: 'apply_changes', arguments: { changes: 'not-an-array' } },
      ]),
    ]

    expect(extractWrittenSpecFiles(messages)).toEqual([
      { path: 'tests/unpaired.testspec.json', toolName: 'write', isError: undefined },
    ])
  })
})
