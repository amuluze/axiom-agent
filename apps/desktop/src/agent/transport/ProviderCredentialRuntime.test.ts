import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMO_PROVIDER_CONFIG } from './provider'
import { TEST_ANTHROPIC_PROFILE } from '@/components/settings/sections/testFixtures'
import { BUILTIN_PROVIDER_REGISTRY } from './ProviderRegistry'
import {
  BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS,
  ProviderCredentialRuntime,
} from './ProviderCredentialRuntime'
import { bindProviderHost, type SecretStore } from './providerHost'
import { referenceProviderProfileParser } from './providerProfile'

const secretMocks = vi.hoisted(() => ({
  save: vi.fn(async () => undefined),
  has: vi.fn(async () => true),
  migrate: vi.fn(async () => true),
  delete: vi.fn(async () => undefined),
}))

const testSecretStore: SecretStore = {
  save: secretMocks.save,
  has: secretMocks.has,
  migrate: secretMocks.migrate,
  delete: secretMocks.delete,
}

describe('ProviderCredentialRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bindProviderHost({
      parser: referenceProviderProfileParser,
      secrets: testSecretStore,
      httpStream: () => {
        throw new Error('测试宿主不提供网络流')
      },
      probe: async () => {
        throw new Error('测试宿主不提供探针')
      },
    })
  })

  it('rejects normal credential writes outside the Profile Provider namespace', async () => {
    const runtime = new ProviderCredentialRuntime(BUILTIN_PROVIDER_REGISTRY)
    const crossProviderProfile = {
      ...TEST_ANTHROPIC_PROFILE,
      secretId: 'provider.openai-responses.api-key',
    }

    await expect(runtime.save(crossProviderProfile, 'key')).rejects.toThrow('身份不匹配')
    await expect(runtime.delete(crossProviderProfile)).rejects.toThrow('身份不匹配')
    expect(secretMocks.save).not.toHaveBeenCalled()
    expect(secretMocks.delete).not.toHaveBeenCalled()
  })

  it('normalizes auth-free Provider profiles before returning status', async () => {
    const runtime = new ProviderCredentialRuntime(BUILTIN_PROVIDER_REGISTRY)

    await expect(runtime.status({
      ...DEMO_PROVIDER_CONFIG,
      apiFormat: 'openai-responses',
    })).rejects.toThrow()
    expect(secretMocks.has).not.toHaveBeenCalled()
  })

  it('keeps legacy migration and source retirement behind a dedicated capability', async () => {
    const migrations = BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS
    const migration = {
      sourceSecretId: 'provider.anthropic-compatible.api-key',
      targetSecretId: 'provider.generic-anthropic-compatible.api-key',
    }

    const receipt = await migrations.migrate(TEST_ANTHROPIC_PROFILE, migration)
    expect(receipt).toMatchObject(migration)
    if (!receipt) throw new Error('缺少 Provider Secret migration receipt')
    await expect(migrations.retireSource(receipt)).resolves.toBeUndefined()
    await expect(migrations.retireSource(receipt)).rejects.toThrow('未获删除授权')

    expect(secretMocks.migrate).toHaveBeenCalledWith(
      migration.sourceSecretId,
      migration.targetSecretId,
    )
    expect(secretMocks.delete).toHaveBeenCalledWith(migration.sourceSecretId)
  })

  it('rejects cross-Provider migration targets and unknown legacy sources', async () => {
    const migrations = BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS

    await expect(migrations.migrate(TEST_ANTHROPIC_PROFILE, {
      sourceSecretId: 'provider.anthropic-compatible.api-key',
      targetSecretId: 'provider.openai-responses.api-key',
    })).rejects.toThrow('目标与 Provider 身份不匹配')
    await expect(migrations.migrate(TEST_ANTHROPIC_PROFILE, {
      sourceSecretId: 'provider.openai-compatible.api-key',
      targetSecretId: 'provider.generic-anthropic-compatible.api-key',
    })).rejects.toThrow('legacy namespace')
    await expect(migrations.retireLegacySource('provider.openai-compatible.api-key'))
      .rejects.toThrow('legacy namespace')
    expect(secretMocks.migrate).not.toHaveBeenCalled()
  })

  it('retries an authorized legacy cleanup without requiring a process-local receipt', async () => {
    const migrations = BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS
    secretMocks.has.mockResolvedValueOnce(false)

    await expect(migrations.retireLegacySource('provider.anthropic-compatible.api-key'))
      .resolves.toBeUndefined()

    expect(secretMocks.delete).not.toHaveBeenCalled()
  })
})
