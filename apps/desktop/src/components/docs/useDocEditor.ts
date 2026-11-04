import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import {
  listWorkspaceDocumentVersions,
  readWorkspaceDocument,
  restoreWorkspaceDocumentVersion,
  saveWorkspaceDocument,
  type WorkspaceDocumentVersion,
} from '@/platform/workspaceDocument'
import type { DocContentState, DocEditState } from './docsViewUtils'

/**
 * 文档页编辑态：整文件读、CAS 保存、⌘S 监听。
 *
 * 为解开「reader 需要 editing、editor 需要 reader 的 setContent/markSynced」的环，
 * editor 不直接持有 reader 的返回值：读取失败时的正文错误与保存后的同步标记经
 * `apiRef` 延迟调用（用户交互时该 ref 早已由组件填好）。`discardEdit` 只清草稿，
 * 重读由组件随后调用 `loadDoc` —— 这样 editor 完全不知道 reader 的存在。
 */
export interface UseDocEditorOptions {
  workspacePath?: string
  requestAutoScan: () => void
  apiRef: RefObject<{
    setContent: Dispatch<SetStateAction<DocContentState | null>>
    markSynced: () => void
  } | null>
  loadErrorMessage: string
  saveErrorMessage: string
  restoreErrorMessage: string
  restoreDirtyError: string
}

export interface DocsEditor {
  edit: DocEditState | null
  setEdit: Dispatch<SetStateAction<DocEditState | null>>
  editLoading: boolean
  setEditLoading: Dispatch<SetStateAction<boolean>>
  editRef: RefObject<DocEditState | null>
  editLoadSeqRef: RefObject<number>
  dirty: boolean
  beginEdit: (path: string) => Promise<void>
  discardEdit: () => void
  saveEdit: () => Promise<void>
  restoreVersion: (sha256: string) => Promise<void>
}

/**
 * 把刚留档的版本提到列表头部（去重）。历史条目只是旧内容的引用，
 * 时间戳在这里不重要——它下一次真读列表时会被真实时间替换。
 */
const rememberVersion = (
  versions: WorkspaceDocumentVersion[],
  sha256: string | null,
): WorkspaceDocumentVersion[] => {
  if (!sha256 || versions.some((version) => version.sha256 === sha256)) return versions
  return [{ sha256, sizeBytes: 0, modifiedMs: Date.now() }, ...versions]
}

export const useDocEditor = (options: UseDocEditorOptions): DocsEditor => {
  const {
    workspacePath,
    requestAutoScan,
    apiRef,
    loadErrorMessage,
    saveErrorMessage,
    restoreErrorMessage,
    restoreDirtyError,
  } = options
  const [edit, setEdit] = useState<DocEditState | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const editRef = useRef<DocEditState | null>(null)
  const editLoadSeqRef = useRef(0)
  editRef.current = edit
  const dirty = edit !== null && edit.draft !== edit.baseline

  const beginEdit = useCallback(async (path: string): Promise<void> => {
    if (!path || editLoading) return
    const seq = ++editLoadSeqRef.current
    setEditLoading(true)
    try {
      const document = await readWorkspaceDocument(path, workspacePath)
      if (editLoadSeqRef.current !== seq) return
      // 宿主读的是原始字节；textarea 会把 CRLF/CR 归一为 LF，baseline 用同一
      // 归一文本，CAS 仍使用宿主返回的原始全文 SHA。
      const text = document.content.replace(/\r\n?/g, '\n')
      setEdit({
        path,
        draft: text,
        baseline: text,
        baselineSha256: document.sha256,
        versions: [],
        versionsLoading: true,
        restoringSha256: null,
        saving: false,
        error: null,
      })
      // 历史列表与正文分开加载：历史读失败不应挡住编辑（正文已经拿到）。
      void listWorkspaceDocumentVersions(path, workspacePath)
        .then((versions) => {
          if (editLoadSeqRef.current !== seq) return
          setEdit((current) => current?.path === path
            ? { ...current, versions, versionsLoading: false }
            : current)
        })
        .catch(() => {
          if (editLoadSeqRef.current !== seq) return
          setEdit((current) => current?.path === path
            ? { ...current, versions: [], versionsLoading: false }
            : current)
        })
    } catch {
      if (editLoadSeqRef.current === seq) {
        apiRef.current?.setContent((current) => current?.path === path
          ? { ...current, error: loadErrorMessage, loading: false }
          : current)
      }
    } finally {
      if (editLoadSeqRef.current === seq) setEditLoading(false)
    }
  }, [apiRef, editLoading, loadErrorMessage, workspacePath])

  const discardEdit = useCallback((): void => {
    editLoadSeqRef.current += 1
    setEditLoading(false)
    setEdit(null)
  }, [])

  const saveEdit = useCallback(async (): Promise<void> => {
    if (!edit || edit.saving || edit.draft === edit.baseline) return
    const submitted = edit
    setEdit((current) => current?.path === submitted.path
      ? { ...current, saving: true, error: null }
      : current)
    try {
      const saved = await saveWorkspaceDocument(
        submitted.path,
        submitted.draft,
        submitted.baselineSha256,
        workspacePath,
      )
      setEdit((current) => current?.path === submitted.path
        ? {
            ...current,
            baseline: submitted.draft,
            baselineSha256: saved.sha256,
            // 保存刚留档的旧内容立刻出现在历史里：把 previousSha256 提到列表头部，
            // 避免为了「撤销保存」再多读一次列表。
            versions: rememberVersion(current.versions, saved.previousSha256),
            saving: false,
            error: null,
          }
        : current)
      apiRef.current?.markSynced()
      requestAutoScan()
      await useAgentStore.getState().refreshActiveProjectContext().catch(() => undefined)
    } catch (error) {
      setEdit((current) => current?.path === submitted.path
        ? {
            ...current,
            saving: false,
            error: typeof error === 'string' ? error : saveErrorMessage,
          }
        : current)
    }
  }, [apiRef, edit, requestAutoScan, saveErrorMessage, workspacePath])

  const restoreVersion = useCallback(async (sha256: string): Promise<void> => {
    if (!edit || edit.saving || edit.restoringSha256) return
    const submitted = edit
    // 有未保存草稿时先让用户自己决定：回滚会覆盖草稿，静默丢弃等于丢数据。
    if (submitted.draft !== submitted.baseline) {
      setEdit((current) => current?.path === submitted.path
        ? { ...current, error: restoreDirtyError }
        : current)
      return
    }
    setEdit((current) => current?.path === submitted.path
      ? { ...current, restoringSha256: sha256, error: null }
      : current)
    try {
      const restored = await restoreWorkspaceDocumentVersion(
        submitted.path,
        sha256,
        submitted.baselineSha256,
        workspacePath,
      )
      setEdit((current) => current?.path === submitted.path
        ? {
            ...current,
            baselineSha256: restored.sha256,
            restoringSha256: null,
            versions: rememberVersion(current.versions, restored.previousSha256),
            error: null,
          }
        : current)
      // 回滚后正文变了：重新读一次，让阅读态与草稿基线一致。
      apiRef.current?.markSynced()
      requestAutoScan()
      await useAgentStore.getState().refreshActiveProjectContext().catch(() => undefined)
      const document = await readWorkspaceDocument(submitted.path, workspacePath)
      const text = document.content.replace(/\r\n?/g, '\n')
      setEdit((current) => current?.path === submitted.path
        ? { ...current, draft: text, baseline: text, baselineSha256: document.sha256 }
        : current)
    } catch (error) {
      setEdit((current) => current?.path === submitted.path
        ? {
            ...current,
            restoringSha256: null,
            error: typeof error === 'string' ? error : restoreErrorMessage,
          }
        : current)
    }
  }, [apiRef, edit, requestAutoScan, restoreDirtyError, restoreErrorMessage, workspacePath])

  // ⌘S 属于编辑态而不是 textarea：焦点在目录树/顶部按钮时也应保存。
  const saveEditRef = useRef(saveEdit)
  saveEditRef.current = saveEdit
  const editing = edit !== null
  useEffect(() => {
    if (!editing) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveEditRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing])

  return {
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
    restoreVersion,
  }
}
