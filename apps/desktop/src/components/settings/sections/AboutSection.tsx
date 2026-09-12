import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Download, ExternalLink, Info, Power, RefreshCw } from 'lucide-react'
import { getRuntimeInfo } from '@/platform/runtimeInfo'
import { openExternalUrl } from '@/platform/webAccess'
import {
  checkForAppUpdateNow,
  installPendingUpdate,
  relaunchAfterUpdate,
} from '@/stores/services/updaterService'
import { useUiStore, type AvailableAppUpdate, type UpdatePhase } from '@/stores/uiStore'
import { normalizeUpdateNotes } from './updateNotes'
import { useT } from '@/i18n'

const WEBSITE_URL = 'https://axiom.amuluze.com'
const CHANGELOG_URL = 'https://axiom.amuluze.com/#/changelog'

const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: 'settings.about.phase.idle',
  checking: 'settings.about.phase.checking',
  downloading: 'settings.about.phase.downloading',
  ready: 'settings.about.phase.ready',
  uptodate: 'settings.about.phase.uptodate',
  disabled: 'settings.about.phase.disabled',
  error: 'settings.about.phase.error',
}

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** 进度百分比：totalBytes 未知（Content-Length 缺失）时返回 null，只展示字节量。 */
const progressPercent = (downloaded: number, total: number | null): number | null =>
  total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null

// 更新清单 notes 是外部渠道携带的文本：只放行 http/https 链接（react-markdown
// 默认已滤 javascript:，这里双保险），经系统浏览器打开，不在应用内跳转。
const openChangelogLink = (event: MouseEvent<HTMLAnchorElement>, href: string | undefined): void => {
  if (!href || !/^https?:\/\//u.test(href)) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  void openExternalUrl(href).catch(() => undefined)
}

const changelogMarkdownComponents: Components = {
  a({ node: _node, ref: _ref, ...props }) {
    return (
      <a
        {...props}
        rel="noreferrer noopener"
        target="_blank"
        onClick={(event) => openChangelogLink(event, props.href)}
      />
    )
  },
}

/**
 * 新版本更新内容：notes 摘自 CHANGELOG（Markdown 格式），经防御性归一化
 * （剥手动安装附录、丢空分节、修复旧版单行清单，见 updateNotes.ts）后用
 * react-markdown 渲染。skipHtml 不渲染内嵌 HTML；长内容在固定高度块内滚动，
 * 不把设置页撑长。
 */
const UpdateChangelog = ({
  update,
  onOpenUrl,
  t,
}: {
  update: AvailableAppUpdate
  onOpenUrl: (url: string) => void
  t: (key: string, params?: Record<string, string | number>) => string
}) => (
  <section className="settings__changelog" aria-label={t('settings.about.changelogAria')}>
    <div className="settings__changelog-header">
      <span>{t('settings.about.changelogTitle')}</span>
      {update.pubDate && (
        <small>{t('settings.about.changelogPublished', { date: new Date(update.pubDate).toLocaleDateString() })}</small>
      )}
    </div>
    <div className="settings__changelog-body settings__changelog-markdown">
      <Markdown components={changelogMarkdownComponents} remarkPlugins={[remarkGfm]} skipHtml>
        {normalizeUpdateNotes(update.notes ?? '') || t('settings.about.changelogEmpty')}
      </Markdown>
    </div>
    <button type="button" className="link-button" onClick={() => onOpenUrl(CHANGELOG_URL)}>
      {t('settings.about.changelogLink')} <ExternalLink size={11} />
    </button>
  </section>
)

export const AboutSection = () => {
  const { t } = useT()
  const updatePhase = useUiStore((state) => state.updatePhase)
  const availableUpdate = useUiStore((state) => state.availableUpdate)
  const updateProgress = useUiStore((state) => state.updateProgress)
  const updateMessage = useUiStore((state) => state.updateMessage)
  const [appVersion, setAppVersion] = useState('…')
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getRuntimeInfo()
      .then((info) => {
        if (!cancelled) setAppVersion(info.appVersion)
      })
      .catch(() => {
        if (!cancelled) setAppVersion(t('settings.about.versionUnknown'))
      })
    return () => {
      cancelled = true
    }
  }, [t])

  const onCheck = useCallback(() => {
    setActionError(null)
    void checkForAppUpdateNow().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }, [])

  const onInstall = useCallback(() => {
    setActionError(null)
    void installPendingUpdate().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }, [])

  const onRelaunch = useCallback(() => {
    setActionError(null)
    void relaunchAfterUpdate().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }, [])

  const onOpen = useCallback((url: string) => {
    void openExternalUrl(url).catch(() => undefined)
  }, [])

  const busy = updatePhase === 'checking' || updatePhase === 'downloading'
  const percent = updateProgress
    ? progressPercent(updateProgress.downloadedBytes, updateProgress.totalBytes)
    : null

  return (
    <section className="settings-section" id="settings-about">
      <div className="section-title">
        <span>{t('settings.about.section.app')}</span>
        <span className="section-state">{t('settings.about.versionState', { version: appVersion })}</span>
      </div>
      <div className="settings-grid">
        <div className="field-group">
          <span className="settings__field-label-with-icon"><Info size={13} />{t('settings.about.versionLabel')}</span>
          <output aria-label={t('settings.about.versionLabel')}>{t('settings.about.versionOutput', { version: appVersion })}</output>
          <small>
            {t('settings.about.desc')}
            <button type="button" className="link-button" onClick={() => onOpen(WEBSITE_URL)}>
              axiom.amuluze.com <ExternalLink size={11} />
            </button>
          </small>
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 'var(--space-6)' }}>
        <span>{t('settings.about.section.update')}</span>
        <span className="section-state">{t('settings.about.updateState')}</span>
      </div>
      <div className="settings-grid">
        <div className="field-group">
          <span className="settings__field-label-with-icon"><RefreshCw size={13} />{t('settings.about.checkLabel')}</span>
          <div className="settings__update-actions" role="status" aria-label={t('settings.about.statusAria')}>
            <span>
              {availableUpdate
                ? t('settings.about.foundVersion', { version: availableUpdate.version })
                : t(PHASE_LABELS[updatePhase])}
              {updateMessage ? ` ${updateMessage}` : ''}
            </span>
          </div>
          {availableUpdate && <UpdateChangelog update={availableUpdate} onOpenUrl={onOpen} t={t} />}
        </div>
      </div>
      <div className="settings-grid" style={{ marginTop: 'var(--space-4)' }}>
        {updatePhase === 'downloading' && (
          <div className="field-group">
            <span className="settings__field-label-with-icon"><Download size={13} />{t('settings.about.downloadLabel')}</span>
            <progress
              aria-label={t('settings.about.downloadAria')}
              max={100}
              value={percent ?? undefined}
            />
            <small>
              {updateProgress
                ? `${formatBytes(updateProgress.downloadedBytes)}${percent !== null ? ` / ${percent}%` : ''}`
                : t('settings.about.downloadConnecting')}
            </small>
          </div>
        )}
        <div className="settings__update-actions">
          <button type="button" className="settings__button" disabled={busy} onClick={onCheck}>
            <RefreshCw size={13} /> {t('settings.about.check')}
          </button>
          {availableUpdate && updatePhase !== 'downloading' && (
            <button
              type="button"
              className="settings__button settings__button--primary"
              disabled={busy}
              onClick={onInstall}
            >
              <Download size={13} /> {t('settings.about.install', { version: availableUpdate.version })}
            </button>
          )}
          {updatePhase === 'ready' && (
            <button type="button" className="settings__button" onClick={onRelaunch}>
              <Power size={13} /> {t('settings.about.relaunch')}
            </button>
          )}
        </div>
      </div>
      {actionError && (
        <div className="settings-error" role="alert">
          <span>{actionError}</span>
        </div>
      )}
      <small style={{ display: 'block', marginTop: 'var(--space-4)' }}>
        {t('settings.about.updateSecurity')}
        {' '}
        <button type="button" className="link-button" onClick={() => onOpen(WEBSITE_URL)}>
          axiom.amuluze.com <ExternalLink size={11} />
        </button>
        {t('settings.about.updateSecurityTail')}
      </small>
    </section>
  )
}
