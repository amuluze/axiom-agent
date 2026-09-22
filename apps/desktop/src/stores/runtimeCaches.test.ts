import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/agent/runtime/AgentHarness', () => ({ AgentHarness: class {} }))

async function loadFresh() {
  vi.resetModules()
  return import('./runtimeCaches')
}

function makeHarnessStub(overrides: Partial<AgentHarness> = {}): AgentHarness {
  return {
    id: 'sess',
    isRunning: false,
    isDisposed: false,
    ...overrides,
  } as unknown as AgentHarness
}

describe('runtimeCaches', () => {
  beforeEach(async () => {
    const mod = await loadFresh()
    mod.dropRuntimeCachesForSession('seed')
  })

  it('preserves identity through getRuntimeSession / setRuntimeSession', async () => {
    const mod = await loadFresh()
    const harness = makeHarnessStub()
    mod.setRuntimeSession('a', harness)
    expect(mod.getRuntimeSession('a')).toBe(harness)
  })

  it('returns undefined for missing session id', async () => {
    const mod = await loadFresh()
    expect(mod.getRuntimeSession('missing')).toBeUndefined()
  })

  it('dropRuntimeCachesForSession atomically removes all four caches', async () => {
    const mod = await loadFresh()
    const harness = makeHarnessStub()
    mod.setRuntimeSession('a', harness)
    mod.setRuntimeProvider('a', { providerId: 'p' } as never, true)
    mod.setRuntimeProjection('a', {
      activeTools: {},
      endReason: null,
      error: null,
      compactionRunning: false,
      queuedMessages: [],
    })
    mod.setRuntimeBasePrompt('a', 'base-prompt-a')
    const removed = mod.dropRuntimeCachesForSession('a')
    expect(removed).toBe(harness)
    expect(mod.getRuntimeSession('a')).toBeUndefined()
    expect(mod.getRuntimeProvider('a')).toBeUndefined()
    expect(mod.getRuntimeProjection('a')).toBeUndefined()
    expect(mod.getRuntimeBasePrompt('a')).toBeUndefined()
  })

  it('keeps basePrompt mirror isolated per session (no cross-workspace leakage)', async () => {
    const mod = await loadFresh()
    mod.setRuntimeSession('a', makeHarnessStub({ id: 'a' } as unknown as Partial<AgentHarness>))
    mod.setRuntimeSession('b', makeHarnessStub({ id: 'b' } as unknown as Partial<AgentHarness>))
    mod.setRuntimeBasePrompt('a', 'base-prompt-for-workspace-x')
    mod.setRuntimeBasePrompt('b', 'base-prompt-for-workspace-y')
    // 各自读取自己的镜像，互不覆盖
    expect(mod.getRuntimeBasePrompt('a')).toBe('base-prompt-for-workspace-x')
    expect(mod.getRuntimeBasePrompt('b')).toBe('base-prompt-for-workspace-y')
    // 更新 b 不影响 a
    mod.setRuntimeBasePrompt('b', 'base-prompt-for-workspace-y-updated')
    expect(mod.getRuntimeBasePrompt('a')).toBe('base-prompt-for-workspace-x')
  })

  it('hasOtherRunningRuntime detects concurrent runtimes', async () => {
    const mod = await loadFresh()
    mod.setRuntimeSession('a', makeHarnessStub({ isRunning: true } as unknown as Partial<AgentHarness>))
    mod.setRuntimeSession('b', makeHarnessStub({ isRunning: false } as unknown as Partial<AgentHarness>))
    expect(mod.hasOtherRunningRuntime('a')).toBe(false)
    expect(mod.hasOtherRunningRuntime('b')).toBe(true)
  })

  it('evicts the least-recently-used idle session beyond the cache cap', async () => {
    const mod = await loadFresh()
    const disposed: string[] = []
    for (let i = 0; i < 9; i += 1) {
      mod.setRuntimeSession(`sess-${i}`, makeHarnessStub({
        id: `sess-${i}`,
        dispose: () => { disposed.push(`sess-${i}`) },
      } as unknown as Partial<AgentHarness>))
    }
    // 第 0 个最久未用 → 被逐出并 dispose；最新 8 个保留
    expect(mod.getRuntimeSession('sess-0')).toBeUndefined()
    expect(mod.getRuntimeSession('sess-8')).toBeDefined()
    expect(disposed).toContain('sess-0')
  })

  it('never evicts a running session', async () => {
    const mod = await loadFresh()
    const disposed: string[] = []
    for (let i = 0; i < 9; i += 1) {
      mod.setRuntimeSession(`sess-${i}`, makeHarnessStub({
        id: `sess-${i}`,
        isRunning: true,
        dispose: () => { disposed.push(`sess-${i}`) },
      } as unknown as Partial<AgentHarness>))
    }
    for (let i = 0; i < 9; i += 1) expect(mod.getRuntimeSession(`sess-${i}`)).toBeDefined()
    expect(disposed).toHaveLength(0)
  })

  it('re-accessing a session protects it from eviction (LRU ordering)', async () => {
    const mod = await loadFresh()
    const disposed: string[] = []
    for (let i = 0; i < 8; i += 1) {
      mod.setRuntimeSession(`sess-${i}`, makeHarnessStub({
        id: `sess-${i}`,
        dispose: () => { disposed.push(`sess-${i}`) },
      } as unknown as Partial<AgentHarness>))
    }
    // 重新访问最旧的 sess-0，使其成为最新
    mod.getRuntimeSession('sess-0')
    mod.setRuntimeSession('sess-8', makeHarnessStub({
      id: 'sess-8',
      dispose: () => { disposed.push('sess-8') },
    } as unknown as Partial<AgentHarness>))
    // 现在最久未用的是 sess-1
    expect(mod.getRuntimeSession('sess-0')).toBeDefined()
    expect(mod.getRuntimeSession('sess-1')).toBeUndefined()
    expect(disposed).toContain('sess-1')
  })

  it('notifies the eviction listener when LRU eviction drops a session', async () => {
    const mod = await loadFresh()
    const evicted: string[] = []
    mod.setRuntimeEvictionListener((id) => { evicted.push(id) })
    for (let i = 0; i < 9; i += 1) {
      mod.setRuntimeSession(`sess-${i}`, makeHarnessStub({
        id: `sess-${i}`,
        dispose: () => undefined,
      } as unknown as Partial<AgentHarness>))
    }
    // 溢出逐出 sess-0（最久未用）时回调收到其 id——agentStore 借此同步清理
    // sessionWorkspacePaths 等模块级映射，避免随历史会话单调增长。
    expect(evicted).toEqual(['sess-0'])
  })

  it('notifies the eviction listener on direct dropRuntimeCachesForSession too', async () => {
    const mod = await loadFresh()
    const dropped: string[] = []
    mod.setRuntimeEvictionListener((id) => { dropped.push(id) })
    mod.setRuntimeSession('a', makeHarnessStub({ id: 'a' } as unknown as Partial<AgentHarness>))
    mod.dropRuntimeCachesForSession('a')
    expect(dropped).toEqual(['a'])
  })

  it('tolerates drops without a registered eviction listener', async () => {
    const mod = await loadFresh()
    mod.setRuntimeSession('a', makeHarnessStub({ id: 'a' } as unknown as Partial<AgentHarness>))
    expect(() => mod.dropRuntimeCachesForSession('a')).not.toThrow()
  })
})
