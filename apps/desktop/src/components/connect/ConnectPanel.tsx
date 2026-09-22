import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useConnectStore } from '@/stores/connectStore'
import { useUiStore } from '@/stores/uiStore'
import { pollWechatLogin, type ConnectPlatform, type ConnectWechatLoginStatus } from '@/platform/connect'
import { CircleAlert, Loader2, MessageSquareText, Plug, QrCode, Trash2, Unplug, X } from 'lucide-react'
import { getPlatformLabel } from '@/components/connect/ConnectIcons'
import { useT } from '@/i18n'

/**
 * 连接弹窗（.pen B9OLF 常态 / llrFR 操作失败态）：全屏遮罩上的居中模态。
 * 按设计稿范围收敛为仅微信个人号（扫码登录 / 单聊）+ 远程会话工作目录 +
 * 已配对聊天；飞书/钉钉后端能力保留但暂无配置入口。
 */

/** 品牌色块内的白字 glyph：设计语言为「品牌底色圆角方块 + 单字」。
 * 三平台全保留——已配对聊天列表可能仍含飞书/钉钉的历史绑定。 */
const PLATFORM_GLYPHS: Record<ConnectPlatform, string> = {
  feishu: '飞',
  dingtalk: '钉',
  weixin: '微',
}

const PlatformBadge = ({ platform, small = false }: { platform: ConnectPlatform; small?: boolean }) => (
  <span className={`connect-panel__brand connect-panel__brand--${platform}${small ? ' connect-panel__brand--sm' : ''}`} aria-hidden="true">
    {PLATFORM_GLYPHS[platform]}
  </span>
)

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

  // 未开始扫码：设计稿 Login Row——accent 主按钮与提示语横排。
  if (!wechatLogin) {
    return (
      <div className="connect-panel__login-row">
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

/** 设计稿「聊天平台」唯一卡片：微信个人号（扫码登录，无需凭证表单）。 */
const WechatCard = () => {
  const { t } = useT()
  const platforms = useConnectStore((state) => state.config.platforms)
  const actionBusy = useConnectStore((state) => state.actionBusy)
  const clearPlatformConfig = useConnectStore((state) => state.clearPlatformConfig)
  const connect = useConnectStore((state) => state.connect)
  const disconnect = useConnectStore((state) => state.disconnect)
  const entry = platforms.find((item) => item.platform === 'weixin')
  const status = entry?.status ?? 'unconfigured'
  const busy = actionBusy
  return (
    <section className="connect-panel__platform">
      {/* 设计稿 Head Row：品牌块 + 名称 + 状态 chip 在左，动作在右（同一行） */}
      <div className="connect-panel__platform-header">
        <PlatformBadge platform="weixin" />
        <span className="connect-panel__platform-name">{getPlatformLabel('weixin', t)}</span>
        <span className={`connect-panel__status connect-panel__status--${status}`}>
          {getStatusLabel(status, t) ?? status}
        </span>
        {entry?.credentialHint && (
          <span className="connect-panel__credential-hint" title={t('app.connect.platform.credentialHint')}>{entry.credentialHint}</span>
        )}
        <span className="connect-panel__spacer" />
        <div className="connect-panel__platform-actions">
          {status !== 'connected' && (
            <button
              type="button"
              className="connect-panel__button"
              disabled={busy}
              onClick={() => { void connect('weixin') }}
            >
              <Plug size={12} />
              {t('app.connect.platform.connect')}
            </button>
          )}
          {status === 'connected' && (
            <button
              type="button"
              className="connect-panel__button"
              disabled={busy}
              onClick={() => { void disconnect('weixin') }}
            >
              <Unplug size={12} />
              {t('app.connect.platform.disconnect')}
            </button>
          )}
          <button
            type="button"
            className="connect-panel__button connect-panel__button--danger"
            title={t('app.connect.platform.credentialHint')}
            aria-label={t('app.connect.platform.clearCredential')}
            onClick={() => {
              const confirmed = window.confirm(t('app.connect.platform.removeConfirm', { platform: getPlatformLabel('weixin', t) }))
              if (!confirmed) return
              void clearPlatformConfig('weixin')
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {entry?.message && status === 'error' && (
        <div className="connect-panel__platform-error">{entry.message}</div>
      )}
      <WechatLoginFlow />
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
            <PlatformBadge platform={binding.platform} small />
            <span className="connect-panel__binding-name">{binding.userName || binding.userId}</span>
            <span className="connect-panel__binding-meta">
              {getPlatformLabel(binding.platform, t)} · {binding.chatType === 'group' ? t('app.connect.bindings.meta.group') : t('app.connect.bindings.meta.direct')}
            </span>
            <button
              type="button"
              className="connect-panel__binding-remove"
              title={t('app.connect.bindings.remove')}
              aria-label={t('app.connect.bindings.remove')}
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
          className={`connect-panel__select${workspacePath ? '' : ' connect-panel__select--empty'}`}
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
  // 动作失败（连接/切换目录/扫码登录/解除配对…）：此前被静默吞掉，面板没有任何反馈，
  // 用户只能看到「点了没反应」。现在一律投影成可见的失败提示条（设计稿 llrFR 顶部横幅）。
  const actionError = useConnectStore((state) => state.actionError)
  const setActionError = useConnectStore((state) => state.setActionError)
  const bindingsCount = useConnectStore((state) => state.config.bindings.length)
  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])
  // Esc 关闭（与反馈弹窗同一交互）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConnectPanelOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setConnectPanelOpen])
  return (
    <div className="connect-backdrop" role="presentation">
      <aside className="connect-dialog" role="dialog" aria-modal="true" aria-label={t('app.connect.header.title')}>
        <div className="connect-dialog__header">
          <span className="connect-dialog__badge">
            <Plug size={16} />
          </span>
          <div className="connect-dialog__heading">
            <h2 className="connect-dialog__title">{t('app.connect.header.title')}</h2>
            <p className="connect-dialog__subtitle">{t('app.connect.header.subtitle')}</p>
          </div>
          <button
            type="button"
            className="connect-dialog__close"
            aria-label={t('app.connect.closeAria')}
            onClick={() => setConnectPanelOpen(false)}
          >
            <X size={15} />
          </button>
        </div>
        <div className="connect-dialog__body">
          {replyError && (
            <div className="connect-panel__reply-error" role="alert">
              <CircleAlert size={14} className="connect-panel__banner-icon" />
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
              <CircleAlert size={14} className="connect-panel__banner-icon" />
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
            <WechatCard />
          </section>
          <section className="connect-panel__section">
            <div className="connect-panel__section-title">{t('app.connect.section.bindings', { count: bindingsCount })}</div>
            <BindingsSection />
          </section>
          {!loaded && <div className="connect-panel__loading">{t('app.connect.loading')}</div>}
        </div>
      </aside>
    </div>
  )
}
