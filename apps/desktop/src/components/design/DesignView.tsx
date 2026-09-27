/**
 * 设计视图（docs/design-canvas.md D5 / §11 无限画布重构）：设计稿的独立展示页
 * ——从侧栏进入时整页覆盖会话（AppView 'design' 路由），不再分屏内嵌会话面板。
 * 单稿渲染交给 DesignCanvas（无限画布 + 直接编辑写回），多稿并排交给
 * DesignCompareView（§7 v0.3 变体探索的对比半边）。
 *
 * 两种格式（docs/ax-format.md）：`.pen`（pen.dev 格式，导入源，可编辑）与
 * `.ax`（Axiom 自有格式，**只读评审面**，作者是 LLM）。两者一起扫描、一起列出；
 * 差别只在加载通道（`useDesignDocument` 对 `.ax` 走严格校验 + 不返回可写原文）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { listWorkspace } from '@/platform/workspace'
import CanvasErrorBoundary from './CanvasErrorBoundary'
import DesignCanvas from './DesignCanvas'
import DesignCompareView, { MAX_COMPARE_COLUMNS } from './DesignCompareView'
import { useAuthorActive, useDesignDocument } from './useDesignDocument'

const PEN_PATH_STORAGE_KEY = 'axiom.design.penPath.v1'
/** 对比模式至少要有两份稿才有意义（单稿时按钮禁用）。 */
const MIN_COMPARE_FILES = 2

/**
 * 清洗空态输入的骨架文件名：去掉用户可能连带的扩展名（`.pen`/`.ax` 都要剥——只剥 `.pen`
 * 会让「checkout.ax」拼出 `.pen/checkout.ax.ax`）、非安全字符折叠为连字符。
 */
const sanitizeSkeletonName = (raw: string): string =>
  raw.trim().replace(/\.(pen|ax)$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  || 'design'

const DesignView = () => {
  const { t } = useT()
  const [files, setFiles] = useState<string[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(PEN_PATH_STORAGE_KEY)
    } catch {
      return null
    }
  })
  const [scanning, setScanning] = useState(false)
  // 对比模式：同题多稿并排（变体评估）。列各持独立订阅，见 DesignCompareView。
  const [compareEnabled, setCompareEnabled] = useState(false)
  // 单稿加载与订阅；rawJson/markWritten/reload 供画布编辑写回（§11）。
  // authorActive：任一会话在运行（作者可能正在写稿）——编辑期坏稿暂缓呈现，
  // 画布保持上一版合法渲染，收笔才落校验错误（useDesignDocument 文件头注 4）。
  const authorActive = useAuthorActive()
  const { loaded, holding, heldError, markWritten, reload, deletePage } = useDesignDocument(selectedPath, {
    authorActive,
  })

  const scanPenFiles = useCallback(async (): Promise<string[]> => {
    setScanning(true)
    try {
      // 注意：listWorkspace 的第一个参数是**目录**，不是扩展名过滤器——设计稿约定放在
      // `.pen/` 目录下（空态文案也是 `.pen/axiom.ax`），所以列出该目录、按扩展名筛选
      // 两种格式。曾经误把 `.ax` 当过滤器再列一次目录（列的是不存在的 `.ax/` 目录，
      // 失败被吞）导致 `.ax` 永远扫不出来。
      const result = await listWorkspace('.pen', 200)
      const found = [...new Set(result.entries
        .filter((entry) => entry.kind === 'file' && (/\.pen$/i.test(entry.path) || /\.ax$/i.test(entry.path)))
        .map((entry) => entry.path))]
        .sort((left, right) => left.localeCompare(right))
      setFiles(found)
      return found
    } catch {
      // 列出失败归一为空态，由引导 UI 收口（无设计稿目录也是空态）。
      setFiles([])
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  // 初次进入：扫描文件；localStorage 记忆的文件已不存在时落到首个可用文件。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await scanPenFiles()
      if (cancelled) return
      setSelectedPath((current) => {
        if (current && found.includes(current)) return current
        return found[0] ?? null
      })
    })()
    return () => {
      cancelled = true
    }
  }, [scanPenFiles])

  useEffect(() => {
    if (!selectedPath) return
    try {
      window.localStorage.setItem(PEN_PATH_STORAGE_KEY, selectedPath)
    } catch {
      // localStorage 不可用时仅失去记忆能力，不影响渲染。
    }
  }, [selectedPath])

  // 稿数掉到两份以下时自动退出对比（没有可比对象，继续并排只会得到单列）。
  useEffect(() => {
    if (files.length < MIN_COMPARE_FILES) setCompareEnabled(false)
  }, [files.length])

  const syncedLabel = loaded ? new Date(loaded.syncedAt).toLocaleTimeString() : null
  const comparePaths = files.slice(0, MAX_COMPARE_COLUMNS)

  if (files.length === 0 && !scanning) {
    return <DesignEmptyState onRescan={() => void scanPenFiles()} />
  }

  return (
    <div className="design-view">
      <div className="design-view__canvas-pane">
        <div className="design-view__toolbar">
          <div className="design-view__files" role="tablist" aria-label={t('app.design.files.aria')}>
            {files.map((path) => {
              // 对比模式下所有列同时可见，tab 的「选中」语义让给对比列自身。
              const active = !compareEnabled && path === selectedPath
              return (
                <button
                  key={path}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`design-view__file${active ? ' is-active' : ''}`}
                  onClick={() => {
                    setSelectedPath(path)
                    setCompareEnabled(false)
                  }}
                >
                  {path}
                </button>
              )
            })}
          </div>
          <div className="design-view__sync">
            {scanning && <span>{t('app.design.sync.scanning')}</span>}
            {loaded?.loadError && (
              <span className="design-view__sync-error" title={loaded.loadError}>
                {t('app.design.sync.error')}
              </span>
            )}
            {syncedLabel && !loaded?.loadError && !compareEnabled && (
              <span className="design-view__sync-time">{t('app.design.sync.syncedAt', { time: syncedLabel })}</span>
            )}
            {/* 编辑期坏稿暂缓的中性提示（非报错样式）：原因入 title 供 hover 查看。 */}
            {holding && !compareEnabled && (
              <span
                className="design-view__sync-holding"
                title={heldError ?? undefined}
              >
                {t('app.design.sync.holding')}
              </span>
            )}
            <button type="button" onClick={() => void scanPenFiles()}>
              {t('app.design.sync.rescan')}
            </button>
          </div>
          <button
            type="button"
            className={`design-view__compare-toggle${compareEnabled ? ' is-active' : ''}`}
            aria-pressed={compareEnabled}
            disabled={files.length < MIN_COMPARE_FILES}
            onClick={() => setCompareEnabled((enabled) => !enabled)}
          >
            {t('app.design.compare.toggle')}
          </button>
        </div>
        {compareEnabled ? (
          <CanvasErrorBoundary
            key={`compare:${comparePaths.join('|')}`}
            title={t('app.design.canvas.renderError')}
            retryLabel={t('app.design.canvas.retry')}
          >
            <DesignCompareView paths={comparePaths} />
          </CanvasErrorBoundary>
        ) : loaded?.parseError ? (
          <div className="design-view__parse-error">{loaded.parseError}</div>
        ) : loaded?.document ? (
          // key 只随文件路径换代：内容（sha256）变化必须保持在原画布实例内
          // 采纳——重挂载会丢选中态、撤销栈与在途写回；坏内容自动重试由
          // boundary 的 resetKey（sha256）承担。
          <CanvasErrorBoundary
            key={loaded.path}
            resetKey={loaded.sha256}
            title={t('app.design.canvas.renderError')}
            retryLabel={t('app.design.canvas.retry')}
          >
            <DesignCanvas
              doc={loaded.document}
              rawJson={loaded.rawJson}
              sha256={loaded.sha256}
              onWritten={markWritten}
              onReload={reload}
              onDeletePage={deletePage}
            />
          </CanvasErrorBoundary>
        ) : (
          <div className="design-view__loading">{t('app.design.loading')}</div>
        )}
      </div>
    </div>
  )
}

export default DesignView

/**
 * 空态：无 .pen 文件时的引导卡片。「添加设计稿」走 Agent 路径建骨架——
 * 新建 .pen 没有 UI 通道（write_design_document 仅写已存在的授权文件，
 * §11），这里只负责新建会话并把骨架指令预填进 Composer，发送决定权留给用户。
 */
const DesignEmptyState = ({ onRescan }: { onRescan: () => void }) => {
  const { t } = useT()
  const [name, setName] = useState('design')
  const [creating, setCreating] = useState(false)

  const addSkeleton = useCallback(async () => {
    const file = sanitizeSkeletonName(name)
    setCreating(true)
    try {
      const created = await useAgentStore.getState().createNewSession()
      if (!created) return
      useUiStore
        .getState()
        .requestComposerInsertion(t('app.design.empty.skeletonPrompt', { file }))
    } finally {
      setCreating(false)
    }
  }, [name, t])

  return (
    <div className="design-view design-view--empty">
      <div className="design-view__empty-card">
        <h2>{t('app.design.empty.title')}</h2>
        <p>{t('app.design.empty.description')}</p>
        <form
          className="design-view__empty-add"
          onSubmit={(event) => {
            event.preventDefault()
            void addSkeleton()
          }}
        >
          <label className="design-view__empty-name">
            {t('app.design.empty.nameLabel')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="design"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button type="submit" className="design-view__rescan" disabled={creating}>
            {t('app.design.empty.add')}
          </button>
        </form>
        <pre className="design-view__empty-snippet">{t('app.design.empty.snippet')}</pre>
        <button type="button" className="design-view__rescan" onClick={onRescan}>
          {t('app.design.empty.rescan')}
        </button>
      </div>
    </div>
  )
}
