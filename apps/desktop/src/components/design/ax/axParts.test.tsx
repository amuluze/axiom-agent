// @vitest-environment jsdom
/**
 * 部件词表与规范表测试（docs/ax-format.md §3.2 规则 9 / §4.1）：
 * ① 闭集校验：未知部件、非法变体、字段越界一律 fail-closed；
 * ② 映射真实：词表里每个类名都必须在样式表中存在（改名/删除即失败，防止映射静默失效）；
 * ③ 画布渲染：按词表映射到真实元素与类名（评审面不生成可交互控件）；
 * ④ 生成代码：同一映射直出真实元素标签（button 就是 button）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AX_PARTS } from '@/agent/design/axParts'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import type { AxDocument } from '@/agent/design/axSchema'
import { emitAxPageToTsx } from '@/agent/design/emitPage'
import PenNodeView from '../PenNodeView'
import type { PenNode, PenPartNode } from '@/agent/design/penParser'

const partDoc = (part: Record<string, unknown>) => JSON.stringify({
  ax: '1.0',
  tokens: {},
  pages: [{ id: 'p1', width: 400, height: 200, tree: [{ id: 'pt1', kind: 'part', ...part }] }],
})

const parsePart = (part: Record<string, unknown>) => parseAxDocument(partDoc(part))

describe('部件词表：闭集校验（fail-closed）', () => {
  it('未知部件报错并列出词表', () => {
    const result = parsePart({ part: 'ghostWidget', label: 'x' })
    expect(result.document).toBeNull()
    const message = result.diagnostics.find((item) => item.level === 'error')?.message ?? ''
    expect(message).toContain('未知部件')
    expect(message).toContain('statusTag')
  })

  it('非法变体报错并列出可用变体', () => {
    const result = parsePart({ part: 'actionButton', variant: 'huge', label: '发送' })
    const message = result.diagnostics.find((item) => item.level === 'error')?.message ?? ''
    expect(message).toContain('没有变体')
    expect(message).toContain('primary')
  })

  it('字段越界报错（divider 不接受 label）', () => {
    const result = parsePart({ part: 'divider', label: '不该有' })
    const message = result.diagnostics.find((item) => item.level === 'error')?.message ?? ''
    expect(message).toContain('不接受字段')
  })

  it('合法部件通过（含变体与允许字段）', () => {
    const result = parsePart({ part: 'actionButton', variant: 'primary', label: '发送', icon: 'send' })
    expect(result.error).toBeNull()
    expect(result.document).not.toBeNull()
  })
})

describe('部件规范表：类名必须真实存在', () => {
  const stylesDir = resolve(import.meta.dirname, '../../../styles')
  const css = readdirSync(stylesDir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(stylesDir, name), 'utf8'))
    .join('\n')

  it('每个基类与变体修饰符类都在样式表里有定义（防映射静默失效）', () => {
    const missing: string[] = []
    for (const [kind, spec] of Object.entries(AX_PARTS)) {
      const names = [spec.className, ...Object.values(spec.variantClass ?? {})]
      if (spec.textClassName) names.push(spec.textClassName)
      for (const name of names) {
        if (!new RegExp(`\\.${name}(?![a-zA-Z0-9_-])`).test(css)) missing.push(`${kind}: .${name}`)
      }
      // 每个非默认变体都必须有修饰符类，否则变体形同虚设。
      for (const variant of spec.variants.slice(1)) {
        if (!spec.variantClass?.[variant]) missing.push(`${kind}: 变体 ${variant} 缺修饰符类`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('部件渲染与生成：映射到真实实现', () => {
  const nodesOf = (part: Record<string, unknown>): PenPartNode => {
    const parsed = parseAxDocument(partDoc(part))
    const projection = projectAxToPenDocument(parsed.document as AxDocument, 'a.ax')
    return (projection.document.pages[0] as PenNode).children?.[0] as PenPartNode
  }

  it('画布按词表渲染：类名 + 文案 + 图标（非交互元素）', () => {
    const node = nodesOf({ part: 'actionButton', variant: 'primary', label: '发送', icon: 'send' })
    expect(node.type).toBe('part')
    const { container } = render(
      <PenNodeView node={node} document={{ fileName: 'a.ax', pages: [], components: {}, variables: {}, modeVariables: { light: {}, dark: {} }, diagnostics: [] }} themeMode="dark" />,
    )
    const element = container.querySelector('[data-pen-id="pt1"]')
    expect(element?.tagName).toBe('SPAN') // 画布内不生成可点的 button
    expect(element?.className).toBe('approval-card__button approval-card__button--primary')
    expect(element?.textContent).toContain('发送')
  })

  it('divider 渲染为无内容的分割元素', () => {
    const node = nodesOf({ part: 'divider' })
    const { container } = render(
      <PenNodeView node={node} document={{ fileName: 'a.ax', pages: [], components: {}, variables: {}, modeVariables: { light: {}, dark: {} }, diagnostics: [] }} themeMode="dark" />,
    )
    const element = container.querySelector('[data-pen-id="pt1"]')
    expect(element?.tagName).toBe('DIV')
    expect(element?.className).toBe('session__divider')
    expect(element?.textContent).toBe('')
  })

  it('生成代码用真实元素标签与类名（button 就是 button），不再进 unresolved', () => {
    const parsed = parseAxDocument(partDoc({ part: 'actionButton', variant: 'primary', label: '发送', icon: 'send' }))
    const emitted = emitAxPageToTsx(parsed.document as AxDocument, 'p1')!
    expect(emitted.code).toContain('<button className=\'approval-card__button approval-card__button--primary\'>')
    expect(emitted.code).toContain('<Send size={15} />')
    expect(emitted.code).toContain("import { Send } from 'lucide-react'")
    expect(emitted.unresolved.filter((item) => item.kind === 'part')).toEqual([])
  })
})
