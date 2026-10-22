/**
 * 画布页面的智能分组与自动排布。
 *
 * 背景：`.ax` 页没有坐标（硬规则「度量与坐标不进设计稿」），此前全部页兜底排在
 * 一条水平直线上——几十页的稿子要横向平移上万像素才能看完。这里把「扫描页面内容」
 * 变成确定性归组，再按组排成多行：
 *
 * 1. **声明分组**：`.ax` 页级 `group`（规则 3「同一 UI 的多状态归组」）——作者声明
 *    的语义，最高优先。
 * 2. **名称前缀**：无声明时从页名推导——剥掉文档级公共前缀（严格 LCP 被少数异名
 *    页破坏时退化为覆盖过半的最高频首段）与尺寸后缀，取首个分隔段（`·`/`—`/`/`）。
 * 3. **内容指纹**：名称也无信号时扫描页树（组件名/部件/图标/文案），Jaccard
 *    相似度贪心聚类——同屏多状态共享大部分词汇，天然聚在一起。
 *
 * 分组只影响**无坐标页**的兜底排布；`.pen` 文件坐标即权威，永远原样保留。
 * 组头（band）只展示、不参与指针交互——摆放调整仍走页拖动/叠加层。
 */
import type { PenDocument, PenNodeUnion } from '@/agent/design/penParser'

/** 无坐标页的自动排布间距。 */
export const AUTO_LAYOUT_GAP = 120

/**
 * 行换行的宽度上限（画布坐标）：约 6 张全尺寸页（1180 宽 + 间距）。组内页数多时
 * 折行而不是无限拉长——横向平移的代价要封顶；小页（侧栏面板 489 宽）一行可容
 * 十余张，天然按宽度自适应。
 */
export const AUTO_LAYOUT_ROW_MAX_WIDTH = 7800

/** 组头带高度（**屏幕像素**，与页标签同高：标签不随缩放变形，带也一样）。 */
export const GROUP_BAND_HEIGHT = 20

/**
 * 组头带上缘相对行上缘的偏移（**屏幕像素**）：行内各页的页标签固定占据行上缘
 * 上方 24px（20px 高 + 4px 空隙），组头带在其上再让 4px——两层文字不打架。
 * 必须是屏幕像素：页标签定位不随缩放变，画布坐标偏移在低倍率下会缩进标签槽里
 * 与页标签重叠（实测 51% 时两者同槽）。
 */
export const GROUP_BAND_SCREEN_CLEARANCE = 48

export interface PagePlacement {
  page: PenNodeUnion
  x: number
  y: number
  width: number
  height: number
  /** 页是否声明了高度（组织性 frame 没有，见 pageSizeOf）。 */
  hasHeight: boolean
}

export interface ContentBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 组头带：一组页的标题行（画布坐标）。渲染层把它投影成屏幕空间标签，
 * 画在首行上方的间隙里——不占布局高度（首行上方本就有 AUTO_LAYOUT_GAP 空隙）。
 */
export interface GroupBand {
  /** 稳定键（与 PageGroupInfo.key 一致）。 */
  key: string
  title: string
  /** 组内参与自动排布的页数。 */
  count: number
  /** 组首行的上缘 y。 */
  rowTop: number
  /** 带的水平范围：该组各行的最大跨度（组头描述整组）。 */
  left: number
  right: number
}

export interface PageGroupInfo {
  /** 稳定键：`declared:<group>` / `name:<段>` / `scan:<簇序号>`。 */
  key: string
  /**
   * 展示标题。单页组与无可靠标题的组为 null——不渲染组头，连续的无标题组
   * 在排布时合并为一行（避免逐页一行的碎行）。
   */
  title: string | null
  /** 组内页 id，按文档序。覆盖全部页各恰好一次。 */
  pageIds: string[]
}

// ---------------------------------------------------------------- 页几何

/**
 * 页尺寸。**未声明 height 的顶层 frame 不是画布页**——.pen 里的 `Section — …`
 * 标题带与组件展示区是无高度的组织性 frame（分组标签语义）。此前它们被套上
 * 240px 兜底高度后变成「一张 8980×240 的空页」：按文档 x/y 压在同组页面上
 * （`Section — 会话` y=1671 与页首 y=1831 重叠 80px），页底又是一块不透明填充，
 * 于是每页顶部 80px 被盖住、整条带子看起来是一大块莫名其妙的色块。
 * hasHeight 让这类 frame 只保留标签与命中区：不铺页底、不画卡片框、不显示
 * 臆造的尺寸。
 */
export const pageSizeOf = (
  page: PenNodeUnion,
): { width: number; height: number; hasHeight: boolean } => {
  // 组件节点（`.ax` 的 component）没有尺寸字段：走 in 窄化，与 unknown 占位同口径。
  const width = 'width' in page && typeof page.width === 'number' && page.width > 0 ? page.width : 320
  const height = 'height' in page && typeof page.height === 'number' && page.height > 0 ? page.height : 240
  return { width, height, hasHeight: 'height' in page && typeof page.height === 'number' && page.height > 0 }
}

/** 坐标读取：unknown 占位节点没有 x/y（PenUnknownNode），统一走 in 窄化。 */
export const coordOf = (page: PenNodeUnion): { x?: number; y?: number } => ({
  x: 'x' in page && typeof page.x === 'number' ? page.x : undefined,
  y: 'y' in page && typeof page.y === 'number' ? page.y : undefined,
})

export const boundsOf = (placements: readonly PagePlacement[]): ContentBounds | null => {
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

// ---------------------------------------------------------------- 名称工具

export const pageNameOf = (page: PenNodeUnion): string =>
  ('name' in page && typeof page.name === 'string' ? page.name : page.id)

/** 名称尾部的「· 1180×780」尺寸段与残留分隔符：分组按语义名，尺寸是噪声。 */
const stripSizeSuffix = (name: string): string =>
  name.replace(/\d+\s*×\s*\d+\s*$/, '').replace(/[\s·\-—/]+$/u, '').trim()

/** 名称分隔段：`·`/`—`/`/` 是作者表达「主体 / 状态」的惯用分隔。空格不切（「SSH 面板」）。 */
const firstSegmentOf = (name: string): string =>
  name.split(/[·—/]/)[0]?.trim() ?? ''

const trimSeparators = (name: string): string =>
  name.replace(/^[\s·\-—/]+/u, '').replace(/[\s·\-—/]+$/u, '')

/** 公共前缀（字符级）。 */
const commonPrefix = (names: readonly string[]): string => {
  if (names.length === 0) return ''
  let prefix = names[0] as string
  for (const name of names.slice(1)) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1
    prefix = prefix.slice(0, i)
    if (prefix === '') break
  }
  return prefix
}

/**
 * 文档级公共前缀：先取严格 LCP；被少数异名页（如组件库页不带「Axiom — 」）破坏时
 * 退化为覆盖过半成员的最高频首段——前缀剥离服务的对象是多数页。
 */
const docPrefixOf = (names: readonly string[]): string => {
  if (names.length < 2) return ''
  const strict = trimSeparators(commonPrefix(names))
  if (strict.length >= 2) return strict
  const counts = new Map<string, number>()
  for (const name of names) {
    const segment = firstSegmentOf(name)
    if (segment.length >= 2) counts.set(segment, (counts.get(segment) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [segment, count] of counts) {
    if (count > bestCount) {
      best = segment
      bestCount = count
    }
  }
  // 覆盖 ≥2/3 才算文档前缀：门槛过低会把「组级前缀」（如某组叫「会话」其余组
  // 不带）误当文档前缀，剥掉后组标题就丢了组身份。
  return best && bestCount >= 2 && bestCount * 3 >= names.length * 2 ? best : ''
}

/**
 * 组标题推导（多成员组）：公共前缀 ≥2 字直接用；否则取覆盖过半成员的最高频
 * 分段（声明组内成员名可能发散——session 组里混着「新任务」「图片灯箱」，但
 * 「会话」覆盖大多数）；再退化到声明键（`session`），无声明则不展示标题。
 */
const deriveGroupTitle = (
  memberNames: readonly string[],
  declaredGroup: string | undefined,
): string | null => {
  const prefix = trimSeparators(commonPrefix(memberNames))
  if (prefix.length >= 2) return prefix
  const counts = new Map<string, number>()
  for (const name of memberNames) {
    const segment = firstSegmentOf(name)
    if (segment.length >= 2) counts.set(segment, (counts.get(segment) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [segment, count] of counts) {
    if (count > bestCount) {
      best = segment
      bestCount = count
    }
  }
  // 「最高频」至少要真的出现两次：两成员组各自唯一分段时 count=1 也能过半数
  // 校验，会把其中一页的名字当成整组标题。
  if (best && bestCount >= 2 && bestCount * 2 >= memberNames.length) return best
  if (declaredGroup && declaredGroup.trim() !== '') return declaredGroup
  return null
}

// ---------------------------------------------------------------- 内容指纹

/**
 * 内容指纹：页树里的组件名 / 部件 / 图标 / 文案。同屏多状态共享大部分内容词汇，
 * 指纹重叠度是「同一 UI」的可靠信号；文案截前 16 条防巨型页淹没信号。
 */
const fingerprintOf = (page: PenNodeUnion): Set<string> => {
  const marks = new Set<string>()
  let textCount = 0
  const walk = (node: PenNodeUnion): void => {
    if (node.type === 'component' && 'name' in node && typeof node.name === 'string' && node.name) {
      marks.add(`component:${node.name}`)
    } else if (node.type === 'part' && 'part' in node && typeof node.part === 'string' && node.part) {
      marks.add(`part:${node.part}`)
    } else if (node.type === 'icon' && 'icon' in node && typeof node.icon === 'string' && node.icon) {
      marks.add(`icon:${node.icon}`)
    } else if (node.type === 'text' && 'content' in node && typeof node.content === 'string') {
      const text = node.content.trim()
      if (text.length >= 2 && textCount < 16) {
        marks.add(`text:${text}`)
        textCount += 1
      }
    }
    const children = 'children' in node ? node.children : undefined
    for (const child of children ?? []) walk(child)
  }
  walk(page)
  return marks
}

/** 内容聚类阈值：同屏状态的重叠度远高于不同屏；取经验下限防漏聚。 */
const SCAN_JACCARD_THRESHOLD = 0.34

/** 第三级：内容指纹贪心聚类（文档序单趟，簇成员指纹取并集）。返回逐页簇序号。 */
const clusterByContent = (pages: readonly PenNodeUnion[]): number[] => {
  const fingerprints = pages.map(fingerprintOf)
  const clusterMarks: Set<string>[] = []
  const assignment = new Array<number>(pages.length).fill(-1)
  for (let i = 0; i < pages.length; i += 1) {
    const marks = fingerprints[i] as Set<string>
    let bestCluster = -1
    let bestScore = 0
    for (let c = 0; c < clusterMarks.length; c += 1) {
      const cluster = clusterMarks[c] as Set<string>
      let intersection = 0
      for (const mark of marks) if (cluster.has(mark)) intersection += 1
      const union = cluster.size + marks.size - intersection
      const score = union === 0 ? 0 : intersection / union
      if (score >= SCAN_JACCARD_THRESHOLD && score > bestScore) {
        bestCluster = c
        bestScore = score
      }
    }
    if (bestCluster >= 0) {
      assignment[i] = bestCluster
      for (const mark of marks) (clusterMarks[bestCluster] as Set<string>).add(mark)
    } else {
      clusterMarks.push(new Set(marks))
      assignment[i] = clusterMarks.length - 1
    }
  }
  return assignment
}

// ---------------------------------------------------------------- 分组

/** 页 id → 声明分组（`.ax` pageMetadata；缺失/空白视为未声明）。 */
const declaredGroupOf = (doc: PenDocument, pageId: string): string | undefined => {
  const group = doc.pageMetadata?.[pageId]?.group
  return group && group.trim() !== '' ? group.trim() : undefined
}

/**
 * 三级分组：声明 group → 名称分段 → 内容聚类。结果覆盖 `doc.pages` 全部页各恰好
 * 一次——状态栏导航与画布排布共用这份结果，漏页会同时破坏两处。
 */
export const resolvePageGroups = (doc: PenDocument): PageGroupInfo[] => {
  const pages = doc.pages
  if (pages.length === 0) return []
  const cleanedNames = pages.map((page) => stripSizeSuffix(pageNameOf(page)))
  const prefix = docPrefixOf(cleanedNames)

  // 名称有信号（至少一个分段被 ≥2 页共享）才走名称分组；全员唯一分段时名称
  // 只能产出逐页一组的碎组，交给内容聚类更可靠。
  const segments = cleanedNames.map((name) => {
    const rest = prefix !== '' && name.startsWith(prefix) ? trimSeparators(name.slice(prefix.length)) : name
    return firstSegmentOf(rest)
  })
  // 组标题同样消费剥掉文档前缀的名称：否则「Axiom — 会话…」组的公共前缀是
  // 「Axiom」，所有组头都会变成文档名。
  const restNames = cleanedNames.map((name) => {
    if (prefix === '' || !name.startsWith(prefix)) return name
    const rest = trimSeparators(name.slice(prefix.length))
    return rest !== '' ? rest : name
  })
  const segmentCounts = new Map<string, number>()
  for (const segment of segments) segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1)
  const nameHasSignal = segments.some((segment) => segment !== '' && (segmentCounts.get(segment) ?? 0) > 1)

  const keys: string[] = new Array(pages.length).fill('')
  let scanNeeded = false
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i] as PenNodeUnion
    const declared = declaredGroupOf(doc, page.id)
    if (declared) {
      keys[i] = `declared:${declared}`
    } else if (nameHasSignal && segments[i]) {
      keys[i] = `name:${segments[i]}`
    } else {
      scanNeeded = true
    }
  }
  if (scanNeeded) {
    const assignment = clusterByContent(pages)
    for (let i = 0; i < pages.length; i += 1) {
      if (keys[i] === '') keys[i] = `scan:${assignment[i]}`
    }
  }

  // 键 → 组（保持首次出现序）；同键页归并。
  const order: string[] = []
  const members = new Map<string, number[]>()
  for (let i = 0; i < pages.length; i += 1) {
    const key = keys[i] as string
    if (!members.has(key)) {
      members.set(key, [])
      order.push(key)
    }
    ;(members.get(key) as number[]).push(i)
  }

  return order.map((key) => {
    const indices = members.get(key) as number[]
    const declared = declaredGroupOf(doc, (pages[indices[0]] as PenNodeUnion).id)
    // 单页组不展示标题：组头会与页标签重复成噪声。
    const title = indices.length >= 2
      ? deriveGroupTitle(indices.map((i) => restNames[i] as string), declared)
      : null
    return {
      key,
      title,
      pageIds: indices.map((i) => (pages[i] as PenNodeUnion).id),
    }
  })
}

// ---------------------------------------------------------------- 排布

interface LayoutRow {
  /** 该行所属组键（换行续行与被合并的碎组都要记录，供 band 跨行聚合）。 */
  groupKey: string
  /** 该行是否渲染组头（组的首行且有标题）。 */
  band: boolean
  /** 无标题组的行可被后续无标题组并入（换行续行不可——续行还属于原组）。 */
  openForMerge: boolean
  placements: PagePlacement[]
  /** 行上缘 y（布局循环里回填，band 聚合用）。 */
  bandTop: number
  /** 行右缘 x（不含尾间距，band 聚合用）。 */
  bandRight: number
}

/**
 * 页布局：有 x/y 的按原坐标铺开（文件坐标即权威，永不重排）；无坐标的按
 * `resolvePageGroups` 的分组排成多行——有标题的组独占一行并挂组头（行宽超上限
 * 折行），连续的无标题组合并为一行；整块排在既有内容下方。
 */
export const buildPlacements = (
  pages: readonly PenNodeUnion[],
  doc: PenDocument,
): { placements: PagePlacement[]; groupBands: GroupBand[] } => {
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
  if (auto.length === 0) return { placements: placed, groupBands: [] }

  // 分组按全量文档算（状态栏共用），排布只消费其中落在自动块里的页。
  const groupInfos = resolvePageGroups(doc)
  const autoById = new Map(auto.map((page) => [page.id, page]))
  const autoGroups = groupInfos
    .map((group) => ({
      ...group,
      pages: group.pageIds
        .map((id) => autoById.get(id))
        .filter((page): page is PenNodeUnion => page !== undefined),
    }))
    .filter((group) => group.pages.length > 0)

  const rows: LayoutRow[] = []
  const newRow = (groupKey: string, band: boolean, openForMerge: boolean): LayoutRow => {
    const row: LayoutRow = { groupKey, band, openForMerge, placements: [], bandTop: 0, bandRight: 0 }
    rows.push(row)
    return row
  }
  let row: LayoutRow | null = null
  for (const group of autoGroups) {
    const titled = group.title !== null
    if (!titled && row?.openForMerge) {
      // 无标题碎组并入上一行，避免逐页一行的碎行。
    } else {
      row = newRow(group.key, titled, !titled)
    }
    let rowWidth = row.placements.reduce((sum, item) => sum + item.width, 0)
      + Math.max(row.placements.length - 1, 0) * AUTO_LAYOUT_GAP
    for (const page of group.pages) {
      const size = pageSizeOf(page)
      // 换行：本页放不下且行内已有页——保底每行至少一页（巨页独占一行）。
      const needed = (row.placements.length > 0 ? rowWidth + AUTO_LAYOUT_GAP : 0) + size.width
      if (row.placements.length > 0 && needed > AUTO_LAYOUT_ROW_MAX_WIDTH) {
        row = newRow(group.key, false, false)
        rowWidth = 0
      }
      row.placements.push({ page, x: 0, y: 0, ...size })
      rowWidth += (row.placements.length > 1 ? AUTO_LAYOUT_GAP : 0) + size.width
    }
  }

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

  const autoPlacements: PagePlacement[] = []
  let cursorY = bottom + AUTO_LAYOUT_GAP
  const rowsByGroup = new Map<string, LayoutRow[]>()
  for (const row of rows) {
    let cursorX = left
    let rowHeight = 0
    for (const item of row.placements) {
      autoPlacements.push({ ...item, x: cursorX, y: cursorY })
      rowHeight = Math.max(rowHeight, item.height)
      cursorX += item.width + AUTO_LAYOUT_GAP
    }
    const list = rowsByGroup.get(row.groupKey) ?? []
    list.push(row)
    rowsByGroup.set(row.groupKey, list)
    row.bandTop = cursorY
    row.bandRight = cursorX - AUTO_LAYOUT_GAP
    cursorY += rowHeight + AUTO_LAYOUT_GAP
  }

  const infoByKey = new Map(groupInfos.map((group) => [group.key, group]))
  const autoCountByKey = new Map(autoGroups.map((group) => [group.key, group.pages.length]))
  const groupBands: GroupBand[] = []
  for (const row of rows) {
    if (!row.band) continue
    const info = infoByKey.get(row.groupKey)
    if (!info?.title) continue
    // 带的水平范围覆盖该组全部行（换行组的组头描述整组）。
    let right = row.bandRight
    for (const member of rowsByGroup.get(row.groupKey) ?? [row]) {
      right = Math.max(right, member.bandRight)
    }
    groupBands.push({
      key: row.groupKey,
      title: info.title,
      count: autoCountByKey.get(row.groupKey) ?? info.pageIds.length,
      rowTop: row.bandTop,
      left,
      right,
    })
  }
  return { placements: [...placed, ...autoPlacements], groupBands }
}
