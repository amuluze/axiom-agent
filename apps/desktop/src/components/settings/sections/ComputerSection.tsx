import { useCallback, useEffect, useState } from 'react'
import { LockKeyhole, Monitor, MonitorOff, ShieldCheck, X } from 'lucide-react'
import {
  loadComputerSettings,
  saveComputerSettings,
  type ComputerSettings,
} from '@/config/computerSettings'
import {
  computerStatus,
  requestComputerAccess,
  stopComputerControl,
  unallowComputerApp,
  type ComputerAllowedApp,
  type ComputerGrantInfo,
} from '@/platform/computerSession'
import { useT } from '@/i18n'
import { useUiStore } from '@/stores/uiStore'

/**
 * 电脑控制配置区：能力开关、macOS 权限引导（辅助功能/屏幕录制）、
 * 会话授权与「始终允许」应用名单（allowlist，Rust 独占 ~/.axiom/computer）。
 * 控制类动作的门控（会话级原生确认 + allowlist）全部由 Rust 权威执行。
 */

interface ComputerStatusState {
  accessibility: boolean
  screenRecording: boolean
  grants: ComputerGrantInfo[]
  allowlist: ComputerAllowedApp[]
}

export const ComputerSection = () => {
  const { t } = useT()
  // Linux 限制：电脑控制依赖 macOS Accessibility/CGEvent，Rust 侧全动作
  // fail-closed（docs/linux-support.md §1.2）——区块顶部直接呈现不支持说明。
  const operatingSystem = useUiStore((state) => state.operatingSystem)
  const isUnsupportedPlatform = operatingSystem !== 'macos'
  const unsupportedNoteKey = operatingSystem === 'windows'
    ? 'settings.computer.windowsUnsupported'
    : 'settings.computer.linuxUnsupported'
  const unsupportedNoteKeyShort = operatingSystem === 'windows'
    ? 'settings.computer.windowsUnsupportedShort'
    : 'settings.computer.linuxUnsupportedShort'
  const [draft, setDraft] = useState<ComputerSettings>(() => loadComputerSettings())
  const [status, setStatus] = useState<ComputerStatusState | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<'status' | 'save' | 'allow' | null>(null)

  const refreshStatus = useCallback(async () => {
    setBusy('status')
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
    } catch {
      // 状态读取失败不打断设置页（非 Tauri 环境下的常态），仅置空。
      setStatus(null)
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    if (isUnsupportedPlatform) return
    void refreshStatus()
  }, [refreshStatus, isUnsupportedPlatform])

  const draftChanged = JSON.stringify(draft) !== JSON.stringify(loadComputerSettings())

  const handleSave = async () => {
    saveComputerSettings(draft)
    setMessage({ kind: 'success', text: t('settings.computer.saved') })
  }

  const handleRequestAccess = async (kind: 'accessibility' | 'screenRecording') => {
    setMessage(null)
    try {
      await requestComputerAccess(kind)
      setMessage({
        kind: 'success',
        text: t('settings.computer.accessOpened'),
      })
      // 系统设置弹窗是异步的：稍等用户操作后重查（简单刷新即可，不做轮询）。
      await refreshStatus()
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleStop = async () => {
    setMessage(null)
    try {
      await stopComputerControl()
      setMessage({ kind: 'success', text: t('settings.computer.stopped') })
      await refreshStatus()
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleUnallow = async (app: ComputerAllowedApp) => {
    setBusy('allow')
    try {
      await unallowComputerApp(app.bundleId)
      await refreshStatus()
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-section" id="settings-computer">
      <div className="section-title">
        <span>{t('settings.computer.title')}</span>
        <span className="section-state">
          {isUnsupportedPlatform
            ? t(unsupportedNoteKeyShort)
            : status
              ? (status.accessibility ? t('settings.computer.state.accessibilityGranted') : t('settings.computer.state.pending'))
              : t('settings.computer.state.unknown')}
        </span>
      </div>
      {isUnsupportedPlatform && (
        <p className="security-note" role="note">
          <MonitorOff size={13} aria-hidden />
          <span>{t(unsupportedNoteKey)}</span>
        </p>
      )}
      <div className="settings-grid">
        <label className="settings__toggle">
          <input
            type="checkbox"
            aria-label={t('settings.computer.enableLabel')}
            checked={draft.enabled}
            onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
          />
          <span className="settings__toggle-body">
            <span className="settings__field-label-with-icon"><Monitor size={13} />{t('settings.computer.enableLabel')}</span>
            <small>
              {t('settings.computer.enableHint')}
            </small>
          </span>
        </label>
      </div>

      {status && (
        <div className="settings-computer-permissions">
          <div className="settings-computer-permission">
            <span className="settings-computer-permission-name">
              <ShieldCheck size={13} />
              {t('settings.computer.accessibilityName')}
            </span>
            <span className={`settings-computer-permission-state ${status.accessibility ? 'is-granted' : 'is-denied'}`}>
              {status.accessibility ? t('settings.computer.granted') : t('settings.computer.notGranted')}
            </span>
            {!status.accessibility && (
              <button type="button" className="secondary-button" onClick={() => void handleRequestAccess('accessibility')}>
                {t('settings.computer.grant')}
              </button>
            )}
          </div>
          <div className="settings-computer-permission">
            <span className="settings-computer-permission-name">
              <ShieldCheck size={13} />
              {t('settings.computer.screenRecordingName')}
            </span>
            <span className={`settings-computer-permission-state ${status.screenRecording ? 'is-granted' : 'is-denied'}`}>
              {status.screenRecording ? t('settings.computer.granted') : t('settings.computer.notGranted')}
            </span>
            {!status.screenRecording && (
              <button type="button" className="secondary-button" onClick={() => void handleRequestAccess('screenRecording')}>
                {t('settings.computer.grant')}
              </button>
            )}
          </div>
        </div>
      )}

      {status && status.allowlist.length > 0 && (
        <div className="settings-computer-allowlist">
          <div className="settings-computer-allowlist-title">{t('settings.computer.allowlistTitle')}</div>
          <ul>
            {status.allowlist.map((app) => (
              <li key={app.bundleId}>
                <span className="settings-computer-allowlist-name">{app.name}</span>
                <span className="settings-computer-allowlist-bundle">{app.bundleId}</span>
                <button
                  type="button"
                  className="settings-computer-allowlist-remove"
                  aria-label={t('settings.computer.removeAria', { app: app.name })}
                  title={t('settings.computer.removeTitle')}
                  disabled={busy === 'allow'}
                  onClick={() => void handleUnallow(app)}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status && status.grants.length > 0 && (
        <p className="security-note">
          <LockKeyhole size={13} aria-hidden />
          <span>
            {t('settings.computer.grantsNote', { apps: [...new Set(status.grants.map((grant) => `${grant.appName}（pid ${grant.pid}）`))].join('、') })}
          </span>
        </p>
      )}

      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.computer.securityNote')}</span>
      </p>

      <div className="settings-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void handleStop()}
          disabled={busy !== null || (status?.grants.length ?? 0) === 0}
        >
          {t('settings.computer.stop')}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void handleSave()}
          disabled={busy !== null || !draftChanged}
        >
          {busy === 'save' ? t('settings.computer.saving') : t('settings.computer.save')}
        </button>
      </div>

      {message && (
        <div className={message.kind === 'error' ? 'settings-error' : 'settings-success'} role="status">
          <span>{message.text}</span>
        </div>
      )}
    </section>
  )
}
