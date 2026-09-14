import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentMessage, AssistantMessage } from '@/agent/core/types'
import {
  MessageContent,
  parseMessageContent,
  RichMessageContent,
} from './MessageContent'

describe('parseMessageContent', () => {
  it('returns a single text block for plain text', () => {
    expect(parseMessageContent('hello')).toEqual([
      { kind: 'text', content: 'hello' },
    ])
  })

  it('splits a code fence with language into a code block', () => {
    const blocks = parseMessageContent('before\n```ts\nconst x = 1\n```\nafter')
    expect(blocks).toEqual([
      { kind: 'text', content: 'before\n' },
      { kind: 'code', language: 'ts', content: 'const x = 1' },
      { kind: 'text', content: '\nafter' },
    ])
  })

  it('handles a code fence without a language annotation', () => {
    const blocks = parseMessageContent('```\nraw\n```')
    expect(blocks).toEqual([
      { kind: 'code', language: undefined, content: 'raw' },
    ])
  })

  it('treats three backticks without a closing fence as plain text', () => {
    const blocks = parseMessageContent('```\nincomplete')
    expect(blocks.every((block) => block.kind === 'text')).toBe(true)
  })

  it('returns an empty text block for an empty string', () => {
    expect(parseMessageContent('')).toEqual([{ kind: 'text', content: '' }])
  })
})

describe('MessageContent SSR', () => {
  it('renders plain text inside a message-content wrapper', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, { content: 'plain text' }))
    expect(html).toContain('message-content')
    expect(html).toContain('plain text')
  })

  it('renders a code block with the language label and copy button', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, {
      content: '```ts\nconst a = 1\n```',
    }))
    expect(html).toContain('message-code-block')
    expect(html).toContain('message-code-header')
    expect(html).toContain('const a = 1')
    expect(html).toContain('复制')
  })

  it('falls back to 代码 label when no language is provided', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, {
      content: '```\nraw\n```',
    }))
    expect(html).toContain('代码')
  })

  it('renders headings, emphasis, lists, links, and GFM tables as semantic Markdown', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, {
      content: [
        '# 修复结果',
        '',
        '**已完成**，包含 `inline()`。',
        '',
        '- 布局恢复',
        '- 输出正常',
        '',
        '| 项目 | 状态 |',
        '| --- | --- |',
        '| 会话 | 通过 |',
        '',
        '[查看文档](https://example.com/docs)',
      ].join('\n'),
    }))
    expect(html).toContain('<h1>修复结果</h1>')
    expect(html).toContain('<strong>已完成</strong>')
    expect(html).toContain('class="message-inline-code"')
    expect(html).toContain('<ul>')
    expect(html).toContain('class="message-table-wrap"')
    expect(html).toContain('<table>')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    // http(s) 链接附带「在面板打开」动作入口。
    expect(html).toContain('message-link-panel')
    expect(html).toContain('在面板打开 https://example.com/docs')
  })

  it('does not render raw HTML or unsafe javascript links', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, {
      content: '<script>alert("unsafe")</script>\n\n[危险链接](javascript:alert(1))',
    }))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('javascript:')
    // 非 http(s) 链接不渲染「在面板打开」入口。
    expect(html).not.toContain('message-link-panel')
  })
})

describe('RichMessageContent SSR', () => {
  const baseAssistant = (overrides: Partial<AssistantMessage> = {}): AgentMessage => ({
    id: 'm',
    createdAt: 0,
    role: 'assistant',
    content: '',
    contentBlocks: [],
    toolCalls: [],
    stopReason: 'stop',
    ...overrides,
  })

  it('falls back to 正在思考… when an assistant message has no content blocks', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: baseAssistant(),
    }))
    expect(html).toContain('正在思考…')
  })

  it('renders assistant text content through MessageContent', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: baseAssistant({
        contentBlocks: [{ type: 'text', text: 'I will edit the file.' }],
      }),
    }))
    expect(html).toContain('I will edit the file.')
  })

  it('renders a thinking block as a collapsible details element', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: baseAssistant({
        contentBlocks: [{ type: 'thinking', thinking: 'step by step', redacted: false }],
      }),
    }))
    expect(html).toContain('message-thinking')
    expect(html).toContain('思考过程')
    expect(html).toContain('step by step')
  })

  it('shows the redacted notice for thinking blocks marked redacted', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: baseAssistant({
        contentBlocks: [{ type: 'thinking', thinking: 'hidden', redacted: true }],
      }),
    }))
    expect(html).toContain('该思考块已由 Provider 隐去')
  })

  it('renders a tool call block with the tool name and truncated raw arguments', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: baseAssistant({
        contentBlocks: [{
          type: 'tool_call',
          id: 'tc-1',
          name: 'read',
          arguments: { path: 'file.md' },
          rawArguments: '{"path":"file.md"}',
        }],
      }),
    }))
    expect(html).toContain('tool-call-list')
    expect(html).toContain('调用工具')
    expect(html).toContain('read')
  })

  it('renders user message content directly', () => {
    const message: AgentMessage = {
      id: 'u',
      createdAt: 0,
      role: 'user',
      content: 'summarise the repo',
    }
    const html = renderToStaticMarkup(createElement(RichMessageContent, { message }))
    expect(html).toContain('summarise the repo')
  })

  it('wraps pasted screenshots in a zoom button for the lightbox', () => {
    const message: AgentMessage = {
      id: 'u-img',
      createdAt: 0,
      role: 'user',
      content: '看这张图',
      contentBlocks: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'cG5n' } },
      ],
    }
    const html = renderToStaticMarkup(createElement(RichMessageContent, { message }))
    expect(html).toContain('message-image-button')
    expect(html).toContain('message-image')
    expect(html).toContain('data:image/png;base64,cG5n')
  })

  it('renders tool result message content directly', () => {
    const message: AgentMessage = {
      id: 't',
      createdAt: 0,
      role: 'tool',
      toolCallId: 'tc-1',
      toolName: 'read',
      content: 'file contents',
      isError: false,
    }
    const html = renderToStaticMarkup(createElement(RichMessageContent, { message }))
    expect(html).toContain('file contents')
  })
})

describe('RichMessageContent streaming SSR', () => {
  const streamingAssistant = (text: string): AgentMessage => ({
    id: 'm',
    createdAt: 0,
    role: 'assistant',
    content: '',
    contentBlocks: [{ type: 'text', text }],
    toolCalls: [],
    stopReason: 'stop',
  })

  it('renders the unclosed tail as a lightweight pre block', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: streamingAssistant('plain text'),
      streaming: true,
    }))
    expect(html).toContain('message-streaming-tail')
    expect(html).toContain('plain text')
  })

  it('renders the closed fence as stable markdown and the trailing text as pre', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: streamingAssistant('```ts\nconst x = 1\n```\nafter'),
      streaming: true,
    }))
    expect(html).toContain('message-code-block')
    expect(html).toContain('const x = 1')
    expect(html).toContain('message-streaming-tail')
    expect(html).toContain('after')
  })
})

describe('RichMessageContent thinking spinner SSR', () => {
  const thinkingAssistant = (contentBlocks: AssistantMessage['contentBlocks']): AgentMessage => ({
    id: 'm',
    createdAt: 0,
    role: 'assistant',
    content: '',
    contentBlocks,
    toolCalls: [],
    stopReason: 'stop',
  })

  it('shows the spinner next to the summary while the thinking block is still streaming', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: thinkingAssistant([{ type: 'thinking', thinking: 'step by st' }]),
      streaming: true,
    }))
    expect(html).toContain('message-thinking__spinner')
  })

  it('hides the spinner once a later block has started after thinking', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: thinkingAssistant([
        { type: 'thinking', thinking: 'done' },
        { type: 'text', text: 'answer' },
      ]),
      streaming: true,
    }))
    expect(html).not.toContain('message-thinking__spinner')
  })

  it('never shows the spinner for history messages', () => {
    const html = renderToStaticMarkup(createElement(RichMessageContent, {
      message: thinkingAssistant([{ type: 'thinking', thinking: 'done' }]),
    }))
    expect(html).not.toContain('message-thinking__spinner')
  })
})
