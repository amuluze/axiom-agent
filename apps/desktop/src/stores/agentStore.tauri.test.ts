import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'
import type {
  ProviderProfilePersistenceMigration,
  SessionRepository,
} from '@/persistence/types'
import {
  deleteSecret,
  hasSecret,
  migrateSecret,
  saveSecret,
} from '@/platform/secrets'
import { defaultProviderProfile } from '@/agent/transport/provider'
import { TEST_ANTHROPIC_PROFILE } from '@/agent/transport/__fixtures__/testAnthropicProfile'

// 覆盖 agentStore 模块加载时绑定的 Rust 宿主：测试环境无 Tauri command，解析用
// reference 实现，密钥走下面 mock 的 platform/secrets。afterEach 的 vi.resetModules
// 会刷新模块实例，因此这里动态 import providerHost/providerProfile，与 store 用的是
// 同一实例。
const loadAgentStore = async (): Promise<typeof import('./agentStore')> => {
  const mod = await import('./agentStore')
  const { bindProviderHost } = await import('@/agent/transport/providerHost')
  const { referenceProviderProfileParser } = await import('@/agent/transport/providerProfile')
  bindProviderHost({
    parser: referenceProviderProfileParser,
    secrets: { save: saveSecret, has: hasSecret, migrate: migrateSecret, delete: deleteSecret },
    httpStream: () => {
      throw new Error('测试宿主不提供网络流')
    },
    probe: async () => {
      throw new Error('测试宿主不提供探针')
    },
  })
  return mod
}

const mocks = vi.hoisted(() => ({
  repository: undefined as SessionRepository | undefined,
  secrets: new Map<string, string>(),
  saveSecretError: undefined as Error | undefined,
  deleteSecretError: undefined as Error | undefined,
  cleanupIntentLoadError: undefined as Error | undefined,
  cleanupIntentPersistError: undefined as Error | undefined,
  cleanupIntent: [] as string[],
  authorizedWorkspaces: [] as Array<{
    path: string
    name: string
    gitBranch?: string | null
  }>,
  workspaceSelection: null as {
    path: string
    name: string
    gitBranch?: string | null
  } | null,
  saveSecret: vi.fn(async (key: string, value: string) => {
    if (mocks.saveSecretError) throw mocks.saveSecretError
    mocks.secrets.set(key, value)
  }),
  migrateSecret: vi.fn(async (sourceKey: string, targetKey: string) => {
    if (mocks.secrets.has(targetKey)) return true
    const value = mocks.secrets.get(sourceKey)
    if (!value) return false
    mocks.secrets.set(targetKey, value)
    return true
  }),
  deleteSecret: vi.fn(async (key: string) => {
    if (mocks.deleteSecretError) throw mocks.deleteSecretError
    mocks.secrets.delete(key)
  }),
}))

vi.mock('@/persistence/createSessionRepository', () => ({
  createSessionRepository: vi.fn(async () => {
    if (!mocks.repository) throw new Error('missing test repository')
    return mocks.repository
  }),
}))

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@/platform/runtimeFaultInjection', () => ({
  runtimeFaultCheckpoint: vi.fn(async () => undefined),
}))

vi.mock('@/platform/secrets', () => ({
  saveSecret: mocks.saveSecret,
  hasSecret: vi.fn(async (key: string) => mocks.secrets.has(key)),
  migrateSecret: mocks.migrateSecret,
  deleteSecret: mocks.deleteSecret,
  loadProviderSecretCleanupIntent: vi.fn(async () => {
    if (mocks.cleanupIntentLoadError) throw mocks.cleanupIntentLoadError
    return [...mocks.cleanupIntent]
  }),
  persistProviderSecretCleanupIntent: vi.fn(async (sourceSecretIds: string[]) => {
    if (mocks.cleanupIntentPersistError) throw mocks.cleanupIntentPersistError
    mocks.cleanupIntent = [...sourceSecretIds]
  }),
}))

vi.mock('@/platform/authorizedFiles', () => ({
  listAuthorizedReadFiles: vi.fn(async () => []),
  revokeAuthorizedReadFile: vi.fn(),
  selectAndAuthorizeReadFile: vi.fn(),
  selectAndAuthorizeReadDirectory: vi.fn(),
}))

vi.mock('@/platform/workspace', () => ({
  activateAuthorizedWorkspace: vi.fn(async (path: string) => {
    const workspace = mocks.authorizedWorkspaces.find((candidate) => candidate.path === path)
    if (!workspace) throw new Error('workspace is not authorized')
    return structuredClone(workspace)
  }),
  getAuthorizedWorkspace: vi.fn(async () => (
    structuredClone(mocks.authorizedWorkspaces.at(-1) ?? null)
  )),
  getAuthorizedWorkspaces: vi.fn(async () => structuredClone(mocks.authorizedWorkspaces)),
  restoreAuthorizedWorkspaces: vi.fn(async (paths: string[]) => {
    for (const path of paths) {
      if (!mocks.authorizedWorkspaces.some((workspace) => workspace.path === path)) {
        mocks.authorizedWorkspaces.push({
          path,
          name: path.split('/').filter(Boolean).at(-1) ?? path,
          gitBranch: null,
        })
      }
    }
    return {
      workspaces: structuredClone(mocks.authorizedWorkspaces),
      failedPaths: [],
    }
  }),
  revokeWorkspace: vi.fn(async (path: string) => {
    const before = mocks.authorizedWorkspaces.length
    mocks.authorizedWorkspaces = mocks.authorizedWorkspaces.filter((workspace) => workspace.path !== path)
    return mocks.authorizedWorkspaces.length < before
  }),
  selectAndAuthorizeWorkspace: vi.fn(async () => {
    const workspace = mocks.workspaceSelection
    if (!workspace) return null
    if (!mocks.authorizedWorkspaces.some((candidate) => candidate.path === workspace.path)) {
      mocks.authorizedWorkspaces.push(structuredClone(workspace))
    }
    return structuredClone(workspace)
  }),
}))

const localStorageState = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => localStorageState.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageState.set(key, value)
  },
  removeItem: (key: string) => {
    localStorageState.delete(key)
  },
  clear: () => localStorageState.clear(),
  key: (index: number) => [...localStorageState.keys()][index] ?? null,
  get length() {
    return localStorageState.size
  },
}

class MigratingMemorySessionRepository extends MemorySessionRepository {
  constructor(private pending: ProviderProfilePersistenceMigration[]) {
    super()
  }

  override async prepareProviderProfileMigrations(): Promise<ProviderProfilePersistenceMigration[]> {
    return structuredClone(this.pending)
  }

  override async commitProviderProfileMigrations(
    migrations: ProviderProfilePersistenceMigration[],
  ): Promise<void> {
    expect(migrations).toEqual(this.pending)
    this.pending = []
  }
}

class RecoveryGatedMemorySessionRepository extends MemorySessionRepository {
  readonly lifecycle: string[] = []
  private recovered = false

  override async initialize(...args: Parameters<MemorySessionRepository['initialize']>) {
    this.lifecycle.push('initialize')
    this.recovered = true
    return super.initialize(...args)
  }

  override async prepareProviderProfileMigrations(): Promise<ProviderProfilePersistenceMigration[]> {
    if (!this.recovered) throw new Error('Provider Profile migration started before recovery')
    this.lifecycle.push('prepare')
    return []
  }

  override async commitProviderProfileMigrations(
    migrations: ProviderProfilePersistenceMigration[],
  ): Promise<void> {
    expect(migrations).toEqual([])
    this.lifecycle.push('commit')
  }
}

class FailingProviderCommitRepository extends MemorySessionRepository {
  override async commitProviderProfileMigrations(): Promise<void> {
    throw new Error('injected Provider Profile commit failure')
  }
}

class CommittedThenInterruptedRepository extends MigratingMemorySessionRepository {
  private interrupted = false

  override async commitProviderProfileMigrations(
    migrations: ProviderProfilePersistenceMigration[],
  ): Promise<void> {
    await super.commitProviderProfileMigrations(migrations)
    if (!this.interrupted) {
      this.interrupted = true
      throw new Error('injected interruption after Provider Profile commit')
    }
  }
}

class RetainedProviderMigrationRepository extends MemorySessionRepository {
  constructor(private readonly pending: ProviderProfilePersistenceMigration[]) {
    super()
  }

  override async prepareProviderProfileMigrations(): Promise<ProviderProfilePersistenceMigration[]> {
    return structuredClone(this.pending)
  }

  override async commitProviderProfileMigrations(): Promise<void> {}
}

describe('agentStore Tauri Provider Secret lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    localStorageState.clear()
    mocks.secrets.clear()
    mocks.saveSecretError = undefined
    mocks.deleteSecretError = undefined
    mocks.cleanupIntentLoadError = undefined
    mocks.cleanupIntentPersistError = undefined
    mocks.cleanupIntent = []
    mocks.authorizedWorkspaces = []
    mocks.workspaceSelection = null
    mocks.repository = new MemorySessionRepository()
    vi.stubGlobal('localStorage', localStorageMock)
  })

  it('blocks structural mutations until desktop initialization reaches ready', { timeout: 15_000 }, async () => {
    const { useAgentStore } = await loadAgentStore()

    expect(useAgentStore.getState().runtimeLifecycle).toBe('initializing')
    await expect(useAgentStore.getState().createNewSession()).resolves.toBe(false)
    await expect(useAgentStore.getState().saveProvider(TEST_ANTHROPIC_PROFILE)).resolves.toEqual({
      saved: false,
    })
    expect(useAgentStore.getState().sessions).toEqual([])

    await useAgentStore.getState().initialize()

    expect(useAgentStore.getState().runtimeLifecycle).toBe('ready')
    expect(useAgentStore.getState().activeSessionId).toBeTruthy()
  })

  it('migrates a V2 Secret once and does not restore it after deletion', async () => {
    const legacyProfile = {
      ...TEST_ANTHROPIC_PROFILE,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    }
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(legacyProfile))
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(mocks.migrateSecret).toHaveBeenCalledOnce()
    expect(mocks.secrets.has('provider.generic-anthropic-compatible.api-key')).toBe(true)
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(false)
    expect(JSON.parse(localStorage.getItem('axiom.provider.config.v1')!)).toMatchObject({
      schemaVersion: 4,
      secretId: 'provider.generic-anthropic-compatible.api-key',
    })

    await expect(useAgentStore.getState().deleteProviderKey()).resolves.toBe(true)

    expect(mocks.migrateSecret).toHaveBeenCalledOnce()
    expect(mocks.secrets.has('provider.generic-anthropic-compatible.api-key')).toBe(false)
    expect(useAgentStore.getState().providerHasKey).toBe(false)
  })

  it('recovers interrupted runtime state before preparing Provider Profile migrations', async () => {
    const repository = new RecoveryGatedMemorySessionRepository()
    mocks.repository = repository

    const { useAgentStore } = await loadAgentStore()
    await expect(useAgentStore.getState().initialize()).resolves.toBeUndefined()

    expect(repository.lifecycle).toEqual(['initialize', 'prepare', 'commit'])
  })

  it('retains legacy Profile metadata and Secret when Provider commit fails, then retries safely', async () => {
    const legacyProfile = {
      ...TEST_ANTHROPIC_PROFILE,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    }
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(legacyProfile))
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')
    mocks.repository = new FailingProviderCommitRepository()

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(useAgentStore.getState().settingsError).toContain('commit failure')
    expect(JSON.parse(localStorage.getItem('axiom.provider.config.v1')!)).toMatchObject({
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    })
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(true)
    expect(mocks.secrets.has('provider.generic-anthropic-compatible.api-key')).toBe(true)
    expect(mocks.cleanupIntent).toEqual(['provider.anthropic-compatible.api-key'])

    mocks.repository = new MemorySessionRepository()
    vi.resetModules()
    const { useAgentStore: retriedStore } = await loadAgentStore()
    await retriedStore.getState().initialize()

    expect(retriedStore.getState().initializationError).toBeNull()
    expect(JSON.parse(localStorage.getItem('axiom.provider.config.v1')!)).toMatchObject({
      schemaVersion: 4,
      secretId: 'provider.generic-anthropic-compatible.api-key',
    })
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(false)
  })

  it('persists cleanup intent before copying a Secret or committing a Profile', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify({
      ...TEST_ANTHROPIC_PROFILE,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    }))
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')
    mocks.migrateSecret.mockImplementationOnce(async (sourceKey: string, targetKey: string) => {
      expect(mocks.cleanupIntent).toEqual(['provider.anthropic-compatible.api-key'])
      mocks.secrets.set(targetKey, mocks.secrets.get(sourceKey)!)
      return true
    })

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(mocks.migrateSecret).toHaveBeenCalledOnce()
    expect(mocks.cleanupIntent).toEqual([])
  })

  it('fails closed before Secret copy when cleanup intent cannot be persisted', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify({
      ...TEST_ANTHROPIC_PROFILE,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    }))
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')
    mocks.cleanupIntentPersistError = new Error('injected native journal failure')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(useAgentStore.getState().settingsError)
      .toContain('旧 Provider Secret 清理意图无法持久化')
    expect(mocks.migrateSecret).not.toHaveBeenCalled()
    expect(mocks.secrets.has('provider.generic-anthropic-compatible.api-key')).toBe(false)
  })

  it('cleans a staged legacy Secret after restart from a post-commit interruption', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    const migration: ProviderProfilePersistenceMigration = {
      sessionId: 'legacy-anthropic',
      expectedProviderConfigJson: '{"schemaVersion":2,"providerId":"generic-anthropic-compatible"}',
      profile: TEST_ANTHROPIC_PROFILE,
      secretMigration: {
        sourceSecretId: 'provider.anthropic-compatible.api-key',
        targetSecretId: 'provider.generic-anthropic-compatible.api-key',
      },
    }
    const repository = new CommittedThenInterruptedRepository([migration])
    mocks.repository = repository
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(useAgentStore.getState().settingsError)
      .toContain('interruption after Provider Profile commit')
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(true)
    expect(mocks.cleanupIntent).toEqual(['provider.anthropic-compatible.api-key'])

    vi.resetModules()
    const { useAgentStore: restartedStore } = await loadAgentStore()
    await restartedStore.getState().initialize()

    expect(restartedStore.getState().initializationError).toBeNull()
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(false)
    expect(mocks.cleanupIntent).toEqual([])
  })

  it('does not delete a staged Secret while a stored Profile still references it', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    const migration: ProviderProfilePersistenceMigration = {
      sessionId: 'legacy-anthropic',
      expectedProviderConfigJson: '{"schemaVersion":2,"providerId":"generic-anthropic-compatible"}',
      profile: TEST_ANTHROPIC_PROFILE,
      secretMigration: {
        sourceSecretId: 'provider.anthropic-compatible.api-key',
        targetSecretId: 'provider.generic-anthropic-compatible.api-key',
      },
    }
    mocks.repository = new RetainedProviderMigrationRepository([migration])
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(useAgentStore.getState().initializationError).toBeNull()
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(true)
    expect(mocks.cleanupIntent).toEqual(['provider.anthropic-compatible.api-key'])
  })

  it('does not migrate a canonical V3 Profile', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'unreferenced-but-unobserved')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(mocks.migrateSecret).not.toHaveBeenCalled()
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(true)
  })

  it('does not overwrite an existing Provider-scoped target during migration', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify({
      ...TEST_ANTHROPIC_PROFILE,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    }))
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')
    mocks.secrets.set('provider.generic-anthropic-compatible.api-key', 'current-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(mocks.secrets.get('provider.generic-anthropic-compatible.api-key')).toBe('current-key')
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(false)
  })

  it('retries legacy Secret cleanup after an application restart', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify({
      ...TEST_ANTHROPIC_PROFILE,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    }))
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')
    mocks.deleteSecretError = new Error('injected Keychain cleanup failure')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(useAgentStore.getState().settingsError).toContain('旧 Provider Secret 清理失败')
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(true)
    expect(mocks.cleanupIntent).toEqual(['provider.anthropic-compatible.api-key'])

    mocks.deleteSecretError = undefined
    mocks.repository = new MemorySessionRepository()
    vi.resetModules()
    const { useAgentStore: restartedStore } = await loadAgentStore()
    await restartedStore.getState().initialize()

    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(false)
    expect(mocks.cleanupIntent).toEqual([])
  })

  it('reports a corrupt Secret cleanup tombstone without deleting uncertain keys', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    mocks.cleanupIntentLoadError = new Error('corrupt native journal')
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'legacy-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(useAgentStore.getState().settingsError).toContain('清理状态已损坏')
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(true)
    expect(mocks.cleanupIntent).toEqual([])
  })

  it('copies one shared legacy Session Secret to every Profile target before GC', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    const secondProfile = {
      ...defaultProviderProfile('generic-anthropic-compatible'),
      profileId: 'test.anthropic.second',
      modelId: 'claude-compatible',
    }
    mocks.repository = new MigratingMemorySessionRepository([
      {
        sessionId: 'legacy-anthropic',
        expectedProviderConfigJson: '{"schemaVersion":2,"providerId":"generic-anthropic-compatible"}',
        profile: TEST_ANTHROPIC_PROFILE,
        secretMigration: {
          sourceSecretId: 'provider.anthropic-compatible.api-key',
          targetSecretId: 'provider.generic-anthropic-compatible.api-key',
        },
      },
      {
        sessionId: 'legacy-anthropic-second',
        expectedProviderConfigJson: '{"schemaVersion":2,"providerId":"generic-anthropic-compatible"}',
        profile: secondProfile,
        secretMigration: {
          sourceSecretId: 'provider.anthropic-compatible.api-key',
          targetSecretId: 'provider.generic-anthropic-compatible.api-key',
        },
      },
    ])
    mocks.secrets.set('provider.anthropic-compatible.api-key', 'shared-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    expect(mocks.secrets.get('provider.generic-anthropic-compatible.api-key')).toBe('shared-key')
    expect(mocks.secrets.has('provider.anthropic-compatible.api-key')).toBe(false)
  })

  it('keeps a required Provider in setup state when no Key is configured', async () => {
    // openai 强制要求 API Key，在未配置 Key 时必须停留在 setup 状态
    // （历史上由内置 minimax 入口承担该断言，入口移除后改用 openai）。
    const requiredProfile = {
      ...defaultProviderProfile('openai'),
      modelId: 'gpt-5',
    }
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(requiredProfile))

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    const result = await useAgentStore.getState().saveProvider(requiredProfile)

    expect(result).toEqual({ saved: true, ready: false })
    expect(useAgentStore.getState()).toMatchObject({
      providerHasKey: false,
      providerSetupRequired: true,
    })
  })

  it('reports Keychain save failures without committing a staged Secret', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    mocks.saveSecretError = new Error('Keychain save failed')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    const result = await useAgentStore.getState().saveProvider(
      TEST_ANTHROPIC_PROFILE,
      'new-key',
    )

    expect(result).toEqual({ saved: false })
    expect(useAgentStore.getState().settingsError).toBe('Keychain save failed')
    expect([...mocks.secrets.keys()].some((key) => key.startsWith('provider.generic-anthropic-compatible.api-key.')))
      .toBe(false)
  })

  it('adds a second Provider profile without retiring the retained profile Secret', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    mocks.secrets.set('provider.generic-anthropic-compatible.api-key', 'anthropic-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    const result = await useAgentStore.getState().saveProvider({
      ...defaultProviderProfile('openai'),
      modelId: 'gpt-5',
    }, 'openai-key')

    expect(result).toEqual({ saved: true, ready: true })
    expect(useAgentStore.getState().provider).toMatchObject({
      providerId: 'openai',
      apiFormat: 'openai-responses',
    })
    expect(useAgentStore.getState().providerHasKey).toBe(true)
    expect([...mocks.secrets.entries()]).toContainEqual([
      expect.stringMatching(/^provider\.openai-responses\.api-key\./),
      'openai-key',
    ])
    expect(mocks.secrets.has('provider.generic-anthropic-compatible.api-key')).toBe(true)
    expect(useAgentStore.getState().providerProfiles).toHaveLength(2)
  })

  it('retires the previous Secret when the same profile is changed to another Provider', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    mocks.secrets.set('provider.generic-anthropic-compatible.api-key', 'anthropic-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    const result = await useAgentStore.getState().saveProvider({
      ...defaultProviderProfile('openai'),
      profileId: TEST_ANTHROPIC_PROFILE.profileId,
      modelId: 'gpt-5',
    }, 'openai-key')

    expect(result).toEqual({ saved: true, ready: true })
    expect(useAgentStore.getState().providerProfiles).toHaveLength(1)
    expect(useAgentStore.getState().provider.providerId).toBe('openai')
    expect(mocks.secrets.has('provider.generic-anthropic-compatible.api-key')).toBe(false)
  })

  it('switches and removes persisted profiles through the Session runtime update path', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    mocks.secrets.set('provider.generic-anthropic-compatible.api-key', 'anthropic-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    const openai = {
      ...defaultProviderProfile('openai'),
      modelId: 'gpt-5',
    }
    await expect(useAgentStore.getState().saveProvider(openai, 'openai-key')).resolves.toEqual({
      saved: true,
      ready: true,
    })

    await expect(useAgentStore.getState().switchProviderProfile(
      TEST_ANTHROPIC_PROFILE.profileId,
    )).resolves.toBe(true)
    expect(useAgentStore.getState().provider.profileId).toBe(TEST_ANTHROPIC_PROFILE.profileId)
    const activeSessionId = useAgentStore.getState().activeSessionId!
    await expect(mocks.repository!.loadSession(activeSessionId)).resolves.toMatchObject({
      session: {
        providerConfig: { profileId: TEST_ANTHROPIC_PROFILE.profileId },
      },
    })
    expect(JSON.parse(localStorage.getItem('axiom.provider.profiles.v1')!)).toMatchObject({
      schemaVersion: 1,
      activeProfileId: TEST_ANTHROPIC_PROFILE.profileId,
      profiles: [{ profileId: TEST_ANTHROPIC_PROFILE.profileId }, { profileId: openai.profileId }],
    })

    await expect(useAgentStore.getState().deleteProviderProfile(openai.profileId)).resolves.toBe(true)
    expect(useAgentStore.getState().providerProfiles).toEqual([
      expect.objectContaining({ profileId: TEST_ANTHROPIC_PROFILE.profileId }),
    ])
    expect([...mocks.secrets.keys()].some((key) => key.startsWith('provider.openai-responses.api-key.')))
      .toBe(false)
  })

  it('refreshes the persisted session systemPrompt identity after switching provider', async () => {
    localStorage.setItem('axiom.provider.config.v1', JSON.stringify(TEST_ANTHROPIC_PROFILE))
    mocks.secrets.set('provider.generic-anthropic-compatible.api-key', 'anthropic-key')

    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    // 初始 provider 为 anthropic（modelId=claude-test 不在内置 catalog，无身份行）。
    const activeSessionId = useAgentStore.getState().activeSessionId!
    const before = await mocks.repository!.loadSession(activeSessionId)
    expect(before.session.systemPrompt).not.toContain('DeepSeek')

    const deepseek = { ...defaultProviderProfile('deepseek') }
    await expect(useAgentStore.getState().saveProvider(deepseek, 'deepseek-key')).resolves.toEqual({
      saved: true,
      ready: true,
    })
    await expect(useAgentStore.getState().switchProviderProfile(
      deepseek.profileId,
    )).resolves.toBe(true)

    // 切换后持久化会话的系统提示必须反映新模型身份（Composer 问「你是谁」的权威来源）。
    const stored = await mocks.repository!.loadSession(useAgentStore.getState().activeSessionId!)
    expect(stored.session.systemPrompt).toContain('DeepSeek Flash')
    expect(stored.session.modelId).toBe('deepseek-flash')

    // 运行时 session（AgentHarness）的 systemPrompt 必须同步为同一身份行，
    // 否则持久化正确但运行时回答仍用旧身份。
    const { getRuntimeSession } = await import('@/stores/runtimeCaches')
    const runtime = getRuntimeSession(useAgentStore.getState().activeSessionId!)
    expect(runtime).toBeDefined()
    const runtimeSystemPrompt = (runtime as unknown as {
      session: { context: { systemPrompt: string } }
    }).session.context.systemPrompt
    expect(runtimeSystemPrompt).toContain('DeepSeek Flash')
  })

  it('adds independent sessions for multiple authorized workspaces', async () => {
    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    const initialSessionId = useAgentStore.getState().activeSessionId

    mocks.workspaceSelection = { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' }
    await expect(useAgentStore.getState().addWorkspace()).resolves.toBe(true)
    const alphaSessionId = useAgentStore.getState().activeSessionId
    expect(alphaSessionId).toBe(initialSessionId)

    mocks.workspaceSelection = { path: '/repo/beta', name: 'beta', gitBranch: 'feat-parallel' }
    await expect(useAgentStore.getState().addWorkspace()).resolves.toBe(true)
    const state = useAgentStore.getState()

    expect(state.activeSessionId).not.toBe(alphaSessionId)
    expect(state.authorizedWorkspaces).toEqual([
      expect.objectContaining({ path: '/repo/alpha', gitBranch: 'main' }),
      expect.objectContaining({ path: '/repo/beta', gitBranch: 'feat-parallel' }),
    ])
    expect(state.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alphaSessionId, workspace: { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' } }),
      expect.objectContaining({ id: state.activeSessionId, workspace: { path: '/repo/beta', name: 'beta', gitBranch: 'feat-parallel' } }),
    ]))

    await expect(useAgentStore.getState().activateWorkspace('/repo/alpha')).resolves.toBe(true)
    expect(useAgentStore.getState()).toMatchObject({
      activeSessionId: alphaSessionId,
      authorizedWorkspace: { path: '/repo/alpha', gitBranch: 'main' },
    })

    await expect(useAgentStore.getState().createNewSession('/repo/beta')).resolves.toBe(true)
    expect(useAgentStore.getState()).toMatchObject({
      authorizedWorkspace: { path: '/repo/beta', gitBranch: 'feat-parallel' },
    })
    expect(useAgentStore.getState().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alphaSessionId, workspace: { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' } }),
      expect.objectContaining({ id: useAgentStore.getState().activeSessionId, workspace: { path: '/repo/beta', name: 'beta', gitBranch: 'feat-parallel' } }),
    ]))
    expect(useAgentStore.getState().sessions.every((stored) => Boolean(stored.workspace))).toBe(true)
  })

  it('removes a workspace permanently so it does not reappear after restart', async () => {
    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    mocks.workspaceSelection = { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' }
    await expect(useAgentStore.getState().addWorkspace()).resolves.toBe(true)
    const alphaSessionId = useAgentStore.getState().activeSessionId

    mocks.workspaceSelection = { path: '/repo/beta', name: 'beta', gitBranch: 'feat-parallel' }
    await expect(useAgentStore.getState().addWorkspace()).resolves.toBe(true)

    await expect(useAgentStore.getState().revokeWorkspace('/repo/alpha')).resolves.toBe(true)

    const stateAfterRevoke = useAgentStore.getState()
    expect(stateAfterRevoke.authorizedWorkspaces).not.toContainEqual(expect.objectContaining({
      path: '/repo/alpha',
    }))
    expect(stateAfterRevoke.sessions.find((stored) => stored.id === alphaSessionId)?.workspace)
      .toBeNull()

    mocks.authorizedWorkspaces = mocks.authorizedWorkspaces.filter((workspace) => workspace.path !== '/repo/alpha')
    mocks.workspaceSelection = null
    vi.resetModules()
    const { useAgentStore: restartedStore } = await loadAgentStore()
    await restartedStore.getState().initialize()

    expect(restartedStore.getState().authorizedWorkspaces).not.toContainEqual(expect.objectContaining({
      path: '/repo/alpha',
    }))
    expect(restartedStore.getState().sessions.some((stored) => stored.workspace?.path === '/repo/alpha'))
      .toBe(false)
  })

  it('keeps localStorage workspace residue consistent when the SQLite clear fails during revoke', async () => {
    // 回归：撤销时 SQLite 清理失败（如 busy 超时）不得先行清空 localStorage——
    // 旧顺序（先 localStorage 后 SQLite）失败后会留下 DB 残留，重启时
    // hydrateSessionMetadata 的 DB→localStorage 反向同步把 workspace 写回，
    // 经 persistedWorkspacePaths → restoreAuthorizedWorkspaces 复活已撤销授权。
    // 顺序契约：SQLite 清理（跨层、可失败）在前，localStorage 清理（本地同步）在后；
    // 跨重启的最终防线是 Rust 侧注册表移除（revokeWorkspace 命令内先行执行）。
    class ClearWorkspaceFailureRepository extends MemorySessionRepository {
      override async clearWorkspaceForPath(): Promise<number> {
        throw new Error('simulated sqlite busy timeout')
      }
    }
    mocks.repository = new ClearWorkspaceFailureRepository()
    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()

    mocks.workspaceSelection = { path: '/repo/flaky', name: 'flaky', gitBranch: 'main' }
    await expect(useAgentStore.getState().addWorkspace()).resolves.toBe(true)
    const flakySessionId = useAgentStore.getState().activeSessionId

    await expect(useAgentStore.getState().revokeWorkspace('/repo/flaky')).resolves.toBe(false)
    expect(useAgentStore.getState().settingsError).toContain('simulated sqlite busy timeout')

    // DB 清理失败即中止：localStorage 的 workspace 绑定保持残留（与 DB 一致），
    // 不出现「localStorage 已清、DB 反写回来」的半清理状态。
    const stored = JSON.parse(
      localStorage.getItem('axiom.session.metadata.v1') ?? '{}',
    ) as Record<string, { workspace?: { path?: string } | null }>
    expect(stored[flakySessionId!]?.workspace?.path).toBe('/repo/flaky')
  })

  it('restores the active working directory after an application restart', async () => {
    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    mocks.workspaceSelection = { path: '/repo/persisted', name: 'persisted', gitBranch: 'main' }
    await expect(useAgentStore.getState().addWorkspace()).resolves.toBe(true)
    const activeSessionId = useAgentStore.getState().activeSessionId

    mocks.authorizedWorkspaces = []
    mocks.workspaceSelection = null
    vi.resetModules()
    const { useAgentStore: restartedStore } = await loadAgentStore()
    await restartedStore.getState().initialize()

    expect(restartedStore.getState()).toMatchObject({
      activeSessionId,
      authorizedWorkspace: {
        path: '/repo/persisted',
        name: 'persisted',
      },
    })
    expect(restartedStore.getState().authorizedWorkspaces).toContainEqual(expect.objectContaining({
      path: '/repo/persisted',
    }))
    expect(restartedStore.getState().sessions.find((stored) => stored.id === activeSessionId)?.workspace)
      .toMatchObject({ path: '/repo/persisted' })
  })

  it('refuses to create an unbound session', async () => {
    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    const before = useAgentStore.getState()

    await expect(useAgentStore.getState().createNewSession()).resolves.toBe(false)

    expect(useAgentStore.getState().activeSessionId).toBe(before.activeSessionId)
    expect(useAgentStore.getState().sessions).toHaveLength(before.sessions.length)
    expect(useAgentStore.getState().settingsError).toContain('工作目录')
  })

  it('archives, restores, and protects running sessions from destructive actions', async () => {
    const { useAgentStore } = await loadAgentStore()
    await useAgentStore.getState().initialize()
    mocks.workspaceSelection = { path: '/repo/archive', name: 'archive', gitBranch: 'main' }
    await expect(useAgentStore.getState().addWorkspace()).resolves.toBe(true)
    const originalSessionId = useAgentStore.getState().activeSessionId!
    await expect(useAgentStore.getState().createNewSession('/repo/archive')).resolves.toBe(true)
    const archivedSessionId = useAgentStore.getState().activeSessionId!

    await expect(useAgentStore.getState().archiveSession(archivedSessionId)).resolves.toBe(true)
    expect(useAgentStore.getState().activeSessionId).toBe(originalSessionId)
    expect(useAgentStore.getState().sessions.find((stored) => stored.id === archivedSessionId)?.archivedAt)
      .toEqual(expect.any(Number))

    await expect(useAgentStore.getState().restoreSession(archivedSessionId)).resolves.toBe(true)
    expect(useAgentStore.getState().sessions.find((stored) => stored.id === archivedSessionId)?.archivedAt)
      .toBeNull()

    useAgentStore.setState((state) => ({
      sessions: state.sessions.map((stored) => stored.id === archivedSessionId
        ? { ...stored, status: 'running' }
        : stored),
    }))
    await expect(useAgentStore.getState().archiveSession(archivedSessionId)).resolves.toBe(false)
    await expect(useAgentStore.getState().deleteSession(archivedSessionId)).resolves.toBe(false)
    expect(useAgentStore.getState().settingsError).toContain('运行中的会话不能删除')
  })
})
