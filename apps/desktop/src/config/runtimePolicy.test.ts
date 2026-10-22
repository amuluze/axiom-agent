import { describe, expect, it } from 'vitest'
import { createRuntimePolicy } from './runtimePolicy'

describe('runtime policy', () => {
  it('keeps Demo provider available for browser development', () => {
    expect(createRuntimePolicy({ development: true, desktop: false })).toMatchObject({
      mode: 'development',
      allowDemoProvider: true,
      allowInitializationFallback: true,
      requireConfiguredProvider: false,
      toolCapabilities: [],
    })
  })

  it('开发档只留本地 loopback：外部目标与 Agent 生成都关闭，但探索能力仍授予', () => {
    // H1-5 分阶段发布第 1 档（开发 feature flag）：收窄发生在工具门
    // （api_request 的 externalTargets），不是能力裁剪——本地开发仍要能 discover 并使用工具。
    expect(createRuntimePolicy({ development: true, desktop: true })).toMatchObject({
      mode: 'development',
      testAutomation: { externalTargets: false, agentGeneration: false },
    })
    expect(createRuntimePolicy({ development: true, desktop: true }).toolCapabilities)
      .toContain('api-test:request')
  })

  it('生产档按内测/Beta 语义放开外部目标与 Agent 生成（与历史行为一致）', () => {
    expect(createRuntimePolicy({ development: false, desktop: true })).toMatchObject({
      mode: 'production',
      testAutomation: { externalTargets: true, agentGeneration: true },
    })
  })

  it('非桌面运行时同样按档位派生策略（与能力表无关）', () => {
    expect(createRuntimePolicy({ development: true, desktop: false }).testAutomation)
      .toEqual({ externalTargets: false, agentGeneration: false })
    expect(createRuntimePolicy({ development: false, desktop: false }).testAutomation)
      .toEqual({ externalTargets: true, agentGeneration: true })
  })

  it.each([true, false])('starts desktop with coding read/write plus UI/API exploration and sub-agents, before native probing (development=%s)', (development) => {
    // 子代理、UI 探索与 API 探索能力不依赖沙箱探测（都不使用命令执行面），因此在探测之前即授予。
    expect(createRuntimePolicy({ development, desktop: true }).toolCapabilities).toEqual([
      'workspace:read', 'workspace:write', 'ui-test:read', 'ui-test:write', 'api-test:request', 'subagent:review', 'subagent:explore',
    ])
  })

  it('非桌面运行时不给任何能力（含子代理）', () => {
    expect(createRuntimePolicy({ development: false, desktop: false }).toolCapabilities).toEqual([])
  })

  it.each(['macos', 'linux'])('adds execution only after a successful native sandbox probe on %s', (operatingSystem) => {
    expect(createRuntimePolicy({
      development: false, desktop: true, operatingSystem, sandboxAvailable: true,
    }).toolCapabilities).toEqual([
      'workspace:read', 'workspace:write', 'workspace:execute',
      'ui-test:read', 'ui-test:write', 'api-test:request', 'subagent:review', 'subagent:explore',
    ])
  })

  it.each(['macos', 'linux', 'windows', 'unknown'])('closes execution on unavailable or unsupported sandboxes (%s)', (operatingSystem) => {
    for (const sandboxAvailable of [false, undefined]) {
      expect(createRuntimePolicy({
        development: false, desktop: true, operatingSystem, sandboxAvailable,
      }).toolCapabilities).toEqual(['workspace:read', 'workspace:write', 'ui-test:read', 'ui-test:write', 'api-test:request', 'subagent:review', 'subagent:explore'])
    }
  })

  it('rejects a positive probe on unsupported platforms and browser runtimes', () => {
    expect(createRuntimePolicy({
      development: false, desktop: true, operatingSystem: 'windows', sandboxAvailable: true,
    }).toolCapabilities).toEqual(['workspace:read', 'workspace:write', 'ui-test:read', 'ui-test:write', 'api-test:request', 'subagent:review', 'subagent:explore'])
    expect(createRuntimePolicy({
      development: true, desktop: false, operatingSystem: 'macos', sandboxAvailable: true,
    }).toolCapabilities).toEqual([])
  })

  it('requires a real Provider in production', () => {
    expect(createRuntimePolicy({ development: false, desktop: true })).toMatchObject({
      mode: 'production', allowDemoProvider: false,
      allowInitializationFallback: false, requireConfiguredProvider: true,
    })
  })
})
