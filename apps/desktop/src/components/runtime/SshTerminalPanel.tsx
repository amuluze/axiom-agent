import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChevronUp, File, Folder, FolderPlus, Loader2, RefreshCw, Server, SquareTerminal, Upload, X } from 'lucide-react'
import { ensureSshEvents, useSshStore, type SshSessionPhase } from '@/stores/sshStore'
import type { RemoteDirEntry } from '@/platform/sshSession'
import {
  DEFAULT_SFTP_PANEL_HEIGHT,
  SFTP_PANEL_BODY_RESERVED_HEIGHT,
  useUiStore,
} from '@/stores/uiStore'
import { useSshTerminals } from './useSshTerminals'
import { useT } from '@/i18n'

/**
 * SSH 终端面板（SshView 右栏，对齐设计稿「Axiom — SSH」终端列）：
 * 主机选择器 + xterm 终端 + 状态栏 + SFTP 文件浏览器。
 *
 * - 每主机一个会话（Rust 侧权威）：主机行/选择器选中未连接主机即自动连接；
 *   密码 /host-key 等交互提示直接出现在终端里（用户亲手输入，stdin 经 Rust
 *   原生 keyDown 手势门校验，与本地终端同一防线）。
 * - 每主机独立 xterm 实例（见 useSshTerminals），切换主机只切显示/隐藏、保留
 *   各主机的缓冲历史与光标——不再用单实例 + reset 清屏。
 * - 输出经 Rust PTY 读线程转发（axiom:ssh-event），按 hostId 分发到对应实例；
 *   done 事件驱动状态回落并打印断开横幅（连接期退出非零码视为「连接失败」，
 *   主机选择器行提供 ↻ 重连）。
 * - 文件浏览器：主机选择器行文件夹图标从终端底部弹出 SFTP 面板（对齐设计稿
 *   `waUDZ`），含 创建文件夹 / 上传文件 / 上传文件夹 / 关闭 + 远程文件列表
 *   （名称 · 修改时间 · 权限），目录可进入、可返回上级。
 */

const getStatusText = (phase: SshSessionPhase, t: (key: string) => string): string => {
  switch (phase) {
    case 'connecting':
      return t('app.sshView.terminal.status.connecting')
    case 'connected':
      return t('app.sshView.terminal.status.connected')
    case 'closed':
      return t('app.sshView.terminal.status.closed')
    case 'failed':
      return t('app.sshView.terminal.status.failed')
    default:
      return t('app.sshView.terminal.status.idle')
  }
}

/** 键盘调整步长（px）：resizer 聚焦后 ArrowUp/ArrowDown 增减高度。 */
const KEYBOARD_RESIZE_STEP = 24
/** 拖拽期间挂在 <html> 上的类名：全局 row-resize 光标 + 禁止文本选择。 */
const SFTP_RESIZING_CLASS = 'sshview__sftp--resizing'

export const SshTerminalPanel = () => {
  const { t } = useT()
  const hosts = useSshStore((state) => state.hosts)
  const sessions = useSshStore((state) => state.sessions)
  const uploads = useSshStore((state) => state.uploads)
  const activeHostId = useSshStore((state) => state.activeHostId)
  const setActiveHostId = useSshStore((state) => state.setActiveHostId)
  const closeSession = useSshStore((state) => state.closeSession)
  const refreshSessions = useSshStore((state) => state.refreshSessions)
  const markSessionConnecting = useSshStore((state) => state.markSessionConnecting)
  const markUploadFailed = useSshStore((state) => state.markUploadFailed)
  const markUploadDone = useSshStore((state) => state.markUploadDone)
  const cancelUpload = useSshStore((state) => state.cancelUpload)
  const resumeUpload = useSshStore((state) => state.resumeUpload)
  const unexpectedCloses = useSshStore((state) => state.unexpectedCloses)
  const clearUnexpectedClose = useSshStore((state) => state.clearUnexpectedClose)
  const dirs = useSshStore((state) => state.dirs)
  const currentDir = useSshStore((state) => state.currentDir)
  const dirsLoading = useSshStore((state) => state.dirsLoading)
  const dirError = useSshStore((state) => state.dirError)
  const loadDir = useSshStore((state) => state.loadDir)
  const makeDir = useSshStore((state) => state.makeDir)
  const uploadFolder = useSshStore((state) => state.uploadFolder)
  const setCurrentDir = useSshStore((state) => state.setCurrentDir)
  const fontSizePx = useUiStore((state) => state.fontSizePx)
  const monoFontFamily = useUiStore((state) => state.monoFontFamily)
  const sftpPanelHeight = useUiStore((state) => state.sftpPanelHeight)
  const setSftpPanelHeight = useUiStore((state) => state.setSftpPanelHeight)

  const { getSlotRef, getTerminal, fitFocus } = useSshTerminals({
    hosts,
    activeHostId,
    fontSizePx,
    monoFontFamily,
  })
  /** 同一主机只自动连接一次（断开后由用户手动重连/再选中触发）。 */
  const autoConnectedRef = useRef(new Set<string>())
  /** SSH 终端栏根元素：SFTP 面板高度上限按该栏实测高度计算。 */
  const paneRef = useRef<HTMLElement | null>(null)
  const sftpDragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  /** SFTP 文件浏览器是否展开（主机选择器行文件夹图标门控）。 */
  const [filePanelOpen, setFilePanelOpen] = useState(false)
  /** 内联新建文件夹输入态。 */
  const [mkdirInput, setMkdirInput] = useState(false)
  const [mkdirName, setMkdirName] = useState('')

  useEffect(() => {
    ensureSshEvents()
    void refreshSessions()
  }, [refreshSessions])

  /** 打开文件浏览器时定位到当前目录（缺省 `~`）。 */
  useEffect(() => {
    if (!filePanelOpen || !activeHostId) return
    const dir = currentDir[activeHostId] ?? '~'
    void loadDir(activeHostId, dir)
  }, [filePanelOpen, activeHostId, loadDir])

  /** 连接指定主机：openSession 失败 → attachError + 终端红色横幅（store 已回落状态）。 */
  const connectHost = useCallback(
    (hostId: string): void => {
      markSessionConnecting(hostId)
      const term = getTerminal(hostId)
      void useSshStore
        .getState()
        .openSession(hostId, term?.cols ?? 80, term?.rows ?? 24)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setAttachError(message)
          getTerminal(hostId)?.write(
            `\r\n\x1b[31m${t('app.sshView.terminal.connectFailed', { message })}\x1b[0m\r\n`,
          )
        })
    },
    [getTerminal, markSessionConnecting, t],
  )

  // 激活主机变化（主机行点击或选择器清空）：切显示对应实例并 fit+focus；
  // 未连接则自动连接。切回「未选择主机」同样切换——各实例缓冲保留隐藏。
  useEffect(() => {
    if (!activeHostId) {
      autoConnectedRef.current.clear()
      return
    }
    setAttachError(null)
    const { sessions: currentSessions, hosts: currentHosts } = useSshStore.getState()
    const phase = currentSessions[activeHostId]
    if (phase === 'connecting' || phase === 'connected') {
      fitFocus(activeHostId)
      return
    }
    if (!currentHosts.some((entry) => entry.id === activeHostId)) return
    fitFocus(activeHostId)
    if (autoConnectedRef.current.has(activeHostId)) return
    autoConnectedRef.current.add(activeHostId)
    clearUnexpectedClose(activeHostId)
    connectHost(activeHostId)
  }, [activeHostId, clearUnexpectedClose, fitFocus, connectHost])

  const activeHost = hosts.find((entry) => entry.id === activeHostId) ?? null
  const phase: SshSessionPhase | null = (activeHostId && sessions[activeHostId]) || null
  const upload = activeHostId ? uploads[activeHostId] : undefined
  const uploadPct =
    upload && upload.total > 0 ? Math.min(100, Math.round((upload.transferred / upload.total) * 100)) : 0

  const handleDisconnect = async (): Promise<void> => {
    if (!activeHostId) return
    await closeSession(activeHostId).catch(() => undefined)
    autoConnectedRef.current.delete(activeHostId)
  }

  /** 触发上传文件到当前浏览目录：路径由 Rust 原生选择器决定；失败经事件/此处投影。 */
  const handleUpload = async (): Promise<void> => {
    if (!activeHostId || phase !== 'connected' || upload) return
    try {
      await useSshStore.getState().uploadFile(activeHostId, currentDir[activeHostId] ?? '~')
    } catch (error) {
      markUploadFailed(
        activeHostId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 触发上传文件夹到当前浏览目录（递归，进度逐文件投影）。 */
  const handleUploadFolder = async (): Promise<void> => {
    if (!activeHostId || phase !== 'connected') return
    try {
      await uploadFolder(activeHostId, currentDir[activeHostId] ?? '~')
    } catch (error) {
      markUploadFailed(
        activeHostId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  const handleCancelUpload = async (): Promise<void> => {
    if (!activeHostId) return
    await cancelUpload(activeHostId).catch(() => undefined)
  }

  const handleResumeUpload = async (): Promise<void> => {
    if (!activeHostId || phase !== 'connected') return
    try {
      await resumeUpload(activeHostId)
    } catch (error) {
      markUploadFailed(
        activeHostId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 意外掉线（非用户主动断开）或连接失败 → 选择器行 ↻ 提供一键重连。 */
  const needsReconnect = activeHostId != null && (
    Boolean(unexpectedCloses[activeHostId]) || phase === 'failed'
  )

  const handleReconnect = (): void => {
    if (!activeHostId) return
    clearUnexpectedClose(activeHostId)
    setAttachError(null)
    autoConnectedRef.current.delete(activeHostId)
    connectHost(activeHostId)
  }

  /** 创建远程目录（相对当前浏览目录）后刷新列表。 */
  const handleMakeDir = async (name: string): Promise<void> => {
    if (!activeHostId || !name.trim()) return
    const base = currentDir[activeHostId] ?? '~'
    const trimmed = name.trim()
    const target = base === '~'
      ? `~/${trimmed}`
      : `${base.replace(/\/$/, '')}/${trimmed}`
    try {
      await makeDir(activeHostId, target)
      await loadDir(activeHostId, base)
    } catch {
      // makeDir 错误已写入 store.error。
    }
  }

  const submitMkdir = async (): Promise<void> => {
    if (!activeHostId) return
    await handleMakeDir(mkdirName)
    setMkdirName('')
    setMkdirInput(false)
  }

  /** 进入远程子目录（仅目录可点）。 */
  const openEntry = (hostId: string, entry: RemoteDirEntry): void => {
    if (!entry.isDir) return
    const base = currentDir[hostId] ?? '~'
    const next = base === '~'
      ? `~/${entry.name}`
      : `${base.replace(/\/$/, '')}/${entry.name}`
    setCurrentDir(hostId, next)
    void loadDir(hostId, next)
  }

  /** 返回上级目录：`~/sub` → `~` → `/`（文件系统根）；仅在 `/` 顶层不动。 */
  const goUp = (hostId: string): void => {
    const base = currentDir[hostId] ?? '~'
    if (base === '/') return
    let parent: string
    if (base === '~') {
      parent = '/'
    } else if (base.startsWith('~/')) {
      const rest = base.slice(2)
      const idx = rest.lastIndexOf('/')
      parent = idx <= 0 ? '~' : `~/${rest.slice(0, idx)}`
    } else {
      const idx = base.lastIndexOf('/')
      parent = idx <= 0 ? '/' : base.slice(0, idx)
    }
    setCurrentDir(hostId, parent)
    void loadDir(hostId, parent)
  }

  /** SFTP 面板高度上限按终端栏实测：栏高减去上方终端区保留（hostbar + footer + 数行可见终端）。 */
  const sftpPaneMaxHeight = (): number | undefined => {
    const pane = paneRef.current
    return pane ? pane.clientHeight - SFTP_PANEL_BODY_RESERVED_HEIGHT : undefined
  }

  // 把手拖拽经 pointer capture 保证指针移出把手仍持续收到 move/up；clamp 集中在
  // uiStore 的 setSftpPanelHeight（上限取终端栏实测高度）。SFTP 面板是终端栏内
  // 浮层，不改变终端容器尺寸，无需触发 xterm fit。startHeight 先按当前上限收口，
  // 避免窗口缩小后残留的偏大偏好让拖拽前段「空行程」。
  const onSftpResizePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.currentTarget.setPointerCapture) return
    event.preventDefault()
    const startHeight = Math.min(sftpPanelHeight, sftpPaneMaxHeight() ?? sftpPanelHeight)
    sftpDragRef.current = { startY: event.clientY, startHeight }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      sftpDragRef.current = null
      return
    }
    document.documentElement.classList.add(SFTP_RESIZING_CLASS)
  }

  const onSftpResizePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = sftpDragRef.current
    if (!drag) return
    const next = drag.startHeight + (drag.startY - event.clientY)
    if (next !== useUiStore.getState().sftpPanelHeight) {
      setSftpPanelHeight(next, sftpPaneMaxHeight())
    }
  }

  const onSftpResizePointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (!sftpDragRef.current) return
    sftpDragRef.current = null
    document.documentElement.classList.remove(SFTP_RESIZING_CLASS)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onSftpResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const delta = event.key === 'ArrowUp' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP
    setSftpPanelHeight(useUiStore.getState().sftpPanelHeight + delta, sftpPaneMaxHeight())
  }

  const selectorValue = activeHost
    ? t('app.sshView.terminal.selector.value', {
        name: activeHost.name,
        hostname: activeHost.hostname,
        port: activeHost.port,
      })
    : t('app.sshView.terminal.selector.unselected')

  const footerStatus = upload
    ? upload.error
      ? t('app.sshView.terminal.footer.uploadFailed', { error: upload.error })
      : t('app.sshView.terminal.footer.uploading', { name: upload.name, pct: uploadPct })
    : attachError
      ? t('app.sshView.terminal.footer.failed')
      : phase === 'connected' && activeHost
        ? t('app.sshView.terminal.footer.connectedLink', {
            phase: getStatusText(phase, t),
            user: activeHost.username,
            host: activeHost.hostname,
            port: activeHost.port,
          })
        : phase
          ? getStatusText(phase, t)
          : t('app.sshView.terminal.status.idle')

  /** 重连入口仅在连接失败/意外掉线后可点（连接中/已连接时禁用）。 */
  const reconnectDisabled =
    !activeHostId || phase === 'connecting' || phase === 'connected'

  const dirPath = activeHostId ? (currentDir[activeHostId] ?? '~') : '~'
  const dirErrorMsg = activeHostId ? (dirError[activeHostId] ?? null) : null
  // 缓存列表带路径标签：仅当缓存确实属于当前路径才渲染——失败/导航中
  // 绝不拿别的目录的条目充数（静默失败曾表现为「点了没反应」）。
  const cachedListing = activeHostId ? dirs[activeHostId] : undefined
  const entries: RemoteDirEntry[] | null =
    cachedListing && cachedListing.path === dirPath ? cachedListing.entries : null

  if (hosts.length === 0) {
    return (
      <section className="sshview__terminal-pane" aria-label={t('app.sshView.terminal.aria')}>
        <div className="sshview__empty">
          <SquareTerminal size={34} strokeWidth={1.5} />
          <div className="sshview__empty-title">{t('app.sshView.terminal.empty.title')}</div>
          <div className="sshview__empty-hint">{t('app.sshView.terminal.empty.hint')}</div>
        </div>
      </section>
    )
  }

  return (
    <section ref={paneRef} className="sshview__terminal-pane" aria-label={t('app.sshView.terminal.aria')}>
      <div className="sshview__hostbar">
        <Server size={15} aria-hidden />
        <span className="sshview__hostbar-value" title={selectorValue}>
          {selectorValue}
        </span>
        <span className="sshview__term-spacer" />
        <button
          type="button"
          className="sshview__term-action"
          aria-label={t('app.sshView.terminal.action.toggleFilesAria')}
          title={filePanelOpen
            ? t('app.sshView.terminal.action.toggleFilesTitle.close')
            : t('app.sshView.terminal.action.toggleFilesTitle.open')}
          disabled={!activeHostId}
          onClick={() => setFilePanelOpen((open) => !open)}
        >
          <Folder size={13} aria-hidden />
        </button>
        <button
          type="button"
          className={`sshview__term-action${needsReconnect ? ' sshview__term-action--warn' : ''}`}
          aria-label={t('app.sshView.terminal.action.reconnectAria')}
          title={t('app.sshView.terminal.action.reconnectTitle')}
          disabled={reconnectDisabled}
          onClick={handleReconnect}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="sshview__term-action sshview__term-action--close"
          aria-label={t('app.sshView.terminal.action.clearAria')}
          title={t('app.sshView.terminal.action.clearTitle')}
          onClick={() => setActiveHostId(null)}
        >
          <X size={15} aria-hidden />
        </button>
      </div>

      {/* 每主机一个独立终端实例（隐藏容器保活）：激活的可见，其余 display:none。 */}
      <div className="sshview__term">
        <div className="sshview__term-body">
          {hosts.map((host) => (
            <div
              key={host.id}
              className="sshview__term-slot"
              ref={getSlotRef(host.id)}
              hidden={host.id !== activeHostId}
              aria-hidden={host.id !== activeHostId}
            />
          ))}
        </div>
      </div>

      <div className="sshview__footer">
        <span className={`sshview__dot${phase ? ` sshview__dot--${phase}` : ''}`} aria-hidden />
        <span className="sshview__footer-status">{footerStatus}</span>
        {upload && !upload.error && (
          <>
            <span className="sshview__upload-bar" aria-hidden>
              <span className="sshview__upload-bar-fill" style={{ width: `${uploadPct}%` }} />
            </span>
            <button
              type="button"
              className="sshview__upload-dismiss"
              onClick={() => void handleCancelUpload()}
            >
              {t('app.sshView.terminal.upload.cancel')}
            </button>
          </>
        )}
        {upload?.error && (
          <>
            <button
              type="button"
              className="sshview__upload-dismiss"
              onClick={() => void handleResumeUpload()}
            >
              {t('app.sshView.terminal.upload.resume')}
            </button>
            <button
              type="button"
              className="sshview__upload-dismiss"
              aria-label={t('app.sshView.terminal.upload.dismissAria')}
              onClick={() => {
                if (activeHostId) markUploadDone(activeHostId)
              }}
            >
              {t('app.sshView.terminal.upload.dismiss')}
            </button>
          </>
        )}
        <span className="sshview__term-spacer" />
        <button
          type="button"
          className="sshview__footer-disconnect"
          disabled={!phase || phase === 'connecting' || phase === 'failed'}
          onClick={() => void handleDisconnect()}
        >
          {t('app.sshView.terminal.footer.disconnect')}
        </button>
      </div>

      {/* SFTP 文件浏览器：从终端底部向上弹出的面板（对齐设计稿「Axiom — SSH」waUDZ）。
          高度经顶部把手拖拽/键盘调整，偏好经 uiStore 持久化。 */}
      {filePanelOpen && activeHostId && (
        <div
          className="sshview__sftp"
          aria-label={t('app.sshView.terminal.sftp.aria')}
          style={{ height: sftpPanelHeight }}
        >
          <div
            className="sshview__sftp-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('app.sshView.terminal.sftp.resizerAria')}
            aria-valuenow={Math.round(sftpPanelHeight)}
            tabIndex={0}
            onPointerDown={onSftpResizePointerDown}
            onPointerMove={onSftpResizePointerMove}
            onPointerUp={onSftpResizePointerEnd}
            onPointerCancel={onSftpResizePointerEnd}
            onKeyDown={onSftpResizeKeyDown}
            onDoubleClick={() =>
              setSftpPanelHeight(DEFAULT_SFTP_PANEL_HEIGHT, sftpPaneMaxHeight())
            }
          />
          <div className="sshview__sftp-header">
            <span className="sshview__sftp-title">{t('app.sshView.terminal.sftp.title')}</span>
            <span className="sshview__term-spacer" />
            <button
              type="button"
              className="sshview__sftp-action"
              aria-label={t('app.sshView.terminal.sftp.action.mkdirAria')}
              title={t('app.sshView.terminal.sftp.action.mkdir')}
              onClick={() => {
                setMkdirName('')
                setMkdirInput(true)
              }}
            >
              <FolderPlus size={13} aria-hidden />
              <span>{t('app.sshView.terminal.sftp.action.mkdir')}</span>
            </button>
            <button
              type="button"
              className="sshview__sftp-action"
              aria-label={t('app.sshView.terminal.sftp.action.uploadFileAria')}
              title={upload
                ? t('app.sshView.terminal.sftp.action.uploadFileTitleBusy')
                : t('app.sshView.terminal.sftp.action.uploadFileTitle')}
              disabled={phase !== 'connected' || Boolean(upload)}
              onClick={() => void handleUpload()}
            >
              <Upload size={13} aria-hidden />
              <span>{t('app.sshView.terminal.sftp.action.uploadFile')}</span>
            </button>
            <button
              type="button"
              className="sshview__sftp-action"
              aria-label={t('app.sshView.terminal.sftp.action.uploadFolderAria')}
              title={t('app.sshView.terminal.sftp.action.uploadFolderTitle')}
              disabled={phase !== 'connected'}
              onClick={() => void handleUploadFolder()}
            >
              <Folder size={13} aria-hidden />
              <span>{t('app.sshView.terminal.sftp.action.uploadFolder')}</span>
            </button>
            <button
              type="button"
              className="sshview__sftp-action sshview__sftp-action--close"
              aria-label={t('app.sshView.terminal.sftp.action.closeAria')}
              title={t('app.sshView.terminal.sftp.action.close')}
              onClick={() => setFilePanelOpen(false)}
            >
              <X size={15} aria-hidden />
            </button>
          </div>

          {mkdirInput && (
            <div className="sshview__sftp-mkdir">
              <input
                value={mkdirName}
                placeholder={t('app.sshView.terminal.sftp.mkdirPlaceholder')}
                autoFocus
                onChange={(event) => setMkdirName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitMkdir()
                  else if (event.key === 'Escape') setMkdirInput(false)
                }}
              />
              <button
                type="button"
                className="sshview__sftp-submit"
                onClick={() => void submitMkdir()}
              >
                {t('app.sshView.terminal.sftp.mkdirSubmit')}
              </button>
              <button
                type="button"
                className="sshview__sftp-cancel"
                onClick={() => setMkdirInput(false)}
              >
                {t('app.sshView.terminal.sftp.mkdirCancel')}
              </button>
            </div>
          )}

          <div className="sshview__sftp-path">
            <button
              type="button"
              className="sshview__sftp-up"
              aria-label={t('app.sshView.terminal.sftp.upAria')}
              title={dirPath === '/'
                ? t('app.sshView.terminal.sftp.upTitleRoot')
                : t('app.sshView.terminal.sftp.upTitle')}
              disabled={dirPath === '/'}
              onClick={() => goUp(activeHostId)}
            >
              <ChevronUp size={13} aria-hidden />
            </button>
            <span className="sshview__sftp-path-value" title={dirPath}>
              {dirPath}
            </span>
          </div>

          <div className="sshview__sftp-list">
            {dirsLoading[activeHostId] ? (
              <div className="sshview__sftp-loading">
                <Loader2 className="sshview__sftp-spin" size={16} aria-hidden />
                <span>{t('app.sshView.terminal.sftp.loading')}</span>
              </div>
            ) : dirErrorMsg ? (
              <div className="sshview__sftp-error" role="alert">
                <span className="sshview__sftp-error-text">
                  {t('app.sshView.terminal.sftp.dirError', { message: dirErrorMsg })}
                </span>
                <button
                  type="button"
                  className="sshview__sftp-error-retry"
                  onClick={() => void loadDir(activeHostId, dirPath)}
                >
                  {t('app.sshView.terminal.sftp.dirRetry')}
                </button>
              </div>
            ) : entries === null ? (
              <div className="sshview__sftp-error">
                <span className="sshview__sftp-error-text">
                  {t('app.sshView.terminal.sftp.notLoaded')}
                </span>
                <button
                  type="button"
                  className="sshview__sftp-error-retry"
                  onClick={() => void loadDir(activeHostId, dirPath)}
                >
                  {t('app.sshView.terminal.sftp.load')}
                </button>
              </div>
            ) : entries.length === 0 ? (
              <span className="sshview__sftp-empty">{t('app.sshView.terminal.sftp.empty')}</span>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="sshview__sftp-row"
                  onClick={() => openEntry(activeHostId, entry)}
                >
                  <span className="sshview__sftp-row-icon" aria-hidden>
                    {entry.isDir ? <Folder size={15} /> : <File size={15} />}
                  </span>
                  <span className="sshview__sftp-row-name" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="sshview__sftp-row-meta">
                    <span className="sshview__sftp-row-date">{entry.modifiedAt}</span>
                    <span className="sshview__sftp-row-perms">{entry.perms}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  )
}
