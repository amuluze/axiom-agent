import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isCaretOnFirstLine,
  loadComposerHistory,
  recordComposerHistoryEntry,
  recordComposerInput,
} from './inputHistory'

const installWindowStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
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
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size
      },
    },
  })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('recordComposerInput', () => {
  it('ignores blank content', () => {
    expect(recordComposerInput(['旧任务'], '   ')).toEqual(['旧任务'])
    expect(recordComposerInput([], '')).toEqual([])
  })

  it('skips a duplicate of the newest entry even when padded', () => {
    expect(recordComposerInput(['修复登录'], '  修复登录  ')).toEqual(['修复登录'])
  })

  it('promotes an older duplicate to the front (MRU)', () => {
    expect(recordComposerInput(['甲', '乙', '丙'], '丙')).toEqual(['丙', '甲', '乙'])
  })

  it('inserts new content at the front', () => {
    expect(recordComposerInput(['乙'], '甲')).toEqual(['甲', '乙'])
  })

  it('drops entries beyond the size limit, oldest first', () => {
    const full = Array.from({ length: 100 }, (_, index) => `任务-${index}`)
    const next = recordComposerInput(full, '新任务')
    expect(next).toHaveLength(100)
    expect(next[0]).toBe('新任务')
    expect(next).not.toContain('任务-99')
  })

  it('refuses oversized entries but accepts the boundary length', () => {
    const boundary = '长'.repeat(20_000)
    expect(recordComposerInput([], boundary)).toEqual([boundary])
    expect(recordComposerInput([], '长'.repeat(20_001))).toEqual([])
  })
})

describe('caret line boundaries', () => {
  const multiline = '第一行\n第二行\n第三行'

  it('treats any caret in a single-line value as on the first line', () => {
    expect(isCaretOnFirstLine('单行', 1)).toBe(true)
  })

  it('detects the first line only before any newline', () => {
    expect(isCaretOnFirstLine(multiline, 0)).toBe(true)
    expect(isCaretOnFirstLine(multiline, 3)).toBe(true)
    expect(isCaretOnFirstLine(multiline, 4)).toBe(false)
    expect(isCaretOnFirstLine(multiline, multiline.length)).toBe(false)
  })
})

describe('loadComposerHistory', () => {
  it('returns an empty history outside the browser runtime', () => {
    expect(loadComposerHistory()).toEqual([])
  })

  it('round-trips a persisted array', () => {
    installWindowStorage().set('axiom.composer.history.v1', JSON.stringify(['新', '旧']))
    expect(loadComposerHistory()).toEqual(['新', '旧'])
  })

  it('fails safe on corrupted payloads', () => {
    const store = installWindowStorage()
    store.set('axiom.composer.history.v1', '{oops')
    expect(loadComposerHistory()).toEqual([])
    store.set('axiom.composer.history.v1', JSON.stringify({ not: 'an array' }))
    expect(loadComposerHistory()).toEqual([])
    store.set('axiom.composer.history.v1', JSON.stringify('字符串也不是数组'))
    expect(loadComposerHistory()).toEqual([])
  })

  it('filters out non-string and blank entries', () => {
    const store = installWindowStorage()
    store.set('axiom.composer.history.v1', JSON.stringify(['有效', 42, null, '   ', '']))
    expect(loadComposerHistory()).toEqual(['有效'])
  })
})

describe('recordComposerHistoryEntry', () => {
  it('persists recorded entries and returns the updated history', () => {
    installWindowStorage()
    expect(recordComposerHistoryEntry('第一条')).toEqual(['第一条'])
    expect(recordComposerHistoryEntry('第二条')).toEqual(['第二条', '第一条'])
    expect(loadComposerHistory()).toEqual(['第二条', '第一条'])
  })

  it('survives a storage write failure', () => {
    const store = installWindowStorage()
    store.set('axiom.composer.history.v1', JSON.stringify(['既有']))
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: () => {
          throw new Error('quota exceeded')
        },
        removeItem: (key: string) => {
          store.delete(key)
        },
        clear: () => {
          store.clear()
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
          return store.size
        },
      },
    })
    expect(() => recordComposerHistoryEntry('新条目')).not.toThrow()
  })
})
