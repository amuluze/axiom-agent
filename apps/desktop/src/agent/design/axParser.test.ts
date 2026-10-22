/**
 * `.ax` 契约测试（docs/ax-format.md §3.3 九条硬规则 + §3.4 版本契约 + 幂等序列化 + 画布投影）。
 *
 * 这些用例是「把还原失败前移到设计阶段」的强制手段：规则破了必须**加载失败**，
 * 不允许静默降级——所以断言重点在「有没有报错」与「错误是否带节点路径」。
 */
import { describe, expect, it } from 'vitest'
import {
  absoluteOriginOf,
  anchorPlacementOf,
  expandSymbolInstances,
  parseAxDocument,
  projectAxToPenDocument,
  serializeAxDocument,
} from './axParser'
import { AX_FORMAT_VERSION, AX_PAGE_KEYS, AX_SYMBOL_ID_SEP } from './axSchema'
import type { AxDocument } from './axSchema'
import type { DesignComponentSummary } from './componentInventoryHost'
import type { PenNode } from './penParser'

/** 投影结果的页子节点（投影产出 PenDocument，页根是 PenNode）。 */
const childrenOfFirstPage = (document: { pages: unknown[] }): PenNode[] =>
  ((document.pages[0] as PenNode).children ?? []) as PenNode[]

const doc = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  ax: '1.0',
  tokens: {
    'bg-main': { $type: 'color', $value: { light: '#F8F7F3', dark: '#161514' } },
    'text-md': { $type: 'dimension', $value: '13px' },
    'space-6': { $type: 'dimension', $value: '6px' },
  },
  components: { ApprovalCard: { props: { command: 'string', danger: 'boolean' } } },
  pages: [{
    id: 'p1',
    name: '会话',
    width: 1180,
    height: 780,
    background: '$bg-main',
    tree: [{ id: 'n1', kind: 'frame', layout: 'vertical', gap: '$space-6', children: [] }],
  }],
  ...overrides,
})

const errorsOf = (source: string): string[] => {
  const result = parseAxDocument(source)
  return result.diagnostics.filter((item) => item.level === 'error').map((item) => item.message)
}

describe('parseAxDocument：版本契约', () => {
  it('缺少或无法解析版本头即拒绝', () => {
    expect(parseAxDocument('{}', {}).error).toMatch(/ax/)
    expect(parseAxDocument(JSON.stringify({ ax: 'v1' }), {}).error).toMatch(/无法解析格式版本/)
    expect(parseAxDocument('not json', {}).error).toMatch(/JSON 解析失败/)
  })

  it('格式主版本高于支持版本时 fail-closed（不降级渲染）', () => {
    const { document, error } = parseAxDocument(doc({ ax: '2.0' }))
    expect(document).toBeNull()
    expect(error).toMatch(/高于本版本支持/)
  })

  it('旧版本无迁移路径时拒绝', () => {
    const { document, error } = parseAxDocument(doc({ ax: '0.9' }))
    expect(document).toBeNull()
    // 版本号从契约常量取：改格式版本时不必回来改用例（迁移路径的**语义**才是被测对象）。
    expect(error).toMatch(new RegExp(`没有到 v${AX_FORMAT_VERSION.replace('.', '\\.')} 的迁移路径`))
  })
})

describe('硬规则 1：组件必须来自词汇表', () => {
  it('未声明组件即报错（带节点路径）', () => {
    const result = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [{ id: 'c1', kind: 'component', name: 'Ghost' }] }],
    }))
    expect(result.document).toBeNull()
    expect(result.diagnostics.some((item) => item.level === 'error' && item.path === 'pages[0].tree[0]')).toBe(true)
    expect(errorsOf(doc({ pages: [{ id: 'p1', tree: [{ id: 'c1', kind: 'component', name: 'Ghost' }] }] }))[0]).toMatch(/未在本稿/)
  })

  it('未声明的 variant 与 props 键分别报错', () => {
    const badVariant = errorsOf(doc({
      components: { ApprovalCard: { variant: ['compact'], props: { command: 'string' } } },
      pages: [{ id: 'p1', tree: [{ id: 'c1', kind: 'component', name: 'ApprovalCard', variant: 'wide' }] }],
    }))
    expect(badVariant.join()).toMatch(/没有变体/)
    const badProp = errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 'c1', kind: 'component', name: 'ApprovalCard', props: { nope: 'x' } }] }],
    }))
    expect(badProp.join()).toMatch(/没有 props/)
  })
})

describe('硬规则 2：数据与 mock 显式区分', () => {
  it('接受字符串、$mock、$bind；拒绝其它形态', () => {
    const ok = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [
        { id: 't1', kind: 'text', text: '字面量', wrap: 'nowrap' },
        { id: 't2', kind: 'text', text: { $mock: '展示文案' }, wrap: 'nowrap' },
        { id: 't3', kind: 'text', text: { $bind: 'session.title' }, wrap: 'nowrap' },
      ] }],
    }))
    expect(ok.error).toBeNull()
    expect(ok.document).not.toBeNull()
    const bad = errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 't1', kind: 'text', text: { $mock: 'a', $bind: 'b' }, wrap: 'nowrap' }] }],
    }))
    expect(bad.join()).toMatch(/\$mock/)
  })

  it('组件 props 接受结构化 $mock（json 型 props 用对象/数组），文案节点仍是字符串专用', () => {
    const structured = parseAxDocument(doc({
      components: { ResultChip: { props: { message: 'json' } } },
      pages: [{ id: 'p1', tree: [
        {
          id: 'c1',
          kind: 'component',
          name: 'ResultChip',
          props: { message: { $mock: { id: 'm1', role: 'assistant', content: '文案', toolCalls: [] } } },
        },
      ] }],
    }))
    expect(structured.error).toBeNull()
    expect(structured.document).not.toBeNull()
    // 文案位置上的结构化 mock 会渲染成空串（静默丢整段文案）→ 校验期 fail-closed。
    const textWithObject = errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 't1', kind: 'text', text: { $mock: { content: '文案' } }, wrap: 'nowrap' }] }],
    }))
    expect(textWithObject.join()).toMatch(/文案必须是字符串/)
  })
})

describe('硬规则 3：状态与分组显式', () => {
  it('page.state 必须是字符串映射', () => {
    expect(errorsOf(doc({ pages: [{ id: 'p1', state: { run: 1 }, tree: [] }] })).join()).toMatch(/state/)
    const ok = parseAxDocument(doc({ pages: [{ id: 'p1', group: 'session', state: { run: 'running' }, tree: [] }] }))
    expect(ok.error).toBeNull()
  })
})

describe('硬规则 4 与 9：布局流式、度量与坐标不进设计稿', () => {
  it('普通节点写 x/y 即报错（未知字段）', () => {
    const errors = errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 'f1', kind: 'frame', x: 10, y: 20, children: [] }] }],
    }))
    expect(errors.join()).toMatch(/不认识的字段 `x`/)
  })

  it('overlay 是唯一允许定位的节点（anchor + offset）', () => {
    const ok = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [{ id: 'o1', kind: 'overlay', anchor: 'bottom-right', offset: [8, 8], children: [] }] }],
    }))
    expect(ok.error).toBeNull()
    expect(errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 'o1', kind: 'overlay', anchor: 'nowhere', children: [] }] }],
    })).join()).toMatch(/anchor/)
  })

  it('part 不允许写度量（width/padding/cornerRadius 都在允许键集之外）', () => {
    for (const [field, value] of [['width', 100], ['padding', [8]], ['cornerRadius', 8]] as const) {
      const errors = errorsOf(doc({
        pages: [{ id: 'p1', tree: [{ id: 'pt1', kind: 'part', part: 'actionButton', [field as string]: value }] }],
      }))
      expect(errors.join()).toMatch(new RegExp(`不认识的字段 \`${field}\``))
    }
    // 只写语义则通过
    const ok = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [{ id: 'pt1', kind: 'part', part: 'actionButton', variant: 'primary', label: '发送' }] }],
    }))
    expect(ok.error).toBeNull()
  })
})

describe('硬规则 5：单位显式', () => {
  it('dimension token 不带单位即报错（裸数值与裸字符串两条路径都给出可执行提示）', () => {
    // 数值与字符串形态都要落到同一条错误上：CSS 里 `var(--text-md)` = `13` 是无效声明。
    for (const value of [13, '13']) {
      const errors = errorsOf(doc({ tokens: { 'text-md': { $type: 'dimension', $value: value } } }))
      expect(errors.join()).toMatch(/必须带单位/)
    }
    // 两档写法同样受约束
    const both = errorsOf(doc({ tokens: { 'text-md': { $type: 'dimension', $value: { light: '13px', dark: 13 } } } }))
    expect(both.join()).toMatch(/必须带单位/)
    // 带单位的数值型 token 通过（归一为字符串）。此处用最小文档，
    // 避免基础 fixture 的页引用 `$bg-main`/`$space-6` 而被覆盖掉 tokens 后报未声明。
    const ok = parseAxDocument(JSON.stringify({
      ax: '1.0',
      tokens: { 'radius-8': { $type: 'dimension', $value: '8px' } },
      pages: [{ id: 'p1', tree: [] }],
    }))
    expect(ok.error).toBeNull()
    expect(ok.document?.tokens['radius-8']).toEqual({ $type: 'dimension', $value: '8px' })
  })

  it('lineHeight 必须显式声明单位语义', () => {
    expect(errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 't1', kind: 'text', text: 'a', wrap: 'nowrap', lineHeight: 1.5 }] }],
    })).join()).toMatch(/lineHeight 必须是/)
    const ok = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [
        { id: 't1', kind: 'text', text: 'a', wrap: 'nowrap', lineHeight: { unit: 'multiplier', value: 1.5 } },
        { id: 't2', kind: 'text', text: 'b', wrap: 'nowrap', lineHeight: { unit: 'px', value: 20 } },
      ] }],
    }))
    expect(ok.error).toBeNull()
  })
})

describe('硬规则 6：无隐式默认歧义', () => {
  it('text 必须显式声明 wrap', () => {
    expect(errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 't1', kind: 'text', text: 'a' }] }],
    })).join()).toMatch(/wrap 必须显式声明/)
  })

  it('尺寸不接受带兜底参数的变体写法', () => {
    const errors = errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 'f1', kind: 'frame', width: 'fill_container(840)', children: [] }] }],
    }))
    expect(errors.join()).toMatch(/尺寸只接受/)
  })

  it('尺寸三态与 token 引用通过', () => {
    const ok = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [{ id: 'f1', kind: 'frame', width: 'fill_container', height: '$space-6', children: [] }] }],
    }))
    expect(ok.error).toBeNull()
  })
})

describe('硬规则 7/8：token 引用与 id 唯一性', () => {
  it('引用未声明 token 报错（渲染期不会静默变空）', () => {
    const errors = errorsOf(doc({
      pages: [{ id: 'p1', background: '$nope', tree: [] }],
    }))
    expect(errors.join()).toMatch(/未声明的 token/)
  })

  it('重复节点 id 与重复页 id 报错', () => {
    expect(errorsOf(doc({
      pages: [{ id: 'p1', tree: [
        { id: 'dup', kind: 'frame', children: [] },
        { id: 'dup', kind: 'frame', children: [] },
      ] }],
    })).join()).toMatch(/重复/)
    expect(errorsOf(doc({
      pages: [
        { id: 'p1', tree: [] },
        { id: 'p1', tree: [] },
      ],
    })).join()).toMatch(/页 id .* 重复/)
  })

  it('未知节点种类报错（闭集，不再降级占位）', () => {
    expect(errorsOf(doc({
      pages: [{ id: 'p1', tree: [{ id: 'x1', kind: 'vector', geometry: 'M0 0' }] }],
    })).join()).toMatch(/未知节点种类/)
  })
})

describe('幂等序列化', () => {
  it('页级 layout/gap/padding 进序列化产物（漏写会让写盘稿塌成默认横向布局）', () => {
    const parsed = parseAxDocument(doc({
      pages: [{
        id: 'p1',
        name: '官网首页',
        layout: 'vertical',
        gap: 24,
        padding: [0, 32],
        width: 1440,
        height: 900,
        tree: [{ id: 'n1', kind: 'frame', layout: 'vertical', children: [] }],
      }],
    }))
    expect(parsed.error).toBeNull()
    const first = serializeAxDocument(parsed.document as AxDocument)
    const page = JSON.parse(first).pages[0] as Record<string, unknown>
    expect(page.layout).toBe('vertical')
    expect(page.gap).toBe(24)
    expect(page.padding).toEqual([0, 32])
    // 幂等：往返后仍在，且二次序列化字节一致
    expect(serializeAxDocument(parseAxDocument(first).document as AxDocument)).toBe(first)
  })

  it('parse → serialize → parse 等值，且两次 serialize 字节一致', () => {
    const parsed = parseAxDocument(doc({
      pages: [{
        id: 'p1',
        name: '会话',
        group: 'session',
        state: { run: 'running' },
        width: 1180,
        height: 780,
        background: '$bg-main',
        tree: [
          { id: 'n1', kind: 'part', part: 'bubble', label: { $mock: '解释这段改动' } },
          { id: 'n2', kind: 'frame', layout: 'vertical', gap: '$space-6', children: [
            { id: 'n3', kind: 'text', text: { $bind: 'session.title' }, wrap: 'width', fontSize: '$text-md' },
          ] },
        ],
      }],
    }))
    expect(parsed.error).toBeNull()
    const first = serializeAxDocument(parsed.document as AxDocument)
    const second = serializeAxDocument(parseAxDocument(first).document as AxDocument)
    expect(second).toBe(first)
    expect(first.endsWith('\n')).toBe(true)
    // 键序稳定：id 在 kind 之前，children 在末尾
    expect(first.indexOf('"id"')).toBeLessThan(first.indexOf('"kind"'))
    expect(first.indexOf('"children"')).toBeGreaterThan(first.indexOf('"gap"'))
  })

  it('页字段顺序恒等于 AX_PAGE_KEYS（顺序即字节契约，调整序列化实现须同步改这里）', () => {
    const parsed = parseAxDocument(doc({
      pages: [{
        id: 'p1',
        name: '顺序守卫',
        layout: 'vertical',
        gap: 8,
        padding: [12],
        group: 'session',
        state: { run: 'running' },
        width: 1180,
        height: 780,
        background: '$bg-main',
        tree: [{ id: 'n1', kind: 'text', text: { $mock: 'x' }, wrap: 'nowrap' }],
      }],
    }))
    expect(parsed.error).toBeNull()
    const page = JSON.parse(serializeAxDocument(parsed.document as AxDocument)).pages[0]
    // 全部页字段都在（漏字段会让写盘稿丢 layout/gap/padding），且顺序与白名单逐字一致。
    expect(Object.keys(page)).toEqual([...AX_PAGE_KEYS])
  })
})

describe('画布投影（P0：primitive 渲染，component/part 占位）', () => {
  it('token 投影为明暗两档自定义属性，页面尺寸与背景进入视图模型', () => {
    const parsed = parseAxDocument(doc())
    const { document, diagnostics } = projectAxToPenDocument(parsed.document as AxDocument, 'axiom.ax')
    expect(document.fileName).toBe('axiom.ax')
    expect(document.version).toBe(AX_FORMAT_VERSION)
    expect(document.modeVariables.dark['bg-main']).toBe('#161514')
    expect(document.modeVariables.light['bg-main']).toBe('#F8F7F3')
    const page = document.pages[0]
    expect(page).toMatchObject({ id: 'p1', width: 1180, height: 780 })
    expect(diagnostics).toHaveLength(0)
  })

  it('text 的 wrap 投影为既有 textGrowth 三态，$bind 显示为占位', () => {
    const parsed = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [
        { id: 't1', kind: 'text', text: { $bind: 'session.title' }, wrap: 'width' },
        { id: 't2', kind: 'text', text: '字面量', wrap: 'nowrap' },
      ] }],
    }))
    const nodes = childrenOfFirstPage(projectAxToPenDocument(parsed.document as AxDocument, 'a.ax').document)
    expect(nodes[0]).toMatchObject({ type: 'text', content: '{session.title}', textGrowth: 'fixed-width' })
    expect(nodes[1]).toMatchObject({ type: 'text', content: '字面量', textGrowth: 'auto' })
  })

  it('component / part 各自投影为视图模型节点（真组件与词表部件渲染，不再占位）', () => {
    const parsed = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [
        { id: 'c1', kind: 'component', name: 'ApprovalCard', fixture: 'pending-command',
          props: { command: 'npm test' } },
        { id: 'pt1', kind: 'part', part: 'actionButton', label: '发送' },
      ] }],
    }))
    const { document, diagnostics } = projectAxToPenDocument(parsed.document as AxDocument, 'a.ax')
    const nodes = childrenOfFirstPage(document)
    // 真组件渲染：投影保留组件名/props/fixture，由注册表在渲染期解析（宿主负责校验）。
    expect(nodes[0]).toMatchObject({
      type: 'component',
      id: 'c1',
      name: 'ApprovalCard',
      fixture: 'pending-command',
      props: { command: 'npm test' },
    })
    // 部件：按词表映射到真实元素与类名（见 axParts），因此不再有占位诊断。
    expect(nodes[1]).toMatchObject({ type: 'part', id: 'pt1', part: 'actionButton', label: '发送' })
    expect(diagnostics).toEqual([])
  })

  it('overlay 投影为绝对定位帧（offset → x/y），image 投影为图片填充', () => {
    const parsed = parseAxDocument(doc({
      pages: [{ id: 'p1', tree: [
        { id: 'o1', kind: 'overlay', anchor: 'bottom-right', offset: [8, 12], children: [] },
        { id: 'i1', kind: 'image', asset: 'assets/logo.png', mode: 'fit', width: 24, height: 24 },
      ] }],
    }))
    const nodes = childrenOfFirstPage(projectAxToPenDocument(parsed.document as AxDocument, 'a.ax').document)
    expect(nodes[0]).toMatchObject({ type: 'frame', layoutPosition: 'absolute', x: 8, y: 12 })
    expect(nodes[1]).toMatchObject({ type: 'rectangle', fill: { kind: 'image', url: 'assets/logo.png', mode: 'fit' } })
  })
})

describe('overlay scrim（1.2 遮罩语义）', () => {
  const scrimDoc = (tree: unknown[], overrides: Record<string, unknown> = {}): string => JSON.stringify({
    ax: '1.2',
    tokens: {},
    components: {},
    pages: [{ id: 'p1', width: 400, height: 300, tree, ...overrides }],
  })

  const overlayNode = {
    id: 'o1', kind: 'overlay', anchor: 'center', scrim: { fill: 'rgba(0, 0, 0, 0.5)' },
    children: [{ id: 'd1', kind: 'frame', width: 320, height: 200, fill: '#ffffff', children: [] }],
  }

  it('合法 scrim 通过校验；1.1 旧稿经单跳迁移加载为当前版本', () => {
    const legacy = JSON.stringify({
      ax: '1.1', tokens: {}, components: {},
      pages: [{ id: 'p1', width: 400, height: 300, tree: [overlayNode] }],
    })
    const migrated = parseAxDocument(legacy)
    expect(migrated.document).not.toBeNull()
    expect(migrated.document?.ax).toBe(AX_FORMAT_VERSION)
    expect(migrated.document?.pages[0]?.tree[0]?.scrim).toEqual({ fill: 'rgba(0, 0, 0, 0.5)' })

    const current = parseAxDocument(scrimDoc([overlayNode]))
    expect(current.document).not.toBeNull()
    expect(errorsOf(scrimDoc([overlayNode]))).toEqual([])
  })

  it('scrim 形状错误逐项报错（非对象 / 未知键 / 缺 fill / fill 非法）', () => {
    const diagnosticsOf = (scrim: unknown) => parseAxDocument(scrimDoc([
      { id: 'o1', kind: 'overlay', anchor: 'center', scrim, children: [] },
    ])).diagnostics.filter((item) => item.level === 'error')

    expect(diagnosticsOf('rgba(0,0,0,0.5)')[0]?.message).toMatch(/scrim 必须是对象/)
    // 未知键：path 落在 scrim 上、消息点名键名（键集白名单的统一口径）。
    const unknownKey = diagnosticsOf({ fill: '#000', blur: 4 })
    expect(unknownKey.some((item) => item.path === 'pages[0].tree[0].scrim' && item.message.includes('`blur`'))).toBe(true)
    expect(diagnosticsOf({})[0]?.message).toMatch(/scrim 缺少 `fill`/)
    // fill 形态非法：数值不是可接受的绘制值。
    expect(diagnosticsOf({ fill: 42 })[0]?.message).toMatch(/fill 必须是/)
  })

  it('非 overlay 节点写 scrim 即报错（键集白名单，遮罩只属于浮层）', () => {
    const diagnostics = parseAxDocument(scrimDoc([
      { id: 'f1', kind: 'frame', scrim: { fill: '#000' }, children: [] },
    ])).diagnostics.filter((item) => item.level === 'error')
    // 键集拒绝落在节点路径上，消息点名 `scrim`（checkKeys 的统一口径）。
    expect(diagnostics.some((item) => item.path === 'pages[0].tree[0]' && item.message.includes('`scrim`'))).toBe(true)
  })

  it('scrim 参与幂等序列化（parse → serialize → parse 等值）', () => {
    const parsed = parseAxDocument(scrimDoc([overlayNode]))
    expect(parsed.document).not.toBeNull()
    const once = serializeAxDocument(parsed.document as AxDocument)
    const twice = serializeAxDocument(parseAxDocument(once).document as AxDocument)
    expect(twice).toBe(once)
    expect(once).toContain('"scrim"')
  })

  it('投影：scrim → 铺满父级的遮罩帧（~scrim 后缀）+ 锚点内容帧（坐标相对父级不变）', () => {
    const parsed = parseAxDocument(scrimDoc([overlayNode]))
    const nodes = childrenOfFirstPage(projectAxToPenDocument(parsed.document as AxDocument, 'a.ax').document)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({
      type: 'frame', id: 'o1~scrim', layoutPosition: 'absolute', x: 0, y: 0,
      width: 400, height: 300, fill: { kind: 'solid', value: 'rgba(0, 0, 0, 0.5)' }, clip: true,
    })
    const inner = ((nodes[0] as PenNode).children ?? [])[0] as PenNode | undefined
    // center 锚点反解（与导入期 anchorPlacementOf 互逆）：(400−320)/2、(300−200)/2。
    expect(inner).toMatchObject({ id: 'o1', layoutPosition: 'absolute', x: 40, y: 50 })
  })

  it('投影：父级无可用尺寸时 scrim 降级为普通浮层并记诊断（不发明遮罩边界）', () => {
    const parsed = parseAxDocument(JSON.stringify({
      ax: '1.2', tokens: {}, components: {},
      pages: [{ id: 'p1', tree: [overlayNode] }],
    }))
    const projected = projectAxToPenDocument(parsed.document as AxDocument, 'a.ax')
    const nodes = childrenOfFirstPage(projected.document)
    expect(nodes[0]).toMatchObject({ id: 'o1', layoutPosition: 'absolute' })
    expect(projected.diagnostics.some((item) => item.level === 'warning' && item.message.includes('scrim'))).toBe(true)
  })

  it('锚点正中互逆：anchorPlacementOf 产出单词 `center`（闭集内），absoluteOriginOf 精确还原', () => {
    // 完全居中（±2px 容差内）：曾产出闭集外的 `center-center`，导入即被校验器拒绝。
    const placement = anchorPlacementOf({ x: 40, y: 50, width: 320, height: 200 }, { width: 400, height: 300 })
    expect(placement.anchor).toBe('center')
    expect(placement.offset).toEqual([0, 0])
    const origin = absoluteOriginOf(placement, { width: 400, height: 300 }, { width: 320, height: 200 })
    expect(origin).toEqual({ x: 40, y: 50 })
  })
})


describe('节点 shadow（1.3 外阴影）', () => {
  const shadowDoc = (tree: unknown[]): string => JSON.stringify({
    ax: '1.2',
    tokens: { 'shadow-color': { $type: 'color', $value: 'rgba(0,0,0,0.18)' } },
    components: {},
    pages: [{ id: 'p1', width: 400, height: 300, tree }],
  })
  const shadowNode = {
    id: 'f1', kind: 'frame', width: 320, height: 200,
    shadow: { color: '$shadow-color', offsetX: 0, offsetY: 4, blur: 12 },
    children: [],
  }

  it('合法 shadow 通过校验；1.2 旧稿经单跳迁移加载为当前版本', () => {
    const migrated = parseAxDocument(shadowDoc([shadowNode]))
    expect(migrated.document?.ax).toBe(AX_FORMAT_VERSION)
    expect(migrated.document?.pages[0]?.tree[0]?.shadow).toEqual({
      color: '$shadow-color', offsetX: 0, offsetY: 4, blur: 12,
    })
    expect(errorsOf(shadowDoc([shadowNode]))).toEqual([])
  })

  it('shadow 形状错误逐项报错（非对象 / 未知键 / 缺 color / 非数值偏移 / 负 blur）', () => {
    const diagnosticsOf = (shadow: unknown) => parseAxDocument(shadowDoc([
      { id: 'f1', kind: 'rect', width: 10, height: 10, shadow },
    ])).diagnostics.filter((item) => item.level === 'error')

    expect(diagnosticsOf('rgba(0,0,0,0.2)')[0]?.message).toMatch(/shadow 必须是对象/)
    // 未知键：消息点名键名（键集白名单的统一口径）。
    const unknownKey = diagnosticsOf({ color: '#000', offsetX: 0, offsetY: 0, blur: 4, spread: 2 })
    expect(unknownKey.some((item) => item.path === 'pages[0].tree[0].shadow' && item.message.includes('`spread`'))).toBe(true)
    expect(diagnosticsOf({ offsetX: 0, offsetY: 0, blur: 4 })[0]?.message).toMatch(/shadow 缺少 `color`/)
    expect(diagnosticsOf({ color: '#000', offsetX: '4px', offsetY: 0, blur: 4 })[0]?.message).toMatch(/offsetX 必须是数值/)
    expect(diagnosticsOf({ color: '#000', offsetX: 0, offsetY: 0, blur: -1 })[0]?.message).toMatch(/blur 不能为负/)
  })

  it('不在允许集的节点写 shadow 即报错（键集白名单：overlay/component/part 无阴影）', () => {
    const diagnostics = parseAxDocument(shadowDoc([
      { id: 'o1', kind: 'overlay', anchor: 'center', shadow: { color: '#000', offsetX: 0, offsetY: 0, blur: 4 }, children: [] },
    ])).diagnostics.filter((item) => item.level === 'error')
    expect(diagnostics.some((item) => item.path === 'pages[0].tree[0]' && item.message.includes('`shadow`'))).toBe(true)
  })

  it('shadow 参与幂等序列化（parse → serialize → parse 等值）', () => {
    const parsed = parseAxDocument(shadowDoc([shadowNode]))
    expect(parsed.document).not.toBeNull()
    const once = serializeAxDocument(parsed.document as AxDocument)
    const twice = serializeAxDocument(parseAxDocument(once).document as AxDocument)
    expect(twice).toBe(once)
    expect(once).toContain('"shadow"')
  })

  it('投影：shadow → 视图模型 PenShadow（offsetX/offsetY → x/y，color 原样交渲染层解析 token）', () => {
    const parsed = parseAxDocument(shadowDoc([shadowNode]))
    const nodes = childrenOfFirstPage(projectAxToPenDocument(parsed.document as AxDocument, 'a.ax').document)
    expect((nodes[0] as PenNode).shadow).toEqual({ color: '$shadow-color', x: 0, y: 4, blur: 12 })
  })
})

describe('symbols（1.4 文档内局部组件）', () => {
  /** 两参数表格行 symbol + 一页含两实例的基线稿（ax 1.3 → 迁移到当前版本）。 */
  const symbolDoc = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    ax: '1.3',
    tokens: { 'text-md': { $type: 'dimension', $value: '13px' } },
    components: {},
    symbols: {
      TableRow: {
        props: { c1: 'string', c2: 'string' },
        body: [{
          id: 'row', kind: 'frame', layout: 'horizontal', gap: 8, children: [
            { id: 'cell-a', kind: 'text', text: { $param: 'c1' }, wrap: 'nowrap', fontSize: '$text-md' },
            { id: 'cell-b', kind: 'text', text: { $param: 'c2' }, wrap: 'nowrap', fontSize: '$text-md' },
          ],
        }],
      },
    },
    pages: [{
      id: 'p1', width: 400, height: 300, tree: [
        { id: 'r1', kind: 'component', name: 'TableRow', props: { c1: '订单 A', c2: '已支付' } },
        { id: 'r2', kind: 'component', name: 'TableRow', props: { c1: { $mock: '订单 B' }, c2: { $bind: 'rows[1].status' } } },
      ],
    }],
    ...overrides,
  })
  const errorsWithPathsOf = (source: string): { level: string; path?: string; message: string }[] =>
    parseAxDocument(source).diagnostics.filter((item) => item.level === 'error')

  it('合法 symbol 与实例通过校验；1.3 旧稿经单跳迁移加载为当前版本', () => {
    const result = parseAxDocument(symbolDoc())
    expect(result.document).not.toBeNull()
    expect(result.document?.ax).toBe(AX_FORMAT_VERSION)
    expect(Object.keys(result.document?.symbols ?? {})).toEqual(['TableRow'])
    expect(errorsWithPathsOf(symbolDoc())).toEqual([])
  })

  it('def 形状错误：未知键 / body 非数组 / body 空 / props 非字符串映射', () => {
    expect(errorsWithPathsOf(symbolDoc({ symbols: { Bad: { props: {}, body: [], extra: 1 } } }))
      .some((item) => item.path === 'symbols.Bad' && item.message.includes('extra'))).toBe(true)
    expect(errorsWithPathsOf(symbolDoc({ symbols: { Bad: { props: {} } } }))
      .some((item) => item.path === 'symbols.Bad.body' && item.message.includes('非空'))).toBe(true)
    expect(errorsWithPathsOf(symbolDoc({ symbols: { Bad: { props: {}, body: {} } } }))
      .some((item) => item.path === 'symbols.Bad.body')).toBe(true)
    expect(errorsWithPathsOf(symbolDoc({ symbols: { Bad: { props: { a: 1 }, body: [{ id: 'x', kind: 'rect', width: 1, height: 1 }] } } }))
      .some((item) => item.path === 'symbols.Bad.props.a')).toBe(true)
  })

  it('body 内 component / overlay 报错（v1 无嵌套、无锚点语义）', () => {
    const withComponent = symbolDoc({
      symbols: { Bad: { props: {}, body: [{ id: 'b1', kind: 'component', name: 'TableRow' }] } },
    })
    expect(errorsWithPathsOf(withComponent)
      .some((item) => item.path === 'symbols.Bad.body[0]' && item.message.includes('不允许 component'))).toBe(true)
    const withOverlay = symbolDoc({
      symbols: { Bad: { props: {}, body: [{ id: 'b1', kind: 'overlay', anchor: 'center', children: [{ id: 'b2', kind: 'rect', width: 1, height: 1 }] }] } },
    })
    expect(errorsWithPathsOf(withOverlay)
      .some((item) => item.path === 'symbols.Bad.body[0]' && item.message.includes('不允许 overlay'))).toBe(true)
  })

  it('参数 ↔ 契约双向核对：引用未声明 / 声明未引用 / 非 string 类型', () => {
    const undeclared = symbolDoc({
      symbols: { Bad: { props: {}, body: [{ id: 't1', kind: 'text', text: { $param: 'ghost' }, wrap: 'nowrap' }] } },
    })
    expect(errorsWithPathsOf(undeclared)
      .some((item) => item.path === 'symbols.Bad.body' && item.message.includes('ghost'))).toBe(true)
    const unused = symbolDoc({
      symbols: { Bad: { props: { used: 'string', dangling: 'string' }, body: [{ id: 't1', kind: 'text', text: { $param: 'used' }, wrap: 'nowrap' }] } },
    })
    expect(errorsWithPathsOf(unused)
      .some((item) => item.path === 'symbols.Bad.props.dangling' && item.message.includes('未引用'))).toBe(true)
    const nonString = symbolDoc({
      symbols: { Bad: { props: { n: 'number' }, body: [{ id: 't1', kind: 'text', text: { $param: 'n' }, wrap: 'nowrap' }] } },
    })
    expect(errorsWithPathsOf(nonString)
      .some((item) => item.path === 'symbols.Bad.props.n' && item.message.includes('string'))).toBe(true)
  })

  it('页树文案位出现 {$param} 即报错；props 值同样拒绝', () => {
    const inText = symbolDoc({
      symbols: {},
      pages: [{ id: 'p1', tree: [{ id: 't1', kind: 'text', text: { $param: 'x' }, wrap: 'nowrap' }] }],
    })
    expect(errorsWithPathsOf(inText)
      .some((item) => item.path === 'pages[0].tree[0].text' && item.message.includes('symbol body'))).toBe(true)
    const inProps = symbolDoc({
      pages: [{ id: 'p1', tree: [{ id: 'r1', kind: 'component', name: 'TableRow', props: { c1: { $param: 'c2' }, c2: 'x' } }] }],
    })
    expect(errorsWithPathsOf(inProps)
      .some((item) => item.path === 'pages[0].tree[0].props.c1' && item.message.includes('props 值'))).toBe(true)
  })

  it('实例校验：未声明参数 / 缺必填 / 非 string 值 / variant·fixture·slot 拒绝', () => {
    const undeclaredProp = symbolDoc({
      pages: [{ id: 'p1', tree: [{ id: 'r1', kind: 'component', name: 'TableRow', props: { c1: 'a', c2: 'b', c3: 'c' } }] }],
    })
    expect(errorsWithPathsOf(undeclaredProp)
      .some((item) => item.path === 'pages[0].tree[0].props.c3' && item.message.includes('没有参数'))).toBe(true)
    const missingRequired = symbolDoc({
      pages: [{ id: 'p1', tree: [{ id: 'r1', kind: 'component', name: 'TableRow', props: { c1: 'a' } }] }],
    })
    expect(errorsWithPathsOf(missingRequired)
      .some((item) => item.path === 'pages[0].tree[0].props.c2' && item.message.includes('必填'))).toBe(true)
    const nonStringValue = symbolDoc({
      pages: [{ id: 'p1', tree: [{ id: 'r1', kind: 'component', name: 'TableRow', props: { c1: 42, c2: 'b' } }] }],
    })
    expect(errorsWithPathsOf(nonStringValue)
      .some((item) => item.path === 'pages[0].tree[0].props.c1' && item.message.includes('string'))).toBe(true)
    for (const field of ['variant', 'fixture'] as const) {
      const bad = symbolDoc({
        pages: [{ id: 'p1', tree: [{ id: 'r1', kind: 'component', name: 'TableRow', props: { c1: 'a', c2: 'b' }, [field]: 'x' }] }],
      })
      expect(errorsWithPathsOf(bad)
        .some((item) => item.path === `pages[0].tree[0].${field}`)).toBe(true)
    }
    const withSlot = symbolDoc({
      pages: [{ id: 'p1', tree: [{ id: 'r1', kind: 'component', name: 'TableRow', props: { c1: 'a', c2: 'b' }, slot: [] }] }],
    })
    expect(errorsWithPathsOf(withSlot)
      .some((item) => item.path === 'pages[0].tree[0].slot' && item.message.includes('slot'))).toBe(true)
  })

  it('重名核对：与 components 声明 / 注册表冲突即 fail-closed', () => {
    const withDecl = symbolDoc({
      components: { TableRow: { props: {} } },
    })
    expect(errorsWithPathsOf(withDecl)
      .some((item) => item.path === 'symbols.TableRow' && item.message.includes('重名'))).toBe(true)
    const inventory: DesignComponentSummary[] = [{
      name: 'TableRow', kind: 'presentational', sourcePath: 'components/x.tsx', props: [], fixtures: [],
    }]
    const parsed = parseAxDocument(symbolDoc(), { componentInventory: inventory })
    expect(parsed.document).toBeNull()
    expect(parsed.diagnostics.some((item) => item.level === 'error' && item.path === 'symbols.TableRow' && item.message.includes('注册表'))).toBe(true)
  })

  it('body id 核对：symbol 内重复 / 含保留分隔符 / 与页树或其它 symbol 重复', () => {
    // 兄弟级重复：validateNodes 的同级去重先拦（路径落到第二个节点）。
    const dupSibling = symbolDoc({
      symbols: { Bad: { props: {}, body: [
        { id: 't1', kind: 'rect', width: 1, height: 1 },
        { id: 't1', kind: 'rect', width: 1, height: 1 },
      ] } },
    })
    expect(errorsWithPathsOf(dupSibling)
      .some((item) => item.path === 'symbols.Bad.body[1]' && item.message.includes('重复'))).toBe(true)
    // 跨层重复：checkSymbolBodyIds 的 body 全树核对兜住（同级查不到）。
    const dupNested = symbolDoc({
      symbols: { Bad: { props: {}, body: [
        { id: 'wrap', kind: 'frame', children: [{ id: 't1', kind: 'rect', width: 1, height: 1 }] },
        { id: 't1', kind: 'rect', width: 1, height: 1 },
      ] } },
    })
    expect(errorsWithPathsOf(dupNested)
      .some((item) => item.path === 'symbols.Bad.body' && item.message.includes('重复'))).toBe(true)
    const reserved = symbolDoc({
      symbols: { Bad: { props: {}, body: [{ id: `x${AX_SYMBOL_ID_SEP}y`, kind: 'rect', width: 1, height: 1 }] } },
    })
    expect(errorsWithPathsOf(reserved)
      .some((item) => item.path === 'symbols.Bad.body' && item.message.includes(AX_SYMBOL_ID_SEP))).toBe(true)
    const pageCollision = symbolDoc({
      symbols: { TableRow: { props: { c1: 'string', c2: 'string' }, body: [
        { id: 'row', kind: 'frame', layout: 'horizontal', children: [
          { id: 'r1', kind: 'text', text: { $param: 'c1' }, wrap: 'nowrap' },
          { id: 'cell-b', kind: 'text', text: { $param: 'c2' }, wrap: 'nowrap' },
        ] },
      ] } },
    })
    expect(errorsWithPathsOf(pageCollision)
      .some((item) => item.path === 'symbols.TableRow.body' && item.message.includes('页树'))).toBe(true)
    const crossSymbol = symbolDoc({
      symbols: {
        TableRow: { props: { c1: 'string', c2: 'string' }, body: [
          { id: 'row', kind: 'frame', layout: 'horizontal', children: [
            { id: 'cell-a', kind: 'text', text: { $param: 'c1' }, wrap: 'nowrap' },
            { id: 'cell-b', kind: 'text', text: { $param: 'c2' }, wrap: 'nowrap' },
          ] },
        ] },
        Other: { props: {}, body: [{ id: 'cell-a', kind: 'rect', width: 1, height: 1 }] },
      },
    })
    expect(errorsWithPathsOf(crossSymbol)
      .some((item) => item.path === 'symbols.Other.body' && item.message.includes('TableRow'))).toBe(true)
  })

  it('幂等序列化：含 symbols 的稿字节等值；无 symbols 的存量稿不落键', () => {
    const parsed = parseAxDocument(symbolDoc())
    expect(parsed.document).not.toBeNull()
    const once = serializeAxDocument(parsed.document!)
    expect(serializeAxDocument(parseAxDocument(once).document!)).toBe(once)
    expect(once).toContain('"symbols"')
    // 键序：props 在 body 之前（diff 友好）。
    expect(once.indexOf('"props"')).toBeLessThan(once.indexOf('"body"'))
    const legacy = parseAxDocument(doc())
    expect(serializeAxDocument(legacy.document!)).not.toContain('"symbols"')
  })

  it('投影展开：参数替换（字面量/$mock/$bind 直通）、id 派生、多实例不冲突', () => {
    const parsed = parseAxDocument(symbolDoc())
    expect(parsed.document).not.toBeNull()
    const axDoc = parsed.document!
    const expanded = expandSymbolInstances(axDoc.pages[0]!.tree, axDoc.symbols ?? {})
    // 两实例 × 各自两个文本节点。
    expect(expanded).toHaveLength(2)
    expect(expanded[0]).toMatchObject({ id: `r1${AX_SYMBOL_ID_SEP}row`, kind: 'frame' })
    const cellsOf = (frameIndex: number) => (expanded[frameIndex]!.children ?? []).map((child) => child.id)
    expect(cellsOf(0)).toEqual([`r1${AX_SYMBOL_ID_SEP}cell-a`, `r1${AX_SYMBOL_ID_SEP}cell-b`])
    expect(cellsOf(1)).toEqual([`r2${AX_SYMBOL_ID_SEP}cell-a`, `r2${AX_SYMBOL_ID_SEP}cell-b`])
    // 字面量与 $mock 解包为字符串；$bind 直通（画布渲染成 {数据源} 占位）。
    expect((expanded[0]!.children ?? [])[0]).toMatchObject({ text: '订单 A' })
    expect((expanded[1]!.children ?? [])[0]).toMatchObject({ text: '订单 B' })
    expect((expanded[1]!.children ?? [])[1]).toMatchObject({ text: { $bind: 'rows[1].status' } })
    // 投影后的页树只有原语：实例不再以 component 节点出现。
    const projected = projectAxToPenDocument(axDoc, 'symbol.ax')
    const page = projected.document.pages[0] as unknown as { children: { type: string; id: string }[] }
    expect(page.children.map((child) => child.type)).toEqual(['frame', 'frame'])
    expect(projected.document.pages.every((node) => JSON.stringify(node).includes('"component"') === false)).toBe(true)
  })

  it('投影展开不共享 def 节点对象（实例间互不影响）', () => {
    const parsed = parseAxDocument(symbolDoc())
    const axDoc = parsed.document!
    const symbols = axDoc.symbols ?? {}
    const first = expandSymbolInstances(axDoc.pages[0]!.tree.slice(0, 1), symbols)[0]!
    first.id = 'mutated'
    const second = expandSymbolInstances(axDoc.pages[0]!.tree.slice(0, 1), symbols)[0]!
    expect(second.id).not.toBe('mutated')
    expect(symbols.TableRow?.body[0]?.id).toBe('row')
  })
})


describe('注册表核对（componentInventory 注入时）', () => {
  /** 与渲染侧注册表同形的摘要桩（fixtureProps 是 presentational 的 props 打底表）。 */
  const inventory: DesignComponentSummary[] = [
    {
      name: 'ApprovalCard',
      kind: 'store-bound' as const,
      sourcePath: 'components/session/ApprovalCard.tsx',
      props: [],
      fixtures: ['pending-command'],
      fixtureProps: {},
    },
    {
      name: 'ResultChip',
      kind: 'presentational' as const,
      sourcePath: 'components/session/ResultChip.tsx',
      props: [
        { name: 'message', type: 'json', required: true, description: '结果消息' },
      ],
      fixtures: ['completed'],
      // 全靠 fixture 打底的组件：节点不写 props 也满足必填（合并口径的回归锚点）。
      fixtureProps: { completed: ['message'] },
    },
    {
      name: 'MessageActions',
      kind: 'presentational' as const,
      sourcePath: 'components/session/MessageActions.tsx',
      props: [
        { name: 'role', type: 'string', required: true, description: 'user 或 assistant' },
        { name: 'text', type: 'string', required: false, description: '复制的内容' },
      ],
      fixtures: ['agent-message'],
      // fixture 只打底 text：必填 role 不被覆盖——节点不写 role 时必须报缺必填。
      fixtureProps: { 'agent-message': ['text'] },
    },
  ]

  const docWith = (components: Record<string, unknown>, tree: unknown[]): string => JSON.stringify({
    ax: '1.2',
    tokens: {},
    components,
    pages: [{ id: 'p1', width: 400, height: 300, tree }],
  })

  const errorsWithInventory = (source: string): string[] => {
    const result = parseAxDocument(source, { componentInventory: inventory })
    return result.diagnostics.filter((item) => item.level === 'error').map((item) => item.message)
  }

  it('组件不在注册表：声明块与节点都指向同一根因（声明块报一次）', () => {
    const errors = errorsWithInventory(docWith(
      { Ghost: { props: {} } },
      [{ id: 'n1', kind: 'component', name: 'Ghost' }],
    ))
    // 组件节点未在本稿声明会先被规则 1 拦下；声明块层面的注册表核对给出可用清单。
    expect(errors.some((message) => message.includes('Ghost') && message.includes('组件注册表'))).toBe(true)
    expect(errors.some((message) => message.includes('ApprovalCard'))).toBe(true)
  })

  it('decl.props 键不在注册表契约内：报错并列出可用 props', () => {
    const errors = errorsWithInventory(docWith(
      { MessageActions: { props: { role: 'string', bogus: 'string' } } },
      [{ id: 'n1', kind: 'component', name: 'MessageActions', props: { role: { $mock: 'user' } } }],
    ))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('bogus')
    expect(errors[0]).toContain('role')
  })

  it('decl.props 缺省时节点 props 键由注册表核对兜住（原校验空档）', () => {
    const errors = errorsWithInventory(docWith(
      { MessageActions: {} },
      [{ id: 'n1', kind: 'component', name: 'MessageActions', props: { bogus: 'x' } }],
    ))
    expect(errors.some((message) => message.includes('bogus'))).toBe(true)
  })

  it('缺必填 props 报错；fixture 打底的键视为已满足（ResultChip 全靠 fixture 不误报）', () => {
    const missing = errorsWithInventory(docWith(
      { MessageActions: { props: { role: 'string' } } },
      [{ id: 'n1', kind: 'component', name: 'MessageActions' }],
    ))
    expect(missing.some((message) => message.includes('必填 props'))).toBe(true)

    const coveredByFixture = parseAxDocument(docWith(
      { ResultChip: { props: { message: 'json' } } },
      [{ id: 'n1', kind: 'component', name: 'ResultChip', fixture: 'completed' }],
    ), { componentInventory: inventory })
    expect(coveredByFixture.document).not.toBeNull()
  })

  it('值型核对：$mock 结构化对象对 json 合法、标量错型报错；$bind 不参与判型', () => {
    const ok = parseAxDocument(docWith(
      { ResultChip: { props: { message: 'json' } } },
      [{ id: 'n1', kind: 'component', name: 'ResultChip', fixture: 'completed',
        props: { message: { $mock: { id: 'm', content: 'done' } } } }],
    ), { componentInventory: inventory })
    expect(ok.document).not.toBeNull()

    const wrongType = errorsWithInventory(docWith(
      { ResultChip: { props: { message: 'json' } } },
      [{ id: 'n1', kind: 'component', name: 'ResultChip', fixture: 'completed',
        props: { message: { $mock: 'oops-json-string' } } }],
    ))
    expect(wrongType.some((message) => message.includes('json'))).toBe(true)

    const bound = parseAxDocument(docWith(
      { MessageActions: { props: { role: 'string' } } },
      [{ id: 'n1', kind: 'component', name: 'MessageActions', props: { role: { $bind: 'msg.role' } } }],
    ), { componentInventory: inventory })
    expect(bound.document).not.toBeNull()
  })

  it('不注入清单（画布/测试路径）时行为与既往逐字节一致：契约外组件不报注册表错误', () => {
    const result = parseAxDocument(docWith(
      { ResultChip: { props: { message: 'json' } } },
      [{ id: 'n1', kind: 'component', name: 'ResultChip' }],
    ))
    expect(result.document).not.toBeNull()
    expect(result.diagnostics.filter((item) => item.level === 'error')).toHaveLength(0)
  })
})

describe('slots 具名插槽契约（1.5）', () => {
  it('1.4 → 1.5 迁移只改版本号（1.4 稿逐字节合法）', () => {
    const parsed = parseAxDocument(doc({ ax: '1.4' }))
    expect(parsed.error).toBeNull()
    expect(parsed.document?.ax).toBe(AX_FORMAT_VERSION)
    expect(parsed.diagnostics).toHaveLength(0)
  })

  it('节点 slot 内容需要 decl.slots 的 default 契约（fail-closed）', () => {
    // 未声明 slots：解析报错并指向声明路径。
    const missing = errorsOf(doc({
      pages: [{
        id: 'p1', width: 400, height: 300,
        tree: [{
          id: 'c1', kind: 'component', name: 'ApprovalCard',
          slot: [{ id: 's1', kind: 'text', text: '附加说明', wrap: 'nowrap' }],
        }],
      }],
    }))
    expect(missing.some((message) => message.includes('default') && message.includes('插槽'))).toBe(true)
    // 声明 default 契约后通过。
    const ok = parseAxDocument(doc({
      components: {
        ApprovalCard: {
          props: { command: 'string', danger: 'boolean' },
          slots: { default: { prop: 'children' } },
        },
      },
      pages: [{
        id: 'p1', width: 400, height: 300,
        tree: [{
          id: 'c1', kind: 'component', name: 'ApprovalCard',
          slot: [{ id: 's1', kind: 'text', text: '附加说明', wrap: 'nowrap' }],
        }],
      }],
    }))
    expect(ok.error).toBeNull()
    expect(ok.diagnostics.filter((item) => item.level === 'error')).toHaveLength(0)
  })

  it('decl.slots 形状校验：非对象 / 缺 prop / prop 非标识符都报错且带路径', () => {
    const bad = errorsOf(doc({
      components: { ApprovalCard: { slots: { default: { nope: 'children' } } } },
    }))
    expect(bad.some((message) => message.includes('插槽契约') || message.includes('prop'))).toBe(true)
    const nonIdent = errorsOf(doc({
      components: { ApprovalCard: { slots: { default: { prop: 'not a prop' } } } },
    }))
    expect(nonIdent.some((message) => message.includes('prop'))).toBe(true)
    const notRecord = errorsOf(doc({
      components: { ApprovalCard: { slots: ['default'] } },
    }))
    expect(notRecord.length).toBeGreaterThan(0)
  })

  it('显式写 slots 才落键：空 slots 不进序列化产物（幂等不被打破）', () => {
    const parsed = parseAxDocument(doc({
      components: { ApprovalCard: { slots: {} } },
    }))
    expect(parsed.error).toBeNull()
    const serialized = serializeAxDocument(parsed.document as AxDocument)
    expect(serialized).not.toContain('"slots"')
  })

  it('slots 往返字节稳定（parse → serialize → parse 等值）', () => {
    const parsed = parseAxDocument(doc({
      components: {
        ApprovalCard: {
          props: { command: 'string', danger: 'boolean' },
          slots: { default: { prop: 'children' } },
        },
      },
      pages: [{
        id: 'p1', width: 400, height: 300,
        tree: [{
          id: 'c1', kind: 'component', name: 'ApprovalCard',
          slot: [{ id: 's1', kind: 'text', text: '附加说明', wrap: 'nowrap' }],
        }],
      }],
    }))
    expect(parsed.error).toBeNull()
    const first = serializeAxDocument(parsed.document as AxDocument)
    expect(first).toContain('"slots"')
    const second = serializeAxDocument(parseAxDocument(first).document as AxDocument)
    expect(second).toBe(first)
  })

  it('注册表核对：decl.slots 插槽名不在注册表契约 / 注入 prop 与 props 撞名都报错', () => {
    const inventory: DesignComponentSummary[] = [
      {
        name: 'Panel',
        kind: 'presentational' as const,
        sourcePath: 'components/Panel.tsx',
        props: [{ name: 'title', type: 'string', required: true, description: '标题' }],
        fixtures: ['default'],
        fixtureProps: { default: ['title'] },
        slots: { default: { prop: 'children' } },
      },
    ]
    const source = (decl: Record<string, unknown>): string => JSON.stringify({
      ax: '1.5',
      tokens: {},
      components: { Panel: decl },
      pages: [{ id: 'p1', width: 400, height: 300, tree: [] }],
    })
    // 插槽名不在注册表契约内。
    const unknownSlot = parseAxDocument(source({ slots: { header: { prop: 'head' } } }), { componentInventory: inventory })
    expect(unknownSlot.diagnostics.filter((item) => item.level === 'error').map((item) => item.message).join('\n'))
      .toContain('header')
    // 注入 prop 与 props 契约撞名。
    const collision = parseAxDocument(source({ slots: { default: { prop: 'title' } } }), { componentInventory: inventory })
    expect(collision.diagnostics.filter((item) => item.level === 'error').map((item) => item.message).join('\n'))
      .toContain('撞名')
    // 合法契约（children 不在 props 白名单内，目录生成器本就剔除 children）零报错。
    const ok = parseAxDocument(source({ slots: { default: { prop: 'children' } } }), { componentInventory: inventory })
    expect(ok.diagnostics.filter((item) => item.level === 'error')).toHaveLength(0)
  })
})
