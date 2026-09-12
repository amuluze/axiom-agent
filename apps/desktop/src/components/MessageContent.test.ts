import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseMessageContent, RichMessageContent } from './MessageContent'

describe('MessageContent', () => {
  it('splits fenced code without interpreting raw HTML', () => {
    expect(parseMessageContent('说明\n```ts\nconst value = "<script>"\n```\n完成')).toEqual([
      { kind: 'text', content: '说明\n' },
      { kind: 'code', language: 'ts', content: 'const value = "<script>"' },
      { kind: 'text', content: '\n完成' },
    ])
  })

  it('keeps unfinished fences as plain text', () => {
    expect(parseMessageContent('```ts\nconst unfinished = true')).toEqual([
      { kind: 'text', content: '```ts\nconst unfinished = true' },
    ])
  })

  it('renders assistant thinking, text, and tool calls in protocol order', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, { message: {
      id: 'assistant-rich',
      role: 'assistant',
      content: 'beforeafter',
      contentBlocks: [
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'before' },
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'read_file',
          arguments: { path: '/tmp/a' },
          rawArguments: '{"path":"/tmp/a"}',
        },
        { type: 'text', text: 'after' },
      ],
      toolCalls: [{
        id: 'call-1',
        name: 'read_file',
        arguments: { path: '/tmp/a' },
        rawArguments: '{"path":"/tmp/a"}',
      }],
      stopReason: 'tool_use',
      createdAt: 1,
    } }))

    expect(html.indexOf('reason')).toBeLessThan(html.indexOf('before'))
    expect(html.indexOf('before')).toBeLessThan(html.indexOf('read_file'))
    expect(html.indexOf('read_file')).toBeLessThan(html.indexOf('after'))
  })
})
