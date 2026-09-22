import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool, AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import { installPromptLocalizationHost } from '@/agent/prompt/promptLocalizationHost'
import { EMPTY_BUILTIN_PROMPT_OVERRIDES } from '@/config/builtinPromptOverrides'
import { bindActiveProjectSkillSnapshot } from './activeProjectSkills'
import { hashSkillContent } from './canonical'
import { SkillChangedError, createLoadSkillTool } from './createLoadSkillTool'
import type { ProjectSkillInventorySnapshot } from './types'

const snapshotOf = async (
  name: string,
  description: string,
  body: string,
): Promise<ProjectSkillInventorySnapshot> => ({
  schemaVersion: 1,
  skills: [{
    name,
    description,
    source: { kind: 'project', root: '.axiom/skills' },
    relativePath: `.axiom/skills/${name}.md`,
    baseRelativePath: '.axiom/skills',
    contentSha256: await hashSkillContent({ name, description, disableModelInvocation: false }, body),
    disableModelInvocation: false,
  }],
})

const context = (): AgentToolExecutionContext => ({
  signal: new AbortController().signal,
  sessionId: 'session-test',
  runId: 'run-test',
  toolCallId: 'toolcall-test',
  reportProgress: async () => undefined,
})

describe('createLoadSkillTool', () => {
  let tool: AgentTool
  let files: Record<string, string>

  // 内置回退的语言/覆写经本地化宿主注入：用例内安装临时宿主，结束后恢复默认
  //（zh-CN + 空覆写），避免污染同进程其它用例。
  afterEach(() => {
    installPromptLocalizationHost({
      resolveLanguage: () => 'zh-CN',
      getOverrides: () => EMPTY_BUILTIN_PROMPT_OVERRIDES,
    })
  })

  beforeEach(() => {
    files = {}
    tool = createLoadSkillTool({
      environment: createFakeAgentEnvironment({
        readText: async (path: string, _offset?: number, _limit?: number) => {
          const content = files[path]
          if (content === undefined) throw new Error('file not found')
          return {
            workspace: { path: '/repo', name: 'repo' },
            path,
            content,
            sha256: 'e'.repeat(64),
            startLine: 1,
            endLine: content.split('\n').length,
            totalLines: content.split('\n').length,
            truncated: false,
            nextOffset: undefined,
          }
        },
      }),
    })
  })

  it('运行时版本与恢复策略正确', () => {
    expect(tool.name).toBe('load_skill')
    expect(tool.runtimeVersion).toBe('6')
    expect(tool.recoveryPolicy).toBe('idempotent')
  })

  it('只允许 snapshot 中的准确 name；未知 name 抛错', async () => {
    bindActiveProjectSkillSnapshot(await snapshotOf('pdf-tools', '提取 PDF', '# 正文'))
    await expect(tool.execute({ name: 'unknown' }, context())).rejects.toThrow('未知技能')
  })

  it('项目未命中时回退到内置正文 Skill（双通道）', async () => {
    bindActiveProjectSkillSnapshot({ schemaVersion: 1, skills: [] })
    const result = await tool.execute({ name: 'brainstorm' }, context())
    expect(result.content).toContain('# 目的')
    expect((result.details as { source?: unknown } | null)?.source).toBe('builtin')
    expect((result.details as { name?: unknown } | null)?.name).toBe('brainstorm')
    expect((result.details as { contentSha256?: unknown } | null)?.contentSha256).toBe('')
  })

  it('内置回退按宿主解析语言返回对应变体（en → 英文正文）', async () => {
    bindActiveProjectSkillSnapshot({ schemaVersion: 1, skills: [] })
    installPromptLocalizationHost({
      resolveLanguage: () => 'en',
      getOverrides: () => EMPTY_BUILTIN_PROMPT_OVERRIDES,
    })
    const result = await tool.execute({ name: 'brainstorm' }, context())
    expect(result.content).toContain('# Purpose')
    expect(result.content).not.toContain('# 目的')
    expect((result.details as { source?: unknown } | null)?.source).toBe('builtin')
  })

  it('设置页保存的 per-language 覆写优先、未覆写字段回落内置默认', async () => {
    bindActiveProjectSkillSnapshot({ schemaVersion: 1, skills: [] })
    installPromptLocalizationHost({
      resolveLanguage: () => 'zh-CN',
      getOverrides: () => ({
        version: 1,
        skills: { domain: { 'zh-CN': { body: '自定义领域正文' } } },
        subagents: {},
      }),
    })
    const result = await tool.execute({ name: 'domain' }, context())
    // 工厂缺省 capabilities=[]：正文后追加审查能力说明（属既有语义），此处验证覆写正文生效。
    expect(result.content).toContain('自定义领域正文')
    expect(result.content).toContain('# 当前会话能力说明')
    // en 覆写不影响 zh-CN 返回；zh-CN 未覆写 description 字段无载体（正文口径）。
    installPromptLocalizationHost({
      resolveLanguage: () => 'en',
      getOverrides: () => ({
        version: 1,
        skills: { domain: { 'zh-CN': { body: '自定义领域正文' } } },
        subagents: {},
      }),
    })
    const enResult = await tool.execute({ name: 'domain' }, context())
    expect(enResult.content).toContain('# Purpose')
  })

  it('未授予 subagent:review 时内置正文追加自查能力说明（静态正文感知能力环境）', async () => {
    bindActiveProjectSkillSnapshot({ schemaVersion: 1, skills: [] })
    const bare = createLoadSkillTool({
      environment: createFakeAgentEnvironment({ readText: async () => { throw new Error('no file') } }),
      capabilities: ['workspace:read'],
    })
    const result = await bare.execute({ name: 'brainstorm' }, context())
    expect(result.content).toContain('# 当前会话能力说明')
    expect(result.content).toContain('不可用')
    // 说明必须同时覆盖两类句式：「何时进入」的通过条件与「由主 Agent 决定调用」的步骤。
    expect(result.content).toContain('「何时进入」的通过条件')
    expect(result.content).toContain('「由主 Agent 决定调用」的步骤')
    expect(result.content).toContain('自查通过即视为满足进入条件')
    expect(result.content.trimEnd().endsWith('不通过则回到对应 Skill 完善。')).toBe(true)
  })

  it('授予 subagent:review 时内置正文原样返回，不追加说明', async () => {
    bindActiveProjectSkillSnapshot({ schemaVersion: 1, skills: [] })
    const granted = createLoadSkillTool({
      environment: createFakeAgentEnvironment({ readText: async () => { throw new Error('no file') } }),
      capabilities: ['workspace:read', 'subagent:review'],
    })
    const result = await granted.execute({ name: 'plan' }, context())
    expect(result.content).not.toContain('# 当前会话能力说明')
  })

  it('项目同名覆盖内置时不追加能力说明（项目正文自带完整语境）', async () => {
    const snapshot = await snapshotOf('implement', '自定义 implement', '# 自定义正文')
    files['.axiom/skills/implement.md'] = '---\nname: implement\ndescription: 自定义 implement\n---\n# 自定义正文'
    bindActiveProjectSkillSnapshot(snapshot)
    const bare = createLoadSkillTool({
      environment: createFakeAgentEnvironment({
        readText: async (path: string, _offset?: number, _limit?: number) => {
          const content = files[path]
          if (content === undefined) throw new Error('file not found')
          return {
            workspace: { path: '/repo', name: 'repo' },
            path,
            content,
            sha256: 'x',
            totalLines: content.split('\n').length,
            startLine: 1,
            endLine: content.split('\n').length,
            truncated: false,
          }
        },
      }),
      capabilities: ['workspace:read'],
    })
    const result = await bare.execute({ name: 'implement' }, context())
    expect(result.content).not.toContain('# 当前会话能力说明')
    expect((result.details as { source?: unknown } | null)?.source).toBe('project')
  })

  it('项目同名覆盖内置（项目优先，双通道）', async () => {
    const snapshot = await snapshotOf('brainstorm', '自定义 brainstorm', '# 自定义正文')
    files['.axiom/skills/brainstorm.md'] = '---\nname: brainstorm\ndescription: 自定义 brainstorm\n---\n# 自定义正文'
    bindActiveProjectSkillSnapshot(snapshot)
    const result = await tool.execute({ name: 'brainstorm' }, context())
    expect(result.content).toContain('# 自定义正文')
    expect((result.details as { source?: unknown } | null)?.source).toBe('project')
  })

  it('内容 hash 匹配时返回正文 + details（baseRelativePath、contentSha256）', async () => {
    const snapshot = await snapshotOf('pdf-tools', '提取 PDF', '# PDF 正文\n第二行')
    files['.axiom/skills/pdf-tools.md'] = '---\nname: pdf-tools\ndescription: 提取 PDF\n---\n# PDF 正文\n第二行'
    bindActiveProjectSkillSnapshot(snapshot)

    const result = await tool.execute({ name: 'pdf-tools' }, context())
    expect(result.content).toContain('# PDF 正文')
    expect((result.details as { name?: unknown } | null)?.name).toBe('pdf-tools')
    expect((result.details as { source?: unknown } | null)?.source).toBe('project')
    expect((result.details as { baseRelativePath?: unknown } | null)?.baseRelativePath).toBe('.axiom/skills')
    expect((result.details as { contentSha256?: unknown } | null)?.contentSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('文件内容变化（hash 不匹配）时 fail-closed 抛 SkillChangedError', async () => {
    const snapshot = await snapshotOf('pdf-tools', '提取 PDF', '# 旧正文')
    files['.axiom/skills/pdf-tools.md'] = '---\nname: pdf-tools\ndescription: 提取 PDF\n---\n# 新正文'
    bindActiveProjectSkillSnapshot(snapshot)

    await expect(tool.execute({ name: 'pdf-tools' }, context())).rejects.toBeInstanceOf(SkillChangedError)
  })

  it('文件缺失时抛读取错误', async () => {
    bindActiveProjectSkillSnapshot(await snapshotOf('pdf-tools', '提取 PDF', '# 正文'))
    await expect(tool.execute({ name: 'pdf-tools' }, context())).rejects.toThrow('读取失败')
  })

  it('frontmatter 漂移（name 改变）时 fail-closed', async () => {
    const snapshot = await snapshotOf('pdf-tools', '提取 PDF', '# 正文')
    files['.axiom/skills/pdf-tools.md'] = '---\nname: renamed\ndescription: 提取 PDF\n---\n# 正文'
    bindActiveProjectSkillSnapshot(snapshot)

    await expect(tool.execute({ name: 'pdf-tools' }, context())).rejects.toThrow('frontmatter name 漂移')
  })

  it('validate 拒绝额外字段与非法 name', () => {
    expect(tool.validate({ name: 'a', extra: 1 })).toEqual({ ok: false, error: expect.any(String) })
    expect(tool.validate({ name: '' })).toEqual({ ok: false, error: expect.any(String) })
    expect(tool.validate({ name: 42 })).toEqual({ ok: false, error: expect.any(String) })
    expect(tool.validate({ name: 'pdf-tools' })).toEqual({ ok: true, value: { name: 'pdf-tools' } })
  })

  it('abort 后不读取', async () => {
    bindActiveProjectSkillSnapshot(await snapshotOf('pdf-tools', '提取 PDF', '# 正文'))
    const controller = new AbortController()
    controller.abort()
    await expect(
      tool.execute({ name: 'pdf-tools' }, { ...context(), signal: controller.signal }),
    ).rejects.toThrowError(expect.objectContaining({ name: 'AbortError' }))
  })
})
