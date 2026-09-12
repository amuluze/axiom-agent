import { describe, expect, it, vi } from 'vitest'
import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'
import { reconcileSessionPromptOnActivation } from './sessionPromptReconcile'

interface StubHarness {
  isDisposed: boolean
  isRunning: boolean
  systemPrompt: string
  activeToolNames: readonly string[]
  updateRuntimeDependencies: MockedHarness['updateRuntimeDependencies']
}

type MockedHarness = {
  updateRuntimeDependencies: ReturnType<typeof vi.fn>
}

const manifest = { hooks: [] } as unknown as RuntimeDependencyManifest

const stubHarness = (overrides: Partial<StubHarness> = {}): AgentHarness => {
  const harness: StubHarness & MockedHarness = {
    isDisposed: false,
    isRunning: false,
    systemPrompt: '旧提示词',
    activeToolNames: ['discover_agent_tools', 'bash'],
    updateRuntimeDependencies: vi.fn(async () => undefined),
    ...overrides,
  }
  return harness as unknown as AgentHarness
}

describe('reconcileSessionPromptOnActivation', () => {
  it('no-ops when the candidate equals the live prompt (深比较门，checkpoint 不失效)', async () => {
    const harness = stubHarness({ systemPrompt: '一致提示词' })
    const applied = await reconcileSessionPromptOnActivation(harness, manifest, '一致提示词')
    expect(applied).toBe(false)
    expect(harness.updateRuntimeDependencies).not.toHaveBeenCalled()
  })

  it('replaces the prompt via runtime_dependencies_update when drifted and idle', async () => {
    const harness = stubHarness()
    const applied = await reconcileSessionPromptOnActivation(harness, manifest, '新提示词')
    expect(applied).toBe(true)
    expect(harness.updateRuntimeDependencies).toHaveBeenCalledTimes(1)
    const input = vi.mocked(harness.updateRuntimeDependencies).mock.calls[0][0] as {
      previous: { systemPrompt: string; activeToolNames: string[]; runtimeManifest: RuntimeDependencyManifest }
      current: { systemPrompt: string; activeToolNames: string[]; runtimeManifest: RuntimeDependencyManifest }
    }
    expect(input.previous.systemPrompt).toBe('旧提示词')
    expect(input.current.systemPrompt).toBe('新提示词')
    // manifest 原样传递：对账只换提示词，不改写依赖指纹（skills 冻结快照不受影响）。
    expect(input.previous.runtimeManifest).toBe(manifest)
    expect(input.current.runtimeManifest).toBe(manifest)
    expect(input.previous.activeToolNames).toEqual(['discover_agent_tools', 'bash'])
    expect(input.current.activeToolNames).toEqual(['discover_agent_tools', 'bash'])
  })

  it('skips a running harness (后台运行中被切回，由轮次回流在 turn_end 自愈)', async () => {
    const harness = stubHarness({ isRunning: true })
    const applied = await reconcileSessionPromptOnActivation(harness, manifest, '新提示词')
    expect(applied).toBe(false)
    expect(harness.updateRuntimeDependencies).not.toHaveBeenCalled()
  })

  it('skips a disposed harness', async () => {
    const harness = stubHarness({ isDisposed: true })
    const applied = await reconcileSessionPromptOnActivation(harness, manifest, '新提示词')
    expect(applied).toBe(false)
    expect(harness.updateRuntimeDependencies).not.toHaveBeenCalled()
  })

  it('propagates persistence failures to the caller (调用方 fail-soft)', async () => {
    const failure = new Error('持久化失败')
    const harness = stubHarness({ updateRuntimeDependencies: vi.fn(async () => {
      throw failure
    }) })
    await expect(reconcileSessionPromptOnActivation(harness, manifest, '新提示词')).rejects.toBe(failure)
  })
})
