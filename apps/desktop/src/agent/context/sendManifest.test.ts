import { describe, expect, it } from 'vitest'
import { buildSendManifest } from './sendManifest'

describe('send manifest', () => {
  it('counts system, history, tools, images and the compaction summary', () => {
    const imageData = 'a'.repeat(2048)
    const body = JSON.stringify({
      system: 'system prompt',
      tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
          ],
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'context-summary: <context-summary>\nprevious work\n</context-summary>' },
      ],
    })
    const manifest = buildSendManifest({
      requestId: 'r1',
      sessionId: 's1',
      providerId: 'generic-anthropic-compatible',
      apiFormat: 'anthropic-compatible',
      body,
    })
    expect(manifest.bytes).toBe(new TextEncoder().encode(body).length)
    expect(manifest.systemBytes).toBe('system prompt'.length)
    expect(manifest.toolCount).toBe(1)
    expect(manifest.toolBytes).toBeGreaterThan(10)
    expect(manifest.messageCount).toBe(3)
    expect(manifest.roleCounts).toEqual({ user: 2, assistant: 1 })
    expect(manifest.imageCount).toBe(1)
    expect(manifest.imageBytes).toBeGreaterThanOrEqual(imageData.length)
    expect(manifest.toolResultCount).toBe(0)
    expect(manifest.retryCount).toBe(0)
    expect(manifest.credentialScan).toBe('pending')
    expect(manifest.summaryIncluded).toBe(true)
  })

  it('counts tool results across Anthropic, Chat Completions and Responses payloads', () => {
    const manifest = buildSendManifest({
      requestId: 'r4',
      providerId: 'p',
      body: JSON.stringify({
        input: [
          { type: 'function_call_output', output: 'responses output' },
          { role: 'tool', content: 'chat output' },
          {
            role: 'user',
            content: [{ type: 'tool_result', content: 'anthropic output' }],
          },
        ],
      }),
    })
    expect(manifest.toolResultCount).toBe(3)
    expect(manifest.toolResultBytes).toBe(
      'responses output'.length + 'chat output'.length + 'anthropic output'.length,
    )
  })

  it('handles OpenAI-style system role, image_url and absent sections', () => {
    const manifest = buildSendManifest({
      requestId: 'r2',
      providerId: 'generic-openai-compatible',
      apiFormat: 'openai-compatible',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'you are helpful' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      }),
    })
    expect(manifest.systemBytes).toBe('you are helpful'.length)
    expect(manifest.toolCount).toBe(0)
    expect(manifest.roleCounts).toEqual({ system: 1, user: 1 })
    expect(manifest.imageCount).toBe(1)
    expect(manifest.imageBytes).toBe('data:image/png;base64,AAAA'.length)
    expect(manifest.summaryIncluded).toBe(false)
    expect(manifest.sessionId).toBeUndefined()
  })

  it('returns a byte-only manifest for malformed bodies instead of throwing', () => {
    const manifest = buildSendManifest({
      requestId: 'r3',
      providerId: 'p',
      apiFormat: 'anthropic-compatible',
      body: 'not-json',
    })
    expect(manifest.bytes).toBe('not-json'.length)
    expect(manifest.messageCount).toBe(0)
    expect(manifest.toolCount).toBe(0)
  })
})
