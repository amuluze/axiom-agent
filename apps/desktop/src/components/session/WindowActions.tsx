import { useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  CircleQuestionMark,
  ClipboardList,
  MessageCircleQuestion,
  PanelRight,
  SquareTerminal,
} from 'lucide-react'
import { openExternalUrl } from '@/platform/webAccess'
import { useUiStore } from '@/stores/uiStore'
import { useT } from '@/i18n'

const DOCS_URL = 'https://axiom.amuluze.com/#/docs'

/**
 * 会话窗口操作图标：帮助、终端、运行时面板开关。
 * 常驻显示于视图右上角（SessionHeader / NewTaskView），运行时面板打开与否
 * 都不改变其位置——展开时按钮原地变为收起（aria-pressed 反映状态）。
 */
export const WindowActions = () => {
  const { t } = useT()
  const terminalPanelOpen = useUiStore((state) => state.terminalPanelOpen)
  const toggleTerminalPanel = useUiStore((state) => state.toggleTerminalPanel)
  const runtimeRailOpen = useUiStore((state) => state.runtimeRailOpen)
  const toggleRuntimeRail = useUiStore((state) => state.toggleRuntimeRail)
  const buttonClass = 'session__window-action'
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

  const openDocs = () => {
    setHelpMenuOpen(false)
    void openExternalUrl(DOCS_URL).catch(() => undefined)
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
              disabled
              title={t('app.windowActions.comingSoon')}
            >
              <ClipboardList size={14} />
              <span>{t('app.windowActions.requests')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="window-help__menu-item"
              disabled
              title={t('app.windowActions.comingSoon')}
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
        onClick={toggleTerminalPanel}
      >
        <SquareTerminal size={16} />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${runtimeRailOpen ? `${buttonClass}--active` : ''}`}
        aria-label={t('app.windowActions.toggleRuntime')}
        aria-pressed={runtimeRailOpen}
        onClick={toggleRuntimeRail}
      >
        <PanelRight size={16} />
      </button>
    </div>
  )
}
