import { describe, expect, it } from 'vitest'
import { parsePenDocument, type PenNode } from '@/agent/design/penParser'
import { buildDesignImplementationPrompt } from './designImplementationPrompt'

const PEN_SOURCE = JSON.stringify({
  version: '2.18',
  variables: {
    'bg-card': [
      { value: '#ffffff', theme: { mode: 'light' } },
      { value: '#1c1b1a', theme: { mode: 'dark' } },
    ],
    'text-muted': '#8a8a8a',
  },
  children: [
    {
      type: 'frame',
      id: 'page-1',
      name: '登录页',
      width: 375,
      height: 812,
      layout: 'vertical',
      gap: 12,
      padding: [24, 16, 24, 16],
      children: [
        {
          type: 'text',
          id: 'title',
          name: '标题',
          content: '欢迎回来',
          fontSize: 24,
          fontWeight: 600,
          fill: '$text-muted',
        },
        {
          type: 'frame',
          id: 'card',
          fill: { type: 'gradient', gradientType: 'linear', rotation: 0, colors: [
            { color: '$bg-card', position: 0 },
            { color: '#ffffff', position: 1 },
          ] },
          children: [{ type: 'icon', id: 'ico', icon: 'arrow-right', fontSize: 16 }],
        },
      ],
    },
  ],
})

const labels = {
  intro: 'INTRO',
  structure: 'STRUCTURE',
  tokens: 'TOKENS',
  truncated: 'TRUNCATED',
}

const build = (source = PEN_SOURCE, options: { maxNodes?: number; maxDepth?: number } = {}) => {
  const parsed = parsePenDocument(source, '.pen/login.pen')
  if (!parsed.document) throw new Error('fixture parse failed')
  const page = parsed.document.pages[0] as PenNode
  return buildDesignImplementationPrompt({ doc: parsed.document, node: page, labels, ...options })
}

describe('buildDesignImplementationPrompt', () => {
  it('输出实现指令、文件标识与缩进结构树（含尺寸/布局/文案/图标）', () => {
    const prompt = build()
    expect(prompt).toContain('INTRO')
    expect(prompt).toContain('.pen/login.pen · v2.18')
    expect(prompt).toContain('STRUCTURE')
    expect(prompt).toContain('- frame "登录页" 375×812 列 gap:12 padding:24/16/24/16')
    expect(prompt).toContain('  - text "标题" bg:$text-muted font:24/600 text:"欢迎回来"')
    expect(prompt).toContain('    - icon ico icon:arrow-right')
  })

  it('汇总子树引用到的 token（含明暗取值，去重排序）', () => {
    const prompt = build()
    expect(prompt).toContain('TOKENS')
    expect(prompt).toContain('- $bg-card: light=#ffffff dark=#1c1b1a')
    // 未按主题分档的 token 明暗同值。
    expect(prompt).toContain('- $text-muted: light=#8a8a8a dark=#8a8a8a')
  })

  it('节点数超上限时截断并标注', () => {
    const prompt = build(PEN_SOURCE, { maxNodes: 2 })
    expect(prompt).toContain('TRUNCATED')
    // 截断后不再包含更深层节点。
    expect(prompt).not.toContain('arrow-right')
  })

  it('深度超上限时截断并标注', () => {
    const prompt = build(PEN_SOURCE, { maxDepth: 1 })
    expect(prompt).toContain('TRUNCATED')
    expect(prompt).toContain('- frame "登录页"')
  })

  it('未知节点类型标注为不支持而非静默丢失', () => {
    const source = JSON.stringify({ children: [{ type: 'browser', id: 'b1', name: '预览' }] })
    const prompt = build(source)
    expect(prompt).toContain('不支持的节点类型 browser')
  })
})
