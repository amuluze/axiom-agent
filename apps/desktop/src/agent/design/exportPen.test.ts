/**
 * `.ax → .pen` 反向导出测试（overlay scrim 口径，docs/ax-format.md §3.4 1.2）。
 *
 * `.pen` 没有遮罩语义：scrim 导出为「铺满父级的绝对定位帧 + 内容帧」的等价几何；
 * 父级无尺寸时省略遮罩并记 warning（不发明遮罩边界，与投影期降级同口径）。
 * 往返（导入 → 导出）的整体结构等价用例见 importPen.test.ts（依赖真实存量稿）。
 */
import { describe, expect, it } from 'vitest'
import { parseAxDocument } from './axParser'
import type { AxDocument } from './axSchema'
import { exportAxToPenDocument } from './exportPen'

type PenRaw = Record<string, unknown>

const exportTree = (tree: unknown[], page: Record<string, unknown> = {}): { raw: PenRaw; warnings: string[] } => {
  const source = JSON.stringify({
    ax: '1.2',
    tokens: {},
    components: {},
    pages: [{ id: 'p1', name: 'Modal', width: 800, height: 600, tree, ...page }],
  })
  const parsed = parseAxDocument(source).document as AxDocument
  const result = exportAxToPenDocument(parsed)
  const root = JSON.parse(result.json) as { children: PenRaw[] }
  // 页根是容器帧（页节点包一层），它的 children[0] 即树的首个投影节点。
  const pageFrame = root.children[0] as PenRaw | undefined
  const projected = (pageFrame?.children ?? []) as PenRaw[]
  return { raw: projected[0] ?? {}, warnings: result.warnings }
}

describe('exportAxToPenDocument：overlay scrim', () => {
  const overlayNode = {
    id: 'o1', kind: 'overlay', anchor: 'center', scrim: { fill: 'rgba(0, 0, 0, 0.5)' },
    children: [{ id: 'd1', kind: 'frame', width: 320, height: 200, fill: '#ffffff', children: [] }],
  }

  it('scrim 导出为铺满父级的遮罩帧 + 内容帧（内容帧锚点反解为左上角坐标）', () => {
    const { raw, warnings } = exportTree([overlayNode])
    expect(warnings).toEqual([])
    expect(raw).toMatchObject({
      type: 'frame', id: 'o1~scrim', layoutPosition: 'absolute', x: 0, y: 0,
      width: 800, height: 600, fill: 'rgba(0, 0, 0, 0.5)', clip: true,
    })
    const content = ((raw.children ?? []) as PenRaw[])[0]
    // center 锚点反解：(800−320)/2、(600−200)/2。
    expect(content).toMatchObject({ id: 'd1', layoutPosition: 'absolute', x: 240, y: 200 })
  })

  it('父级无尺寸时 scrim 省略并记 warning（不发明遮罩边界）', () => {
    const { raw, warnings } = exportTree([overlayNode], { width: undefined, height: undefined })
    // 无 scrim：树的首节点就是内容帧本身（带锚点反解坐标）。
    expect(raw).toMatchObject({ id: 'd1', layoutPosition: 'absolute' })
    expect(raw.children).toEqual([])
    expect(warnings.some((warning) => warning.includes('scrim'))).toBe(true)
  })
})

describe('exportAxToPenDocument：shadow（1.3 外阴影）', () => {
  it('shadow 导出为 .pen 的 effect 形态，且经 penParser 读回与视图模型等价（往返零损）', async () => {
    const { parsePenDocument } = await import('./penParser')
    const { raw, warnings } = exportTree([{
      id: 'c1', kind: 'frame', width: 320, height: 200, fill: '#ffffff',
      shadow: { color: '$shadow-color', offsetX: 0, offsetY: 4, blur: 12 },
      children: [],
    }])
    expect(warnings).toEqual([])
    // .pen 形态：penParser 的 normalizeShadow 读 color/offset.{x,y}/blur。
    expect(raw.effect).toEqual({ color: '$shadow-color', offset: { x: 0, y: 4 }, blur: 12 })
    // 读回：投影出的 PenShadow 与 .ax 投影同形（color 原样、几何字段一致）。
    const reparsed = parsePenDocument(JSON.stringify({ children: [raw] }), 'a.pen')
    // 单顶层节点即页根：pages[0] 就是导出的帧本身。
    const frame = reparsed.document?.pages[0] as { shadow?: unknown } | undefined
    expect(frame?.shadow).toEqual({ color: '$shadow-color', x: 0, y: 4, blur: 12 })
  })
})
