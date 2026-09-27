/**
 * 设计无限画布（docs/design-canvas.md D4 / §11 无限画布重构）。
 *
 * .pen 的全部页（顶层 frame）按各自 x/y 铺在同一张无限画布上：pan / 以光标
 * 为中心的缩放 / 适应画布、点选高亮、页与绝对定位节点拖动改位、删除、属性
 * 检查器编辑、undo/redo。编辑以「原始 JSON 字段补丁」写回
 * write_design_document（CAS 防覆盖外部保存），写盘成功后经 markWritten
 * 短路轮询并阻止自回声重采纳；无 rawJson 的调用方（对比列）退化为只读浏览。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { findPenNode, parsePenDocument } from '@/agent/design/penParser'
import type { PenDocument, PenNode, PenNodeUnion } from '@/agent/design/penParser'
import PenNodeView from './PenNodeView'
import DesignScanPanel from './DesignScanPanel'
import { useDesignScan } from './useDesignScan'
import { buildDesignImplementationPrompt } from './designImplementationPrompt'
import { renderPenPageToPngBase64 } from './ax/renderPageHost'
import { useCanvasThemeMode } from './useCanvasThemeMode'
import {
  applyPatchToRaw,
  applyPatchesToRaw,
  collectRefNodeIds,
  findRawNodePath,
  readAtRaw,
  serializePenRaw,
} from './designEditing'
import type { DesignEditPatch } from './designEditing'
import { encodeUtf8ToBase64 } from '@/platform/base64'
import { exportDesignPng, writeDesignDocument } from '@/platform/designDocument'
import { useT } from '@/i18n'

const MIN_SCALE = 0.1
const MAX_SCALE = 4
const ZOOM_STEP = 0.2
/** 拖拽位移超过该值（屏幕像素）视为拖动而非点选。 */
const DRAG_CLICK_THRESHOLD_PX = 6
/** `.ax` 页级删除确认态的自动收起时长：足够完成「看清→再点」，短到不碍下一次点选。 */
const DELETE_ARM_TIMEOUT_MS = 3_000
/** 无坐标页的自动排布间距（兜底：axiom.pen 的页都带 x/y）。 */
const AUTO_LAYOUT_GAP = 120
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
      kind: 'node'
      pointerId: number
      nodeId: string
      /** 点按（无位移）时选中的节点：拖绝对节点 = 自身。 */
      selectNodeId: string
      element: HTMLElement
      startClientX: number
      startClientY: number
      baseX: number
      baseY: number
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

interface PagePlacement {
  page: PenNodeUnion
  x: number
  y: number
  width: number
  height: number
  /** 页是否声明了高度（组织性 frame 没有，见 pageSizeOf）。 */
  hasHeight: boolean
}

interface ContentBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const pageName = (page: PenNodeUnion): string =>
  ('name' in page && typeof page.name === 'string' ? page.name : page.id)

/**
 * 页面摆放叠加层（`.ax` 评审面专用）。`.ax` 格式页没有坐标（硬规则「坐标不进
 * 设计稿」），画布自动排布；用户拖动是**评审呈现层**的调整，不是设计内容——
 * 按 D3「画布不做内容编辑」不写文件、不走 raw 补丁（绕过格式校验），落
 * localStorage 按文档路径归档。`.pen` 不走叠加层：文件坐标即权威。
 */
type PageLayoutOffsets = Record<string, { x: number; y: number }>

const PAGE_LAYOUT_STORAGE_KEY = 'axiom.design.page-layout.v1'

const loadPageLayout = (docPath: string): PageLayoutOffsets => {
  try {
    const raw = window.localStorage.getItem(PAGE_LAYOUT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, PageLayoutOffsets>
    return parsed[docPath] ?? {}
  } catch {
    return {}
  }
}

const savePageLayout = (docPath: string, offsets: PageLayoutOffsets): void => {
  try {
    const raw = window.localStorage.getItem(PAGE_LAYOUT_STORAGE_KEY)
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, PageLayoutOffsets>
    all[docPath] = offsets
    window.localStorage.setItem(PAGE_LAYOUT_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // localStorage 不可用（配额/隐私模式）：仅失去跨重启记忆，本次拖动照常生效。
  }
}

/** 名称是否已自带宽×高（设计稿常见命名「… · 1180×780」），此时不再拼接尺寸。 */
const NAME_HAS_SIZE = /\d+\s*×\s*\d+\s*$/

const pageSizeLabel = (page: PenNodeUnion, width: number, height: number): string | null =>
  NAME_HAS_SIZE.test(pageName(page)) ? null : `${width}×${height}`

/**
 * 页尺寸。**未声明 height 的顶层 frame 不是画布页**——.pen 里的 `Section — …`
 * 标题带与组件展示区是无高度的组织性 frame（分组标签语义）。此前它们被套上
 * 240px 兜底高度后变成「一张 8980×240 的空页」：按文档 x/y 压在同组页面上
 * （`Section — 会话` y=1671 与页首 y=1831 重叠 80px），页底又是一块不透明填充，
 * 于是每页顶部 80px 被盖住、整条带子看起来是一大块莫名其妙的色块。
 * hasHeight 让这类 frame 只保留标签与命中区：不铺页底、不画卡片框、不显示
 * 臆造的尺寸。
 */
const pageSizeOf = (
  page: PenNodeUnion,
): { width: number; height: number; hasHeight: boolean } => {
  // 组件节点（`.ax` 的 component）没有尺寸字段：走 in 窄化，与 unknown 占位同口径。
  const width = 'width' in page && typeof page.width === 'number' && page.width > 0 ? page.width : 320
  const height = 'height' in page && typeof page.height === 'number' && page.height > 0 ? page.height : 240
  return { width, height, hasHeight: 'height' in page && typeof page.height === 'number' && page.height > 0 }
}

/** 坐标读取：unknown 占位节点没有 x/y（PenUnknownNode），统一走 in 窄化。 */
const coordOf = (page: PenNodeUnion): { x?: number; y?: number } => ({
  x: 'x' in page && typeof page.x === 'number' ? page.x : undefined,
  y: 'y' in page && typeof page.y === 'number' ? page.y : undefined,
})

/** 页布局：有 x/y 的按原坐标铺开；无坐标的兜底排在既有内容下方一行。 */
const buildPlacements = (pages: readonly PenNodeUnion[]): PagePlacement[] => {
  const placed: PagePlacement[] = []
  const auto: PenNodeUnion[] = []
  for (const page of pages) {
    const { x, y } = coordOf(page)
    if (x !== undefined && y !== undefined) {
      placed.push({ page, x, y, ...pageSizeOf(page) })
    } else {
      auto.push(page)
    }
  }
  if (auto.length > 0) {
    let bottom = -Infinity
    let left = Infinity
    for (const item of placed) {
      bottom = Math.max(bottom, item.y + item.height)
      left = Math.min(left, item.x)
    }
    if (!Number.isFinite(bottom) || !Number.isFinite(left)) {
      bottom = 0
      left = 0
    }
    let cursorX = left
    for (const page of auto) {
      const size = pageSizeOf(page)
      placed.push({ page, x: cursorX, y: bottom + AUTO_LAYOUT_GAP, ...size })
      cursorX += size.width + AUTO_LAYOUT_GAP
    }
  }
  return placed
}

const boundsOf = (placements: readonly PagePlacement[]): ContentBounds | null => {
  if (placements.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const item of placements) {
    minX = Math.min(minX, item.x)
    minY = Math.min(minY, item.y)
    maxX = Math.max(maxX, item.x + item.width)
    maxY = Math.max(maxY, item.y + item.height)
  }
  return { minX, minY, maxX, maxY }
}

const containsNode = (node: PenNodeUnion, nodeId: string): boolean => {
  if (node.id === nodeId) return true
  const children = 'children' in node ? node.children : undefined
  return (children ?? []).some((child) => containsNode(child, nodeId))
}

// ---------------------------------------------------------------- 页面拖动吸附

/** 吸附触发阈值（屏幕像素）：除以缩放得画布坐标阈值，各缩放级别手感一致。 */
export const PAGE_SNAP_THRESHOLD_SCREEN_PX = 6

/** 对齐参考线（画布坐标）：value 是参考轴坐标，start/end 是线段在另一轴的范围。 */
export interface PageSnapGuide {
  value: number
  start: number
  end: number
}

export interface PageSnapResult {
  dx: number
  dy: number
  /** 竖直参考线（x 轴对齐：左/中/右）。 */
  guideX: PageSnapGuide | null
  /** 水平参考线（y 轴对齐：上/中/下）。 */
  guideY: PageSnapGuide | null
}

/**
 * 页面拖动吸附（Figma 式智能对齐）：拖动页的左/中/右、上/中/下三轴与**其它页**
 * 的同轴做阈值吸附，返回修正后的位移与参考线段。纯函数——指针层逐帧调用，
 * 松手提交的坐标即吸附后的坐标。
 */
export const computePageSnap = (
  placements: readonly PagePlacement[],
  draggedId: string,
  baseX: number,
  baseY: number,
  rawDx: number,
  rawDy: number,
  threshold: number,
): PageSnapResult => {
  const dragged = placements.find((item) => item.page.id === draggedId)
  if (!dragged) return { dx: rawDx, dy: rawDy, guideX: null, guideY: null }
  const others = placements.filter((item) => item.page.id !== draggedId)

  const snapAxis = (
    axis: 'x' | 'y',
    raw: number,
    crossDelta: number,
  ): { delta: number; guide: PageSnapGuide | null } => {
    const size = axis === 'x' ? dragged.width : dragged.height
    const base = axis === 'x' ? baseX : baseY
    const crossBase = axis === 'x' ? baseY : baseX
    const crossSize = axis === 'x' ? dragged.height : dragged.width
    const draggedAxes = [base, base + size / 2, base + size].map((value) => value + raw)
    let best: { distance: number; delta: number; guide: PageSnapGuide } | null = null
    for (const other of others) {
      const otherSize = axis === 'x' ? other.width : other.height
      const otherBase = axis === 'x' ? other.x : other.y
      const otherCrossBase = axis === 'x' ? other.y : other.x
      const otherCrossSize = axis === 'x' ? other.height : other.width
      for (const target of [otherBase, otherBase + otherSize / 2, otherBase + otherSize]) {
        for (const value of draggedAxes) {
          const distance = Math.abs(value - target)
          if (distance > threshold) continue
          if (best && distance >= best.distance) continue
          // 参考线段覆盖拖动页与对齐页的联合范围（对齐关系一目了然）。
          const crossStart = Math.min(crossBase + crossDelta, otherCrossBase)
          const crossEnd = Math.max(crossBase + crossDelta + crossSize, otherCrossBase + otherCrossSize)
          best = { distance, delta: target - value, guide: { value: target, start: crossStart, end: crossEnd } }
        }
      }
    }
    return best ? { delta: raw + best.delta, guide: best.guide } : { delta: raw, guide: null }
  }

  const xSnap = snapAxis('x', rawDx, rawDy)
  const ySnap = snapAxis('y', rawDy, xSnap.delta)
  return { dx: xSnap.delta, dy: ySnap.delta, guideX: xSnap.guide, guideY: ySnap.guide }
}


const walkNodeChildren = (
  node: PenNodeUnion,
  visit: (child: PenNodeUnion) => void,
): void => {
  const children = 'children' in node ? node.children : undefined
  for (const child of children ?? []) {
    visit(child)
    walkNodeChildren(child, visit)
  }
}

const DesignCanvas = ({
  doc,
  rawJson = null,
  sha256,
  onWritten,
  onReload,
  onDeletePage,
}: {
  doc: PenDocument
  /** 原始 JSON 文本：存在才启用编辑层（补丁写回）。对比列等只读场景不传。 */
  rawJson?: string | null
  sha256?: string
  onWritten?: (sha256: string) => void
  onReload?: () => void
  /**
   * `.ax` 评审面的整页删除通道（useDesignDocument.deletePage）。提供后才解锁
   * 「选中页根 → 删除」；`.pen` 的删除走编辑层（undo 可回退），不经此属性。
   */
  onDeletePage?: (pageId: string) => Promise<{ ok: boolean; message: string | null }>
}) => {
  const { t } = useT()
  const themeMode = useCanvasThemeMode()
  const editable = Boolean(rawJson && onWritten)
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
  // 撤销栈代际：栈本身在 ref 里，bump 它驱动状态栏按钮的可用性重渲染。
  const [, setHistoryVersion] = useState(0)
  // 编辑层：raw 原始 JSON 树 + 解析投影。本地编辑后 doc 与 props.doc 分叉，
  // 外部变更经 sha 采纳整体换代（undo/redo 栈随之清空）。
  const [edit, setEdit] = useState<{ raw: unknown; doc: PenDocument } | null>(null)
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
  const adoptedShaRef = useRef<string | undefined>(undefined)
  const casShaRef = useRef<string | undefined>(undefined)
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const undoStackRef = useRef<DesignEditPatch[][]>([])
  const redoStackRef = useRef<DesignEditPatch[][]>([])
  const editRef = useRef(edit)
  editRef.current = edit

  const viewDoc = edit?.doc ?? doc

  // 切换文档时重读摆放叠加层（按文档路径归档）。
  useEffect(() => {
    setPageOffsets(loadPageLayout(doc.fileName))
  }, [doc.fileName])

  // 扫描运行状态上提到画布层：面板与画布叠加层（当前页扫描光束 / 已完成页
  // 状态描边）消费同一份数据，扫描时画布逐页点亮（pen.dev 的动态扫描效果）。
  const scan = useDesignScan({ doc: viewDoc, requireSize: axReview })
  // 打开面板即扫一轮（与原面板挂载语义一致）；文档换代不自动重扫，由用户重跑。
  const runScanRef = useRef(scan.run)
  runScanRef.current = scan.run
  useEffect(() => {
    if (scanOpen) void runScanRef.current()
  }, [scanOpen])

  // 外部内容采纳：sha 换代（首次加载 / Agent·pen.dev 保存）才重建编辑层。
  // 自写回声被 markWritten 同步的 sha 短路（adoptedShaRef 已在写盘时更新）。
  useEffect(() => {
    if (!rawJson) {
      setEdit(null)
      adoptedShaRef.current = undefined
      return
    }
    if (sha256 !== undefined && sha256 === adoptedShaRef.current) return
    try {
      const raw: unknown = JSON.parse(rawJson)
      undoStackRef.current = []
      redoStackRef.current = []
      setHistoryVersion((version) => version + 1)
      adoptedShaRef.current = sha256
      casShaRef.current = sha256
      setEdit({ raw, doc })
    } catch {
      setEdit(null)
    }
    // doc 与 rawJson 由同一次 setLoaded 原子更新，作为采纳来源一起消费。
  }, [rawJson, sha256, doc])

  /**
   * 重解析 + 排队写盘。写请求串行出队，CAS 基准在出队时才读——连续两次编辑
   * 之间上一次写盘已把 casShaRef 推进到新值，不会误判冲突。写失败（典型是
   * CAS 命中外部修改）回滚本组补丁并触发 reload，从磁盘收回权威内容。
   */
  const publishRaw = useCallback(
    (raw: unknown, group: DesignEditPatch[] | null) => {
      const source = serializePenRaw(raw)
      const parsed = parsePenDocument(source, doc.fileName).document
      if (parsed) setEdit({ raw, doc: parsed })
      const contentBase64 = encodeUtf8ToBase64(source)
      writeChainRef.current = writeChainRef.current.then(async () => {
        try {
          const written = await writeDesignDocument(doc.fileName, contentBase64, casShaRef.current)
          casShaRef.current = written.sha256
          adoptedShaRef.current = written.sha256
          onWritten?.(written.sha256)
          setNotice(null)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setNotice({ tone: 'error', text: t('app.design.canvas.writeFailed', { message }) })
          if (group) {
            for (const patch of group.slice().reverse()) {
              applyPatchToRaw(raw, { path: patch.path, before: patch.after, after: patch.before })
            }
            undoStackRef.current = undoStackRef.current.filter((item) => item !== group)
            const reverted = parsePenDocument(serializePenRaw(raw), doc.fileName).document
            if (reverted) setEdit({ raw, doc: reverted })
          }
          onReload?.()
        }
      })
    },
    [doc.fileName, onWritten, onReload, t],
  )

  const applyEditPatches = useCallback(
    (patches: DesignEditPatch[]): boolean => {
      const current = editRef.current
      if (!current || !editable) return false
      if (!applyPatchesToRaw(current.raw, patches)) return false
      undoStackRef.current.push(patches)
      redoStackRef.current = []
      setHistoryVersion((version) => version + 1)
      publishRaw(current.raw, patches)
      return true
    },
    [editable, publishRaw],
  )

  const undo = useCallback(() => {
    const current = editRef.current
    const group = undoStackRef.current.pop()
    if (!current || !group) return
    const inverses = group
      .slice()
      .reverse()
      .map((patch) => ({ path: patch.path, before: patch.after, after: patch.before }))
    if (applyPatchesToRaw(current.raw, inverses)) {
      redoStackRef.current.push(group)
      publishRaw(current.raw, null)
    } else {
      undoStackRef.current.push(group)
    }
    setHistoryVersion((version) => version + 1)
  }, [publishRaw])

  const redo = useCallback(() => {
    const current = editRef.current
    const group = redoStackRef.current.pop()
    if (!current || !group) return
    if (applyPatchesToRaw(current.raw, group)) {
      undoStackRef.current.push(group)
      publishRaw(current.raw, null)
    } else {
      redoStackRef.current.push(group)
    }
    setHistoryVersion((version) => version + 1)
  }, [publishRaw])

  // 撤销/重做可用性读的是 ref 长度：变更点总会触发 setHistoryVersion 重渲染。
  const canUndo = editable && undoStackRef.current.length > 0
  const canRedo = editable && redoStackRef.current.length > 0

  const placements = useMemo(() => {
    const base = buildPlacements(viewDoc.pages)
    if (!axReview || editable || Object.keys(pageOffsets).length === 0) return base
    return base.map((item) => {
      const offset = pageOffsets[item.page.id]
      return offset ? { ...item, x: offset.x, y: offset.y } : item
    })
  }, [viewDoc, editable, axReview, pageOffsets])
  const pageIds = useMemo(() => new Set(placements.map((item) => item.page.id)), [placements])

  /**
   * 页面拖动的持久化出口。编辑态（.pen）写文件坐标（既有 CAS + undo 通道）；
   * `.ax` 评审面写 localStorage 摆放叠加层（不写文件）；无编辑通道的只读 .pen
   * 没有出口——维持「页内按下 = 平移」的旧语义。
   */
  const pageDragTarget: 'file' | 'offsets' | null = editable ? 'file' : axReview ? 'offsets' : null

  // ref 实例内部的解析节点在 raw 树里没有对应物（子树来自组件定义克隆），
  // 按 id 编辑会误伤组件本体——整体只读。
  const readonlyIds = useMemo(() => {
    const result = new Set<string>()
    if (!edit) return result
    for (const refId of collectRefNodeIds(edit.raw)) {
      const parsed = findPenNode(edit.doc, refId)
      if (parsed) walkNodeChildren(parsed, (child) => result.add(child.id))
    }
    return result
  }, [edit])

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

  const selectedNode = useMemo(
    () => (selectedId ? findPenNode(viewDoc, selectedId) ?? null : null),
    [viewDoc, selectedId],
  )
  const selectedWritable = Boolean(
    editable && selectedNode && !readonlyIds.has(selectedNode.id),
  )
  // `.ax` 评审面的页级删除：仅当选中的是页根、有删除通道、且删后仍有页
  // （`.ax` 校验器拒绝空 pages 数组——与其写不进去，不如按钮直接说明）。
  const axPageSelected = Boolean(axReview && !editable && selectedNode && pageIds.has(selectedNode.id))
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
        setNotice({ tone: 'error', text: t('app.design.canvas.deletePageFailed', { message: result.message ?? '' }) })
      }
    },
    [onDeletePage, t],
  )

  const deleteButtonTitle = selectedWritable
    ? undefined
    : axPageDeletable
      ? deleteArmed
        ? t('app.design.canvas.deleteArmed')
        : t('app.design.canvas.deletePageHint')
      : axPageSelected
        ? t('app.design.canvas.deleteLastPageDisabled')
          : axReview
            ? t('app.design.inspector.deleteReviewReadonly')
            : t('app.design.canvas.deleteDisabled')

  const onDeleteButtonClick = () => {
    if (selectedWritable) {
      deleteSelected()
      return
    }
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
  const selectedMovable = Boolean(
    selectedNode &&
      (pageIds.has(selectedNode.id) ||
        ('layoutPosition' in selectedNode && selectedNode.layoutPosition === 'absolute')),
  )

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

  // 扫描面板点击问题页：选中并聚焦该页（与页标签双击同一行为）。
  const focusPageFromScan = useCallback(
    (pageId: string) => {
      const placement = placements.find((item) => item.page.id === pageId)
      setSelectedId(pageId)
      if (placement) focusPlacement(placement)
    },
    [placements, focusPlacement],
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
    const name = 'name' in selectedNode && typeof selectedNode.name === 'string'
      ? selectedNode.name
      : selectedNode.id
    requestComposerInsertion(`@[${name}](${doc.fileName})（design_query nodeId: ${selectedNode.id}）`)
  }, [selectedNode, doc.fileName, requestComposerInsertion])

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

  const deleteSelected = useCallback(() => {
    const current = editRef.current
    if (!current || !selectedId || !editable) return
    if (readonlyIds.has(selectedId)) return
    const nodePath = findRawNodePath(current.raw, selectedId)
    if (!nodePath || nodePath.length === 0) return
    const before = readAtRaw(current.raw, nodePath)
    if (before === undefined) return
    applyEditPatches([{ path: nodePath, before, after: undefined }])
    setSelectedId(null)
  }, [selectedId, editable, readonlyIds, applyEditPatches])

  const commitNodeMove = useCallback(
    (nodeId: string, baseX: number, baseY: number, dx: number, dy: number) => {
      const current = editRef.current
      if (!current) return
      const node = findPenNode(current.doc, nodeId)
      const nodePath = findRawNodePath(current.raw, nodeId)
      if (!node || !nodePath) return
      const beforeX = 'x' in node && typeof node.x === 'number' ? node.x : undefined
      const beforeY = 'y' in node && typeof node.y === 'number' ? node.y : undefined
      applyEditPatches([
        { path: [...nodePath, 'x'], before: beforeX, after: Math.round(baseX + dx) },
        { path: [...nodePath, 'y'], before: beforeY, after: Math.round(baseY + dy) },
      ])
    },
    [applyEditPatches],
  )

  /**
   * 页面移动提交。编辑态：页根 x/y 进文件（与节点移动同一 CAS/undo 通道；原本
   * 无坐标的自动排布页就此固化为显式坐标）。`.ax` 评审面：进 localStorage 摆放
   * 叠加层——评审呈现层的调整不写文件，也绝不走 raw 补丁绕过格式校验。
   */
  const commitPageMove = useCallback(
    (pageId: string, baseX: number, baseY: number, dx: number, dy: number) => {
      const nextX = Math.round(baseX + dx)
      const nextY = Math.round(baseY + dy)
      if (editable) {
        const current = editRef.current
        if (!current) return
        const node = findPenNode(current.doc, pageId)
        const nodePath = findRawNodePath(current.raw, pageId)
        if (!node || !nodePath) return
        const beforeX = 'x' in node && typeof node.x === 'number' ? node.x : undefined
        const beforeY = 'y' in node && typeof node.y === 'number' ? node.y : undefined
        applyEditPatches([
          { path: [...nodePath, 'x'], before: beforeX, after: nextX },
          { path: [...nodePath, 'y'], before: beforeY, after: nextY },
        ])
        return
      }
      setPageOffsets((current) => {
        const next = { ...current, [pageId]: { x: nextX, y: nextY } }
        savePageLayout(doc.fileName, next)
        return next
      })
    },
    [editable, applyEditPatches, doc.fileName],
  )

  // 键盘：Esc 取消选中；Del/Backspace 删除；Cmd/Ctrl+Z 撤销（+Shift 重做）。
  // 输入控件聚焦时不劫持按键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (event.key === 'Escape') {
        setSelectedId(null)
        return
      }
      if (!editable) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editable, selectedId, undo, redo, deleteSelected])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
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
      // 无持久化出口的只读 .pen：维持「标签上按下不 pan」的既有语义，
      // 点击/双击由标签自身处理。
      return
    }

    // 画布浮层控件自行处理点击/双击：一旦在此 setPointerCapture，后续
    // click/dblclick 会被重定向到 viewport（指针捕获的补发语义）。
    if (target?.closest('[data-canvas-ui]')) return

    const element = target?.closest<HTMLElement>('[data-pen-id]')
    const nodeId = element?.getAttribute('data-pen-id') ?? null
    const node = nodeId ? findPenNode(viewDoc, nodeId) : undefined

    // 绝对定位节点拖自身（编辑态专属：位置写入文件）。
    if (
      editable &&
      element &&
      nodeId &&
      node &&
      !readonlyIds.has(nodeId) &&
      'layoutPosition' in node &&
      node.layoutPosition === 'absolute' &&
      !pageIds.has(nodeId)
    ) {
      const placement = placements.find((item) => item.page.id === nodeId)
      const baseX = 'x' in node && typeof node.x === 'number' ? node.x : placement ? placement.x : 0
      const baseY = 'y' in node && typeof node.y === 'number' ? node.y : placement ? placement.y : 0
      interactionRef.current = {
        kind: 'node',
        pointerId: event.pointerId,
        nodeId,
        selectNodeId: nodeId,
        element,
        startClientX: event.clientX,
        startClientY: event.clientY,
        baseX,
        baseY,
      }
      captureViewport()
      return
    }

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
    // 拖动预览直接写元素 transform（不经 React 状态），松手时由提交的数据接管。
    interaction.element.style.transform = `translate(${rawDx}px, ${rawDy}px)`
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
    if (interaction.kind === 'node') {
      commitNodeMove(
        interaction.nodeId,
        interaction.baseX,
        interaction.baseY,
        (event.clientX - interaction.startClientX) / scale,
        (event.clientY - interaction.startClientY) / scale,
      )
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

  /** 检查器字段提交：对选中节点 raw 定位后打单字段补丁。 */
  const patchSelectedField = useCallback(
    (field: string, value: unknown) => {
      const current = editRef.current
      if (!current || !selectedId || !editable || readonlyIds.has(selectedId)) return
      const nodePath = findRawNodePath(current.raw, selectedId)
      if (!nodePath) return
      applyEditPatches([{ path: [...nodePath, field], before: readAtRaw(current.raw, [...nodePath, field]), after: value }])
    },
    [selectedId, editable, readonlyIds, applyEditPatches],
  )

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
  const selectedNodeNameValue = selectedNode && 'name' in selectedNode && typeof selectedNode.name === 'string'
    ? selectedNode.name
    : ''

  const selectedPenNode: PenNode | null =
    selectedNode && selectedNode.type !== 'unknown' ? (selectedNode as PenNode) : null

  return (
    <div className="design-canvas">
      <div
        ref={viewportRef}
        className="design-canvas__viewport"
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
                  <PenNodeView node={placement.page} document={viewDoc} themeMode={themeMode} />
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
        <div className="design-canvas__page-layer" data-testid="design-canvas-page-layer">
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
            const scanning = scanOpen && scan.currentId === placement.page.id
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
          {readonlyIds.has(selectedNode.id) && (
            <p className="design-canvas__inspector-readonly">
              {t('app.design.inspector.readonly')}
            </p>
          )}
          {selectedWritable && (
            <div className="design-canvas__inspector-fields">
              <InspectorTextField
                label={t('app.design.inspector.name')}
                value={selectedNodeNameValue}
                onCommit={(value) => patchSelectedField('name', value === '' ? undefined : value)}
              />
              {selectedMovable && (
                <>
                  <InspectorNumberField
                    label="X"
                    value={selectedPenNode && typeof selectedPenNode.x === 'number' ? selectedPenNode.x : undefined}
                    onCommit={(value) => patchSelectedField('x', value)}
                  />
                  <InspectorNumberField
                    label="Y"
                    value={selectedPenNode && typeof selectedPenNode.y === 'number' ? selectedPenNode.y : undefined}
                    onCommit={(value) => patchSelectedField('y', value)}
                  />
                </>
              )}
              {selectedPenNode && typeof selectedPenNode.width === 'number' && (
                <InspectorNumberField
                  label={t('app.design.inspector.width')}
                  value={selectedPenNode.width}
                  onCommit={(value) => patchSelectedField('width', value)}
                />
              )}
              {selectedPenNode && typeof selectedPenNode.height === 'number' && (
                <InspectorNumberField
                  label={t('app.design.inspector.height')}
                  value={selectedPenNode.height}
                  onCommit={(value) => patchSelectedField('height', value)}
                />
              )}
              {selectedPenNode?.type === 'text' && (
                <InspectorTextArea
                  label={t('app.design.inspector.content')}
                  value={selectedPenNode.content ?? ''}
                  onCommit={(value) => patchSelectedField('content', value)}
                />
              )}
              {selectedPenNode && typeof selectedPenNode.fontSize === 'number' && (
                <InspectorNumberField
                  label={t('app.design.inspector.fontSize')}
                  value={selectedPenNode.fontSize}
                  onCommit={(value) => patchSelectedField('fontSize', value)}
                />
              )}
              {selectedPenNode && typeof selectedPenNode.cornerRadius === 'number' && (
                <InspectorNumberField
                  label={t('app.design.inspector.radius')}
                  value={selectedPenNode.cornerRadius}
                  onCommit={(value) => patchSelectedField('cornerRadius', value)}
                />
              )}
              {selectedPenNode?.fill && (
                <InspectorFillField
                  fill={selectedPenNode.fill}
                  onCommit={(value) => patchSelectedField('fill', { kind: 'solid', value })}
                />
              )}
            </div>
          )}
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
              disabled={!selectedWritable && !axPageDeletable}
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
        {editable && (
          <span className="design-canvas__history">
            <button type="button" onClick={undo} disabled={!canUndo} aria-label={t('app.design.canvas.undo')}>
              {t('app.design.canvas.undo')}
            </button>
            <button type="button" onClick={redo} disabled={!canRedo} aria-label={t('app.design.canvas.redo')}>
              {t('app.design.canvas.redo')}
            </button>
          </span>
        )}
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

const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

/** 检查器字段公共行为：外部值换代即重置草稿，blur/Enter 提交。 */
const useDraft = (value: string): [string, (next: string) => void, () => void] => {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  return [draft, setDraft, () => setDraft(value)]
}

const InspectorTextField = ({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}) => {
  const [draft, setDraft, reset] = useDraft(value)
  const commit = (): void => {
    if (draft === value) return
    if (draft.trim() === '') {
      reset()
      return
    }
    onCommit(draft.trim())
  }
  return (
    <label className="design-canvas__field">
      <span>{label}</span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
        spellCheck={false}
      />
    </label>
  )
}

const InspectorNumberField = ({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number | undefined
  onCommit: (value: number) => void
}) => {
  const [draft, setDraft, reset] = useDraft(value === undefined ? '' : String(value))
  const commit = (): void => {
    const parsed = Number(draft.trim())
    if (!Number.isFinite(parsed)) {
      reset()
      return
    }
    if (parsed === value) return
    onCommit(parsed)
  }
  return (
    <label className="design-canvas__field">
      <span>{label}</span>
      <input
        value={draft}
        inputMode="decimal"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
        spellCheck={false}
      />
    </label>
  )
}

const InspectorTextArea = ({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}) => {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <label className="design-canvas__field design-canvas__field--area">
      <span>{label}</span>
      <textarea
        value={draft}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        spellCheck={false}
      />
    </label>
  )
}

const InspectorFillField = ({
  fill,
  onCommit,
}: {
  fill: PenNode['fill']
  onCommit: (hex: string) => void
}) => {
  const { t } = useT()
  if (fill?.kind !== 'solid') {
    return (
      <div className="design-canvas__field">
        <span>{t('app.design.inspector.fill')}</span>
        <span className="design-canvas__field-static">{fill ? fill.kind : '—'}</span>
      </div>
    )
  }
  const hex = /^#[0-9a-fA-F]{6}$/.test(fill.value) ? fill.value : null
  if (!hex) {
    // token 填充展示引用名，不提供字面编辑（避免把设计 token 打散成硬编码色）。
    return (
      <div className="design-canvas__field">
        <span>{t('app.design.inspector.fill')}</span>
        <span className="design-canvas__field-static">{fill.value}</span>
      </div>
    )
  }
  return (
    <label className="design-canvas__field">
      <span>{t('app.design.inspector.fill')}</span>
      <input type="color" value={hex} onChange={(event) => onCommit(event.target.value)} />
    </label>
  )
}

export default DesignCanvas
