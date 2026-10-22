/**
 * `AxNode` 接口 ↔ `AX_ALLOWED_KEYS` 双向一致性（Domain Spec 不变量 3/9）。
 *
 * 二者是两份独立事实源：接口给类型、白名单给校验。接口加字段忘了登记进
 * `AX_NODE_KEY_NAMES` 由 `axSchema.ts` 的类型级穷尽断言在 `tsc` 阶段拦住；
 * 本文件补另一半——运行时断言每个 kind 的键集都是接口字段的子集、且所有 kind 的
 * 并集与接口字段集合相等（接口没有「永远不可用」的字段），并把「越界能力无处可写」
 * 变成可执行的回归断言（part 不带度量、非 overlay 不带定位）。
 */
import { describe, expect, it } from 'vitest'
import { AX_ALLOWED_KEYS, AX_NODE_KINDS, AX_NODE_KEY_NAMES } from './axSchema'

const INTERFACE_KEYS = new Set<string>(AX_NODE_KEY_NAMES)

describe('AX_ALLOWED_KEYS 与 AxNode 接口一致性', () => {
  it('每个 kind 的键集都来自接口字段（白名单没有接口未声明的键）', () => {
    for (const kind of AX_NODE_KINDS) {
      const unknown = AX_ALLOWED_KEYS[kind].filter((key) => !INTERFACE_KEYS.has(key))
      expect(unknown, `${kind} 的白名单出现 AxNode 未声明的键`).toEqual([])
    }
  })

  it('接口字段并集等于各 kind 白名单并集（没有永远不可用的字段）', () => {
    const union = new Set(Object.values(AX_ALLOWED_KEYS).flatMap((keys) => [...keys]))
    expect([...union].sort()).toEqual([...INTERFACE_KEYS].sort())
  })

  it('每个 kind 都带 id/kind，键集无重复', () => {
    for (const kind of AX_NODE_KINDS) {
      const keys = AX_ALLOWED_KEYS[kind]
      expect(new Set(keys).size, `${kind} 键集有重复项`).toBe(keys.length)
      expect(keys).toContain('id')
      expect(keys).toContain('kind')
    }
  })

  it('越界能力无处可写：part 不带度量，非 overlay 不带定位', () => {
    // part 是语义部件，度量由实现侧规范表决定（规则 9）。
    for (const key of [
      'width', 'height', 'padding', 'gap', 'cornerRadius', 'fontSize', 'strokeWidth',
      'justifyContent', 'alignItems', 'layout', 'children',
    ]) {
      expect(AX_ALLOWED_KEYS.part, `part 不该允许 ${key}`).not.toContain(key)
    }
    // 绝对定位只存在于 overlay（规则 4）：连 x/y 这类字段名都不给。
    for (const kind of AX_NODE_KINDS.filter((item) => item !== 'overlay')) {
      for (const key of ['anchor', 'offset', 'x', 'y', 'position', 'left', 'top']) {
        expect(AX_ALLOWED_KEYS[kind], `${kind} 不该允许定位字段 ${key}`).not.toContain(key)
      }
    }
  })
})
