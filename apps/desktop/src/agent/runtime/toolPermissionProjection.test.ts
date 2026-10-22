import { describe, expect, it } from 'vitest'
import { createProductToolRuntime } from './productToolRuntime'
import { projectSessionActiveToolNames } from './toolPermissionProjection'

describe('session tool permission projection', () => {
  const coding = createProductToolRuntime(['workspace:read', 'workspace:write', 'workspace:execute'])

  it('drops privileged and delegated tools from restored sessions without granting new tools', () => {
    const restored = ['read_workspace_file', 'run_workspace_command', 'ssh', 'ssh_hosts', 'computer',
      'browser', 'web_fetch', 'web_search', 'explore_subagent', 'inspect_subagent', 'examine_subagent', 'review_subagent']
    const original = restored.slice()
    const names = projectSessionActiveToolNames(restored, coding.tools, coding.activeToolNames)
    expect(names).toEqual(expect.arrayContaining(['read', 'ls', 'grep', 'find', 'bash', 'discover_agent_tools']))
    expect(names).toHaveLength(6)
    expect(names).not.toContain('write')
    expect(restored).toEqual(original)
  })

  it('removes restored execution when the current platform cannot sandbox commands', () => {
    const runtime = createProductToolRuntime(['workspace:read', 'workspace:write'])
    expect(projectSessionActiveToolNames(['bash'], runtime.tools, runtime.activeToolNames)).toEqual(runtime.activeToolNames)
  })

  it('silently drops persisted channel tools that are no longer registered', () => {
    // web/browser/ssh/computer 等通道工具已随会话能力预设清理移除：旧会话
    // 持久化的这些活动工具名必须在能力门控名单内被静默裁剪，恢复不拒绝。
    expect(projectSessionActiveToolNames(['web_search', 'web_fetch', 'browser', 'ssh', 'ssh_hosts', 'computer'], coding.tools, coding.activeToolNames))
      .toEqual(coding.activeToolNames)
  })

  it('fails on unknown persisted tool names and missing mandatory tools', () => {
    expect(() => projectSessionActiveToolNames(['malicious_tool'], coding.tools, coding.activeToolNames))
      .toThrow('Session 活动工具未注册')
    expect(() => projectSessionActiveToolNames([], coding.tools, ['ghost'])).toThrow('Session 必需工具未注册')
  })

  it('未授予 ui-test:read 时恢复会话里的 ui 工具名被静默裁剪（能力门，不拒绝）', () => {
    // 与其它能力门控工具同一条恢复路径：当前运行时不注册这些名字 → 静默裁剪，
    // 既不因未知工具名拒绝恢复，也不会凭空激活。
    expect(projectSessionActiveToolNames(['ui_assert', 'ui_snapshot'], coding.tools, coding.activeToolNames))
      .toEqual(coding.activeToolNames)
  })

  it('授予能力时新会话仍不默认激活 ui 工具（discover-gated）', () => {
    const runtime = createProductToolRuntime(['workspace:read', 'ui-test:read'])
    expect(runtime.tools.map((tool) => tool.name)).toContain('ui_assert')
    expect(runtime.activeToolNames).not.toContain('ui_assert')
  })

  it('未授予 ui-test:write 时恢复会话里的 UI 写工具名被静默裁剪（能力门，不拒绝）', () => {
    const runtime = createProductToolRuntime(['workspace:read', 'ui-test:read'])
    expect(projectSessionActiveToolNames(['ui_click', 'ui_navigate', 'ui_press'], runtime.tools, runtime.activeToolNames))
      .toEqual(runtime.activeToolNames)
  })

  it('授予 ui-test:write 时新会话仍不默认激活 UI 写工具（discover-gated + 逐次审批）', () => {
    const runtime = createProductToolRuntime(['workspace:read', 'ui-test:write'])
    expect(runtime.tools.map((tool) => tool.name)).toContain('ui_click')
    expect(runtime.activeToolNames).not.toContain('ui_click')
  })

  it('未授予 api-test:request 时恢复会话里的 api_request 被静默裁剪（能力门，不拒绝）', () => {
    expect(projectSessionActiveToolNames(['api_request'], coding.tools, coding.activeToolNames))
      .toEqual(coding.activeToolNames)
  })

  it('授予 api-test:request 时新会话仍不默认激活 api_request（discover-gated）', () => {
    const runtime = createProductToolRuntime(['workspace:read', 'api-test:request'])
    expect(runtime.tools.map((tool) => tool.name)).toContain('api_request')
    expect(runtime.activeToolNames).not.toContain('api_request')
  })
})
