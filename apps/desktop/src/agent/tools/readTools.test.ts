import { describe, expect, it } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createReadTool } from './readTool'
import { createLsTool } from './lsTool'
import { createGrepTool } from './grepTool'
import { createFindTool } from './findTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

describe('readTool execute', () => {
  it('threads workspace text content + sha256 + pagination footer to the model', async () => {
    const environment = createFakeAgentEnvironment({
      readText: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo', gitBranch: 'main' },
        path: 'src/main.ts',
        content: 'export const main = () => 0',
        sha256: 'a'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
      }),
    })
    const result = await createReadTool(environment).execute({ path: 'src/main.ts' }, baseContext())

    expect(result.content).toContain('export const main = () => 0')
    expect(result.content).toContain(`[Full file sha256: ${'a'.repeat(64)}]`)
    expect(result.details).toMatchObject({
      path: 'src/main.ts',
      sha256: 'a'.repeat(64),
      source: 'workspace',
      truncated: false,
    })
  })

  it('appends a continue-offset footer when the read is truncated', async () => {
    const environment = createFakeAgentEnvironment({
      readText: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        path: 'big.txt',
        content: 'line 1\nline 2',
        sha256: 'b'.repeat(64),
        startLine: 1,
        endLine: 2,
        totalLines: 10,
        truncated: true,
        nextOffset: 3,
      }),
    })
    const result = await createReadTool(environment).execute({ path: 'big.txt' }, baseContext())

    expect(result.content).toContain('Use offset=3 to continue')
    expect(result.details).toMatchObject({ truncated: true, nextOffset: 3 })
  })

  it('routes absolute paths through the authorizedFiles branch', async () => {
    const environment = createFakeAgentEnvironment({
      authorizedReadText: async () => ({
        file: {
          path: '/etc/hosts.cfg',
          name: 'hosts.cfg',
          sizeBytes: 7,
          isDirectory: false,
        },
        content: 'enabled',
      }),
    })
    const result = await createReadTool(environment).execute({ path: '/etc/hosts.cfg' }, baseContext())

    expect(result.content).toBe('enabled')
    expect(result.details).toMatchObject({ path: '/etc/hosts.cfg', source: 'absolute' })
  })
})

describe('lsTool execute', () => {
  it('renders directory entries with a trailing "/" and empty fallback', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        directory: 'src',
        entries: [
          { path: 'src/lib', name: 'lib', kind: 'directory' as const, sizeBytes: 0 },
          { path: 'src/main.ts', name: 'main.ts', kind: 'file' as const, sizeBytes: 42 },
        ],
        truncated: false,
      }),
    })
    const result = await createLsTool(environment).execute({ path: 'src' }, baseContext())

    expect(result.content).toBe('src/lib/\nsrc/main.ts')
    expect(result.details).toMatchObject({ directory: 'src', truncated: false })
  })

  it('falls back to "(empty directory)" and reports truncation', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        directory: 'empty',
        entries: [],
        truncated: true,
      }),
    })
    const result = await createLsTool(environment).execute({ path: 'empty' }, baseContext())

    expect(result.content).toContain('(empty directory)')
    expect(result.content).toContain('Entry cap')
    expect(result.details).toMatchObject({ truncated: true })
  })
})

describe('grepTool execute', () => {
  it('groups matches with their context lines and tags match vs context separators', async () => {
    const environment = createFakeAgentEnvironment({
      searchText: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        matches: [
          {
            path: 'src/main.ts',
            lineNumber: 5,
            line: 'const x = 1',
            contextLines: [
              { lineNumber: 4, line: '// before', isMatch: false },
              { lineNumber: 6, line: 'const y = 2', isMatch: false },
            ],
          },
        ],
        truncated: false,
      }),
    })
    const result = await createGrepTool(environment).execute(
      { pattern: 'const x' },
      baseContext({ reportProgress: async () => undefined }),
    )

    // Match line uses the `path:N:` separator; context lines use `path-N-`.
    expect(result.content).toContain('src/main.ts:5: const x = 1')
    expect(result.content).toContain('src/main.ts-4- // before')
    expect(result.content).toContain('src/main.ts-6- const y = 2')
    expect(result.details).toMatchObject({ truncated: false })
  })

  it('reports "No matches found" and a truncation footer when capped', async () => {
    const environment = createFakeAgentEnvironment({
      searchText: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        matches: [],
        truncated: true,
      }),
    })
    const result = await createGrepTool(environment).execute(
      { pattern: 'absent' },
      baseContext({ reportProgress: async () => undefined }),
    )

    expect(result.content).toContain('No matches found')
    expect(result.content).toContain('Match cap')
  })
})

describe('findTool execute', () => {
  it('lists matched files and tags directories with "/"', async () => {
    const environment = createFakeAgentEnvironment({
      find: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        pattern: '**/*.ts',
        rootPath: 'src',
        matches: [
          { path: 'src/lib', name: 'lib', kind: 'directory' as const, sizeBytes: 0 },
          { path: 'src/main.ts', name: 'main.ts', kind: 'file' as const, sizeBytes: 42 },
        ],
        truncated: false,
      }),
    })
    const result = await createFindTool(environment).execute(
      { pattern: '**/*.ts', path: 'src' },
      baseContext(),
    )

    expect(result.content).toBe('src/lib/\nsrc/main.ts')
    expect(result.details).toMatchObject({ pattern: '**/*.ts', rootPath: 'src', truncated: false })
  })

  it('reports "No matches found" and a result-cap footer when truncated', async () => {
    const environment = createFakeAgentEnvironment({
      find: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        pattern: 'missing',
        rootPath: '.',
        matches: [],
        truncated: true,
      }),
    })
    const result = await createFindTool(environment).execute({ pattern: 'missing' }, baseContext())

    expect(result.content).toContain('No matches found')
    expect(result.content).toContain('Result cap')
  })
})

// 验收 9/19：仅文本判定下产图点不产出图片负载、不调用编码宿主，说明文案
// 含钉死占位子串且不把能力受限表述为环境故障（Domain 不变量 6）。
describe('readTool 仅文本判定降级', () => {
  const UNSUPPORTED_IMAGE_NOTE = '[图片已省略：当前模型不支持图片输入]'
  // 封闭词表（Task Spec 验收 9 逐字钉死）：能力受限 ≠ 环境故障，两者可观测语义可区分。
  const FORBIDDEN_WORDS = [
    '渲染器不可用', '环境故障', 'no renderer', 'host seam not injected',
    'sandbox', 'fallback',
  ]

  it('图片文件 → 无 image 块、含占位子串、无封闭词、宿主未产图', async () => {
    const readTextCalls: unknown[] = []
    const environment = createFakeAgentEnvironment({
      readText: async (...args) => {
        readTextCalls.push(args)
        return {
          workspace: { path: '/workspace/repo', name: 'repo' },
          path: 'media/logo.png',
          content: '',
          sha256: 'c'.repeat(64),
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          truncated: false,
          image: { mimeType: 'image/png', dataBase64: 'aGk=', resized: true },
        }
      },
    })
    const result = await createReadTool(environment).execute(
      { path: 'media/logo.png' },
      baseContext({ modelAcceptsImage: false }),
    )

    expect(result.contentBlocks?.some((block) => block.type === 'image') ?? false).toBe(false)
    expect(result.content).toContain(UNSUPPORTED_IMAGE_NOTE)
    expect(result.content).toContain(`[Full file sha256: ${'c'.repeat(64)}]`)
    for (const word of FORBIDDEN_WORDS) {
      expect(result.content.includes(word), `不应出现封闭词「${word}」`).toBe(false)
    }
    // 验收 19：宿主读图（编码）恰被调用一次以获取 sha，但不产生图片负载。
    expect(readTextCalls).toHaveLength(1)
  })

  it('占位文案与请求侧降级共用同一常量（不漂移）', async () => {
    const environment = createFakeAgentEnvironment({
      readText: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        path: 'a.png',
        content: '',
        sha256: 'd'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
        image: { mimeType: 'image/png', dataBase64: 'aGk=', resized: false },
      }),
    })
    const result = await createReadTool(environment).execute(
      { path: 'a.png' },
      baseContext({ modelAcceptsImage: false }),
    )
    const withImage = await createReadTool(environment).execute(
      { path: 'a.png' },
      baseContext({ modelAcceptsImage: true }),
    )
    expect(withImage.contentBlocks?.some((block) => block.type === 'image')).toBe(true)
    expect(result.content).toContain(UNSUPPORTED_IMAGE_NOTE)
    // 支持图片时不带占位说明（不污染视觉模型的上下文）。
    expect(withImage.content.includes(UNSUPPORTED_IMAGE_NOTE)).toBe(false)
  })
})
