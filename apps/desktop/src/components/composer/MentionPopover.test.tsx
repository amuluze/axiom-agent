import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MentionPopover, resolveMentionKeyAction } from './MentionPopover'

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
