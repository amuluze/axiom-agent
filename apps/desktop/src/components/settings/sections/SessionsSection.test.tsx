import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionsSection } from './SessionsSection'
import { buildSessionsHook, stubContext } from './testFixtures'
import type { StoredAgentSession, StorageStats } from '@/persistence/types'

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
  ...overrides,
})

const baseStats: StorageStats = {
  sessionCount: 3,
  messageCount: 45,
  runCount: 7,
  toolExecutionCount: 18,
  providerRequestCount: 9,
  checkpointCount: 4,
  artifactCount: 12,
  databaseBytes: 1024 * 1024 * 2,
  artifactBytes: 1024 * 1024 * 10,
  artifactTrashCount: 3,
  artifactTrashBytes: 1024 * 512,
}

const renderSection = (overrides: {
  sessions?: StoredAgentSession[]
  storageStats?: StorageStats | null
  desktop?: boolean
  recoveredRuns?: number
} = {}) => {
  const sessions = overrides.sessions ?? [stubSession()]
  return renderToStaticMarkup(createElement(SessionsSection, {
    hook: buildSessionsHook({ sessions, storageStats: overrides.storageStats ?? null }),
    context: stubContext,
    tree: sessions.map((session) => ({
      session,
      depth: session.parentSessionId ? 1 : 0,
      hasChildren: false,
      orphaned: false,
    })),
    titleById: new Map(),
    storageStats: overrides.storageStats ?? null,
    recoveredRuns: overrides.recoveredRuns ?? 0,
    desktop: overrides.desktop ?? true,
  }))
}

describe('SessionsSection', () => {
  it('lists every session and exposes create + delete actions', () => {
    const html = renderSection()
    expect(html).toContain('Sprint planning')
    expect(html).toContain('新建会话')
    expect(html).toContain('删除')
  })

  it('shows the session count in the section state', () => {
    const html = renderSection({
      sessions: [stubSession({ id: 'a' }), stubSession({ id: 'b' })],
    })
    expect(html).toContain('2 个会话')
  })

  it('displays branch kind labels for retry and branch sessions', () => {
    const html = renderSection({
      sessions: [
        stubSession({ id: 'r', branchKind: 'retry' }),
        stubSession({ id: 'b', branchKind: 'branch' }),
      ],
    })
    expect(html).toContain('Retry 分支')
    expect(html).toContain('分支')
  })

  it('shows the parent lineage for sessions that have a parentSessionId', () => {
    const titleById = new Map([['parent-1', 'parent-session']])
    const session = stubSession({ id: 'child', parentSessionId: 'parent-1' })
    const html = renderToStaticMarkup(createElement(SessionsSection, {
      hook: buildSessionsHook({ sessions: [session] }),
      context: stubContext,
      tree: [{ session, depth: 1, hasChildren: false, orphaned: false }],
      titleById,
      storageStats: null,
      recoveredRuns: 0,
      desktop: true,
    }))
    expect(html).toContain('源自 parent-session')
  })

  it('renders storage statistics with formatted values when present', () => {
    const html = renderSection({ storageStats: baseStats })
    expect(html).toContain('消息 45')
    expect(html).toContain('运行 7')
    expect(html).toContain('工具 18')
    expect(html).toContain('检查点 4')
    expect(html).toContain('Artifact 12 项')
    expect(html).toContain('SQLite 2.0 MiB')
    expect(html).toContain('有效 Artifact 10.0 MiB')
  })

  it('hides storage stats section in memory-only (non-desktop) mode', () => {
    const html = renderSection({ storageStats: baseStats, desktop: false })
    expect(html).not.toContain('SQLite 2.0 MiB')
    expect(html).toContain('内存模式')
  })

  it('shows the recovered runs banner when runs were recovered', () => {
    const html = renderSection({ recoveredRuns: 2 })
    expect(html).toContain('本次启动已安全结束 2 个中断运行')
  })
})