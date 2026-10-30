import { pageUsesProjectComponents } from '@/agent/design/projectPreview'
import type { PenDocument } from '@/agent/design/penParser'
import type { DesignScanRenderOutcome } from '@/agent/design/designScan'
import type { PagePlacement } from './designPageGrouping'
import type { DesignScanBatchRender } from './useDesignScan'
import {
  domRectToViewportFrame,
  fitScaleFor,
  fullyInsideViewport,
  overlappingPageIds,
  panTargetFor,
  rasterOrderOf,
  runPool,
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
  /** 相机缩放：巨页原地取景时降到装得下的倍率（页仍留在画布原位）。 */
  setScale: (value: number) => void
  setSweeping: (value: boolean) => void
}

const SCREEN_CAPTURE_CONCURRENCY = 4
const SWEEP_SETTLE_MS = 260
const SWEEP_BEAM_MS = 900
const SWEEP_BEAM_CLEAR_MS = 80
/**
 * 取景留边（屏幕 px）：页要「完全落入视口」才算可原位采集，故缩放必须留出余量，
 * 否则按精确贴合算出的倍率下，页边缘恰好贴住视口边界（`fullyInsideViewport` 的
 * inset 判定），一次浮点误差就让该页永远判为不可见 → 死循环降级。
 */
const FRAME_INSET = 8

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
  setScale,
  setSweeping,
}: CanvasScanSweepOptions): DesignScanBatchRender => async (pages, onPageDone, onActive, options) => {
  const stagingOutcomeOf = async (pageId: string): Promise<DesignScanRenderOutcome> => {
    try {
      const result = await renderPenPageForScan({ doc, pageIdOrIndex: pageId, maxBytes: options?.thumbnailMaxBytes ?? 16 * 1024 })
      if (!result) return { ok: false, reason: '渲染器不可用' }
      if (!result.ok) return { ok: false, reason: result.reason }
      return {
        ok: true,
        width: result.width,
        height: result.height,
        samples: result.samples,
        distinctColors: result.distinctColors,
        topColorFraction: result.topColorFraction,
        ...(options?.thumbnailMaxBytes !== undefined && result.base64 ? { base64: result.base64 } : {}),
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

  /**
   * 走「全屏 staging 遮罩」采集的页集合——**只剩项目组件页**。
   *
   * 遮罩路径（`renderPageHost.tsx` 的 capture 模式）会挂一个
   * `position:fixed;inset:0;z-index:2147483000` 的全窗口不透明容器——用户看到的
   * 「检查设计稿时全屏浮现」就是它，逐页切换即逐页闪屏。
   *
   * 原本还有两类降级理由，本轮一并消掉：
   * - **巨页**（当前倍率下装不进视口）：改为**原地取景**——把相机临时缩到该页
   *   装得下的倍率，页仍留在画布原位，采集全程不引入任何遮罩。
   * - **相交页**（与邻页矩形重叠）：原位截取会拍到压在上面的邻页内容，像素统计
   *   失真。改为**隔离采集**——采集时临时隐藏压在目标页上的邻页，拍到的仍是目标
   *   页自己的像素，同样全程在画布内。
   *
   * 项目组件页仍留 staging：画布上的预览是 `ProjectDesignPreview` 渲染的位图，
   * 可能尚未刷新（占位态），必须走隔离浏览器实拍——但它不产生全屏遮罩
   * （隔离浏览器是独立实例，headless 默认）。
   */
  const fallbackIds = new Set<string>()
  for (const page of doc.axDocument?.pages ?? []) {
    if (pageUsesProjectComponents(page.tree, doc.projectComponents)) fallbackIds.add(page.id)
  }
  const sweepable = pages.filter((page) => placementOf.has(page.id) && !fallbackIds.has(page.id))
  const sweepableIds = new Set(sweepable.map((page) => page.id))
  const stagingPages = pages.filter((page) => !sweepableIds.has(page.id))
  /** 画布坐标下互相重叠的页：采集时需隔离（隐藏压在上面的邻页），否则拍到邻页像素。 */
  const overlapping = overlappingPageIds(
    placements.map((item) => ({
      id: item.page.id,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    })),
  )

  sweepActiveRef.current = true
  sweepAbortRef.current = false
  const restoreOffset = offsetRef.current
  const restoreScale = scaleRef.current
  // 扫掠最后写入的机位：finally 只在机位仍归扫掠所有时恢复；用户接管后不得回滚。
  let sweepOffset = restoreOffset
  let sweepScale = restoreScale
  const applyOffset = (value: Point): void => {
    sweepOffset = value
    offsetRef.current = value
    setOffset(value)
  }
  setSweeping(true)
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  /**
   * 采集一页：原位矩形截图（无遮罩）。
   *
   * 相交页隔离：把压在目标页上的邻页临时隐藏——目标页自己的像素（含自身底色）
   * 露出来，拍到的仍是它自己。隐藏在采集后立即还原。
   *
   * 相交页必须**串行**采集：并发时 A 的隔离会隐藏正在被采集的 B，两张都失真。
   * 故按「是否参与相交」分组：孤立页并发，相交页串行。
   */
  const captureInPlace = async (id: string): Promise<void> => {
    const wrapper = surfaceRef.current?.querySelector<HTMLElement>(`[data-page-wrapper="${id}"]`)
    const rect = wrapper?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      onPageDone(id, { ok: false, reason: '页面矩形不可用' })
      return
    }
    const hidden: Array<{ element: HTMLElement; visibility: string }> = []
    for (const otherId of overlapping.get(id) ?? []) {
      const other = surfaceRef.current?.querySelector<HTMLElement>(`[data-page-wrapper="${otherId}"]`)
      if (!other) continue
      hidden.push({ element: other, visibility: other.style.visibility })
      other.style.visibility = 'hidden'
    }
    try {
      const stats = await captureRectStats([rect.x, rect.y, rect.width, rect.height], {
        thumbnailMaxBytes: options?.thumbnailMaxBytes,
      })
      onPageDone(id, {
        ok: true,
        width: stats.width,
        height: stats.height,
        samples: stats.stats.samples,
        distinctColors: stats.stats.distinctColors,
        topColorFraction: stats.stats.topColorFraction,
        ...(stats.base64 ? { base64: stats.base64 } : {}),
      })
    } catch (error) {
      onPageDone(id, { ok: false, reason: `原位截图失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      for (const entry of hidden) entry.element.style.visibility = entry.visibility
    }
  }
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
    /**
     * 取景中的目标页：它在画布内需要更低的倍率才装得下视口。这类页**单独**采集
     * ——降倍率期间同视口的其它页也会变得「完全可见」，若一并采集，它们就以过低的
     * 分辨率入图（文字细节被抹平，像素统计会把「有内容但字太小」误判成近乎空白）。
     * 采完这一页立刻恢复用户倍率，其余页不受影响。
     */
    let framedTargetId: string | null = null
    const applyScale = async (value: number): Promise<void> => {
      if (value === sweepScale) return
      sweepScale = value
      setScale(value)
      scaleRef.current = value
      await sleep(SWEEP_SETTLE_MS)
    }
    while (pending.length > 0) {
      if (sweepAbortRef.current) break
      if (framedTargetId) {
        // 取景页：单独采。降倍率期间同视口的其它页也会变得「完全可见」——它们不该
        // 用这个倍率入图（文字细节被抹平，像素统计会把「有内容但字太小」误判成近乎
        // 空白），故本轮只采目标页，倍率恢复后再让它们按正常倍率入图。
        const id = framedTargetId
        framedTargetId = null
        const target = placementOf.get(id)
        // setScale/setOffset 是目标机位；DOM 可能尚未提交或矩形已陈旧。不能把「请求过
        // 取景」当作「页面已完整可见」，否则会把越界矩形交给原生截图。
        if (!target || !fullyInsideViewport(screenRectOf(target), viewport)) {
          onPageDone(id, { ok: false, reason: '页面取景后仍未完整落入视口，无法原位采集' })
          pending = pending.filter((pendingId) => pendingId !== id)
          if (!sweepAbortRef.current) await applyScale(restoreScale)
          continue
        }
        onActive([id])
        await sleep(SWEEP_BEAM_MS)
        if (sweepAbortRef.current) break
        onActive(null)
        await sleep(SWEEP_BEAM_CLEAR_MS)
        await captureInPlace(id)
        pending = pending.filter((pendingId) => pendingId !== id)
        if (!sweepAbortRef.current) await applyScale(restoreScale)
        continue
      }
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
        // 孤立页并发采集，相交页串行（并发会互相隐藏对方而双双失真）。
        const isolated = visible.filter((id) => !overlapping.has(id))
        const crossing = visible.filter((id) => overlapping.has(id))
        await runPool(isolated, SCREEN_CAPTURE_CONCURRENCY, captureInPlace)
        for (const id of crossing) await captureInPlace(id)
        const scannedIds = new Set(visible)
        pending = pending.filter((id) => !scannedIds.has(id))
        continue
      }
      const nextId = pending[0]
      const next = nextId !== undefined ? placementOf.get(nextId) : undefined
      if (!next) break
      // 原地取景：页在当前倍率下装不进视口时，把相机临时缩到装得下的倍率。
      // 页仍留在画布原位（只是相机变了），采集全程无遮罩。
      const fitScale = fitScaleFor(next, viewport, FRAME_INSET)
      if (fitScale < sweepScale) {
        await applyScale(fitScale)
        framedTargetId = nextId
      }
      // 缩放缓存期间用户可能已接管相机；不得再写入扫掠的平移目标。
      if (sweepAbortRef.current) break
      applyOffset(panTargetFor(
        { x: next.x, y: next.y, width: next.width, height: next.height },
        sweepScale,
        viewport,
      ))
      await sleep(SWEEP_SETTLE_MS)
    }
  } finally {
    const cameraOwnedBySweep = scaleRef.current === sweepScale
      && offsetRef.current.x === sweepOffset.x
      && offsetRef.current.y === sweepOffset.y
    setSweeping(false)
    onActive(null)
    // 文档换代等内部中断恢复扫描前机位；用户已经改写相机时保留用户现场。
    if (cameraOwnedBySweep) {
      applyOffset(restoreOffset)
      if (scaleRef.current !== restoreScale) {
        setScale(restoreScale)
        scaleRef.current = restoreScale
      }
    }
  }

  for (const page of stagingPages) {
    if (sweepAbortRef.current) break
    onActive([page.id])
    onPageDone(page.id, await stagingOutcomeOf(page.id))
  }
  onActive(null)
  sweepActiveRef.current = false
}
