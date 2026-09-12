import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SummaryInstructionsDialog } from './SummaryInstructionsDialog'

describe('SummaryInstructionsDialog', () => {
  it('returns null when mode is null', () => {
    const html = renderToStaticMarkup(createElement(SummaryInstructionsDialog, {
      mode: null,
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(html).toBe('')
  })

  it('renders the compaction dialog with title and action', () => {
    const html = renderToStaticMarkup(createElement(SummaryInstructionsDialog, {
      mode: 'compaction',
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(html).toContain('压缩上下文')
    expect(html).toContain('开始压缩')
    expect(html).toContain('summary-instructions-dialog')
  })

  it('renders the branch dialog with title and action', () => {
    const html = renderToStaticMarkup(createElement(SummaryInstructionsDialog, {
      mode: 'branch',
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(html).toContain('总结后创建分支')
    expect(html).toContain('生成并分支')
  })

  it('displays the default empty byte count', () => {
    const html = renderToStaticMarkup(createElement(SummaryInstructionsDialog, {
      mode: 'compaction',
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(html).toContain('0 /')
  })

  it('shows the replace-instructions checkbox only in branch mode', () => {
    const compactionHtml = renderToStaticMarkup(createElement(SummaryInstructionsDialog, {
      mode: 'compaction',
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(compactionHtml).not.toContain('替换默认分支摘要指令')

    const branchHtml = renderToStaticMarkup(createElement(SummaryInstructionsDialog, {
      mode: 'branch',
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(branchHtml).toContain('替换默认分支摘要指令')
  })

  it('has the cancel button and the modal dialog role', () => {
    const html = renderToStaticMarkup(createElement(SummaryInstructionsDialog, {
      mode: 'compaction',
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(html).toContain('取消')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
  })
})