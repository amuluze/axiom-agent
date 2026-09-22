import { describe, expect, it } from 'vitest'
import {
  AUTHORIZED_FILES_PROMPT_LIMIT,
  buildAuthorizationContextSection,
  buildBasePromptSections,
  buildCapabilitySection,
  buildCapabilitySections,
  buildSddWorkflowSection,
  buildSessionBasePrompt,
  SYSTEM_PROMPT_VERSION,
  TOOL_DISCOVERY_NOTICE,
} from './systemPromptSections'
import { buildSystemPrompt } from '@/agent/runtime/productToolRuntime'
import type { AgentTool } from '@/agent/core/types'
import type { AgentCapability } from '@/config/runtimePolicy'
import { BUILTIN_SKILL_BODIES } from '@/agent/skills/builtinSkillBodies'
import type { ProjectSkillInventorySnapshot } from '@/agent/skills/types'

const projectSkillsSnapshot = (): ProjectSkillInventorySnapshot => ({
  schemaVersion: 1,
  skills: [{
    name: 'pdf-tools',
    description: '操作 PDF：提取文本、合并、拆分。',
    source: { kind: 'project', root: '.axiom/skills' },
    relativePath: '.axiom/skills/pdf-tools/SKILL.md',
    baseRelativePath: '.axiom/skills/pdf-tools',
    contentSha256: 'a'.repeat(64),
    disableModelInvocation: false,
  }],
})

const tool = (
  name: string,
  snippet: string | undefined,
  guidelines: string[] | undefined,
): AgentTool =>
  ({
    name,
    label: name,
    description: '',
    runtimeVersion: '1',
    inputSchema: {},
    promptSnippet: snippet,
    promptGuidelines: guidelines,
  }) as unknown as AgentTool

describe('systemPromptSections', () => {
  describe('buildBasePromptSections', () => {
    it('contains all base H2 sections', () => {
      const prompt = buildBasePromptSections()
      for (const heading of ['# 角色', '# 协作风格', '# 工作流', '# 失败与收口']) {
        expect(prompt).toContain(heading)
      }
    })

    it('is in Chinese (no leftover English section headers)', () => {
      const prompt = buildBasePromptSections()
      expect(prompt).not.toMatch(/# Tone|# Doing tasks|# Tool usage/)
    })

    it('injects the model identity into the 角色 section when a modelName is given', () => {
      const prompt = buildBasePromptSections('DeepSeek V4 Flash')
      expect(prompt).toContain('DeepSeek V4 Flash')
      // 模型身份行位于 # 角色 段（第二个 # 标题之前），不新增 H2 分节
      const roleSection = prompt.slice(0, prompt.indexOf('\n# 协作风格'))
      expect(roleSection).toContain('底层模型显示名为「DeepSeek V4 Flash」')
      const headings = prompt.match(/^# .+$/gm) ?? []
      expect(headings).toEqual(['# 角色', '# 协作风格', '# 工作流', '# 失败与收口'])
    })

    it('collapses multi-line modelName to a single line before injection', () => {
      const prompt = buildBasePromptSections('DeepSeek\nV4  Flash')
      expect(prompt).toContain('「DeepSeek V4 Flash」')
      expect(prompt).not.toContain('\nV4')
    })

    it('omits the model identity line when modelName is absent or blank', () => {
      const baseline = buildBasePromptSections()
      expect(buildBasePromptSections(undefined)).toBe(baseline)
      expect(buildBasePromptSections('')).toBe(baseline)
      expect(buildBasePromptSections('   ')).toBe(baseline)
      expect(baseline).not.toContain('底层模型')
    })
  })

  describe('buildCapabilitySection', () => {
    it('returns a rule for every file/workspace capability', () => {
      expect(buildCapabilitySection('filesystem:read')).not.toBeNull()
      expect(buildCapabilitySection('workspace:read')).not.toBeNull()
      expect(buildCapabilitySection('workspace:write')).not.toBeNull()
      expect(buildCapabilitySection('workspace:execute')).not.toBeNull()
    })

    it('returns a rule for both sub-agent capabilities', () => {
      expect(buildCapabilitySection('subagent:explore')).toContain('explore_subagent')
      expect(buildCapabilitySection('subagent:review')).toContain('inspect_subagent')
    })

    it('subagent:explore 段指引预算中止处理：partial 收口或收窄 scope 重试', () => {
      const section = buildCapabilitySection('subagent:explore')
      expect(section).toContain('探索子 Agent 有固定预算')
      expect(section).toContain('把 scope 收窄到未覆盖部分后重新委派')
    })

    it('web:browser 段含调度指引：视觉/交互验证优先内置 browser，排除替代通道', () => {
      const section = buildCapabilitySection('web:browser')
      expect(section).toContain('优先使用内置 browser')
      // 替代通道的排除要点名：curl 看不到渲染、web_fetch 够不到 localhost、
      // computer 是用户真实桌面、验证责任不得交还用户。
      expect(section).toContain('curl 只拿得到 HTML 文本')
      expect(section).toContain('web_fetch 只达公网够不到 localhost')
      expect(section).toContain('不要让用户自己打开浏览器查看')
      // 未启用时不许用 curl 伪装验证完成。
      expect(section).toContain('不要转用 curl 伪装验证完成')
    })

    it('subagent:review 段指引预算中止处理：partial 收口或收窄 scope 重审', () => {
      const section = buildCapabilitySection('subagent:review', ['subagent:review', 'workspace:execute'])
      expect(section).toContain('预算用尽会返回 partial 或报错')
      expect(section).toContain('把 scope 收窄到未覆盖部分后重新委派')
    })

    it('subagent:review 的 diff 指引按 workspace:execute 组合分化（不宣传不存在的 bash 路径）', () => {
      const withBash = buildCapabilitySection('subagent:review', ['subagent:review', 'workspace:execute'])
      expect(withBash).toContain('先用 bash 采集 git diff')
      // 缺省（单能力调用，无组合上下文）与显式无 workspace:execute 都渲染降级变体
      const degraded = buildCapabilitySection('subagent:review', ['subagent:review'])
      expect(degraded).not.toContain('先用 bash 采集 git diff')
      expect(degraded).toContain('未授予命令执行能力')
      expect(buildCapabilitySection('subagent:review')).not.toContain('先用 bash 采集 git diff')
    })

    it('every returned section is under the 安全边界 heading', () => {
      for (const capability of [
        'filesystem:read',
        'workspace:read',
        'workspace:write',
        'workspace:execute',
      ] as const) {
        expect(buildCapabilitySection(capability)).toContain('# 安全边界')
      }
    })
  })

  describe('buildCapabilitySections', () => {
    it('returns null when no capability grants a rule', () => {
      expect(buildCapabilitySections([])).toBeNull()
    })

    it('组装时把完整能力集传给组合敏感段（subagent:review 的 diff 指引）', () => {
      const withExecute = buildCapabilitySections(['workspace:read', 'workspace:execute', 'subagent:review'])!
      expect(withExecute).toContain('先用 bash 采集 git diff')
      const withoutExecute = buildCapabilitySections(['workspace:read', 'subagent:review'])!
      expect(withoutExecute).not.toContain('先用 bash 采集 git diff')
      expect(withoutExecute).toContain('未授予命令执行能力')
    })

    it('merges multiple capabilities under a single 安全边界 heading', () => {
      const merged = buildCapabilitySections(['workspace:read', 'workspace:write'])
      const headingCount = (merged!.match(/# 安全边界/g) ?? []).length
      expect(headingCount).toBe(1)
      expect(merged).toContain('SHA-256')
      expect(merged).toContain('相对路径')
    })

    // 安全段正文顺序为 canonical（能力名字典序）且与入参数组顺序解耦：重排
    // runtimePolicy 的 toolCapabilities 不会改变提示词正文，会话恢复时持久化
    // 提示词与重建结果始终一致。此测试固化该契约。
    it('emits capability rules in canonical order regardless of input order', () => {
      const shuffled = [
        'workspace:execute',
        'workspace:write',
        'workspace:read',
        'filesystem:read',
      ] as const
      const canonical = [
        'filesystem:read',
        'workspace:read',
        'workspace:write',
        'workspace:execute',
      ] as const
      const fromShuffled = buildCapabilitySections([...shuffled])!
      const fromCanonical = buildCapabilitySections([...canonical])!
      expect(fromShuffled).toBe(fromCanonical)
      // 用各段首个特征词锚定顺序：正文按 canonical 顺序出现
      const anchors = ['绝对路径', '相对路径', 'SHA-256', 'network: true']
      let lastIndex = -1
      for (const anchor of anchors) {
        const index = fromCanonical.indexOf(anchor)
        expect(index).toBeGreaterThan(-1)
        expect(index).toBeGreaterThan(lastIndex)
        lastIndex = index
      }
    })

    it('deduplicates repeated capabilities', () => {
      const merged = buildCapabilitySections(['workspace:read', 'workspace:read'])!
      expect(merged.match(/收窄搜索/g) ?? []).toHaveLength(1)
    })
  })

  describe('buildSddWorkflowSection', () => {
    it('returns null without workspace:read', () => {
      expect(buildSddWorkflowSection([])).toBeNull()
      expect(buildSddWorkflowSection(['filesystem:read'])).toBeNull()
      expect(buildSddWorkflowSection(['subagent:review'])).toBeNull()
    })

    it('lists builtin skills but omits review sub-agents without subagent:review', () => {
      const section = buildSddWorkflowSection(['workspace:read'])!
      expect(section).toContain('# SDD 工作流')
      expect(section).toContain('brainstorm')
      expect(section).not.toContain('review_subagent')
      expect(section).not.toContain('inspect_subagent')
      expect(section).toContain('按 Skill 自查收口')
    })

    it('lists both skills and review sub-agents with subagent:review', () => {
      const section = buildSddWorkflowSection(['workspace:read', 'subagent:review'])!
      expect(section).toContain('brainstorm')
      expect(section).toContain('inspect_subagent')
      expect(section).toContain('examine_subagent')
      expect(section).toContain('review_subagent')
      expect(section).toContain('小改动由主 Agent 自查收口')
    })

    it('derives the builtin skill list from BUILTIN_SKILL_BODIES（单一数据源）', () => {
      const capabilitySets: AgentCapability[][] = [['workspace:read'], ['workspace:read', 'subagent:review']]
      for (const capabilities of capabilitySets) {
        const section = buildSddWorkflowSection(capabilities)!
        const names = BUILTIN_SKILL_BODIES.map((skill) => skill.name)
        expect(section).toContain(names.join(' / '))
      }
    })

    it('contains no $-prefixed skill references to non-builtin skills（无幻觉引用）', () => {
      // 旧「$review 快速自查清单」是已删除的 UI Token Skill 的残留引用——段内
      // 提及的 $name 必须命中内置清单，否则模型会尝试加载不存在的技能。
      const builtinNames = new Set(BUILTIN_SKILL_BODIES.map((skill) => skill.name))
      const capabilitySets: AgentCapability[][] = [['workspace:read'], ['workspace:read', 'subagent:review']]
      for (const capabilities of capabilitySets) {
        const section = buildSddWorkflowSection(capabilities)!
        for (const match of section.matchAll(/\$([a-z0-9][a-z0-9-]*)/gu)) {
          expect(builtinNames.has(match[1]!), `SDD 段引用了不存在的 $${match[1]}`).toBe(true)
        }
      }
    })

    it('contains only known *_subagent tool references（无幻觉工具引用）', () => {
      const knownReviewers = new Set(['inspect_subagent', 'examine_subagent', 'review_subagent'])
      const capabilitySets: AgentCapability[][] = [['workspace:read'], ['workspace:read', 'subagent:review']]
      for (const capabilities of capabilitySets) {
        const section = buildSddWorkflowSection(capabilities)!
        for (const match of section.matchAll(/([a-z][a-z0-9]*_subagent)/gu)) {
          expect(knownReviewers.has(match[1]!), `SDD 段引用了未知工具 ${match[1]}`).toBe(true)
        }
      }
    })
  })

  describe('buildAuthorizationContextSection', () => {
    it('returns null when neither workspace nor authorized files exist', () => {
      expect(buildAuthorizationContextSection({})).toBeNull()
      expect(buildAuthorizationContextSection({ authorizedFilePaths: [] })).toBeNull()
    })

    it('includes the workspace root when bound', () => {
      const section = buildAuthorizationContextSection({ workspacePath: '/repo/demo' })!
      expect(section).toContain('# 授权上下文')
      expect(section).toContain('/repo/demo')
      expect(section).toContain('相对路径')
    })

    it('lists explicitly authorized files and caps overflow with a count', () => {
      const paths = Array.from(
        { length: AUTHORIZED_FILES_PROMPT_LIMIT + 3 },
        (_, index) => `/abs/file-${index}.ts`,
      )
      const section = buildAuthorizationContextSection({ authorizedFilePaths: paths })!
      expect(section).toContain('/abs/file-0.ts')
      expect(section).toContain(`/abs/file-${AUTHORIZED_FILES_PROMPT_LIMIT - 1}.ts`)
      expect(section).not.toContain(`/abs/file-${AUTHORIZED_FILES_PROMPT_LIMIT}.ts`)
      expect(section).toContain('另有 3 个')
    })
  })

  describe('buildSessionBasePrompt', () => {
    it('omits the authorization section when no authorization context exists', () => {
      const prompt = buildSessionBasePrompt({ capabilities: ['workspace:read'] })
      expect(prompt).not.toContain('# 授权上下文')
      expect(prompt).toContain('# 安全边界')
      expect(prompt).toContain('# 工具发现')
    })

    it('renders builtin skills in 项目上下文 even when no AGENTS.md is loaded', () => {
      const prompt = buildSessionBasePrompt({ capabilities: ['workspace:read'] })
      expect(prompt).toContain('# 项目上下文')
      expect(prompt).toContain('<available_skills>')
      expect(prompt).toContain('<skill source="builtin">')
    })

    it('places authorization, project context, and discovery in the canonical order', () => {
      const prompt = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        workspacePath: '/repo/demo',
        projectContext: '## 约定\n使用 pnpm',
      })
      const safety = prompt.indexOf('# 安全边界')
      const authorization = prompt.indexOf('# 授权上下文')
      const project = prompt.indexOf('# 项目上下文')
      const discovery = prompt.indexOf('# 工具发现')
      expect(safety).toBeGreaterThan(-1)
      expect(authorization).toBeGreaterThan(safety)
      expect(project).toBeGreaterThan(authorization)
      expect(discovery).toBeGreaterThan(project)
    })

    it('injects <available_skills> as a sub-block of 项目上下文 after the AGENTS.md body', () => {
      const prompt = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        projectContext: '## 约定\n使用 pnpm',
        projectSkills: projectSkillsSnapshot(),
      })
      const project = prompt.indexOf('# 项目上下文')
      const agentsBody = prompt.indexOf('## 约定')
      const skillsBlock = prompt.indexOf('<available_skills>')
      const discovery = prompt.indexOf('# 工具发现')
      expect(project).toBeGreaterThan(-1)
      expect(agentsBody).toBeGreaterThan(project)
      expect(skillsBlock).toBeGreaterThan(agentsBody)
      expect(discovery).toBeGreaterThan(skillsBlock)
      expect(prompt).toContain('<name>pdf-tools</name>')
    })

    it('renders 项目上下文 with skills even when AGENTS.md is absent', () => {
      const prompt = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        projectSkills: projectSkillsSnapshot(),
      })
      expect(prompt).toContain('# 项目上下文')
      expect(prompt).toContain('<available_skills>')
    })

    it('injects <available_docs> as a sub-block of 项目上下文 after skills', () => {
      const prompt = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        projectContext: '## 约定\n使用 pnpm',
        projectSkills: projectSkillsSnapshot(),
        projectDocs: {
          entries: [{ role: 'domain', title: '领域约束', relativePath: '.specs/domain/a.md' }],
          truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0,
        },
      })
      const skillsBlock = prompt.indexOf('<available_skills>')
      const docsBlock = prompt.indexOf('<available_docs>')
      expect(skillsBlock).toBeGreaterThan(-1)
      expect(docsBlock).toBeGreaterThan(skillsBlock)
      expect(prompt).toContain('<doc role="domain" path=".specs/domain/a.md">领域约束</doc>')
    })

    it('renders 项目上下文 with docs even when AGENTS.md is absent', () => {
      const prompt = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        projectDocs: {
          entries: [{ role: 'doc', title: '实现现状', relativePath: '.docs/a.md' }],
          truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0,
        },
      })
      expect(prompt).toContain('# 项目上下文')
      expect(prompt).toContain('<available_docs>')
    })

    it('omits <available_docs> when the inventory is empty', () => {
      const prompt = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        projectDocs: { entries: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
      })
      expect(prompt).not.toContain('<available_docs>')
    })

    it('renders builtin skills when the project snapshot is empty or all skills are disabled', () => {
      const empty = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        projectSkills: { schemaVersion: 1, skills: [] },
      })
      expect(empty).toContain('# 项目上下文')
      expect(empty).toContain('<available_skills>')
      expect(empty).toContain('<skill source="builtin">')

      const disabled = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        projectSkills: {
          schemaVersion: 1,
          skills: [{ ...projectSkillsSnapshot().skills[0]!, disableModelInvocation: true }],
        },
      })
      expect(disabled).toContain('<available_skills>')
      expect(disabled).toContain('<skill source="builtin">')
      expect(disabled).not.toContain('<name>pdf-tools</name>')
    })

    it('injects modelName into the 角色 section and omits it when absent', () => {
      const withModel = buildSessionBasePrompt({
        capabilities: ['workspace:read'],
        modelName: 'DeepSeek V4 Flash',
      })
      expect(withModel).toContain('底层模型显示名为「DeepSeek V4 Flash」')
      const withoutModel = buildSessionBasePrompt({ capabilities: ['workspace:read'] })
      expect(withoutModel).not.toContain('底层模型')
      // 模型身份行在 # 角色 段内，早于 # 安全边界，不影响既有分节
      expect(withModel.indexOf('底层模型')).toBeLessThan(withModel.indexOf('# 安全边界'))
    })

    it('declares the input convention for @ / # mentions', () => {
      const prompt = buildSessionBasePrompt({ capabilities: ['workspace:read'] })
      expect(prompt).toContain('# 输入约定')
      expect(prompt).toContain('@[名称](路径)')
      expect(prompt).toContain('/技能名')
      expect(prompt).toContain('#[名称](会话ID)')
    })

    it('places the input convention before the capability safety section', () => {
      const prompt = buildSessionBasePrompt({ capabilities: ['workspace:read'] })
      const convention = prompt.indexOf('# 输入约定')
      const safety = prompt.indexOf('# 安全边界')
      expect(convention).toBeGreaterThan(-1)
      expect(safety).toBeGreaterThan(-1)
      expect(convention).toBeLessThan(safety)
    })
  })

  it('exposes a version number and a discovery notice', () => {
    expect(typeof SYSTEM_PROMPT_VERSION).toBe('number')
    expect(TOOL_DISCOVERY_NOTICE).toContain('discover_agent_tools')
    expect(TOOL_DISCOVERY_NOTICE).toContain('# 工具发现')
  })

  // 基准提示词 H2 锚点守卫（人类可读的结构稳定性补充）。SYSTEM_PROMPT_VERSION 与
  // 静态正文指纹的强制绑定见 systemPromptVersionContract.test.ts；这里只断言
  // H2 锚点集合稳定——新增/删除/重命名 H2 即视为提示词变更，需评估 bump。
  it('keeps the base prompt H2 anchors stable', () => {
    const prompt = buildBasePromptSections()
    const headings = prompt.match(/^# .+$/gm) ?? []
    expect(headings).toEqual(['# 角色', '# 协作风格', '# 工作流', '# 失败与收口'])
  })
})

describe('buildSystemPrompt', () => {
  it('returns the base prompt unchanged when no snippets or guidelines exist', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      tools: [tool('a', undefined, undefined)],
    })
    expect(result).toBe('base')
  })

  it('appends a 可用能力 section from snippets', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      tools: [tool('read', '读取文件内容。', undefined)],
    })
    expect(result).toContain('# 可用能力')
    expect(result).toContain('- 读取文件内容。')
  })

  it('appends a 工具使用准则 section from guidelines', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      tools: [tool('read', undefined, ['优先用 read。'])],
    })
    expect(result).toContain('# 工具使用准则')
    expect(result).toContain('- 优先用 read。')
  })

  it('deduplicates guidelines while preserving first-occurrence order', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      tools: [
        tool('a', undefined, ['共享准则', '甲专属']),
        tool('b', undefined, ['共享准则', '乙专属']),
      ],
    })
    const guidelinesLine = result.split('# 工具使用准则\n')[1]
    const lines = guidelinesLine.split('\n').map((line) => line.replace(/^- /, ''))
    // 共享准则 appears once, 甲专属 before 乙专属 (declaration order preserved)
    expect(lines).toEqual(['共享准则', '甲专属', '乙专属'])
  })

  it('respects activeToolNames filter', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      tools: [
        tool('read', '读取。', ['读准则']),
        tool('bash', '运行命令。', ['命令准则']),
      ],
      activeToolNames: ['read'],
    })
    expect(result).toContain('读取。')
    expect(result).not.toContain('运行命令。')
    expect(result).toContain('读准则')
    expect(result).not.toContain('命令准则')
  })
})
