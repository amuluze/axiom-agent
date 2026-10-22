import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { readWorkspaceDocument, saveWorkspaceDocument } from '@/platform/workspaceDocument'
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
}

export const useDocEditor = (options: UseDocEditorOptions): DocsEditor => {
  const { workspacePath, requestAutoScan, apiRef, loadErrorMessage, saveErrorMessage } = options
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
        saving: false,
        error: null,
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
  }
}
