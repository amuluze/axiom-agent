import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { MonitorOff, Power, RotateCcw, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { setTerminalFocus } from '@/platform/terminal'
import { useAgentStore } from '@/stores/agentStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { DEFAULT_TERMINAL_PANEL_HEIGHT, useUiStore } from '@/stores/uiStore'
import { useT } from '@/i18n'
import {
  attachTerminal,
  detachTerminal,
  disposeTerminal,
  fitTerminal,
  restartTerminal,
  syncTerminalFont,
} from './terminalRuntime'

/** 键盘调整步长（px）：resizer 聚焦后 ArrowUp/ArrowDown 增减高度。 */
const KEYBOARD_RESIZE_STEP = 24
/** 拖拽期间挂在 <html> 上的类名：全局 row-resize 光标 + 禁止文本选择。 */
const RESIZING_CLASS = 'terminal-panel--resizing'

/**
 * 会话窗口底部终端面板：按**激活工作区**呈现终端。
 *
 * xterm 实例与承载 DOM 都在 `terminalRuntime`（模块级 Map，不在 React 树里）：本组件
 * 只负责把激活工作区的容器挂入视口、把离开的容器解绑，因此关闭面板、切会话、切视图
 * 都不结束任何工作区 shell（Domain 不变量 9）。
 * 终端归属与启动目录在启动时显式绑定到该工作区（Domain 不变量 4）。
 */
export const WorkspaceTerminalPanel = () => {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const setTerminalPanelOpen = useUiStore((state) => state.setTerminalPanelOpen)
  const terminalPanelHeight = useUiStore((state) => state.terminalPanelHeight)
  const setTerminalPanelHeight = useUiStore((state) => state.setTerminalPanelHeight)
  const fontSizePx = useUiStore((state) => state.fontSizePx)
  const monoFontFamily = useUiStore((state) => state.monoFontFamily)
  // 只在仍处于已授权集合内时呈现：撤销后存在一个短暂窗口 authorizedWorkspace 仍指向
  // 已撤销路径，此时必须渲染空态，而不是为未授权工作区发起启动（验收 6/7）。
  const activeWorkspacePath = useAgentStore((state) => {
    const path = state.authorizedWorkspace?.path ?? null
    return path && state.authorizedWorkspaces.some((workspace) => workspace.path === path) ? path : null
  })
  const activeStatus = useTerminalStore((state) =>
    activeWorkspacePath ? state.entries[activeWorkspacePath]?.status ?? null : null,
  )
  // 条目被替换（重启）时 terminalId 会变：呈现逻辑必须跟着重跑，否则新 xterm 永远不
  // open（旧实例的 container 已随 dispose 摸除），面板空白且因焦点监听未注册而不可输入。
  const activeTerminalId = useTerminalStore((state) =>
    activeWorkspacePath ? state.entries[activeWorkspacePath]?.terminalId ?? null : null,
  )
  // Linux 限制：终端 stdin 手势门依赖 macOS 原生 keyDown（NSEvent local
  // monitor），Linux 无等价物（Wayland 禁止全局输入观测），Rust 侧 spawn 已
  // fail-closed——面板只呈现说明，不 attach/不启动（详见 docs/linux-support.md）。
  const operatingSystem = useUiStore((state) => state.operatingSystem)
  // 非 macOS 平台（Linux/Windows）均无手势门等价实现：Rust 侧 spawn 已 fail-closed。
  const isUnsupportedPlatform = operatingSystem !== 'macos'
  const unsupportedHintKey = operatingSystem === 'windows'
    ? 'app.terminalPanel.windowsUnsupported'
    : 'app.terminalPanel.linuxUnsupported'

  // 呈现切换：挂入激活工作区的容器（不存在则启动），离开的工作区只解绑 DOM。
  useEffect(() => {
    if (isUnsupportedPlatform) return
    const container = containerRef.current
    if (!container || !activeWorkspacePath) return
    attachTerminal(activeWorkspacePath, container)
    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => fitTerminal(activeWorkspacePath), 80)
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (timer) window.clearTimeout(timer)
      // DOM 摘除不保证触发 textarea blur，必须显式上报失焦（否则未消费配额残留）。
      void setTerminalFocus(false)
      detachTerminal(activeWorkspacePath)
    }
  }, [activeWorkspacePath, activeTerminalId, isUnsupportedPlatform])

  // 字号/字体偏好热更新所有条目，并让可见终端重新 fit（尺寸变化经 onResize 同步 PTY）。
  useEffect(() => {
    if (isUnsupportedPlatform) return
    syncTerminalFont()
    if (activeWorkspacePath) fitTerminal(activeWorkspacePath)
  }, [fontSizePx, monoFontFamily, activeWorkspacePath, isUnsupportedPlatform])

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.currentTarget.setPointerCapture) return
    event.preventDefault()
    dragStateRef.current = { startY: event.clientY, startHeight: terminalPanelHeight }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      dragStateRef.current = null
      return
    }
    document.documentElement.classList.add(RESIZING_CLASS)
  }

  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragStateRef.current
    if (!drag) return
    const next = drag.startHeight + (drag.startY - event.clientY)
    if (next !== useUiStore.getState().terminalPanelHeight) setTerminalPanelHeight(next)
  }

  const onResizePointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragStateRef.current) return
    dragStateRef.current = null
    document.documentElement.classList.remove(RESIZING_CLASS)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const delta = event.key === 'ArrowUp' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP
    setTerminalPanelHeight(useUiStore.getState().terminalPanelHeight + delta)
  }

  return (
    <section
      className="terminal-panel"
      aria-label={t('app.terminalPanel.aria')}
      style={{ height: terminalPanelHeight }}
    >
      <div
        className="terminal-panel__resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('app.terminalPanel.resizerAria')}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => setTerminalPanelHeight(DEFAULT_TERMINAL_PANEL_HEIGHT)}
      />
      <div className="terminal-panel__header">
        <span className="terminal-panel__title">{t('app.terminalPanel.title')}</span>
        {/* 图标成组贴右（设计稿 ok6TR：标题 + 撑满 Spacer + 图标组，组内间距 8px）。 */}
        <div className="terminal-panel__actions">
          {activeWorkspacePath && activeStatus === 'running' && (
            <button
              type="button"
              className="rail__toggle"
              aria-label={t('app.terminalPanel.stopAria')}
              onClick={() => disposeTerminal(activeWorkspacePath)}
            >
              <Power size={16} />
            </button>
          )}
          {activeWorkspacePath && activeStatus === 'exited' && (
            <button
              type="button"
              className="rail__toggle"
              aria-label={t('app.terminalPanel.restartAria')}
              onClick={() => restartTerminal(activeWorkspacePath)}
            >
              <RotateCcw size={16} />
            </button>
          )}
          <button
            type="button"
            className="rail__toggle"
            aria-label={t('app.terminalPanel.closeAria')}
            onClick={() => setTerminalPanelOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      {isUnsupportedPlatform
        ? (
          <div className="terminal-panel__empty" role="status">
            <MonitorOff size={18} />
            <p>{t(unsupportedHintKey)}</p>
          </div>
        )
        : activeWorkspacePath
          ? <div className="terminal-panel__viewport" ref={containerRef} />
          : <div className="terminal-panel__empty" role="status">{t('app.terminalPanel.emptyState')}</div>}
    </section>
  )
}
