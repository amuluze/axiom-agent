import {
  getWorkspaceRecoveryIssue,
  retryWorkspaceRecovery,
  type WorkspaceRecoveryIssue,
} from '@/platform/workspace'
import { isTauriRuntime } from '@/platform/environment'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useT } from '@/i18n'

interface WorkspaceRecoveryNoticeProps {
  issue: WorkspaceRecoveryIssue | null
  error: string | null
  busy: boolean
  onRetry: () => void
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const WorkspaceRecoveryNotice = ({
  issue,
  error,
  busy,
  onRetry,
}: WorkspaceRecoveryNoticeProps) => {
  const { t } = useT()
  return (
  <main className="startup-recovery-shell">
    <section
      aria-labelledby="workspace-recovery-title"
      className="startup-recovery-card"
      role="alert"
    >
      <div className="eyebrow">DURABLE WORKSPACE RECOVERY</div>
      <h1 id="workspace-recovery-title">
        {issue ? t('app.recoveryGate.title.issue') : t('app.recoveryGate.title.ok')}
      </h1>
      <p className="startup-recovery-summary">
        {issue ? t('app.recoveryGate.desc.issue') : t('app.recoveryGate.desc.ok')}
      </p>
      <dl className="startup-recovery-details">
        {issue?.workspace && (
          <div>
            <dt>{t('app.recoveryGate.workspace')}</dt>
            <dd><code>{issue.workspace}</code></dd>
          </div>
        )}
        {issue?.recoveryId && (
          <div>
            <dt>{t('app.recoveryGate.transaction')}</dt>
            <dd><code>{issue.recoveryId}</code></dd>
          </div>
        )}
        {issue?.recoveryPath && (
          <div>
            <dt>{t('app.recoveryGate.material')}</dt>
            <dd><code>{issue.recoveryPath}</code></dd>
          </div>
        )}
        <div>
          <dt>{t('app.recoveryGate.diagnostic')}</dt>
          <dd>{issue?.message ?? error}</dd>
        </div>
      </dl>
      <p className="startup-recovery-guidance">
        {t('app.recoveryGate.detail')}
      </p>
      <div className="startup-recovery-actions">
        <button autoFocus disabled={busy} onClick={onRetry} type="button">
          {busy ? t('app.recoveryGate.checking') : issue ? t('app.recoveryGate.retry') : t('app.recoveryGate.recheck')}
        </button>
      </div>
    </section>
  </main>
  )
}

export const WorkspaceRecoveryGate = ({ children }: { children: ReactNode }) => {
  const { t } = useT()
  const desktop = isTauriRuntime()
  const [issue, setIssue] = useState<WorkspaceRecoveryIssue | null | undefined>(
    desktop ? undefined : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const checkRecovery = useCallback(async (retry: boolean) => {
    if (!desktop) {
      setIssue(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      setIssue(await (retry ? retryWorkspaceRecovery() : getWorkspaceRecoveryIssue()))
    } catch (checkError) {
      setError(errorMessage(checkError))
    } finally {
      setBusy(false)
    }
  }, [desktop])

  useEffect(() => {
    void checkRecovery(false)
  }, [checkRecovery])

  if (issue === undefined && error === null) {
    return (
      <main className="startup-recovery-shell">
        <div aria-live="polite" className="startup-recovery-loading" role="status">
          {t('app.recoveryGate.checkingTitle')}
        </div>
      </main>
    )
  }
  if (issue === null && error === null) return children
  return (
    <WorkspaceRecoveryNotice
      busy={busy}
      error={error}
      issue={issue ?? null}
      onRetry={() => void checkRecovery(issue !== undefined && issue !== null)}
    />
  )
}
