import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentSession } from '@/persistence/types'

vi.mock('@/platform/environment', () => ({ isTauriRuntime: () => true }))

const createLocalStorage = (): Storage => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as unknown as Storage
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', createLocalStorage())
})

type SessionMetadataModule = typeof import('./sessionMetadata')

const loadModule = async (): Promise<SessionMetadataModule> => import('./sessionMetadata')

const storedSession = (
  id: string,
  overrides: Partial<Pick<StoredAgentSession, 'workspace' | 'archivedAt'>> = {},
): StoredAgentSession => ({ id, title: 't', createdAt: 1, updatedAt: 1, status: 'idle', messages: [], ...overrides }) as unknown as StoredAgentSession

describe('sessionMetadata hydration invariant', () => {
  it('prefers the DB workspace and syncs localStorage back to it', async () => {
    const module = await loadModule()
    const dbWorkspace = { path: '/repo', name: 'repo' }
    // localStorage 中残留一条过期的 workspace（与 DB 冲突）
    module.updateSessionMetadata('session-1', {
      workspace: { path: '/stale', name: 'stale' },
    })
    const hydrated = module.hydrateSessionMetadata(
      storedSession('session-1', { workspace: dbWorkspace }),
    )
    expect(hydrated.workspace).toEqual(dbWorkspace)
    // localStorage 缓存被 DB 值覆盖
    expect(module.persistedWorkspacePaths()).toEqual(['/repo'])
  })

  it('falls back to localStorage metadata when the DB has no workspace', async () => {
    const module = await loadModule()
    module.updateSessionMetadata('session-1', {
      workspace: { path: '/cached', name: 'cached' },
      archivedAt: 42,
    })
    const hydrated = module.hydrateSessionMetadata(storedSession('session-1'))
    expect(hydrated.workspace).toEqual({ path: '/cached', name: 'cached' })
    expect(hydrated.archivedAt).toBe(42)
  })

  it('does not let a stale localStorage workspace override the DB workspace', async () => {
    const module = await loadModule()
    module.updateSessionMetadata('session-1', {
      workspace: { path: '/stale', name: 'stale' },
    })
    const hydrated = module.hydrateSessionMetadata(
      storedSession('session-1', { workspace: { path: '/db', name: 'db' } }),
    )
    expect(hydrated.workspace).toEqual({ path: '/db', name: 'db' })
  })

  it('clears workspace metadata only for the targeted sessions', async () => {
    const module = await loadModule()
    module.updateSessionMetadata('session-a', { workspace: { path: '/repo', name: 'repo' } })
    module.updateSessionMetadata('session-b', { workspace: { path: '/repo', name: 'repo' } })
    module.removeWorkspaceSessionMetadataForSessions(['session-a'])
    const hydratedA = module.hydrateSessionMetadata(storedSession('session-a'))
    const hydratedB = module.hydrateSessionMetadata(storedSession('session-b'))
    expect(hydratedA.workspace).toBeNull()
    expect(hydratedB.workspace).toEqual({ path: '/repo', name: 'repo' })
  })

  it('dedupes persisted workspace paths across sessions', async () => {
    const module = await loadModule()
    module.updateSessionMetadata('session-a', { workspace: { path: '/repo', name: 'repo' } })
    module.updateSessionMetadata('session-b', { workspace: { path: '/repo', name: 'repo' } })
    expect(module.persistedWorkspacePaths()).toEqual(['/repo'])
  })
})
