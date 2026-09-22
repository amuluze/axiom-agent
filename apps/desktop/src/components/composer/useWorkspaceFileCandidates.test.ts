// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceEntry } from '@/platform/workspace'
import {
  buildWorkspaceGlobPattern,
  mergeFileCandidates,
  sortWorkspaceEntries,
  useWorkspaceFileCandidates,
  WORKSPACE_SEARCH_DEBOUNCE_MS,
  workspaceEntriesToCandidates,
} from './useWorkspaceFileCandidates'

const findWorkspaceFiles = vi.hoisted(() => vi.fn())

vi.mock('@/platform/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/platform/workspace')>()
  return {
    ...original,
    findWorkspaceFiles: findWorkspaceFiles,
  }
})

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  const useAgentStore = ((selector: (state: StoreState) => unknown): unknown =>
    selector({
      ...original.useAgentStore.getState(),
      authorizedWorkspace: { path: '/repo', name: 'repo', gitBranch: 'main' },
    })) as unknown as typeof original.useAgentStore
  useAgentStore.getState = () => original.useAgentStore.getState()
  return { ...original, useAgentStore }
})

describe('buildWorkspaceGlobPattern', () => {
  it('maps an empty query to the top-level listing glob', () => {
    expect(buildWorkspaceGlobPattern('')).toBe('*')
    expect(buildWorkspaceGlobPattern('  ')).toBe('*')
    expect(buildWorkspaceGlobPattern('**/*')).toBe('*')
  })

  it('builds a case-insensitive contains glob from the last path segment', () => {
    expect(buildWorkspaceGlobPattern('app')).toBe('**/*[aA][pP][pP]*')
    expect(buildWorkspaceGlobPattern('apps/des')).toBe('**/*[dD][eE][sS]*')
  })

  it('keeps non-cased characters literal and strips glob metacharacters', () => {
    expect(buildWorkspaceGlobPattern('a1-_.ts')).toBe('**/*[aA]1-_.[tT][sS]*')
    expect(buildWorkspaceGlobPattern('a*b?[c]')).toBe('**/*[aA][bB][cC]*')
    expect(buildWorkspaceGlobPattern('布局')).toBe('**/*布局*')
  })

  it('caps the query length', () => {
    const pattern = buildWorkspaceGlobPattern('x'.repeat(64))
    expect(pattern.startsWith('**/*')).toBe(true)
    expect(pattern.length).toBeLessThan(64 * 4)
  })
})

describe('mergeFileCandidates', () => {
  it('puts manual references first and dedupes by id', () => {
    const manual = [{ id: '/repo/src', label: 'src', isDirectory: true }]
    const workspace = [
      { id: '/repo/src', label: 'src', hint: '目录', isDirectory: true },
      { id: '/repo/src/main.ts', label: 'src/main.ts', hint: 'ts' },
    ]
    expect(mergeFileCandidates(manual, workspace)).toEqual([
      { id: '/repo/src', label: 'src', isDirectory: true },
      { id: '/repo/src/main.ts', label: 'src/main.ts', hint: 'ts' },
    ])
  })

  it('caps the merged list at the limit', () => {
    const manual = [{ id: '/repo/a', label: 'a' }]
    const workspace = Array.from({ length: 10 }, (_, index) => ({
      id: `/repo/file-${index}`,
      label: `file-${index}`,
    }))
    expect(mergeFileCandidates(manual, workspace, 5)).toHaveLength(5)
    expect(mergeFileCandidates(manual, workspace, 5)[0]!.id).toBe('/repo/a')
  })
})

describe('workspaceEntriesToCandidates', () => {
  it('maps entries to absolute-path ids with relative labels and type hints', () => {
    const entries: WorkspaceEntry[] = [
      { path: 'apps/desktop', name: 'desktop', kind: 'directory', sizeBytes: 0 },
      { path: 'apps/desktop/src/App.tsx', name: 'App.tsx', kind: 'file', sizeBytes: 12 },
    ]
    expect(workspaceEntriesToCandidates(entries, '/repo/', '目录')).toEqual([
      { id: '/repo/apps/desktop', label: 'apps/desktop', hint: '目录', group: 'workspace', relativePath: 'apps/desktop', isDirectory: true },
      { id: '/repo/apps/desktop/src/App.tsx', label: 'apps/desktop/src/App.tsx', hint: 'tsx', group: 'workspace', relativePath: 'apps/desktop/src/App.tsx' },
    ])
  })
})

describe('sortWorkspaceEntries', () => {
  it('puts directories first, then sorts by path', () => {
    const entries: WorkspaceEntry[] = [
      { path: 'zeta.md', name: 'zeta.md', kind: 'file', sizeBytes: 1 },
      { path: 'src', name: 'src', kind: 'directory', sizeBytes: 0 },
      { path: 'alpha.md', name: 'alpha.md', kind: 'file', sizeBytes: 1 },
      { path: 'apps', name: 'apps', kind: 'directory', sizeBytes: 0 },
    ]
    expect(sortWorkspaceEntries(entries).map((entry) => entry.path)).toEqual([
      'apps', 'src', 'alpha.md', 'zeta.md',
    ])
  })
})

describe('useWorkspaceFileCandidates', () => {
  beforeEach(() => {
    findWorkspaceFiles.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const Probe = ({ query, browseDir = null }: { query: string | null; browseDir?: string | null }) => {
    const candidates = useWorkspaceFileCandidates(query, browseDir)
    return createElement(
      'ul',
      null,
      candidates.map((candidate) => createElement('li', { key: candidate.id }, candidate.id)),
    )
  }

  it('lists the workspace top level (depth 1) for an empty query', async () => {
    findWorkspaceFiles.mockResolvedValue({ matches: [], truncated: false })
    render(createElement(Probe, { query: '' }))
    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_SEARCH_DEBOUNCE_MS + 10)
    })
    expect(findWorkspaceFiles.mock.calls[0]?.[0]).toMatchObject({ pattern: '*', maxDepth: 1 })
  })

  it('browses inside a directory when a browse root is given', async () => {
    findWorkspaceFiles.mockResolvedValue({ matches: [], truncated: false })
    render(createElement(Probe, { query: '', browseDir: 'apps' }))
    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_SEARCH_DEBOUNCE_MS + 10)
    })
    expect(findWorkspaceFiles.mock.calls[0]?.[0]).toMatchObject({
      pattern: '*',
      maxDepth: 1,
      path: 'apps',
    })
  })

  it('debounces the query and exposes workspace matches', async () => {
    findWorkspaceFiles.mockResolvedValue({
      matches: [
        { path: 'src/main.ts', name: 'main.ts', kind: 'file', sizeBytes: 1 },
      ] satisfies WorkspaceEntry[],
      truncated: false,
    })
    const { rerender } = render(createElement(Probe, { query: '' }))
    // 防抖窗口内不发起请求。
    rerender(createElement(Probe, { query: 'mai' }))
    expect(findWorkspaceFiles).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_SEARCH_DEBOUNCE_MS + 10)
    })
    expect(findWorkspaceFiles).toHaveBeenCalledTimes(1)
    expect(findWorkspaceFiles.mock.calls[0]?.[0]).toMatchObject({
      pattern: '**/*[mM][aA][iI]*',
      limit: 1000,
      workspacePath: '/repo',
    })
    expect(screen.getByText('/repo/src/main.ts')).toBeInTheDocument()
  })

  it('falls back to an empty list when the search fails (non-Tauri runtime)', async () => {
    findWorkspaceFiles.mockRejectedValue(new Error('Tauri API 不可用'))
    render(createElement(Probe, { query: 'x' }))
    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_SEARCH_DEBOUNCE_MS + 10)
    })
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})
