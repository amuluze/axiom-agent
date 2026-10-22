import { describe, expect, it } from 'vitest'
import {
  AgentEnvironmentError,
  type AgentEnvironment,
} from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import type { WorkspaceReadResult } from '@/platform/workspace'
import {
  AGENTS_MD_FILENAME,
  PROJECT_CONTEXT_MAX_BYTES,
  buildProjectContextSection,
  loadProjectContext,
} from './projectContext'

const workspace = { path: '/repo', name: 'repo' }

/** 按宿主真实分页语义切片：limit 默认 200 行，超出即 truncated + nextOffset。 */
const pagedRead =
  (content: string, defaultLimit: number) =>
  async (path: string, offset?: number, limit?: number): Promise<WorkspaceReadResult> => {
    const lines = content.split('\n')
    const start = (offset ?? 1) - 1
    const take = limit ?? defaultLimit
    const slice = lines.slice(start, start + take)
    const endLine = start + slice.length
    const truncated = endLine < lines.length
    return {
      workspace,
      path,
      content: slice.join('\n'),
      sha256: 'e'.repeat(64),
      startLine: start + 1,
      endLine,
      totalLines: lines.length,
      truncated,
      nextOffset: truncated ? endLine + 1 : undefined,
    }
  }

const envWith = (
  readText: (path: string, offset?: number, limit?: number) => Promise<WorkspaceReadResult>,
): AgentEnvironment => createFakeAgentEnvironment({ readText })

describe('loadProjectContext', () => {
  it('宿主明确返回 not_found 时判为 absent', async () => {
    const environment = envWith(async () => {
      throw new AgentEnvironmentError('not_found', '任意本地化文案')
    })
    await expect(loadProjectContext(environment)).resolves.toEqual({ kind: 'absent' })
  })

  it('读取失败返回 unavailable，而非当成没有', async () => {
    // 这是三态的核心：合并两者会让一次偶发错误把整段正文从 live 提示词删掉。
    const environment = envWith(async () => { throw new Error('transient ipc failure') })
    await expect(loadProjectContext(environment)).resolves.toEqual({ kind: 'unavailable' })
  })

  it('未知错误不会被文案误判为 not_found', async () => {
    const environment = envWith(async () => { throw new Error('file not found') })
    await expect(loadProjectContext(environment)).resolves.toEqual({ kind: 'unavailable' })
  })

  it('空白文件返回 absent', async () => {
    const environment = envWith(pagedRead('   \n\n  ', 200))
    await expect(loadProjectContext(environment)).resolves.toEqual({ kind: 'absent' })
  })

  it('短文件全文返回，且读取路径固定为工作区根 AGENTS.md', async () => {
    const calls: { path: string; offset?: number; limit?: number }[] = []
    const environment = envWith(async (path, offset, limit) => {
      calls.push({ path, offset, limit })
      return pagedRead('# 索引\n指向实现位置', 200)(path, offset, limit)
    })
    await expect(loadProjectContext(environment)).resolves.toEqual({ kind: 'content', content: '# 索引\n指向实现位置' })
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe(AGENTS_MD_FILENAME)
  })

  it('超过宿主默认 200 行的索引文件读到 EOF（不被静默截断）', async () => {
    // 286 行、约 64 KiB：与本仓 AGENTS.md 同量级，「版本契约」等后半段必须可见。
    const lines = Array.from({ length: 286 }, (_, index) => `第 ${index + 1} 行内容 padding padding padding`)
    const content = lines.join('\n')
    const environment = envWith(pagedRead(content, 200))
    const result = await loadProjectContext(environment)
    expect(result.kind).toBe('content')
    const body = result.kind === 'content' ? result.content : ''
    expect(body).toContain('第 286 行')
    // 分页读完才停：末尾内容与总行数一致，无「未完整加载」告警。
    expect(body).not.toContain('未完整加载')
  })

  it('宿主报 truncated 时按 nextOffset 继续翻页（不依赖调用方传 limit）', async () => {
    const seenOffsets: (number | undefined)[] = []
    const content = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join('\n')
    const environment = envWith(async (path, offset, limit) => {
      seenOffsets.push(offset)
      return pagedRead(content, 200)(path, offset, limit)
    })
    const result = await loadProjectContext(environment)
    // 首屏显式给足行数上限，不吃宿主 200 行默认值。
    expect(seenOffsets).toEqual([1])
    expect(result.kind === 'content' && result.content).toContain('line 450')
  })

  it('分页达上限仍未读完时显式告知只读到多少行（索引残缺不得静默）', async () => {
    // 每页只给 1 行、且永远 truncated：模拟宿主按字节预算截断且无 nextOffset 前进
    // 之外的最坏情形，验证上限兜底后模型能看到「只读到 N/M 行」。
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`)
    const environment = envWith(async (path, offset) => {
      const start = (offset ?? 1) - 1
      const slice = lines.slice(start, start + 1)
      const endLine = start + slice.length
      return {
        workspace,
        path,
        content: slice.join('\n'),
        sha256: 'e'.repeat(64),
        startLine: start + 1,
        endLine,
        totalLines: lines.length,
        truncated: true,
        nextOffset: endLine + 1,
      }
    })
    const result = await loadProjectContext(environment)
    const body = result.kind === 'content' ? result.content : ''
    expect(body).toContain('未完整加载')
    expect(body).toMatch(/只读到 \d+\/50 行/)
  })

  it('超出字节预算时按行边界截断并注明省略量', async () => {
    const line = 'x'.repeat(1024)
    const content = Array.from({ length: 200 }, () => line).join('\n')
    const environment = envWith(pagedRead(content, 200))
    const result = await loadProjectContext(environment)
    const body = result.kind === 'content' ? result.content : ''
    expect(body).toContain('已截断：省略了约')
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      PROJECT_CONTEXT_MAX_BYTES + 256,
    )
    // 每行完整（不切半行），故含完整的 1024 字符行。
    expect(body).toMatch(/x{1024}/u)
  })
})

describe('buildProjectContextSection', () => {
  it('有内容时包成 # 项目上下文 分节', () => {
    expect(buildProjectContextSection('正文')).toBe('# 项目上下文\n正文')
  })

  it('无内容返回 null（由调用方过滤，避免空壳标题）', () => {
    expect(buildProjectContextSection(null)).toBeNull()
    expect(buildProjectContextSection('')).toBeNull()
  })
})
