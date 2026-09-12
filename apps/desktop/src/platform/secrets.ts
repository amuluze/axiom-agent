import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './environment'

const requireTauri = (): void => {
  if (!isTauriRuntime()) throw new Error('安全密钥存储仅在 Axiom 桌面应用中可用')
}

export const saveSecret = async (key: string, value: string): Promise<void> => {
  requireTauri()
  await invoke('save_secret', { key, value })
}

export const hasSecret = async (key: string): Promise<boolean> => {
  requireTauri()
  return invoke<boolean>('has_secret', { key })
}

export const migrateSecret = async (sourceKey: string, targetKey: string): Promise<boolean> => {
  requireTauri()
  return invoke<boolean>('migrate_secret', { sourceKey, targetKey })
}

export const deleteSecret = async (key: string): Promise<void> => {
  requireTauri()
  await invoke('delete_secret', { key })
}

export const loadProviderSecretCleanupIntent = async (): Promise<string[]> => {
  requireTauri()
  return invoke<string[]>('load_provider_secret_cleanup_intent')
}

export const persistProviderSecretCleanupIntent = async (
  sourceSecretIds: string[],
): Promise<void> => {
  requireTauri()
  await invoke('persist_provider_secret_cleanup_intent', { sourceSecretIds })
}

/** 一键迁移旧钥匙串密钥的汇总（Rust `LegacySecretMigrationSummary`）。 */
export interface LegacySecretMigrationResult {
  /** 钥匙串中扫描到的旧条目数 */
  scanned: number
  /** 本次回填 DB 并删除旧条目（读取会依次弹授权框） */
  migrated: number
  /** DB 已有同 key 数据，仅清理陈旧钥匙串副本 */
  cleanedStale: number
  /** 读取被拒/失败，条目保留（可重试） */
  failed: number
}

export const migrateLegacySecrets = async (): Promise<LegacySecretMigrationResult> => {
  requireTauri()
  return invoke<LegacySecretMigrationResult>('migrate_legacy_secrets')
}
