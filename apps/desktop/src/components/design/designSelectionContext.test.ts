import { describe, expect, it } from 'vitest'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import { buildDesignReferencePrompt } from './designSelectionContext'

const document = () => {
  const parsed = parseAxDocument(JSON.stringify({ ax: '1.3', tokens: {}, components: {}, pages: [{ id: 'p', name: '会话', group: 'session', state: { run: 'running' }, width: 100, height: 100,
    tree: [{ id: 'frame', kind: 'frame', children: [{ id: 'text', kind: 'text', text: { $bind: 'session.title' }, wrap: 'nowrap' }] }] }] }))
  if (!parsed.document) throw new Error('fixture invalid')
  const doc = projectAxToPenDocument(parsed.document, '.pen/test.ax').document
  if (!doc) throw new Error('projection failed')
  doc.axDocument = parsed.document
  doc.sha256 = 'observed-sha'
  return doc
}

describe('定位口径（引用与范围头共用）', () => {
  const symbolDocument = () => {
    const parsed = parseAxDocument(JSON.stringify({
      ax: '1.4', tokens: {}, components: {},
      symbols: { Cell: { props: { t: 'string' }, body: [{ id: 'sym-cell', kind: 'text', text: { $param: 't' }, wrap: 'nowrap' }] } },
      pages: [{ id: 'p', name: '页', width: 100, height: 100, tree: [
        { id: 'inst', kind: 'component', name: 'Cell', props: { t: '内容' } },
      ] }],
    }))
    if (!parsed.document) throw new Error('fixture invalid')
    const doc = projectAxToPenDocument(parsed.document, '.pen/sym.ax').document
    if (!doc) throw new Error('projection failed')
    doc.axDocument = parsed.document
    return doc
  }

  it('symbol 展开节点落回实例 id（不把投影派生 id 当 authored id）', () => {
    const doc = symbolDocument()
    const page = doc.pages[0]
    if (!('children' in page)) throw new Error('missing page children')
    const expanded = page.children?.[0]
    if (!expanded) throw new Error('missing expanded node')
    expect(expanded.id).toBe('inst~s:sym-cell')
    const prompt = buildDesignReferencePrompt(doc, expanded)
    // 点选 symbol 内部 = 选中整个实例：引用必须给出实例 id，而不是展开后的派生 id。
    expect(prompt).toContain('nodeId: "inst"')
    expect(prompt).not.toContain('~s:')
  })

  it('投影合成的遮罩层引用真实 overlay，不发送不存在的节点 id', () => {
    const parsed = parseAxDocument(JSON.stringify({ ax: '1.3', tokens: {}, components: {}, pages: [{ id: 'p', width: 100, height: 100,
      tree: [{ id: 'dialog', kind: 'overlay', anchor: 'center', scrim: { fill: '#000000' }, children: [] }] }] }))
    if (!parsed.document) throw new Error('fixture invalid')
    const doc = projectAxToPenDocument(parsed.document, '.pen/dialog.ax').document
    if (!doc) throw new Error('projection failed')
    doc.axDocument = parsed.document
    const root = doc.pages[0]
    if (!('children' in root) || !root.children?.[0]) throw new Error('missing scrim')
    const prompt = buildDesignReferencePrompt(doc, root.children[0])
    expect(prompt).toContain('nodeId: "dialog"')
  })
})

describe('轻量引用（引用到会话）', () => {
  it('页引用只带定位：稿路径 + 页 id/名称 + page 查询，不内联 authored 子树', () => {
    const doc = document()
    const prompt = buildDesignReferencePrompt(doc, doc.pages[0])
    expect(prompt).toContain('.pen/test.ax')
    expect(prompt).toContain('页「会话」')
    expect(prompt).toContain('pageId: p')
    expect(prompt).toContain('mode: "page"')
    // 模型必须先激活再读取：引用不承载内容，只能当定位。
    expect(prompt).toContain('discover_agent_tools')
    expect(prompt).not.toContain('"authored"')
    expect(prompt).not.toContain('$bind')
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(500)
  })

  it('节点引用带 authored 节点 id 与 node 查询，不带绑定原文', () => {
    const doc = document()
    const frame = doc.pages[0]
    if (!('children' in frame)) throw new Error('missing frame')
    const text = frame.children?.[0]
    if (!text || !('children' in text) || !text.children?.[0]) throw new Error('missing text')
    const prompt = buildDesignReferencePrompt(doc, text.children[0])
    expect(prompt).toContain('pageId: p')
    expect(prompt).toContain('mode: "node"')
    expect(prompt).toContain('nodeId: "text"')
    expect(prompt).not.toContain('$bind')
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(500)
  })

  it('页缺 name 时用 pageId 兑底（引用不能出现空定位）', () => {
    const parsed = parseAxDocument(JSON.stringify({
      ax: '1.3', tokens: {}, components: {},
      pages: [{ id: 'p-x', width: 100, height: 100, tree: [] }],
    }))
    if (!parsed.document) throw new Error('fixture invalid')
    const doc = projectAxToPenDocument(parsed.document, '.pen/x.ax').document
    if (!doc) throw new Error('projection failed')
    doc.axDocument = parsed.document
    const prompt = buildDesignReferencePrompt(doc, doc.pages[0])
    expect(prompt).toContain('页「p-x」')
    expect(prompt).toContain('pageId: p-x')
  })
})
