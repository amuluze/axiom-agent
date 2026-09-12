import { describe, expect, it, vi } from 'vitest'
import {
  createStorageStatsSlice,
  type StorageStatsDependencies,
  type StorageStatsSlice,
  type StorageStatsStateView,
} from './storageStatsSlice'
import type { SessionRepository } from '@/persistence/types'

interface MockState {
  view: StorageStatsStateView
  setCalls: Array<Partial<StorageStatsStateView>>
}

function makeState(): MockState {
  const view: StorageStatsStateView = {
    runtimeLifecycle: 'ready',
    storageStats: null,
    settingsError: null,
  }
  return { view, setCalls: [] }
}

function makeRepository(overrides: Partial<SessionRepository> = {}): SessionRepository {
  return {
    getStats: vi.fn(async () => ({ artifactBytes: 1, artifactCount: 1 })),
    ...overrides,
  } as unknown as SessionRepository
}

function buildSlice(args: { repository?: SessionRepository; state?: MockState } = {}): {
  slice: StorageStatsSlice
  state: MockState
  repo: SessionRepository
} {
  const state = args.state ?? makeState()
  const repo = args.repository ?? makeRepository()
  const deps: StorageStatsDependencies = {
    get: () => state.view,
    set: (partial) => {
      state.setCalls.push(partial)
      Object.assign(state.view, partial)
    },
    getRepository: () => repo,
  }
  return { slice: createStorageStatsSlice(deps), state, repo }
}

describe('storageStatsSlice', () => {
  it('refreshStorageStats stores the repository stats on success', async () => {
    const { slice, state, repo } = buildSlice()
    await slice.refreshStorageStats()
    expect(state.view.storageStats).toEqual({ artifactBytes: 1, artifactCount: 1 })
    expect(repo.getStats).toHaveBeenCalledTimes(1)
  })

  it('refreshStorageStats captures errors via settingsError', async () => {
    const state = makeState()
    const failingRepo = makeRepository({ getStats: vi.fn(async () => { throw new Error('boom') }) })
    const { slice } = buildSlice({ state, repository: failingRepo })
    await slice.refreshStorageStats()
    expect(state.view.settingsError).toBe('boom')
  })

  it('refreshStorageStats skips while the runtime is initializing', async () => {
    const state = makeState()
    state.view.runtimeLifecycle = 'initializing'
    const { slice, state: tracked, repo } = buildSlice({ state })
    await slice.refreshStorageStats()
    expect(tracked.setCalls).toEqual([])
    expect(repo.getStats).not.toHaveBeenCalled()
  })
})
