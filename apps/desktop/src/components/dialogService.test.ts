import { describe, expect, it } from 'vitest'
import {
  confirmDialog,
  getDialogRequest,
  promptDialog,
  settleDialog,
} from './dialogService'

describe('dialogService', () => {
  it('resolves a confirm request from the host decision', async () => {
    const pending = confirmDialog({ message: 'Delete this?' })
    expect(getDialogRequest()?.kind).toBe('confirm')
    settleDialog(true)
    await expect(pending).resolves.toBe(true)
    expect(getDialogRequest()).toBeNull()
  })

  it('resolves a prompt request with the entered value or null on cancel', async () => {
    const accepted = promptDialog({ title: 'Rename', defaultValue: 'old' })
    settleDialog('new')
    await expect(accepted).resolves.toBe('new')

    const cancelled = promptDialog({ title: 'Rename' })
    settleDialog(null)
    await expect(cancelled).resolves.toBeNull()
  })

  it('cancels the previous request when a second dialog is opened', async () => {
    const first = confirmDialog({ message: 'first' })
    const second = promptDialog({ title: 'second' })
    await expect(first).resolves.toBe(false)
    settleDialog('value')
    await expect(second).resolves.toBe('value')
  })
})
