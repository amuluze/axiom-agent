/**
 * 页面渲染扫描的运行时状态（扫描验证的画布动态效果数据源）。
 *
 * 状态放画布层而不是面板内：扫描不只是面板里的一张报告——画布要逐页点亮
 * （当前页扫描光束 + 已完成页的状态描边），两者消费同一份运行状态。
 * 面板（DesignScanPanel）与画布叠加层都从这里取数。
 */
import { useCallback, useRef, useState } from 'react'
import type { PenDocument } from '@/agent/design/penParser'
import {
  extractScanPages,
  scanDesignPages,
  type DesignPageStatus,
  type DesignScanPageInput,
  type DesignScanRenderPage,
  type DesignScanReport,
} from '@/agent/design/designScan'
import { canRenderDesignScanPage, renderDesignScanPage } from '@/agent/design/designRenderHost'

/** 面板与画布都不消费缩略图（画布即视觉面），按最小预算渲染，空白判定不受影响。 */
const SCAN_THUMBNAIL_BYTES = 16 * 1024

export interface DesignScanState {
  running: boolean
  progress: { done: number; total: number }
  report: DesignScanReport | null
  /** 已完成页的判定（扫描过程中逐页累积，画布据此实时点亮状态描边）。 */
  statuses: ReadonlyMap<string, DesignPageStatus>
  /** 当前正在扫描的页（串行执行的在途页），画布在其上显示扫描光束。 */
  currentId: string | null
  run: () => Promise<void>
}

export const useDesignScan = ({
  doc,
  requireSize,
}: {
  doc: PenDocument
  requireSize: boolean
}): DesignScanState => {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [report, setReport] = useState<DesignScanReport | null>(null)
  const [statuses, setStatuses] = useState<ReadonlyMap<string, DesignPageStatus>>(new Map())
  // 序号收口：文档换代 / 重开后迟到的扫描不写回状态。
  const runSeqRef = useRef(0)
  // 当前在途页 = 扫描序里下标为 done 的页（串行）；引擎 onProgress 只给计数，
  // 页序由这里持有的提取结果补全。
  const pagesRef = useRef<readonly DesignScanPageInput[]>([])

  const run = useCallback(async () => {
    const seq = runSeqRef.current + 1
    runSeqRef.current = seq
    const { pages, documentIssues } = extractScanPages(doc)
    pagesRef.current = pages
    setRunning(true)
    setReport(null)
    setStatuses(new Map())
    setProgress({ done: 0, total: pages.length })
    try {
      const renderPage: DesignScanRenderPage | undefined = canRenderDesignScanPage()
        ? async (page) => {
          const result = await renderDesignScanPage({
            doc,
            pageIdOrIndex: page.id,
            maxBytes: SCAN_THUMBNAIL_BYTES,
          })
          if (!result) return null
          if (!result.ok) return { ok: false, reason: result.reason }
          return {
            ok: true,
            width: result.width,
            height: result.height,
            samples: result.samples,
            distinctColors: result.distinctColors,
            topColorFraction: result.topColorFraction,
          }
        }
        : undefined
      const next = await scanDesignPages(pages, documentIssues, renderPage, {
        requireSize,
        onProgress: (update) => {
          if (runSeqRef.current !== seq) return
          setProgress({ done: update.done, total: update.total })
          setStatuses((previous) => new Map(previous).set(update.verdict.id, update.verdict.status))
        },
      })
      if (runSeqRef.current === seq) setReport(next)
    } finally {
      if (runSeqRef.current === seq) setRunning(false)
    }
  }, [doc, requireSize])

  // 在途页 = 扫描序里下标为 done 的页（onProgress 在每页完成后计数，
  // 第 k 页在途时 done === k）；扫完（done === total）或未运行时为 null。
  const currentId =
    running && progress.done < progress.total
      ? pagesRef.current[progress.done]?.id ?? null
      : null

  return { running, progress, report, statuses, currentId, run }
}
