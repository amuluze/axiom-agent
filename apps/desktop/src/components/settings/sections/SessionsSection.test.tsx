import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionsSection } from './SessionsSection'
import { buildSessionsHook, stubContext } from './testFixtures'
import {
  EMPTY_RECOVERY_SUMMARY,
  type RecoverySummary,
  type StoredAgentSession,
  type StorageStats,
} from '@/persistence/types'

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
  recoverySummary?: RecoverySummary
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
    recoverySummary: overrides.recoverySummary ?? EMPTY_RECOVERY_SUMMARY,
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
      recoverySummary: EMPTY_RECOVERY_SUMMARY,
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

  it('exposes explicit database maintenance only in desktop mode', () => {
    const html = renderSection({ storageStats: baseStats })
    expect(html).toContain('压缩数据库')
    const memoryOnly = renderSection({ storageStats: baseStats, desktop: false })
    expect(memoryOnly).not.toContain('压缩数据库')
  })

  it('shows the recovery summary with dispositions and re-authorization needs', () => {
    const recoverySummary: RecoverySummary = {
      recoveredRuns: 2,
      completedRuns: 1,
      failedRuns: 0,
      unknownRuns: 1,
      interruptedToolExecutions: 3,
      possiblyExecutedToolExecutions: 1,
      recoveredSessions: ['session-1'],
    }
    const session = stubSession({ id: 'session-1', activeToolNames: ['ssh', 'ssh_hosts', 'read'] })
    const html = renderSection({ sessions: [session], recoverySummary })
    expect(html).toContain('本次启动已安全结束 2 个中断运行')
    expect(html).toContain('已完成 1 个、已失败 0 个、状态未知 1 个')
    expect(html).toContain('中断工具调用 3 个')
  })
})
