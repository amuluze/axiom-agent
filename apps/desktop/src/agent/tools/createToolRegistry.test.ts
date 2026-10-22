import { describe, expect, it } from 'vitest'
import { createToolRegistry } from './createToolRegistry'
import { createProductToolRuntime } from '@/agent/runtime/productToolRuntime'

const namesFor = (capabilities: Parameters<typeof createToolRegistry>[0]['capabilities']) =>
  createToolRegistry({ capabilities }).map((tool) => tool.name)

describe('tool registry', () => {
  it('does not expose diagnostics to a production file capability set', () => {
    expect(namesFor(['filesystem:read'])).toEqual(['read'])
  })

  it('registers the scoped workspace discovery toolset together', () => {
    expect(namesFor(['workspace:read'])).toEqual(['read', 'ls', 'grep', 'find', 'design_query', 'load_skill'])
  })

  it('Explore 仅在 workspace:read + subagent:explore 下注册', () => {
    expect(namesFor(['workspace:read'])).not.toContain('explore_subagent')
    expect(namesFor(['subagent:explore'])).not.toContain('explore_subagent')
    expect(namesFor(['workspace:read', 'subagent:explore'])).toContain('explore_subagent')
  })

  it('审查 SubAgent 仅在 workspace:read + subagent:review 下注册，与 explore 解耦', () => {
    expect(namesFor(['workspace:read'])).not.toContain('inspect_subagent')
    expect(namesFor(['workspace:read', 'subagent:explore'])).not.toContain('inspect_subagent')
    expect(namesFor(['subagent:review'])).not.toContain('inspect_subagent')
    expect(namesFor(['workspace:read', 'subagent:review'])).toEqual([
      'read',
      'ls',
      'grep',
      'find',
      'design_query',
      'load_skill',
      'inspect_subagent',
      'examine_subagent',
      'review_subagent',
    ])
  })

  it('审查 SubAgent 不要求审批、sequential、recoveryPolicy never', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:read', 'subagent:review'] })
    const reviewers = tools.filter((tool) =>
      ['inspect_subagent', 'examine_subagent', 'review_subagent'].includes(tool.name))
    expect(reviewers).toHaveLength(3)
    for (const reviewer of reviewers) {
      expect(reviewer.recoveryPolicy).toBe('never')
      expect(reviewer.requiresApproval).toBe(false)
      expect(reviewer.executionMode).toBe('sequential')
    }
    // 契约版本各自独立（与 runtime-semantic-versions.json / toolNameMigrations 对齐）。
    const byName = new Map(reviewers.map((tool) => [tool.name, tool.runtimeVersion]))
    expect(byName.get('inspect_subagent')).toBe('11')
    expect(byName.get('examine_subagent')).toBe('11')
    expect(byName.get('review_subagent')).toBe('13')
  })

  it('explore_subagent 不要求审批、sequential、recoveryPolicy never，且不在默认激活集', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:read', 'subagent:explore'] })
    const explore = tools.find((tool) => tool.name === 'explore_subagent')!
    expect(explore.recoveryPolicy).toBe('never')
    expect(explore.requiresApproval).toBe(false)
    expect(explore.executionMode).toBe('sequential')
    expect(explore.runtimeVersion).toBe('16')
    // 首版 discover-gated：不加入 productToolRuntime 的 ALWAYS_ACTIVE_READ_TOOLS
    expect(createProductToolRuntime(['workspace:read', 'subagent:explore'], undefined).activeToolNames)
      .not.toContain('explore_subagent')
  })

  it('load_skill 不要求审批且是可幂等只读工具', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:read'] })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')!
    expect(loadSkill.recoveryPolicy).toBe('idempotent')
    expect(loadSkill.runtimeVersion).toBe('6')
    expect(loadSkill.executionMode).not.toBe('sequential')
  })




  it('registers protected workspace write tools together', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:write'] })
    expect(tools.map((tool) => tool.name)).toEqual([
      'write',
      'edit',
      'apply_changes',
      'restore_trash',
      'design_import',
    ])
    expect(tools.every((tool) => tool.requiresApproval && tool.executionMode === 'sequential')).toBe(true)
    expect(tools.map((tool) => tool.runtimeVersion)).toEqual(['12', '12', '10', '7', '9'])
  })

  it('registers command execution separately and always requires serial one-time approval', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:execute'] })
    expect(tools.map((tool) => tool.name)).toEqual(['bash'])
    expect(tools.every((tool) => tool.requiresApproval && tool.executionMode === 'sequential')).toBe(true)
    expect(tools[0]?.runtimeVersion).toBe('26')
  })

  it('returns no tools when the runtime has no granted capabilities', () => {
    expect(namesFor([])).toEqual([])
  })

  describe('UI 只读探索工具（ui-test:read）', () => {
    const UI_TOOL_NAMES = ['ui_snapshot', 'ui_find', 'ui_screenshot', 'ui_wait', 'ui_assert']

    it('仅在 workspace:read + ui-test:read 同时授予时注册，只读且不要求审批', () => {
      expect(namesFor(['ui-test:read'])).not.toContain('ui_snapshot')
      expect(namesFor(['workspace:read'])).not.toContain('ui_snapshot')
      const tools = createToolRegistry({ capabilities: ['workspace:read', 'ui-test:read'] })
      const uiTools = tools.filter((tool) => UI_TOOL_NAMES.includes(tool.name))
      expect(uiTools.map((tool) => tool.name)).toEqual(UI_TOOL_NAMES)
      for (const tool of uiTools) {
        expect(tool.requiresApproval).toBeFalsy()
        expect(tool.recoveryPolicy).toBe('idempotent')
        expect(tool.runtimeVersion).toBe('1')
        expect(tool.executionMode).not.toBe('sequential')
      }
    })

    it('discover-gated：注册到完整工具表但不进默认激活集', () => {
      const runtime = createProductToolRuntime(['workspace:read', 'ui-test:read'], undefined)
      expect(runtime.activeToolNames).toEqual(['discover_agent_tools', 'read', 'ls', 'grep', 'find'])
      for (const name of UI_TOOL_NAMES) {
        expect(runtime.tools.map((tool) => tool.name)).toContain(name)
        expect(runtime.activeToolNames).not.toContain(name)
      }
    })
  })

  describe('UI 写探索工具（ui-test:write）', () => {
    const UI_WRITE_TOOL_NAMES = ['ui_navigate', 'ui_click', 'ui_input', 'ui_select', 'ui_press']
    // ui_click/ui_input/ui_select 加宽为 locator|ref 二选一后升到 v2；ui_navigate/ui_press 不变。
    const UI_WRITE_TOOL_VERSIONS: Record<string, string> = {
      ui_navigate: '1',
      ui_click: '2',
      ui_input: '2',
      ui_select: '2',
      ui_press: '1',
    }

    it('仅在 workspace:read + ui-test:write 同时授予时注册，全部要求逐次审批且串行', () => {
      expect(namesFor(['ui-test:write'])).not.toContain('ui_navigate')
      expect(namesFor(['workspace:read'])).not.toContain('ui_navigate')
      // 只读能力不隐含写能力：两个注册门互相独立。
      expect(namesFor(['workspace:read', 'ui-test:read'])).not.toContain('ui_navigate')
      const tools = createToolRegistry({ capabilities: ['workspace:read', 'ui-test:write'] })
      const uiTools = tools.filter((tool) => UI_WRITE_TOOL_NAMES.includes(tool.name))
      expect(uiTools.map((tool) => tool.name)).toEqual(UI_WRITE_TOOL_NAMES)
      for (const tool of uiTools) {
        expect(tool.requiresApproval).toBe(true)
        expect(tool.recoveryPolicy).toBe('idempotent')
        expect(tool.runtimeVersion).toBe(UI_WRITE_TOOL_VERSIONS[tool.name])
        expect(tool.executionMode).toBe('sequential')
        expect(typeof tool.idempotencyKey).toBe('function')
        expect(typeof tool.approvalPresentation).toBe('function')
        // browser_command 不消费审批租约：Agent 层审批即门，写工具不得声明租约绑定输入。
        expect(tool.approvalLeaseInput).toBeUndefined()
      }
    })

    it('discover-gated：注册到完整工具表但不进默认激活集', () => {
      const runtime = createProductToolRuntime(['workspace:read', 'ui-test:write'], undefined)
      expect(runtime.activeToolNames).toEqual(['discover_agent_tools', 'read', 'ls', 'grep', 'find'])
      for (const name of UI_WRITE_TOOL_NAMES) {
        expect(runtime.tools.map((tool) => tool.name)).toContain(name)
        expect(runtime.activeToolNames).not.toContain(name)
      }
    })
  })

  describe('API 探索工具（api-test:request）', () => {
    it('仅在 workspace:read + api-test:request 同时授予时注册，要求逐次审批且不声明幂等键', () => {
      expect(namesFor(['api-test:request'])).not.toContain('api_request')
      expect(namesFor(['workspace:read'])).not.toContain('api_request')
      // UI 能力不隐含出网能力：两组注册门互相独立。
      expect(namesFor(['workspace:read', 'ui-test:write', 'ui-test:read'])).not.toContain('api_request')
      const tool = createToolRegistry({ capabilities: ['workspace:read', 'api-test:request'] })
        .find((candidate) => candidate.name === 'api_request')
      expect(tool).toBeDefined()
      expect(tool?.requiresApproval).toBe(true)
      expect(tool?.executionMode).toBe('sequential')
      expect(tool?.runtimeVersion).toBe('5')
      expect(typeof tool?.approvalPresentation).toBe('function')
      // 工具覆盖 GET…DELETE：POST/PUT/PATCH/DELETE 不允许自动重放（设计 §9.3），
      // 故整体取 never——never 工具不得声明幂等键（deferredTools 会直接拒绝）。
      expect(tool?.recoveryPolicy).toBe('never')
      expect(tool?.idempotencyKey).toBeUndefined()
      expect(tool?.approvalLeaseInput).toBeUndefined()
    })

    it('discover-gated：注册到完整工具表但不进默认激活集', () => {
      const runtime = createProductToolRuntime(['workspace:read', 'api-test:request'], undefined)
      expect(runtime.activeToolNames).toEqual(['discover_agent_tools', 'read', 'ls', 'grep', 'find'])
      expect(runtime.tools.map((candidate) => candidate.name)).toContain('api_request')
      expect(runtime.activeToolNames).not.toContain('api_request')
    })
  })
})
