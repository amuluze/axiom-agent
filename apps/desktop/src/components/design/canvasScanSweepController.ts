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
  const fallbackOutcomeOf = async (pageId: string): Promise<DesignScanRenderOutcome> => {
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
        ...(options?.thumbnailMaxBytes !== undefined && result.base64
          ? { base64: result.base64, imageWidth: result.width, imageHeight: result.height }
          : {}),
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
   * 不能原位采集的页集合：项目组件页必须走隔离浏览器实拍（画布位图可能尚未刷新）；
   * 若内部布局异常导致普通页缺少 placement，也由单页渲染器明确失败，不再提供
   * 全屏 capture 回退。
   *
   * 巨页通过原地取景缩到视口内，相交页通过临时隐藏邻页隔离采集，均不离开画布。
   */
  const fallbackIds = new Set<string>()
  for (const page of doc.axDocument?.pages ?? []) {
    if (pageUsesProjectComponents(page.tree, doc.projectComponents)) fallbackIds.add(page.id)
  }
  const sweepable = pages.filter((page) => placementOf.has(page.id) && !fallbackIds.has(page.id))
  const sweepableIds = new Set(sweepable.map((page) => page.id))
  const fallbackPages = pages.filter((page) => !sweepableIds.has(page.id))
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
  /** 相机缩放：巨页原地取景时降到装得下的倍率（页仍留在画布原位）。 */
  const applyScale = async (value: number): Promise<void> => {
    if (value === sweepScale) return
    sweepScale = value
    setScale(value)
    scaleRef.current = value
    await sleep(SWEEP_SETTLE_MS)
  }
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
        ...(stats.base64
          ? {
            base64: stats.base64,
            imageWidth: stats.thumbnailWidth ?? stats.width,
            imageHeight: stats.thumbnailHeight ?? stats.height,
          }
          : {}),
      })
    } catch (error) {
      onPageDone(id, { ok: false, reason: `原位截图失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      for (const entry of hidden) entry.element.style.visibility = entry.visibility
    }
  }
  /**
   * 相机收口：采完（或中断）后把相机还给用户——除非用户中途自己改写了相机，
   * 那时保留用户现场。
   */
  const restoreCamera = (): void => {
    const cameraOwnedBySweep = scaleRef.current === sweepScale
      && offsetRef.current.x === sweepOffset.x
      && offsetRef.current.y === sweepOffset.y
    setSweeping(false)
    onActive(null)
    if (cameraOwnedBySweep) {
      applyOffset(restoreOffset)
      if (scaleRef.current !== restoreScale) {
        setScale(restoreScale)
        scaleRef.current = restoreScale
      }
    }
  }
  /**
   * 单页渲染快路径（会话 render/compare、画布导出 PNG）。
   *
   * 与逐页扫描不同：这里只要一页，且要的是**该页的图**而不是扫描报告，因此
   * 不走扫描的逐页推进——只做两件事：把目标页取景到「完整可见、且不超过 1:1」
   * 的倍率，再原位截一张。但光束停驻保留：会话触发的截图与导出也是画布上的
   * 采集动作，与批量扫描共用同一「点亮 → 扫完一个周期 → 出 DOM → 截图」的
   * 光栅节拍（onActive 分接到画布光束），否则相机凭空滑动一下就截走了。
   *
   * 取景这一步不能省：截图分辨率取决于用户当前缩放，画布缩到 30% 时导出的
   * PNG 只有设计尺寸的三分之一，模型自查拿到的也是糊图。取景只改相机（页仍
   * 在画布原位），采完由 restoreCamera 段把机位还给用户。
   */
  if (options?.fitTarget && pages.length === 1) {
    const targetId = pages[0]?.id ?? ''
    const item = placementOf.get(targetId)
    try {
      if (!item) {
        onPageDone(targetId, { ok: false, reason: '页面矩形不可用（该页未在画布中渲染）' })
        return
      }
      if (fallbackIds.has(targetId)) {
        // 项目组件页在画布上只是可能未刷新的预览位图，不能就地采集——交单页渲染器
        // 转交隔离浏览器实拍（不产生全屏容器）。
        onPageDone(targetId, await fallbackOutcomeOf(targetId))
        return
      }
      const fitScale = Math.min(1, fitScaleFor(item, viewport, FRAME_INSET))
      // 倍率与平移一次性写入，随后只等一次落定：表面变换带 220ms 缓动
      // （.is-sweeping），一次 260ms 足够 DOM 真值收敛。
      if (fitScale !== sweepScale) {
        sweepScale = fitScale
        setScale(fitScale)
        scaleRef.current = fitScale
      }
      applyOffset(panTargetFor(
        { x: item.x, y: item.y, width: item.width, height: item.height },
        fitScale,
        viewport,
      ))
      await sleep(SWEEP_SETTLE_MS)
      // DOM 真值复核：取景是「请求过的机位」，DOM 可能尚未提交或矩形已陈旧。
      // 复核不过就明确失败——否则会把越界矩形交给原生截图（拍到半页）。
      if (!fullyInsideViewport(screenRectOf(item), viewport)) {
        onPageDone(targetId, { ok: false, reason: '页面取景后仍未完整落入视口，无法原位采集' })
        return
      }
      if (sweepAbortRef.current) {
        onPageDone(targetId, { ok: false, reason: '截图已被用户的画布操作中断' })
        return
      }
      // 光束停驻节拍与批量路径一致：点亮 → 扫完一个周期 → 出 DOM → 截图。
      // 光带画在页矩形内，必须在截图前离开 DOM（80ms 缓冲），否则光带像素
      // 混进截图统计（空白检测漏报）。
      onActive([targetId])
      await sleep(SWEEP_BEAM_MS)
      if (sweepAbortRef.current) {
        onPageDone(targetId, { ok: false, reason: '截图已被用户的画布操作中断' })
        return
      }
      onActive(null)
      await sleep(SWEEP_BEAM_CLEAR_MS)
      await captureInPlace(targetId)
    } finally {
      restoreCamera()
      sweepActiveRef.current = false
    }
    return
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
    // 文档换代等内部中断恢复扫描前机位；用户已经改写相机时保留用户现场。
    restoreCamera()
  }

  for (const page of fallbackPages) {
    if (sweepAbortRef.current) break
    onActive([page.id])
    onPageDone(page.id, await fallbackOutcomeOf(page.id))
  }
  onActive(null)
  sweepActiveRef.current = false
}
