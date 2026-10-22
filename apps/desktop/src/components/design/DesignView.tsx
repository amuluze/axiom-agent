/**
 * 设计视图（docs/design-canvas.md D5 / §11 无限画布重构）：设计稿的独立展示页
 * ——从侧栏进入时整页覆盖会话（AppView 'design' 路由），不再分屏内嵌会话面板。
 * 单稿渲染交给 DesignCanvas（无限画布评审面）。
 *
 * `.ax` 是唯一设计稿格式；`.pen` 仅经 design_import 一次性迁移。
 * 设计画布以严格校验后的 `.ax` 投影为评审面。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { findWorkspaceFiles } from '@/platform/workspace'
import { createId } from '@/agent/core/id'
import CanvasErrorBoundary from './CanvasErrorBoundary'
import DesignCanvas from './DesignCanvas'
import { useAuthorActive, useDesignDocument } from './useDesignDocument'
import DesignHistoryPanel from './DesignHistoryPanel'

const PEN_PATH_STORAGE_KEY = 'axiom.design.document.v2'
export const DESIGN_INDEX_POLL_MS = 10_000

/**
 * 清洗空态输入的骨架文件名：去掉用户可能连带的扩展名（`.pen`/`.ax` 都要剥——只剥 `.pen`
 * 会让「checkout.ax」拼出 `.pen/checkout.ax.ax`）、非安全字符折叠为连字符。
 */
const sanitizeSkeletonName = (raw: string): string =>
  raw.trim().replace(/\.(pen|ax)$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  || 'design'

const WorkspaceDesignView = ({ workspacePath }: { workspacePath?: string }) => {
  const { t } = useT()
  const storageKey = `${PEN_PATH_STORAGE_KEY}:${workspacePath ?? 'none'}`
  const [files, setFiles] = useState<string[]>([])
  const filesRef = useRef<string[]>([])
  filesRef.current = files
  const [selectedPath, setSelectedPath] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(storageKey)
    } catch {
      return null
    }
  })
  const [scanning, setScanning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const scanInFlightRef = useRef(false)
  // 单稿加载与订阅（§11）。
  // authorActive：当前稿被运行会话的写工具命中——编辑期坏稿暂缓呈现，
  // 画布保持上一版合法渲染，收笔才落校验错误（useDesignDocument 文件头注 4）。
  const authorActive = useAuthorActive(workspacePath, selectedPath)
  const { loaded, holding, heldError, deletePage, reload } = useDesignDocument(selectedPath, {
    authorActive,
    workspacePath,
  })

  const scanPenFiles = useCallback(async (showProgress = true): Promise<string[]> => {
    if (scanInFlightRef.current) return filesRef.current
    scanInFlightRef.current = true
    if (showProgress) setScanning(true)
    try {
      const result = await findWorkspaceFiles({
        requestId: createId('design-index'),
        pattern: '*.ax',
        path: '.pen',
        limit: 1_000,
        signal: new AbortController().signal,
        workspacePath,
      })
      const found = [...new Set(result.matches
        .filter((entry) => entry.kind === 'file' && /\.ax$/i.test(entry.path))
        .map((entry) => entry.path))]
        .sort((left, right) => left.localeCompare(right))
      setFiles(found)
      setSelectedPath((current) => current && found.includes(current) ? current : found[0] ?? null)
      return found
    } catch {
      // 列出失败归一为空态，由引导 UI 收口（无设计稿目录也是空态）。
      setFiles([])
      setSelectedPath(null)
      return []
    } finally {
      scanInFlightRef.current = false
      if (showProgress) setScanning(false)
    }
  }, [workspacePath])

  // 初次进入：扫描文件；localStorage 记忆的文件已不存在时落到首个可用文件。
  useEffect(() => {
    void scanPenFiles()
    const timer = window.setInterval(() => void scanPenFiles(false), DESIGN_INDEX_POLL_MS)
    return () => window.clearInterval(timer)
  }, [scanPenFiles, storageKey])

  useEffect(() => {
    if (!selectedPath) return
    try {
      window.localStorage.setItem(storageKey, selectedPath)
    } catch {
      // localStorage 不可用时仅失去记忆能力，不影响渲染。
    }
  }, [selectedPath, storageKey])

  const syncedLabel = loaded ? new Date(loaded.syncedAt).toLocaleTimeString() : null

  if (files.length === 0 && !scanning) {
    return <DesignEmptyState onRescan={() => void scanPenFiles()} />
  }

  return (
    <div className="design-view">
      <div className="design-view__canvas-pane">
        <div className="design-view__toolbar">
          <div className="design-view__files" role="tablist" aria-label={t('app.design.files.aria')}>
            {files.map((path) => (
              <button
                key={path}
                type="button"
                role="tab"
                aria-selected={path === selectedPath}
                className={`design-view__file${path === selectedPath ? ' is-active' : ''}`}
                onClick={() => setSelectedPath(path)}
              >
                {path}
              </button>
            ))}
          </div>
          <div className="design-view__sync">
            {scanning && <span>{t('app.design.sync.scanning')}</span>}
            {loaded?.loadError && (
              <span className="design-view__sync-error" title={loaded.loadError}>
                {t('app.design.sync.error')}
              </span>
            )}
            {syncedLabel && !loaded?.loadError && (
              <span className="design-view__sync-time">{t('app.design.sync.syncedAt', { time: syncedLabel })}</span>
            )}
            {/* 编辑期坏稿暂缓的中性提示（非报错样式）：原因入 title 供 hover 查看。 */}
            {holding && (
              <span
                className="design-view__sync-holding"
                title={heldError ?? undefined}
              >
                {t('app.design.sync.holding')}
              </span>
            )}
            <button
              type="button"
              disabled={!selectedPath || !loaded?.sha256}
              onClick={() => setHistoryOpen((current) => !current)}
            >
              {t('app.design.history.open')}
            </button>
            <button type="button" onClick={() => void scanPenFiles()}>
              {t('app.design.sync.rescan')}
            </button>
          </div>
        </div>
        {historyOpen && selectedPath && loaded?.sha256 && (
          <DesignHistoryPanel
            key={`${selectedPath}:${loaded.sha256}`}
            path={selectedPath}
            workspacePath={workspacePath}
            expectedSha256={loaded.sha256}
            onRestored={reload}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        {loaded?.parseError ? (
          <div className="design-view__parse-error">{loaded.parseError}</div>
        ) : loaded?.document ? (
          // key 只随文件路径换代：内容（sha256）变化必须保持在原画布实例内
          // 采纳——重挂载会丢选中态与页摆放叠加层；坏内容自动重试由
          // boundary 的 resetKey（sha256）承担。
          <CanvasErrorBoundary
            key={`${workspacePath}:${loaded.path}`}
            resetKey={loaded.sha256}
            title={t('app.design.canvas.renderError')}
            retryLabel={t('app.design.canvas.retry')}
          >
            <DesignCanvas
              doc={loaded.document}
              sha256={loaded.sha256}
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

const DesignView = () => {
  const workspacePath = useAgentStore((state) => state.authorizedWorkspace?.path)
  return <WorkspaceDesignView key={workspacePath ?? 'none'} workspacePath={workspacePath} />
}

export default DesignView

/**
 * 空态：无 .pen 文件时的引导卡片。「添加设计稿」走 Agent 路径建骨架——
 * 新建设计稿没有 UI 通道（页级语义命令仅写已存在的授权文件，
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
