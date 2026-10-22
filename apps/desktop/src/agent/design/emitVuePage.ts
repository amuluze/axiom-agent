import type { AxDocument, AxNode } from './axSchema'
import type {
  EmitPageOptions,
  EmitPageResult,
  EmitUnresolved,
} from './emitPage'
import {
  boxShadowOf,
  cssValueOf,
  literalOf,
  paintOf,
  positionStyleOf,
  sizeOf,
} from './emitPage'
import {
  componentFixtureOf,
  designBindingOf,
  resolveComponentProps,
} from './componentInstance'
import { axPartClassNames, axPartSpecOf } from './axParts'
import { expandSymbolInstances } from './axParser'

const attribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
const stringExpression = (value: string): string =>
  literalOf(value)
    .replace(/"/g, '\\u0022')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
const expression = (value: unknown): string => {
  if (typeof value === 'string') return stringExpression(value)
  if (Array.isArray(value)) return `[${value.map(expression).join(', ')}]`
  if (value !== null && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, field]) => `${stringExpression(key)}: ${expression(field)}`)
      .join(', ')} }`
  return JSON.stringify(value) ?? 'null'
}
const styleAttribute = (style: Record<string, string>): string =>
  ` :style="${expression(style)}"`

export const emitAxPageToVue = (
  document: AxDocument,
  pageIdOrIndex: string | number,
  options: EmitPageOptions = {},
): EmitPageResult | null => {
  const page =
    typeof pageIdOrIndex === 'number'
      ? document.pages[pageIdOrIndex - 1]
      : document.pages.find(
          (item) => item.id === pageIdOrIndex || item.name === pageIdOrIndex,
        )
  if (!page) return null
  const componentName = options.componentName ?? 'DesignPage'
  const unresolved: EmitUnresolved[] = []
  const imports = new Map<string, string>()
  const bindings = new Map<string, string>()
  const counts = { nodes: 0, components: 0, symbols: 0, primitives: 0 }
  // symbol 实例（1.4）：Vue SFC 是单文件单组件模型，不发射局部组件——先内联展开
  // （与画布投影同一套展开语义），并逐 symbol 记一条说明。展开不是静默降级：接线者
  // 需要知道复用边界在哪（React 输出会得到独立的局部组件）。
  const symbols = document.symbols ?? {}
  const usedSymbolNames: string[] = []
  const collectUsedSymbols = (nodes: readonly AxNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'component' && typeof node.name === 'string'
        && Object.hasOwn(symbols, node.name) && !usedSymbolNames.includes(node.name)) {
        usedSymbolNames.push(node.name)
      }
      if (node.children) collectUsedSymbols(node.children)
      if (node.slot) collectUsedSymbols(node.slot)
    }
  }
  collectUsedSymbols(page.tree ?? [])
  const renderTree = usedSymbolNames.length > 0
    ? expandSymbolInstances(page.tree ?? [], symbols)
    : (page.tree ?? [])
  for (const name of usedSymbolNames) {
    unresolved.push({
      id: name,
      kind: 'symbol',
      reason: `Vue SFC 单文件模型：symbol ${name} 已内联展开（React 输出为独立局部组件）`,
    })
  }
  const binding = (key: string, type: string): string => {
    bindings.set(key, type)
    return `bindings[${stringExpression(key)}]`
  }
  const text = (value: unknown, node: AxNode): string => {
    const reference = designBindingOf(value)
    if (reference?.kind === 'bind') {
      unresolved.push({
        id: node.id,
        kind: `${node.kind}($bind)`,
        reason: `需接线数据源：${reference.target}`,
      })
      return `<span v-text="${binding(`${node.id}.text`, 'string')}" />`
    }
    return `<span v-text="${expression(reference?.kind === 'mock' ? reference.value : (value ?? ''))}" />`
  }
  const render = (node: AxNode): string => {
    counts.nodes += 1
    if (node.kind === 'component') {
      counts.components += 1
      const name = typeof node.name === 'string' ? node.name : ''
      const detail = options.componentDetails?.[name]
      const info = options.componentImports?.[name]
      if (
        !detail ||
        !info ||
        detail.summary.framework !== 'vue' ||
        info.imported !== 'default'
      ) {
        unresolved.push({
          id: node.id,
          kind: 'component',
          reason: `${name} 缺少 Vue SFC default 导出契约`,
        })
        return ''
      }
      imports.set(name, `import ${name} from ${literalOf(info.from)}`)
      const resolved = resolveComponentProps(
        detail.summary.kind,
        componentFixtureOf(detail.fixtures, node.fixture),
        node.props,
        node.variant,
      )
      const attributes: string[] = []
      for (const [key, value] of Object.entries(resolved)) {
        const reference = designBindingOf(node.props?.[key])
        if (reference?.kind === 'bind') {
          unresolved.push({
            id: `${node.id}.${key}`,
            kind: 'component($bind)',
            reason: `需接线数据源：${reference.target}`,
          })
          attributes.push(
            `:${key}="${binding(`${node.id}.${key}`, `InstanceType<typeof ${name}>['$props'][${literalOf(key)}]`)}"`,
          )
        } else attributes.push(`:${key}="${expression(value)}"`)
      }
      for (const key of detail.statics) {
        if (Object.hasOwn(resolved, key)) continue
        attributes.push(
          `:${key}="${binding(`${node.id}.${key}`, `NonNullable<InstanceType<typeof ${name}>['$props'][${literalOf(key)}]>`)}"`,
        )
        unresolved.push({
          id: `${node.id}.${key}`,
          kind: 'component(callback)',
          reason: `需接线回调或事件：${name}.${key}`,
        })
      }
      for (const field of detail.summary.props) {
        if (!field.required || Object.hasOwn(resolved, field.name)) continue
        attributes.push(
          `:${field.name}="${binding(`${node.id}.${field.name}`, `InstanceType<typeof ${name}>['$props'][${literalOf(field.name)}]`)}"`,
        )
        unresolved.push({
          id: `${node.id}.${field.name}`,
          kind: 'component(prop)',
          reason: `缺少必填属性：${name}.${field.name}`,
        })
      }
      if (detail.summary.kind === 'store-bound')
        unresolved.push({
          id: node.id,
          kind: 'component(store)',
          reason: '需要接线真实状态或展示包装',
        })
      // 插槽（1.5）：详单 slots 契约存在时直译为 default template；无契约仍记
      // unresolved，不静默丢内容（既有目录 defaultSlot 布尔继续兜底）。
      const slotNodes = node.slot ?? node.children ?? []
      const hasSlot = detail?.slots?.default !== undefined || detail?.summary.defaultSlot === true
      if (slotNodes.length > 0 && !hasSlot)
        unresolved.push({
          id: node.id,
          kind: 'component(slot)',
          reason: '插槽尚无实现契约',
        })
      const tag = `${name}${attributes.length ? ` ${attributes.join(' ')}` : ''}`
      if (hasSlot)
        return `<${tag}><template #default>${slotNodes.map(render).join('\n')}</template></${name}>`
      return `<${tag} />`
    }
    counts.primitives += 1
    const children = () => (node.children ?? []).map(render).join('\n')
    const style: Record<string, string> = {}
    const width = sizeOf(node.width)
    const height = sizeOf(node.height)
    if (width) style.width = width
    if (height) style.height = height
    if (node.kind === 'overlay') {
      const content = `<div${styleAttribute(positionStyleOf(node))}>${children()}</div>`
      if (!node.scrim) return content
      const paint = paintOf(node.scrim.fill)
      return `<div${styleAttribute({ position: 'absolute', inset: '0', ...(paint ? { [paint.key]: paint.css } : {}) })}>${content}</div>`
    }
    if (node.kind === 'part') {
      const spec = axPartSpecOf(node.part)
      if (!spec || node.icon || node.supporting !== undefined) {
        unresolved.push({
          id: node.id,
          kind: 'part',
          reason: '此部件包含尚未适配的图标或辅助内容，请使用项目 Vue 组件',
        })
        return ''
      }
      if (node.state)
        unresolved.push({
          id: `${node.id}.state`,
          kind: 'part(state)',
          reason: `状态语义需接线：${node.state}`,
        })
      return `<${spec.element} class="${attribute(axPartClassNames(spec, node.variant).join(' '))}">${node.label !== undefined ? text(node.label, node) : ''}</${spec.element}>`
    }
    if (node.kind === 'frame') {
      style.display = 'flex'
      style.flexDirection = node.layout === 'vertical' ? 'column' : 'row'
      if (node.gap !== undefined)
        style.gap =
          typeof node.gap === 'number' ? `${node.gap}px` : cssValueOf(node.gap)
      if (node.padding)
        style.padding = node.padding
          .map((value) =>
            typeof value === 'number' ? `${value}px` : cssValueOf(value),
          )
          .join(' ')
      if (node.justifyContent) style.justifyContent = node.justifyContent
      if (node.alignItems) style.alignItems = node.alignItems
      if (node.clip) style.overflow = 'hidden'
    }
    const paint = paintOf(node.fill)
    if (paint) style[paint.key] = paint.css
    if (node.shadow) style.boxShadow = boxShadowOf(node.shadow)
    if (typeof node.cornerRadius === 'number')
      style.borderRadius = `${node.cornerRadius}px`
    if (node.kind === 'text') {
      if (paint) {
        delete style[paint.key]
        style.color = paint.css
      }
      if (node.fontSize !== undefined)
        style.fontSize =
          typeof node.fontSize === 'number'
            ? `${node.fontSize}px`
            : cssValueOf(node.fontSize)
      if (node.fontWeight !== undefined)
        style.fontWeight =
          typeof node.fontWeight === 'number'
            ? String(node.fontWeight)
            : cssValueOf(node.fontWeight)
      if (node.fontFamily) style.fontFamily = cssValueOf(node.fontFamily)
      if (node.lineHeight)
        style.lineHeight =
          node.lineHeight.unit === 'px'
            ? `${node.lineHeight.value}px`
            : String(node.lineHeight.value)
      if (node.textAlign) style.textAlign = node.textAlign
      if (node.letterSpacing !== undefined)
        style.letterSpacing =
          typeof node.letterSpacing === 'number'
            ? `${node.letterSpacing}px`
            : cssValueOf(node.letterSpacing)
      style.whiteSpace = node.wrap === 'nowrap' ? 'nowrap' : 'pre-wrap'
      return `<div${styleAttribute(style)}>${text(node.text, node)}</div>`
    }
    if (node.kind === 'frame')
      return `<div${styleAttribute(style)}>${children()}</div>`
    if (node.kind === 'rect' || node.kind === 'ellipse') {
      if (node.kind === 'ellipse') style.borderRadius = '50%'
      if (typeof node.stroke === 'string')
        style.border = `1px solid ${cssValueOf(node.stroke)}`
      return `<div${styleAttribute(style)} />`
    }
    if (node.kind === 'image')
      return `<img src="${attribute(node.asset ?? '')}" alt=""${styleAttribute(style)} />`
    if (node.kind === 'path')
      return `<svg${node.viewBox ? ` viewBox="${node.viewBox.join(' ')}"` : ''}${styleAttribute(style)}><path d="${attribute(node.geometry ?? '')}" fill="${attribute(typeof node.fill === 'string' ? cssValueOf(node.fill) : 'none')}" /></svg>`
    unresolved.push({
      id: node.id,
      kind: node.kind,
      reason: '尚无 Vue 映射，请使用项目组件',
    })
    return ''
  }
  const body = renderTree.map(render).join('\n')
  const style: Record<string, string> = {
    position: 'relative',
    minWidth: '0',
    display: 'flex',
    flexDirection: page.layout === 'vertical' ? 'column' : 'row',
    background: cssValueOf(page.background ?? '$bg-main'),
  }
  if (options.layout === 'reference') {
    if (page.width !== undefined) style.width = `${page.width}px`
    if (page.height !== undefined) style.height = `${page.height}px`
  } else {
    style.width = '100%'
    style.minHeight = '100%'
  }
  if (page.gap !== undefined)
    style.gap =
      typeof page.gap === 'number' ? `${page.gap}px` : cssValueOf(page.gap)
  if (page.padding)
    style.padding = page.padding
      .map((value) =>
        typeof value === 'number' ? `${value}px` : cssValueOf(value),
      )
      .join(' ')
  const code = `<script setup lang="ts">\n${[...imports.values()].join('\n')}\n${bindings.size ? `interface ${componentName}Bindings {\n${[...bindings].map(([key, type]) => `  ${literalOf(key)}: ${type}`).join('\n')}\n}\nconst { bindings } = defineProps<{ bindings: ${componentName}Bindings }>()\n` : ''}</script>\n\n<template>\n  <div${styleAttribute(style)}>\n${body}\n  </div>\n</template>\n`
  return {
    code: code.replace(/<\/script(?!>\n\n<template>)/gi, '<\\/script'),
    componentName,
    unresolved,
    counts,
  }
}
