/**
 * 设计变体对比视图（docs/design-canvas.md §7 v0.3 变体探索的对比半边）。
 *
 * 同一工作区里的多份 .pen（同题多稿）并排渲染：共享缩放与页序，每列保留各自
 * 的 token 注入与诊断——变体评估靠并排目视，因此不再叠加交互（点选仍在单稿
 * 画布 DesignCanvas 里做）。前端的编排侧（起 N 个会话各写一稿）走既有 Agent
 * 会话与写工具，这里只负责「已有 N 稿时怎么看」。
 */
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PenDocument, PenNodeUnion } from '@/agent/design/penParser'
import PenNodeView from './PenNodeView'
import CanvasErrorBoundary from './CanvasErrorBoundary'
import { useCanvasThemeMode } from './useCanvasThemeMode'
import { useAuthorActive, useDesignDocument } from './useDesignDocument'
import { useT } from '@/i18n'

const MIN_SCALE = 0.25
const MAX_SCALE = 3
const ZOOM_STEP = 0.2

/** 对比列上限：更多列在常见窗口宽度下每列都不可读，超出按工作区文件顺序截断。 */
export const MAX_COMPARE_COLUMNS = 4

const pageLabel = (page: PenNodeUnion, index: number): string =>
  ('name' in page && typeof page.name === 'string' ? page.name : page.id) || String(index + 1)

const CompareColumn = ({
  path,
  pageIndex,
  scale,
  selected,
  onSelect,
}: {
  path: string
  pageIndex: number
  scale: number
  selected: boolean
  onSelect: () => void
}) => {
  const { t } = useT()
  const themeMode = useCanvasThemeMode()
  // 每列自持订阅（useDesignDocument 一实例一文件）：变体被 Agent 改写时该列自更新。
  // 编辑期坏稿暂缓与单稿画布同口径——变体生成是多轮写，中间态报错不该闪进对比列。
  const authorActive = useAuthorActive()
  const { loaded: entry } = useDesignDocument(path, { authorActive })
  const doc = entry?.document ?? null
  // 容器级 token 注入：每列用自己文档的 token 字面值（变体可能改过 token）。
  const variableStyle = useMemo(() => {
    if (!doc) return {} as CSSProperties
    const style: Record<string, string> = {}
    for (const [name, value] of Object.entries(doc.modeVariables[themeMode])) {
      style[`--${name}`] = value
    }
    return style as CSSProperties
  }, [doc, themeMode])
  const safeIndex = doc ? Math.min(pageIndex, Math.max(doc.pages.length - 1, 0)) : 0
  const page = doc?.pages[safeIndex]

  return (
    <section
      className={`design-compare__column${selected ? ' is-selected' : ''}`}
      aria-label={path}
    >
      <header className="design-compare__column-head">
        <button
          type="button"
          className="design-compare__column-title"
          onClick={onSelect}
          title={t('app.design.compare.selectHint')}
        >
          {path}
        </button>
        {doc && doc.diagnostics.length > 0 && (
          <span className="design-compare__badge">{doc.diagnostics.length}</span>
        )}
        {entry?.loadError && (
          <span className="design-compare__load-error" title={entry.loadError}>
            {t('app.design.sync.error')}
          </span>
        )}
      </header>
      <div className="design-compare__viewport">
        {entry?.parseError ? (
          <div className="design-view__parse-error">{entry.parseError}</div>
        ) : page ? (
          <CanvasErrorBoundary
            key={`${path}:${entry?.sha256 ?? ''}`}
            title={t('app.design.canvas.renderError')}
            retryLabel={t('app.design.canvas.retry')}
          >
            <div
              className="design-compare__surface"
              data-theme-mode={themeMode}
              style={{ ...variableStyle, transform: `scale(${scale})` }}
            >
              <PenNodeView node={page} document={doc as PenDocument} themeMode={themeMode} />
            </div>
          </CanvasErrorBoundary>
        ) : (
          <div className="design-canvas__empty">{t('app.design.canvas.empty')}</div>
        )}
      </div>
    </section>
  )
}

const DesignCompareView = ({ paths }: { paths: readonly string[] }) => {
  const { t } = useT()
  // 页序与缩放共享：变体对比要在同一页、同一缩放上比，否则失去可比性。
  const [pageIndex, setPageIndex] = useState(0)
  const [scale, setScale] = useState(1)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)

  const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
  const columns = [...new Set(paths)].slice(0, MAX_COMPARE_COLUMNS)
  // 页列表取首列文档（同题多稿页结构通常一致；不一致时各列按同一序号取页）。
  const authorActive = useAuthorActive()
  const reference = useDesignDocument(columns[0] ?? null, { authorActive })
  const pageOptions = reference.loaded?.document?.pages ?? []

  return (
    <div className="design-compare">
      <div className="design-compare__toolbar">
        <span className="design-compare__count">
          {t('app.design.compare.count', { count: String(columns.length) })}
        </span>
        {pageOptions.length > 1 && (
          <span className="design-compare__pages" role="tablist" aria-label={t('app.design.pages.aria')}>
            {pageOptions.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={index === pageIndex}
                className={`design-compare__page${index === pageIndex ? ' is-active' : ''}`}
                onClick={() => setPageIndex(index)}
              >
                {pageLabel(item, index)}
              </button>
            ))}
          </span>
        )}
        {focusedPath && (
          <span className="design-compare__focus">{t('app.design.compare.focus', { path: focusedPath })}</span>
        )}
        <span className="design-compare__zoom">
          <button
            type="button"
            aria-label={t('app.design.zoom.out')}
            onClick={() => setScale((value) => clampScale(value - ZOOM_STEP))}
          >
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button
            type="button"
            aria-label={t('app.design.zoom.in')}
            onClick={() => setScale((value) => clampScale(value + ZOOM_STEP))}
          >
            +
          </button>
          <button type="button" onClick={() => setScale(1)}>
            {t('app.design.zoom.reset')}
          </button>
        </span>
      </div>
      <div className="design-compare__columns" data-count={columns.length}>
        {columns.map((path) => (
          <CompareColumn
            key={path}
            path={path}
            pageIndex={pageIndex}
            scale={scale}
            selected={focusedPath === path}
            onSelect={() => setFocusedPath(path)}
          />
        ))}
      </div>
    </div>
  )
}

export default DesignCompareView
