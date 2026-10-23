import { describe, expect, it } from 'vitest'
import { createWorkspaceScanCache } from './workspaceScanCache'

describe('workspaceScanCache', () => {
  it('reuses a scan within the TTL and expires afterwards', () => {
    let clock = 0
    const cache = createWorkspaceScanCache<string>({ ttlMs: 10_000, now: () => clock })
    cache.set('/repo', 'first')

    clock = 9_999
    expect(cache.get('/repo')).toBe('first')

    clock = 10_001
    expect(cache.get('/repo')).toBeUndefined()
    // 过期即删除：之后再次读取不会复活旧值。
    clock = 10_002
    expect(cache.get('/repo')).toBeUndefined()
  })

  it('isolates workspaces and supports explicit invalidation', () => {
    const cache = createWorkspaceScanCache<string>({ ttlMs: 60_000 })
    cache.set('/a', 'a')
    cache.set('/b', 'b')

    expect(cache.get('/a')).toBe('a')
    expect(cache.get('/b')).toBe('b')

    cache.invalidate('/a')
    expect(cache.get('/a')).toBeUndefined()
    expect(cache.get('/b')).toBe('b')

    cache.clear()
    expect(cache.get('/b')).toBeUndefined()
  })
})
