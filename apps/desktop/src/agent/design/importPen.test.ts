// @vitest-environment node
/**
 * P0 验收：真实存量稿的 `.pen → .ax` 导入（docs/ax-format.md §6 P0）。
 *
 * 三条硬要求：
 * 1. **导入产物必须是合法 `.ax`**（`parseAxDocument` 零 error）——导入器不能产出坏稿；
 * 2. **结构等价**：投影回画布后的树与原 `.pen` 树逐节点等价（尺寸/文案/填充/子节点数），
 *    唯一允许的差异是绝对定位节点被 overlay 包一层（`.ax` 里坐标只能写在 overlay 上）；
 * 3. **无静默丢失**：`.ax` 暂不接受的字段必须出现在 warnings 里，且**只能**是已知清单
 *    里的那些——新增一项静默丢弃会让本用例失败（这是「格式还没覆盖什么」的可回归账本）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePenDocument } from '@/agent/design/penParser'
import type { PenDocument, PenNode, PenNodeUnion } from '@/agent/design/penParser'
import { parseAxDocument, projectAxToPenDocument, serializeAxDocument } from '@/agent/design/axParser'
import type { AxDocument, AxNode } from '@/agent/design/axSchema'
import { axOverlaySourceId, isAxOverlayWrapperId } from '@/agent/design/axSchema'
import { importPenDocument, penInstanceTexts } from './importPen'
import { axInstanceOfPenComponent } from './axComponentMap'
import { exportAxToPenDocument } from './exportPen'

const PEN_FILES = ['.pen/axiom.pen', '.pen/website.pen']

/**
 * P0 已知的未迁移字段清单，分两类，每新增一项都要在此登记（否则用例失败）：
 * 1. **真未覆盖**：`shadow`（.pen 的 effect）、`opacity`、`strokeLinejoin`、`flipX/Y`、
 *    `metadata`/`context`（设计注记，本就不该进实现）、图片的远程 URL 填充；
 * 2. **在该节点种类上语义无效**：`.pen` 的解析器会往所有节点上带 `layout`/`gap`/
 *    `padding`/`justifyContent`/`alignItems`/`theme`（共享字段），而 `.ax` 只让
 *    真正会用它们的种类（frame/overlay）持有；落在 text/icon/rect 上的这些字段
 *    渲染器同样不使用（`PenNodeView` 只在 frame 分支消费），丢弃与渲染等价。
 * 另有 `padding(非数组)`：ref 覆写整棵替换的子树未经解析器归一（已知缺口，
 * 渲染器同样忽略），导入器镜像该容错并记账。
 */
const KNOWN_UNMIGRATED_FIELDS = [
  'shadow', 'opacity', 'strokeLinejoin', 'flipX', 'flipY', 'metadata', 'context',
  'layout', 'gap', 'padding', 'justifyContent', 'alignItems', 'theme',
  'width', 'height', 'stroke', 'strokeWidth', 'cornerRadius', 'fill',
  'padding(非数组)',
  // 填充/描边的降级项（远程图片填充、覆写透传的原始形态）：与渲染器同口径丢弃，但记账。
  'fill(远程/图片填充)', 'fill(未知形态)', 'stroke(未知形态)',
]

const readPen = (relative: string): string | null => {
  const path = resolve(import.meta.dirname, '../../../../..', relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** 去掉绝对定位包装（overlay + `~content` 子节点），还原成与 `.pen` 同构的树。 */
/**
 * 绝对定位包装（overlay，id 形如 `X~overlay`）→ 被包住的源节点（id `X`）。
 * 包装层带后缀、内层保留源 id：这样导出再导入不会让后缀累积。
 */
const unwrap = (node: PenNodeUnion): PenNodeUnion => {
  const pen = node as PenNode
  if (pen.type === 'frame' && pen.layoutPosition === 'absolute' && isAxOverlayWrapperId(pen.id)) {
    const child = pen.children?.[0] as PenNode | undefined
    if (child) return { ...child, id: axOverlaySourceId(pen.id) }
  }
  return pen
}

/**
 * 渲染等价的尺寸归一：`fill_container(840)` / `hug_content` 的括号提示不参与渲染
 * （第八轮实测：括号里只是「内容撑不开时的兜底尺寸」提示），导入器按 `.ax` 规则 6
 * 归一到关键字。比较时同口径归一，避免把「有意归一」误判成结构漂移。
 */
const renderSize = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null
  if (value.startsWith('fill_container')) return 'fill_container'
  if (value.startsWith('fit_content') || value.startsWith('hug_content')) return 'fit_content'
  return value
}

/**
 * 渲染等价的填充归一：远程图片填充在 `.pen` 侧被解析器拒绝渲染（占位纹理由渲染器
 * 兜底）、在 `.ax` 侧被校验器拒绝为资产——两侧都不出图，比较时同口径归一为 null。
 */
const fillOf = (pen: PenNode): unknown => {
  const fill = pen.fill as unknown as Record<string, unknown> | undefined
  if (!fill) return null
  // 覆写透传的原始填充（`{ type:'solid', value }`）渲染器按 `.value` 读取，
  // 导入器镜像同一口径 → 比较时同口径取值。
  if (typeof fill.value === 'string' && (fill.kind === undefined || fill.kind === 'solid')) return fill.value
  if (fill.kind === 'solid' && typeof fill.value === 'string') return fill.value
  if (fill.kind === 'image' && typeof fill.url === 'string') {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(fill.url) || fill.url.startsWith('//') || fill.url.startsWith('/')
      ? null
      : `image:${fill.url}`
  }
  return fill.kind ?? null
}

const growthToWrap = (growth: PenNode['textGrowth']): string =>
  growth === 'fixed-width' ? 'width' : growth === 'fixed-width-height' ? 'width-height' : 'nowrap'

/** 组件实例的归一形态：两侧都归到这一个标记上比较（见 shapeOf 的说明）。 */
const componentShapeOf = (name: string, props: Record<string, unknown> | undefined): unknown => ({
  type: 'component',
  name,
  props: props ?? null,
})

/**
 * 结构比较的组件归一（`.ax` 的 component 节点 / 导出 `.pen` 的占位框 / `.pen` 里的 ref 实例
 * 三种形态压成同一个标记）。`withProps` 决定标记里是否带 props：
 * - 投影路径（`.pen` 实例 → `.ax` 节点）props 必须逐字相同 → 带上（能验出映射的 props 没丢）；
 * - 往返路径（`.ax` → `.pen` → `.ax`）props 在 `.pen` 里没有落脚点（占位框只留名字），
 *   带上必然假红 → 不带。
 */
const componentShape = (pen: PenNode, withProps: boolean): unknown | null => {
  const asComponent = pen as unknown as { type: string; name?: string; props?: Record<string, unknown> }
  if (asComponent.type === 'component') {
    return componentShapeOf(asComponent.name ?? '', withProps ? asComponent.props : undefined)
  }
  // 导出侧占位框：exportPen 用 `component:<Name>`/`part:<Key>` 命名。
  if (pen.type === 'frame' && typeof pen.name === 'string' && pen.name.startsWith('component:')) {
    return componentShapeOf(pen.name.slice('component:'.length), undefined)
  }
  // 源稿侧的 ref 实例：按映射判定它**应该**升成哪个组件（defer/未登记 → 不是组件）。
  if (pen.refComponentName !== undefined) {
    const instance = axInstanceOfPenComponent(pen.refComponentName, { texts: penInstanceTexts(pen) })
    if (instance && !('defer' in instance)) {
      return componentShapeOf(instance.component, withProps ? instance.props : undefined)
    }
  }
  return null
}

const shapeOf = (node: PenNodeUnion, withProps = false): unknown => {
  const pen = unwrap(node) as PenNode
  const component = componentShape(pen, withProps)
  if (component) return component
  const children = (pen.children ?? []).map((child) => shapeOf(child, withProps))
  return {
    type: pen.type,
    // 布局三件套也参与比较：`.pen` 页根是 frame，丢 layout 会让侧栏与主区竖着堆
    // （P0 曾漏掉过——结构比较必须覆盖渲染敏感字段，而不只是节点数）。
    // 布局方向按渲染语义归一：缺省即 horizontal（`.pen` 省略、`.ax` 显式写出，两者等价）。
    layout: pen.layout === 'vertical' ? 'vertical' : 'horizontal',
    gap: pen.gap ?? null,
    // 非数组 padding（覆写透传的原始值）渲染器不使用 → 与导入器同口径归一为无 padding。
    padding: Array.isArray(pen.padding) ? pen.padding : null,
    width: renderSize(pen.width),
    height: renderSize(pen.height),
    content: pen.type === 'text' ? pen.content ?? '' : null,
    // 换行三态归一为 `.ax` 的 wrap 词汇（`.pen` 的 auto/缺省 = 不换行）。
    wrap: pen.type === 'text' ? growthToWrap(pen.textGrowth) : null,
    fill: fillOf(pen),
    childCount: children.length,
    children,
  }
}

/**
 * 去掉组件实例留下的两类节点后的 `.ax` 字节，用于比较**纯 primitive 部分**：
 * - `component` 节点（升级产物）；
 * - 以及它在 `.pen` 侧的对偶——导出器写的占位框。占位框按**id** 识别（导出保留同一 id）：
 *   `.ax` 的 frame 种类不接受 `name`，所以「再导入」这一侧已经认不出名字了。
 */
const stripComponentNodes = (document: AxDocument, dropIds: ReadonlySet<string>): string => {
  const strip = (nodes: AxNode[]): AxNode[] =>
    nodes
      .filter((node) => node.kind !== 'component' && !dropIds.has(node.id))
      .map((node) => ({
        ...node,
        ...(node.children ? { children: strip(node.children) } : {}),
        ...(node.slot ? { slot: strip(node.slot) } : {}),
      }))
  return serializeAxDocument({
    ...document,
    components: {},
    pages: document.pages.map((page) => ({ ...page, tree: strip(page.tree) })),
  })
}

/** 一份稿里所有 `component` 节点的 id（两轮之间它们是同一个块的两种形态）。 */
const componentNodeIds = (document: AxDocument): Set<string> => {
  const ids = new Set<string>()
  document.pages.forEach((page) => {
    const stack = [...page.tree]
    while (stack.length > 0) {
      const node = stack.shift() as AxNode
      if (node.kind === 'component') ids.add(node.id)
      stack.push(...(node.children ?? []), ...(node.slot ?? []))
    }
  })
  return ids
}

/** 一份稿里被组件升级覆盖的实例数（与导出侧的占位框数必须相等）。 */
const upgradedInstanceCount = (document: PenDocument): number => {
  let count = 0
  const visit = (node: PenNodeUnion): void => {
    const pen = node as PenNode
    if (componentShape(pen, false)) count += 1
    ;(pen.children ?? []).forEach(visit)
  }
  document.pages.forEach(visit)
  return count
}

// 真实 `.pen` 源稿是导入往返用例的前提；工作区把稿迁移成 `.ax` 并删除 `.pen` 后，
// describe.each 会拿到空数组（= 无套件，vitest 直接报套件级错误）。空表时落一个
// 显式占位用例：跳过是显式的，不让 `npm test` 变红。
const AVAILABLE_PEN_FILES = PEN_FILES.filter((file) => readPen(file) !== null)

if (AVAILABLE_PEN_FILES.length === 0) {
  it('真实 .pen 源稿缺失（已迁移为 .ax）：导入往返用例整体跳过', () => {
    expect(AVAILABLE_PEN_FILES).toHaveLength(0)
  })
}

describe.each(AVAILABLE_PEN_FILES)('往返 %s', (file) => {
  const source = readPen(file) as string

  it('.pen → .ax → .pen 后结构等价（组件实例按占位框显式降级）', () => {
    const parsed = parsePenDocument(source, 'a.pen')
    // 固定 name：`.ax` 的 name 由调用方给（应用里是文件名），不参与往返语义。
    const { document, warnings } = importPenDocument(parsed.document!, 'axiom')
    void warnings
    const exported = exportAxToPenDocument(document)
    // 占位降级只可能来自 `.ax` 独有的 component/part：`.pen` 里没有组件概念，升级成
    // `component` 节点的实例导出时必然成为占位框。数量必须**恰好等于**升级面——少了
    // 说明导出器把某类 primitive 也写成了占位框，多了说明升级面记账漏了。
    const placeholders = exported.warnings.filter((item) => item.includes('占位框'))
    expect(placeholders).toHaveLength(upgradedInstanceCount(parsed.document!))
    const reparsed = parsePenDocument(exported.json, 'roundtrip.pen')
    expect(reparsed.error).toBeNull()
    const before = parsed.document!
    const after = reparsed.document!
    expect(after.pages).toHaveLength(before.pages.length)
    before.pages.forEach((page, index) => {
      const penRoot = page as PenNode
      const roundTripped = after.pages[index]!
      // 非容器顶层节点（画布上直接放的占位矩形）在 `.ax` 里必然是页容器的子节点，
      // 往返后多一层容器——对齐到被包住的节点比较（与导入侧同一口径）。
      const wrapped = (roundTripped as PenNode).children ?? []
      const actual = penRoot.type === 'frame' ? shapeOf(roundTripped) : shapeOf(wrapped[0] ?? roundTripped)
      expect(actual, `第 ${index + 1} 页往返后结构漂移`).toEqual(shapeOf(page))
    })
  })

  it('往返两轮的 .ax 在 primitive 上字节一致（组件实例按占位框降级，属已声明损失）', () => {
    const parsed = parsePenDocument(source, 'a.pen')
    const first = importPenDocument(parsed.document!, 'axiom')
    const exported = exportAxToPenDocument(first.document)
    const second = importPenDocument(parsePenDocument(exported.json, 'r.pen').document!, 'axiom')
    // 第二轮的「组件 → .pen 占位框 → 再导入」路径上，实例已成普通 frame，升级面必然清空；
    // 除这块**显式记账的降级**外，两轮字节必须一致——否则说明往返在别处悄悄漂了。
    expect(second.components.filter((item) => item.component !== undefined)).toEqual([])
    const drop = componentNodeIds(first.document)
    // 被剔除的 id 数 = 升级面（website.pen 没有 reusable 组件，这里是 0）。
    expect(drop.size).toBe(upgradedInstanceCount(parsed.document!))
    expect(stripComponentNodes(second.document, drop))
      .toBe(stripComponentNodes(first.document, drop))
  })
})

describe.each(AVAILABLE_PEN_FILES)('导入 %s', (file) => {
  const source = readPen(file) as string

  it('组件实例对账：升级/未升级两堆都带计数，且「取代文案」只算映射没消费的那些', () => {
    const parsed = parsePenDocument(source, 'a.pen')
    const { components } = importPenDocument(parsed.document!)
    for (const item of components) {
      expect(item.count).toBeGreaterThan(0)
      // 两堆互斥：升级项有 component 名、没有原因；未升级项反之。
      expect(item.component === undefined).toBe(item.reason !== undefined)
    }
    const upgraded = components.filter((item) => item.component !== undefined)
    const toolCards = upgraded.filter((item) => item.component === 'ToolCallCard')
    for (const item of toolCards) {
      // 工具卡的标题与数字都被 props 消费（path / sizeBytes / diffAdded / diffRemoved）→ 零取代。
      expect(item.replacedTexts ?? 0, `${item.name} 的文案应被 props 完整表达`).toBe(0)
    }
    const approvalCards = upgraded.filter((item) => item.component === 'ApprovalCard')
    for (const item of approvalCards) {
      // 审批卡的文案来自 store 数据（fixture），实例里那几句不再进稿——必须计数。
      expect(item.replacedTexts ?? 0, `${item.name} 的文案应由实现侧提供并计数`).toBeGreaterThan(0)
    }
  })

  it('导入产物是合法 .ax（零校验错误），且序列化幂等可回读', () => {
    const parsed = parsePenDocument(source, file.split('/').pop() ?? 'a.pen')
    expect(parsed.error).toBeNull()
    const { document } = importPenDocument(parsed.document!)
    const serialized = serializeAxDocument(document)
    const validated = parseAxDocument(serialized)
    expect(validated.error).toBeNull()
    expect(validated.diagnostics.filter((item) => item.level === 'error')).toEqual([])
    expect(validated.document).not.toBeNull()
    // 二次序列化字节一致（幂等）
    expect(serializeAxDocument(validated.document!)).toBe(serialized)
  })

  it('投影回画布后与原 .pen 逐节点结构等价', () => {
    const parsed = parsePenDocument(source, file.split('/').pop() ?? 'a.pen')
    const { document } = importPenDocument(parsed.document!)
    const projection = projectAxToPenDocument(document, file)
    const before = parsed.document!
    expect(projection.document.pages).toHaveLength(before.pages.length)
    before.pages.forEach((page, index) => {
      const importedPage = projection.document.pages[index]!
      // `.pen` 的顶层节点可以不是 frame（eg. 画布上直接放一张占位矩形/图片）——
      // `.ax` 的页按定义是容器，投影必然包一层 page frame，这里对齐到被包住的节点。
      const penRoot = page as PenNode
      const wrappedChildren = (importedPage as PenNode).children ?? []
      const importedShape = penRoot.type === 'frame'
        ? shapeOf(importedPage, true)
        : shapeOf(wrappedChildren[0] ?? importedPage, true)
      expect(importedShape, `第 ${index + 1} 页结构漂移`).toEqual(shapeOf(page, true))
    })
  })

  it('绝对定位经「锚点 + 残差」往返后坐标不变（P1 无损不变量）', () => {
    const parsed = parsePenDocument(source, file.split('/').pop() ?? 'a.pen')
    const { document } = importPenDocument(parsed.document!)
    const projection = projectAxToPenDocument(document, file)
    // 收集两侧「绝对定位节点 id → 左上角坐标」。
    const collect = (root: PenNodeUnion, into: Map<string, { x: number; y: number }>): void => {
      const pen = root as PenNode
      if ((root as { type: string }).type === 'unknown') return
      if (pen.layoutPosition === 'absolute' && typeof pen.x === 'number' && typeof pen.y === 'number') {
        // 包装层按源 id 记账（内层就是源节点本身）。
        into.set(axOverlaySourceId(pen.id), { x: pen.x, y: pen.y })
      }
      ;(pen.children ?? []).forEach((child) => {
        collect(child, into)
      })
    }
    const before = new Map<string, { x: number; y: number }>()
    const after = new Map<string, { x: number; y: number }>()
    parsed.document!.pages.forEach((page) => {
      collect(page, before)
    })
    projection.document.pages.forEach((page) => {
      collect(page, after)
    })
    // 不变量：源里每一个绝对定位节点都必须在投影侧存在且坐标一致（一个都不能丢）。
    // axiom.pen 有数十处（这条断言因此在那边非平凡）；website.pen 没有，属正常。
    let compared = 0
    for (const [id, original] of before) {
      const imported = after.get(id)
      expect(imported, `绝对定位节点 ${id} 在投影侧丢失`).toBeDefined()
      if (!imported) continue
      expect(imported.x, `节点 ${id} 的 x 经锚点往返漂移`).toBeCloseTo(original.x, 6)
      expect(imported.y, `节点 ${id} 的 y 经锚点往返漂移`).toBeCloseTo(original.y, 6)
      compared += 1
    }
    expect(compared).toBe(before.size)
  })

  it('未迁移字段只出现在已知清单里（无静默丢失）', () => {
    const parsed = parsePenDocument(source, file.split('/').pop() ?? 'a.pen')
    const { warnings } = importPenDocument(parsed.document!)
    const unmerged = new Set<string>()
    for (const warning of warnings) {
      const match = /未迁移字段 `([^`]+)`/.exec(warning.message)
      if (match) unmerged.add(match[1]!)
    }
    expect([...unmerged].filter((field) => !KNOWN_UNMIGRATED_FIELDS.includes(field))).toEqual([])
  })
})
