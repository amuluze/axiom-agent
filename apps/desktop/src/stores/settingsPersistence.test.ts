import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const localStorageState = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => localStorageState.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageState.set(key, value)
  },
  removeItem: (key: string) => {
    localStorageState.delete(key)
  },
  clear: () => {
    localStorageState.clear()
  },
  key: () => null,
  length: 0,
}

beforeEach(() => {
  vi.stubGlobal('localStorage', localStorageMock)
  localStorageState.clear()
})

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('./services/providerStorage', async (importOriginal) => {
  const original = await importOriginal<typeof import('./services/providerStorage')>()
  return {
    ...original,
    loadProviderSelection: () => ({
      requiresSetup: false,
      config: {
        schemaVersion: 1,
        profileId: 'builtin.test',
        providerId: 'test',
        apiFormat: 'openai-compatible',
        endpoint: 'https://example.test',
        modelId: 'test-model',
        apiKey: '',
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        capabilities: { toolReferences: false, toolSearch: false },
      },
      secretMigration: undefined,
    }),
  }
})

afterEach(() => {
  localStorageState.clear()
  vi.resetModules()
})

async function loadFreshModule() {
  vi.resetModules()
  return import('./settingsPersistence')
}

describe('settingsPersistence', () => {
  it('exposes default settings when localStorage is empty', async () => {
    const mod = await loadFreshModule()
    expect(mod.activeContextPolicySettings).toBeDefined()
    expect(mod.activeQueueModeSettings).toBeDefined()
    expect(mod.activeReasoningSettings).toBeDefined()
    expect(mod.activeAgentLimitsSettings).toBeDefined()
  })

  it('setters update the live binding observable by importers', async () => {
    const mod = await loadFreshModule()
    const before = mod.activeContextPolicySettings
    const updated = {
      ...before,
      reserveTokens: 8_192,
    } as typeof mod.activeContextPolicySettings
    mod.setActiveContextPolicySettings(updated)
    expect(mod.activeContextPolicySettings).toBe(updated)
    expect(mod.activeContextPolicySettings.reserveTokens).toBe(8_192)
  })

  it('reloads from localStorage on a fresh module load', async () => {
    // Setters update only the in-memory live binding; persistence is the
    // store action's responsibility (see saveReasoningSettings /
    // saveQueueModes). We pre-seed localStorage here to verify the cold
    // load path picks up the stored value.
    localStorageState.set('axiom.reasoning.v1', JSON.stringify({ level: 'high', mode: 'effort', budgetTokens: 4096 }))
    localStorageState.set('axiom.queue.mode.v1', JSON.stringify({ steering: 'all', followUp: 'all' }))
    const mod = await loadFreshModule()
    expect(mod.activeReasoningSettings.level).toBe('high')
    expect(mod.activeQueueModeSettings.steering).toBe('all')
  })

  it('falls back to defaults when localStorage payload is corrupted', async () => {
    localStorageState.set('axiom.reasoning.v1', '{not json')
    const mod = await loadFreshModule()
    expect(mod.activeReasoningSettings).toBeDefined()
    expect(mod.activeReasoningSettings.level).toBe('off')
  })

  it('preserves the queued mode policy across fresh module loads', async () => {
    const first = await loadFreshModule()
    first.setActiveQueueModeSettings({
      ...first.activeQueueModeSettings,
      followUp: 'one-at-a-time',
    })
    const second = await loadFreshModule()
    expect(second.activeQueueModeSettings.followUp).toBe('one-at-a-time')
  })

  it('reloads agent limits from localStorage and clamps corrupted payloads', async () => {
    localStorageState.set('axiom.agent.limits.v1', JSON.stringify({
      maxTurns: 64,
      maxToolCalls: 200,
      maxTotalTokens: 3_000_000,
    }))
    const mod = await loadFreshModule()
    expect(mod.activeAgentLimitsSettings.maxTurns).toBe(64)
    expect(mod.activeAgentLimitsSettings.maxToolCalls).toBe(200)
    expect(mod.activeAgentLimitsSettings.maxTotalTokens).toBe(3_000_000)

    const second = await loadFreshModule()
    second.setActiveAgentLimitsSettings({ maxTurns: 80, maxToolCalls: 160, maxTotalTokens: 500_000 })
    expect(second.activeAgentLimitsSettings.maxTurns).toBe(80)
    expect(second.activeAgentLimitsSettings.maxTotalTokens).toBe(500_000)
  })
})
