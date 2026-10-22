import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceFindResult } from '@/platform/workspace'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import {
  createScopedReadEnvironment,
  normalizeScope,
  pathWithinScope,
} from './scopedReadEnvironment'

const readOptions = () => ({ allowedToolNames: ['read', 'ls', 'grep', 'find'], signal: new AbortController().signal })

const defaultWorkspace = { path: '/workspace/repo', name: 'repo', gitBranch: 'main' }

const envWith = (overrides: {
  readText?: (path: string) => Promise<{ workspace: typeof defaultWorkspace; path: string; content: string; sha256: string; startLine: number; endLine: number; totalLines: number; truncated: boolean }>
  list?: (path?: string) => Promise<{ workspace: typeof defaultWorkspace; directory: string; entries: { path: string; name: string; kind: 'directory' | 'file'; sizeBytes: number }[]; truncated: boolean }>
  find?: (path?: string) => Promise<{ workspace: typeof defaultWorkspace; pattern: string; rootPath: string; matches: { path: string; name: string; kind: 'directory' | 'file'; sizeBytes: number }[]; truncated: boolean }>
}) => createFakeAgentEnvironment({
  readText: overrides.readText,
  list: overrides.list,
  find: overrides.find
    ? async (request): Promise<WorkspaceFindResult> => {
        const result = await overrides.find?.(request.path)
        if (!result) throw new Error('fake find returned no result')
        return { ...result } as WorkspaceFindResult
      }
    : undefined,
})

describe('normalizeScopeEntry', () => {
  it('scope 不能扩大父权限：base 拒绝时 scoped 同样失败', async () => {
    const base = envWith({
      readText: async () => { throw new Error('base denied') },
    })
    const scoped = createScopedReadEnvironment(base, [], readOptions())
    await expect(scoped.workspace.readText('src/a.ts')).rejects.toThrow('base denied')
  })

  it('normalizeScope 去重并排序', () => {
    expect(normalizeScope(['pkg', 'src', 'src/', 'pkg'])).toEqual(['pkg', 'src'])
  })
})


describe('父能力与范围纵深防线', () => {
  it('缺父网页或读取工具时宿主通道拒绝，禁止旁路调用', async () => {
    const base = createFakeAgentEnvironment()
    const environment = createScopedReadEnvironment(base, [], { allowedToolNames: ['grep'], signal: new AbortController().signal })
    await expect(environment.workspace.readText('src/a.ts')).rejects.toThrow('read')
    await expect(environment.workspace.list()).rejects.toThrow('ls')
    expect(base.workspace.readText).not.toHaveBeenCalled()
  })

  it('UI 探索通道对子代理结构性不可达：读、写两条通道都封死', async () => {
    const base = createFakeAgentEnvironment()
    const environment = createScopedReadEnvironment(base, ['src'], readOptions())
    await expect(environment.browser.command({ action: 'tabs' })).rejects.toThrow('browser.command')
    await expect(environment.browser.write({ action: 'click', tabId: 'tab-1', ref: 1 }))
      .rejects.toThrow('browser.write')
    expect(base.browser.command).not.toHaveBeenCalled()
    expect(base.browser.write).not.toHaveBeenCalled()
  })

  it('API 出网对子代理结构性不可达：api 通道封死', async () => {
    const base = createFakeAgentEnvironment()
    const environment = createScopedReadEnvironment(base, ['src'], readOptions())
    await expect(environment.api.runStep({
      runId: 'run-1',
      stepId: 'call-1',
      step: { id: 'call-1', action: 'api.request', method: 'GET', url: 'https://api.example.test/v1' },
    }, new AbortController().signal)).rejects.toThrow('api.runStep')
    expect(base.api.runStep).not.toHaveBeenCalled()
  })

  it('单范围默认检索在宿主请求前收窄，多范围省略 path 则零访问', async () => {
    const base = createFakeAgentEnvironment({
      list: async (path) => ({ workspace: defaultWorkspace, directory: path ?? '.', entries: [], truncated: false }),
      find: async (request) => ({ workspace: defaultWorkspace, pattern: request.pattern, rootPath: request.path ?? '.', matches: [], truncated: false }),
    })
    const one = createScopedReadEnvironment(base, ['src'], readOptions())
    const signal = new AbortController().signal
    await one.workspace.list()
    await one.workspace.searchText({ requestId: 'r', pattern: 'x' }, signal)
    await one.workspace.find({ requestId: 'f', pattern: '*', signal })
    expect(base.workspace.list).toHaveBeenCalledWith('src', undefined)
    expect(base.workspace.searchText).toHaveBeenCalledWith(expect.objectContaining({ path: 'src' }), signal)
    expect(base.workspace.find).toHaveBeenCalledWith(expect.objectContaining({ path: 'src' }))
    vi.clearAllMocks()
    const multiple = createScopedReadEnvironment(base, ['src', 'docs'], readOptions())
    await expect(multiple.workspace.list()).rejects.toThrow('请指定')
    await expect(multiple.workspace.searchText({ requestId: 'r', pattern: 'x' }, signal)).rejects.toThrow('请指定')
    await expect(multiple.workspace.find({ requestId: 'f', pattern: '*', signal })).rejects.toThrow('请指定')
    expect(base.workspace.list).not.toHaveBeenCalled()
    expect(base.workspace.searchText).not.toHaveBeenCalled()
    expect(base.workspace.find).not.toHaveBeenCalled()
  })

  it('无范围不能允许绝对路径或遍历，非法声明不能退化成全工作区', async () => {
    const base = createFakeAgentEnvironment()
    expect(() => createScopedReadEnvironment(base, ['src', '../secret'], readOptions())).toThrow('范围')
    const environment = createScopedReadEnvironment(base, [], readOptions())
    await expect(environment.workspace.readText('/etc/passwd')).rejects.toThrow('范围')
    await expect(environment.workspace.readText('../outside')).rejects.toThrow('范围')
    expect(base.workspace.readText).not.toHaveBeenCalled()
  })

  it('keeps scope boundaries for generated sibling paths', () => {
    const random = { value: 0x13579bdf }
    const next = (): number => {
      random.value = (random.value * 1664525 + 1013904223) >>> 0
      return random.value
    }
    for (let iteration = 0; iteration < 256; iteration += 1) {
      const scope = `src/module-${next() % 997}/part-${next() % 997}`
      expect(pathWithinScope(scope, [scope])).toBe(true)
      expect(pathWithinScope(`${scope}/file.ts`, [scope])).toBe(true)
      expect(pathWithinScope(`${scope}extra`, [scope])).toBe(false)
      expect(pathWithinScope(`${scope}-sibling/file.ts`, [scope])).toBe(false)
      expect(pathWithinScope(`../${scope}/file.ts`, [scope])).toBe(false)
      expect(() => normalizeScope([`../${scope}`])).toThrow('范围')
    }
  })

  it('委托取消后拒绝迟到读取与新的宿主访问', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const base = createFakeAgentEnvironment({ readText: async () => {
      await held
      return { workspace: defaultWorkspace, path: 'src/a.ts', content: 'late', sha256: 'a'.repeat(64), startLine: 1, endLine: 1, totalLines: 1, truncated: false }
    } })
    const controller = new AbortController()
    const environment = createScopedReadEnvironment(base, ['src'], { allowedToolNames: ['read'], signal: controller.signal })
    const pending = environment.workspace.readText('src/a.ts')
    controller.abort()
    release?.()
    await expect(pending).rejects.toThrow('取消')
  })
})
