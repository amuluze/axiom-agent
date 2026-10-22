import { expect, it } from 'vitest'
import { emitAxPageToVue } from './emitVuePage'
import type { AxDocument } from './axSchema'
import type { DesignComponentDetail } from './componentInventoryHost'

const detail: DesignComponentDetail = {
	summary: {
		name: 'Button',
		framework: 'vue',
		kind: 'presentational',
		sourcePath: 'src/Button.vue',
		props: [{ name: 'label', type: 'string', required: true, description: '' }],
		fixtures: ['ready'],
	},
	statics: ['onClick'],
	fixtures: { ready: { label: '保存 {{ arbitrary() }}' } },
}
const document: AxDocument = {
	ax: '1.0',
	tokens: {},
	components: {},
	pages: [
		{
			id: 'page',
			width: 400,
			height: 300,
			tree: [
				{
					id: 'button',
					kind: 'component',
					name: 'Button',
					fixture: 'ready',
					props: { label: { $bind: 'state.label' } },
				},
				{
					id: 'text',
					kind: 'text',
					text: '{{ arbitrary() }} </template>',
					wrap: 'nowrap',
				},
			],
		},
	],
}
it('Vue 输出 script setup、真实 SFC 导入、合并 fixture 和类型化的必填绑定', () => {
	const result = emitAxPageToVue(document, 'page', {
		componentImports: { Button: { from: '@/Button.vue', imported: 'default' } },
		componentDetails: { Button: detail },
	})
	expect(result?.code).toContain('<script setup lang="ts">')
	expect(result?.code).toContain("import Button from '@/Button.vue'")
	expect(result?.code).toContain(
		"'button.onClick': NonNullable<InstanceType<typeof Button>['$props']['onClick']>",
	)
	expect(result?.code).toContain(
		'defineProps<{ bindings: DesignPageBindings }>()',
	)
	expect(result?.code).toContain(
		'v-text="\'{{ arbitrary() }} \\u003c/template\\u003e\'"',
	)
	expect(result?.code).toContain("'width': '100%'")
	expect(result?.code).not.toContain('() => undefined')
	expect(result?.unresolved.map((entry) => entry.kind)).toEqual([
		'component($bind)',
		'component(callback)',
	])
})
it('纯 fixture 和参考尺寸直接生成，React 组件与未知原语显式列入 unresolved', () => {
	const copy = structuredClone(document)
	delete copy.pages[0]!.tree[0]!.props
	const result = emitAxPageToVue(copy, 1, {
		layout: 'reference',
		componentImports: { Button: { from: '@/Button.vue', imported: 'default' } },
		componentDetails: { Button: detail },
	})
	expect(result?.code).toContain(':label="\'保存 {{ arbitrary() }}\'"')
	expect(result?.code).toContain('400px')
	expect(result?.code).toContain('</script>\n\n<template>')
	expect(emitAxPageToVue(copy, 1)?.unresolved).toContainEqual(
		expect.objectContaining({ kind: 'component' }),
	)
})

it('有契约的 default 插槽递归生成，嵌套回调保留类型化 bindings', () => {
  const copy = structuredClone(document)
  delete copy.pages[0]!.tree[0]!.props
  copy.pages[0]!.tree[0]!.slot = [{ id: 'nested', kind: 'component', name: 'Button', fixture: 'ready' }]
  const result = emitAxPageToVue(copy, 1, {
    componentImports: { Button: { from: '@/Button.vue', imported: 'default' } },
    componentDetails: { Button: { ...detail, summary: { ...detail.summary, defaultSlot: true } } },
  })
  expect(result?.code).toContain('<template #default><Button')
  expect(result?.code).toContain("'nested.onClick'")
  expect(result?.unresolved.map((entry) => entry.kind)).not.toContain('component(slot)')
  expect(result?.counts.components).toBe(2)
})

it('symbol 实例内联展开并逐 symbol 记 unresolved 说明（Vue 不发射局部组件）', () => {
  const withSymbols: AxDocument = {
    ax: '1.4',
    tokens: {},
    components: {},
    symbols: {
      TableRow: {
        props: { c1: 'string' },
        body: [
          {
            id: 'row',
            kind: 'frame',
            layout: 'horizontal',
            children: [
              { id: 'cell-a', kind: 'text', text: { $param: 'c1' }, wrap: 'nowrap' },
            ],
          },
        ],
      },
    },
    pages: [
      {
        id: 'page',
        width: 400,
        height: 300,
        tree: [
          { id: 'r1', kind: 'component', name: 'TableRow', props: { c1: '订单 A' } },
          { id: 'r2', kind: 'component', name: 'TableRow', props: { c1: { $bind: 'rows[1].name' } } },
        ],
      },
    ],
  }
  const result = emitAxPageToVue(withSymbols, 'page', {})
  // 展开后的文案进入模板（字面量直出；$bind 保留为类型化接线点），不再出现实例标签。
  expect(result?.code).toContain("'订单 A'")
  expect(result?.code).toContain("bindings['r2~s:cell-a.text'") // 派生 id 的绑定键（含分隔符原文）
  expect(result?.code).not.toContain('<TableRow')
  // 逐 symbol 一条说明：展开不是静默降级，接线者需要知道复用边界。
  expect(result?.unresolved).toContainEqual(
    expect.objectContaining({ kind: 'symbol', reason: expect.stringContaining('TableRow') }),
  )
  expect(result?.counts.symbols).toBe(0)
})
