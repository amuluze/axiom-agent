import ProjectDesignPreview from './ProjectDesignPreview'
import { pageUsesProjectComponents } from '@/agent/design/projectPreview'
/**
 * 设计无限画布（.ax 的评审投影；现况见 docs/design-project-components.md 与
 * docs/ax-format.md，docs/design-canvas.md 为历史演进记录）。
 *
 * 全部页铺在同一张无限画布上：pan / 以光标为中心的缩放 / 适应画布、点选高亮、
 * 页分组摆放、扫描验证、引用到会话与实现提示词注入。`.ax` 是「评审面」：
 * 作者只有 LLM，画布不接入手势编辑——页拖动只写 localStorage 摆放叠加层，
 * 唯一写手势是两段式确认的整页删除（useDesignDocument.deletePage：读盘 CAS
 * 预检 + 摘除后整稿过 .ax 校验 + CAS 写回）。
 * 画布不接手工编辑层：`.ax` 没有可写回的节点补丁通道。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { findPenNode } from '@/agent/design/penParser'
import type { PenDocument } from '@/agent/design/penParser'
import PenNodeView from './PenNodeView'
import DesignScanPanel from './DesignScanPanel'
import { useDesignScan, type DesignScanBatchRender } from './useDesignScan'
import { nativeCaptureSupported } from './nativePageCapture'
import { createCanvasScanSweep } from './canvasScanSweepController'
import { buildDesignImplementationPrompt } from './designImplementationPrompt'
import { buildDesignReferencePrompt } from './designSelectionContext'
import { renderPenPageToPngBase64 } from './ax/renderPageHost'
import { useCanvasThemeMode } from './useCanvasThemeMode'
import { exportDesignPng } from '@/platform/designDocument'
import { useT } from '@/i18n'
import {
  boundsOf,
  buildPlacements,
  GROUP_BAND_HEIGHT,
  GROUP_BAND_SCREEN_CLEARANCE,
  pageNameOf as pageName,
  resolvePageGroups,
} from './designPageGrouping'
import type { ContentBounds, PagePlacement } from './designPageGrouping'
import {
  clampScale,
  computePageSnap,
  containsNode,
  loadPageLayout,
  MAX_SCALE,
  MIN_SCALE,
  PAGE_SNAP_THRESHOLD_SCREEN_PX,
  pageSizeLabel,
  savePageLayout,
  ZOOM_STEP,
} from './canvasGeometry'
import type { PageLayoutOffsets, PageSnapGuide } from './canvasGeometry'

/** 拖拽位移超过该值（屏幕像素）视为拖动而非点选。 */
const DRAG_CLICK_THRESHOLD_PX = 6
/** `.ax` 页级删除确认态的自动收起时长：足够完成「看清→再点」，短到不碍下一次点选。 */
const DELETE_ARM_TIMEOUT_MS = 3_000
/** 视口裁剪的外扩边距（视口尺寸比例）：快速平移时不露白。 */
const CULLING_MARGIN_RATIO = 0.5
/**
 * 首屏自动视野的可读下限：一次铺开全部页常见要缩到 10%（axiom.pen 65 页跨度
 * 上万像素），全部页挤成色块等于不可用。低于该值就改为「页 1 可读 + 其余自取」
 * ——显式的「适应画布」按钮不受此限（用户主动要求看全貌）。
 */
const FIT_READABLE_FLOOR = 0.25
/**
 * 低倍率整页点选阈值：低于该缩放时页内文字/图标在屏幕上只有几像素，
 * 点中的必然是「随手一按的某个小节点」——此倍率下点位归到所属页，
 * 让页面成为点击目标（选中页 + 检查器显示页属性）。
 */
const PAGE_PICK_SCALE = 0.35
/** 页标签条高度（屏幕空间，不随缩放变化）。 */
const LABEL_HEIGHT_PX = 20

type Interaction =
  | {
      kind: 'pan'
      pointerId: number
      startClientX: number
      startClientY: number
      baseX: number
      baseY: number
      downNodeId: string | null
    }
  | {
      kind: 'page'
      pointerId: number
      pageId: string
      /** 点按（无位移）时选中的节点：按住页内子节点拖动，点按仍选中该子节点。 */
      selectNodeId: string
      /** 预览变换的元素：页面 wrapper（定位容器），松手由提交的数据接管。 */
      element: HTMLElement
      startClientX: number
      startClientY: number
      baseX: number
      baseY: number
      /** 吸附修正后的位移（pointermove 逐帧更新；提交坐标以此为准）。 */
      snapDx?: number
      snapDy?: number
    }

/**
 * 页面摆放叠加层（`.ax` 评审面专用）。`.ax` 格式页没有坐标（硬规则「坐标不进
 * 设计稿」），画布自动排布；用户拖动是**评审呈现层**的调整，不是设计内容——
 * 按 D3「画布不做内容编辑」不写文件（绕过格式校验），落 localStorage 按文档
 * 路径归档。
 */
const DesignCanvas = ({
  doc,
  sha256,
  onDeletePage,
}: {
  doc: PenDocument
  sha256?: string
  /**
   * `.ax` 评审面的整页删除通道（useDesignDocument.deletePage）。提供后才解锁
   * 「选中页根 → 删除」。
   */
  onDeletePage?: (pageId: string) => Promise<{ ok: boolean; message: string | null }>
}) => {
  const { t } = useT()
  const themeMode = useCanvasThemeMode()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  // 扫描验证面板（逐页渲染检查）：开合由状态栏按钮控制。
  const [scanOpen, setScanOpen] = useState(false)
  // 显式反馈（导出/保存）：null 为无提示，完成与失败都不静默。
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  // `.ax` 评审面的页面摆放（localStorage 持久化）：agent 换代不影响——文件里
  // 没有页坐标，叠加层与文件内容没有冲突面。
  const [pageOffsets, setPageOffsets] = useState<PageLayoutOffsets>({})
  // `.ax` 评审面判定（页面拖动走摆放叠加层的格式口径）。
  const axReview = doc.fileName.toLowerCase().endsWith('.ax')
  // 页面拖动吸附的参考线（画布坐标）：拖动中实时更新，松手/取消清空。
  const [pageSnapGuides, setPageSnapGuides] = useState<{
    x: PageSnapGuide | null
    y: PageSnapGuide | null
  } | null>(null)

  const viewportRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectedElementRef = useRef<HTMLElement | null>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const dragDistanceRef = useRef(0)
  const autoFitDoneRef = useRef(false)
  // 扫掠（原位扫描）的命令面：offset/scale 镜像供异步编排读取；abort 由用户
  // pointerdown 置位（扫掠在步进间隙检查，让位给用户操作）。
  const offsetRef = useRef(offset)
  offsetRef.current = offset
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const sweepActiveRef = useRef(false)
  const sweepAbortRef = useRef(false)
  // 原生截图可用性（异步探测，一次缓存）：可用时画布扫描走原位扫掠，否则回落
  // staging 单页路径（jsdom 测试 / 浏览器 dev 均无原生截图）。
  const [nativeScanReady, setNativeScanReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void nativeCaptureSupported().then((ok) => {
      if (!cancelled) setNativeScanReady(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])
  // 扫掠编排器经 ref 注入（定义在 placements 之后；trampoline 稳定传给 hook）。
  const scanBatchRef = useRef<DesignScanBatchRender | null>(null)
  const [sweeping, setSweeping] = useState(false)

  const viewDoc = doc

  // 切换文档时重读摆放叠加层（按文档路径归档）。
  useEffect(() => {
    setPageOffsets(loadPageLayout(JSON.stringify([doc.workspacePath ?? null, doc.fileName])))
  }, [doc.fileName, doc.workspacePath])

  // 扫描运行状态上提到画布层：面板与画布叠加层（当前页扫描光束 / 已完成页
  // 状态描边）消费同一份数据，扫描时画布逐页点亮（pen.dev 的动态扫描效果）。
  const scanBatchTrampoline = useCallback<DesignScanBatchRender>(async (pages, onPageDone, onActive) => {
    const impl = scanBatchRef.current
    if (!impl) throw new Error('扫掠编排器未就绪')
    await impl(pages, onPageDone, onActive)
  }, [])
  const scan = useDesignScan({
    doc: viewDoc,
    requireSize: axReview,
    batchRender: nativeScanReady ? scanBatchTrampoline : undefined,
  })
  // 打开面板即扫一轮（与原面板挂载语义一致）；文档换代不自动重扫，由用户重跑。
  const runScanRef = useRef(scan.run)
  runScanRef.current = scan.run
  useEffect(() => {
    if (scanOpen) void runScanRef.current()
  }, [scanOpen])

  // 分组排布：有坐标页原样保留，无坐标页按内容智能分组排成多行（组头带描述分组）。
  // `.ax` 评审面的手动摆放（localStorage）仍以偏移叠加在此之上。
  const { placements, groupBands } = useMemo(() => {
    const layout = buildPlacements(viewDoc.pages, viewDoc)
    if (!axReview || Object.keys(pageOffsets).length === 0) return layout
    return {
      placements: layout.placements.map((item) => {
        const offset = pageOffsets[item.page.id]
        return offset ? { ...item, x: offset.x, y: offset.y } : item
      }),
      // 组头带锚在分组基准位上：手动拖动不拖走组头（它描述的是分组，不是某一页）。
      groupBands: layout.groupBands,
    }
  }, [viewDoc, axReview, pageOffsets])
  const pageIds = useMemo(() => new Set(placements.map((item) => item.page.id)), [placements])

  /**
   * 页面拖动的持久化出口。`.ax` 评审面写 localStorage 摆放叠加层（不写文件）。
   */
  const pageDragTarget: 'offsets' | null = axReview ? 'offsets' : null

  // 视口裁剪：只挂载与视口（含外扩边距）相交的页，75 页不全量渲染。
  const visiblePlacements = useMemo(() => {
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return placements
    const marginX = (viewportSize.width * CULLING_MARGIN_RATIO) / scale
    const marginY = (viewportSize.height * CULLING_MARGIN_RATIO) / scale
    const viewX = -offset.x / scale - marginX
    const viewY = -offset.y / scale - marginY
    const viewWidth = viewportSize.width / scale + marginX * 2
    const viewHeight = viewportSize.height / scale + marginY * 2
    return placements.filter(
      (item) =>
        item.x < viewX + viewWidth &&
        item.x + item.width > viewX &&
        item.y < viewY + viewHeight &&
        item.y + item.height > viewY,
    )
  }, [placements, viewportSize, offset, scale])
  const visibleKey = useMemo(
    () => visiblePlacements.map((item) => item.page.id).join('|'),
    [visiblePlacements],
  )

  // 组头带与页同规格做视口裁剪（band 悬在行上方第二个标签位，让开页标签）。
  const visibleGroups = useMemo(() => {
    if (groupBands.length === 0) return []
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return groupBands
    const marginX = (viewportSize.width * CULLING_MARGIN_RATIO) / scale
    const marginY = (viewportSize.height * CULLING_MARGIN_RATIO) / scale
    const viewX = -offset.x / scale - marginX
    const viewY = -offset.y / scale - marginY
    const viewWidth = viewportSize.width / scale + marginX * 2
    const viewHeight = viewportSize.height / scale + marginY * 2
    return groupBands.filter((band) => {
      // 带在屏幕空间悬于行上缘上方 GROUP_BAND_SCREEN_CLEARANCE 处，换算回画布坐标参与裁剪。
      const top = band.rowTop - GROUP_BAND_SCREEN_CLEARANCE / scale
      const height = GROUP_BAND_HEIGHT / scale
      return (
        band.left < viewX + viewWidth &&
        band.right > viewX &&
        top < viewY + viewHeight &&
        top + height > viewY
      )
    })
  }, [groupBands, viewportSize, offset, scale])

  const selectedNode = useMemo(
    () => (selectedId ? findPenNode(viewDoc, selectedId) ?? null : null),
    [viewDoc, selectedId],
  )
  // `.ax` 评审面的页级删除：仅当选中的是页根、有删除通道、且删后仍有页
  // （`.ax` 校验器拒绝空 pages 数组——与其写不进去，不如按钮直接说明）。
  const axPageSelected = Boolean(axReview && selectedNode && pageIds.has(selectedNode.id))
  const axPageDeletable = Boolean(axPageSelected && onDeletePage && viewDoc.pages.length > 1)
  // 页级删除两段式确认：`.ax` 无撤销栈，误点的代价是一页内容——第一次点击
  // 只武装（按钮变确认态，短暂超时自动收起），第二次才执行。
  const [deleteArmed, setDeleteArmed] = useState(false)
  const deleteArmTimerRef = useRef(0)
  const disarmDelete = useCallback(() => {
    window.clearTimeout(deleteArmTimerRef.current)
    setDeleteArmed(false)
  }, [])
  // 确认永远绑定「当前选中的那一页」：换选中/内容换代（sha）即收起确认态。
  const deleteArmScopeKey = `${selectedId ?? ''}:${sha256 ?? ''}`
  const deleteArmScopeRef = useRef(deleteArmScopeKey)
  useEffect(() => {
    if (deleteArmScopeRef.current === deleteArmScopeKey) return
    deleteArmScopeRef.current = deleteArmScopeKey
    disarmDelete()
    return () => window.clearTimeout(deleteArmTimerRef.current)
  }, [deleteArmScopeKey, disarmDelete])

  const runAxPageDelete = useCallback(
    async (pageId: string) => {
      if (!onDeletePage) return
      const result = await onDeletePage(pageId)
      if (!result.ok) {
        // message 为 null = 用户在原生确认框里取消了：什么都没发生，不报错误。
        if (result.message) {
          setNotice({ tone: 'error', text: t('app.design.canvas.deletePageFailed', { message: result.message }) })
        }
      } else if (result.message) {
        setNotice({ tone: 'error', text: result.message })
      }
    },
    [onDeletePage, t],
  )

  const deleteButtonTitle = axPageDeletable
    ? deleteArmed
      ? t('app.design.canvas.deleteArmed')
      : t('app.design.canvas.deletePageHint')
    : axPageSelected
      ? t('app.design.canvas.deleteLastPageDisabled')
        : axReview
          ? t('app.design.inspector.deleteReviewReadonly')
          : t('app.design.canvas.deleteDisabled')

  const onDeleteButtonClick = () => {
    if (!axPageDeletable || !selectedId) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      window.clearTimeout(deleteArmTimerRef.current)
      deleteArmTimerRef.current = window.setTimeout(() => setDeleteArmed(false), DELETE_ARM_TIMEOUT_MS)
      return
    }
    disarmDelete()
    void runAxPageDelete(selectedId)
  }

  // 选中高亮走 DOM class（避免把 selectedId 灌进整棵 memo 树）；
  // viewDoc/visibleKey 是高亮重挂的失效信号（内容换代/裁剪集合变化）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewDoc 与 visibleKey 是刻意的重触发器
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    selectedElementRef.current?.classList.remove('is-selected')
    selectedElementRef.current = null
    if (!selectedId) return
    for (const element of surface.querySelectorAll<HTMLElement>('[data-pen-id]')) {
      if (element.getAttribute('data-pen-id') === selectedId) {
        element.classList.add('is-selected')
        selectedElementRef.current = element
        break
      }
    }
  }, [selectedId, viewDoc, visibleKey])

  // 选中节点在编辑/换代后消失（被删/换文件）即取消选中。
  useEffect(() => {
    if (selectedId && !selectedNode) setSelectedId(null)
  }, [selectedId, selectedNode])

  // 视口尺寸观测：裁剪与 fit 依赖（jsdom / 无 ResizeObserver 环境全量渲染）。
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setViewportSize({ width: rect.width, height: rect.height })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  /**
   * 聚焦一段内容范围。minScale 是缩放下限：算出的适应倍率低于它时改用下限，
   * 并把内容**左上角**贴到视口内边距处（而非居中）——倍率被托住说明内容远大于
   * 视口，此时从页首开始读比看中间一截有用。显式「适应画布」不设下限（看全貌）。
   */
  const focusBounds = useCallback((bounds: ContentBounds | null, minScale = MIN_SCALE) => {
    const viewport = viewportRef.current
    if (!viewport || !bounds) return
    const rect = viewport.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const width = Math.max(bounds.maxX - bounds.minX, 1)
    const height = Math.max(bounds.maxY - bounds.minY, 1)
    const padding = 80
    const fitted = Math.min(
      (rect.width - padding * 2) / width,
      (rect.height - padding * 2) / height,
    )
    const nextScale = Math.min(MAX_SCALE, Math.max(minScale, fitted))
    setScale(nextScale)
    if (fitted < minScale) {
      setOffset({ x: padding - bounds.minX * nextScale, y: padding - bounds.minY * nextScale })
      return
    }
    setOffset({
      x: (rect.width - width * nextScale) / 2 - bounds.minX * nextScale,
      y: (rect.height - height * nextScale) / 2 - bounds.minY * nextScale,
    })
  }, [])

  const fitAll = useCallback(() => focusBounds(boundsOf(placements)), [placements, focusBounds])

  const focusPlacement = useCallback(
    (placement: PagePlacement) => {
      focusBounds(
        {
          minX: placement.x,
          minY: placement.y,
          maxX: placement.x + placement.width,
          maxY: placement.y + placement.height,
        },
        FIT_READABLE_FLOOR,
      )
    },
    [focusBounds],
  )

  // 用户按下即中断扫掠：扫掠在步进间隙检查并让位（还原视口、剩余页记未完成）。
  // 只读 ref，useCallback 空依赖保持引用稳定，消费方（面板聚焦/换代 effect）可入依赖。
  const abortSweepIfActive = useCallback(() => {
    if (sweepActiveRef.current) sweepAbortRef.current = true
  }, [])

  // 扫描面板点击问题页：选中并聚焦该页（与页标签双击同一行为）。聚焦与扫掠相机
  // 会抢 offset——用户显式聚焦优先，扫掠让位中断。
  const focusPageFromScan = useCallback(
    (pageId: string) => {
      abortSweepIfActive()
      const placement = placements.find((item) => item.page.id === pageId)
      setSelectedId(pageId)
      if (placement) focusPlacement(placement)
    },
    [placements, focusPlacement, abortSweepIfActive],
  )

  // 初次拿到内容自动给视野：优先看全貌，但全部页一次铺开常需 10% 级倍率
  // （axiom.pen 65 页跨度上万像素）——那种倍率下页面只剩色块，因此低于可读
  // 下限时改为聚焦第一页（可读），全貌交给「适应画布」按钮。
  useEffect(() => {
    if (autoFitDoneRef.current || placements.length === 0 || viewportSize.width <= 0) return
    autoFitDoneRef.current = true
    const bounds = boundsOf(placements)
    if (!bounds) return
    const viewport = viewportRef.current
    const rect = viewport?.getBoundingClientRect()
    const padding = 80
    const fitted = rect && rect.width > 0 && rect.height > 0
      ? Math.min(
        (rect.width - padding * 2) / Math.max(bounds.maxX - bounds.minX, 1),
        (rect.height - padding * 2) / Math.max(bounds.maxY - bounds.minY, 1),
      )
      : MIN_SCALE
    if (fitted < FIT_READABLE_FLOOR) focusPlacement(placements[0])
    else focusBounds(bounds)
  }, [placements, viewportSize, focusBounds, focusPlacement])

  const requestComposerInsertion = useUiStore((state) => state.requestComposerInsertion)

  const referenceSelected = useCallback(() => {
    if (!selectedNode) return
    // 「引用到会话」只投递定位（稿路径 + 页/节点 id）：内容由模型在会话里用
    // design_query 按需读取，不让可能陈旧的选中子树占会话上下文。
    requestComposerInsertion(buildDesignReferencePrompt(viewDoc, selectedNode))
  }, [selectedNode, viewDoc, requestComposerInsertion])

  const implementSelected = useCallback(() => {
    if (!selectedNode) return
    requestComposerInsertion(
      buildDesignImplementationPrompt({
        doc: viewDoc,
        node: selectedNode,
        labels: {
          intro: t('app.design.prompt.intro'),
          structure: t('app.design.prompt.structure'),
          tokens: t('app.design.prompt.tokens'),
          truncated: t('app.design.prompt.truncated'),
        },
      }),
    )
  }, [selectedNode, viewDoc, requestComposerInsertion, t])

  /**
   * 页面移动提交。`.ax` 评审面：进 localStorage 摆放叠加层——评审呈现层的调整
   * 不写文件（绕过格式校验）。
   */
  const commitPageMove = useCallback(
    (pageId: string, baseX: number, baseY: number, dx: number, dy: number) => {
      const nextX = Math.round(baseX + dx)
      const nextY = Math.round(baseY + dy)
      setPageOffsets((current) => {
        const next = { ...current, [pageId]: { x: nextX, y: nextY } }
        savePageLayout(JSON.stringify([doc.workspacePath ?? null, doc.fileName]), next)
        return next
      })
    },
    [doc.fileName, doc.workspacePath],
  )

  /**
   * 清空手动摆放（`.ax` 评审面）：页面回到智能分组的基准排布。手动偏移叠加在
   * 分组布局之上，散拖几页后想要回整齐只有显式重置一条路（逐页拖回不现实）。
   */
  const resetPageOffsets = useCallback(() => {
    savePageLayout(JSON.stringify([doc.workspacePath ?? null, doc.fileName]), {})
    setPageOffsets({})
  }, [doc.workspacePath, doc.fileName])

  const runScanSweep = createCanvasScanSweep({
    doc: viewDoc,
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
  })
  scanBatchRef.current = runScanSweep

  // 内容换代（Agent 写盘 / 编辑重解析）即在途扫掠作废：旧 placements 闭包下的
  // 相机推进对新布局失准，续跑只会产出成片「扫描中断」误报——让位并还原视口；
  // 过期扫描的状态写回由 useDesignScan 的换代失效拦下。
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewDoc 是刻意的重触发器（换代即中断），effect 体内不直接消费
  useEffect(() => {
    abortSweepIfActive()
  }, [viewDoc, abortSweepIfActive])

  // 键盘：Esc 取消选中。输入控件聚焦时不劫持按键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    abortSweepIfActive()
    const target = event.target as HTMLElement | null
    // 中键拖拽：无论落点一律平移——放大后页面铺满视口、页内按下已被「拖页」
    // 占用时，中键是保底的平移出口（与 Figma 同款）。
    if (event.button === 1) {
      event.preventDefault()
      dragDistanceRef.current = 0
      interactionRef.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        baseX: offset.x,
        baseY: offset.y,
        downNodeId: null,
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // jsdom 无 setPointerCapture：测试直接派发 pointer 事件即可。
      }
      return
    }
    if (event.button !== 0) return
    dragDistanceRef.current = 0

    const captureViewport = () => {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // jsdom 无 setPointerCapture：测试直接派发 pointer 事件即可。
      }
    }

    // 页标签是任何缩放级别都可靠的「抓手」（低倍率下页内容只剩几个像素）。
    // 指针捕获必须打在**标签自身**：捕获会把后续 pointer 事件（含派生的
    // click/dblclick）重定向到捕获元素——第六轮的教训是打在 viewport 上会吞掉
    // 标签的选中与聚焦；打在标签上则标签语义原样保留，拖出视口也能收到 up。
    const label = target?.closest<HTMLElement>('[data-canvas-ui="page-label"]')
    if (label) {
      const pageId = label.getAttribute('data-page-id')
      const placement = pageId ? placements.find((item) => item.page.id === pageId) : undefined
      const wrapper =
        pageId && placement
          ? surfaceRef.current?.querySelector<HTMLElement>(`[data-page-wrapper="${pageId}"]`)
          : null
      if (pageId && placement && wrapper && pageDragTarget !== null) {
        interactionRef.current = {
          kind: 'page',
          pointerId: event.pointerId,
          pageId,
          selectNodeId: pageId,
          element: wrapper,
          startClientX: event.clientX,
          startClientY: event.clientY,
          baseX: placement.x,
          baseY: placement.y,
        }
        try {
          label.setPointerCapture(event.pointerId)
        } catch {
          // 同上：无捕获环境按事件冒泡处理。
        }
      }
      // 点击/双击由标签自身处理。
      return
    }

    // 画布浮层控件自行处理点击/双击：一旦在此 setPointerCapture，后续
    // click/dblclick 会被重定向到 viewport（指针捕获的补发语义）。
    if (target?.closest('[data-canvas-ui]')) return

    const element = target?.closest<HTMLElement>('[data-pen-id]')
    const nodeId = element?.getAttribute('data-pen-id') ?? null
    const node = nodeId ? findPenNode(viewDoc, nodeId) : undefined

    // 页内按下（页根、流内子节点、ref 内容等）：拖动移动**所属页**——对齐
    // Figma/pen.dev 的顶层 frame 手感，页面常被子内容铺满，「抓住内容拖」必须
    // 生效；点按（无位移）仍选中按中的节点。位置出口见 commitPageMove。
    if (nodeId && node && pageDragTarget !== null) {
      const placement = placements.find(
        (item) => item.page.id === nodeId || containsNode(item.page, nodeId),
      )
      if (placement) {
        const wrapper =
          element?.closest<HTMLElement>('[data-page-wrapper]') ??
          surfaceRef.current?.querySelector<HTMLElement>(`[data-page-wrapper="${placement.page.id}"]`)
        if (wrapper) {
          interactionRef.current = {
            kind: 'page',
            pointerId: event.pointerId,
            pageId: placement.page.id,
            selectNodeId: nodeId,
            element: wrapper,
            startClientX: event.clientX,
            startClientY: event.clientY,
            baseX: placement.x,
            baseY: placement.y,
          }
          captureViewport()
          return
        }
      }
    }

    interactionRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
      downNodeId: nodeId,
    }
    captureViewport()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    const dx = event.clientX - interaction.startClientX
    const dy = event.clientY - interaction.startClientY
    dragDistanceRef.current = Math.max(dragDistanceRef.current, Math.hypot(dx, dy))
    if (interaction.kind === 'pan') {
      setOffset({ x: interaction.baseX + dx, y: interaction.baseY + dy })
      return
    }
    if (dragDistanceRef.current <= DRAG_CLICK_THRESHOLD_PX) return
    const rawDx = dx / scale
    const rawDy = dy / scale
    // 页面拖动：对其它页的边缘/中线做阈值吸附，预览与提交都用修正后的位移；
    // 参考线只在吸附目标变化时 setState（拖动高频 move 不做无谓重渲染）。
    if (interaction.kind === 'page') {
      const snap = computePageSnap(
        placements,
        interaction.pageId,
        interaction.baseX,
        interaction.baseY,
        rawDx,
        rawDy,
        PAGE_SNAP_THRESHOLD_SCREEN_PX / scale,
      )
      interaction.snapDx = snap.dx
      interaction.snapDy = snap.dy
      interaction.element.style.transform = `translate(${snap.dx}px, ${snap.dy}px)`
      setPageSnapGuides((previous) => {
        const same = previous !== null
          && previous.x?.value === snap.guideX?.value && previous.x?.start === snap.guideX?.start && previous.x?.end === snap.guideX?.end
          && previous.y?.value === snap.guideY?.value && previous.y?.start === snap.guideY?.start && previous.y?.end === snap.guideY?.end
        if (same && (previous.x !== null || previous.y !== null)) return previous
        return snap.guideX || snap.guideY ? { x: snap.guideX, y: snap.guideY } : null
      })
      return
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    interactionRef.current = null
    const moved = dragDistanceRef.current > DRAG_CLICK_THRESHOLD_PX
    if (interaction.kind === 'pan') {
      // 点击（非拖拽）语义：命中节点即选中，空白处取消选中。
      if (!moved) setSelectedId(interaction.downNodeId)
      return
    }
    interaction.element.style.transform = ''
    setPageSnapGuides(null)
    if (!moved) {
      setSelectedId(interaction.selectNodeId)
      return
    }
    commitPageMove(
      interaction.pageId,
      interaction.baseX,
      interaction.baseY,
      interaction.snapDx ?? (event.clientX - interaction.startClientX) / scale,
      interaction.snapDy ?? (event.clientY - interaction.startClientY) / scale,
    )
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    interactionRef.current = null
    if (interaction.kind !== 'pan') interaction.element.style.transform = ''
    setPageSnapGuides(null)
  }

  // 滚轮 pan / ctrl 滚轮以光标为中心缩放，挂在原生监听上（合成事件 passive 无法 preventDefault）。
  const onWheel = useCallback((event: WheelEvent) => {
    event.preventDefault()
    // 用户接管相机（pan/缩放）即中断扫掠：与 pointerdown 同一让位语义，
    // 否则扫掠的 setOffset 会和用户抢相机（ref 跨渲染稳定，可直接置位）。
    if (sweepActiveRef.current) sweepAbortRef.current = true
    if (event.ctrlKey || event.metaKey) {
      const rect = viewportRef.current?.getBoundingClientRect()
      const cursorX = rect ? event.clientX - rect.left : 0
      const cursorY = rect ? event.clientY - rect.top : 0
      setScale((current) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current - event.deltaY * 0.02))
        if (next === current) return next
        setOffset((currentOffset) => ({
          x: cursorX - ((cursorX - currentOffset.x) * next) / current,
          y: cursorY - ((cursorY - currentOffset.y) * next) / current,
        }))
        return next
      })
    } else {
      setOffset((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }))
    }
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // 容器级 token 注入：$token → var(--token) 由当前主题的字面值解析。
  const variableStyle = useMemo(() => {
    const style: Record<string, string> = {}
    for (const [name, value] of Object.entries(viewDoc.modeVariables[themeMode])) {
      style[`--${name}`] = value
    }
    return style as CSSProperties
  }, [viewDoc, themeMode])

  const errorCount = viewDoc.diagnostics.filter((item) => item.level === 'error').length
  const warningCount = viewDoc.diagnostics.length - errorCount

  const groupedDiagnostics = useMemo(() => {
    const byKey = new Map<string, { level: string; message: string; count: number }>()
    for (const item of viewDoc.diagnostics) {
      const key = `${item.level}:${item.message}`
      const existing = byKey.get(key)
      if (existing) existing.count += 1
      else byKey.set(key, { level: item.level, message: item.message, count: 1 })
    }
    return [...byKey.values()]
  }, [viewDoc.diagnostics])

  /** 导出选中节点所属的顶层页（无限画布没有「当前页」，以选中为准）。 */
  const exportSelectedPage = useCallback(async () => {
    if (!selectedNode) return
    const rootPage = placements.find(
      (item) =>
        item.page.id === selectedNode.id || containsNode(item.page, selectedNode.id),
    )
    if (!rootPage) return
    setExporting(true)
    setNotice(null)
    try {
      // 原生截图优先（WKWebView 的 foreignObject 管线被画布污染，renderPageHost 内回退）。
      const base64 = await renderPenPageToPngBase64(viewDoc, rootPage.page.id)
      if (!base64) throw new Error('页面无法渲染（无尺寸或不存在）')
      const savedPath = await exportDesignPng(`${pageName(rootPage.page)}.png`, base64)
      if (savedPath) setNotice({ tone: 'info', text: t('app.design.canvas.exported', { path: savedPath }) })
    } catch (error) {
      setNotice({
        tone: 'error',
        text: t('app.design.canvas.exportFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setExporting(false)
    }
  }, [selectedNode, placements, viewDoc, t])

  const visibleSet = useMemo(
    () => new Set(visiblePlacements.map((item) => item.page.id)),
    [visiblePlacements],
  )

  // 号码按文档序（placements）而非可见子集下标：视口平移/缩放会改变可见集合，
  // 用可见下标编号时同一页会不停改号（「12 Section — 会话」只是当时的第 12 个
  // 可见项），页号就失去了「指认某一页」的意义。
  const pageNumber = useMemo(() => {
    const numbers = new Map<string, number>()
    placements.forEach((item, index) => {
      numbers.set(item.page.id, index + 1)
    })
    return numbers
  }, [placements])

  // 状态栏「按状态页导航」与画布排布共用同一份分组结果（声明 group → 名称 → 内容扫描）。
  const pageGroups = useMemo(() => resolvePageGroups(viewDoc), [viewDoc])
  const pagesById = useMemo(() => new Map(viewDoc.pages.map((page) => [page.id, page])), [viewDoc])
  const hasPageOffsets = Object.keys(pageOffsets).length > 0

  // 页底：设计稿的 bg-main（明暗自洽），缺失时用应用卡片色兜底。
  const pageSurface = viewDoc.modeVariables[themeMode]['bg-main'] || 'var(--bg-card)'

  // 选中节点所属的顶层页（页卡片高亮 + 聚焦用）：单趟扫描，命中即停。
  const selectedPageId = useMemo(() => {
    if (!selectedNode) return null
    for (const placement of placements) {
      if (containsNode(placement.page, selectedNode.id)) return placement.page.id
    }
    return null
  }, [selectedNode, placements])

  // 画布网格：随平移缩放走（间距按 2 的幂收敛到 8–96px，避免过密/过疏）。
  const gridStep = useMemo(() => {
    let step = 24 * scale
    while (step < 8) step *= 2
    while (step > 96) step /= 2
    return step
  }, [scale])

  // 检查器显示名：part/component 节点也可能被选中，统一走 in 窄化。
  const selectedNodeName = selectedNode
    ? ('name' in selectedNode && typeof selectedNode.name === 'string' ? selectedNode.name : selectedNode.id)
    : ''

  return (
    <div className="design-canvas">
      <div
        ref={viewportRef}
        className={`design-canvas__viewport${sweeping ? ' is-sweeping' : ''}`}
        data-theme-mode={themeMode}
        style={{
          backgroundPosition: `${offset.x}px ${offset.y}px`,
          backgroundSize: `${gridStep}px ${gridStep}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          data-testid="design-canvas-surface"
          ref={surfaceRef}
          className="design-canvas__surface"
          data-selected-id={selectedId ?? undefined}
          style={{
            ...variableStyle,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        >
          {placements.length === 0 ? (
            <div className="design-canvas__empty">{t('app.design.canvas.empty')}</div>
          ) : (
            placements.map((placement) => (
              <div
                key={placement.page.id}
                data-page-wrapper={placement.page.id}
                className="design-canvas__page-wrapper"
                data-page-selected={selectedPageId === placement.page.id ? 'true' : undefined}
                style={{
                  position: 'absolute',
                  left: placement.x,
                  top: placement.y,
                  width: placement.width,
                  height: placement.height,
                  // 页无填充时也要与画布底分开：用设计稿自身的 bg-main token，
                  // 取不到时退应用主题卡片色。
                  // 无高度的组织性 frame 不铺页底：它按文档坐标压在同组页面之上，
                  // 铺底就是一块盖住页首内容的不透明色块。
                  background: placement.hasHeight ? pageSurface : undefined,
                }}
              >
                {visibleSet.has(placement.page.id) ? (
                  (() => {
                    const axPage = viewDoc.axDocument?.pages.find((page) => page.id === placement.page.id)
                    return axPage && pageUsesProjectComponents(axPage.tree, viewDoc.projectComponents)
                      ? <ProjectDesignPreview document={viewDoc} page={axPage} theme={themeMode} />
                      : <PenNodeView node={placement.page} document={viewDoc} themeMode={themeMode} />
                  })()
                ) : null}
              </div>
            ))
          )}
          {pageSnapGuides?.x && (
            <div
              className="design-canvas__snap-guide"
              style={{
                left: pageSnapGuides.x.value,
                top: pageSnapGuides.x.start,
                height: pageSnapGuides.x.end - pageSnapGuides.x.start,
                width: 1 / scale,
              }}
            />
          )}
          {pageSnapGuides?.y && (
            <div
              className="design-canvas__snap-guide"
              style={{
                top: pageSnapGuides.y.value,
                left: pageSnapGuides.y.start,
                width: pageSnapGuides.y.end - pageSnapGuides.y.start,
                height: 1 / scale,
              }}
            />
          )}
        </div>
        {/* 页卡片层：屏幕空间绘制（1px 边框/标签不随缩放变形）。内容仍在上面的
            变换面里；低倍率时卡片接管指针，让「点中某页」成为可行操作。 */}
        <div className={`design-canvas__page-layer${sweeping ? ' is-scanning' : ''}`} data-testid="design-canvas-page-layer">
          {/* 组头带：屏幕空间标签（不随缩放变形），描述下方一行的分组。 */}
          {visibleGroups.map((band) => {
            const left = band.left * scale + offset.x
            // 屏幕像素定位：与页标签同一坐标系（标签占行上缘上方 24px，带在其上）。
            const top = band.rowTop * scale + offset.y - GROUP_BAND_SCREEN_CLEARANCE
            return (
              <div
                key={band.key}
                className="design-canvas__group-band"
                style={{ left, top, width: Math.max((band.right - band.left) * scale, 120) }}
                aria-hidden="true"
              >
                <span className="design-canvas__group-band-title">{band.title}</span>
                <span className="design-canvas__group-band-count">
                  {t('app.design.group.pageCount', { count: band.count })}
                </span>
                <span className="design-canvas__group-band-rule" />
              </div>
            )
          })}
          {visiblePlacements.map((placement) => {
            // 尺寸标签只在页真有高度时显示：无高度 frame 的 240 是兜底值，
            // 显示出来就是给设计稿编造一个它没有的尺寸。
            const sizeLabel = placement.hasHeight
              ? pageSizeLabel(placement.page, placement.width, placement.height)
              : null
            const left = placement.x * scale + offset.x
            const top = placement.y * scale + offset.y
            const width = placement.width * scale
            const height = placement.height * scale
            const selected = selectedPageId === placement.page.id
            // 低倍率下页内节点在屏幕上只有几像素，点中的必是小元素——此倍率
            // 让卡片接管指针，点击/拖动都作用于整页（评审面 .ax 同样适用）。
            const pagePick = scale < PAGE_PICK_SCALE
            // 扫描动态效果（pen.dev 同款）：在途页显示扫描光束，已完成的页按
            // 判定显示状态描边（ok 不描——65 页全绿时满屏描边等于没有信息）。
            const scanStatus = scanOpen ? scan.statuses.get(placement.page.id) : undefined
            // 在途页集合驱动扫描环（批量扫掠可多页并行；串行路径由 useDesignScan
            // 维护为单页集合，行为与旧 currentId 一致）。
            const scanning = scanOpen && scan.activeIds.has(placement.page.id)
            return (
              <Fragment key={placement.page.id}>
                {/* 卡片框的尺寸同样依赖兜底高度，对组织性 frame 画出来就是假边界。 */}
                {placement.hasHeight && (
                  <div
                    className={`design-canvas__page-chrome${selected ? ' is-selected' : ''}${pagePick ? ' is-pickable' : ''}`}
                    style={{ left, top, width, height, pointerEvents: pagePick ? 'auto' : 'none' }}
                    data-pen-id={pagePick ? placement.page.id : undefined}
                    aria-hidden="true"
                  />
                )}
                {scanning && (
                  <div
                    className="design-canvas__scan-beam"
                    style={{ left, top, width, height }}
                    aria-hidden="true"
                  />
                )}
                {(scanStatus === 'fail' || scanStatus === 'warn') && (
                  <div
                    className={`design-canvas__scan-marker is-${scanStatus}`}
                    style={{ left, top, width, height }}
                    aria-hidden="true"
                  />
                )}
                <button
                  type="button"
                  data-canvas-ui="page-label"
                  data-page-id={placement.page.id}
                  aria-label={pageName(placement.page)}
                  className={`design-canvas__page-label${selected ? ' is-selected' : ''}`}
                  style={{ left, top: top - LABEL_HEIGHT_PX - 4, maxWidth: Math.max(width, 60) }}
                  title={`${pageName(placement.page)} · ${placement.width}×${placement.height}
${t('app.design.canvas.fitPageHint')}`}
                  onClick={() => setSelectedId(placement.page.id)}
                  onDoubleClick={() => focusPlacement(placement)}
                >
                  <span className="design-canvas__page-label-index">
                    {pageNumber.get(placement.page.id) ?? 0}
                  </span>
                  <span className="design-canvas__page-label-name">{pageName(placement.page)}</span>
                  {sizeLabel && (
                    <span className="design-canvas__page-label-size">{sizeLabel}</span>
                  )}
                </button>
              </Fragment>
            )
          })}
        </div>
      </div>
      {selectedNode && (
        <div className="design-canvas__inspector">
          <div className="design-canvas__inspector-head">
            <span className="design-canvas__inspector-type">{selectedNode.type}</span>
            <span className="design-canvas__inspector-name" title={selectedNode.id}>
              {selectedNodeName}
            </span>
          </div>
          <div className="design-canvas__inspector-actions">
            <button type="button" onClick={referenceSelected}>
              {t('app.design.canvas.reference')}
            </button>
            <button type="button" onClick={implementSelected}>
              {t('app.design.canvas.implement')}
            </button>
            <button
              type="button"
              className={`design-canvas__inspector-delete${deleteArmed ? ' is-armed' : ''}`}
              disabled={!axPageDeletable}
              title={deleteButtonTitle}
              onClick={onDeleteButtonClick}
            >
              {deleteArmed ? t('app.design.canvas.deleteArmed') : t('app.design.canvas.delete')}
            </button>
          </div>
        </div>
      )}
      <div className="design-canvas__statusbar">
        <span className="design-canvas__doc-info">
          {doc.fileName} · {viewDoc.pages.length}
          {t('app.design.pages.countSuffix')}
        </span>
        {axReview && viewDoc.pages.length > 1 && pageGroups.length > 1 && (
          <select aria-label={t('app.design.canvas.statePage')} value={selectedPageId ?? viewDoc.pages[0]?.id ?? ''}
            onChange={(event) => focusPageFromScan(event.target.value)}>
            {pageGroups.map((group) => (
              <optgroup key={group.key} label={group.title ?? t('app.design.pages.aria')}>
                {group.pageIds.map((pageId) => {
                  const page = pagesById.get(pageId)
                  if (!page) return null
                  const state = viewDoc.pageMetadata?.[pageId]?.state
                  return (
                    <option key={pageId} value={pageId}>
                      {pageName(page)}{state ? ` · ${Object.values(state).join(' / ')}` : ''}
                    </option>
                  )
                })}
              </optgroup>
            ))}
          </select>
        )}
        {axReview && hasPageOffsets && (
          <button type="button" onClick={resetPageOffsets} title={t('app.design.canvas.resetLayoutHint')}>
            {t('app.design.canvas.resetLayout')}
          </button>
        )}
        <span className="design-canvas__zoom">
          <button type="button" onClick={() => setScale((s) => clampScale(s - ZOOM_STEP))} aria-label={t('app.design.zoom.out')}>
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale((s) => clampScale(s + ZOOM_STEP))} aria-label={t('app.design.zoom.in')}>
            +
          </button>
          <button type="button" onClick={fitAll}>
            {t('app.design.canvas.fit')}
          </button>
          <button
            type="button"
            onClick={() => {
              setScale(1)
              setOffset({ x: 0, y: 0 })
            }}
          >
            {t('app.design.zoom.reset')}
          </button>
        </span>
        <span className="design-canvas__theme">{themeMode}</span>
        {viewDoc.version && <span className="design-canvas__theme">v{viewDoc.version}</span>}
        <button
          type="button"
          onClick={() => void exportSelectedPage()}
          disabled={!selectedNode || exporting}
          title={selectedNode ? undefined : t('app.design.canvas.exportHint')}
        >
          {exporting ? t('app.design.canvas.exportBusy') : t('app.design.canvas.export')}
        </button>
        <button
          type="button"
          className={`design-canvas__scan-toggle${scanOpen ? ' is-active' : ''}`}
          aria-pressed={scanOpen}
          onClick={() => setScanOpen((open) => !open)}
          title={t('app.design.scan.hint')}
        >
          {t('app.design.scan.toggle')}
        </button>
        {notice && (
          <span
            className={`design-canvas__notice is-${notice.tone}`}
            title={notice.text}
          >
            {notice.text}
          </span>
        )}
        {viewDoc.diagnostics.length > 0 && (
          <button
            type="button"
            className={`design-canvas__diagnostics-toggle${errorCount > 0 ? ' has-error' : ''}`}
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            {t('app.design.diagnostics.toggle', { error: errorCount, warning: warningCount })}
          </button>
        )}
      </div>
      {diagnosticsOpen && viewDoc.diagnostics.length > 0 && (
        <ul className="design-canvas__diagnostics">
          {groupedDiagnostics.map((item) => (
            <li
              key={`${item.level}:${item.message}`}
              className={`design-canvas__diagnostic is-${item.level}`}
            >
              {item.count > 1 ? `${item.message} ×${item.count}` : item.message}
            </li>
          ))}
        </ul>
      )}
      {scanOpen && (
        <DesignScanPanel
          scan={scan}
          onClose={() => setScanOpen(false)}
          onFocusPage={focusPageFromScan}
        />
      )}
    </div>
  )
}

export default DesignCanvas
