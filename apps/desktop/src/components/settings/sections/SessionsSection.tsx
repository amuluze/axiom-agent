import { useState, type CSSProperties } from 'react'
import { Folder, GitBranch, Trash2, Edit3 } from 'lucide-react'
import type { SessionsHook, SettingsSectionContext } from './types'
import type { StorageStats } from '@/persistence/types'
import { gcArtifacts, type ArtifactGcResult } from '@/platform/artifacts'
import {
  migrateLegacySecrets,
  type LegacySecretMigrationResult,
} from '@/platform/secrets'
import { useT } from '@/i18n'
import { displaySessionTitle } from '@/i18n/sessionTitle'

interface SessionsSectionProps {
  hook: SessionsHook
  context: SettingsSectionContext
  tree: Array<{
    session: { id: string; title: string; parentSessionId?: string | null; branchKind?: string | null; messageCount: number; modelId: string }
    depth: number
    hasChildren: boolean
    orphaned: boolean
  }>
  titleById: Map<string, string>
  storageStats: StorageStats | null
  recoveredRuns: number
  desktop: boolean
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

export const SessionsSection = ({
  hook,
  context,
  tree,
  titleById,
  storageStats,
  recoveredRuns,
  desktop,
}: SessionsSectionProps) => {
  const { t } = useT()
  const { sessions, activeSessionId, createSession, selectSession, renameSession, deleteSession } = hook
  const { busy } = context
  const [gcResult, setGcResult] = useState<ArtifactGcResult | null>(null)
  const [gcing, setGcing] = useState(false)
  const [gcError, setGcError] = useState<string | null>(null)
  const runGc = async (): Promise<void> => {
    setGcing(true)
    setGcError(null)
    try {
      setGcResult(await gcArtifacts())
    } catch (error) {
      setGcError(error instanceof Error ? error.message : String(error))
    } finally {
      setGcing(false)
    }
  }
  const [migrationResult, setMigrationResult] = useState<LegacySecretMigrationResult | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [migrationError, setMigrationError] = useState<string | null>(null)
  const runLegacyMigration = async (): Promise<void> => {
    setMigrating(true)
    setMigrationError(null)
    try {
      setMigrationResult(await migrateLegacySecrets())
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrating(false)
    }
  }
  return (
    <section className="settings-section" id="settings-sessions" aria-labelledby="settings-sessions-title">
      <div className="section-title">
        <span>{t('settings.sessions.title')}</span>
        <span className="section-state">{t('settings.sessions.count', { count: sessions.length })}</span>
      </div>
      <button
        className="file-picker-button"
        disabled={busy}
        onClick={() => void createSession()}
        type="button"
      >
        <Folder size={13} />
        <span>{t('settings.sessions.new')}</span>
      </button>
      <ul aria-label={t('settings.sessions.treeAria')} className="session-list">
        {tree.map(({ session: stored, depth, hasChildren, orphaned }) => {
          const parentTitle = stored.parentSessionId
            ? titleById.get(stored.parentSessionId)
            : undefined
          const parentDisplayTitle = parentTitle
            ? displaySessionTitle(t, parentTitle)
            : undefined
          const detached = Boolean(stored.branchKind && !stored.parentSessionId)
          return (
            <li
              key={stored.id}
              className={stored.id === activeSessionId ? 'is-active' : ''}
              data-depth={Math.min(depth, 6)}
              style={{ '--session-depth': Math.min(depth, 6) } as CSSProperties}
            >
              <button
                aria-current={stored.id === activeSessionId ? 'true' : undefined}
                aria-label={t('settings.sessions.switchAria', { title: displaySessionTitle(t, stored.title) })}
                disabled={busy || stored.id === activeSessionId}
                onClick={() => void selectSession(stored.id)}
                type="button"
              >
                <strong>{displaySessionTitle(t, stored.title)}</strong>
                <span>
                  {stored.branchKind === 'retry' ? t('settings.sessions.branchKind.retry') : stored.branchKind === 'branch' ? t('settings.sessions.branchKind.branch') : t('settings.sessions.branchKind.session')}
                  {' · '}{t('settings.sessions.messageCount', { count: stored.messageCount, model: stored.modelId })}
                </span>
                {(parentTitle || detached || orphaned || hasChildren) && (
                  <span className="session-lineage">
                    <GitBranch size={12} aria-hidden />
                    <span>
                      {parentDisplayTitle
                        ? t('settings.sessions.from', { title: parentDisplayTitle })
                        : detached || orphaned
                          ? t('settings.sessions.originalDeleted')
                          : t('settings.sessions.hasBranches')}
                    </span>
                  </span>
                )}
              </button>
              <div className="session-item-actions">
                <button
                  aria-label={t('settings.sessions.renameAria', { title: stored.title })}
                  disabled={busy}
                  onClick={() => {
                    const title = window.prompt(t('settings.sessions.renamePrompt'), stored.title)
                    if (title !== null) void renameSession(stored.id, title)
                  }}
                  type="button"
                >
                  <Edit3 size={12} />
                  <span>{t('settings.sessions.rename')}</span>
                </button>
                <button
                  aria-label={t('settings.sessions.deleteAria', { title: stored.title })}
                  className="session-delete-button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t('settings.sessions.deleteConfirm', { title: stored.title }))) {
                      void deleteSession(stored.id)
                    }
                  }}
                  type="button"
                >
                  <Trash2 size={12} />
                  <span>{t('settings.sessions.delete')}</span>
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {storageStats && (
        <div className="storage-stats">
          <span>{t('settings.sessions.stat.messages', { count: storageStats.messageCount })}</span>
          <span>{t('settings.sessions.stat.runs', { count: storageStats.runCount })}</span>
          <span>{t('settings.sessions.stat.tools', { count: storageStats.toolExecutionCount })}</span>
          <span>{t('settings.sessions.stat.checkpoints', { count: storageStats.checkpointCount })}</span>
          <span>{t('settings.sessions.stat.artifacts', { count: storageStats.artifactCount })}</span>
          <span>{desktop ? t('settings.sessions.stat.sqlite', { size: formatBytes(storageStats.databaseBytes) }) : t('settings.sessions.stat.memory')}</span>
          {desktop && <span>{t('settings.sessions.stat.artifactBytes', { size: formatBytes(storageStats.artifactBytes) })}</span>}
          {desktop && storageStats.artifactTrashCount > 0 && (
            <span>{t('settings.sessions.stat.artifactTrash', { count: storageStats.artifactTrashCount, size: formatBytes(storageStats.artifactTrashBytes) })}</span>
          )}
          {desktop && storageStats.artifactCleanupWarning && (
            <span>{t('settings.sessions.stat.artifactWarning', { warning: storageStats.artifactCleanupWarning })}</span>
          )}
        </div>
      )}
      {desktop && (
        <div className="artifact-gc-row">
          <button
            className="file-picker-button"
            disabled={busy || gcing}
            onClick={() => {
              if (window.confirm(t('settings.sessions.gcConfirm'))) {
                void runGc()
              }
            }}
            type="button"
          >
            {gcing ? t('settings.sessions.gcing') : t('settings.sessions.gc')}
          </button>
          {gcResult && (
            <span className="artifact-gc-result">
              {t('settings.sessions.gcResult', { trashed: gcResult.reconciled.trashed, purged: gcResult.reconciled.purged })}
            </span>
          )}
          {gcError && <span className="artifact-gc-error" role="alert">{gcError}</span>}
        </div>
      )}
      {desktop && (
        <div className="artifact-gc-row">
          <button
            className="file-picker-button"
            disabled={busy || migrating}
            onClick={() => {
              if (window.confirm(t('settings.sessions.migrateConfirm'))) {
                void runLegacyMigration()
              }
            }}
            type="button"
          >
            {migrating ? t('settings.sessions.migrating') : t('settings.sessions.migrate')}
          </button>
          {migrationResult && (
            <span className="artifact-gc-result">
              {migrationResult.failed === 0
                ? t('settings.sessions.migrateOk', { migrated: migrationResult.migrated, cleaned: migrationResult.cleanedStale })
                : t('settings.sessions.migratePartial', { migrated: migrationResult.migrated, cleaned: migrationResult.cleanedStale, failed: migrationResult.failed })}
            </span>
          )}
          {migrationError && <span className="artifact-gc-error" role="alert">{migrationError}</span>}
        </div>
      )}
      {recoveredRuns > 0 && (
        <p className="recovery-note">{t('settings.sessions.recovered', { count: recoveredRuns })}</p>
      )}
    </section>
  )
}
