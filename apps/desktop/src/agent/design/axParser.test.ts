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
  parseAxDocument,
  projectAxToPenDocument,
  serializeAxDocument,
} from './axParser'
import { AX_FORMAT_VERSION } from './axSchema'
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
