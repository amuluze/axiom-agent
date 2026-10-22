/**
 * 文档视图（AppView 'docs'，从侧栏「文档」进入；侧栏此时切换为文档助手会话列）。
 * 形态按 .pen 设计稿 docs-view / docs-edit / docs-empty 三页对齐：
 * 顶部标签栏（已打开文档 + 同步状态 + 编辑/重新扫描 或 保存⌘S/放弃），
 * 主区为 Markdown 正文（或编辑态的源码编辑面），右侧 280px 文档目录树
 * （分组含项目指南 AGENTS.md 与子目录指南，见 docsIndex.ts）。
 *
 * 文档是用户/Agent 共写的可信说明：阅读与编辑都在本页，编辑保存走用户手势
 * CAS 通道（platform/workspaceDocument.ts，路径白名单在 Rust 权威执行）；
 * 结构性新建仍引导走会话（空态预填指令），与 DesignView 空态同一模式。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Archive, ChevronRight, FileText, RefreshCw } from 'lucide-react'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agentStore'
import { installViewChangeGuard, useUiStore } from '@/stores/uiStore'
import { MAX_NESTED_AGENTS_DEPTH } from '@/agent/prompt/projectAgents'
import { openExternalUrl } from '@/platform/webAccess'
import { confirmDialog } from '@/components/dialogService'
import {
  docsIndexHasContent,
  type DocsGroupRole,
  type DocsIndexEntry,
  type DocsIndexGroup,
  type WorkspaceDocsIndex,
} from '@/stores/services/docsIndex'
import {
  OVERSIZED_LINE_PLACEHOLDER,
  SELECTED_PATH_STORAGE_KEY,
  blockUnsupportedLink,
  headingId,
  isExternalHttpLink,
  resolveRelativeDocPath,
  scrollToFragment,
  splitLink,
  type DocContentState,
} from './docsViewUtils'
import { useDocsReader } from './useDocReader'
import { useDocEditor } from './useDocEditor'
import { useDocsScan } from './useDocsScan'


const GROUP_LABEL_KEY: Record<DocsGroupRole, string> = {
  'agents-root': 'app.docs.group.agentsRoot',
  design: 'app.docs.group.design',
  domain: 'app.docs.group.domain',
  task: 'app.docs.group.task',
  plan: 'app.docs.group.plan',
  doc: 'app.docs.group.doc',
  'agents-nested': 'app.docs.group.agentsNested',
}

/** 组头的路径标注（设计稿 dvd-ga-hp 等：分组名旁的 mono 弱化路径）。 */
const GROUP_PATH_KEY: Partial<Record<DocsGroupRole, string>> = {
  'agents-root': 'app.docs.groupPath.agentsRoot',
  design: 'app.docs.groupPath.design',
  domain: 'app.docs.groupPath.domain',
  task: 'app.docs.groupPath.task',
  plan: 'app.docs.groupPath.plan',
  doc: 'app.docs.groupPath.doc',
  'agents-nested': 'app.docs.groupPath.agentsNested',
}

const isAgentsRole = (role: DocsGroupRole): boolean => role === 'agents-root' || role === 'agents-nested'

const openExternalLink = (event: MouseEvent<HTMLAnchorElement>, href: string): void => {
  event.preventDefault()
  void openExternalUrl(href)
}

const WorkspaceDocsView = ({ workspacePath, workspaceName }: { workspacePath?: string; workspaceName?: string }) => {
  const { t } = useT()
  const running = useAgentStore((state) => state.running)
  const projectDocsRevision = useAgentStore((state) => state.projectDocsRevision)
  const projectDocsWorkspacePath = useAgentStore((state) => state.projectDocsWorkspacePath)
  const storageKey = `${SELECTED_PATH_STORAGE_KEY}:${workspacePath ?? 'none'}`
  /** 已打开文档的标签页集合（设计稿 dvd-tabs：mono 文件名，点击切换）。 */
  const [collapsedRoles, setCollapsedRoles] = useState<ReadonlySet<DocsGroupRole>>(new Set())
  /** 当前正文是在哪一代扫描之后读到的；避免选中 AGENTS.md 时首读后立刻重复读一遍。 */
  const pendingFragmentRef = useRef<string | null>(null)
  /** 已为哪一份索引 revision 触发过自动重读；防止“索引与读回哈希不一致”时无限重读。 */


  const flattenEntries = useCallback((current: WorkspaceDocsIndex): DocsIndexEntry[] =>
    current.groups.flatMap((group) => [...group.entries, ...group.archivedEntries]), [])
  const diagnosticText = (diagnostic: DocsIndexGroup['diagnostics'][number]): string => {
    switch (diagnostic.code) {
      case 'root_list_failed':
        return t('app.docs.listFailed')
      case 'root_list_truncated':
        return t('app.docs.listTruncated')
      case 'root_entry_limit':
        return t('app.docs.truncatedHint', { count: diagnostic.affectedCount })
      case 'nested_directories_omitted':
        return t('app.docs.nestedOmitted', { count: diagnostic.affectedCount })
      case 'nested_scan_truncated':
        return t('app.docs.nestedScanTruncated', { count: diagnostic.affectedCount })
      case 'file_read_failed':
        return t('app.docs.readFailed', { count: diagnostic.affectedCount })
    }
  }

  const handleScanned = useCallback((paths: string[]): void => {
    const currentEdit = editRef.current
    const preserveDraft = currentEdit !== null && currentEdit.draft !== currentEdit.baseline
    const currentSelected = selectedPathRef.current
    const nextSelected = currentSelected && paths.includes(currentSelected)
      ? currentSelected
      : preserveDraft
        ? currentEdit.path
        : paths[0] ?? null
    setOpenPaths((current) => current.filter((path) => (
      paths.includes(path) || (preserveDraft && path === currentEdit.path)
    )))
    selectedPathRef.current = nextSelected
    setSelectedPath(nextSelected)
    if (!preserveDraft) {
      setEdit((current) => current && !paths.includes(current.path) ? null : current)
    }
    // 只有选中路径真的变化时才取消在途 beginEdit：常规 run 结束重扫不改变选中项，
    // 无条件推进 seq 会丢弃迟到的读到结果，而 editLoading 再无人复位。
    if (nextSelected !== currentSelected) {
      editLoadSeqRef.current += 1
      setEditLoading(false)
    }
  }, [])

  const { index, scanning, scanError, scan, requestAutoScan, scanGenerationRef } = useDocsScan({
    workspacePath,
    running,
    docsRevision: projectDocsRevision,
    docsRevisionWorkspacePath: projectDocsWorkspacePath,
    onScanned: handleScanned,
    scanFailedMessage: t('app.docs.scanFailed'),
  })

  // editor 先于 reader 调用（reader 需要 editing），二者通过 apiRef 解环：
  // 保存后的同步标记与读失败时的正文错误由组件在 reader 就绪后填入。
  const readerApiRef = useRef<{
    setContent: Dispatch<SetStateAction<DocContentState | null>>
    markSynced: () => void
  } | null>(null)
  const {
    edit,
    setEdit,
    editLoading,
    setEditLoading,
    editRef,
    editLoadSeqRef,
    dirty,
    beginEdit,
    discardEdit,
    saveEdit,
  } = useDocEditor({
    workspacePath,
    requestAutoScan,
    apiRef: readerApiRef,
    loadErrorMessage: t('app.docs.loadError'),
    saveErrorMessage: t('app.docs.saveError'),
  })
  const editing = edit !== null
  const {
    selectedPath,
    setSelectedPath,
    selectedPathRef,
    openPaths,
    setOpenPaths,
    content,
    setContent,
    loadDoc,
    syncedAt,
    markSynced,
  } = useDocsReader({
    workspacePath,
    storageKey,
    index,
    editing,
    scanGenerationRef,
    loadErrorMessage: t('app.docs.loadError'),
  })
  readerApiRef.current = { setContent, markSynced }


  useEffect(() => installViewChangeGuard(async () => {
    const current = editRef.current
    if (!current || current.draft === current.baseline) return true
    return confirmDialog({ message: t('app.docs.discardConfirm'), danger: true })
  }), [t])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      const current = editRef.current
      if (!current || current.draft === current.baseline) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // 选中/打开集合的一致性：打开的标签必须包含当前选中（localStorage 恢复的旧选中
  // 可能已被扫描剪除——scan 内已过滤，这里兜底首次挂载路径）。


  // 序号守卫：切换文档/翻页期间的迟到读结果不回写（旧文档的分页响应
  // 迟于新文档的首读完成时，会把新文档内容整体顶掉）。




  /** 切换文档的统一入口：离开编辑态时脏草稿需确认，取消则保持原选中。 */
  const requestSelect = useCallback(async (path: string): Promise<boolean> => {
    if (edit?.path === path) return true
    if (edit && edit.path !== path && edit.draft !== edit.baseline) {
      if (!await confirmDialog({ message: t('app.docs.discardConfirm'), danger: true })) return false
    }
    editLoadSeqRef.current += 1
    setEditLoading(false)
    setEdit(null)
    selectedPathRef.current = path
    setSelectedPath(path)
    return true
  }, [edit, t])

  const toggleGroup = useCallback((role: DocsGroupRole): void => {
    setCollapsedRoles((current) => {
      const next = new Set(current)
      if (next.has(role)) next.delete(role)
      else next.add(role)
      return next
    })
  }, [])

  const selectPath = useCallback(async (path: string): Promise<boolean> => {
    if (!await requestSelect(path)) return false
    // 重复点击当前文档也重读：否则正文陈旧时没有任何“刷新”入口
    // （重扫只更新树，selectedPath 不变也不会触发 loadDoc）。
    if (path === selectedPath && !editing) void loadDoc(path, 0)
    return true
  }, [editing, loadDoc, requestSelect, selectedPath])

  const openFromTree = useCallback(async (path: string): Promise<void> => {
    if (!await selectPath(path)) return
    setOpenPaths((current) => current.includes(path) ? current : [...current, path])
  }, [selectPath])

  /**
   * 进入编辑：一次读取整份文档，失败则不进入。
   *
   * 不再走分页读取拼接：分页在“单行超过宿主 128 KiB 输出上限”时会返回占位提示
   * 而不是真实行，拼接后保存会把提示文本写回磁盘。整文件读取（≤1 MiB）同时
   * 消除了分页边界与换行重建的歧义。
   */



  const indexedPaths = useMemo(() => new Set(
    index ? flattenEntries(index).map((entry) => entry.path) : [],
  ), [flattenEntries, index])

  const openMarkdownLink = useCallback(async (
    event: MouseEvent<HTMLAnchorElement>,
    href: string | undefined,
  ): Promise<void> => {
    if (!href) {
      blockUnsupportedLink(event)
      return
    }
    if (isExternalHttpLink(href)) {
      openExternalLink(event, href)
      return
    }
    const { path: linkedPath, fragment } = splitLink(href)
    if (!linkedPath && fragment !== null) {
      event.preventDefault()
      scrollToFragment(fragment)
      return
    }
    if (!selectedPath) {
      blockUnsupportedLink(event)
      return
    }
    const resolved = resolveRelativeDocPath(selectedPath, linkedPath)
    if (!resolved || !indexedPaths.has(resolved)) {
      blockUnsupportedLink(event)
      return
    }
    event.preventDefault()
    if (await requestSelect(resolved)) {
      setOpenPaths((current) => current.includes(resolved) ? current : [...current, resolved])
      pendingFragmentRef.current = fragment
      if (resolved === selectedPath && fragment !== null) scrollToFragment(fragment)
    }
  }, [indexedPaths, requestSelect, selectedPath])

  const markdownComponents = useMemo<Components>(() => ({
    a({ node: _node, ref: _ref, ...props }) {
      const href = props.href
      if (href === undefined) return <span {...props} />
      const external = isExternalHttpLink(href)
      return (
        <a
          {...props}
          href={href}
          rel={external ? 'noreferrer noopener' : undefined}
          target={external ? '_blank' : undefined}
          onClick={(event) => { void openMarkdownLink(event, href) }}
        />
      )
    },
    h1({ children, node: _node, ref: _ref, ...props }) {
      return <h1 {...props} id={headingId(children)}>{children}</h1>
    },
    h2({ children, node: _node, ref: _ref, ...props }) {
      return <h2 {...props} id={headingId(children)}>{children}</h2>
    },
    h3({ children, node: _node, ref: _ref, ...props }) {
      return <h3 {...props} id={headingId(children)}>{children}</h3>
    },
    h4({ children, node: _node, ref: _ref, ...props }) {
      return <h4 {...props} id={headingId(children)}>{children}</h4>
    },
    table({ children, node: _node, ref: _ref, ...props }) {
      return <div className="docs-view__table-wrap"><table {...props}>{children}</table></div>
    },
  }), [openMarkdownLink])

  useEffect(() => {
    const fragment = pendingFragmentRef.current
    if (fragment === null || content?.loading || content?.path !== selectedPath) return
    pendingFragmentRef.current = null
    scrollToFragment(fragment)
  }, [content, selectedPath])

  const oversizedLineNotice = content !== null
    && !content.loading
    && content.chunks.some((chunk) => OVERSIZED_LINE_PLACEHOLDER.test(chunk))
  const syncedLabel = useMemo(
    () => syncedAt ? syncedAt.toLocaleTimeString() : null,
    [syncedAt],
  )

  if (!docsIndexHasContent(index ?? { groups: [] }) && !scanning && !edit) {
    return <DocsEmptyState onRescan={() => void scan()} error={scanError ?? undefined} />
  }

  return (
    <div className="docs-view">
      <div className="docs-view__main">
        <div className="docs-view__topbar">
          <div className="docs-view__tabs" role="tablist" aria-label={t('app.docs.tablistAria')}>
            {openPaths.map((path) => {
              const active = path === selectedPath
              return (
                <button
                  key={path}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`docs-view__tab${active ? ' is-active' : ''}`}
                  onClick={() => { void selectPath(path) }}
                >
                  {path}
                </button>
              )
            })}
          </div>
          <div className="docs-view__topbar-actions">
            {editing ? (
              <>
                {dirty && <span className="docs-view__unsaved">{t('app.docs.unsaved')}</span>}
                <button
                  type="button"
                  className="docs-view__save"
                  disabled={edit?.saving || !dirty}
                  onClick={() => void saveEdit()}
                >
                  {t('app.docs.save')}
                </button>
                <button type="button" className="docs-view__topbar-secondary" onClick={() => { discardEdit(); if (selectedPath) void loadDoc(selectedPath, 0) }}>
                  {t('app.docs.discard')}
                </button>
              </>
            ) : (
              <>
                {syncedLabel && <span className="docs-view__sync">{t('app.docs.syncedAt', { time: syncedLabel })}</span>}
                <button
                  type="button"
                  className="docs-view__topbar-primary"
                  disabled={!selectedPath || content?.loading === true || editLoading}
                  onClick={() => { if (selectedPath) void beginEdit(selectedPath) }}
                >
                  {editLoading ? t('app.docs.loadingDoc') : t('app.docs.edit')}
                </button>
                <button type="button" className="docs-view__topbar-secondary" onClick={() => void scan()}>
                  {t('app.docs.rescan')}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="docs-view__body">
          <div className="docs-view__content">
            {!selectedPath || !content ? (
              <div className="docs-view__placeholder">{content ? t('app.docs.loadingDoc') : t('app.docs.selectHint')}</div>
            ) : editing && edit ? (
              <>
                <div className="docs-view__doc-header docs-view__doc-header--edit">
                  <span className="docs-view__doc-path">{edit.path}</span>
                  <span className="docs-view__edit-mode">{t('app.docs.editing')}</span>
                  {edit.error && <span className="docs-view__doc-error">{edit.error}</span>}
                </div>
                <textarea
                  className="docs-view__editor"
                  value={edit.draft}
                  spellCheck={false}
                  aria-label={t('app.docs.editorAria')}
                  onChange={(event) => {
                    const draft = event.target.value
                    setEdit((current) => current?.path === edit.path
                      ? { ...current, draft, error: null }
                      : current)
                  }}
                />
              </>
            ) : (
              <>
                <div className="docs-view__doc-header">
                  <span className="docs-view__doc-path">{content.path}</span>
                  {content.loading && <span>{t('app.docs.loadingDoc')}</span>}
                  {!content.loading && !content.error && content.totalLines > 0 && (
                    <span className="docs-view__doc-lines">
                      {t('app.docs.linesLoaded', { loaded: content.loadedLines, total: content.totalLines })}
                    </span>
                  )}
                  {content.error && <span className="docs-view__doc-error">{content.error}</span>}
                </div>
                {content.error ? (
                  <div className="docs-view__doc-actions">
                    <button type="button" onClick={() => void loadDoc(content.path, 0)}>
                      {t('app.docs.retry')}
                    </button>
                  </div>
                ) : (
                  <>
                    {oversizedLineNotice && (
                      <div className="docs-view__doc-note" role="status">
                        <AlertTriangle size={12} />
                        <span>{t('app.docs.oversizedLine')}</span>
                      </div>
                    )}
                    <div className="docs-view__doc-body">
                      <Markdown components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml>
                        {content.chunks.join('\n')}
                      </Markdown>
                      {content.nextOffset !== null && !content.loading && (
                        <div className="docs-view__doc-actions">
                          <button type="button" onClick={() => void loadDoc(content.path, content.nextOffset ?? 0)}>
                            {t('app.docs.loadMore')}
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <div className="docs-view__divider" />
          <aside className="docs-view__tree">
            <div className="docs-view__tree-header">
              <span className="docs-view__tree-title">{t('app.docs.title')}</span>
              <span className="docs-view__tree-workspace" title={workspacePath}>{workspaceName}</span>
              <button
                type="button"
                className="docs-view__tree-refresh"
                aria-label={t('app.docs.rescan')}
                title={t('app.docs.rescan')}
                onClick={() => void scan()}
              >
                <RefreshCw size={14} className={scanning ? 'docs-view__spin' : undefined} />
              </button>
            </div>
            <div className="docs-view__tree-body">
              {scanError && index && (
                <div className="docs-view__group-note docs-view__group-note--error">
                  <AlertTriangle size={11} />
                  <span>{scanError}</span>
                </div>
              )}
              {scanning && !index && <div className="docs-view__tree-hint">{t('app.docs.scanning')}</div>}
              {(index?.groups ?? []).map((group) => (
                <section className="docs-view__group" key={group.role}>
                  <button
                    type="button"
                    className="docs-view__group-header"
                    onClick={() => toggleGroup(group.role)}
                  >
                    <ChevronRight
                      size={12}
                      className={`docs-view__chevron${collapsedRoles.has(group.role) ? '' : ' is-open'}`}
                    />
                    <span className="docs-view__group-label">{t(GROUP_LABEL_KEY[group.role])}</span>
                    {GROUP_PATH_KEY[group.role] && (
                      <span className="docs-view__group-path">{t(GROUP_PATH_KEY[group.role] as string)}</span>
                    )}
                    <span className="docs-view__group-count">{group.entries.length + group.archivedEntries.length}</span>
                  </button>
                  {!collapsedRoles.has(group.role) && (
                    <div className="docs-view__group-items">
                      {group.diagnostics.map((diagnostic) => {
                        const error = diagnostic.code === 'root_list_failed' || diagnostic.code === 'file_read_failed'
                        return (
                          <div
                            key={`${diagnostic.code}:${diagnostic.root}:${diagnostic.reason ?? ''}`}
                            className={`docs-view__group-note${error ? ' docs-view__group-note--error' : ''}`}
                          >
                            {error && <AlertTriangle size={11} />}
                            <span>
                              {diagnosticText(diagnostic)}
                              {/* 诊断必须可定位：嵌套目录的列举失败/截断以该目录作 root，
                                  只给通用文案时用户无法知道该去复查哪一个目录。 */}
                              <code className="docs-view__group-note-path" title={diagnostic.root}>
                                {diagnostic.root}
                              </code>
                            </span>
                          </div>
                        )
                      })}
                      {group.role === 'agents-nested' && (
                        <div className="docs-view__group-note">
                          <span>{t('app.docs.agentsDepthNote', { depth: MAX_NESTED_AGENTS_DEPTH })}</span>
                        </div>
                      )}
                      {group.truncated && (
                        <div className="docs-view__group-note">
                          <AlertTriangle size={11} />
                          <span>{t('app.docs.agentsTruncated')}</span>
                        </div>
                      )}
                      {group.scanFailed && (
                        <div className="docs-view__group-note docs-view__group-note--error">
                          <AlertTriangle size={11} />
                          <span>{t('app.docs.agentsScanFailed')}</span>
                        </div>
                      )}
                      {[...group.entries, ...group.archivedEntries].map((entry) => {
                        const active = entry.path === selectedPath
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            title={entry.path}
                            aria-current={active ? 'true' : undefined}
                            className={`docs-view__item${active ? ' is-active' : ''}${entry.archived ? ' is-archived' : ''}`}
                            onClick={() => { void openFromTree(entry.path) }}
                          >
                            {entry.archived
                              ? <Archive size={12} className="docs-view__item-icon" />
                              : <FileText size={12} className="docs-view__item-icon" />}
                            <span className="docs-view__item-label">{isAgentsRole(entry.role) ? entry.path : entry.title}</span>
                            {entry.archived && <span className="docs-view__item-badge">{t('app.docs.archivedLabel')}</span>}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

export const DocsView = () => {
  const workspace = useAgentStore((state) => state.authorizedWorkspace)
  if (!workspace) return <DocsNoWorkspaceState />
  return <WorkspaceDocsView key={workspace.path} workspacePath={workspace.path} workspaceName={workspace.name} />
}

export default DocsView

/** 空态：工作区没有任何可浏览文档时的引导（docs-empty 设计稿：居中卡片 + 预填指令，
 *  结构性新建走会话——与 DesignView 空态同一模式，本页不直接建目录）。 */
const DocsEmptyState = ({ onRescan, error }: { onRescan: () => void; error?: string }) => {
  const { t } = useT()
  const [creating, setCreating] = useState(false)

  const initStructure = useCallback(async () => {
    setCreating(true)
    try {
      const created = await useAgentStore.getState().createNewSession()
      if (!created) return
      useUiStore.getState().requestComposerInsertion(t('app.docs.empty.initPrompt'))
    } finally {
      setCreating(false)
    }
  }, [t])

  return (
    <div className="docs-view docs-view--empty">
      <div className="docs-view__empty-card">
        <h2>{error ?? t('app.docs.empty.title')}</h2>
        {!error && (
          <>
            <p>{t('app.docs.empty.description')}</p>
            <div className="docs-view__empty-hint">
              <span className="docs-view__empty-hint-label">{t('app.docs.empty.hintLabel')}</span>
              <code className="docs-view__empty-hint-box">{t('app.docs.empty.hintPrompt')}</code>
            </div>
          </>
        )}
        <div className="docs-view__empty-actions">
          {!error && (
            <button type="button" className="docs-view__empty-primary" disabled={creating} onClick={() => void initStructure()}>
              {t('app.docs.empty.init')}
            </button>
          )}
          <button type="button" className="docs-view__empty-secondary" onClick={onRescan}>
            {t('app.docs.empty.rescan')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 无工作区态：引导授权工作区（与侧栏「添加工作区」同一动作）。 */
const DocsNoWorkspaceState = () => {
  const { t } = useT()
  const addWorkspace = useAgentStore((state) => state.addWorkspace)
  return (
    <div className="docs-view docs-view--empty">
      <div className="docs-view__empty-card">
        <h2>{t('app.docs.noWorkspace.title')}</h2>
        <p>{t('app.docs.noWorkspace.description')}</p>
        <button type="button" className="docs-view__empty-primary" onClick={() => { void addWorkspace() }}>
          {t('app.docs.noWorkspace.add')}
        </button>
      </div>
    </div>
  )
}
