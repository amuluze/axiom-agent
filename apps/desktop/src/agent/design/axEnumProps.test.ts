import { describe, expect, it } from 'vitest'
import { expandSymbolInstances, parseAxDocument } from './axParser'
import { AX_FORMAT_VERSION } from './axSchema'

const TOKENS = { 'text-md': { $type: 'dimension', $value: '13px' } }

const doc = (symbols: unknown, tree: unknown, ax = '1.6'): string =>
  JSON.stringify({ ax, tokens: TOKENS, components: {}, symbols, pages: [{ id: 'p1', width: 400, height: 300, tree }] })

/** 枚举契约 + 枚举位（icon.name）引用的最小合法 symbol。 */
const iconRow = {
  IconRow: {
    props: { iconName: { enum: ['globe', 'plug'] }, label: 'string' },
    body: [{
      id: 'row', kind: 'frame', children: [
        { id: 'ic', kind: 'icon', name: { $param: 'iconName' } },
        { id: 'tx', kind: 'text', text: { $param: 'label' }, wrap: 'nowrap', fontSize: '$text-md' },
      ],
    }],
  },
}
const instance = (props: unknown) => [{ id: 'i1', kind: 'component', name: 'IconRow', props }]

const errorsOf = (src: string) => parseAxDocument(src).diagnostics.filter((item) => item.level === 'error')

describe('枚举型 props（1.6）', () => {
  it('枚举契约 + 枚举位引用：合法稿解析通过，实例值命中闭集', () => {
    const parsed = parseAxDocument(doc(iconRow, instance({ iconName: 'globe', label: '设置' })))
    expect(errorsOf(doc(iconRow, instance({ iconName: 'globe', label: '设置' })))).toEqual([])
    expect(parsed.document).not.toBeNull()
    expect(parsed.document?.ax).toBe(AX_FORMAT_VERSION)
  })

  it('页树枚举位写 {$param} 即报错（只有 symbol body 接受枚举引用）', () => {
    const errs = errorsOf(doc({}, [{ id: 'p1-ic', kind: 'icon', name: { $param: 'iconName' } }]))
    expect(errs.some((item) => item.path === 'pages[0].tree[0]')).toBe(true)
  })

  it('实例值越界报错并列出可用值域', () => {
    const errs = errorsOf(doc(iconRow, instance({ iconName: 'star', label: '设置' })))
    const hit = errs.find((item) => item.path === 'pages[0].tree[0].props.iconName')
    expect(hit?.message).toContain('不在值域')
    expect(hit?.message).toContain('globe')
  })

  it('位置 × 类型错配：枚举位参数声明为 string 报错', () => {
    const bad = { IconRow: { props: { iconName: 'string', label: 'string' }, body: iconRow.IconRow.body } }
    const errs = errorsOf(doc(bad, instance({ iconName: 'globe', label: '设置' })))
    expect(errs.some((item) => item.path === 'symbols.IconRow.props.iconName' && item.message.includes('枚举位'))).toBe(true)
  })

  it('契约值域非法（重复项）报键级路径', () => {
    const bad = { IconRow: { props: { iconName: { enum: ['globe', 'globe'] }, label: 'string' }, body: iconRow.IconRow.body } }
    expect(errorsOf(doc(bad, instance({ iconName: 'globe', label: '设置' })))
      .some((item) => item.path === 'symbols.IconRow.props.iconName')).toBe(true)
  })

  it('投影展开把枚举位替换为实例字面量', () => {
    const parsed = parseAxDocument(doc(iconRow, instance({ iconName: 'plug', label: '设置' })))
    const expanded = expandSymbolInstances(parsed.document!.pages[0].tree, parsed.document!.symbols ?? {})
    const names: unknown[] = []
    const walk = (nodes: readonly { children?: unknown[] }[]): void => {
      for (const node of nodes) {
        const icon = node as { kind?: string; name?: unknown; children?: { children?: unknown[] }[] }
        if (icon.kind === 'icon') names.push(icon.name)
        walk((node.children ?? []) as readonly { children?: unknown[] }[])
      }
    }
    walk(expanded as readonly { children?: unknown[] }[])
    expect(names).toEqual(['plug'])
  })

  it('1.5 稿迁移到 1.6 只改版本号，语义不变', () => {
    const parsed = parseAxDocument(doc(iconRow, instance({ iconName: 'globe', label: '设置' }), '1.5'))
    expect(errorsOf(doc(iconRow, instance({ iconName: 'globe', label: '设置' }), '1.5'))).toEqual([])
    expect(parsed.document?.ax).toBe(AX_FORMAT_VERSION)
  })
})
