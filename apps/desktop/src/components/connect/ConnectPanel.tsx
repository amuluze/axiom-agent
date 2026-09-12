import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useConnectStore } from '@/stores/connectStore'
import { useUiStore } from '@/stores/uiStore'
import { pollWechatLogin, type ConnectPlatform, type ConnectWechatLoginStatus } from '@/platform/connect'
import { Loader2, MessageSquareText, Plug, QrCode, Trash2, Unplug, X } from 'lucide-react'
import { DingtalkIcon, FeishuIcon, getPlatformLabel, WeixinIcon } from '@/components/connect/ConnectIcons'
import { useT } from '@/i18n'

/**
 * 连接面板：侧边栏底部的浮层。管理三平台（飞书 / 钉钉 / 微信个人号）的
 * 凭证配置、连接启停、配对绑定与微信扫码登录，以及远程会话工作目录。
 */

const PLATFORM_ICONS: Record<ConnectPlatform, ReactNode> = {
  feishu: <FeishuIcon size={14} />,
  dingtalk: <DingtalkIcon size={14} />,
  weixin: <WeixinIcon size={14} />,
}

const getStatusLabel = (status: string, t: (key: string) => string): string => {
  switch (status) {
    case 'unconfigured': return t('app.connect.platform.unconfigured')
    case 'disconnected': return t('app.connect.platform.disconnected')
    case 'connecting': return t('app.connect.platform.connecting')
    case 'connected': return t('app.connect.platform.connected')
    case 'error': return t('app.connect.platform.error')
    default: return status
  }
}

/** 渲染 Rust 生成的 QR 点阵（'1' 为暗模块），不引入二维码依赖。 */
const QrMatrix = ({ rows, size = 172, ariaLabel }: { rows: string[]; size?: number; ariaLabel: string }) => {
  const count = rows.length
  if (count === 0) return null
  const cell = size / count
  const dark: ReactNode[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === '1') {
        dark.push(
          <rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell + 0.4} height={cell + 0.4} />,
        )
      }
    }
  })
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={ariaLabel}
      className="connect-panel__qr"
    >
      <rect width={size} height={size} fill="white" />
      {dark}
    </svg>
  )
}

const WechatLoginFlow = () => {
  const { t } = useT()
  const { wechatLogin, wechatLoginMessage, beginWechatLogin, setWechatLoginMessage, clearWechatLogin, refresh } =
    useConnectStore()
  const [status, setStatus] = useState<ConnectWechatLoginStatus>({ status: 'waiting' })
  const [rows, setRows] = useState<string[]>([])
  const pollRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!wechatLogin) return
    const poll = async (): Promise<void> => {
      if (!wechatLogin) return
      let next: ConnectWechatLoginStatus
      try {
        next = await pollWechatLogin(wechatLogin.loginId)
      } catch {
        next = { status: 'failed', message: t('app.connect.wechat.pollFailed') }
      }
      setStatus(next)
      if (next.status === 'waiting' && next.rows && next.rows.length > 0) {
        setRows(next.rows)
      }
      if (next.status === 'confirmed') {
        stopPolling()
        setWechatLoginMessage(t('app.connect.wechat.confirmed'))
        void refresh()
        window.setTimeout(() => clearWechatLogin(), 2500)
      } else if (next.status === 'expired' || next.status === 'failed') {
        stopPolling()
      }
    }
    void poll()
    pollRef.current = window.setInterval(() => { void poll() }, 1500)
    return stopPolling
  }, [wechatLogin, clearWechatLogin, refresh, setWechatLoginMessage, stopPolling])

  if (!wechatLogin) {
    return (
      <div className="connect-panel__login-empty">
        <button
          type="button"
          className="connect-panel__button connect-panel__button--primary"
          onClick={() => { void beginWechatLogin() }}
        >
          <QrCode size={13} />
          {t('app.connect.wechat.scanLogin')}
        </button>
        <span className="connect-panel__hint">{t('app.connect.wechat.scanHint')}</span>
      </div>
    )
  }

  return (
    <div className="connect-panel__login">
      {status.status === 'scanned' && <div className="connect-panel__login-tip">{t('app.connect.wechat.scanned')}</div>}
      {status.status === 'waiting' && rows.length > 0 && (
        <div className="connect-panel__login-qr">
          <QrMatrix rows={rows} ariaLabel={t('app.connect.weixin.qrAria')} />
          <span className="connect-panel__hint">{t('app.connect.wechat.qrHint')}</span>
        </div>
      )}
      {status.status === 'starting' && (
        <div className="connect-panel__login-loading">
          <Loader2 size={14} className="connect-panel__spinner" />
          {t('app.connect.wechat.starting')}
        </div>
      )}
      {status.status === 'expired' && (
        <div className="connect-panel__login-expired">
          <span>{t('app.connect.wechat.expired')}</span>
          <button
            type="button"
            className="connect-panel__button"
            onClick={() => { void beginWechatLogin() }}
          >
            {t('app.connect.wechat.regenerate')}
          </button>
        </div>
      )}
      {status.status === 'failed' && (
        <div className="connect-panel__login-error">{status.message}</div>
      )}
      {wechatLoginMessage && <div className="connect-panel__login-message">{wechatLoginMessage}</div>}
    </div>
  )
}

interface PlatformCardProps {
  platform: ConnectPlatform
}

const PlatformCard = ({ platform }: PlatformCardProps) => {
  const { t } = useT()
  const platforms = useConnectStore((state) => state.config.platforms)
  const actionBusy = useConnectStore((state) => state.actionBusy)
  const savePlatformConfig = useConnectStore((state) => state.savePlatformConfig)
  const clearPlatformConfig = useConnectStore((state) => state.clearPlatformConfig)
  const connect = useConnectStore((state) => state.connect)
  const disconnect = useConnectStore((state) => state.disconnect)
  const entry = platforms.find((item) => item.platform === platform)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const configured = entry?.configured ?? false
  const status = entry?.status ?? 'unconfigured'
  const busy = actionBusy

  const fields = platform === 'feishu'
    ? [
        { key: 'appId', label: t('app.connect.platform.fields.feishu.appId'), placeholder: t('app.connect.platform.fields.feishu.appIdPlaceholder'), secret: false },
        { key: 'appSecret', label: t('app.connect.platform.fields.feishu.appSecret'), placeholder: t('app.connect.platform.fields.feishu.appSecretPlaceholder'), secret: true },
      ]
    : platform === 'dingtalk'
      ? [
          { key: 'clientId', label: t('app.connect.platform.fields.dingtalk.clientId'), placeholder: t('app.connect.platform.fields.dingtalk.clientIdPlaceholder'), secret: false },
          { key: 'clientSecret', label: t('app.connect.platform.fields.dingtalk.clientSecret'), placeholder: t('app.connect.platform.fields.dingtalk.clientSecretPlaceholder'), secret: true },
        ]
      : []

  const startEdit = (): void => {
    setForm({})
    setError(null)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    if (platform === 'weixin') return
    setError(null)
    const errorMessage = await savePlatformConfig(platform, form)
    if (errorMessage) setError(errorMessage)
    else setEditing(false)
  }

  const isConfigured = platform === 'weixin' || configured

  return (
    <section className="connect-panel__platform">
      <div className="connect-panel__platform-header">
        <span className="connect-panel__platform-icon">{PLATFORM_ICONS[platform]}</span>
        <span className="connect-panel__platform-name">{getPlatformLabel(platform, t)}</span>
        <span className={`connect-panel__status connect-panel__status--${status}`}>
          {getStatusLabel(status, t) ?? status}
        </span>
        {entry?.credentialHint && (
          <span className="connect-panel__credential-hint" title={t('app.connect.platform.credentialHint')}>{entry.credentialHint}</span>
        )}
      </div>
      {entry?.message && status === 'error' && (
        <div className="connect-panel__platform-error">{entry.message}</div>
      )}
      {!editing && (
        <div className="connect-panel__platform-actions">
          {!isConfigured && (
            <button type="button" className="connect-panel__button" onClick={startEdit}>
              {t('app.connect.platform.configure')}
            </button>
          )}
          {isConfigured && status !== 'connected' && (
            <button
              type="button"
              className="connect-panel__button connect-panel__button--primary"
              disabled={busy}
              onClick={() => { void connect(platform) }}
            >
              <Plug size={12} />
              {t('app.connect.platform.connect')}
            </button>
          )}
          {isConfigured && status === 'connected' && (
            <button
              type="button"
              className="connect-panel__button"
              disabled={busy}
              onClick={() => { void disconnect(platform) }}
            >
              <Unplug size={12} />
              {t('app.connect.platform.disconnect')}
            </button>
          )}
          {isConfigured && (
            <button
              type="button"
              className="connect-panel__button connect-panel__button--danger"
              title={t('app.connect.platform.credentialHint')}
              onClick={() => {
                const confirmed = window.confirm(t('app.connect.platform.removeConfirm', { platform: getPlatformLabel(platform, t) }))
                if (!confirmed) return
                void clearPlatformConfig(platform)
              }}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
      {editing && (
        <div className="connect-panel__platform-form">
          {fields.map((field) => (
            <label className="connect-panel__field" key={field.key}>
              <span>{field.label}</span>
              <input
                type={field.secret ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={form[field.key] ?? ''}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            </label>
          ))}
          {error && <div className="connect-panel__platform-error">{error}</div>}
          <div className="connect-panel__platform-form-actions">
            <button
              type="button"
              className="connect-panel__button connect-panel__button--primary"
              disabled={busy}
              onClick={() => { void save() }}
            >
              {t('app.connect.platform.save')}
            </button>
            <button type="button" className="connect-panel__button" onClick={() => setEditing(false)}>
              {t('app.connect.platform.cancel')}
            </button>
          </div>
        </div>
      )}
      {platform === 'weixin' && <WechatLoginFlow />}
    </section>
  )
}

const BindingsSection = () => {
  const { t } = useT()
  const bindings = useConnectStore((state) => state.config.bindings)
  const unpair = useConnectStore((state) => state.unpair)
  const [removing, setRemoving] = useState<Record<string, boolean>>({})
  if (bindings.length === 0) {
    return (
      <div className="connect-panel__empty">
        <MessageSquareText size={14} />
        <span>{t('app.connect.bindings.empty')}</span>
      </div>
    )
  }
  return (
    <ul className="connect-panel__bindings">
      {bindings.map((binding) => {
        const key = `${binding.platform}:${binding.chatId}:${binding.userId}`
        return (
          <li className="connect-panel__binding" key={key}>
            <span className="connect-panel__binding-icon">{PLATFORM_ICONS[binding.platform]}</span>
            <span className="connect-panel__binding-name">
              {binding.userName || binding.userId}
              <span className="connect-panel__binding-meta">
                {getPlatformLabel(binding.platform, t)} · {binding.chatType === 'group' ? t('app.connect.bindings.meta.group') : t('app.connect.bindings.meta.direct')}
              </span>
            </span>
            <button
              type="button"
              className="connect-panel__binding-remove"
              title={t('app.connect.bindings.remove')}
              disabled={removing[key]}
              onClick={() => {
                const confirmed = window.confirm(t('app.connect.platform.unpairConfirm', { platform: getPlatformLabel(binding.platform, t) }))
                if (!confirmed) return
                setRemoving((current) => ({ ...current, [key]: true }))
                void unpair(binding.platform, binding.chatId, binding.userId).finally(() => {
                  setRemoving((current) => ({ ...current, [key]: false }))
                })
              }}
            >
              <X size={12} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

const PairingSection = () => {
  const { t } = useT()
  const pairing = useConnectStore((state) => state.pairing)
  const newPairingCode = useConnectStore((state) => state.newPairingCode)
  const expiresAt = pairing ? pairing.expiresAt - Date.now() : 0
  const expired = pairing !== null && expiresAt <= 0
  return (
    <section className="connect-panel__section">
      <div className="connect-panel__section-title">{t('app.connect.section.pairing')}</div>
      {pairing && !expired && (
        <div className="connect-panel__pairing">
          <span className="connect-panel__pairing-label">
            {t('app.connect.pairing.label')}
          </span>
          <code className="connect-panel__pairing-code">/bind {pairing.code}</code>
          <span className="connect-panel__hint">
            {t('app.connect.pairing.hint', { seconds: Math.ceil(expiresAt / 1000) })}
          </span>
        </div>
      )}
      {pairing && expired && (
        <div className="connect-panel__hint">{t('app.connect.pairing.expired')}</div>
      )}
      <button
        type="button"
        className="connect-panel__button"
        onClick={() => { void newPairingCode() }}
      >
        {pairing ? t('app.connect.pairing.regenerate') : t('app.connect.pairing.generate')}
      </button>
    </section>
  )
}

const WorkspaceSection = () => {
  const { t } = useT()
  const workspacePath = useConnectStore((state) => state.config.workspacePath)
  const changeWorkspace = useConnectStore((state) => state.changeWorkspace)
  const sessions = useAgentStore((state) => state.sessions)
  const authorizedWorkspaces = useAgentStore((state) => state.authorizedWorkspaces)
  // 有会话在用的工作目录优先；否则取已授权目录列表。
  const options = authorizedWorkspaces.length > 0
    ? authorizedWorkspaces
    : Array.from(new Set(sessions.map((session) => session.workspace?.path).filter(Boolean))).map((path) => ({
        path: path as string,
        name: path as string,
      }))
  return (
    <section className="connect-panel__section">
      <div className="connect-panel__section-title">{t('app.connect.section.workspace')}</div>
      {options.length === 0 ? (
        <span className="connect-panel__hint">{t('app.connect.workspace.hint')}</span>
      ) : (
        <select
          className="connect-panel__select"
          value={workspacePath ?? ''}
          onChange={(event) => { void changeWorkspace(event.target.value || null) }}
        >
          <option value="">{t('app.connect.workspace.unselected')}</option>
          {options.map((workspace) => (
            <option key={workspace.path} value={workspace.path}>
              {workspace.name}
            </option>
          ))}
        </select>
      )}
    </section>
  )
}

export const ConnectPanel = () => {
  const { t } = useT()
  const setConnectPanelOpen = useUiStore((state) => state.setConnectPanelOpen)
  const loaded = useConnectStore((state) => state.loaded)
  const refresh = useConnectStore((state) => state.refresh)
  const replyError = useConnectStore((state) => state.replyError)
  const clearReplyError = useConnectStore((state) => state.clearReplyError)
  // 动作失败（连接/切换目录/扫码登录/配对码…）：此前被静默吞掉，面板没有任何反馈，
  // 用户只能看到「点了没反应」。现在一律投影成可见的失败提示条。
  const actionError = useConnectStore((state) => state.actionError)
  const setActionError = useConnectStore((state) => state.setActionError)
  const bindingsCount = useConnectStore((state) => state.config.bindings.length)
  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])
  return (
    <aside className="connect-panel" role="dialog" aria-label={t('app.connect.header.title')}>
      <div className="connect-panel__header">
        <span className="connect-panel__header-title">{t('app.connect.header.title')}</span>
        <button
          type="button"
          className="connect-panel__close"
          aria-label={t('app.connect.closeAria')}
          onClick={() => setConnectPanelOpen(false)}
        >
          <X size={14} />
        </button>
      </div>
      <div className="connect-panel__body">
        {replyError && (
          <div className="connect-panel__reply-error" role="alert">
            <span className="connect-panel__reply-error-text">
              {t('app.connect.replyError', { platform: getPlatformLabel(replyError.platform, t), message: replyError.message })}
            </span>
            <button
              type="button"
              className="connect-panel__reply-error-close"
              aria-label={t('app.connect.replyErrorCloseAria')}
              title={t('app.connect.replyErrorCloseTitle')}
              onClick={clearReplyError}
            >
              <X size={12} />
            </button>
          </div>
        )}
        {actionError && (
          <div className="connect-panel__action-error" role="alert">
            <span className="connect-panel__reply-error-text">
              {t('app.connect.actionError', { message: actionError })}
            </span>
            <button
              type="button"
              className="connect-panel__reply-error-close"
              aria-label={t('app.connect.actionErrorCloseAria')}
              title={t('app.connect.actionErrorCloseTitle')}
              onClick={() => setActionError(null)}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <WorkspaceSection />
        <section className="connect-panel__section">
          <div className="connect-panel__section-title">{t('app.connect.section.platforms')}</div>
          <div className="connect-panel__platforms">
            <PlatformCard platform="feishu" />
            <PlatformCard platform="dingtalk" />
            <PlatformCard platform="weixin" />
          </div>
        </section>
        <PairingSection />
        <section className="connect-panel__section">
          <div className="connect-panel__section-title">{t('app.connect.section.bindings', { count: bindingsCount })}</div>
          <BindingsSection />
        </section>
        {!loaded && <div className="connect-panel__loading">{t('app.connect.loading')}</div>}
      </div>
    </aside>
  )
}
