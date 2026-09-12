import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import {
  computerStatus,
  requestComputerAccess,
  stopComputerControl,
  unallowComputerApp,
  type ComputerAllowedApp,
  type ComputerGrantInfo,
} from '@/platform/computerSession'
import { getComputerSettings } from '@/config/computerSettings'
import { useUiStore } from '@/stores/uiStore'
import { useT } from '@/i18n'

/**
 * 电脑控制面板：macOS 权限状态、会话控制授权、「始终允许」应用名单与
 * kill switch。全部是观察/管理类动作（不经会话门），挂载不触发任何控制。
 *
 * 与设置页（ComputerSection）共享 Rust 侧状态源：本面板面向运行中的值守
 * （Agent 正在控制什么、一键停止），设置页面向偏好（开关 + 权限引导）。
 */
const toErrorMessage = (cause: unknown, fallback: string): string => {
  if (typeof cause === 'string') return cause
  if (cause instanceof Error) return cause.message
  return fallback
}

interface ComputerStatusState {
  accessibility: boolean
  screenRecording: boolean
  grants: ComputerGrantInfo[]
  allowlist: ComputerAllowedApp[]
}

export const ComputerPanel = () => {
  const { t } = useT()
  const setSettingsSection = useUiStore((state) => state.setSettingsSection)
  const setView = useUiStore((state) => state.setView)
  const [status, setStatus] = useState<ComputerStatusState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const enabled = getComputerSettings().enabled

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const response = await computerStatus()
      if (response.type === 'status') {
        setStatus({
          accessibility: response.accessibility,
          screenRecording: response.screenRecording,
          grants: response.grants,
          allowlist: response.allowlist,
        })
      }
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.computerPanel.error.statusFailed')))
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const grantAppNames = status
    ? [...new Set(status.grants.map((grant) => grant.appName))]
    : []

  const handleStop = async (): Promise<void> => {
    setError(null)
    try {
      await stopComputerControl()
      await refresh()
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.computerPanel.error.stopFailed')))
    }
  }

  const handleUnallow = async (app: ComputerAllowedApp): Promise<void> => {
    setError(null)
    try {
      await unallowComputerApp(app.bundleId)
      await refresh()
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.computerPanel.error.removeFailed')))
    }
  }

  const handleRequestAccess = async (kind: 'accessibility' | 'screenRecording'): Promise<void> => {
    setError(null)
    try {
      await requestComputerAccess(kind)
      await refresh()
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.computerPanel.error.requestFailed')))
    }
  }

  const goToSettings = (): void => {
    setSettingsSection('computer')
    setView('settings')
  }

  return (
    <section className="rail__panel rail__computer-panel" aria-label={t('app.computerPanel.aria')}>
      {!enabled ? (
        <div className="rail__computer-empty">
          <Monitor size={34} strokeWidth={1.5} />
          <div className="rail__computer-empty-title">{t('app.computerPanel.empty.disabledTitle')}</div>
          <div className="rail__computer-empty-hint">{t('app.computerPanel.empty.disabledHint')}</div>
          <button type="button" className="rail__computer-action" onClick={goToSettings}>
            {t('app.computerPanel.openSettings')}
          </button>
        </div>
      ) : (
        <>
          {error && <div className="rail__browser-error" role="alert">{error}</div>}
          {status === null && !error && (
            <div className="rail__computer-empty">
              <Monitor size={34} strokeWidth={1.5} />
              <div className="rail__computer-empty-title">{t('app.computerPanel.unknownTitle')}</div>
              <div className="rail__computer-empty-hint">{t('app.computerPanel.unknownHint')}</div>
            </div>
          )}
          {status && (
            <>
              <div className="rail__computer-card">
                <div className="rail__computer-card-title">
                  <MonitorSmartphone size={13} />
                  {t('app.computerPanel.permissions.title')}
                </div>
                <PermissionRow
                  permissionKey="accessibility"
                  required
                  granted={status.accessibility}
                  onRequest={() => { void handleRequestAccess('accessibility') }}
                />
                <PermissionRow
                  permissionKey="screenRecording"
                  required={false}
                  granted={status.screenRecording}
                  onRequest={() => { void handleRequestAccess('screenRecording') }}
                />
              </div>

              <div className="rail__computer-card">
                <div className="rail__computer-card-title">
                  <Square size={13} />
                  {t('app.computerPanel.grants.title')}
                </div>
                {grantAppNames.length === 0 ? (
                  <div className="rail__computer-card-empty">
                    {t('app.computerPanel.grants.empty')}
                  </div>
                ) : (
                  <>
                    <ul className="rail__computer-grants">
                      {status.grants.map((grant) => (
                        <li key={`${grant.sessionId}-${grant.pid}`}>
                          <span className="rail__computer-grant-name">{grant.appName}</span>
                          <span className="rail__computer-grant-pid">{t('app.computerPanel.grants.pid', { pid: grant.pid })}</span>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="rail__computer-stop"
                      onClick={() => { void handleStop() }}
                      disabled={loading}
                    >
                      <Square size={12} />
                      {t('app.computerPanel.grants.stop')}
                    </button>
                  </>
                )}
              </div>

              <div className="rail__computer-card">
                <div className="rail__computer-card-title">
                  <ShieldCheck size={13} />
                  {t('app.computerPanel.allowlist.title')}
                </div>
                {status.allowlist.length === 0 ? (
                  <div className="rail__computer-card-empty">
                    {t('app.computerPanel.allowlist.empty')}
                  </div>
                ) : (
                  <ul className="rail__computer-allowlist">
                    {status.allowlist.map((app) => (
                      <li key={app.bundleId}>
                        <span className="rail__computer-allowlist-name">{app.name}</span>
                        <button
                          type="button"
                          className="rail__computer-allowlist-remove"
                          aria-label={t('app.computerPanel.allowlist.removeAria', { name: app.name })}
                          title={t('app.computerPanel.allowlist.removeTitle')}
                          onClick={() => { void handleUnallow(app) }}
                        >
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="rail__computer-note">
                <AlertTriangle size={12} />
                {t('app.computerPanel.note')}
              </p>
            </>
          )}
        </>
      )}
      {enabled && (
        <div className="rail__browser-footer">
          <span className="rail__browser-status">
            <span
              className={`rail__browser-dot ${(status?.grants.length ?? 0) > 0 ? 'rail__browser-dot--running' : ''}`}
              aria-hidden
            />
            <span className="rail__browser-status-text">
              {status
                ? (grantAppNames.length > 0
                    ? t('app.computerPanel.status.controlling', { apps: grantAppNames.join(t('app.computerPanel.status.appJoiner')) })
                    : t('app.computerPanel.status.standby'))
                : t('app.computerPanel.status.unknown')}
            </span>
          </span>
          <button
            type="button"
            className="rail__browser-navbtn"
            aria-label={t('app.computerPanel.refreshAria')}
            title={t('app.computerPanel.refreshTitle')}
            disabled={loading}
            onClick={() => { void refresh() }}
          >
            <RefreshCw size={12} />
          </button>
        </div>
      )}
    </section>
  )
}

type PermissionKey = 'accessibility' | 'screenRecording'

const PermissionRow = ({
  permissionKey,
  required,
  granted,
  onRequest,
}: {
  permissionKey: PermissionKey
  required: boolean
  granted: boolean
  onRequest: () => void
}) => {
  const { t } = useT()
  const label =
    permissionKey === 'accessibility'
      ? t('app.computerPanel.permissions.accessibility.label')
      : t('app.computerPanel.permissions.screenRecording.label')
  return (
    <div className="rail__computer-permission">
      <span className="rail__computer-permission-label">
        {label}
        {required && <em>{t('app.computerPanel.permissions.required')}</em>}
      </span>
      {granted ? (
        <span className="rail__computer-permission-state is-granted">
          <ShieldCheck size={12} />
          {t('app.computerPanel.permissions.granted')}
        </span>
      ) : (
        <button type="button" className="rail__computer-permission-request" onClick={onRequest}>
          <ShieldAlert size={12} />
          {t('app.computerPanel.permissions.request')}
        </button>
      )}
    </div>
  )
}
