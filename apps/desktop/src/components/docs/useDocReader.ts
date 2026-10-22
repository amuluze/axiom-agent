import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { readWorkspaceText } from '@/platform/workspace'
import type { WorkspaceDocsIndex } from '@/stores/services/docsIndex'
import { DOC_READ_LINES, type DocContentState } from './docsViewUtils'

/**
 * 文档页阅读态：选中项、已打开标签、分页正文。
 *
 * 只负责「读」：选中切换的脏草稿确认（requestSelect）与编辑态归 useDocEditor，
 * 扫描调度归 useDocsScan（本 hook 只消费它的 scanGeneration 做 revision 比对）。
 * 序号守卫与 revision 去重是本 hook 的核心，迁移时不得简化。
 */
export interface UseDocsReaderOptions {
  workspacePath?: string
  /** 每个工作区记忆最后打开文档的 localStorage 键。 */
  storageKey: string
  index: WorkspaceDocsIndex | null
  /** 编辑态期间禁止后台重读覆盖阅读面。 */
  editing: boolean
  scanGenerationRef: RefObject<number>
  loadErrorMessage: string
}

export interface DocsReader {
  selectedPath: string | null
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  selectedPathRef: RefObject<string | null>
  openPaths: string[]
  setOpenPaths: Dispatch<SetStateAction<string[]>>
  content: DocContentState | null
  setContent: Dispatch<SetStateAction<DocContentState | null>>
  loadDoc: (path: string, fromOffset: number) => Promise<void>
  syncedAt: Date | null
  markSynced: () => void
}

const flattenEntries = (index: WorkspaceDocsIndex) =>
  index.groups.flatMap((group) => [...group.entries, ...group.archivedEntries])

export const useDocsReader = (options: UseDocsReaderOptions): DocsReader => {
  const { workspacePath, storageKey, index, editing, scanGenerationRef, loadErrorMessage } = options
  const [selectedPath, setSelectedPath] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(storageKey)
    } catch {
      return null
    }
  })
  const [openPaths, setOpenPaths] = useState<string[]>(() => (selectedPath ? [selectedPath] : []))
  const [content, setContent] = useState<DocContentState | null>(null)
  const [syncedAt, setSyncedAt] = useState<Date | null>(null)
  const selectedPathRef = useRef<string | null>(selectedPath)
  const contentScanGenerationRef = useRef(0)
  const autoReloadRevisionRef = useRef<string | null>(null)
  const loadSeqRef = useRef(0)
  selectedPathRef.current = selectedPath

  const loadDoc = useCallback(async (path: string, fromOffset: number): Promise<void> => {
    const seq = ++loadSeqRef.current
    setContent((current) => ({
      path,
      chunks: fromOffset === 0 ? [] : current?.path === path ? current.chunks : [],
      loadedLines: fromOffset === 0 ? 0 : current?.path === path ? current.loadedLines : 0,
      totalLines: fromOffset === 0 ? 0 : current?.path === path ? current.totalLines : 0,
      nextOffset: null,
      revision: '',
      loading: true,
      error: null,
    }))
    try {
      const read = await readWorkspaceText(path, fromOffset, DOC_READ_LINES, workspacePath)
      if (loadSeqRef.current !== seq) return
      setSyncedAt(new Date())
      contentScanGenerationRef.current = scanGenerationRef.current
      setContent((current) => {
        const base = fromOffset === 0 ? [] : current?.path === path ? current.chunks : []
        return {
          path,
          chunks: [...base, read.content],
          loadedLines: read.endLine,
          totalLines: read.totalLines,
          nextOffset: read.nextOffset ?? null,
          revision: read.sha256,
          loading: false,
          error: null,
        }
      })
    } catch {
      if (loadSeqRef.current !== seq) return
      setContent({
        path,
        chunks: [],
        loadedLines: 0,
        totalLines: 0,
        nextOffset: null,
        revision: '',
        loading: false,
        error: loadErrorMessage,
      })
    }
  }, [loadErrorMessage, scanGenerationRef, workspacePath])

  // 选中变化即整段重读；扫描后 selectedPath 未变时不重复触发。
  useEffect(() => {
    if (!selectedPath) {
      setContent(null)
      return
    }
    void loadDoc(selectedPath, 0)
  }, [loadDoc, selectedPath])

  // 重扫只更新树；正文自己发现 revision 变化（覆盖 Agent 写入与外部编辑）。
  useEffect(() => {
    if (!selectedPath || editing || !index) return
    if (content?.path !== selectedPath || !content.revision) return
    const entry = flattenEntries(index).find((item) => item.path === selectedPath)
    if (!entry) return
    const key = entry.revision
      ? `${selectedPath}\0${entry.revision}`
      : `${selectedPath}\0scan:${scanGenerationRef.current}`
    if (entry.revision && entry.revision === content.revision) return
    if (!entry.revision && contentScanGenerationRef.current === scanGenerationRef.current) return
    if (autoReloadRevisionRef.current === key) return
    autoReloadRevisionRef.current = key
    void loadDoc(selectedPath, 0)
  }, [
    content?.path,
    content?.revision,
    editing,
    index,
    loadDoc,
    scanGenerationRef,
    selectedPath,
  ])

  useEffect(() => {
    if (selectedPath && !openPaths.includes(selectedPath)) {
      setOpenPaths((current) => [...current, selectedPath])
    }
  }, [openPaths, selectedPath])

  useEffect(() => {
    if (!selectedPath) return
    try {
      window.localStorage.setItem(storageKey, selectedPath)
    } catch {
      // localStorage 不可用时仅失去记忆能力，不影响浏览。
    }
  }, [selectedPath, storageKey])

  const markSynced = useCallback((): void => {
    setSyncedAt(new Date())
  }, [])

  return {
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
  }
}
