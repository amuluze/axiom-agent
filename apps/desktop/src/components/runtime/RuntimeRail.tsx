import { useMemo, useRef } from 'react'
import { Globe, Grid2x2, Monitor, type LucideIcon } from 'lucide-react'
import {
  DEFAULT_RUNTIME_RAIL_WIDTH,
  MIN_RUNTIME_RAIL_WIDTH,
  runtimeRailMaxWidth,
  useUiStore,
  type RuntimeRailPane,
  type RuntimeRailTab,
} from '@/stores/uiStore'
import { useT, type TFunction } from '@/i18n'
import { BrowserPanel } from './BrowserPanel'
import { ComputerPanel } from './ComputerPanel'

/** 按当前语言解析标签页元数据（picker 与 pane 标题共用同一事实来源）。
 * 顺序对齐设计稿；SSH 自设计稿起迁出运行时面板（独立全窗口 SshView，
 * 入口在侧栏导航）。 */
const buildRailPanes = (t: TFunction): Array<{ id: RuntimeRailTab; label: string; description: string; Icon: LucideIcon }> => [
  { id: 'browser', label: t('app.runtimeRail.tab.browser.label'), description: t('app.runtimeRail.tab.browser.desc'), Icon: Globe },
  { id: 'computer', label: t('app.runtimeRail.tab.computer.label'), description: t('app.runtimeRail.tab.computer.desc'), Icon: Monitor },
]

/** 键盘调整步长（px）：resizer 聚焦后 ArrowLeft/ArrowRight 增减宽度。 */
const KEYBOARD_RESIZE_STEP = 16
/** 拖拽期间挂在 <html> 上的类名：全局 col-resize 光标 + 禁止文本选择。 */
const RESIZING_CLASS = 'runtime-rail--resizing'

/**
 * 右侧运行时面板：收起/展开图标常驻视图右上角（ShellLayout 之外的 WindowActions），
 * 面板本体只负责双态内容——展开即回「打开标签页」卡片选择页（picker），
 * 点卡片打开对应功能面板；面板顶部子条提供返回卡片页与当前 pane 标题。
 *
 * - 浏览器：内嵌浏览器（见 BrowserPanel）
 * - 电脑控制：权限/会话授权/allowlist（见 ComputerPanel）
 * - SSH 已迁出：独立全窗口 SshView，入口在侧栏导航「SSH」。
 *
 * 由 App ShellLayout 在 runtimeRailOpen 时挂载，宽度是
 * 显式布局偏好，clamp + 持久化集中在 uiStore.setRuntimeRailWidth。
 */
export const RuntimeRail = () => {
  const pane = useUiStore((state) => state.runtimeRailPane)
  const setPane = useUiStore((state) => state.setRuntimeRailPane)
  const width = useUiStore((state) => state.runtimeRailWidth)
  const setWidth = useUiStore((state) => state.setRuntimeRailWidth)
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const { t } = useT()
  const railPanes = useMemo(() => buildRailPanes(t), [t])

  // 把手拖拽经 pointer capture 保证指针移出把手仍持续收到 move/up；rail 靠右，
  // 向左拖增大宽度。clamp 集中在 uiStore 的 setRuntimeRailWidth。
  const onResizerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.currentTarget.setPointerCapture) return
    event.preventDefault()
    dragStateRef.current = { startX: event.clientX, startWidth: width }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      dragStateRef.current = null
      return
    }
    document.documentElement.classList.add(RESIZING_CLASS)
  }

  const onResizerPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragStateRef.current
    if (!drag) return
    const next = drag.startWidth + (drag.startX - event.clientX)
    if (next !== useUiStore.getState().runtimeRailWidth) setWidth(next)
  }

  const onResizerPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStateRef.current) return
    dragStateRef.current = null
    document.documentElement.classList.remove(RESIZING_CLASS)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onResizerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP
    setWidth(useUiStore.getState().runtimeRailWidth + delta)
  }

  const activePane = pane === 'picker' ? null : railPanes.find((item) => item.id === pane) ?? null

  return (
    <aside
      className="rail"
      aria-label={t('app.runtimeRail.aria')}
      // 宽度经 --rail-current-width 变量驱动（SessionView 在容器上也设了同一
      // 变量供 grid 轨道使用）；此处兜底独立挂载场景。
      style={{ '--rail-current-width': `${width}px` } as React.CSSProperties}
    >
      <div
        className="rail__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('app.runtimeRail.resizerAria')}
        aria-valuemin={MIN_RUNTIME_RAIL_WIDTH}
        aria-valuemax={runtimeRailMaxWidth()}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onResizerPointerDown}
        onPointerMove={onResizerPointerMove}
        onPointerUp={onResizerPointerEnd}
        onPointerCancel={onResizerPointerEnd}
        onKeyDown={onResizerKeyDown}
        onDoubleClick={() => setWidth(DEFAULT_RUNTIME_RAIL_WIDTH)}
      />
      {activePane === null ? (
        <RailPanePicker panes={railPanes} onSelect={setPane} t={t} />
      ) : (
        <>
          <div className="rail__pane-bar">
            <button
              type="button"
              className="rail__pane-back"
              aria-label={t('app.runtimeRail.backAria')}
              title={t('app.runtimeRail.backTitle')}
              onClick={() => setPane('picker')}
            >
              <Grid2x2 size={13} aria-hidden />
            </button>
            <span className="rail__pane-title">{activePane.label}</span>
          </div>
          {activePane.id === 'browser' ? (
            <BrowserPanel />
          ) : (
            <ComputerPanel />
          )}
        </>
      )}
    </aside>
  )
}

/**
 * 「打开标签页」选择页：空态卡片网格（图标 + 名称），对齐 IDE 侧边面板的
 * 选择形态。点击卡片打开对应功能；pane 已打开时由顶部「返回标签页」按钮回到本页。
 */
const RailPanePicker = ({
  panes,
  onSelect,
  t,
}: {
  panes: Array<{ id: RuntimeRailTab; label: string; description: string; Icon: LucideIcon }>
  onSelect: (pane: RuntimeRailPane) => void
  t: TFunction
}) => (
  <div className="rail__pane-picker">
    <h2 className="rail__pane-picker-title">{t('app.runtimeRail.pickerTitle')}</h2>
    <p className="rail__pane-picker-subtitle">{t('app.runtimeRail.pickerSubtitle')}</p>
    <div className="rail__pane-picker-grid" role="tablist" aria-label={t('app.runtimeRail.pickerTabsAria')}>
      {panes.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={false}
          id={`rail-tab-${id}`}
          aria-controls={`rail-tab-panel-${id}`}
          className="rail__pane-card"
          onClick={() => onSelect(id)}
        >
          <Icon size={22} strokeWidth={1.5} aria-hidden />
          <span className="rail__pane-card-label">{label}</span>
        </button>
      ))}
    </div>
  </div>
)
