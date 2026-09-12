import { describe, expect, it, vi } from 'vitest'
import {
  bindAgentEnvironment,
  desktopAgentEnvironment,
  getAgentEnvironment,
} from './agentEnvironmentHost'
import type { AgentEnvironment } from './AgentEnvironment'
import type { RuntimeInfo } from '@/platform/runtimeInfo'

describe('agentEnvironmentHost seam', () => {
  it('fails closed before binding (未 bind 时 fail-closed)', async () => {
    await expect(getAgentEnvironment().workspace.readText('a.ts', 0, 1))
      .rejects.toMatchObject({ code: 'unavailable', name: 'AgentEnvironmentError' })
    await expect(getAgentEnvironment().artifacts.writeToolResult({
      runId: 'r',
      toolCallId: 'c',
      toolName: 'bash',
      content: 'x',
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('forwards to the bound implementation via getAgentEnvironment', async () => {
    const getInfo = vi.fn(async () => ({ mode: 'desktop' as const, capabilities: [] as string[] }) as unknown as RuntimeInfo)
    const impl: AgentEnvironment = {
      runtime: { getInfo },
      authorizedFiles: { list: vi.fn(async () => []), readText: vi.fn() },
      workspace: {
        list: vi.fn(), readText: vi.fn(), searchText: vi.fn(), createTextFile: vi.fn(),
        editTextFile: vi.fn(), applyChanges: vi.fn(), restoreTrash: vi.fn(), runCommand: vi.fn(),
        find: vi.fn(),
      },
      artifacts: { writeToolResult: vi.fn() },
      web: {
        search: vi.fn(),
        fetch: vi.fn(),
      },
      browser: {
        command: vi.fn(),
      },
      computer: {
        command: vi.fn(),
      },
      ssh: {
        command: vi.fn(),
      },
    }
    bindAgentEnvironment(impl)

    await expect(getAgentEnvironment().runtime.getInfo())
      .resolves.toEqual({ mode: 'desktop', capabilities: [] })
    expect(getInfo).toHaveBeenCalledTimes(1)
  })

  it('lazy proxy routes module-level tool singletons to the bound implementation', async () => {
    const getInfo = vi.fn(async () => ({ mode: 'desktop' as const, capabilities: ['workspace:read'] as string[] }) as unknown as RuntimeInfo)
    bindAgentEnvironment({
      runtime: { getInfo },
      authorizedFiles: { list: vi.fn(async () => []), readText: vi.fn() },
      workspace: {
        list: vi.fn(), readText: vi.fn(), searchText: vi.fn(), createTextFile: vi.fn(),
        editTextFile: vi.fn(), applyChanges: vi.fn(), restoreTrash: vi.fn(), runCommand: vi.fn(),
        find: vi.fn(),
      },
      artifacts: { writeToolResult: vi.fn() },
      web: {
        search: vi.fn(),
        fetch: vi.fn(),
      },
      browser: {
        command: vi.fn(),
      },
      computer: {
        command: vi.fn(),
      },
      ssh: {
        command: vi.fn(),
      },
    })

    // tools 在模块加载时捕获 desktopAgentEnvironment（proxy），bind 后调用仍指向新实现
    await expect(desktopAgentEnvironment.runtime.getInfo())
      .resolves.toEqual({ mode: 'desktop', capabilities: ['workspace:read'] })
    expect(getInfo).toHaveBeenCalledTimes(1)
  })
})
