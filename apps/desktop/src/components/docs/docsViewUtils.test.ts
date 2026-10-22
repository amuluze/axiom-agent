import { describe, expect, it } from 'vitest'
import {
  OVERSIZED_LINE_PLACEHOLDER,
  headingId,
  isExternalHttpLink,
  resolveRelativeDocPath,
  splitLink,
} from './docsViewUtils'

describe('docsViewUtils', () => {
  it('resolveRelativeDocPath 归一 . 与 ..，并拒绝越界/绝对/协议链接', () => {
    expect(resolveRelativeDocPath('.specs/tasks/a.md', '../domain/b.md')).toBe('.specs/domain/b.md')
    expect(resolveRelativeDocPath('.specs/tasks/a.md', './b.md')).toBe('.specs/tasks/b.md')
    // 越界必须整条拒绝：夹在中间的 .. 不能被「悄悄吃掉」。
    expect(resolveRelativeDocPath('.specs/tasks/a.md', '../../../out.md')).toBeNull()
    expect(resolveRelativeDocPath('.specs/tasks/a.md', '/etc/passwd')).toBeNull()
    expect(resolveRelativeDocPath('.specs/tasks/a.md', 'https://example.com')).toBeNull()
  })

  it('resolveRelativeDocPath 解码百分号编码并剥离 fragment', () => {
    expect(resolveRelativeDocPath('.docs/a.md', 'b%20c.md#sec')).toBe('.docs/b c.md')
    // 非法编码返回 null（不能让 URIError 冒到渲染层）。
    expect(resolveRelativeDocPath('.docs/a.md', '%E0%A4%A')).toBeNull()
  })

  it('headingId 归一为锚点 id：小写、去符号、空白转连字符', () => {
    expect(headingId('Hello World')).toBe('hello-world')
    expect(headingId('第 1 章：概述')).toBe('第-1-章概述')
    expect(headingId('a -- b')).toBe('a-b')
  })

  it('splitLink 只在真正的 # 处分段', () => {
    expect(splitLink('a.md#x')).toEqual({ path: 'a.md', fragment: 'x' })
    expect(splitLink('a.md')).toEqual({ path: 'a.md', fragment: null })
  })

  it('isExternalHttpLink 只把 http(s) 当外部链接', () => {
    expect(isExternalHttpLink('http://example.com')).toBe(true)
    expect(isExternalHttpLink('https://example.com')).toBe(true)
    expect(isExternalHttpLink('file:///tmp/a.md')).toBe(false)
  })

  it('超长行占位正则只命中宿主生成的提示', () => {
    expect(OVERSIZED_LINE_PLACEHOLDER.test(
      '[Line 12 is 200000 bytes, exceeds the 128 KiB read output limit. Use a narrower offset/limit ...]',
    )).toBe(true)
    expect(OVERSIZED_LINE_PLACEHOLDER.test('普通正文，没有宿主提示')).toBe(false)
  })
})
