import { describe, expect, it } from 'vitest'
import { removeRootJsonArrayItem } from './removeJsonArrayItem'

describe('removeRootJsonArrayItem', () => {
  it('只移除格式化数组中的目标项', () => {
    const source = `{
  "before": { "pages": ["nested"] },
  "pages": [
    { "id": "p1", "text": "},]" },
    { "id": "p2", "children": [{ "value": "\\\"" }] },
    { "id": "p3" }
  ],
  "after": true
}
`
    const result = removeRootJsonArrayItem(source, 'pages', 1)
    expect(JSON.parse(result)).toMatchObject({ pages: [{ id: 'p1' }, { id: 'p3' }] })
    expect(result).toContain('"before": { "pages": ["nested"] }')
    expect(result).toContain('"after": true')
    expect(result.endsWith('\n')).toBe(true)
  })

  it('支持首项、末项与压缩 JSON', () => {
    const source = '{"pages":[{"id":"a"},{"id":"b"},{"id":"c"}],"keep":1}'
    expect(JSON.parse(removeRootJsonArrayItem(source, 'pages', 0)).pages).toEqual([{ id: 'b' }, { id: 'c' }])
    expect(JSON.parse(removeRootJsonArrayItem(source, 'pages', 2)).pages).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('单项数组移除后保持合法 JSON', () => {
    expect(JSON.parse(removeRootJsonArrayItem('{"pages":[{"id":"a"}]}', 'pages', 0))).toEqual({ pages: [] })
  })
})
