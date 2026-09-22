import { useEffect, useState } from 'react'
import { AppWindow, FlaskConical, LockKeyhole, PowerOff, ShieldAlert, Trash2 } from 'lucide-react'
import {
  loadBrowserSettings,
  saveBrowserSettings,
  type BrowserSettings,
} from '@/config/browserSettings'
import {
  browserStatus,
  clearBrowserProfileData,
  detectBrowserEngines,
  ensureBrowserRunning,
  shutdownBrowser,
  validateBrowserExecutable,
  type BrowserEngineInfo,
} from '@/platform/browserSession'
import { useT } from '@/i18n'

/**
 * 浏览器配置区：能力开关、引擎选择（自动探测 + 各引擎 + 自定义路径）、运行
 * 模式、证书校验与 profile 数据管理。配置持久化在 config/browserSettings
 * （localStorage），spawn 侧安全边界（可执行文件 allowlist、隔离 profile、
 * 回环 CDP、清理路径钉死）由 Rust 权威执行。
 */

interface BrowserStatusState {
  running: boolean
  engine?: string
  version?: string
  port?: number
  headless?: boolean
  tabs?: number
}

/** 下拉「自定义路径」哨兵值：非引擎列表中的路径一律落到该选项。 */
const CUSTOM_PATH_OPTION = '__custom__'

export const BrowserSection = () => {
  const { t } = useT()
  const [draft, setDraft] = useState<BrowserSettings>(() => loadBrowserSettings())
  const [engines, setEngines] = useState<BrowserEngineInfo[]>([])
  const [status, setStatus] = useState<BrowserStatusState | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<'detect' | 'test' | 'shutdown' | 'save' | 'clearCache' | 'clearAll' | null>(null)

  const refreshStatus = async () => {
    try {
      const response = await browserStatus()
      if (response.type === 'status') {
        setStatus({
          running: response.running,
          engine: response.engine,
          version: response.version,
          port: response.port,
          headless: response.headless,
          tabs: response.tabs,
        })
      }
    } catch {
      // 状态读取失败不打断设置页（非 Tauri 环境下的常态），仅置空。
      setStatus(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setBusy('detect')
      try {
        const response = await detectBrowserEngines()
        if (!cancelled && response.type === 'detected') setEngines(response.engines)
      } catch {
        // 非 Tauri 环境（浏览器 dev 模式）无 Rust 通道，保持空探测结果。
      } finally {
        if (!cancelled) setBusy(null)
      }
    }
    void load()
    void refreshStatus()
    return () => {
      cancelled = true
    }
  }, [])

  const draftChanged = JSON.stringify(draft) !== JSON.stringify(loadBrowserSettings())

  const handleSave = async () => {
    setBusy('save')
    setMessage(null)
    try {
      if (draft.executablePath.trim()) {
        const response = await validateBrowserExecutable(draft.executablePath.trim())
        if (response.type !== 'executableValid') {
          setMessage({ kind: 'error', text: t('settings.browser.pathInvalid') })
          return
        }
        // 以 Rust 归一化后的路径回填（如 ~ 展开），避免下次校验反复漂移。
        setDraft((current) => ({ ...current, executablePath: response.path }))
        saveBrowserSettings({ ...draft, executablePath: response.path })
      } else {
        saveBrowserSettings(draft)
      }
      setMessage({ kind: 'success', text: t('settings.browser.saved') })
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const handleTest = async () => {
    setBusy('test')
    setMessage(null)
    try {
      const config = {
        enabled: true,
        executablePath: draft.executablePath.trim(),
        headless: draft.headless,
        ignoreCertificateErrors: draft.ignoreCertificateErrors,
      }
      const response = await ensureBrowserRunning(config)
      if (response.type === 'status' && response.running) {
        setMessage({
          kind: 'success',
          text: t('settings.browser.connectOk', { engine: response.engine ?? t('settings.browser.engineUnknown'), version: response.version ?? t('settings.browser.versionUnknown') }),
        })
      } else {
        setMessage({ kind: 'error', text: t('settings.browser.connectFailed') })
      }
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

  const handleShutdown = async () => {
    setBusy('shutdown')
    setMessage(null)
    try {
      await shutdownBrowser()
      setMessage({ kind: 'success', text: t('settings.browser.shutdownOk') })
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

  const handleClearProfileData = async (mode: 'cache' | 'all') => {
    const confirmText = mode === 'all'
      ? t('settings.browser.clearAllConfirm')
      : t('settings.browser.clearCacheConfirm')
    if (!window.confirm(confirmText)) return
    setBusy(mode === 'all' ? 'clearAll' : 'clearCache')
    setMessage(null)
    try {
      await clearBrowserProfileData(mode)
      setMessage({ kind: 'success', text: t('settings.browser.clearOk') })
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

  const availableEngines = engines.filter((engine) => engine.available)
  // 引擎/路径合一：引擎列表内的路径直接显示为选中项；列表外的历史自定义路径
  // 或用户点选「自定义路径…」时展开输入框。customPathMode 是纯 UI 态——选中
  // 自定义入口本身不改动路径值，只展开输入框。
  const [customPathMode, setCustomPathMode] = useState(false)
  const knownEnginePath = engines.some((engine) => engine.path === draft.executablePath)
  const showCustomPathInput = customPathMode
    || (draft.executablePath !== '' && !knownEnginePath)
  const selectValue = showCustomPathInput
    ? CUSTOM_PATH_OPTION
    : draft.executablePath

  return (
    <section className="settings-section" id="settings-browser">
      <div className="section-title">
        <span>{t('settings.browser.title')}</span>
        <span className="section-state">{status?.running ? t('settings.browser.state.running') : t('settings.browser.state.stopped')}</span>
      </div>
      <label className="settings__toggle">
        <input
          type="checkbox"
          aria-label={t('settings.browser.enableLabel')}
          checked={draft.enabled}
          onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
        />
        <span className="settings__toggle-body">
          <span className="settings__field-label-with-icon"><AppWindow size={13} />{t('settings.browser.enableLabel')}</span>
          <small>
            {t('settings.browser.enableHint')}
          </small>
        </span>
      </label>

      {/* 设计稿：开关是卡片的直接子项，字段构成 3 等宽 Grid（自定义路径时第三格展开输入框）。 */}
      <div className="settings-grid settings-grid--third">
        <label>
          <span className="settings__field-label-with-icon"><AppWindow size={13} />{t('settings.browser.engineLabel')}</span>
          <select
            aria-label={t('settings.browser.engineLabel')}
            value={selectValue}
            onChange={(event) => {
              const value = event.target.value
              // 「自定义路径…」只是展开输入框的入口，不改动当前路径值。
              if (value === CUSTOM_PATH_OPTION) {
                setCustomPathMode(true)
                return
              }
              setCustomPathMode(false)
              setDraft((current) => ({ ...current, executablePath: value }))
            }}
          >
            <option value="">
              {t('settings.browser.engineAuto', {
                detail: availableEngines.length > 0
                  ? t('settings.browser.engineAutoFound', { engine: availableEngines[0]?.engine })
                  : t('settings.browser.engineAutoEmpty'),
              })}
            </option>
            {engines.map((engine) => (
              <option key={engine.path} value={engine.path} disabled={!engine.available}>
                {engine.engine}
                {engine.available ? '' : t('settings.browser.engineUnavailable')}
              </option>
            ))}
            <option value={CUSTOM_PATH_OPTION}>{t('settings.browser.customPathOption')}</option>
          </select>
          <small>
            {t('settings.browser.engineHint')}
          </small>
        </label>

        {showCustomPathInput && (
          <label>
            <span className="settings__field-label-with-icon"><AppWindow size={13} />{t('settings.browser.pathLabel')}</span>
            <input
              type="text"
              aria-label={t('settings.browser.pathAria')}
              placeholder={t('settings.browser.pathPlaceholder')}
              value={draft.executablePath}
              onChange={(event) =>
                setDraft((current) => ({ ...current, executablePath: event.target.value }))
              }
            />
            <small>{t('settings.browser.pathHint')}</small>
          </label>
        )}

        <label>
          <span className="settings__field-label-with-icon"><AppWindow size={13} />{t('settings.browser.modeLabel')}</span>
          <select
            aria-label={t('settings.browser.modeAria')}
            value={draft.headless ? 'headless' : 'headed'}
            onChange={(event) =>
              setDraft((current) => ({ ...current, headless: event.target.value === 'headless' }))
            }
          >
            <option value="headless">{t('settings.browser.mode.headless')}</option>
            <option value="headed">{t('settings.browser.mode.headed')}</option>
          </select>
          <small>{t('settings.browser.modeHint')}</small>
        </label>
      </div>

      <p className="section-subtitle">{t('settings.browser.securityTitle')}</p>
      <label className="settings__toggle">
        <input
          type="checkbox"
          aria-label={t('settings.browser.certIgnoreLabel')}
          checked={draft.ignoreCertificateErrors}
          onChange={(event) =>
            setDraft((current) => ({ ...current, ignoreCertificateErrors: event.target.checked }))
          }
        />
        <span className="settings__toggle-body">
          <span className="settings__field-label-with-icon"><ShieldAlert size={13} />{t('settings.browser.certIgnoreLabel')}</span>
          <small>{t('settings.browser.certIgnoreHint')}</small>
        </span>
      </label>

      <p className="section-subtitle">{t('settings.browser.dataTitle')}</p>
      <div className="settings-grid settings-grid--third">
        {/* 数据清理是动作不是输入控件：div + 显式按钮，不用 label 包裹（label
            关联会改变 button 的 accessible name，语义也不成立）。 */}
        <div>
          <span className="settings__field-label-with-icon"><Trash2 size={13} />{t('settings.browser.clearCacheLabel')}</span>
          <small>{t('settings.browser.clearCacheHint')}</small>
          <button
            type="button"
            aria-label={t('settings.browser.clearCacheAria')}
            className="secondary-button"
            disabled={busy !== null || status?.running}
            onClick={() => { void handleClearProfileData('cache') }}
          >
            {busy === 'clearCache' ? t('settings.browser.clearing') : t('settings.browser.clearCacheButton')}
          </button>
        </div>
        <div>
          <span className="settings__field-label-with-icon"><Trash2 size={13} />{t('settings.browser.clearAllLabel')}</span>
          <small>{t('settings.browser.clearAllHint')}</small>
          <button
            type="button"
            aria-label={t('settings.browser.clearAllAria')}
            className="secondary-button settings__danger-button"
            disabled={busy !== null || status?.running}
            onClick={() => { void handleClearProfileData('all') }}
          >
            {busy === 'clearAll' ? t('settings.browser.clearing') : t('settings.browser.clearAllButton')}
          </button>
        </div>
      </div>
      {status?.running && (
        <p className="security-note">
          <LockKeyhole size={13} aria-hidden />
          <span>{t('settings.browser.dataRunningNote')}</span>
        </p>
      )}

      {status?.running && (
        <p className="security-note security-note--accent">
          <LockKeyhole size={13} aria-hidden />
          <span>
            {t('settings.browser.runningNote', {
              engine: status.engine ?? t('settings.browser.engineUnknown'),
              version: status.version ?? t('settings.browser.versionUnknown'),
              port: status.port ?? '?',
              mode: status.headless ? t('settings.browser.mode.headlessShort') : t('settings.browser.mode.headedShort'),
              tabs: status.tabs ?? 0,
            })}
          </span>
        </p>
      )}
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.browser.securityNote')}</span>
      </p>

      <div className="settings-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void handleTest()}
          disabled={busy !== null}
        >
          <FlaskConical size={13} />{busy === 'test' ? t('settings.browser.testing') : t('settings.browser.test')}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void handleShutdown()}
          disabled={busy !== null || !status?.running}
        >
          <PowerOff size={13} />{t('settings.browser.shutdown')}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void handleSave()}
          disabled={busy !== null || !draftChanged}
        >
          {busy === 'save' ? t('settings.browser.saving') : t('settings.browser.save')}
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
