import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDesignMutations,
  designMutationPaths,
  isDesignMutationActive,
  recordDesignMutation,
} from './designAuthorActivity'

describe('designAuthorActivity', () => {
  afterEach(() => clearDesignMutations('session'))

  it('只提取会修改 .ax 的工具目标', () => {
    expect(designMutationPaths('edit', { path: '.pen/a.ax', edits: [] })).toEqual(['.pen/a.ax'])
    expect(designMutationPaths('write', { path: 'src/a.ts', content: '' })).toEqual([])
    expect(designMutationPaths('design_import', { source: 'a.pen', target: '.pen/a.ax' })).toEqual(['.pen/a.ax'])
    expect(designMutationPaths('apply_changes', {
      operations: [
        { type: 'patch-file', path: '.pen/a.ax' },
        { type: 'move', from: '.pen/old.ax', to: '.pen/new.ax' },
        { type: 'patch-file', path: 'src/a.ts' },
      ],
    })).toEqual(['.pen/a.ax', '.pen/old.ax', '.pen/new.ax'])
  })

  it('按会话与文件隔离，并兼容工作区绝对路径', () => {
    recordDesignMutation('session', 'edit', { path: '/workspace/.pen/a.ax', edits: [] })
    expect(isDesignMutationActive('session', '.pen/a.ax', '/workspace')).toBe(true)
    expect(isDesignMutationActive('session', '.pen/b.ax', '/workspace')).toBe(false)
    expect(isDesignMutationActive('other', '.pen/a.ax', '/workspace')).toBe(false)
    clearDesignMutations('session')
    expect(isDesignMutationActive('session', '.pen/a.ax', '/workspace')).toBe(false)
  })
})
