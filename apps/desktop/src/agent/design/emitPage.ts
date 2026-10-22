/**
 * `.ax` 页 → 实现骨架（TSX 源码）的发射器（docs/ax-format.md §4.7）。
 *
 * 两层映射：
 * 1. **恒等层（组件节点）**：`component` → `<ApprovalCard variant="…" command="npm test" />`，
 *    props 已由注册表契约校验，导入路径来自注册表登记的真实源码路径——不需要任何推断。
 * 2. **映射层（部件/原语）**：`part` 映射到部件规范表登记的元素与类名；原语映射到
 *    Axiom 技术栈的 CSS（CSS 变量 + 语义类名风格），其中 **overlay 的锚点语义直译成 CSS**：
 *    `anchor: bottom-right` + `offset: [8, 12]` → `right: 8, bottom: 12`（这正是 P1 把
 *    坐标归一成锚点的回报——生成的是 `right/bottom` 而不是 `left: 1052px`）。
 *
 * 不静默：任何无法映射的节点都出现在 `unresolved` 里（含 id/kind/原因），调用方据此
 * 告诉模型「哪些东西需要人工接线」。
 *
 * 输出是**源码文本**：转义集中在一处（`escapeJsxText`/`literalOf`）并有单测；
 * 生成物经 TypeScript 语法断言与真实项目 strict 类型检查。
 */
import type { DesignComponentDetail } from './componentInventoryHost'
import { componentFixtureOf, designBindingOf as bindingOf, resolveComponentProps } from './componentInstance'
import { axBindingKind, type AxBinding, type AxDocument, type AxGradient, type AxImageFill, type AxNode, type AxPage, type AxShadow, type AxSize } from './axSchema'
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
  componentDetails?: Record<string, DesignComponentDetail>
  layout?: 'responsive' | 'reference'
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
  counts: { nodes: number; components: number; symbols: number; primitives: number }
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

/** 图标名（kebab）→ lucide 组件名；非法返回 null（交给 unresolved 显式记录）。 */
const lucideNameOf = (iconName: string | undefined): string | null => {
  if (!iconName) return null
  const pascal = iconName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return /^[A-Za-z][A-Za-z0-9]*$/.test(pascal) ? pascal : null
}

/**
 * 文案 → TSX：返回字面文本或类型化绑定表达式；symbol body 内的 `{$param}` 发射为
 * prop 引用表达式（`{c1}`）——局部组件的 typed props 直接消费。
 */
const textChildOf = (
  value: unknown,
  unresolved: EmitUnresolved[],
  node: AxNode,
  bind: (key: string, type: string) => string,
  params?: ReadonlySet<string>,
): string => {
  if (typeof value === 'string') return escapeJsxText(value)
  // symbol body 的参数引用（1.4）：发射为 `{prop名}`（params 缺省 = 页树路径，校验器
  // 已拦住页树里的 $param，这里只防御性返回空）。
  if (params !== undefined && axBindingKind(value) === 'param') {
    const paramName = (value as AxBinding).$param ?? ''
    return params.has(paramName) ? `{${paramName}}` : ''
  }
  const binding = bindingOf(value)
  // 结构化 mock 在文案位置已被 axParser 校验器拒绝；这里只认字符串 mock。
  if (binding?.kind === 'mock') {
    return escapeJsxText(typeof binding.value === 'string' ? binding.value : '')
  }
  if (binding?.kind === 'bind') {
    // 数据绑定在实现侧要接真实数据源：生成必填的类型化接线点。
    unresolved.push({ id: node.id, kind: `${node.kind}($bind)`, reason: `需接线数据源：${binding.target}` })
    return `{${bind(`${node.id}.text`, 'string')}}`
  }
  return ''
}

/** token 引用原样保留为 `var(--name)`（`.ax` 的 `$name` → CSS 变量）。 */
export const cssValueOf = (value: string): string => (value.startsWith('$') ? `var(--${value.slice(1)})` : value)

/** shadow 直译：`{offsetX offsetY blur color}` 形态对齐 CSS box-shadow（color 走 token→var 映射）。 */
export const boxShadowOf = (shadow: AxShadow): string =>
  `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${cssValueOf(shadow.color)}`

export const sizeOf = (value: AxSize | undefined): string | null => {
  if (value === undefined) return null
  if (typeof value === 'number') return `${value}px`
  if (value === 'fill_container') return '100%'
  if (value === 'fit_content') return 'fit-content'
  return cssValueOf(value)
}

export const paintOf = (value: string | AxGradient | AxImageFill | undefined): { css: string; key: string } | null => {
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
export const positionStyleOf = (node: AxNode): Record<string, string> => {
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
 * 名字 → PascalCase 组件标识符；非 ASCII 起始加前缀——中文标识符在 JS 里合法、JSX
 * 也会当成组件引用，但加前缀更易读、也避免与宿主标签混淆。
 */
const pascalIdentifierOf = (base: string, prefix: string): string => {
  const cleaned = base.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const pascal = cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
  return /^[A-Za-z]/.test(pascal) ? pascal : `${prefix}${pascal || 'Draft'}`
}

/** 页名 → 组件名（PascalCase；非 ASCII 起始加 `Page` 前缀）。 */
const componentNameOf = (page: AxPage): string => pascalIdentifierOf(page.name ?? page.id, 'Page')

/** symbol 名 → 局部组件名（PascalCase；非 ASCII 起始加 `Sym` 前缀，与页组件区分）。 */
const symbolComponentNameOf = (name: string): string => pascalIdentifierOf(name, 'Sym')

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
  const bindings = new Map<string, string>()
  const bind = (key: string, type: string): string => {
    bindings.set(key, type)
    return `bindings[${literalOf(key)}]`
  }
  const counts = { nodes: 0, components: 0, symbols: 0, primitives: 0 }

  // symbol 名 → 局部组件名的确定性映射（全稿按名排序分配；净化后同名追加序号，
  // 并预留页组件名）。实例发射与组件声明必须同名，先算好再走树。
  const symbolComponentNames = new Map<string, string>()
  {
    const pageComponent = options.componentName ?? componentNameOf(page)
    const taken = new Set<string>([pageComponent])
    for (const name of Object.keys(axDocument.symbols ?? {}).sort()) {
      let candidate = symbolComponentNameOf(name)
      if (taken.has(candidate)) {
        let suffix = 2
        while (taken.has(`${candidate}${suffix}`)) suffix += 1
        candidate = `${candidate}${suffix}`
      }
      taken.add(candidate)
      symbolComponentNames.set(name, candidate)
    }
  }

  const wrap = (depth: number): string => ' '.repeat(depth * indent)

  // 页内实际用到的 symbol（实例发射时登记）——只发射用到的，未用 symbol 不进产物。
  const usedSymbols = new Set<string>()

  /** 枚举位图标参数（1.6）：body 里以 `{$param}` 作 `icon.name` 的参数名集合。 */
  const iconParamNamesOf = (nodes: readonly AxNode[]): Set<string> => {
    const names = new Set<string>()
    const walk = (list: readonly AxNode[]): void => {
      for (const node of list) {
        if (node.kind === 'icon' && typeof node.name === 'object' && node.name !== null) {
          const param = (node.name as { $param?: unknown }).$param
          if (typeof param === 'string') names.add(param)
        }
        walk(node.children ?? [])
        walk(node.slot ?? [])
      }
    }
    walk(nodes)
    return names
  }

  // 枚举位图标的局部变量表：body 递归会经过多层 frame，用闭包传递（改签名要动所有递归点）。
  let activeIconLocals: ReadonlyMap<string, string> | undefined

  const nodeToJsx = (node: AxNode, depth: number, params?: ReadonlySet<string>): string | null => {
    counts.nodes += 1
    if (node.kind === 'component') {
      // 本地 symbol 实例（1.4）：发射为同文件局部组件（见下方 symbol 发射段），
      // props 直传 string 文案；`$bind` 与注册表组件同款走类型化接线点。
      const symbolName = typeof node.name === 'string' ? node.name : undefined
      const symbolDef = symbolName === undefined ? undefined : axDocument.symbols?.[symbolName]
      if (symbolName !== undefined && symbolDef) {
        counts.symbols += 1
        usedSymbols.add(symbolName)
        const tag = symbolComponentNames.get(symbolName) ?? symbolName
        const props: string[] = []
        for (const [key, value] of Object.entries(node.props ?? {})) {
          const binding = bindingOf(value)
          if (binding?.kind === 'bind') {
            unresolved.push({ id: `${node.id}.${key}`, kind: 'symbol($bind)', reason: `需接线数据源：${binding.target}` })
            props.push(`${key}={${bind(`${node.id}.${key}`, 'string')}}`)
          } else {
            const literal = typeof value === 'string'
              ? value
              : binding?.kind === 'mock' && typeof binding.value === 'string' ? binding.value : ''
            props.push(`${key}={${literalOf(literal)}}`)
          }
        }
        return `<${tag}${props.length > 0 ? ` ${props.join(' ')}` : ''} />`
      }
      counts.components += 1
      const name = typeof node.name === 'string' ? node.name : ''
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
      const detail = options.componentDetails?.[name]
      const fixture = detail ? componentFixtureOf(detail.fixtures, node.fixture) : {}
      const resolved = resolveComponentProps(detail?.summary.kind ?? 'presentational', fixture, node.props, node.variant)
      const props: string[] = []
      if (!detail) unresolved.push({ id: node.id, kind: 'component', reason: `缺少 ${name} 的完整契约，fixture 与回调未校验` })
      for (const [key, value] of Object.entries(resolved)) {
        const binding = bindingOf(node.props?.[key])
        if (binding?.kind === 'bind') {
          unresolved.push({ id: `${node.id}.${key}`, kind: 'component($bind)', reason: `需接线数据源：${binding.target}` })
          props.push(`${key}={${bind(`${node.id}.${key}`, `ComponentProps<typeof ${name}>[${literalOf(key)}]`)}}`)
        } else props.push(`${key}={${jsonLiteralOf(value)}}`)
      }
      for (const key of detail?.statics ?? []) {
        if (Object.hasOwn(resolved, key)) continue
        props.push(`${key}={${bind(`${node.id}.${key}`, `ComponentProps<typeof ${name}>[${literalOf(key)}]`)}}`)
        unresolved.push({ id: `${node.id}.${key}`, kind: 'component(callback)', reason: `需接线回调：${name}.${key}` })
      }
      for (const field of detail?.summary.props ?? []) {
        if (!field.required || Object.hasOwn(resolved, field.name)) continue
        props.push(`${field.name}={${bind(`${node.id}.${field.name}`, `ComponentProps<typeof ${name}>[${literalOf(field.name)}]`)}}`)
        unresolved.push({ id: `${node.id}.${field.name}`, kind: 'component(prop)', reason: `缺少必填属性：${name}.${field.name}` })
      }
      if (detail?.summary.kind === 'store-bound') {
        unresolved.push({ id: node.id, kind: 'component(store)', reason: 'fixture 是预览 store 数据，实现侧需接线真实状态' })
      }
      // 插槽（1.5）：详单 slots 契约存在时直译——default → children 形态发射为 JSX
      // children；具名 prop 形态注入 Fragment（首版仅 children 形态插槽，无作用域插槽）。
      // 无契约仍记 unresolved，不静默丢内容（既有目录 defaultSlot 布尔继续兜底 children）。
      const slotNodes = node.slot ?? node.children ?? []
      const slotProp = detail?.slots?.default?.prop ?? (detail?.summary.defaultSlot ? 'children' : undefined)
      if (slotNodes.length > 0 && slotProp === undefined) {
        unresolved.push({ id: node.id, kind: 'component(slot)', reason: '插槽尚无实现契约，不自动转换为 children' })
      } else if (slotNodes.length > 0 && slotProp !== 'children') {
        const children = slotNodes.map((child) => nodeToJsx(child, depth + 1, params)).filter((child) => child !== null)
        const fragment = children.length > 0
          ? `<>${children.map((child) => `\n${wrap(depth + 2)}${child}`).join('')}\n${wrap(depth + 1)}</>`
          : 'null'
        props.push(`${slotProp}={${fragment}}`)
      }
      const tag = `${name}${props.length > 0 ? ` ${props.join(' ')}` : ''}`
      if (slotProp === 'children') {
        const children = slotNodes.map((child) => nodeToJsx(child, depth + 1, params)).filter((child) => child !== null)
        return `<${tag}>${children.length ? `\n${children.map((child) => `${wrap(depth + 1)}${child}`).join('\n')}\n${wrap(depth)}` : '{null}'}</${name}>`
      }
      return `<${tag} />`
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
        const text = textChildOf(node.label, unresolved, node, bind, params)
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
      const children = (node.children ?? []).map((child) => nodeToJsx(child, depth + 1, params)).filter((item) => item !== null)
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
      const children = (node.children ?? []).map((child) => nodeToJsx(child, depth + 1, params)).filter((item) => item !== null)
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
      return `<div style=${objectLiteralOf(style)}>${textChildOf(node.text, unresolved, node, bind, params)}</div>`
    }

    if (node.kind === 'icon') {
      counts.primitives += 1
      const iconParam = typeof node.name === 'object' && node.name !== null
        ? (node.name as { $param?: unknown }).$param
        : undefined
      if (typeof iconParam === 'string') {
        // 枚举位参数：发射为局部变量（映射表在选择处声明），prop 被真实消费。
        const local = activeIconLocals?.get(iconParam)
        if (!local) {
          unresolved.push({ id: node.id, kind: 'icon', reason: `枚举位参数 ${iconParam} 未在契约声明为枚举型` })
          return null
        }
        const paramSize = node.size ?? 16
        const paramPaint = paintOf(node.fill)
        const paramStyle: Record<string, string> = { ...(paramPaint ? { color: paramPaint.css } : {}) }
        return `<${local} size={${paramSize}}${Object.keys(paramStyle).length > 0 ? ` style=${objectLiteralOf(paramStyle)}` : ''} />`
      }
      const iconName = typeof node.name === 'string' ? node.name : undefined
      const pascal = lucideNameOf(iconName)
      if (!pascal) {
        unresolved.push({ id: node.id, kind: 'icon', reason: `图标名无法转成组件名：${iconName ?? ''}` })
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
  // symbol 局部组件（仅页内用到的）：`const X = ({ p }: { p: string }) => (<>…</>)`。
  // body 经同一个 nodeToJsx 发射（icon/import/unresolved 自然汇入），参数引用由
  // params 作用域发射为 `{p}` 表达式；多根 body 用 Fragment 包裹——零 DOM 节点，
  // 与投影展开「body 根直接成为实例父级的 flex 子项」同语义。
  const symbolComponents: string[] = []
  const iconMapConsts: string[] = []
  for (const name of [...usedSymbols].sort()) {
    const def = axDocument.symbols?.[name]
    const componentTag = symbolComponentNames.get(name)
    if (!def || !componentTag) continue
    const contract = def.props ?? {}
    const paramNames = [...new Set(Object.keys(contract))]
    // 枚举位参数（icon.name，1.6）：生成图标映射表 + 块体局部变量，让发射物真实消费该
    // prop——声明了却不消费是 TS6133，整稿编译门禁会直接红（不能只记 wiring 点）。
    const iconLocals = new Map<string, string>()
    const iconParams = iconParamNamesOf(def.body)
    for (const [param, type] of Object.entries(contract)) {
      if (type === 'string' || !iconParams.has(param)) continue
      const mapConst = `ICON_${componentTag}_${param}`
      const entries = type.enum.map((value) => {
        const pascal = lucideNameOf(value)
        if (pascal) lucideIcons.add(pascal)
        return `${literalOf(value)}: ${pascal ?? 'undefined'}`
      })
      iconMapConsts.push(`const ${mapConst} = { ${entries.join(', ')} } as const`)
      iconLocals.set(param, `IconOf_${param}`)
    }
    activeIconLocals = iconLocals.size > 0 ? iconLocals : undefined
    const bodyLines = def.body
      .map((root) => nodeToJsx(root, iconLocals.size > 0 ? 3 : 2, new Set(paramNames)))
      .filter((item) => item !== null)
    activeIconLocals = undefined
    if (paramNames.length > 0 && lucideIcons.has(componentTag)) {
      // 局部组件名与 lucide 图标导入同名会让生成的模块编译不过——不静默，标记接线点。
      unresolved.push({ id: name, kind: 'symbol', reason: `局部组件名 ${componentTag} 与 lucide 图标导入同名，实现侧请重命名其一` })
    }
    const propTypes = paramNames.map((param) => {
      const type = contract[param]
      return type === 'string'
        ? `${param}: string`
        : `${param}: ${type.enum.map((value) => literalOf(value)).join(' | ')}`
    })
    const signature = propTypes.length > 0 ? `({ ${paramNames.join(', ')} }: { ${propTypes.join('; ')} })` : '()'
    if (iconLocals.size > 0) {
      // 含枚举位图标的局部组件必须用块体：先按 prop 取组件，再返回 Fragment。
      symbolComponents.push(
        [
          `const ${componentTag} = ${signature} => {`,
          ...[...iconLocals].map(([param, local]) => `${wrap(1)}const ${local} = ICON_${componentTag}_${param}[${param}]`),
          `${wrap(1)}return (`,
          `${wrap(2)}<>`,
          ...bodyLines.map((line) => `${wrap(3)}${line}`),
          `${wrap(2)}</>`,
          `${wrap(1)})`,
          '}',
          '',
        ].join('\n'),
      )
      continue
    }
    symbolComponents.push(
      [
        `const ${componentTag} = ${signature} => (`,
        `${wrap(1)}<>`,
        ...bodyLines.map((line) => `${wrap(2)}${line}`),
        `${wrap(1)}</>`,
        ')',
        '',
      ].join('\n'),
    )
  }
  const componentName = options.componentName ?? componentNameOf(page)
  const imports: string[] = []
  if (lucideIcons.size > 0) {
    imports.push(`import { ${[...lucideIcons].sort().join(', ')} } from 'lucide-react'`)
  }
  for (const [name, info] of [...componentImports.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    imports.push(info.imported === 'default'
      ? `import ${name} from ${literalOf(info.from)}`
      : `import { ${info.imported && info.imported !== name ? `${info.imported} as ${name}` : name} } from ${literalOf(info.from)}`)
  }
  const containerStyle: Record<string, string> = {}
  containerStyle.position = 'relative'
  containerStyle.minWidth = '0'
  if (options.layout === 'reference') {
    if (page.width !== undefined) containerStyle.width = `${page.width}px`
    if (page.height !== undefined) containerStyle.height = `${page.height}px`
  } else {
    containerStyle.width = '100%'
    containerStyle.minHeight = '100%'
  }
  if (page.layout) containerStyle.flexDirection = page.layout === 'vertical' ? 'column' : 'row'
  containerStyle.display = 'flex'
  if (page.gap !== undefined) containerStyle.gap = typeof page.gap === 'number' ? `${page.gap}px` : cssValueOf(page.gap)
  if (page.padding) containerStyle.padding = page.padding.map((value) => (typeof value === 'number' ? `${value}px` : cssValueOf(value))).join(' ')
  if (page.background !== undefined) containerStyle.background = cssValueOf(page.background)
  else containerStyle.background = 'var(--bg-main)'

  const bindingType = bindings.size > 0
    ? `export interface ${componentName}Bindings {\n${[...bindings].map(([key, type]) => `${wrap(1)}${literalOf(key)}: ${type}`).join('\n')}\n}\n`
    : null
  if ([...bindings.values()].some((type) => type.startsWith('ComponentProps<'))) {
    imports.unshift("import type { ComponentProps } from 'react'")
  }
  const code = [
    ...(imports.length > 0 ? [...imports, ''] : []),
    ...(bindingType ? [bindingType] : []),
    ...(iconMapConsts.length > 0 ? [...iconMapConsts, ''] : []),
    ...symbolComponents,
    `export const ${componentName} = (${bindingType ? `{ bindings }: { bindings: ${componentName}Bindings }` : ''}) => (`,
    `${wrap(1)}<div style=${objectLiteralOf(containerStyle)}>`,
    ...body.map((item) => `${wrap(2)}${item}`),
    `${wrap(1)}</div>`,
    ')',
    '',
  ].join('\n')

  return { code, componentName, unresolved, counts }
}
