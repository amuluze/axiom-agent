// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DialogHost } from './DialogHost'
import { confirmDialog, promptDialog, settleDialog } from './dialogService'

afterEach(() => {
  settleDialog(false)
})

describe('DialogHost interactions', () => {
  it('cancels a confirmation with Escape', async () => {
    const pending = confirmDialog({ message: '确定删除吗？' })
    render(<DialogHost />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    await expect(pending).resolves.toBe(false)
  })

  it('submits a prompt with Enter in the input', async () => {
    const pending = promptDialog({ title: '重命名', defaultValue: 'old' })
    render(<DialogHost />)

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'new' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await expect(pending).resolves.toBe('new')
  })

  it('resolves null when the prompt is cancelled by clicking cancel', async () => {
    const pending = promptDialog({ title: '重命名', defaultValue: 'old' })
    render(<DialogHost />)

    fireEvent.click(screen.getByRole('button', { name: /取消|Cancel/ }))

    await expect(pending).resolves.toBeNull()
  })
})
