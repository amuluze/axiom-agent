import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MentionPopover, resolveMentionKeyAction, sectionizeCandidates } from './MentionPopover'

describe('MentionPopover', () => {
  it('returns an empty string when active is null', () => {
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: null,
      candidates: [],
      onSelect: () => undefined,
      onClose: () => undefined,
    }))
    expect(html).toBe('')
  })

  it('renders the empty placeholder for each kind when candidates are empty', () => {
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'file', triggerStart: 0, queryEnd: 4, query: '' },
      candidates: [],
      onSelect: () => undefined,
      onClose: () => undefined,
    }))
    expect(html).toContain('尚未添加文件或目录引用')
  })

  it('renders each candidate as a button with label and optional hint', () => {
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'skill', triggerStart: 0, queryEnd: 1, query: '' },
      candidates: [
        { id: 'review', label: 'review', hint: 'reviews code' },
        { id: 'plan', label: 'plan' },
      ],
      onSelect: () => undefined,
      onClose: () => undefined,
    }))
    expect(html).toContain('composer__mention-popover')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('review')
    expect(html).toContain('reviews code')
    expect(html).toContain('plan')
  })

  it('shows the correct title and icon for each mention kind', () => {
    const kinds: Array<'file' | 'skill' | 'thread'> = ['file', 'skill', 'thread']
    const labels = ['选择文件或目录', '选择技能', '关联会话']
    for (let i = 0; i < kinds.length; i++) {
      const html = renderToStaticMarkup(createElement(MentionPopover, {
        active: { kind: kinds[i]!, triggerStart: 0, queryEnd: 1, query: '' },
        candidates: [{ id: 'x', label: 'x' }],
        onSelect: () => undefined,
        onClose: () => undefined,
      }))
      expect(html).toContain(labels[i])
    }
  })

  it('shows a folder icon for directory candidates', () => {
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'file', triggerStart: 0, queryEnd: 1, query: '' },
      candidates: [{ id: '/ws/src', label: 'src', isDirectory: true }],
      onSelect: () => undefined,
      onClose: () => undefined,
    }))
    expect(html).toContain('folder')
  })

  it('applies the active highlight to the first item', () => {
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'file', triggerStart: 0, queryEnd: 1, query: '' },
      candidates: [
        { id: 'a', label: 'first' },
        { id: 'b', label: 'second' },
      ],
      onSelect: () => undefined,
      onClose: () => undefined,
    }))
    expect(html).toContain('composer__mention-item--active')
    expect(html).toContain('aria-selected="true"')
  })

  it('places the authorize row after the candidates behind a divider', () => {
    // 设计稿 NdCPW：授权动作行位于候选列表之后、分隔线下方（列表的延续动作）。
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'file', triggerStart: 0, queryEnd: 1, query: '' },
      candidates: [{ id: 'a', label: 'first' }],
      onSelect: () => undefined,
      onClose: () => undefined,
      onAuthorizeFile: () => undefined,
      onAuthorizeDirectory: () => undefined,
    }))
    expect(html).toContain('composer__mention-divider')
    const listIndex = html.indexOf('composer__mention-item')
    const dividerIndex = html.indexOf('composer__mention-divider')
    const actionsIndex = html.indexOf('composer__mention-actions')
    expect(listIndex).toBeGreaterThan(-1)
    expect(dividerIndex).toBeGreaterThan(listIndex)
    expect(actionsIndex).toBeGreaterThan(dividerIndex)
  })

  it('keeps the authorize row visible for file mode when candidates are empty', () => {
    // 空态下「选择文件/目录」是主出路，必须仍然可见。
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'file', triggerStart: 0, queryEnd: 4, query: '' },
      candidates: [],
      onSelect: () => undefined,
      onClose: () => undefined,
      onAuthorizeFile: () => undefined,
      onAuthorizeDirectory: () => undefined,
    }))
    expect(html).toContain('尚未添加文件或目录引用')
    expect(html).toContain('选择文件…')
    expect(html).toContain('选择目录…')
  })

  it('groups file candidates by source and pins the actions outside the scroll area', () => {
    const html = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'file', triggerStart: 0, queryEnd: 1, query: '' },
      candidates: [
        { id: '/ws/authz', label: 'authz', hint: '…/github/licensor', group: 'referenced' },
        { id: '/ws/website', label: 'website', hint: '目录', group: 'workspace' },
      ],
      onSelect: () => undefined,
      onClose: () => undefined,
      onAuthorizeFile: () => undefined,
      onAuthorizeDirectory: () => undefined,
    }))
    expect(html).toContain('已引用')
    expect(html).toContain('工作区匹配')
    const scrollIndex = html.indexOf('composer__mention-scroll')
    const footerIndex = html.indexOf('composer__mention-footer')
    expect(scrollIndex).toBeGreaterThan(-1)
    expect(footerIndex).toBeGreaterThan(scrollIndex)
    // 动作行位于滚动区之外（footer 之后），候选再多也不会被挤出视野。
    expect(html.indexOf('选择文件…')).toBeGreaterThan(footerIndex)
  })

  it('tells "no match" apart from "no references yet"', () => {
    const noMatch = renderToStaticMarkup(createElement(MentionPopover, {
      active: { kind: 'file', triggerStart: 0, queryEnd: 3, query: 'zzz' },
      candidates: [{ id: '/ws/authz', label: 'authz', group: 'referenced' }],
      onSelect: () => undefined,
      onClose: () => undefined,
    }))
    expect(noMatch).toContain('没有匹配的文件或目录')
  })
})

describe('sectionizeCandidates', () => {
  it('keeps global highlight indices while bucketing by group order', () => {
    const sections = sectionizeCandidates([
      { id: 'a', label: 'a', group: 'referenced' },
      { id: 'b', label: 'b', group: 'workspace' },
      { id: 'c', label: 'c', group: 'referenced' },
    ])
    expect(sections.map((section) => section.group)).toEqual(['referenced', 'workspace'])
    expect(sections[0]?.items.map((item) => item.index)).toEqual([0, 2])
    expect(sections[1]?.items.map((item) => item.index)).toEqual([1])
  })
})

describe('resolveMentionKeyAction', () => {
  it('moves the highlight cyclically without moving textarea focus', () => {
    expect(resolveMentionKeyAction('ArrowDown', 2, 1)).toEqual({ type: 'highlight', index: 0 })
    expect(resolveMentionKeyAction('ArrowUp', 2, 0)).toEqual({ type: 'highlight', index: 1 })
  })

  it('selects with Enter or Tab and always allows Escape to close', () => {
    expect(resolveMentionKeyAction('Enter', 2, 1)).toEqual({ type: 'select', index: 1 })
    expect(resolveMentionKeyAction('Tab', 2, 0)).toEqual({ type: 'select', index: 0 })
    expect(resolveMentionKeyAction('Escape', 0, 0)).toEqual({ type: 'close' })
  })
})
