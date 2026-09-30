/**
 * 页面渲染扫描的运行时状态（扫描验证的画布动态效果数据源）。
 *
 * 状态放画布层而不是面板内：扫描不只是面板里的一张报告——画布要逐页点亮
 * （当前页扫描光束 + 已完成页的状态描边），两者消费同一份运行状态。
 * 面板（DesignScanPanel）与画布叠加层都从这里取数。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PenDocument } from '@/agent/design/penParser'
import {
  extractScanPages,
  scanDesignPages,
  scanDesignPagesBatch,
  type DesignPageStatus,
  type DesignScanBatchRenderPage,
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
  /** 在途页集合（批量扫掠可多页并行，画布据此同时点亮多道扫描环）。 */
  activeIds: ReadonlySet<string>
  run: () => Promise<void>
}

/**
 * 批量渲染器（画布原位扫掠注入；缺省走 staging 单页渲染路径）。
 * DesignCanvas 提供它时扫描在画布内原位并行进行；否则（jsdom 测试 / 无原生
 * 截图能力）回落到既有 per-page 渲染回调路径。
 */
export type DesignScanBatchRender = DesignScanBatchRenderPage

export const useDesignScan = ({
  doc,
  requireSize,
  batchRender,
}: {
  doc: PenDocument
  requireSize: boolean
  /** 画布原位扫掠（原生截图可用时由 DesignCanvas 注入）；缺省 staging 路径。 */
  batchRender?: DesignScanBatchRender
}): DesignScanState => {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [report, setReport] = useState<DesignScanReport | null>(null)
  const [statuses, setStatuses] = useState<ReadonlyMap<string, DesignPageStatus>>(new Map())
  const [activeIds, setActiveIds] = useState<ReadonlySet<string>>(new Set())
  // 序号收口：文档换代 / 重开后迟到的扫描不写回状态。
  const runSeqRef = useRef(0)

  // 文档换代即在途扫描作废：内容已变，迟到的判定/报告只会误导（引擎仍会跑完，
  // 但所有写回都被 alive() 拦下；扫掠相机由画布层的内容换代 abort 让位）。
  // 这里同步收掉运行态，避免 running 卡在 true、面板停在半程进度。
  useEffect(() => {
    runSeqRef.current += 1
    setRunning(false)
    setProgress({ done: 0, total: 0 })
    setStatuses(new Map())
    setActiveIds(new Set())
  }, [doc])

  const run = useCallback(async () => {
    const seq = runSeqRef.current + 1
    runSeqRef.current = seq
    const { pages, documentIssues } = extractScanPages(doc)
    setRunning(true)
    setReport(null)
    setStatuses(new Map())
    setActiveIds(new Set())
    setProgress({ done: 0, total: pages.length })
    const alive = () => runSeqRef.current === seq
    const recordVerdict = (verdict: { id: string; status: DesignPageStatus }) => {
      setStatuses((previous) => new Map(previous).set(verdict.id, verdict.status))
    }
    // 在途页统一由引擎 onActive 显式回报（串行 = 单元素；批量/并发 = 集合），
    // 不从 onProgress 计数推导——并发完成乱序时下标推导必然错位。
    const handleActive = (ids: readonly string[] | null) => {
      if (!alive()) return
      setActiveIds(new Set(ids ?? []))
    }
    try {
      if (batchRender) {
        // 批量路径（画布原位扫掠）：引擎按页回报判定与在途集合，画布逐页点亮。
        const next = await scanDesignPagesBatch(pages, documentIssues, batchRender, {
          requireSize,
          onProgress: (update) => {
            if (!alive()) return
            setProgress({ done: update.done, total: update.total })
            recordVerdict(update.verdict)
          },
          onActive: handleActive,
        })
        if (alive()) setReport(next)
        return
      }
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
          if (!alive()) return
          setProgress({ done: update.done, total: update.total })
          recordVerdict(update.verdict)
        },
        onActive: handleActive,
      })
      if (alive()) setReport(next)
    } finally {
      if (alive()) {
        setRunning(false)
        setActiveIds(new Set())
      }
    }
  }, [doc, requireSize, batchRender])

  // 当前在途页：onActive 回报集合的第一个元素（串行路径恒为单元素）。
  const currentId = running && activeIds.size > 0 ? [...activeIds][0] ?? null : null

  return { running, progress, report, statuses, currentId, activeIds, run }
}
