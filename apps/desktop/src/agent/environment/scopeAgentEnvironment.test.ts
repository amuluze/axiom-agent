import { describe, expect, it, vi } from 'vitest'
import type { AgentCapability } from '@/config/runtimePolicy'
import type { BrowserCommandResponse } from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from '../tools/__fixtures__/fakeAgentEnvironment'
import { scopeAgentEnvironment } from './scopeAgentEnvironment'

describe('capability-scoped agent environment', () => {
  it('blocks privileged host primitives even when a coding tool calls them indirectly', async () => {
    const host = createFakeAgentEnvironment()
    const scoped = scopeAgentEnvironment(host, ['workspace:read', 'workspace:write'])
    await expect(scoped.workspace.runCommand({ requestId: 'command', command: 'pwd' }, new AbortController().signal, undefined, 'lease'))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect(host.workspace.runCommand).not.toHaveBeenCalled()
  })

  it('blocks every mutation for a read-only scope before consuming leases or calling the host', async () => {
    const host = createFakeAgentEnvironment()
    const scoped = scopeAgentEnvironment(host, ['workspace:read'])
    await expect(scoped.workspace.createTextFile('a.txt', 'text', 'lease')).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(scoped.workspace.editTextFile('a.txt', [], 'lease')).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(scoped.workspace.applyChanges({ requestId: 'change', operations: [] }, 'lease')).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(scoped.workspace.restoreTrash('recovery', 'lease')).rejects.toMatchObject({ code: 'not_authorized' })
    expect(host.workspace.createTextFile).not.toHaveBeenCalled()
    expect(host.workspace.editTextFile).not.toHaveBeenCalled()
    expect(host.workspace.applyChanges).not.toHaveBeenCalled()
    expect(host.workspace.restoreTrash).not.toHaveBeenCalled()
  })

  it('freezes the granted capability set instead of following mutations to the caller array', async () => {
    const host = createFakeAgentEnvironment()
    const capabilities: AgentCapability[] = ['workspace:read']
    const scoped = scopeAgentEnvironment(host, capabilities)
    capabilities.push('workspace:write')
    await expect(scoped.workspace.list()).resolves.toMatchObject({ entries: [] })
    expect(host.workspace.list).toHaveBeenCalledOnce()
  })

  it('未授予 ui-test:read 时浏览器通道抛 not_authorized 且不触达宿主', async () => {
    const host = createFakeAgentEnvironment()
    const scoped = scopeAgentEnvironment(host, ['workspace:read'])
    await expect(scoped.browser.command({ action: 'tabs' })).rejects.toMatchObject({
      code: 'not_authorized',
      name: 'AgentEnvironmentError',
    })
    expect(host.browser.command).not.toHaveBeenCalled()
  })

  it('授予 ui-test:read 时原样透传浏览器通道（含只读动作与响应）', async () => {
    const host = createFakeAgentEnvironment()
    const response: BrowserCommandResponse = { type: 'tabs', tabs: [] }
    host.browser.command = vi.fn(async () => response)
    const scoped = scopeAgentEnvironment(host, ['workspace:read', 'ui-test:read'])
    await expect(scoped.browser.command({ action: 'tabs' })).resolves.toBe(response)
    expect(host.browser.command).toHaveBeenCalledWith({ action: 'tabs' })
  })

  it('未授予 ui-test:write 时写通道抛 not_authorized 且不触达宿主', async () => {
    const host = createFakeAgentEnvironment()
    const scoped = scopeAgentEnvironment(host, ['workspace:read', 'ui-test:read'])
    await expect(scoped.browser.write({ action: 'click', tabId: 'tab-1', ref: 3 })).rejects.toMatchObject({
      code: 'not_authorized',
      name: 'AgentEnvironmentError',
    })
    expect(host.browser.write).not.toHaveBeenCalled()
  })

  it('两条通道路由互相独立：授予 ui-test:write 不隐含 ui-test:read', async () => {
    const host = createFakeAgentEnvironment()
    const scoped = scopeAgentEnvironment(host, ['workspace:read', 'ui-test:write'])
    await expect(scoped.browser.command({ action: 'tabs' })).rejects.toMatchObject({ code: 'not_authorized' })
    expect(host.browser.command).not.toHaveBeenCalled()
  })

  it('授予 ui-test:write 时原样透传写通道（含写动作与响应）', async () => {
    const host = createFakeAgentEnvironment()
    const response: BrowserCommandResponse = { type: 'done' }
    host.browser.write = vi.fn(async () => response)
    const scoped = scopeAgentEnvironment(host, ['workspace:read', 'ui-test:write'])
    const request = { action: 'press', tabId: 'tab-1', key: 'Enter' } as const
    await expect(scoped.browser.write(request)).resolves.toBe(response)
    expect(host.browser.write).toHaveBeenCalledWith(request)
  })

  it('未授予 api-test:request 时 API 通道抛 not_authorized 且不触达宿主', async () => {
    const host = createFakeAgentEnvironment()
    const scoped = scopeAgentEnvironment(host, ['workspace:read', 'ui-test:write'])
    await expect(scoped.api.runStep({
      runId: 'run-1',
      stepId: 'call-1',
      step: { id: 'call-1', action: 'api.request', method: 'GET', url: 'https://api.example.test/v1' },
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'not_authorized',
      name: 'AgentEnvironmentError',
    })
    expect(host.api.runStep).not.toHaveBeenCalled()
  })

  it('授予 api-test:request 时原样透传 API 通道（含环境 id 与信号）', async () => {
    const host = createFakeAgentEnvironment()
    const result = {
      verdict: 'passed' as const,
      runnerVerdict: 'passed' as const,
      transport: 'received' as const,
      message: 'HTTP 200 · 12 ms',
      evidenceContentHash: 'a'.repeat(64),
      statusCode: 200,
      elapsedMs: 12,
      extracted: {},
    }
    host.api.runStep = vi.fn(async () => result)
    const scoped = scopeAgentEnvironment(host, ['workspace:read', 'api-test:request'])
    const request = {
      runId: 'run-1',
      stepId: 'call-1',
      environmentId: 'staging',
      step: { id: 'call-1', action: 'api.request' as const, method: 'GET' as const, url: 'https://api.example.test/v1' },
    }
    const signal = new AbortController().signal
    await expect(scoped.api.runStep(request, signal)).resolves.toBe(result)
    expect(host.api.runStep).toHaveBeenCalledWith(request, signal)
  })
})
