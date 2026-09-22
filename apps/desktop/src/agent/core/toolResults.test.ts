import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReference, ToolCall } from './types'
import { createToolResultMessage, type ToolCallOutcome } from './toolResults'

const makeCall = (id = 'call-1', name = 'screenshot'): ToolCall => ({
  id,
  name,
  arguments: {},
  rawArguments: '{}',
})

const makeOutcome = (result: Partial<ToolCallOutcome['result']>, isError = false): ToolCallOutcome => ({
  call: makeCall(),
  result: { content: 'done', ...result },
  isError,
})

const base64Image = (kib: number) => ({
  type: 'image' as const,
  source: { type: 'base64' as const, mediaType: 'image/png', data: 'A'.repeat(kib * 1024) },
})

const artifact = (sizeBytes: number): ArtifactReference => ({
  id: 'artifact-1',
  kind: 'text',
  mediaType: 'text/plain',
  relativePath: 'tool_results/artifact-1',
  contentHash: 'hash-1',
  sizeBytes,
  createdAt: 1,
})

const messageByteLength = (message: { content: string; contentBlocks?: unknown[] }): number =>
  new TextEncoder().encode(JSON.stringify(message)).byteLength

describe('createToolResultMessage message byte budget', () => {
  it('keeps a small result with image blocks untouched', async () => {
    const message = await createToolResultMessage(
      'run-1',
      makeOutcome({ content: '截图完成', contentBlocks: [base64Image(64)] }),
      256 * 1024,
    )
    expect(message.content).toBe('截图完成')
    // 首项是内联文本块，其后才是图片块。
    expect(message.contentBlocks).toHaveLength(2)
    expect(message.artifact).toBeUndefined()
  })

  it('drops trailing oversized image blocks and appends an omission note', async () => {
    const message = await createToolResultMessage(
      'run-1',
      makeOutcome({
        content: '截图完成',
        // 两张 1 MiB base64 图：整体远超 1.5 MiB 消息预算，但首张可保留。
        contentBlocks: [base64Image(1024), base64Image(1024)],
      }),
      256 * 1024,
    )
    expect(messageByteLength(message)).toBeLessThan(1536 * 1024)
    expect(message.contentBlocks).toHaveLength(2)
    expect(message.contentBlocks?.[0]).toMatchObject({ type: 'text' })
    expect(message.content).toContain('截图完成')
    expect(message.content).toContain('已省略尾部 1 张图片')
  })

  it('drops every image block when even a single one busts the budget', async () => {
    const message = await createToolResultMessage(
      'run-1',
      makeOutcome({ content: '截图完成', contentBlocks: [base64Image(4096)] }),
      256 * 1024,
    )
    expect(messageByteLength(message)).toBeLessThan(1536 * 1024)
    // 图片全部丢弃，只留下内联文本块。
    expect(message.contentBlocks?.every((block) => block.type === 'text')).toBe(true)
    expect(message.content).toContain('已省略尾部 1 张图片')
    // 省略说明只追加在文本里，不改变结果本身的成败语义。
    expect(message.isError).toBe(false)
  })

  it('keeps artifact externalization of oversized text alongside the budget guard', async () => {
    const externalize = vi.fn(async () => artifact(300 * 1024))
    const message = await createToolResultMessage(
      'run-1',
      makeOutcome({ content: 'x'.repeat(300 * 1024) }),
      256 * 1024,
      externalize,
    )
    expect(externalize).toHaveBeenCalledOnce()
    expect(message.artifact).toMatchObject({ id: 'artifact-1' })
    expect(message.content).toContain('完整工具结果已安全保存为 Artifact')
  })
})
