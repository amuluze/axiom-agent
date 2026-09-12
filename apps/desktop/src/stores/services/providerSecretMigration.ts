import type {
  ProviderProfile,
  ProviderSecretMigration,
  ProviderSecretMigrationReceipt,
} from '@/agent/transport/provider'
import { isTauriRuntime } from '@/platform/environment'
import { runtimeFaultCheckpoint } from '@/platform/runtimeFaultInjection'
import {
  loadProviderSecretCleanupIntent,
  persistProviderSecretCleanupIntent,
} from '@/platform/secrets'
import type {
  ProviderProfilePersistenceMigration,
  SessionRepository,
} from '@/persistence/types'
import { loadProviderSelection } from './providerStorage'

/**
 * Surface used by the Provider Secret migration service to operate on the
 * runtime-side credential migration singleton. Only the white-listed
 * `stores/agentStore.ts` is allowed to import the runtime singleton directly
 * (see `scripts/tauri-capability-audit.mjs:131`). Other files must receive a
 * fully bound view through this interface.
 */
export interface ProviderSecretMigrationBindings {
  migrate(profile: ProviderProfile, migration: ProviderSecretMigration): Promise<ProviderSecretMigrationReceipt | null>
  retireSource(receipt: ProviderSecretMigrationReceipt): Promise<void>
  retireLegacySource(sourceSecretId: string): Promise<void>
}

export const migrateProviderSecret = async (
  bindings: ProviderSecretMigrationBindings,
  profile: ProviderProfile,
  migration: ProviderSecretMigration | undefined,
): Promise<ProviderSecretMigrationReceipt | undefined> => {
  if (!isTauriRuntime() || !migration) return undefined
  return (await bindings.migrate(profile, migration)) ?? undefined
}

const loadPendingProviderSecretCleanup = async (): Promise<{
  sourceSecretIds: Set<string>
  warning: string | null
}> => {
  try {
    return {
      sourceSecretIds: new Set(await loadProviderSecretCleanupIntent()),
      warning: null,
    }
  } catch {
    return {
      sourceSecretIds: new Set(),
      warning: '旧 Provider Secret 清理状态已损坏，未执行不确定清理',
    }
  }
}

const persistPendingProviderSecretCleanup = async (sourceSecretIds: Set<string>): Promise<void> => {
  await persistProviderSecretCleanupIntent([...sourceSecretIds].sort())
}

export const stageProviderSecretCleanupIntent = async (
  localMigration: ProviderSecretMigration | undefined,
  profileMigrations: ProviderProfilePersistenceMigration[],
): Promise<void> => {
  if (!isTauriRuntime()) return
  const sourceSecretIds = new Set([
    ...(localMigration ? [localMigration.sourceSecretId] : []),
    ...profileMigrations.flatMap((migration) => (
      migration.secretMigration ? [migration.secretMigration.sourceSecretId] : []
    )),
  ])
  if (sourceSecretIds.size === 0) return
  const pendingCleanup = await loadPendingProviderSecretCleanup()
  if (pendingCleanup.warning) throw new Error(pendingCleanup.warning)
  for (const sourceSecretId of sourceSecretIds) {
    pendingCleanup.sourceSecretIds.add(sourceSecretId)
  }
  if (pendingCleanup.sourceSecretIds.size > 256) {
    throw new Error('旧 Provider Secret 清理意图超过安全上限')
  }
  try {
    await persistPendingProviderSecretCleanup(pendingCleanup.sourceSecretIds)
    await runtimeFaultCheckpoint('intent_fsynced')
  } catch {
    throw new Error('旧 Provider Secret 清理意图无法持久化')
  }
}

export const garbageCollectMigratedProviderSecrets = async (
  bindings: ProviderSecretMigrationBindings,
  repository: SessionRepository,
  migrationReceipts: Map<string, ProviderSecretMigrationReceipt>,
): Promise<string | null> => {
  if (!isTauriRuntime()) return null
  const pendingCleanup = await loadPendingProviderSecretCleanup()
  const pendingSourceSecretIds = pendingCleanup.sourceSecretIds
  if (migrationReceipts.size === 0 && pendingSourceSecretIds.size === 0) {
    return pendingCleanup.warning
  }
  const remainingMigrations = await repository.prepareProviderProfileMigrations()
  const retainedSourceSecretIds = new Set(remainingMigrations.flatMap((migration) => (
    migration.secretMigration ? [migration.secretMigration.sourceSecretId] : []
  )))
  const localMigration = (await loadProviderSelection()).secretMigration
  if (localMigration) retainedSourceSecretIds.add(localMigration.sourceSecretId)
  for (const receipt of migrationReceipts.values()) {
    if (!retainedSourceSecretIds.has(receipt.sourceSecretId)) {
      pendingSourceSecretIds.add(receipt.sourceSecretId)
    }
  }
  if (pendingSourceSecretIds.size === 0) return pendingCleanup.warning
  try {
    await persistPendingProviderSecretCleanup(pendingSourceSecretIds)
  } catch {
    return [pendingCleanup.warning, '旧 Provider Secret 清理状态无法持久化']
      .filter(Boolean)
      .join('；')
  }
  const failures: string[] = []
  for (const sourceSecretId of [...pendingSourceSecretIds]) {
    if (retainedSourceSecretIds.has(sourceSecretId)) continue
    try {
      const receipt = migrationReceipts.get(sourceSecretId)
      if (receipt) await bindings.retireSource(receipt)
      else await bindings.retireLegacySource(sourceSecretId)
      pendingSourceSecretIds.delete(sourceSecretId)
      await persistPendingProviderSecretCleanup(pendingSourceSecretIds)
    } catch {
      failures.push(sourceSecretId)
    }
  }
  const failureWarning = failures.length > 0
    ? `旧 Provider Secret 清理失败：${failures.join(', ')}`
    : null
  return [pendingCleanup.warning, failureWarning].filter(Boolean).join('；') || null
}
