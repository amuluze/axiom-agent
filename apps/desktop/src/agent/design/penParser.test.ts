import { describe, expect, it } from 'vitest'
import { parsePenDocument, tokenToCss, type PenNode } from './penParser'

describe('tokenToCss', () => {
  it('把 $token 映射为 var(--token)，字面值原样返回', () => {
    expect(tokenToCss('$color-bg-primary')).toBe('var(--color-bg-primary)')
    expect(tokenToCss('#ff0000')).toBe('#ff0000')
  })

  it('含 url(/expression(/javascript: 的值渲染为空（远程加载面封堵）', () => {
    // .pen 是不完全可信输入：字面色会原样进入 background 等加载型属性。
    expect(tokenToCss('url(https://evil.example/x)')).toBe('')
    expect(tokenToCss('URL( https://evil.example/x )')).toBe('')
    expect(tokenToCss('expression(alert(1))')).toBe('')
    expect(tokenToCss('javascript:alert(1)')).toBe('')
    // CSS 注释拼接是等价写法（u/**/rl(x)），不能成为绕过。
    expect(tokenToCss('u/**/rl(https://evil.example/x)')).toBe('')
    // 合法值不误伤：内容里含 url 字样但不是 url( 函数。
    expect(tokenToCss('#aabbcc')).toBe('#aabbcc')
    expect(tokenToCss('$bg-main')).toBe('var(--bg-main)')
  })
})

describe('parsePenDocument', () => {
  it('拒绝非 JSON 与缺少 children 的输入', () => {
    expect(parsePenDocument('not json', 'a.pen').error).toMatch(/JSON 解析失败/)
    expect(parsePenDocument('{"version":1}', 'a.pen').error).toMatch(/children/)
  })

  it('顶层非 reusable frame 为页面，reusable frame 为组件', () => {
    const source = JSON.stringify({
      version: 1,
      children: [
        { type: 'frame', id: 'page-1', name: '首页' },
        { type: 'frame', id: 'comp-1', name: '按钮', reusable: true },
      ],
    })
    const { document, error } = parsePenDocument(source, 'a.pen')
    expect(error).toBeNull()
    expect(document?.pages).toHaveLength(1)
    const firstPage = document?.pages[0]
    expect(firstPage && 'name' in firstPage ? firstPage.name : undefined).toBe('首页')
    expect(document?.components['comp-1']?.name).toBe('按钮')
  })

  it('variables 归一为按主题的字面值映射', () => {
    const source = JSON.stringify({
      children: [],
      variables: {
        'color-accent': [
          { value: '#111111', theme: { mode: 'light' } },
          { value: '#eeeeee', theme: { mode: 'dark' } },
        ],
        'space-gap': '8px',
      },
    })
    const { document } = parsePenDocument(source, 'a.pen')
    expect(document?.modeVariables.light['color-accent']).toBe('#111111')
    expect(document?.modeVariables.dark['color-accent']).toBe('#eeeeee')
    expect(document?.modeVariables.light['space-gap']).toBe('8px')
    expect(document?.modeVariables.dark['space-gap']).toBe('8px')
  })

  it('variables 对象包裹形态（{type, value: entries}）同样归一出主题映射', () => {
    // 真实 .pen 文件（spec 2.17+）的变量是 {type:'color', value:[...]} 包裹形态，
    // 曾因下钻时多包一层数组被过滤成空，主题 token 全部丢失。
    const source = JSON.stringify({
      children: [],
      variables: {
        'bg-main': {
          type: 'color',
          value: [
            { value: '#161514', theme: { mode: 'dark' } },
            { value: '#F8F7F3', theme: { mode: 'light' } },
          ],
        },
        'font-ui': { type: 'string', value: 'Inter' },
      },
    })
    const { document } = parsePenDocument(source, 'a.pen')
    expect(document?.modeVariables.light['bg-main']).toBe('#F8F7F3')
    expect(document?.modeVariables.dark['bg-main']).toBe('#161514')
    expect(document?.modeVariables.light['font-ui']).toBe('Inter')
    expect(document?.modeVariables.dark['font-ui']).toBe('Inter')
  })

  it('ref 展开组件子树并应用 descendants 覆写', () => {
    const source = JSON.stringify({
      children: [
        {
          type: 'frame',
          id: 'btn',
          reusable: true,
          children: [
            { type: 'text', id: 'label', content: '默认' },
            { type: 'icon', id: 'ico', icon: 'check' },
          ],
        },
        {
          type: 'ref',
          id: 'ref-1',
          ref: 'btn',
          descendants: { label: { content: '覆盖' }, ico: { enabled: false } },
        },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const ref = document?.pages[0] as PenNode | undefined
    expect(ref?.type).toBe('frame')
    expect(ref?.id).toBe('ref-1')
    const children = (ref?.children ?? []) as PenNode[]
    expect(children).toHaveLength(1)
    expect(children[0]?.type).toBe('text')
    expect(children[0]?.content).toBe('覆盖')
  })

  it('descendants 的 fill/stroke/effect 覆写按 paint 语义归一，不裸并入', () => {
    // 回归：覆写曾是裸 spread，`fill: "$text"` 直接落到节点上成为裸字符串，
    // 渲染层 paintToCss 取 .value 抛 TypeError → 无错误边界时整树卸载（黑屏）。
    const source = JSON.stringify({
      children: [
        {
          type: 'frame',
          id: 'btn',
          reusable: true,
          children: [
            { type: 'text', id: 'label', content: '默认' },
            { type: 'text', id: 'sub', content: '副文本' },
          ],
        },
        {
          type: 'ref',
          id: 'ref-1',
          ref: 'btn',
          descendants: {
            label: { fill: '$text', fontWeight: '600' },
            sub: {
              stroke: { type: 'solid', value: '$border' },
              effect: { color: '#000000', offset: { x: 2, y: 4 }, blur: 8 },
            },
          },
        },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const children = ((document?.pages[0] as PenNode | undefined)?.children ?? []) as PenNode[]
    const label = children.find((child) => child.id === 'label')
    expect(label?.fill).toEqual({ kind: 'solid', value: '$text' })
    expect(label?.fontWeight).toBe('600')
    const sub = children.find((child) => child.id === 'sub')
    expect(sub?.stroke).toEqual({ kind: 'solid', value: '$border' })
    expect(sub?.shadow).toEqual({ color: '#000000', x: 2, y: 4, blur: 8 })
  })

  it('自引用组件不死循环：解析期组件未登记，内层 ref 降级为缺失占位', () => {
    const source = JSON.stringify({
      children: [
        {
          type: 'frame',
          id: 'loop',
          reusable: true,
          children: [{ type: 'ref', id: 'inner', ref: 'loop' }],
        },
        { type: 'ref', id: 'top', ref: 'loop' },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const top = document?.pages[0] as PenNode | undefined
    expect(top?.id).toBe('top')
    const inner = (top?.children ?? [])[0] as PenNode | undefined
    expect(inner?.refMissing).toBe(true)
  })

  it('嵌套深度超过 MAX_REF_DEPTH 的 ref 降级为缺失占位', () => {
    // 现状语义：depth 是树嵌套深度而非 ref 链深度，深层 ref 同样被拦截。
    const source = JSON.stringify({
      children: [
        { type: 'frame', id: 'comp', reusable: true },
        {
          type: 'frame', id: 'l0', children: [
            { type: 'frame', id: 'l1', children: [
              { type: 'frame', id: 'l2', children: [
                { type: 'frame', id: 'l3', children: [
                  { type: 'frame', id: 'l4', children: [
                    { type: 'frame', id: 'l5', children: [
                      { type: 'frame', id: 'l6', children: [
                        { type: 'frame', id: 'l7', children: [
                          { type: 'frame', id: 'l8', children: [
                            { type: 'ref', id: 'deep-ref', ref: 'comp' },
                          ] },
                        ] },
                      ] },
                    ] },
                  ] },
                ] },
              ] },
            ] },
          ],
        },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    let node = document?.pages[0] as PenNode | undefined
    while (node?.children?.length) node = node.children[0] as PenNode
    expect(node?.id).toBe('deep-ref')
    expect(node?.refMissing).toBe(true)
  })

  it('ref 目标缺失时降级为占位并记入诊断', () => {
    const source = JSON.stringify({
      children: [{ type: 'ref', id: 'ref-x', ref: 'ghost', name: '幽灵' }],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    expect((document?.pages[0] as PenNode | undefined)?.refMissing).toBe(true)
    expect(document?.diagnostics.some((item) => item.message.includes('ghost'))).toBe(true)
  })

  it('未知节点类型降级为占位框且去重不崩溃', () => {
    const source = JSON.stringify({
      children: [
        { type: 'browser', id: 'b1' },
        { type: 'script', id: 's1' },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    expect(document?.pages).toHaveLength(2)
    expect(document?.pages.every((page) => page.type === 'unknown')).toBe(true)
    expect(document?.diagnostics).toHaveLength(2)
  })

  it('enabled:false 的节点被剔除', () => {
    const source = JSON.stringify({
      children: [
        { type: 'frame', id: 'page', children: [{ type: 'text', id: 't', enabled: false }] },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    expect((document?.pages[0] as PenNode | undefined)?.children).toHaveLength(0)
  })

  it('图片填充解析为 image paint；外部（远程/协议相对）URL 记入诊断', () => {
    const source = JSON.stringify({
      children: [
        { type: 'frame', id: 'p1', fill: { type: 'image', url: 'assets/a.png', mode: 'fit' } },
        { type: 'frame', id: 'p2', fill: { type: 'image', url: 'https://evil.example/x.png' } },
        { type: 'frame', id: 'p3', fill: { type: 'image', url: '//cdn.example/x.png' } },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const local = document?.pages[0] as PenNode | undefined
    expect(local?.fill).toEqual({ kind: 'image', url: 'assets/a.png', mode: 'fit' })
    const remote = document?.pages[1] as PenNode | undefined
    expect(remote?.fill?.kind).toBe('image')
    const rejected = document?.diagnostics.filter((item) => item.message.includes('外部图片引用已拒绝'))
    expect(rejected).toHaveLength(2)
  })

  it('token 值含 url( 被置空并记入诊断', () => {
    const source = JSON.stringify({
      children: [],
      variables: {
        'bg-evil': 'url(https://evil.example/x)',
        'bg-ok': '#ffffff',
      },
    })
    const { document } = parsePenDocument(source, 'a.pen')
    expect(document?.modeVariables.light['bg-evil']).toBe('')
    expect(document?.modeVariables.light['bg-ok']).toBe('#ffffff')
    expect(document?.diagnostics.some((item) => item.message.includes('bg-evil'))).toBe(true)
  })

  it('记录 spec 版本；主版本超出已验证范围时记入诊断', () => {
    const supported = parsePenDocument(JSON.stringify({ version: '2.18', children: [] }), 'a.pen')
    expect(supported.document?.version).toBe('2.18')
    expect(supported.document?.diagnostics).toHaveLength(0)
    const future = parsePenDocument(JSON.stringify({ version: '3.0', children: [] }), 'a.pen')
    expect(future.document?.version).toBe('3.0')
    expect(future.document?.diagnostics.some((item) => item.message.includes('v3.0'))).toBe(true)
  })

  it('填充列表取首个未禁用条目，solid 与 gradient 都能解析', () => {
    const source = JSON.stringify({
      children: [
        {
          type: 'frame',
          id: 'p1',
          fill: [
            { value: '$color-red', enabled: false },
            { value: '$color-blue' },
          ],
        },
        {
          type: 'frame',
          id: 'p2',
          fill: {
            type: 'gradient',
            gradientType: 'linear',
            rotation: 0,
            colors: [
              { color: '$color-black', position: 0 },
              { color: '#ffffff', position: 1 },
            ],
          },
        },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const first = document?.pages[0] as PenNode | undefined
    expect(first?.fill).toEqual({ kind: 'solid', value: '$color-blue' })
    const gradient = (document?.pages[1] as PenNode | undefined)?.fill
    expect(gradient?.kind).toBe('gradient')
    if (gradient?.kind === 'gradient') {
      expect(gradient.css).toContain('linear-gradient')
      expect(gradient.css).toContain('var(--color-black)')
    }
  })
})

describe('parsePenDocument：渲染语义归一（实测两处设计稿的字段形态）', () => {
  it('number 型 token 注入时补 px（gap/padding/cornerRadius/fontSize 全靠它）', () => {
    // .pen 的 number token 是长度（axiom.pen 的 text-*/space-*/radius-*）。
    // 注入裸数值会让 `font-size: var(--text-md)` 解析成 `font-size: 13`——无效声明
    // 被整条丢弃，字号回落继承值、gap/padding 变 0。
    const source = JSON.stringify({
      variables: {
        'space-8': { type: 'number', value: 8 },
        'text-md': { type: 'number', value: 13 },
        'font-ui': 'Inter',
        'bg-main': { type: 'color', value: '#161514' },
      },
      children: [{ type: 'frame', id: 'p', name: '页' }],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    expect(document?.modeVariables.dark['space-8']).toBe('8px')
    expect(document?.modeVariables.light['text-md']).toBe('13px')
    // 颜色与字符串不受影响。
    expect(document?.modeVariables.dark['bg-main']).toBe('#161514')
    expect(document?.modeVariables.dark['font-ui']).toBe('Inter')
  })

  it('strokeWidth 逐边对象保留（分隔线不能回落成四边全描）', () => {
    const source = JSON.stringify({
      children: [
        {
          type: 'frame',
          id: 'bar',
          stroke: '$border-subtle',
          strokeWidth: { bottom: 1 },
        },
        { type: 'frame', id: 'plain', stroke: '$border-subtle', strokeWidth: 2 },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const pages = (document?.pages ?? []) as PenNode[]
    expect(pages[0]?.strokeWidth).toEqual({ bottom: 1 })
    expect(pages[1]?.strokeWidth).toBe(2)
  })

  it('angular 渐变映射为 conic-gradient（进度环）并保留色标', () => {
    const source = JSON.stringify({
      children: [
        {
          type: 'ellipse',
          id: 'ring',
          innerRadius: 0.58,
          fill: {
            type: 'gradient',
            gradientType: 'angular',
            rotation: 0,
            colors: [
              { color: '$accent', position: 0 },
              { color: '$accent', position: 0.46 },
              { color: '$border-subtle', position: 0.46 },
              { color: '$border-subtle', position: 1 },
            ],
          },
        },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const ring = document?.pages[0] as PenNode
    expect(ring.innerRadius).toBe(0.58)
    const fill = ring.fill
    expect(fill?.kind).toBe('gradient')
    if (fill?.kind === 'gradient') {
      expect(fill.gradientType).toBe('angular')
      expect(fill.css).toContain('conic-gradient(from 0deg')
      expect(fill.css).toContain('var(--accent) 46%')
      expect(fill.stops).toHaveLength(4)
    }
  })

  it('path 节点保留 geometry 与 viewBox（数组与字符串两种形态）', () => {
    const source = JSON.stringify({
      children: [
        { type: 'path', id: 'mark', geometry: 'M0 0h8v8H0z', viewBox: [0, 0, 16, 16], fill: '$text' },
        { type: 'path', id: 'mark-2', geometry: 'M0 0h4v4H0z', viewBox: '0 0 8 8' },
      ],
    })
    const { document } = parsePenDocument(source, 'a.pen')
    const pages = (document?.pages ?? []) as PenNode[]
    expect(pages[0]?.geometry).toBe('M0 0h8v8H0z')
    expect(pages[0]?.viewBox).toEqual([0, 0, 16, 16])
    expect(pages[1]?.viewBox).toEqual([0, 0, 8, 8])
  })
})

describe('parsePenDocument：版本兼容（老版 .pen 的 group）', () => {
  it('group 迁移为 frame，子节点按 x/y 绝对定位', () => {
    // 参考实现的 2.15→2.16 迁移：group 不再有布局，子节点各按坐标摆放。
    const source = JSON.stringify({
      version: '2.15',
      children: [
        {
          type: 'group',
          id: 'g-1',
          name: '分组',
          layout: 'vertical',
          gap: 8,
          clip: true,
          children: [
            { type: 'rectangle', id: 'r-1', x: 10, y: 20, width: 40, height: 10 },
            { type: 'text', id: 't-1', x: 0, y: 40, content: 'hi' },
          ],
        },
      ],
    })
    const { document } = parsePenDocument(source, 'legacy.pen')
    const group = document?.pages[0] as PenNode
    expect(group.type).toBe('frame')
    // 布局属性（gap）与裁剪按迁移语义清空。
    expect(group.layout).toBeUndefined()
    expect(group.gap).toBeUndefined()
    expect(group.clip).toBeUndefined()
    expect(group.children?.every((child) => (
      child.type === 'unknown' || child.type === 'component' || child.type === 'part'
      || child.layoutPosition === 'absolute'
    ))).toBe(true)
    // 不再降级为占位框（此前整组内容丢失）。
    expect(group.children).toHaveLength(2)
  })
})
