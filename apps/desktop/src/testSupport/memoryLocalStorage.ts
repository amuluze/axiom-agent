/**
 * 每测试文件独立的内存版 `localStorage`（替代 Node 的实验性全局）。
 *
 * **为什么需要它**：跑前端测试一直要带
 * `NODE_OPTIONS="--experimental-webstorage --localstorage-file=/tmp/..."`——
 * Node 的 `globalThis.localStorage` 是实验特性、且**所有 vitest worker 共享同一个落盘文件**。
 * 已实证：分处不同 worker 进程的两个测试文件，B 能读到 A 写入的值。于是并发运行下
 * 互相覆盖/清空，产生间歇性假红（本仓已命中 `DesignCanvas` 的摆放叠加层断言与
 * `BrowserSection` 的配置持久化断言）。AGENTS.md 记的「Node 26 的 localStorage 占位
 * 会遮蔽 jsdom 环境」也是同一个根因的另一面。
 *
 * 装在**每个测试文件**自己的环境里（`vitest.setup.ts` 每个文件都跑一遍），
 * 因此文件之间彻底隔离，也不再需要 NODE_OPTIONS——那是给进程内所有测试共用的。
 *
 * 只实现 Web Storage 的核心面；`window.localStorage` 的类型是 DOM 的 `Storage`，
 * 这里显式满足该接口。测试若需要「跨文件共享」语义，那本身就该是显式 fixture
 * 而不是环境泄漏。
 */
export interface MemoryLocalStorage extends Storage {
  /** 清空并返回条目数（便于断言与调试）。 */
  reset(): void
}

const createMemoryLocalStorage = (): MemoryLocalStorage => {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    key(index: number): string | null {
      // 规范要求按 key 的 UTF-16 序升序；Map 是插入序，故显式排序。
      return [...entries.keys()].sort()[index] ?? null
    },
    getItem(key: string): string | null {
      return entries.get(String(key)) ?? null
    },
    setItem(key: string, value: string): void {
      entries.set(String(key), String(value))
    },
    removeItem(key: string): void {
      entries.delete(String(key))
    },
    clear(): void {
      entries.clear()
    },
    reset(): void {
      entries.clear()
    },
  }
}

/** 供测试直接构造一份独立存储（不装到全局）。 */
export const createMemoryLocalStorageForTest = (): MemoryLocalStorage => createMemoryLocalStorage()

/**
 * 把内存版 localStorage 装到当前测试环境。仅 DOM 环境生效（node 环境无 window），
 * 也不覆盖已存在的原生实现——若某天 jsdom 提供了按 window 隔离的实现，那正是我们要的。
 */
export const installMemoryLocalStorage = (): void => {
  if (typeof globalThis.window === 'undefined') return
  const target = globalThis.window as Window & { localStorage?: Storage }
  const native = Object.getOwnPropertyDescriptor(target, 'localStorage')
  // 原生实现存在且可写 → 已被 jsdom 之类按环境隔离的实现接管，不必干预。
  if (native && !native.configurable) return
  const storage = createMemoryLocalStorage()
  for (const scope of [globalThis.window, globalThis]) {
    Object.defineProperty(scope, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    })
  }
}