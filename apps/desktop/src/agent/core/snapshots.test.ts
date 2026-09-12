import { describe, expect, it } from 'vitest'
import type {
  AgentContext,
  AgentTool,
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from './types'
import {
  cloneJsonValue,
  snapshotAgentContext,
  snapshotAgentMessages,
  snapshotAgentTool,
  snapshotAssistantMessage,
  snapshotModelRequest,
  snapshotToolCall,
  snapshotToolResultMessage,
} from './snapshots'

const makeCall = (): ToolCall => ({
  id: 'call-1',
  name: 'echo',
  arguments: { value: 'a' },
  rawArguments: '{"value":"a"}',
})

const makeTool = (name = 'read'): AgentTool => ({
  name,
  runtimeVersion: '1',
  label: name,
  description: name,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  validate: (input) => ({ ok: true, value: input as never }),
  execute: async () => ({ content: 'ok' }),
})

const makeAssistant = (): AssistantMessage => ({
  id: 'm1',
  role: 'assistant',
  content: 'hello',
  toolCalls: [makeCall()],
  stopReason: 'stop',
  createdAt: 1,
  provider: 'p',
  model: 'm',
})

const makeToolResult = (): ToolResultMessage => ({
  id: 'r1',
  role: 'tool',
  toolCallId: 'call-1',
  toolName: 'echo',
  content: 'ok',
  isError: false,
  createdAt: 1,
})

describe('cloneJsonValue / structured-clone helpers', () => {
  it('cloneJsonValue produces a deep copy of nested JSON', () => {
    const source = { nested: { list: [1, 2, 3] } }
    const clone = cloneJsonValue(source)
    expect(clone).toEqual(source)
    expect(clone).not.toBe(source)
    expect(clone.nested).not.toBe(source.nested)
    expect(clone.nested.list).not.toBe(source.nested.list)
  })
})

describe('snapshotAgentMessages', () => {
  it('clones every message and isolates the returned array', () => {
    const messages = [makeAssistant(), makeToolResult()]
    const snapshot = snapshotAgentMessages(messages)
    expect(snapshot).toEqual(messages)
    expect(snapshot).not.toBe(messages)
    expect(snapshot[0]).not.toBe(messages[0])
  })
})

describe('snapshotAgentTool', () => {
  it('clones the inputSchema and isolates the tool object', () => {
    const tool = makeTool()
    const snapshot = snapshotAgentTool(tool)
    expect(snapshot).toEqual(tool)
    expect(snapshot).not.toBe(tool)
    expect(snapshot.inputSchema).not.toBe(tool.inputSchema)
  })
})

describe('snapshotAgentContext', () => {
  it('clones model, messages, tools and isolates activeToolNames', () => {
    const message = makeAssistant()
    const tool = makeTool()
    const context: AgentContext = {
      sessionId: 's',
      systemPrompt: '',
      model: { provider: 'p', model: 'm' },
      messages: [message],
      tools: [tool],
      activeToolNames: ['read'],
    }
    const snapshot = snapshotAgentContext(context)
    expect(snapshot).toEqual(context)
    expect(snapshot.model).not.toBe(context.model)
    expect(snapshot.messages).not.toBe(context.messages)
    expect(snapshot.messages[0]).not.toBe(message)
    expect(snapshot.tools).not.toBe(context.tools)
    expect(snapshot.tools[0]).not.toBe(tool)
    expect(snapshot.activeToolNames).not.toBe(context.activeToolNames)
  })
})

describe('snapshotAssistantMessage / snapshotToolResultMessage / snapshotToolCall', () => {
  it('isolates an assistant message and its nested toolCalls', () => {
    const message = makeAssistant()
    const snapshot = snapshotAssistantMessage(message)
    expect(snapshot).toEqual(message)
    expect(snapshot.toolCalls).not.toBe(message.toolCalls)
  })

  it('isolates a tool result message', () => {
    const message = makeToolResult()
    const snapshot = snapshotToolResultMessage(message)
    expect(snapshot).toEqual(message)
    expect(snapshot).not.toBe(message)
  })

  it('isolates a tool call', () => {
    const call = makeCall()
    const snapshot = snapshotToolCall(call)
    expect(snapshot).toEqual(call)
    expect(snapshot).not.toBe(call)
  })
})

describe('snapshotModelRequest', () => {
  it('deep-clones the model request', () => {
    const request = {
      sessionId: 's',
      runId: 'r',
      systemPrompt: '',
      model: { provider: 'p', model: 'm' },
      messages: [],
      tools: [],
    }
    const snapshot = snapshotModelRequest(request)
    expect(snapshot).toEqual(request)
    expect(snapshot.model).not.toBe(request.model)
  })
})
