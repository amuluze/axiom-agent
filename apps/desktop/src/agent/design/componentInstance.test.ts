import { describe, expect, it } from 'vitest'
import { componentFixtureOf, designBindingOf, resolveComponentProps } from './componentInstance'

describe('component instance props', () => {
  it('具名 fixture 打底，mock 覆盖，bind 使用原值或可见占位', () => {
    const fixture = componentFixtureOf({ first: { text: 'first' }, chosen: { text: 'fixture', value: null } }, 'chosen')
    expect(resolveComponentProps('presentational', fixture, {
      text: { $mock: 'override' }, value: { $bind: 'data.value' }, missing: { $bind: 'data.title' },
    })).toEqual({ text: 'override', value: null, missing: '{data.title}' })
    expect(fixture).toEqual({ text: 'fixture', value: null })
  })

  it('store fixture 不混入组件 props，结构化 mock 保留对象', () => {
    const message = { content: 'hello', toolCalls: [] }
    expect(resolveComponentProps('store-bound', { messages: [] }, { message: { $mock: message } })).toEqual({ message })
  })

  it('显式变体覆盖 fixture 与 props，预览与代码生成共用同一优先级', () => {
    expect(resolveComponentProps('presentational', { variant: 'default' }, { variant: 'default' }, 'overlay')).toEqual({ variant: 'overlay' })
  })

  it('仅识别单键绑定；无具名 fixture 时兼容首个数据档案', () => {
    expect(designBindingOf({ $bind: 'data', extra: true })).toBeNull()
    expect(designBindingOf({ $mock: null })).toEqual({ kind: 'mock', value: null })
    expect(componentFixtureOf({ first: { text: 'hello' } })).toEqual({ text: 'hello' })
    expect(componentFixtureOf({})).toEqual({})
  })
})
