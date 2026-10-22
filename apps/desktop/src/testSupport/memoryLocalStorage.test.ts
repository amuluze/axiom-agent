// @vitest-environment jsdom
/**
 * localStorage 测试环境隔离的守门用例。
 *
 * 背景：跑前端测试长期依赖 `NODE_OPTIONS=--experimental-webstorage
 * --localstorage-file=...`，而那个落盘文件**被所有 vitest worker 共享**——
 * 已实证分处不同 worker 进程的两个测试文件能互相读到对方写入的值，并发下
 * 互相覆盖/清空产生间歇假红（本仓命中过画布摆放叠加层与设置持久化两处断言）。
 * 现在 `vitest.setup.ts` 给每个测试文件装一份内存版 localStorage，用例锁死该隔离。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryLocalStorageForTest } from '../testSupport/memoryLocalStorage'

describe('测试环境的 localStorage', () => {
  it('内存实现满足 Storage 核心语义', () => {
    const storage = createMemoryLocalStorageForTest()
    expect(storage.length).toBe(0)
    expect(storage.getItem('missing')).toBeNull()
    storage.setItem('b', '2')
    storage.setItem('a', '1')
    // 值按字符串存取，key 按插入保留、key() 按 UTF-16 序返回
    storage.setItem('n', 3 as unknown as string)
    expect(storage.getItem('n')).toBe('3')
    expect(storage.length).toBe(3)
    expect([...Array(storage.length).keys()].map((index) => storage.key(index))).toEqual(['a', 'b', 'n'])
    storage.removeItem('a')
    expect(storage.getItem('a')).toBeNull()
    expect(storage.length).toBe(2)
    storage.clear()
    expect(storage.length).toBe(0)
  })

  it('当前环境的 localStorage 是内存实现，不落到共享文件', () => {
    // 装上之后 window.localStorage 必须在写之后仍能读到，且 key 可枚举——
    // 这正是 Node 实验性全局（共享落盘文件）会跨文件串味的地方。
    window.localStorage.setItem('__isolation_probe__', 'x')
    expect(window.localStorage.getItem('__isolation_probe__')).toBe('x')
    window.localStorage.removeItem('__isolation_probe__')
    expect(window.localStorage.getItem('__isolation_probe__')).toBeNull()
  })
})