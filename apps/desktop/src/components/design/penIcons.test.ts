import { describe, expect, it } from 'vitest'
import { resolvePenIcon, resolvePenIconLazy } from './penIcons'

describe('penIcons 图标解析（静态词表 + 懒加载兜底）', () => {
  it('静态映射：高频名同步命中，未知名返回 undefined', () => {
    expect(resolvePenIcon('trash-2')).toBeDefined()
    expect(resolvePenIcon('sparkles')).toBeDefined()
    expect(resolvePenIcon(undefined)).toBeUndefined()
  })

  it('懒加载兜底：词表外的合法 lucide 名可解析（kebab→Pascal 查全量命名空间）', async () => {
    // 'bell' / 'bell-ring' 是合法 lucide 图标、不在静态词表。
    expect(resolvePenIcon('bell')).toBeUndefined()
    expect(await resolvePenIconLazy('bell')).toBeDefined()
    expect(await resolvePenIconLazy('bell-ring')).toBeDefined()
    // 静态命中的名字走懒加载入口同样直接返回（短路径）。
    expect(await resolvePenIconLazy('trash-2')).toBeDefined()
  })

  it('懒加载兜底：不存在的名字返回 undefined（与静态路径同口径降级）', async () => {
    expect(await resolvePenIconLazy('totally-not-an-icon')).toBeUndefined()
    expect(await resolvePenIconLazy(undefined)).toBeUndefined()
  })
})
