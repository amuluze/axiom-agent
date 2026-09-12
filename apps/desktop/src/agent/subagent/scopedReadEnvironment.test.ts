import { describe, expect, it } from 'vitest'
import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'
import type { WorkspaceFindResult } from '@/platform/workspace'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import {
  createScopedReadEnvironment,
  normalizeScope,
  normalizeScopeEntry,
  pathWithinScope,
} from './scopedReadEnvironment'

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
  it('移除 . 与尾随 /，保留合法相对路径', () => {
    expect(normalizeScopeEntry('src/./a/')).toBe('src/a')
    expect(normalizeScopeEntry('src')).toBe('src')
  })

  it('拒绝绝对路径、..、NUL、Windows 盘符与空值', () => {
    expect(normalizeScopeEntry('/abs')).toBeNull()
    expect(normalizeScopeEntry('../up')).toBeNull()
    expect(normalizeScopeEntry('a\0b')).toBeNull()
    expect(normalizeScopeEntry('C:\\win')).toBeNull()
    expect(normalizeScopeEntry('')).toBeNull()
  })

  it('纯 . 与 ./ 规范化为空，拒绝（fail-closed，不得降级为全工作区）', () => {
    expect(normalizeScopeEntry('.')).toBeNull()
    expect(normalizeScopeEntry('./')).toBeNull()
    expect(normalizeScopeEntry('.//')).toBeNull()
    // 路径中的 . 分段仍被移除，保留其余部分。
    expect(normalizeScopeEntry('./src/')).toBe('src')
  })
})

describe('pathWithinScope', () => {
  it('空 scope 允许整个工作区', () => {
    expect(pathWithinScope('anything/deep', [])).toBe(true)
  })

  it('scope 内放行，前缀碰撞不误放行', () => {
    const scope = ['src/a', 'pkg']
    expect(pathWithinScope('src/a', scope)).toBe(true)
    expect(pathWithinScope('src/a/b.ts', scope)).toBe(true)
    expect(pathWithinScope('src/ab.ts', scope)).toBe(false)
    expect(pathWithinScope('pkg/x.ts', scope)).toBe(true)
    expect(pathWithinScope('src/b.ts', scope)).toBe(false)
  })

  it('越界或非法路径拒绝', () => {
    const scope = ['src']
    expect(pathWithinScope('../src/a', scope)).toBe(false)
    expect(pathWithinScope('/etc/passwd', scope)).toBe(false)
  })
})

describe('createScopedReadEnvironment', () => {
  it('scope 内 readText/list/find/searchText 放行', async () => {
    const base = envWith({
      readText: async (path) => ({
        workspace: defaultWorkspace,
        path,
        content: 'x',
        sha256: 'a'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
      }),
      list: async (path) => ({
        workspace: defaultWorkspace,
        directory: path ?? '.',
        entries: [{ path: 'src/a.ts', name: 'a.ts', kind: 'file', sizeBytes: 0 }],
        truncated: false,
      }),
      find: async (path) => ({
        workspace: defaultWorkspace,
        pattern: '*',
        rootPath: path ?? '.',
        matches: [{ path: 'src/a.ts', name: 'a.ts', kind: 'file', sizeBytes: 0 }],
        truncated: false,
      }),
    })
    const scoped = createScopedReadEnvironment(base, ['src'])
    await expect(scoped.workspace.readText('src/a.ts')).resolves.toMatchObject({ path: 'src/a.ts' })
    const list = await scoped.workspace.list('src')
    expect(list.entries.map((entry) => entry.path)).toEqual(['src/a.ts'])
    const find = await scoped.workspace.find({ requestId: 'r', pattern: '*', path: 'src', signal: new AbortController().signal })
    expect(find.matches.map((match) => match.path)).toEqual(['src/a.ts'])
  })

  it('scope 外 readText/list 拒绝', async () => {
    const base = envWith({})
    const scoped = createScopedReadEnvironment(base, ['src'])
    await expect(scoped.workspace.readText('outside.txt')).rejects.toBeInstanceOf(AgentEnvironmentError)
    await expect(scoped.workspace.list('other')).rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('scope 内子路径放行（src/ab.txt 在 src 内）', async () => {
    const base = envWith({
      readText: async (path) => ({
        workspace: defaultWorkspace,
        path,
        content: 'x',
        sha256: 'a'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
      }),
    })
    const scoped = createScopedReadEnvironment(base, ['src'])
    await expect(scoped.workspace.readText('src/ab.txt')).resolves.toMatchObject({ path: 'src/ab.txt' })
  })

  it('前缀碰撞：scope src/a 不误放行 src/ab.ts，但放行 src/a 子树', async () => {
    const base = envWith({
      readText: async (path) => ({
        workspace: defaultWorkspace,
        path,
        content: 'x',
        sha256: 'a'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
      }),
    })
    const scoped = createScopedReadEnvironment(base, ['src/a'])
    await expect(scoped.workspace.readText('src/ab.ts')).rejects.toBeInstanceOf(AgentEnvironmentError)
    await expect(scoped.workspace.readText('src/a/x.ts')).resolves.toMatchObject({ path: 'src/a/x.ts' })
  })

  it('Rust 返回越界 path（symlink 解析后越出 scope）报错/丢弃', async () => {
    const base = envWith({
      readText: async () => ({
        workspace: defaultWorkspace,
        path: '../secrets.txt',
        content: 'x',
        sha256: 'a'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
      }),
    })
    const scoped = createScopedReadEnvironment(base, ['src'])
    await expect(scoped.workspace.readText('src/a.ts')).rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('searchText 结果中越界 match 被过滤', async () => {
    const base = createFakeAgentEnvironment({
      searchText: async () => ({
        workspace: defaultWorkspace,
        matches: [
          { path: 'src/a.ts', lineNumber: 1, line: 'x' },
          { path: 'other/b.ts', lineNumber: 1, line: 'y' },
        ],
        truncated: false,
      }),
    })
    const scoped = createScopedReadEnvironment(base, ['src'])
    const result = await scoped.workspace.searchText(
      { requestId: 'r', pattern: 'x' },
      new AbortController().signal,
    )
    expect(result.matches.map((match) => match.path)).toEqual(['src/a.ts'])
  })

  it('authorizedFiles 绝对读取始终拒绝', async () => {
    const base = createFakeAgentEnvironment({})
    const scoped = createScopedReadEnvironment(base, [])
    await expect(scoped.authorizedFiles.readText('/tmp/secret.txt')).rejects.toBeInstanceOf(AgentEnvironmentError)
    await expect(scoped.authorizedFiles.list()).resolves.toEqual([])
  })

  it('find 的 path 越界拒绝（单 path 语义）', async () => {
    const base = createFakeAgentEnvironment({})
    const scoped = createScopedReadEnvironment(base, ['src'])
    await expect(
      scoped.workspace.find({ requestId: 'r', pattern: '*', path: 'other', signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('无 scope 时仍只能在父授权工作区（写方法结构上不可用）', async () => {
    const base = createFakeAgentEnvironment({})
    const scoped = createScopedReadEnvironment(base, [])
    await expect(scoped.workspace.readText('src/a.ts')).resolves.toMatchObject({})
    await expect(scoped.workspace.createTextFile('x.ts', 'x', 'lease')).rejects.toBeInstanceOf(AgentEnvironmentError)
    await expect(scoped.workspace.runCommand({} as never, new AbortController().signal, undefined, 'lease')).rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('artifacts.writeToolResult 结构上不可用（子 Agent 不外化 Artifact）', async () => {
    const base = createFakeAgentEnvironment({})
    const scoped = createScopedReadEnvironment(base, [])
    await expect(scoped.artifacts.writeToolResult({} as never)).rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('browser 结构性封死：只读子 Agent 不共享主 Agent 的有状态浏览器会话', async () => {
    const base = createFakeAgentEnvironment({
      // 父环境的 browser 即便可用，scoped 封面也必须拒绝而不是透传。
      browserCommand: async () => ({ type: 'done' }),
    })
    const scoped = createScopedReadEnvironment(base, [])
    await expect(
      scoped.browser.command({ action: 'tabs' }),
    ).rejects.toBeInstanceOf(AgentEnvironmentError)
    await expect(
      scoped.browser.command({ action: 'newTab', url: 'http://localhost:5173/' }),
    ).rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('ssh 结构性封死：只读子 Agent 不共享主 Agent 的远程主机特权通道', async () => {
    const base = createFakeAgentEnvironment({
      sshAgentCommand: async () => ({ type: 'hosts', hosts: [] }),
    })
    const scoped = createScopedReadEnvironment(base, [])
    await expect(scoped.ssh.command({ action: 'listHosts' })).rejects.toBeInstanceOf(AgentEnvironmentError)
    await expect(
      scoped.ssh.command({ action: 'exec', sessionId: 's', host: 'prod', command: 'uptime' }),
    ).rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('scope 不能扩大父权限：base 拒绝时 scoped 同样失败', async () => {
    const base = envWith({
      readText: async () => { throw new Error('base denied') },
    })
    const scoped = createScopedReadEnvironment(base, [])
    await expect(scoped.workspace.readText('src/a.ts')).rejects.toThrow('base denied')
  })

  it('normalizeScope 去重并排序', () => {
    expect(normalizeScope(['pkg', 'src', 'src/', 'pkg'])).toEqual(['pkg', 'src'])
  })
})
