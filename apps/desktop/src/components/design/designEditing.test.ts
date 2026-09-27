import { describe, expect, it } from 'vitest'
import {
  applyPatchToRaw,
  applyPatchesToRaw,
  collectRefNodeIds,
  findRawNodePath,
  readAtRaw,
  serializePenRaw,
} from './designEditing'

const FIXTURE = {
  version: '2.18',
  children: [
    {
      type: 'frame',
      id: 'page-1',
      name: '首页',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      children: [
        { type: 'text', id: 'text-1', content: 'hello', x: 10, y: 10, layoutPosition: 'absolute' },
        { type: 'frame', id: 'flow-1', children: [{ type: 'text', id: 'inner-1', content: 'flow' }] },
      ],
    },
    {
      type: 'ref',
      id: 'inst-1',
      ref: 'comp-1',
      x: 130,
      y: 0,
    },
    {
      type: 'frame',
      id: 'comp-1',
      reusable: true,
      children: [{ type: 'text', id: 'comp-inner-1', content: 'component body' }],
    },
  ],
}

describe('findRawNodePath', () => {
  it('顶层页与深层嵌套节点都能按 id 定位', () => {
    expect(findRawNodePath(FIXTURE, 'page-1')).toEqual(['children', 0])
    expect(findRawNodePath(FIXTURE, 'text-1')).toEqual(['children', 0, 'children', 0])
    expect(findRawNodePath(FIXTURE, 'inner-1')).toEqual(['children', 0, 'children', 1, 'children', 0])
  })

  it('ref 实例根定位到 raw 的 ref 声明（而非组件定义）', () => {
    expect(findRawNodePath(FIXTURE, 'inst-1')).toEqual(['children', 1])
  })

  it('未知 id 返回 null', () => {
    expect(findRawNodePath(FIXTURE, 'nope')).toBeNull()
  })
})

describe('readAtRaw', () => {
  it('按路径读值；缺失路径返回 undefined', () => {
    expect(readAtRaw(FIXTURE, ['children', 0, 'name'])).toBe('首页')
    expect(readAtRaw(FIXTURE, ['children', 0, 'children', 0, 'content'])).toBe('hello')
    expect(readAtRaw(FIXTURE, ['children', 9, 'name'])).toBeUndefined()
  })
})

describe('applyPatchToRaw', () => {
  it('对象字段写入与删除', () => {
    const raw = structuredClone(FIXTURE)
    expect(applyPatchToRaw(raw, { path: ['children', 0, 'x'], before: 0, after: 42 })).toBe(true)
    expect((raw.children as never[])[0]).toMatchObject({ x: 42 })
    expect(applyPatchToRaw(raw, { path: ['children', 0, 'name'], before: '首页', after: undefined })).toBe(true)
    expect((raw.children as never[])[0]).not.toHaveProperty('name')
  })

  it('数组下标 splice 删除与越界拒绝', () => {
    const raw = structuredClone(FIXTURE)
    expect(applyPatchToRaw(raw, { path: ['children', 0, 'children', 0], before: {}, after: undefined })).toBe(true)
    const pageChildren = (raw.children as Record<string, unknown>[])[0].children as unknown[]
    expect(pageChildren).toHaveLength(1)
    expect(applyPatchToRaw(raw, { path: ['children', 9], before: {}, after: undefined })).toBe(false)
  })

  it('容器缺失时拒绝且不产生半应用', () => {
    const raw = structuredClone(FIXTURE)
    expect(applyPatchToRaw(raw, { path: ['children', 0, 'nope', 'x'], before: 1, after: 2 })).toBe(false)
  })
})

describe('applyPatchesToRaw', () => {
  it('成组应用；中途失败回滚已应用部分', () => {
    const raw = structuredClone(FIXTURE)
    const ok = applyPatchesToRaw(raw, [
      { path: ['children', 0, 'x'], before: 0, after: 7 },
      { path: ['children', 0, 'y'], before: 0, after: 9 },
    ])
    expect(ok).toBe(true)
    expect((raw.children as never[])[0]).toMatchObject({ x: 7, y: 9 })

    const rolled = structuredClone(FIXTURE)
    const failed = applyPatchesToRaw(rolled, [
      { path: ['children', 0, 'x'], before: 0, after: 7 },
      { path: ['children', 0, 'missing', 'x'], before: 0, after: 7 },
    ])
    expect(failed).toBe(false)
    // 首个补丁已被回滚：树保持原样。
    expect((rolled.children as never[])[0]).toMatchObject({ x: 0 })
  })
})

describe('collectRefNodeIds', () => {
  it('收集页面与组件定义内的全部 ref 声明 id', () => {
    const withNestedRef = structuredClone(FIXTURE)
    ;(((withNestedRef.children as Record<string, unknown>[])[2]).children as unknown[]).push({
      type: 'ref',
      id: 'inst-nested',
      ref: 'comp-1',
    })
    expect(collectRefNodeIds(withNestedRef)).toEqual(new Set(['inst-1', 'inst-nested']))
    expect(collectRefNodeIds(FIXTURE)).toEqual(new Set(['inst-1']))
  })
})

describe('serializePenRaw', () => {
  it('2 空格缩进序列化，未知字段原样保留', () => {
    const raw = structuredClone(FIXTURE)
    const source = serializePenRaw(raw)
    expect(source).toContain('"reusable": true')
    const reparsed = JSON.parse(source) as typeof FIXTURE
    expect(reparsed.children).toHaveLength(3)
    expect(source).toContain('\n  "children": [')
  })
})
