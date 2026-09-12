import { describe, expect, it, vi } from 'vitest'
import {
  shouldCloseProviderSetup,
  submitProviderSettings,
} from './settingsUtils'

const DRAFT = {
  profileId: 'draft-profile',
  schemaVersion: 4 as const,
  providerId: 'generic-anthropic-compatible',
  apiFormat: 'anthropic-compatible',
  endpoint: 'https://example.test/v1/messages',
  modelId: 'claude-test',
  maxOutputTokens: 4096,
  contextWindow: 200_000,
  timeoutMs: 60_000,
  capabilities: { toolReferences: true, toolSearch: false },
} as const

describe('settingsUtils.shouldCloseProviderSetup', () => {
  it('closes first-run setup only after a ready Provider save', () => {
    expect(shouldCloseProviderSetup(true, { saved: true, ready: false })).toBe(false)
    expect(shouldCloseProviderSetup(true, { saved: false })).toBe(false)
    expect(shouldCloseProviderSetup(true, { saved: true, ready: true })).toBe(true)
    expect(shouldCloseProviderSetup(false, { saved: true, ready: true })).toBe(false)
  })
})

describe('settingsUtils.submitProviderSettings', () => {
  it('returns the unfailed result and skips cleanup when save did not persist', async () => {
    const save = vi.fn(async () => ({ saved: false } as const))
    const clearApiKey = vi.fn()
    const close = vi.fn()

    await expect(submitProviderSettings({
      draft: DRAFT,
      apiKey: 'keychain-write-fails',
      setupRequired: true,
      save,
      clearApiKey,
      close,
    })).resolves.toEqual({ saved: false })

    expect(save).toHaveBeenCalledWith(DRAFT, 'keychain-write-fails')
    expect(clearApiKey).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('closes the setup dialog only when the saved Provider is ready', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ saved: true, ready: false } as const)
      .mockResolvedValueOnce({ saved: true, ready: true } as const)
    const clearApiKey = vi.fn()
    const close = vi.fn()

    await expect(submitProviderSettings({
      draft: DRAFT,
      apiKey: 'k',
      setupRequired: true,
      save,
      clearApiKey,
      close,
    })).resolves.toEqual({ saved: true, ready: false })
    expect(close).not.toHaveBeenCalled()

    await expect(submitProviderSettings({
      draft: DRAFT,
      apiKey: 'k2',
      setupRequired: true,
      save,
      clearApiKey,
      close,
    })).resolves.toEqual({ saved: true, ready: true })
    expect(close).toHaveBeenCalledTimes(1)
    expect(clearApiKey).toHaveBeenCalledTimes(2)
  })
})
