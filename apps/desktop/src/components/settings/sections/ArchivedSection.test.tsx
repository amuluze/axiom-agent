import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArchivedSection } from './ArchivedSection'
import type { StoredAgentSession } from '@/persistence/types'

const mocks = vi.hoisted(() => ({
  sessions: [] as StoredAgentSession[],
  activeSessionId: null as string | null,
  restoreSession: vi.fn(),
  deleteSession: vi.fn(),
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      sessions: mocks.sessions,
      activeSessionId: mocks.activeSessionId,
      restoreSession: mocks.restoreSession,
      deleteSession: mocks.deleteSession,
    } as StoreState),
  }
})

afterEach(() => {
  mocks.sessions = []
  mocks.activeSessionId = null
  mocks.restoreSession.mockClear()
  mocks.deleteSession.mockClear()
})

const stubSession = (overrides: Partial<StoredAgentSession> = {}): StoredAgentSession => ({
  id: 'session-1',
  title: 'Sprint planning',
  systemPrompt: '',
  modelProvider: 'generic-anthropic-compatible',
  modelId: 'claude-test',
  reasoning: null,
  activeToolNames: [],
  providerConfig: null,
  runtimeManifest: null,
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  messageCount: 8,
  parentSessionId: null,
  forkedFromMessageId: null,
  branchKind: null,
  retriedMessageId: null,
  archivedAt: Date.now() - 1000 * 60 * 5,
  workspace: { path: '/repo/project', name: 'project', gitBranch: 'main' },
  ...overrides,
})

describe('ArchivedSection', () => {
  it('shows an empty state when no archived sessions exist', () => {
    const html = renderToStaticMarkup(createElement(ArchivedSection))
    expect(html).toContain('没有已归档的会话')
    expect(html).toContain('archived-empty')
    expect(html).toContain('0 个')
  })

  it('groups archived sessions by workspace and displays counts', () => {
    mocks.sessions = [
      stubSession({ id: 'a', title: 'Alpha', workspace: { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' } }),
      stubSession({ id: 'b', title: 'Beta', workspace: { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' } }),
      stubSession({ id: 'c', title: 'Gamma', workspace: { path: '/repo/beta', name: 'beta', gitBranch: 'main' } }),
    ]
    const html = renderToStaticMarkup(createElement(ArchivedSection))
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
    expect(html).toContain('2 个')
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
    expect(html).toContain('Gamma')
    expect(html).toContain('3 个')
  })

  it('renders restore and delete actions for each session', () => {
    mocks.sessions = [stubSession({ id: 'a', title: 'Alpha' })]
    const html = renderToStaticMarkup(createElement(ArchivedSection))
    expect(html).toContain('取消归档')
    expect(html).toContain('删除会话')
  })

  it('highlights the currently active session', () => {
    mocks.sessions = [stubSession({ id: 'a', title: 'Alpha' })]
    mocks.activeSessionId = 'a'
    const html = renderToStaticMarkup(createElement(ArchivedSection))
    expect(html).toContain('archived-item--active')
  })
})
