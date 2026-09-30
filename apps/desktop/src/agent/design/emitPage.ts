/**
 * `.ax` 页 → 实现骨架（TSX 源码）的发射器（docs/ax-format.md §4.7）。
 *
 * 两层映射：
 * 1. **恒等层（组件节点）**：`component` → `<ApprovalCard variant="…" command="npm test" />`，
 *    props 已由注册表契约校验，导入路径来自注册表登记的真实源码路径——不需要任何推断。
 * 2. **映射层（部件/原语）**：`part`（部件规范表未落地）显式记为 unresolved；原语映射到
 *    Axiom 技术栈的 CSS（CSS 变量 + 语义类名风格），其中 **overlay 的锚点语义直译成 CSS**：
 *    `anchor: bottom-right` + `offset: [8, 12]` → `right: 8, bottom: 12`（这正是 P1 把
 *    坐标归一成锚点的回报——生成的是 `right/bottom` 而不是 `left: 1052px`）。
 *
 * 不静默：任何无法映射的节点都出现在 `unresolved` 里（含 id/kind/原因），调用方据此
 * 告诉模型「哪些东西需要人工接线」。
 *
 * 输出是**源码文本**：转义集中在一处（`escapeJsxText`/`literalOf`）并有单测；语法
 * 有效性由用例经 TypeScript 解析器断言（生成物必须能被解析、能被 tsc 检查）。
 */
import type { AxDocument, AxGradient, AxImageFill, AxNode, AxPage, AxShadow, AxSize } from './axSchema'
import { axPartClassNames, axPartSpecOf } from './axParts'

/** 组件导入信息（来自注册表的 `sourcePath`，由调用方注入）。 */
export interface EmitComponentImport {
  /** import 来源（如 `@/components/session/ApprovalCard`）。 */
  from: string
  /** 具名导入（默认与组件名同名）。 */
  imported?: string
}

export interface EmitPageOptions {
  /** 生成组件名（缺省由页名派生）。 */
  componentName?: string
  /** 组件名 → 导入来源（缺省用 `@/<sourcePath 去扩展名>` 兜底，并在 unresolved 里提示）。 */
  componentImports?: Record<string, EmitComponentImport>
  /** 缩进宽度（默认 2）。 */
  indent?: number
}

export interface EmitUnresolved {
  id: string
  kind: string
  reason: string
}

export interface EmitPageResult {
  code: string
  componentName: string
  unresolved: EmitUnresolved[]
  counts: { nodes: number; components: number; primitives: number }
}

/** JSX 文本转义：`{`/`}`/`<`/`>` 必须转义，`&` 用实体（避免被解析成表达式或标签）。 */
export const escapeJsxText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')

/** 字符串字面量：单引号包裹 + 转义（props 与 CSS 值共用）。 */
export const literalOf = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

/**
 * 结构化 mock → JS 表达式字面量（`JSON.stringify` 的产物本身就是合法 JS 对象字面量，
 * 键与字符串值都用双引号）。用在 json 型 props 上（工具调用的 call/result、消息对象等），
 * 生成代码里必须是真的对象/数组，不能是 JSON 字符串。
 */
export const jsonLiteralOf = (value: unknown): string => JSON.stringify(value) ?? 'null'

/**
 * mock 值 → TSX 属性表达式：字符串仍用单引号字面量（与 `.ax` 1.0 的生成结果逐字一致，
 * 避免格式拓宽把已有稿的 codegen diff 全掀一遍）；对象/数组用 `{…}` 对象字面量
 * （json 型 props：工具调用的 call/result 等，生成代码里必须是真对象）。
 */
const mockExpressionOf = (value: unknown): string =>
  typeof value === 'string'
    ? literalOf(value)
    : `{${jsonLiteralOf(value)}}`

/** 图标名（kebab）→ lucide 组件名；非法返回 null（交给 unresolved 显式记录）。 */
const lucideNameOf = (iconName: string | undefined): string | null => {
  if (!iconName) return null
  const pascal = iconName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return /^[A-Za-z][A-Za-z0-9]*$/.test(pascal) ? pascal : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 绑定值：`{$mock}` 取字面量（字符串或结构化）；`{$bind}` 生成注释 + 占位（不引入未定义标识符）。 */
const bindingOf = (value: unknown): { kind: 'mock'; value: unknown } | { kind: 'bind'; target: string } | null => {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1) return null
  const key = keys[0]
  if (key === '$mock' && Object.hasOwn(value, '$mock')) return { kind: 'mock', value: value.$mock }
  if (key === '$bind' && typeof value.$bind === 'string') return { kind: 'bind', target: value.$bind }
  return null
}

/** 文案 → TSX：返回待拼接片段（可能是 JSX 表达式或注释 + 文本）。 */
const textChildOf = (value: unknown, unresolved: EmitUnresolved[], node: AxNode): string => {
  if (typeof value === 'string') return escapeJsxText(value)
  const binding = bindingOf(value)
  // 结构化 mock 在文案位置已被 axParser 校验器拒绝；这里只认字符串 mock。
  if (binding?.kind === 'mock') {
    return escapeJsxText(typeof binding.value === 'string' ? binding.value : '')
  }
  if (binding?.kind === 'bind') {
    // 数据绑定在实现侧要接真实数据源：生成注释说明接线点，占位文本保证结构完整。
    unresolved.push({ id: node.id, kind: `${node.kind}($bind)`, reason: `需接线数据源：${binding.target}` })
    return `{/* $bind: ${escapeJsxText(binding.target)} */}${escapeJsxText(binding.target)}`
  }
  return ''
}

/** token 引用原样保留为 `var(--name)`（`.ax` 的 `$name` → CSS 变量）。 */
const cssValueOf = (value: string): string => (value.startsWith('$') ? `var(--${value.slice(1)})` : value)

/** shadow 直译：`{offsetX offsetY blur color}` 形态对齐 CSS box-shadow（color 走 token→var 映射）。 */
const boxShadowOf = (shadow: AxShadow): string =>
  `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${cssValueOf(shadow.color)}`

const sizeOf = (value: AxSize | undefined): string | null => {
  if (value === undefined) return null
  if (typeof value === 'number') return `${value}px`
  if (value === 'fill_container') return '100%'
  if (value === 'fit_content') return 'fit-content'
  return cssValueOf(value)
}

const paintOf = (value: string | AxGradient | AxImageFill | undefined): { css: string; key: string } | null => {
  if (value === undefined) return null
  if (typeof value === 'string') return { key: 'background', css: cssValueOf(value) }
  if ('asset' in value) return { key: 'backgroundImage', css: `url(${literalOf(value.asset)})` }
  const stops = value.stops
    .map((stop) => `${cssValueOf(stop.color)} ${Math.round(stop.position * 100)}%`)
    .join(', ')
  const css = value.kind === 'radial'
    ? `radial-gradient(circle, ${stops})`
    : value.kind === 'angular'
      ? `conic-gradient(from ${value.rotation}deg, ${stops})`
      : `linear-gradient(${180 + value.rotation}deg, ${stops})`
  return { key: 'backgroundImage', css }
}

/** 锚点 → CSS 定位（唯一允许绝对定位的地方；直译锚点，不写像素坐标）。 */
const positionStyleOf = (node: AxNode): Record<string, string> => {
  const [offsetX, offsetY] = node.offset ?? [0, 0]
  // `center` 是单词锚点（正中）：split 后缺横向段，回退用纵向段（与 absoluteOriginOf 同口径）。
  const [vertical, horizontal = vertical] = (node.anchor ?? 'top-left').split('-') as [string, string]
  const style: Record<string, string> = { position: 'absolute' }
  if (horizontal === 'left') style.left = `${offsetX}px`
  else if (horizontal === 'center') {
    style.left = '50%'
    style.transform = 'translateX(-50%)'
  } else style.right = `${offsetX * -1}px`
  if (vertical === 'top') style.top = `${offsetY}px`
  else if (vertical === 'center') {
    style.top = '50%'
    style.transform = `${style.transform ? `${style.transform} ` : ''}translateY(-50%)`
  } else style.bottom = `${offsetY * -1}px`
  return style
}

const objectLiteralOf = (entries: Record<string, string>): string => {
  const parts = Object.entries(entries).map(([key, value]) => `${key}: ${literalOf(value)}`)
  return `{{ ${parts.join(', ')} }}`
}

/**
 * 页名 → 组件名：PascalCase；非 ASCII 起始（中文页名很常见）加 `Page` 前缀——
 * 中文标识符在 JS 里合法、JSX 也会当成组件引用，但加前缀更易读、也避免与宿主标签混淆。
 */
const componentNameOf = (page: AxPage): string => {
  const base = (page.name ?? page.id).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const pascal = base
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
  return /^[A-Za-z]/.test(pascal) ? pascal : `Page${pascal || 'Draft'}`
}

/**
 * 发射一页。返回 null 表示页不存在或缺少尺寸（页无尺寸就无法生成容器样式）。
 */
export const emitAxPageToTsx = (
  axDocument: AxDocument,
  pageIdOrIndex: string | number,
  options: EmitPageOptions = {},
): EmitPageResult | null => {
  const indent = options.indent ?? 2
  const pageIndex = typeof pageIdOrIndex === 'number'
    ? pageIdOrIndex - 1
    : axDocument.pages.findIndex((page) => page.id === pageIdOrIndex || page.name === pageIdOrIndex)
  const page = pageIndex >= 0 ? axDocument.pages[pageIndex] : undefined
  if (!page) return null

  const unresolved: EmitUnresolved[] = []
  const lucideIcons = new Set<string>()
  const componentImports = new Map<string, EmitComponentImport>()
  const counts = { nodes: 0, components: 0, primitives: 0 }

  const wrap = (depth: number): string => ' '.repeat(depth * indent)

  const nodeToJsx = (node: AxNode, depth: number): string | null => {
    counts.nodes += 1
    if (node.kind === 'component') {
      counts.components += 1
      const name = node.name ?? ''
      if (name === '') {
        unresolved.push({ id: node.id, kind: 'component', reason: '组件节点缺少 name' })
        return null
      }
      const importInfo = options.componentImports?.[name]
      if (!importInfo) {
        unresolved.push({ id: node.id, kind: 'component', reason: `缺少 ${name} 的导入来源（注册表未登记？）` })
      } else {
        componentImports.set(name, importInfo)
      }
      const props: string[] = []
      if (node.variant) props.push(`variant=${literalOf(node.variant)}`)
      for (const [key, value] of Object.entries(node.props ?? {})) {
        const binding = bindingOf(value)
        if (binding?.kind === 'mock') props.push(`${key}=${mockExpressionOf(binding.value)}`)
        else if (binding?.kind === 'bind') {
          unresolved.push({ id: `${node.id}.${key}`, kind: 'component($bind)', reason: `需接线数据源：${binding.target}` })
          props.push(`/* $bind: ${binding.target} */`)
        } else if (typeof value === 'number') props.push(`${key}={${value}}`)
        else if (typeof value === 'boolean') props.push(`${key}={${value}}`)
        else if (typeof value === 'string') props.push(`${key}=${literalOf(value)}`)
      }
      const children = (node.children ?? []).map((child) => nodeToJsx(child, depth + 1)).filter((item) => item !== null)
      const head = `<${name}${props.length > 0 ? ` ${props.join(' ')}` : ''}`
      return children.length > 0
        ? `${head}>\n${children.map((child) => `${wrap(depth + 1)}${child}`).join('\n')}\n${wrap(depth)}</${name}>`
        : `${head} />`
    }

    if (node.kind === 'part') {
      counts.primitives += 1
      // 部件 → 词表登记的**真实元素 + 类名**（与画布同一份映射，见 agent/design/axParts）。
      const spec = axPartSpecOf(node.part)
      if (!spec) {
        unresolved.push({ id: node.id, kind: 'part', reason: `词表未登记的部件：${node.part ?? '?'}` })
        return null
      }
      const className = axPartClassNames(spec, node.variant)
        .filter((name) => name !== spec.textClassName)
        .join(' ')
      const inner: string[] = []
      if (node.icon !== undefined) {
        const pascal = lucideNameOf(node.icon)
        if (pascal) {
          lucideIcons.add(pascal)
          inner.push(`<${pascal} size={15} />`)
        } else {
          unresolved.push({ id: `${node.id}.icon`, kind: 'part(icon)', reason: `图标名无法转成组件名：${node.icon}` })
        }
      }
      if (node.label !== undefined) {
        const text = textChildOf(node.label, unresolved, node)
        inner.push(spec.textClassName && typeof node.label === 'string'
          ? `<span className=${literalOf(spec.textClassName)}>${text}</span>`
          : text)
      }
      if (node.state !== undefined) {
        // 状态语义（如 hover）在实现侧通常由 CSS 伪类/状态类表达——标出接线点，不臆造类名。
        unresolved.push({ id: `${node.id}.state`, kind: 'part(state)', reason: `状态语义需接线到 CSS 状态类：${node.state}` })
      }
      const body = inner.join('')
      return body.length > 0
        ? `<${spec.element} className=${literalOf(className)}>${body}</${spec.element}>`
        : `<${spec.element} className=${literalOf(className)} />`
    }

    if (node.kind === 'overlay') {
      counts.primitives += 1
      const children = (node.children ?? []).map((child) => nodeToJsx(child, depth + 1)).filter((item) => item !== null)
      const style = positionStyleOf(node)
      const content = `<div style=${objectLiteralOf(style)}>\n${children.map((child) => `${wrap(depth + 1)}${child}`).join('\n')}\n${wrap(depth)}</div>`
      if (!node.scrim) return content
      // 遮罩语义（1.2）：backdrop 直译为铺满定位父级的遮罩层（inset: 0），
      // 内容层按锚点定位其上——实现里真实存在的 backdrop + dialog 结构。
      const scrimPaint = paintOf(node.scrim.fill)
      const scrimStyle: Record<string, string> = { position: 'absolute', inset: '0' }
      if (scrimPaint) scrimStyle[scrimPaint.key] = scrimPaint.css
      return `<div style=${objectLiteralOf(scrimStyle)}>\n${wrap(depth + 1)}${content}\n${wrap(depth)}</div>`
    }

    const style: Record<string, string> = {}
    const width = sizeOf(node.width)
    const height = sizeOf(node.height)
    if (width) style.width = width
    if (height) style.height = height
    if (node.kind === 'frame') {
      counts.primitives += 1
      style.display = 'flex'
      style.flexDirection = node.layout === 'vertical' ? 'column' : 'row'
      if (node.gap !== undefined) style.gap = typeof node.gap === 'number' ? `${node.gap}px` : cssValueOf(node.gap)
      if (node.padding) style.padding = node.padding.map((value) => (typeof value === 'number' ? `${value}px` : cssValueOf(value))).join(' ')
      if (node.justifyContent) style.justifyContent = node.justifyContent === 'space_between' ? 'space-between' : node.justifyContent
      if (node.alignItems) style.alignItems = node.alignItems
      if (node.clip) style.overflow = 'hidden'
      if (node.cornerRadius !== undefined) {
        style.borderRadius = typeof node.cornerRadius === 'number'
          ? `${node.cornerRadius}px`
          : Array.isArray(node.cornerRadius)
            ? node.cornerRadius.map((value) => (typeof value === 'number' ? `${value}px` : cssValueOf(value))).join(' ')
            : cssValueOf(node.cornerRadius)
      }
      const paint = paintOf(node.fill)
      if (paint) style[paint.key] = paint.css
      if (node.shadow) style.boxShadow = boxShadowOf(node.shadow)
      const children = (node.children ?? []).map((child) => nodeToJsx(child, depth + 1)).filter((item) => item !== null)
      const body = children.map((child) => `${wrap(depth + 1)}${child}`).join('\n')
      return `<div style=${objectLiteralOf(style)}>\n${body}\n${wrap(depth)}</div>`
    }

    if (node.kind === 'text') {
      counts.primitives += 1
      // 文本节点的 fill 是**字色**（格式语义，与 .pen 同源）——不是背景。
      const paint = paintOf(node.fill)
      if (paint) style.color = paint.css
      if (node.fontSize !== undefined) style.fontSize = typeof node.fontSize === 'number' ? `${node.fontSize}px` : cssValueOf(node.fontSize)
      if (node.fontWeight !== undefined) style.fontWeight = String(node.fontWeight).startsWith('$') ? cssValueOf(String(node.fontWeight)) : String(node.fontWeight)
      if (node.lineHeight) style.lineHeight = node.lineHeight.unit === 'multiplier' ? String(node.lineHeight.value) : `${node.lineHeight.value}px`
      if (node.letterSpacing !== undefined) style.letterSpacing = typeof node.letterSpacing === 'number' ? `${node.letterSpacing}px` : cssValueOf(node.letterSpacing)
      if (node.textAlign) style.textAlign = node.textAlign
      if (node.shadow) style.boxShadow = boxShadowOf(node.shadow)
      style.whiteSpace = node.wrap === 'nowrap' ? 'nowrap' : 'pre-wrap'
      return `<div style=${objectLiteralOf(style)}>${textChildOf(node.text, unresolved, node)}</div>`
    }

    if (node.kind === 'icon') {
      counts.primitives += 1
      const pascal = lucideNameOf(node.name)
      if (!pascal) {
        unresolved.push({ id: node.id, kind: 'icon', reason: `图标名无法转成组件名：${node.name ?? ''}` })
        return null
      }
      lucideIcons.add(pascal)
      const size = node.size ?? 16
      const paint = paintOf(node.fill)
      const iconStyle: Record<string, string> = { ...(paint ? { color: paint.css } : {}) }
      if (node.shadow) iconStyle.filter = `drop-shadow(${node.shadow.offsetX}px ${node.shadow.offsetY}px ${node.shadow.blur}px ${cssValueOf(node.shadow.color)})`
      return `<${pascal} size={${size}}${Object.keys(iconStyle).length > 0 ? ` style=${objectLiteralOf(iconStyle)}` : ''} />`
    }

    if (node.kind === 'rect' || node.kind === 'ellipse') {
      counts.primitives += 1
      const paint = paintOf(node.fill)
      if (paint) style[paint.key] = paint.css
      const stroke = paintOf(node.stroke)
      if (stroke) style.border = `1px solid ${stroke.css}`
      if (node.cornerRadius !== undefined && typeof node.cornerRadius === 'number') style.borderRadius = `${node.cornerRadius}px`
      if (node.kind === 'ellipse') style.borderRadius = '50%'
      if (node.shadow) style.boxShadow = boxShadowOf(node.shadow)
      return `<div style=${objectLiteralOf(style)} />`
    }

    if (node.kind === 'path') {
      counts.primitives += 1
      const fill = node.fill !== undefined && typeof node.fill === 'string' ? cssValueOf(node.fill) : 'none'
      const viewBox = node.viewBox ? ` viewBox=${literalOf(node.viewBox.join(' '))}` : ''
      const sizeAttrs = `${width ? ` width=${literalOf(width)}` : ''}${height ? ` height=${literalOf(height)}` : ''}`
      // path 的阴影走 filter drop-shadow：box-shadow 对 svg 是矩形盒、不跟随路径形状。
      const filter = node.shadow
        ? ` style=${objectLiteralOf({ filter: `drop-shadow(${node.shadow.offsetX}px ${node.shadow.offsetY}px ${node.shadow.blur}px ${cssValueOf(node.shadow.color)})` })}`
        : ''
      return `<svg${viewBox}${sizeAttrs}${filter}>\n${wrap(depth + 1)}<path d=${literalOf(node.geometry ?? '')} fill=${literalOf(fill)} />\n${wrap(depth)}</svg>`
    }

    if (node.kind === 'image') {
      counts.primitives += 1
      return `<img src=${literalOf(node.asset ?? '')} alt="" style=${objectLiteralOf(style)} />`
    }

    unresolved.push({ id: node.id, kind: node.kind, reason: '尚无映射' })
    return null
  }

  const body = page.tree.map((node) => nodeToJsx(node, 2)).filter((item) => item !== null)
  const componentName = options.componentName ?? componentNameOf(page)
  const imports: string[] = []
  if (lucideIcons.size > 0) {
    imports.push(`import { ${[...lucideIcons].sort().join(', ')} } from 'lucide-react'`)
  }
  for (const [name, info] of [...componentImports.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    imports.push(`import { ${info.imported ?? name} } from ${literalOf(info.from)}`)
  }
  const containerStyle: Record<string, string> = {}
  if (page.width !== undefined) containerStyle.width = `${page.width}px`
  if (page.height !== undefined) containerStyle.height = `${page.height}px`
  if (page.layout) containerStyle.flexDirection = page.layout === 'vertical' ? 'column' : 'row'
  containerStyle.display = 'flex'
  if (page.gap !== undefined) containerStyle.gap = typeof page.gap === 'number' ? `${page.gap}px` : cssValueOf(page.gap)
  if (page.padding) containerStyle.padding = page.padding.map((value) => (typeof value === 'number' ? `${value}px` : cssValueOf(value))).join(' ')
  if (page.background !== undefined) containerStyle.background = cssValueOf(page.background)
  else containerStyle.background = 'var(--bg-main)'

  const code = [
    ...(imports.length > 0 ? [...imports, ''] : []),
    `/** 由 ${page.name ?? page.id}（.ax）生成：组件为恒等映射，原语已映射到 CSS 变量。 */`,
    `export const ${componentName} = () => (`,
    `${wrap(1)}<div style=${objectLiteralOf(containerStyle)}>`,
    ...body.map((item) => `${wrap(2)}${item}`),
    `${wrap(1)}</div>`,
    ')',
    '',
  ].join('\n')

  return { code, componentName, unresolved, counts }
}
