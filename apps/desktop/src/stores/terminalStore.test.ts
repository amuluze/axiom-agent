import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore } from './terminalStore'

/**
 * 按工作区投影：每工作区至多一个终端条目；带 terminalId 的写入/移除只在匹配时生效，
 * 以此丢弃撤销或重启后迟到的 PTY 事件（验证验收 6/11/12 的前端半段）。
 */
describe('terminalStore per-workspace projection', () => {
  beforeEach(() => {
    useTerminalStore.setState({ entries: {} })
  })

  it('is idempotent when the same workspace is activated repeatedly', () => {
    const store = useTerminalStore.getState()
    store.upsertEntry('/ws/a', { terminalId: 'term-1', status: 'spawning' })
    store.upsertEntry('/ws/a', { terminalId: 'term-1', status: 'running' })
    const entries = useTerminalStore.getState().entries
    expect(Object.keys(entries)).toEqual(['/ws/a'])
    expect(entries['/ws/a']).toEqual({ terminalId: 'term-1', status: 'running' })
  })

  it('keeps different workspaces independent', () => {
    const store = useTerminalStore.getState()
    store.upsertEntry('/ws/a', { terminalId: 'term-1', status: 'running' })
    store.upsertEntry('/ws/b', { terminalId: 'term-2', status: 'running' })
    store.setEntryStatus('/ws/b', 'term-2', 'exited')
    const entries = useTerminalStore.getState().entries
    expect(entries['/ws/a']?.status).toBe('running')
    expect(entries['/ws/b']?.status).toBe('exited')
  })

  it('ignores status updates carrying a stale terminal id', () => {
    const store = useTerminalStore.getState()
    store.upsertEntry('/ws/a', { terminalId: 'term-1', status: 'running' })
    store.setEntryStatus('/ws/a', 'term-old', 'exited')
    expect(useTerminalStore.getState().entries['/ws/a']?.status).toBe('running')
  })

  it('does not resurrect a removed entry from a stale terminal id', () => {
    const store = useTerminalStore.getState()
    store.upsertEntry('/ws/a', { terminalId: 'term-1', status: 'running' })
    store.removeEntry('/ws/a', 'term-1')
    expect(useTerminalStore.getState().entries['/ws/a']).toBeUndefined()
    store.setEntryStatus('/ws/a', 'term-1', 'exited')
    expect(useTerminalStore.getState().entries['/ws/a']).toBeUndefined()
  })

  it('keeps the surviving entry when removal targets a stale terminal id', () => {
    const store = useTerminalStore.getState()
    store.upsertEntry('/ws/a', { terminalId: 'term-2', status: 'running' })
    store.removeEntry('/ws/a', 'term-1')
    expect(useTerminalStore.getState().entries['/ws/a']?.terminalId).toBe('term-2')
  })
})
