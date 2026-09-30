// @vitest-environment node
/**
 * 发射器测试（docs/ax-format.md §4.7 P5 验收）：
 * ① 组件恒等映射（含导入来源与 props）；② 绑定值不产出未定义标识符；
 * ③ 原语 → CSS 变量映射（含锚点直译成 right/bottom）；④ 无法映射的显式进 unresolved；
 * ⑤ **生成物必须能被 TypeScript 解析**（P5 验收「生成代码通过 typecheck」的可执行版本）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseAxDocument } from './axParser'
import type { AxDocument } from './axSchema'
import { parsePenDocument } from './penParser'
import { emitAxPageToTsx, escapeJsxText, literalOf } from './emitPage'
import { importPenDocument } from '@/agent/design/importPen'

const SOURCE = JSON.stringify({
  ax: '1.0',
  tokens: {
    'bg-main': { $type: 'color', $value: { light: '#F8F7F3', dark: '#161514' } },
    'text-md': { $type: 'dimension', $value: '13px' },
    'space-6': { $type: 'dimension', $value: '6px' },
  },
  components: { ApprovalCard: { props: { command: 'string', danger: 'boolean' } } },
  pages: [{
    id: 'p-session',
    name: '会话',
    width: 1180,
    height: 780,
    layout: 'horizontal',
    background: '$bg-main',
    tree: [
      { id: 'c1', kind: 'component', name: 'ApprovalCard',
        props: { command: { $mock: 'npm test' }, danger: false } },
      { id: 'f1', kind: 'frame', layout: 'vertical', gap: '$space-6', padding: [8, 12], children: [
        { id: 't1', kind: 'text', text: { $mock: '说明 <文本> {x}' }, wrap: 'width',
          fontSize: '$text-md', fill: '$text-md', lineHeight: { unit: 'multiplier', value: 1.5 } },
        { id: 't2', kind: 'text', text: { $bind: 'session.title' }, wrap: 'nowrap' },
        { id: 'i1', kind: 'icon', name: 'shield-alert', size: 15, fill: '$bg-main' },
        { id: 'e1', kind: 'ellipse', width: 16, height: 16, innerRadius: 0.58, fill: '$bg-main' },
        { id: 'pa1', kind: 'path', geometry: 'M0 0h8v8H0z', viewBox: [0, 0, 16, 16], fill: '$bg-main' },
        { id: 'im1', kind: 'image', asset: 'assets/logo.png', width: 24, height: 24 },
        { id: 'pt1', kind: 'part', part: 'actionButton', variant: 'primary', label: '发送' },
      ] },
      { id: 'o1', kind: 'overlay', anchor: 'bottom-right', offset: [-8, -12], children: [
        { id: 'c2', kind: 'component', name: 'ApprovalCard', props: { command: 'npm test' } },
      ] },
    ],
  }],
})

const document_ = parseAxDocument(SOURCE).document as AxDocument
const emit = (options = {}) => emitAxPageToTsx(document_, 'p-session', {
  componentImports: { ApprovalCard: { from: '@/components/session/ApprovalCard' } },
  ...options,
})

/** TypeScript 语法校验：生成的源码必须能被解析（等价于「生成代码通过 typecheck」的语法面）。 */
const syntaxErrorsOf = (code: string): string[] => {
  const sourceFile = ts.createSourceFile('Generated.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []
  return diagnostics.map((item) => JSON.stringify(item))
}

describe('emitAxPageToTsx：映射', () => {
  it('组件恒等映射：JSX 标签 + props（$mock 取字面量）+ 注册表导入来源', () => {
    const result = emit()!
    expect(result.code).toContain("import { ApprovalCard } from '@/components/session/ApprovalCard'")
    expect(result.code).toContain('<ApprovalCard command=\'npm test\' danger={false} />')
    expect(result.counts.components).toBe(2)
  })

  it('结构化 $mock 的 json 型 props 生成真实对象字面量（不是 JSON 字符串）', () => {
    const source = JSON.stringify({
      ax: '1.1',
      components: { ToolCallCard: { props: { toolName: 'string', call: 'json' } } },
      pages: [{ id: 'p', width: 400, height: 200, tree: [
        { id: 'c1', kind: 'component', name: 'ToolCallCard', props: {
          toolName: { $mock: 'read' },
          call: { $mock: { id: 't1', role: 'assistant', toolCalls: [{ id: 't1', name: 'read', arguments: { path: 'a.ts' } }] } },
        } },
      ] }],
    })
    const parsed = parseAxDocument(source).document as AxDocument
    const result = emitAxPageToTsx(parsed, 'p', {
      componentImports: { ToolCallCard: { from: '@/components/session/ToolCallCard' } },
    })!
    // 生成物里必须是对象字面量（写成 JSON 字符串会变成语法错，见下面的解析断言）。
    expect(result.code).toContain("toolName='read'")
    expect(result.code).toContain('call={{')
    expect(syntaxErrorsOf(result.code)).toEqual([])
  })

  it('shadow 直译：box-shadow（token color → var）；path 用 drop-shadow 跟随形状', () => {
    const source = JSON.stringify({
      ax: '1.2',
      tokens: { 'shadow-color': { $type: 'color', $value: 'rgba(0,0,0,0.18)' } },
      components: {},
      pages: [{ id: 'p', name: 'Cards', width: 800, height: 600, tree: [
        { id: 'c1', kind: 'frame', width: 320, height: 200, fill: '#ffffff',
          shadow: { color: '$shadow-color', offsetX: 0, offsetY: 4, blur: 12 }, children: [] },
        { id: 'mark', kind: 'path', geometry: 'M0 0h10v10z', viewBox: [0, 0, 10, 10],
          shadow: { color: '#000000', offsetX: 2, offsetY: 2, blur: 4 } },
      ] }],
    })
    const parsed = parseAxDocument(source).document as AxDocument
    const result = emitAxPageToTsx(parsed, 'p')!
    expect(result.code).toContain("boxShadow: '0px 4px 12px var(--shadow-color)'")
    // path 的阴影走 filter drop-shadow（box-shadow 对 svg 是矩形盒，不跟随路径形状）。
    expect(result.code).toContain("filter: 'drop-shadow(2px 2px 4px #000000)'")
    expect(syntaxErrorsOf(result.code)).toEqual([])
  })

  it('$bind 不产出未定义标识符：注释说明接线点 + 占位文本 + 进 unresolved', () => {
    const result = emit()!
    expect(result.code).toContain('{/* $bind: session.title */}session.title')
    expect(result.unresolved.some((item) => item.reason.includes('session.title'))).toBe(true)
  })

  it('原语 → CSS：flex/token 变量/字色/图标/圆形/路径/图片', () => {
    const { code } = emit()!
    expect(code).toContain("display: 'flex'")
    expect(code).toContain("flexDirection: 'column'")
    expect(code).toContain("gap: 'var(--space-6)'")
    expect(code).toContain("padding: '8px 12px'")
    expect(code).toContain("color: 'var(--text-md)'")
    expect(code).toContain("whiteSpace: 'pre-wrap'")
    expect(code).toContain('<ShieldAlert size={15}')
    expect(code).toContain("import { ShieldAlert } from 'lucide-react'")
    expect(code).toContain("borderRadius: '50%'")
    expect(code).toContain('<path d=\'M0 0h8v8H0z\'')
    expect(code).toContain('<img src=\'assets/logo.png\'')
  })

  it('overlay 锚点直译成 CSS 定位（right/bottom，而不是像素 left/top）', () => {
    const { code } = emit()!
    expect(code).toContain("position: 'absolute'")
    expect(code).toContain("right: '8px'")
    expect(code).toContain("bottom: '12px'")
    expect(code).not.toContain('left: 1052')
  })

  it('overlay 的 scrim 直译为 inset 遮罩层（backdrop + 锚点内容层）', () => {
    const source = JSON.stringify({
      ax: '1.2',
      tokens: {},
      components: {},
      pages: [{ id: 'p', name: 'Modal', width: 800, height: 600, tree: [
        { id: 'o1', kind: 'overlay', anchor: 'center', scrim: { fill: 'rgba(0, 0, 0, 0.5)' }, children: [
          { id: 'd1', kind: 'frame', width: 320, height: 200, fill: '#ffffff', children: [] },
        ] },
      ] }],
    })
    const parsed = parseAxDocument(source).document as AxDocument
    const result = emitAxPageToTsx(parsed, 'p')!
    // 遮罩层铺满定位父级（inset: 0），内容层按锚点定位其上（正中 = 50% + translate）。
    expect(result.code).toContain("position: 'absolute', inset: '0'")
    expect(result.code).toContain("background: 'rgba(0, 0, 0, 0.5)'")
    expect(result.code).toContain("left: '50%'")
    expect(result.code).toContain('translateX(-50%)')
    expect(syntaxErrorsOf(result.code)).toEqual([])
  })

  it('anchor: center（单词锚点）直译为正中定位（曾错误地落到右对齐分支）', () => {
    const source = JSON.stringify({
      ax: '1.2',
      tokens: {},
      components: {},
      pages: [{ id: 'p', width: 800, height: 600, tree: [
        { id: 'o1', kind: 'overlay', anchor: 'center', children: [
          { id: 'd1', kind: 'frame', width: 320, height: 200, children: [] },
        ] },
      ] }],
    })
    const parsed = parseAxDocument(source).document as AxDocument
    const result = emitAxPageToTsx(parsed, 'p')!
    expect(result.code).toContain("left: '50%'")
    expect(result.code).toContain("top: '50%'")
    expect(result.code).not.toContain("right:")
    expect(syntaxErrorsOf(result.code)).toEqual([])
  })

  it('部件（part）按词表映射到真实元素与类名（不是 unresolved）', () => {
    const { code, unresolved } = emit()!
    expect(code).toContain("className='approval-card__button approval-card__button--primary'")
    expect(unresolved.filter((item) => item.kind === 'part')).toEqual([])
  })

  it('缺导入来源的组件也显式记进 unresolved', () => {
    const { unresolved } = emit({ componentImports: {} })!
    expect(unresolved.some((item) => item.reason.includes('缺少 ApprovalCard 的导入来源'))).toBe(true)
  })

  it('转义：文本里的尖括号与花括号不破坏 JSX；字面量转义引号与换行', () => {
    const { code } = emit()!
    expect(code).toContain('说明 &lt;文本&gt; &#123;x&#125;')
    expect(escapeJsxText('a<b>{c}')).toBe('a&lt;b&gt;&#123;c&#125;')
    expect(literalOf("it's\nnew")).toBe("'it\\'s\\nnew'")
  })
})

describe('emitAxPageToTsx：语法有效性', () => {
  it('生成物通过 TypeScript 解析（无语法诊断）', () => {
    expect(syntaxErrorsOf(emit()!.code)).toEqual([])
  })

  it('端到端：真实 .pen → .ax → 发射，仍然语法有效且无未解释的 unresolved 类型', () => {
    const penPath = resolve(import.meta.dirname, '../../../../..', '.pen/axiom.pen')
    if (!existsSync(penPath)) return
    const parsed = parsePenDocument(readFileSync(penPath, 'utf8'), 'axiom.pen')
    const imported = importPenDocument(parsed.document!, 'axiom')
    const emitted = emitAxPageToTsx(imported.document, 1)!
    expect(emitted.code).toContain('export const')
    expect(syntaxErrorsOf(emitted.code)).toEqual([])
    // 导入产物只含 primitive：unresolved 里不应出现「尚无映射」（那种节点不该被发出去）。
    expect(emitted.unresolved.filter((item) => item.reason === '尚无映射')).toEqual([])
  })
})
