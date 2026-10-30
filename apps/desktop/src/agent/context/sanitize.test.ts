import type { AgentMessage, ToolResultMessage } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { buildContextProjection } from './budget'
import { sanitizeContextMessages } from './sanitize'

const readResult = (
  id: string,
  content: string,
  startLine: number,
  endLine: number,
  sha256 = 'a'.repeat(64),
): ToolResultMessage => ({
  id,
  role: 'tool',
  toolCallId: `call-${id}`,
  toolName: 'read',
  content,
  details: {
    path: 'src/runtime.ts',
    startLine,
    endLine,
    totalLines: 500,
    truncated: true,
    nextOffset: endLine + 1,
    sha256,
  },
  isError: false,
  createdAt: startLine,
})

describe('context sanitizer', () => {
  it('omits an earlier read only when a later read of the same revision covers its range', () => {
    const earlier = readResult('earlier', 'old line\n'.repeat(200), 50, 100)
    const later = readResult('later', 'new line\n'.repeat(200), 1, 200)
    const history: AgentMessage[] = [earlier, later]

    const projection = buildContextProjection(history)

    expect(history[0]).toBe(earlier)
    expect((history[0] as ToolResultMessage).content).toContain('old line')
    expect((projection[0] as ToolResultMessage).content).toContain('superseded')
    expect(projection[0]).not.toHaveProperty('contentBlocks')
    expect(projection[1]).toBe(later)
  })

  it('keeps an earlier read when the file revision changed', () => {
    const messages: AgentMessage[] = [
      readResult('earlier', 'before\n'.repeat(200), 1, 100, 'a'.repeat(64)),
      readResult('later', 'after\n'.repeat(200), 1, 100, 'b'.repeat(64)),
    ]

    expect(sanitizeContextMessages(messages)).toEqual(messages)
  })

  it('keeps a small superseded read when rewriting it would invalidate a larger cached suffix', () => {
    const earlier = readResult('earlier', 'old line\n'.repeat(20), 50, 100)
    const cached: AgentMessage = {
      id: 'cached-response',
      role: 'assistant',
      content: 'cached reasoning '.repeat(200),
      toolCalls: [],
      stopReason: 'stop',
      usage: {
        inputTokens: 2_000,
        outputTokens: 20,
        totalTokens: 2_020,
        cacheReadTokens: 1_500,
      },
      createdAt: 2,
    }
    const later = readResult('later', 'new line\n'.repeat(200), 1, 200)

    const sanitized = sanitizeContextMessages([earlier, cached, later])

    expect(sanitized[0]).toBe(earlier)
  })

  it('replaces a large superseded read when its savings amortize the cached suffix', () => {
    const earlier = readResult('earlier', 'old line\n'.repeat(5_000), 50, 100)
    const cached: AgentMessage = {
      id: 'cached-response',
      role: 'assistant',
      content: 'cached reasoning '.repeat(20),
      toolCalls: [],
      stopReason: 'stop',
      usage: {
        inputTokens: 2_000,
        outputTokens: 20,
        totalTokens: 2_020,
        cacheReadTokens: 1_500,
      },
      createdAt: 2,
    }
    const later = readResult('later', 'new line\n'.repeat(200), 1, 200)

    const sanitized = sanitizeContextMessages([earlier, cached, later]) as ToolResultMessage[]

    expect(sanitized[0]?.content).toContain('superseded')
  })

  it('ignores cache affinity during aggressive local rescue', () => {
    const earlier = readResult('earlier', 'old line\n'.repeat(20), 50, 100)
    const cached: AgentMessage = {
      id: 'cached-response',
      role: 'assistant',
      content: 'cached reasoning '.repeat(200),
      toolCalls: [],
      stopReason: 'stop',
      usage: {
        inputTokens: 2_000,
        outputTokens: 20,
        totalTokens: 2_020,
        cacheReadTokens: 1_500,
      },
      createdAt: 2,
    }
    const later = readResult('later', 'new line\n'.repeat(200), 1, 200)

    const sanitized = sanitizeContextMessages(
      [earlier, cached, later],
      { aggressive: true },
    ) as ToolResultMessage[]

    expect(sanitized[0]?.content).toContain('superseded')
  })

  it('does not replace a discardable result when the placeholder would cost more', () => {
    const message: ToolResultMessage = {
      id: 'empty-search',
      role: 'tool',
      toolCallId: 'call-empty-search',
      toolName: 'grep',
      content: 'No matches found.',
      details: { matches: [], contextRetention: 'discardable' },
      isError: false,
      createdAt: 1,
    }

    expect(sanitizeContextMessages([message])[0]).toBe(message)
  })

  it('replaces a large explicitly discardable result without mutating the source', () => {
    const message: ToolResultMessage = {
      id: 'discardable',
      role: 'tool',
      toolCallId: 'call-discardable',
      toolName: 'grep',
      content: 'noise\n'.repeat(200),
      contentBlocks: [{ type: 'text', text: 'noise\n'.repeat(200) }],
      details: { contextRetention: 'discardable' },
      isError: false,
      createdAt: 1,
    }

    const sanitized = sanitizeContextMessages([message])[0] as ToolResultMessage

    expect(sanitized.content).toContain('no retained context value')
    expect(sanitized.contentBlocks).toBeUndefined()
    expect(message.contentBlocks).toHaveLength(1)
  })

  it('aggressively removes older image payloads while retaining the newest image', () => {
    const imageResult = (id: string, data: string, createdAt: number): ToolResultMessage => ({
      id,
      role: 'tool',
      toolCallId: `call-${id}`,
      toolName: 'read',
      content: `${id} image`,
      contentBlocks: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }],
      details: { image: { mimeType: 'image/png', dataBase64: data } },
      isError: false,
      createdAt,
    })
    const earlier = imageResult('earlier', 'A'.repeat(2_000), 1)
    const later = imageResult('later', 'B'.repeat(2_000), 2)

    const sanitized = sanitizeContextMessages([earlier, later], { aggressive: true }) as ToolResultMessage[]

    expect(sanitized[0]?.content).toContain('Earlier image payload omitted')
    expect(sanitized[0]?.contentBlocks).toBeUndefined()
    expect(sanitized[0]?.details).not.toHaveProperty('image.dataBase64')
    expect(sanitized[1]?.contentBlocks).toEqual(later.contentBlocks)
    expect(sanitized[1]?.details).not.toHaveProperty('image.dataBase64')
    expect(earlier.contentBlocks?.[0]).toHaveProperty('source.data', 'A'.repeat(2_000))
  })

  it('aggressively replaces older inline Artifact content while retaining the newest result', () => {
    const artifactResult = (id: string, content: string, createdAt: number): ToolResultMessage => ({
      id,
      role: 'tool',
      toolCallId: `call-${id}`,
      toolName: 'bash',
      content,
      artifact: {
        id: `artifact-${id}`,
        kind: 'text',
        mediaType: 'text/plain',
        relativePath: `${id}.txt`,
        contentHash: id.repeat(64).slice(0, 64),
        sizeBytes: content.length,
        createdAt,
      },
      isError: false,
      createdAt,
    })
    const earlier = artifactResult('a', 'old output\n'.repeat(300), 1)
    const later = artifactResult('b', 'latest output', 2)

    const sanitized = sanitizeContextMessages([earlier, later], { aggressive: true }) as ToolResultMessage[]

    expect(sanitized[0]?.content).toContain('Artifact artifact-a')
    expect(sanitized[0]?.artifact).toEqual(earlier.artifact)
    expect(sanitized[1]?.content).toBe('latest output')
    expect(earlier.content).toContain('old output')
  })
})
