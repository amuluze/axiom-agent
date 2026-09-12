import { defaultConvertToModelMessages } from '@/agent/core/messages'
import type {
  AgentMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { createBranchSummaryMessage } from './branch'
import { generateBranchSummary } from './branchSummary'

class SummaryTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    yield { type: 'start' }
    yield { type: 'text_delta', delta: '## 目标\n保留已离开分支的有效结论\n\n## 后续步骤\n1. 在新分支继续' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

describe('branch summary', () => {
  it('summarizes abandoned history without tools and keeps deterministic file facts', async () => {
    const transport = new SummaryTransport()
    const messages: AgentMessage[] = [
      { id: 'u-old', role: 'user', content: 'inspect files', createdAt: 1 },
      {
        id: 't-read',
        role: 'tool',
        toolCallId: 'read-call',
        toolName: 'read_workspace_file',
        content: 'contents',
        details: { path: 'src/read.ts', operation: 'read' },
        isError: false,
        createdAt: 2,
      },
      {
        id: 't-edit',
        role: 'tool',
        toolCallId: 'edit-call',
        toolName: 'edit_workspace_file',
        content: 'edited',
        details: { path: 'src/edit.ts', operation: 'edited' },
        isError: false,
        createdAt: 3,
      },
    ]

    const result = await generateBranchSummary({
      sessionId: 'session-1',
      messages,
      model: { provider: 'test', model: 'summary-model', maxOutputTokens: 8_192 },
      transport,
      signal: new AbortController().signal,
      customInstructions: '重点保留恢复策略',
    })

    expect(result).toMatchObject({
      sourceFromMessageId: 'u-old',
      sourceThroughMessageId: 't-edit',
      readFiles: ['src/read.ts'],
      modifiedFiles: ['src/edit.ts'],
    })
    expect(transport.requests[0]).toMatchObject({
      sessionId: 'session-1',
      model: { model: 'summary-model' },
      tools: [],
      maxOutputTokens: 2_048,
    })
    const content = transport.requests[0]?.messages[0]?.content ?? ''
    expect(content).toContain('<abandoned-branch>')
    expect(content).toContain('请生成结构化分支摘要')
    expect(content).toContain('额外关注事项：\n重点保留恢复策略')
  })

  it('can replace the default branch-summary task while retaining system safety constraints', async () => {
    const transport = new SummaryTransport()
    await generateBranchSummary({
      sessionId: 'session-replace',
      messages: [{ id: 'u1', role: 'user', content: 'old exploration', createdAt: 1 }],
      model: { provider: 'test', model: 'summary-model' },
      transport,
      signal: new AbortController().signal,
      customInstructions: '只提取尚未解决的阻塞项',
      replaceInstructions: true,
    })

    const request = transport.requests[0]
    const content = request?.messages[0]?.content ?? ''
    expect(content).toContain('只提取尚未解决的阻塞项')
    expect(content).not.toContain('请生成结构化分支摘要')
    expect(request?.systemPrompt).toContain('不要调用工具')
    expect(request?.tools).toEqual([])
  })

  it('supports before/after hooks, instruction override, cancellation, and safe replacement', async () => {
    const generatedTransport = new SummaryTransport()
    const lifecycle: string[] = []
    const generated = await generateBranchSummary({
      sessionId: 'session-hooks',
      messages: [{ id: 'u1', role: 'user', content: 'old exploration', createdAt: 1 }],
      model: { provider: 'test', model: 'summary-model' },
      transport: generatedTransport,
      signal: new AbortController().signal,
      customInstructions: 'original focus',
      hooks: {
        beforeBranchSummary: (context) => {
          lifecycle.push(`before:${context.summaryInstructions?.customInstructions}`)
          return { customInstructions: 'hook focus', replaceInstructions: true }
        },
        afterBranchSummary: (context) => {
          lifecycle.push(`after:${context.replaced}:${context.result.sourceThroughMessageId}`)
          context.result.content = 'after hook mutation'
        },
      },
    })
    const generatedContent = generatedTransport.requests[0]?.messages[0]?.content ?? ''
    expect(generatedContent).toContain('hook focus')
    expect(generatedContent).not.toContain('original focus')
    expect(generatedContent).not.toContain('请生成结构化分支摘要')
    expect(lifecycle).toEqual(['before:original focus', 'after:false:u1'])
    expect(generated.content).not.toBe('after hook mutation')

    const replacementTransport = new SummaryTransport()
    const replaced = await generateBranchSummary({
      sessionId: 'session-replacement',
      messages: [{
        id: 't1',
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'read_workspace_file',
        content: 'contents',
        details: { path: 'src/safe.ts', operation: 'read' },
        isError: false,
        createdAt: 1,
      }],
      model: { provider: 'test', model: 'summary-model' },
      transport: replacementTransport,
      signal: new AbortController().signal,
      hooks: {
        beforeBranchSummary: () => ({ replacement: { content: 'hook replacement' } }),
      },
    })
    expect(replacementTransport.requests).toHaveLength(0)
    expect(replaced).toEqual({
      content: 'hook replacement',
      sourceFromMessageId: 't1',
      sourceThroughMessageId: 't1',
      readFiles: ['src/safe.ts'],
      modifiedFiles: [],
    })

    await expect(generateBranchSummary({
      sessionId: 'session-cancel',
      messages: [{ id: 'u1', role: 'user', content: 'old exploration', createdAt: 1 }],
      model: { provider: 'test', model: 'summary-model' },
      transport: new SummaryTransport(),
      signal: new AbortController().signal,
      hooks: { beforeBranchSummary: () => ({ cancel: true }) },
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('persists a built-in custom message that converts into model context', () => {
    const message = createBranchSummaryMessage({
      content: '## 目标\ncontinue safely',
      sourceFromMessageId: 'a2',
      sourceThroughMessageId: 't3',
      readFiles: [],
      modifiedFiles: ['src/app.ts'],
    }, 10)

    expect(message).toMatchObject({
      role: 'custom',
      customType: 'branch-summary',
      data: { version: 1, sourceFromMessageId: 'a2', sourceThroughMessageId: 't3' },
    })
    expect(defaultConvertToModelMessages([message])[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<branch-summary>'),
    })
  })
})

describe('branch summary edge cases', () => {
  const baseOptions = {
    sessionId: 'session-1',
    model: { provider: 'test', model: 'summary-model' },
    signal: new AbortController().signal,
  }

  it('rejects empty histories and messages without model-facing content', async () => {
    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [],
      transport: new SummaryTransport(),
    })).rejects.toThrow('没有需要总结')

    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{
        id: 'c1', role: 'custom', customType: 'other', content: '', createdAt: 1,
      }],
      transport: new SummaryTransport(),
    })).rejects.toThrow('没有可供模型总结')
  })

  it('rejects empty or oversized replacement summaries', async () => {
    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{ id: 'u1', role: 'user', content: 'old', createdAt: 1 }],
      transport: new SummaryTransport(),
      hooks: { beforeBranchSummary: () => ({ replacement: { content: '   ' } }) },
    })).rejects.toThrow('替代摘要不能为空')

    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{ id: 'u1', role: 'user', content: 'old', createdAt: 1 }],
      transport: new SummaryTransport(),
      hooks: { beforeBranchSummary: () => ({ replacement: { content: 'x'.repeat(128 * 1024 + 1) } }) },
    })).rejects.toThrow('超过 128 KiB 安全上限')
  })

  it('propagates transport errors, tool attempts, and stream termination failures', async () => {
    const errorTransport: ModelTransport = {
      async *stream() { yield { type: 'error', message: 'provider down' } },
    }
    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{ id: 'u1', role: 'user', content: 'old', createdAt: 1 }],
      transport: errorTransport,
    })).rejects.toThrow('分支摘要失败')

    const toolTransport: ModelTransport = {
      async *stream() { yield { type: 'tool_call_start', index: 0, id: 'c1', name: 'read' } },
    }
    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{ id: 'u1', role: 'user', content: 'old', createdAt: 1 }],
      transport: toolTransport,
    })).rejects.toThrow('尝试调用工具')

    const noDoneTransport: ModelTransport = {
      async *stream() { yield { type: 'start' } },
    }
    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{ id: 'u1', role: 'user', content: 'old', createdAt: 1 }],
      transport: noDoneTransport,
    })).rejects.toThrow('模型流未正常结束')

    const emptyTransport: ModelTransport = {
      async *stream() { yield { type: 'start' }; yield { type: 'done', stopReason: 'stop' } },
    }
    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{ id: 'u1', role: 'user', content: 'old', createdAt: 1 }],
      transport: emptyTransport,
    })).rejects.toThrow('摘要为空')

    const oversizedTransport: ModelTransport = {
      async *stream() { yield { type: 'text_delta', delta: 'x'.repeat(128 * 1024 + 1) } },
    }
    await expect(generateBranchSummary({
      ...baseOptions,
      messages: [{ id: 'u1', role: 'user', content: 'old', createdAt: 1 }],
      transport: oversizedTransport,
    })).rejects.toThrow('超过 128 KiB 安全上限')
  })

})
