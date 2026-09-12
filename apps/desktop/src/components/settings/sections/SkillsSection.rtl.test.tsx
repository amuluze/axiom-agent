// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillReloadPreview } from '@/stores/agentStateTypes'
import { SkillsSection } from './SkillsSection'

const skill = (name: string, sha: string) => ({
  name,
  description: `${name} 描述`,
  source: { kind: 'project' as const, root: '.axiom/skills' as const },
  relativePath: `.axiom/skills/${name}.md`,
  baseRelativePath: '.axiom/skills',
  contentSha256: sha,
  disableModelInvocation: false,
})

const currentSnapshot = () => ({
  schemaVersion: 1 as const,
  skills: [skill('alpha', 'a'.repeat(64)), skill('beta', 'b'.repeat(64))],
})

const mocks = vi.hoisted(() => {
  const makeSkill = (name: string, sha: string) => ({
    name,
    description: `${name} 描述`,
    source: { kind: 'project' as const, root: '.axiom/skills' as const },
    relativePath: `.axiom/skills/${name}.md`,
    baseRelativePath: '.axiom/skills',
    contentSha256: sha,
    disableModelInvocation: false,
  })
  return {
    authorizedWorkspace: { path: '/repo', name: 'repo' },
    projectSkills: {
      schemaVersion: 1 as const,
      skills: [makeSkill('alpha', 'a'.repeat(64)), makeSkill('beta', 'b'.repeat(64))],
    },
    skillReloadPreview: null as SkillReloadPreview | null,
    previewSkillReload: vi.fn(async () => ({}) as SkillReloadPreview),
    applySkillReload: vi.fn(async () => undefined),
    projectSkillsEnabled: true,
    setProjectSkillsEnabled: vi.fn(),
  }
})

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      authorizedWorkspace: mocks.authorizedWorkspace,
      projectSkills: mocks.projectSkills,
      skillDiagnostics: [],
      skillReloadPreview: mocks.skillReloadPreview,
      previewSkillReload: mocks.previewSkillReload,
      applySkillReload: mocks.applySkillReload,
    } as StoreState),
  }
})

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      projectSkillsEnabled: mocks.projectSkillsEnabled,
      setProjectSkillsEnabled: mocks.setProjectSkillsEnabled,
    } as UiState),
  }
})

afterEach(() => {
  mocks.skillReloadPreview = null
  mocks.previewSkillReload.mockClear()
  mocks.applySkillReload.mockClear()
  mocks.authorizedWorkspace = { path: '/repo', name: 'repo' }
  mocks.projectSkills = {
    schemaVersion: 1 as const,
    skills: [skill('alpha', 'a'.repeat(64)), skill('beta', 'b'.repeat(64))],
  }
})

describe('SkillsSection reload 确认框（RTL）', () => {
  it('重新扫描生成 diff 预览后展开确认区，展示变更与摘要成本提示', async () => {
    const preview: SkillReloadPreview = {
      added: ['gamma'],
      removed: ['beta'],
      changed: [],
      snapshot: { schemaVersion: 1, skills: [skill('alpha', 'a'.repeat(64)), skill('gamma', 'c'.repeat(64))] },
      diagnostics: [],
    }
    mocks.previewSkillReload.mockImplementation(async () => {
      mocks.skillReloadPreview = preview
      return preview
    })

    render(<SkillsSection />)
    fireEvent.click(screen.getByRole('button', { name: /重新扫描/ }))

    expect(await screen.findByText(/检测到 2 项变更/)).toBeTruthy()
    expect(screen.getByText(/新增：gamma/)).toBeTruthy()
    expect(screen.getByText(/删除：beta/)).toBeTruthy()
    expect(screen.getByText(/摘要检查点失效/)).toBeTruthy()
    expect(screen.getByText(/历史较长时下一轮可能增加一次摘要模型调用、费用与等待时间/)).toBeTruthy()
  })

  it('确认应用调用 applySkillReload', async () => {
    const preview: SkillReloadPreview = {
      added: ['gamma'],
      removed: [],
      changed: [],
      snapshot: { schemaVersion: 1, skills: [skill('alpha', 'a'.repeat(64)), skill('gamma', 'c'.repeat(64))] },
      diagnostics: [],
    }
    mocks.previewSkillReload.mockImplementation(async () => {
      mocks.skillReloadPreview = preview
      return preview
    })

    render(<SkillsSection />)
    fireEvent.click(screen.getByRole('button', { name: /重新扫描/ }))
    fireEvent.click(await screen.findByRole('button', { name: /确认应用/ }))

    expect(mocks.applySkillReload).toHaveBeenCalledTimes(1)
  })

  it('无变更时显示"一致"空态，不展开确认区', async () => {
    const preview: SkillReloadPreview = {
      added: [],
      removed: [],
      changed: [],
      snapshot: currentSnapshot(),
      diagnostics: [],
    }
    mocks.previewSkillReload.mockImplementation(async () => {
      mocks.skillReloadPreview = preview
      return preview
    })

    render(<SkillsSection />)
    fireEvent.click(screen.getByRole('button', { name: /重新扫描/ }))

    expect(await screen.findByText(/无待应用的变更/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /确认应用/ })).toBeNull()
  })
})

describe('SkillsSection 内置/项目技能区分展示（RTL）', () => {
  it('内置技能区渲染 6 个内置 Skill 与来源标注，项目区独立成块', () => {
    render(<SkillsSection />)
    expect(screen.getByText('内置技能')).toBeTruthy()
    expect(screen.getByText('项目级技能')).toBeTruthy()
    for (const name of ['domain', 'brainstorm', 'diagnose', 'plan', 'implement', 'finish']) {
      expect(screen.getByText(name)).toBeTruthy()
    }
    // 每个内置项都有「内置」badge；项目 alpha/beta 不带该 badge。
    expect(screen.getAllByText('内置')).toHaveLength(6)
    expect(screen.queryByText(/已被项目同名覆盖/)).toBeNull()
  })

  it('项目同名 Skill 时内置项标注遮蔽关系（load_skill 双通道项目优先）', () => {
    mocks.projectSkills = {
      schemaVersion: 1,
      skills: [
        ...mocks.projectSkills.skills,
        { ...skill('plan', 'p'.repeat(64)) },
      ],
    }
    render(<SkillsSection />)
    const planBadges = screen.getAllByText('plan').length
    expect(planBadges).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/已被项目同名覆盖/)).toBeTruthy()
  })

  it('无授权工作区时内置技能区仍展示（内置与工作区无关）', () => {
    mocks.authorizedWorkspace = null as unknown as { path: string; name: string }
    render(<SkillsSection />)
    expect(screen.getByText('内置技能')).toBeTruthy()
    expect(screen.getByText('brainstorm')).toBeTruthy()
    expect(screen.getByText(/尚未激活工作区/)).toBeTruthy()
  })
})
