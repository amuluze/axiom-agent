import { describe, expect, it } from 'vitest'
import type { AgentContext, AgentMessage, AgentTool } from './types'
import { runtimeToolsSnapshot, sameRuntimeValue, validatedMessages } from './messageValidation'

const user = (overrides: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 'u1',
  role: 'user',
  content: 'hello',
  createdAt: 1,
  ...overrides,
} as AgentMessage)

const assistant = (overrides: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 'a1',
  role: 'assistant',
  content: '',
  createdAt: 2,
  toolCalls: [],
  stopReason: 'stop',
  ...overrides,
} as AgentMessage)

const toolMessage = (overrides: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 't1',
  role: 'tool',
  content: 'ok',
  createdAt: 3,
  toolCallId: 'call-1',
  toolName: 'read',
  isError: false,
  ...overrides,
} as AgentMessage)

const custom = (overrides: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 'c1',
  role: 'custom',
  content: 'note',
  createdAt: 4,
  customType: 'notice',
  ...overrides,
} as AgentMessage)

const tool = (name: string): AgentTool => ({ name } as unknown as AgentTool)

const contextWith = (tools: AgentTool[], activeToolNames?: string[]): AgentContext => ({
  sessionId: 'session',
  systemPrompt: '',
  model: { provider: 'p', model: 'm' },
  messages: [],
  tools,
  activeToolNames,
} as AgentContext)

describe('validatedMessages', () => {
  it('accepts the four message roles and returns an isolated snapshot', () => {
    const input = [user(), assistant(), toolMessage(), custom()]
    const result = validatedMessages(input, 'test')

    expect(result.map((message) => message.id)).toEqual(['u1', 'a1', 't1', 'c1'])
    expect(result).not.toBe(input)
    expect(result[0]).not.toBe(input[0])
    input[0].content = 'mutated'
    expect(result[0].content).toBe('hello')
  })

  it('rejects non-arrays and malformed message shapes', () => {
    expect(() => validatedMessages(null as unknown as AgentMessage[], 'prompts'))
      .toThrow('prompts 必须是消息数组')
    expect(() => validatedMessages([{ ...user(), id: '' }], 'prompts'))
      .toThrow('prompts 包含格式无效的消息')
    expect(() => validatedMessages([{ ...user(), createdAt: Number.NaN }], 'prompts'))
      .toThrow('prompts 包含格式无效的消息')
    expect(() => validatedMessages([{ ...user(), role: 'system' } as unknown as AgentMessage], 'prompts'))
      .toThrow('prompts 包含格式无效的消息')
    expect(() => validatedMessages([{ ...user(), content: 42 } as unknown as AgentMessage], 'prompts'))
      .toThrow('prompts 包含格式无效的消息')
  })

  it('rejects role-specific fields that are missing or invalid', () => {
    expect(() => validatedMessages([{ ...assistant(), toolCalls: undefined } as unknown as AgentMessage], 'prompts'))
      .toThrow('prompts 包含角色字段无效的消息')
    expect(() => validatedMessages([{ ...assistant(), stopReason: 'unknown' } as unknown as AgentMessage], 'prompts'))
      .toThrow('prompts 包含角色字段无效的消息')
    expect(() => validatedMessages([{ ...toolMessage(), isError: 'no' } as unknown as AgentMessage], 'prompts'))
      .toThrow('prompts 包含角色字段无效的消息')
    expect(() => validatedMessages([{ ...toolMessage(), toolCallId: undefined } as unknown as AgentMessage], 'prompts'))
      .toThrow('prompts 包含角色字段无效的消息')
    expect(() => validatedMessages([{ ...custom(), customType: undefined } as unknown as AgentMessage], 'prompts'))
      .toThrow('prompts 包含角色字段无效的消息')
  })

  it('rejects duplicate ids within the batch and against existing ids', () => {
    expect(() => validatedMessages([user(), user()], 'prompts'))
      .toThrow('prompts 包含重复消息 ID：u1')
    expect(() => validatedMessages([user()], 'prompts', new Set(['u1'])))
      .toThrow('prompts 包含重复消息 ID：u1')
  })
})

describe('sameRuntimeValue', () => {
  it('ignores object key order', () => {
    expect(sameRuntimeValue(
      { provider: 'p', model: 'm' },
      { model: 'm', provider: 'p' },
    )).toBe(true)
    expect(sameRuntimeValue(
      { provider: 'p', reasoning: { effort: 'high', budget: 1 } },
      { reasoning: { budget: 1, effort: 'high' }, provider: 'p' },
    )).toBe(true)
  })

  it('compares primitives strictly instead of through JSON coercion', () => {
    expect(sameRuntimeValue(0, '0')).toBe(false)
    expect(sameRuntimeValue(null, undefined)).toBe(false)
    expect(sameRuntimeValue('a', 'a')).toBe(true)
    expect(sameRuntimeValue(true, 1)).toBe(false)
  })

  it('treats explicit undefined keys as absent', () => {
    expect(sameRuntimeValue({ model: 'm' }, { model: 'm', reasoning: undefined })).toBe(true)
  })

  it('compares nested arrays in order', () => {
    expect(sameRuntimeValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(sameRuntimeValue([1, 2], [2, 1])).toBe(false)
    expect(sameRuntimeValue({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false)
    expect(sameRuntimeValue({ a: [1] }, { a: '1' })).toBe(false)
  })
})

describe('runtimeToolsSnapshot', () => {
  it('projects registry names and copies the active list', () => {
    const context = contextWith([tool('read'), tool('write')], ['read'])
    const snapshot = runtimeToolsSnapshot(context)

    expect(snapshot.toolNames).toEqual(['read', 'write'])
    expect(snapshot.activeToolNames).toEqual(['read'])
    snapshot.activeToolNames.push('write')
    expect(context.activeToolNames).toEqual(['read'])
  })

  it('falls back to the full registry for legacy contexts without active names', () => {
    const snapshot = runtimeToolsSnapshot(contextWith([tool('read'), tool('ls')]))
    expect(snapshot.activeToolNames).toEqual(['read', 'ls'])
  })
})
