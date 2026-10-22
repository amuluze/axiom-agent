import { pageUsesProjectComponents } from '@/agent/design/projectPreview'
import type { PenDocument } from '@/agent/design/penParser'
import type { DesignScanRenderOutcome } from '@/agent/design/designScan'
import type { PagePlacement } from './designPageGrouping'
import type { DesignScanBatchRender } from './useDesignScan'
import {
  domRectToViewportFrame,
  fullyInsideViewport,
  panTargetFor,
  rasterOrderOf,
  runPool,
  stagingPageIds,
} from './canvasScanSweep'
import { captureRectStats } from './nativePageCapture'
import { renderPenPageForScan } from './ax/renderPageHost'

interface Point {
  x: number
  y: number
}

interface CanvasScanSweepOptions {
  doc: PenDocument
  placements: PagePlacement[]
  viewportSize: { width: number; height: number }
  viewportRef: { current: HTMLDivElement | null }
  surfaceRef: { current: HTMLDivElement | null }
  offsetRef: { current: Point }
  scaleRef: { current: number }
  sweepActiveRef: { current: boolean }
  sweepAbortRef: { current: boolean }
  setOffset: (value: Point) => void
  setSweeping: (value: boolean) => void
}

const SCREEN_CAPTURE_CONCURRENCY = 4
const SWEEP_SETTLE_MS = 260
const SWEEP_BEAM_MS = 900
const SWEEP_BEAM_CLEAR_MS = 80

export const createCanvasScanSweep = ({
  doc,
  placements,
  viewportSize,
  viewportRef,
  surfaceRef,
  offsetRef,
  scaleRef,
  sweepActiveRef,
  sweepAbortRef,
  setOffset,
  setSweeping,
}: CanvasScanSweepOptions): DesignScanBatchRender => async (pages, onPageDone, onActive) => {
  const stagingOutcomeOf = async (pageId: string): Promise<DesignScanRenderOutcome> => {
    try {
      const result = await renderPenPageForScan({ doc, pageIdOrIndex: pageId, maxBytes: 16 * 1024 })
      if (!result) return { ok: false, reason: '渲染器不可用' }
      if (!result.ok) return { ok: false, reason: result.reason }
      return {
        ok: true,
        width: result.width,
        height: result.height,
        samples: result.samples,
        distinctColors: result.distinctColors,
        topColorFraction: result.topColorFraction,
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  const viewportWindowRect = viewportRef.current?.getBoundingClientRect()
  const viewportOrigin = {
    left: viewportWindowRect?.left ?? 0,
    top: viewportWindowRect?.top ?? 0,
  }
  const viewport = viewportWindowRect && viewportWindowRect.width > 0 && viewportWindowRect.height > 0
    ? { width: viewportWindowRect.width, height: viewportWindowRect.height }
    : { width: viewportSize.width, height: viewportSize.height }
  const placementOf = new Map(placements.map((item) => [item.page.id, item]))
  const pageById = new Map(pages.map((page) => [page.id, page]))
  const screenRectOf = (item: PagePlacement) => {
    const rect = surfaceRef.current
      ?.querySelector<HTMLElement>(`[data-page-wrapper="${item.page.id}"]`)
      ?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      return domRectToViewportFrame(
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewportOrigin,
      )
    }
    return {
      x: item.x * scaleRef.current + offsetRef.current.x,
      y: item.y * scaleRef.current + offsetRef.current.y,
      width: item.width * scaleRef.current,
      height: item.height * scaleRef.current,
    }
  }

  const fallbackIds = stagingPageIds(
    placements.map((item) => ({
      id: item.page.id,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    })),
    scaleRef.current,
    viewport,
  )
  for (const page of doc.axDocument?.pages ?? []) {
    if (pageUsesProjectComponents(page.tree, doc.projectComponents)) fallbackIds.add(page.id)
  }
  const sweepable = pages.filter((page) => placementOf.has(page.id) && !fallbackIds.has(page.id))
  const sweepableIds = new Set(sweepable.map((page) => page.id))
  const stagingPages = pages.filter((page) => !sweepableIds.has(page.id))

  sweepActiveRef.current = true
  sweepAbortRef.current = false
  const restoreOffset = offsetRef.current
  setSweeping(true)
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    let pending = rasterOrderOf(
      sweepable.flatMap((page) => {
        const item = placementOf.get(page.id)
        return item
          ? [{ id: page.id, screen: { x: item.x, y: item.y, width: item.width, height: item.height } }]
          : []
      }),
      viewport,
    )
    let stalledFor: string | null = null
    while (pending.length > 0) {
      if (sweepAbortRef.current) break
      const visible = pending.filter((id) => {
        const item = placementOf.get(id)
        return item !== undefined && fullyInsideViewport(screenRectOf(item), viewport)
      })
      if (visible.length > 0) {
        onActive(visible)
        await sleep(SWEEP_BEAM_MS)
        if (sweepAbortRef.current) break
        onActive(null)
        await sleep(SWEEP_BEAM_CLEAR_MS)
        await runPool(visible, SCREEN_CAPTURE_CONCURRENCY, async (id) => {
          const rect = surfaceRef.current
            ?.querySelector<HTMLElement>(`[data-page-wrapper="${id}"]`)
            ?.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) {
            onPageDone(id, { ok: false, reason: '页面矩形不可用' })
            return
          }
          try {
            const stats = await captureRectStats([rect.x, rect.y, rect.width, rect.height])
            onPageDone(id, {
              ok: true,
              width: stats.width,
              height: stats.height,
              samples: stats.stats.samples,
              distinctColors: stats.stats.distinctColors,
              topColorFraction: stats.stats.topColorFraction,
            })
          } catch (error) {
            onPageDone(id, { ok: false, reason: `原位截图失败：${error instanceof Error ? error.message : String(error)}` })
          }
        })
        const scannedIds = new Set(visible)
        pending = pending.filter((id) => !scannedIds.has(id))
        stalledFor = null
        continue
      }
      const nextId = pending[0]
      const next = nextId !== undefined ? placementOf.get(nextId) : undefined
      if (!next) break
      if (stalledFor === nextId) {
        pending = pending.slice(1)
        const page = pageById.get(nextId)
        if (page) stagingPages.push(page)
        stalledFor = null
        continue
      }
      stalledFor = nextId
      setOffset(panTargetFor(
        { x: next.x, y: next.y, width: next.width, height: next.height },
        scaleRef.current,
        viewport,
      ))
      await sleep(SWEEP_SETTLE_MS)
    }
  } finally {
    setSweeping(false)
    onActive(null)
    setOffset(restoreOffset)
  }

  for (const page of stagingPages) {
    if (sweepAbortRef.current) break
    onActive([page.id])
    onPageDone(page.id, await stagingOutcomeOf(page.id))
  }
  onActive(null)
  sweepActiveRef.current = false
}
