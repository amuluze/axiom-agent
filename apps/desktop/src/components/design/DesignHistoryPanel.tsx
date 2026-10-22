import { useEffect, useState } from 'react'
import {
  listDesignDocumentVersions,
  restoreDesignDocumentVersion,
  type DesignDocumentVersion,
} from '@/platform/designDocument'
import { useT } from '@/i18n'

const CONFIRM_TIMEOUT_MS = 3_000

interface DesignHistoryPanelProps {
  path: string
  workspacePath?: string
  expectedSha256: string
  onRestored: () => Promise<void>
  onClose: () => void
}

const DesignHistoryPanel = ({
  path,
  workspacePath,
  expectedSha256,
  onRestored,
  onClose,
}: DesignHistoryPanelProps) => {
  const { t } = useT()
  const [versions, setVersions] = useState<DesignDocumentVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [armedSha, setArmedSha] = useState<string | null>(null)
  const [restoringSha, setRestoringSha] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setWarning(null)
    void listDesignDocumentVersions(path, workspacePath, false)
      .then(async (local) => {
        if (cancelled) return
        setVersions(local)
        setLoading(false)
        try {
          const merged = await listDesignDocumentVersions(path, workspacePath, true)
          if (!cancelled) setVersions(merged)
        } catch (reason) {
          if (!cancelled) setWarning(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, workspacePath])

  useEffect(() => {
    if (!armedSha) return undefined
    const timer = window.setTimeout(() => setArmedSha(null), CONFIRM_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [armedSha])

  const restore = async (version: DesignDocumentVersion): Promise<void> => {
    if (armedSha !== version.sha256) {
      setArmedSha(version.sha256)
      return
    }
    setRestoringSha(version.sha256)
    setError(null)
    try {
      await restoreDesignDocumentVersion(path, version.sha256, expectedSha256, workspacePath)
      await onRestored()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setArmedSha(null)
    } finally {
      setRestoringSha(null)
    }
  }

  return (
    <section className="design-history" aria-label={t('app.design.history.title')}>
      <div className="design-history__header">
        <strong>{t('app.design.history.title')}</strong>
        <button type="button" onClick={onClose}>{t('app.design.history.close')}</button>
      </div>
      {loading ? (
        <p>{t('app.design.history.loading')}</p>
      ) : error ? (
        <p className="design-history__error" role="alert">{error}</p>
      ) : (
        <>
          {warning && <p className="design-history__warning">{t('app.design.history.gitWarning', { message: warning })}</p>}
          {versions.length === 0 ? (
            <p>{t('app.design.history.empty')}</p>
          ) : (
            <ul>
              {versions.map((version) => (
                <li key={version.sha256}>
                  <span>
                    {new Date(version.modifiedMs).toLocaleString()}
                    {' · '}
                    {version.pageCount === null
                      ? t('app.design.history.unknownPages')
                      : t('app.design.history.pages', { count: version.pageCount })}
                    {' · '}
                    {version.sha256.slice(0, 8)}
                  </span>
                  <button
                    type="button"
                    disabled={restoringSha !== null}
                    onClick={() => void restore(version)}
                  >
                    {restoringSha === version.sha256
                      ? t('app.design.history.restoring')
                      : armedSha === version.sha256
                        ? t('app.design.history.confirm')
                        : t('app.design.history.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

export default DesignHistoryPanel
