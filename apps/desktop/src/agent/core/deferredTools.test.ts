import { describe, expect, it } from 'vitest'
import type { AgentContext, AgentMessage, AgentTool } from './types'
import {
  activateToolResults,
  activeToolsForContext,
  normalizeAgentContextTools,
  resolveActiveToolNames,
  validateActiveToolNames,
  validateAddedToolNames,
  validateToolRegistry,
} from './deferredTools'

const makeTool = (name: string, overrides: Partial<AgentTool> = {}): AgentTool => ({
  name,
  runtimeVersion: '1',
  label: name,
  description: name,
  inputSchema: {},
  validate: (input) => ({ ok: true, value: input as never }),
  execute: async () => ({ content: 'ok' }),
  ...overrides,
})

const registry = (names: string[]): AgentTool[] => names.map((name) => makeTool(name))

describe('validateToolRegistry', () => {
  it('rejects duplicate tool names', () => {
    expect(() => validateToolRegistry(registry(['a', 'a']))).toThrow('重复工具名称：a')
  })

  it('rejects empty names', () => {
    expect(() => validateToolRegistry(registry(['']))).toThrow('工具名称不能为空')
  })

  it('rejects missing runtimeVersion', () => {
    const tool = makeTool('a', { runtimeVersion: '' })
    expect(() => validateToolRegistry([tool])).toThrow('Runtime version 不能为空')
  })

  it('enforces the idempotencyKey contract', () => {
    const missingKey = makeTool('a', { recoveryPolicy: 'idempotent' })
    expect(() => validateToolRegistry([missingKey])).toThrow('必须提供 idempotencyKey')

    const strayKey = makeTool('a', { idempotencyKey: () => 'key' })
    expect(() => validateToolRegistry([strayKey])).toThrow('只有声明 idempotent')
  })

  it('accepts a valid registry', () => {
    expect(() => validateToolRegistry(registry(['a', 'b']))).not.toThrow()
  })
})

describe('validateActiveToolNames', () => {
  it('rejects duplicate active names', () => {
    expect(() => validateActiveToolNames(['a', 'a'], registry(['a']))).toThrow('重复工具名称')
  })

  it('rejects unknown tool names', () => {
    expect(() => validateActiveToolNames(['ghost'], registry(['a']))).toThrow('未知工具：ghost')
  })

  it('returns a fresh copy of the input names', () => {
    const names = ['a', 'b']
    const result = validateActiveToolNames(names, registry(['a', 'b']))
    expect(result).toEqual(['a', 'b'])
    expect(result).not.toBe(names)
  })
})

describe('validateAddedToolNames', () => {
  it('returns empty for undefined or empty input', () => {
    expect(validateAddedToolNames(undefined, registry(['a']))).toEqual([])
    expect(validateAddedToolNames([], registry(['a']))).toEqual([])
  })

  it('validates a non-empty addition', () => {
    expect(validateAddedToolNames(['b'], registry(['a', 'b']))).toEqual(['b'])
    expect(() => validateAddedToolNames(['ghost'], registry(['a']))).toThrow('未知工具')
  })
})

describe('resolveActiveToolNames', () => {
  const tools = registry(['read', 'web_search'])

  it('defaults to every registry tool when no initial set is given', () => {
    expect(resolveActiveToolNames(tools, [])).toEqual(['read', 'web_search'])
  })

  it('returns a registry-ordered projection of the active set', () => {
    expect(resolveActiveToolNames(tools, [], ['web_search'])).toEqual(['web_search'])
  })

  it('accumulates addedToolNames from non-error tool messages', () => {
    const messages: AgentMessage[] = [
      {
        id: 'm1', role: 'tool', toolCallId: 'c1', toolName: 'read',
        content: '', isError: false, createdAt: 1,
        addedToolNames: ['web_search'],
      },
    ]
    expect(resolveActiveToolNames(tools, messages, ['read'])).toEqual(['read', 'web_search'])
  })

  it('ignores additions from errored tool messages', () => {
    const messages: AgentMessage[] = [
      {
        id: 'm1', role: 'tool', toolCallId: 'c1', toolName: 'read',
        content: '', isError: true, createdAt: 1,
        addedToolNames: ['web_search'],
      },
    ]
    expect(resolveActiveToolNames(tools, messages, ['read'])).toEqual(['read'])
  })
})

const makeContext = (tools: AgentTool[], activeToolNames?: string[]): AgentContext => ({
  sessionId: 's',
  systemPrompt: '',
  model: { provider: 'p', model: 'm' },
  messages: [],
  tools,
  activeToolNames,
})

describe('normalizeAgentContextTools / activeToolsForContext', () => {
  it('copies messages and tools arrays while resolving active names', () => {
    const tools = registry(['read', 'web_search'])
    const context = makeContext(tools, ['read'])
    const normalized = normalizeAgentContextTools(context)
    expect(normalized.activeToolNames).toEqual(['read'])
    expect(normalized.messages).not.toBe(context.messages)
    expect(normalized.tools).not.toBe(context.tools)
  })

  it('activeToolsForContext filters to the resolved active set', () => {
    const tools = registry(['read', 'web_search'])
    const context = makeContext(tools, ['web_search'])
    expect(activeToolsForContext(context).map((tool) => tool.name)).toEqual(['web_search'])
  })
})

describe('activateToolResults', () => {
  it('accumulates additions from tool results and preserves the registry order', () => {
    const tools = registry(['read', 'write', 'web_search'])
    const context = makeContext(tools, ['read'])
    const results = [
      {
        id: 'r1', role: 'tool' as const, toolCallId: 'c1', toolName: 'read',
        content: '', isError: false, createdAt: 1, addedToolNames: ['web_search'],
      },
    ]
    const next = activateToolResults(context, results)
    expect(next.activeToolNames).toEqual(['read', 'web_search'])
  })
})
