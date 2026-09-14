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
    expect(namesFor(['workspace:read'])).toEqual(['read', 'ls', 'grep', 'find', 'load_skill'])
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
    // 契约版本各自独立（与 runtime-semantic-versions.json / toolNameMigrations 对齐）：
    // review v6 / inspect·examine v4——fail 判定前置软门禁回环提示、无 diff 降级处理。
    const byName = new Map(reviewers.map((tool) => [tool.name, tool.runtimeVersion]))
    expect(byName.get('inspect_subagent')).toBe('5')
    expect(byName.get('examine_subagent')).toBe('5')
    expect(byName.get('review_subagent')).toBe('7')
  })

  it('explore_subagent 不要求审批、sequential、recoveryPolicy never，且不在默认激活集', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:read', 'subagent:explore'] })
    const explore = tools.find((tool) => tool.name === 'explore_subagent')!
    expect(explore.recoveryPolicy).toBe('never')
    expect(explore.requiresApproval).toBe(false)
    expect(explore.executionMode).toBe('sequential')
    expect(explore.runtimeVersion).toBe('10')
    // 首版 discover-gated：不加入 productToolRuntime 的 ALWAYS_ACTIVE_READ_TOOLS
    expect(createProductToolRuntime(['workspace:read', 'subagent:explore'], undefined).activeToolNames)
      .not.toContain('explore_subagent')
  })

  it('load_skill 不要求审批且是可幂等只读工具', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:read'] })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')!
    expect(loadSkill.recoveryPolicy).toBe('idempotent')
    expect(loadSkill.runtimeVersion).toBe('5')
    expect(loadSkill.executionMode).not.toBe('sequential')
  })

  it('web 工具仅在 web:read 下注册，幂等只读且不进入默认激活集', () => {
    expect(namesFor(['workspace:read'])).not.toContain('web_search')
    expect(namesFor(['web:read'])).toEqual(['web_search', 'web_fetch'])
    const tools = createToolRegistry({ capabilities: ['workspace:read', 'web:read'] })
    for (const tool of tools.filter((entry) => ['web_search', 'web_fetch'].includes(entry.name))) {
      expect(tool.recoveryPolicy).toBe('idempotent')
      expect(tool.requiresApproval).toBe(false)
      expect(tool.runtimeVersion).toBe('1')
      expect(tool.executionMode).not.toBe('sequential')
    }
    // discover-gated：外部内容不可信且涉及查询词外发，不随会话启动默认激活。
    expect(createProductToolRuntime(['workspace:read', 'web:read'], undefined).activeToolNames)
      .not.toContain('web_search')
    expect(createProductToolRuntime(['workspace:read', 'web:read'], undefined).activeToolNames)
      .not.toContain('web_fetch')
  })

  it('browser 工具仅在 web:browser 下注册，恢复策略 never 且不进默认激活集', () => {
    expect(namesFor(['web:read'])).not.toContain('browser')
    expect(namesFor(['web:browser'])).toEqual(['browser'])
    const tools = createToolRegistry({ capabilities: ['web:browser'] })
    const browser = tools.find((tool) => tool.name === 'browser')
    expect(browser).toBeDefined()
    // 点击/填写是有状态副作用，崩溃恢复不重放；浏览器是共享有状态资源，
    // 与写工具同档串行执行；不消费审批（隔离 profile 无登录态）。
    expect(browser?.recoveryPolicy).toBe('never')
    expect(browser?.requiresApproval).toBe(false)
    expect(browser?.executionMode).toBe('sequential')
    // v2：新增 console 动作 + 快照状态注记（迁移链见 toolNameMigrations.ts）。
    expect(browser?.runtimeVersion).toBe('4')
    expect(createProductToolRuntime(['workspace:read', 'web:browser'], undefined).activeToolNames)
      .not.toContain('browser')
  })

  it('ssh 工具仅在 ssh:remote 下注册，exec 逐次审批、hosts 只读免审批', () => {
    expect(namesFor(['web:browser'])).not.toContain('ssh')
    expect(namesFor(['ssh:remote'])).toEqual(['ssh_hosts', 'ssh'])
    const tools = createToolRegistry({ capabilities: ['ssh:remote'] })
    const hosts = tools.find((tool) => tool.name === 'ssh_hosts')!
    const exec = tools.find((tool) => tool.name === 'ssh')!
    // 清单只读可并行、免审批；exec 是真实远程主机的副作用操作：逐次审批
    // （lease 绑定 {host, command}）+ Rust 会话授权表，顺序执行、崩溃不重放。
    expect(hosts.requiresApproval).toBe(false)
    expect(hosts.executionMode).toBe('parallel')
    expect(hosts.recoveryPolicy).toBe('never')
    expect(exec.requiresApproval).toBe(true)
    expect(exec.executionMode).toBe('sequential')
    expect(exec.recoveryPolicy).toBe('never')
    expect(exec.runtimeVersion).toBe('1')
    expect(hosts.runtimeVersion).toBe('2')
    // discover-gated：不随会话启动默认激活（与 browser/computer 同一语义）。
    expect(createProductToolRuntime(['workspace:read', 'ssh:remote'], undefined).activeToolNames)
      .not.toContain('ssh')
    expect(createProductToolRuntime(['workspace:read', 'ssh:remote'], undefined).activeToolNames)
      .not.toContain('ssh_hosts')
  })

  it('registers protected workspace write tools together', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:write'] })
    expect(tools.map((tool) => tool.name)).toEqual([
      'write',
      'edit',
      'apply_changes',
      'restore_trash',
    ])
    expect(tools.every((tool) => tool.requiresApproval && tool.executionMode === 'sequential')).toBe(true)
    expect(tools.map((tool) => tool.runtimeVersion)).toEqual(['6', '7', '5', '3'])
  })

  it('registers command execution separately and always requires serial one-time approval', () => {
    const tools = createToolRegistry({ capabilities: ['workspace:execute'] })
    expect(tools.map((tool) => tool.name)).toEqual(['bash'])
    expect(tools.every((tool) => tool.requiresApproval && tool.executionMode === 'sequential')).toBe(true)
    expect(tools[0]?.runtimeVersion).toBe('15')
  })

  it('returns no tools when the runtime has no granted capabilities', () => {
    expect(namesFor([])).toEqual([])
  })
})
