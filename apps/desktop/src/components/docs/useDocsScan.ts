import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { scanWorkspaceDocs, type WorkspaceDocsIndex } from '@/stores/services/docsIndex'
import { AUTO_SCAN_DEBOUNCE_MS } from './docsViewUtils'

/**
 * 文档页扫描调度：四个自动触发源（前台 run 结束、后台会话 revision、focus /
 * visibilitychange、手动重扫）合并进同一条单飞通道——在途时的触发置 pending，
 * 当前轮结束后补扫（在途扫描可能读过旧磁盘，丢弃尾沿会让树停在旧值）。
 *
 * hook 不持有选中/编辑状态：扫描成功只回传路径集合，选中修正由调用方在
 * `onScanned` 里完成（拆分时刻意保留的边界）。
 */
export interface UseDocsScanOptions {
  workspacePath?: string
  running: boolean
  docsRevision: number
  docsRevisionWorkspacePath: string | null
  onScanned: (paths: string[]) => void
  /** 整体扫描失败时的展示文案（由调用方注入，hook 不依赖 i18n）。 */
  scanFailedMessage: string
}

export interface DocsScanController {
  index: WorkspaceDocsIndex | null
  scanning: boolean
  scanError: string | null
  scan: (showProgress?: boolean) => Promise<void>
  requestAutoScan: () => void
  /** 成功扫描的代数（AGENTS.md 条目无 revision，reader 用它触发一次重读）。 */
  scanGenerationRef: RefObject<number>
}

const collectPaths = (index: WorkspaceDocsIndex): string[] =>
  index.groups
    .flatMap((group) => [...group.entries, ...group.archivedEntries])
    .map((entry) => entry.path)

export const useDocsScan = (options: UseDocsScanOptions): DocsScanController => {
  const {
    workspacePath,
    running,
    docsRevision,
    docsRevisionWorkspacePath,
    onScanned,
    scanFailedMessage,
  } = options
  const [index, setIndex] = useState<WorkspaceDocsIndex | null>(null)
  // 挂载后必然立即扫描；初始为 true 避免先闪一帧空态。
  const [scanning, setScanning] = useState(true)
  const [scanError, setScanError] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  const pendingRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const previousRunningRef = useRef(running)
  const observedRevisionRef = useRef(docsRevision)
  const onScannedRef = useRef(onScanned)
  const failedMessageRef = useRef(scanFailedMessage)
  onScannedRef.current = onScanned
  failedMessageRef.current = scanFailedMessage

  const scan = useCallback(async (showProgress = true): Promise<void> => {
    // 手动重扫或已在执行的扫描优先：取消尚在等待的自动触发。
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (inFlightRef.current) {
      pendingRef.current = true
      if (showProgress) setScanning(true)
      return
    }
    inFlightRef.current = true
    if (showProgress) setScanning(true)
    try {
      do {
        pendingRef.current = false
        const next = await scanWorkspaceDocs(workspacePath)
        generationRef.current += 1
        setIndex(next)
        setScanError(null)
        onScannedRef.current(collectPaths(next))
      } while (pendingRef.current)
    } catch {
      // 整体扫描失败不等于「项目没有文档」：保留上一份索引与正文，只显示错误。
      setScanError(failedMessageRef.current)
    } finally {
      inFlightRef.current = false
      setScanning(false)
    }
  }, [workspacePath])

  const requestAutoScan = useCallback((): void => {
    // 隐藏窗口不扫描；恢复可见时 visibilitychange 会重新请求。
    if (document.visibilityState === 'hidden') return
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (document.visibilityState === 'hidden') return
      void scan(false)
    }, AUTO_SCAN_DEBOUNCE_MS)
  }, [scan])

  useEffect(() => {
    void scan()
  }, [scan])

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    const previous = previousRunningRef.current
    previousRunningRef.current = running
    if (previous && !running) requestAutoScan()
  }, [requestAutoScan, running])

  // 后台会话在自身 run 里写入 Spec/Plan 时不会切换前台 running：store 递增代数。
  useEffect(() => {
    if (observedRevisionRef.current === docsRevision) return
    observedRevisionRef.current = docsRevision
    // 其它工作区后台会话的变化不应触发当前文档树重扫。
    if (docsRevisionWorkspacePath !== null && docsRevisionWorkspacePath !== workspacePath) return
    requestAutoScan()
  }, [docsRevision, docsRevisionWorkspacePath, requestAutoScan, workspacePath])

  // 外部编辑器改动不产生应用事件：回到窗口/标签页时请求一次自动扫描。
  useEffect(() => {
    const refresh = (): void => {
      requestAutoScan()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [requestAutoScan])

  return { index, scanning, scanError, scan, requestAutoScan, scanGenerationRef: generationRef }
}
