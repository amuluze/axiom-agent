import { describe, expect, it } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import type { WorkspaceEntry, WorkspaceReadResult } from '@/platform/workspace'
import { hashSkillContent } from './canonical'
import { bindActiveProjectSkillSnapshot } from './activeProjectSkills'
import { createLoadSkillTool } from './createLoadSkillTool'
import {
  loadProjectSkills,
  readSkillFileBounded,
  MAX_PROJECT_SKILLS,
  MAX_SKILL_ROOT_ENTRIES,
  MAX_SKILL_BODY_BYTES,
  PROJECT_SKILLS_ROOT,
} from './loadProjectSkills'

const skillMd = (name: string, description = '描述', extra = ''): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n正文${extra}`

const entry = (path: string, kind: WorkspaceEntry['kind'], name?: string): WorkspaceEntry => ({
  path,
  name: name ?? path.split('/').pop() ?? path,
  kind,
  sizeBytes: 0,
})

const makeEnv = (
  entries: WorkspaceEntry[],
  files: Record<string, string> = {},
): { environment: AgentEnvironment; calls: { list: string[] } } => {
  const calls: { list: string[] } = { list: [] }
  const environment = createFakeAgentEnvironment({
    list: async (path) => {
      calls.list.push(path ?? '.')
      return {
        workspace: { path: '/repo', name: 'repo' },
        directory: path ?? '.',
        entries,
        truncated: false,
      }
    },
    readText: async (path: string, offset?: number, limit?: number): Promise<WorkspaceReadResult> => {
      const content = files[path] ?? ''
      const page = offset === undefined ? content : content.split('\n').slice((offset ?? 1) - 1, (offset ?? 1) - 1 + (limit ?? 500)).join('\n')
      return {
        workspace: { path: '/repo', name: 'repo' },
        path,
        content: page,
        sha256: 'e'.repeat(64),
        startLine: 1,
        endLine: page.split('\n').length,
        totalLines: content.split('\n').length,
        truncated: false,
        nextOffset: undefined,
      }
    },
  })
  return { environment, calls }
}

describe('loadProjectSkills', () => {
  it('根目录缺失（list 抛错）fail-soft 返回空 snapshot，不产 diagnostic', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => { throw new Error('directory missing') },
    })
    const result = await loadProjectSkills(environment)
    expect(result.snapshot).toEqual({ schemaVersion: 1, skills: [] })
    expect(result.diagnostics).toEqual([])
  })

  it('只扫描固定根 .axiom/skills 的一层', async () => {
    const { environment, calls } = makeEnv([entry('.axiom/skills/a.md', 'file')])
    await loadProjectSkills(environment)
    expect(calls.list).toEqual([PROJECT_SKILLS_ROOT])
  })

  it('目录形态：读取 <name>/SKILL.md，baseRelativePath 指向目录', async () => {
    const { environment } = makeEnv(
      [entry('.axiom/skills/pdf-tools', 'directory')],
      { '.axiom/skills/pdf-tools/SKILL.md': skillMd('pdf-tools', '提取 PDF') },
    )
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(1)
    const skill = result.snapshot.skills[0]!
    expect(skill.name).toBe('pdf-tools')
    expect(skill.relativePath).toBe('.axiom/skills/pdf-tools/SKILL.md')
    expect(skill.baseRelativePath).toBe('.axiom/skills/pdf-tools')
    expect(skill.source).toEqual({ kind: 'project', root: '.axiom/skills' })
    expect(result.diagnostics).toEqual([])
  })

  it('单文件形态：stem 为 name，baseRelativePath 指向根', async () => {
    const { environment } = makeEnv(
      [entry('.axiom/skills/release-review.md', 'file')],
      { '.axiom/skills/release-review.md': skillMd('release-review', '发布评审') },
    )
    const result = await loadProjectSkills(environment)
    const skill = result.snapshot.skills[0]!
    expect(skill.name).toBe('release-review')
    expect(skill.relativePath).toBe('.axiom/skills/release-review.md')
    expect(skill.baseRelativePath).toBe('.axiom/skills')
  })

  it('拒绝 symlink 候选并产 unavailable diagnostic', async () => {
    const { environment } = makeEnv([entry('.axiom/skills/link', 'symlink')])
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(0)
    expect(result.diagnostics.map((item) => item.code)).toContain('unavailable')
  })

  it('忽略非 .md 文件与其他类型条目', async () => {
    const { environment } = makeEnv([
      entry('.axiom/skills/notes.txt', 'file'),
      entry('.axiom/skills/whatever', 'other'),
    ])
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(0)
  })

  it('frontmatter 非法产 invalid_frontmatter + typed reason', async () => {
    const { environment } = makeEnv(
      [entry('.axiom/skills/bad.md', 'file')],
      { '.axiom/skills/bad.md': 'name: bad\n---\n' },
    )
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(0)
    const diagnostic = result.diagnostics[0]!
    expect(diagnostic.code).toBe('invalid_frontmatter')
    expect(diagnostic.reason).toBe('missing_frontmatter')
    expect(diagnostic.relativePath).toBe('.axiom/skills/bad.md')
  })

  it('frontmatter name 与文件 stem 不一致产 invalid_name', async () => {
    const { environment } = makeEnv(
      [entry('.axiom/skills/realname.md', 'file')],
      { '.axiom/skills/realname.md': skillMd('othername') },
    )
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(0)
    expect(result.diagnostics.map((item) => item.code)).toContain('invalid_name')
  })

  it('同根同名冲突（目录 + 单文件）全部拒绝产 collision', async () => {
    const { environment } = makeEnv(
      [
        entry('.axiom/skills/tools', 'directory'),
        entry('.axiom/skills/tools.md', 'file'),
      ],
      {
        '.axiom/skills/tools/SKILL.md': skillMd('tools'),
        '.axiom/skills/tools.md': skillMd('tools'),
      },
    )
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(0)
    expect(result.diagnostics.filter((item) => item.code === 'collision')).toHaveLength(2)
  })

  it('正文超过 64 KiB 拒绝产 too_large', async () => {
    const { environment } = makeEnv(
      [entry('.axiom/skills/big.md', 'file')],
      { '.axiom/skills/big.md': skillMd('big', 'x', 'y'.repeat(MAX_SKILL_BODY_BYTES + 1)) },
    )
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(0)
    expect(result.diagnostics.map((item) => item.code)).toContain('too_large')
  })

  it('有效 skills 超过 32 上限时截断并产 inventory_truncated', async () => {
    const entries: WorkspaceEntry[] = []
    const files: Record<string, string> = {}
    for (let index = 0; index < 40; index++) {
      const name = `skill-${String(index).padStart(2, '0')}`
      entries.push(entry(`.axiom/skills/${name}.md`, 'file'))
      files[`.axiom/skills/${name}.md`] = skillMd(name)
    }
    const { environment } = makeEnv(entries, files)
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(MAX_PROJECT_SKILLS)
    expect(result.diagnostics.map((item) => item.code)).toContain('inventory_truncated')
  })

  it('扫描根直接条目超过 64 时确定性截断并产 inventory_truncated', async () => {
    // 模拟 workspace.list 的确定性排序输出（filename 小写稳定排序）：
    // 按 name 升序构造 MAX_SKILL_ROOT_ENTRIES + 6 个有效条目，超过 64 根截断阈值。
    const entries: WorkspaceEntry[] = []
    const files: Record<string, string> = {}
    const total = MAX_SKILL_ROOT_ENTRIES + 6
    for (let index = 0; index < total; index++) {
      const name = `skill-${String(index).padStart(2, '0')}`
      entries.push(entry(`.axiom/skills/${name}.md`, 'file'))
      files[`.axiom/skills/${name}.md`] = skillMd(name)
    }
    const { environment } = makeEnv(entries, files)
    const result = await loadProjectSkills(environment)
    // 根截断（>64）+ 有效 skill 截断（>32）各产一条 inventory_truncated
    const truncated = result.diagnostics.filter((item) => item.code === 'inventory_truncated')
    expect(truncated).toHaveLength(2)
    // 截断发生在排序后，确定性选取 ASCII name 最小的 32 个：skill-00..skill-31
    expect(result.snapshot.skills).toHaveLength(MAX_PROJECT_SKILLS)
    expect(result.snapshot.skills[0]!.name).toBe('skill-00')
    expect(result.snapshot.skills[MAX_PROJECT_SKILLS - 1]!.name).toBe(
      `skill-${String(MAX_PROJECT_SKILLS - 1).padStart(2, '0')}`,
    )
  })

  it('按 ASCII name 排序，跨运行稳定', async () => {
    const { environment } = makeEnv(
      [
        entry('.axiom/skills/zebra.md', 'file'),
        entry('.axiom/skills/alpha.md', 'file'),
        entry('.axiom/skills/bravo.md', 'file'),
      ],
      {
        '.axiom/skills/zebra.md': skillMd('zebra'),
        '.axiom/skills/alpha.md': skillMd('alpha'),
        '.axiom/skills/bravo.md': skillMd('bravo'),
      },
    )
    const first = await loadProjectSkills(environment)
    const second = await loadProjectSkills(environment)
    expect(first.snapshot.skills.map((item) => item.name)).toEqual(['alpha', 'bravo', 'zebra'])
    expect(first.snapshot.skills.map((item) => item.name)).toEqual(second.snapshot.skills.map((item) => item.name))
  })

  it('contentSha256 与 canonical 哈希一致（对解析后的 body 计算）', async () => {
    const body = '正文\r\n带 CRLF 换行'
    const content = `---\nname: pdf-tools\ndescription: 提取 PDF\n---\n${body}`
    const { environment } = makeEnv(
      [entry('.axiom/skills/pdf-tools.md', 'file')],
      { '.axiom/skills/pdf-tools.md': content },
    )
    const result = await loadProjectSkills(environment)
    const skill = result.snapshot.skills[0]!
    expect(skill.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(skill.contentSha256).toBe(await hashSkillContent({ name: 'pdf-tools', description: '提取 PDF', disableModelInvocation: false }, body))
  })

  it('disableModelInvocation 保留到 snapshot', async () => {
    const { environment } = makeEnv(
      [entry('.axiom/skills/secret.md', 'file')],
      { '.axiom/skills/secret.md': '---\nname: secret\ndescription: x\ndisable-model-invocation: true\n---\n' },
    )
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills[0]!.disableModelInvocation).toBe(true)
  })

  it('端到端：扫描生成的 snapshot 可被 load_skill 用同一 environment 加载成功（hash 闭环）', async () => {
    const content = skillMd('pdf-tools', '提取 PDF', '\n- 合并\n- 拆分')
    const { environment } = makeEnv(
      [entry('.axiom/skills/pdf-tools', 'directory')],
      { '.axiom/skills/pdf-tools/SKILL.md': content },
    )
    const { snapshot } = await loadProjectSkills(environment)
    expect(snapshot.skills).toHaveLength(1)
    bindActiveProjectSkillSnapshot(snapshot)

    const tool = createLoadSkillTool({ environment })
    const result = await tool.execute(
      { name: 'pdf-tools' },
      { signal: new AbortController().signal, sessionId: 's', runId: 'r', toolCallId: 't', reportProgress: async () => undefined },
    )
    expect(result.content).toContain('- 合并')
    expect((result.details as { contentSha256?: unknown } | null)?.contentSha256).toBe(snapshot.skills[0]!.contentSha256)
  })

  it('分页读取到 EOF 拼接完整内容', async () => {
    const content = `---\nname: paged\ndescription: 分页\n---\n${'行'.repeat(1500)}`
    const environment = createFakeAgentEnvironment({
      list: async () => ({
        workspace: { path: '/repo', name: 'repo' },
        directory: PROJECT_SKILLS_ROOT,
        entries: [entry('.axiom/skills/paged.md', 'file')],
        truncated: false,
      }),
      readText: async (path: string, offset?: number, limit?: number): Promise<WorkspaceReadResult> => {
        const lines = content.split('\n')
        const start = offset ?? 1
        const pageLines = lines.slice(start - 1, start - 1 + (limit ?? 500))
        const truncated = start - 1 + pageLines.length < lines.length
        return {
          workspace: { path: '/repo', name: 'repo' },
          path,
          content: pageLines.join('\n'),
          sha256: 'e'.repeat(64),
          startLine: start,
          endLine: start - 1 + pageLines.length,
          totalLines: lines.length,
          truncated,
          nextOffset: truncated ? start + pageLines.length : undefined,
        }
      },
    })
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(1)
    expect(result.diagnostics).toEqual([])
  })

  it('readSkillFileBounded：nextOffset 连续停滞时 fail-closed 返回 unavailable', async () => {
    // 模拟底层 read 分页异常：truncated=true 但 nextOffset 固定不变，offset 永远不前进。
    const environment = createFakeAgentEnvironment({
      readText: async (path: string): Promise<WorkspaceReadResult> => ({
        workspace: { path: '/repo', name: 'repo' },
        path,
        content: '部分',
        sha256: 'e'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 100,
        truncated: true,
        nextOffset: 1,
      }),
    })
    const read = await readSkillFileBounded(environment.workspace, '.axiom/skills/stuck.md')
    expect(read).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('readSkillFileBounded 停滞失败时候选产 unavailable diagnostic 且不进 snapshot', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => ({
        workspace: { path: '/repo', name: 'repo' },
        directory: PROJECT_SKILLS_ROOT,
        entries: [entry('.axiom/skills/stuck.md', 'file')],
        truncated: false,
      }),
      readText: async (path: string): Promise<WorkspaceReadResult> => ({
        workspace: { path: '/repo', name: 'repo' },
        path,
        content: '部分',
        sha256: 'e'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 100,
        truncated: true,
        nextOffset: 1,
      }),
    })
    const result = await loadProjectSkills(environment)
    expect(result.snapshot.skills).toHaveLength(0)
    expect(result.diagnostics.map((item) => item.code)).toContain('unavailable')
  })
})
