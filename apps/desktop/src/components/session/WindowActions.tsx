import { useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  CircleQuestionMark,
  ClipboardList,
  MessageCircleQuestion,
  PanelRight,
  Server,
  SquareTerminal,
} from 'lucide-react'
import { openExternalUrl } from '@/platform/webAccess'
import { useUiStore } from '@/stores/uiStore'
import { useT } from '@/i18n'
import type { FeedbackKind } from '@/stores/uiStore'

import { useDesignUiPreview } from '@/components/design/ax/previewContext'

const DOCS_URL = 'https://axiom.amuluze.com/#/docs'

/**
 * 会话窗口操作图标：帮助、终端、运行时面板开关。
 * 常驻显示于视图右上角（SessionHeader / NewTaskView），运行时面板打开与否
 * 都不改变其位置——展开时按钮原地变为收起（aria-pressed 反映状态）。
 */
export const WindowActions = () => {
  const { t } = useT()
  const preview = useDesignUiPreview()
  const storeTerminalPanelOpen = useUiStore((state) => state.terminalPanelOpen)
  const terminalPanelOpen = preview ? preview.terminalPanelOpen : storeTerminalPanelOpen
  const storeToggleTerminalPanel = useUiStore((state) => state.toggleTerminalPanel)
  const toggleTerminalPanel = preview ? preview.toggleTerminalPanel : storeToggleTerminalPanel
  const storeRuntimeRailOpen = useUiStore((state) => state.runtimeRailOpen)
  const runtimeRailOpen = preview ? preview.runtimeRailOpen : storeRuntimeRailOpen
  const storeRuntimeRailPane = useUiStore((state) => state.runtimeRailPane)
  const runtimeRailPane = preview ? preview.runtimeRailPane : storeRuntimeRailPane
  const storeToggleRuntimeRail = useUiStore((state) => state.toggleRuntimeRail)
  const toggleRuntimeRail = preview ? preview.toggleRuntimeRail : storeToggleRuntimeRail
  const storeOpenRuntimeRailPane = useUiStore((state) => state.openRuntimeRailPane)
  const openRuntimeRailPane = preview ? preview.openRuntimeRailPane : storeOpenRuntimeRailPane
  const buttonClass = 'session__window-action'
  /** SSH 面板是否随 rail 打开且正显示 SSH pane：反映在 toggle 的 active 态。 */
  const sshPaneOpen = runtimeRailOpen && runtimeRailPane === 'ssh'
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  // 帮助菜单宿主容器 ref：用于「点击菜单外部收起」的边界判断。
  const helpPickerRef = useRef<HTMLDivElement | null>(null)

  // 点击菜单外部或按 Escape 收起帮助菜单：与 Composer 下拉菜单同一交互契约。
  useEffect(() => {
    if (!helpMenuOpen) return
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return
      if (!helpPickerRef.current?.contains(event.target)) {
        setHelpMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setHelpMenuOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [helpMenuOpen])

  /** SSH toggle：开 → 直达 ssh pane；已开 ssh pane → 收起 rail（与 rail toggle 同语义）。 */
  const toggleSshPane = (): void => {
    if (preview) return
    if (runtimeRailOpen && useUiStore.getState().runtimeRailPane === 'ssh') {
      toggleRuntimeRail?.()
      return
    }
    openRuntimeRailPane?.('ssh')
  }

  const openDocs = () => {
    setHelpMenuOpen(false)
    if (preview) return
    void openExternalUrl(DOCS_URL).catch(() => undefined)
  }

  // 需求/问题共用同一反馈弹窗，按入口预选类型（与设计稿帮助菜单语义一致）。
  const openFeedback = (kind: FeedbackKind) => {
    setHelpMenuOpen(false)
    if (preview) return
    useUiStore.getState().openFeedback(kind)
  }

  return (
    <div
      className="session__window-actions"
      role="toolbar"
      aria-label={t('app.windowActions.aria')}
    >
      <div className="window-help" ref={helpPickerRef}>
        <button
          type="button"
          className={buttonClass}
          aria-label={t('app.windowActions.help')}
          aria-haspopup="menu"
          aria-expanded={helpMenuOpen}
          title={t('app.windowActions.helpTitle')}
          onClick={() => setHelpMenuOpen((open) => !open)}
        >
          <CircleQuestionMark size={16} />
        </button>
        {helpMenuOpen && (
          <div className="window-help__menu" role="menu" aria-label={t('app.windowActions.helpMenuAria')}>
            <button type="button" role="menuitem" className="window-help__menu-item" onClick={openDocs}>
              <BookOpen size={14} />
              <span>{t('app.windowActions.docs')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="window-help__menu-item"
              onClick={() => openFeedback('feature')}
            >
              <ClipboardList size={14} />
              <span>{t('app.windowActions.requests')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="window-help__menu-item"
              onClick={() => openFeedback('bug')}
            >
              <MessageCircleQuestion size={14} />
              <span>{t('app.windowActions.issues')}</span>
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className={`${buttonClass} ${terminalPanelOpen ? `${buttonClass}--active` : ''}`}
        aria-label={t('app.windowActions.toggleTerminal')}
        aria-pressed={terminalPanelOpen}
        onClick={() => { if (!preview) toggleTerminalPanel?.() }}
      >
        <SquareTerminal size={16} />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${sshPaneOpen ? `${buttonClass}--active` : ''}`}
        aria-label={t('app.windowActions.toggleSsh')}
        aria-pressed={sshPaneOpen}
        onClick={toggleSshPane}
      >
        <Server size={16} />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${runtimeRailOpen ? `${buttonClass}--active` : ''}`}
        aria-label={t('app.windowActions.toggleRuntime')}
        aria-pressed={runtimeRailOpen}
        onClick={() => { if (!preview) toggleRuntimeRail?.() }}
      >
        <PanelRight size={16} />
      </button>
    </div>
  )
}
