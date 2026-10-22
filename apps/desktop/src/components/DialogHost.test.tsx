import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DialogHost } from './DialogHost'
import { confirmDialog, settleDialog } from './dialogService'

describe('DialogHost', () => {
  it('renders a pending confirmation as a focus-trapped modal', () => {
    const pending = confirmDialog({
      title: '删除会话',
      message: '确定删除吗？',
      confirmLabel: '删除',
      danger: true,
    })
    const html = renderToStaticMarkup(createElement(DialogHost))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('删除会话')
    expect(html).toContain('确定删除吗？')
    expect(html).toContain('app-dialog__button--danger')
    settleDialog(false)
    void pending
  })
})
