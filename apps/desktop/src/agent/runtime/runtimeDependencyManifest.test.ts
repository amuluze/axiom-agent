/// <reference types="node" />
import type { AgentTool } from '@/agent/core/types'
import { readFileSync } from 'node:fs'
import { validateToolRegistry } from '@/agent/core/deferredTools'
import { defaultProviderProfile } from '@/agent/transport/provider'
import { describe, expect, it } from 'vitest'
import { TEST_ANTHROPIC_PROFILE } from '@/components/settings/sections/testFixtures'
import {
  assertRuntimeDependenciesCompatible,
  createRuntimeDependencyManifest as createManifest,
  decodeRuntimeDependencyManifest,
  runtimeDependencyManifestsEqual,
} from './runtimeDependencyManifest'
import { DESKTOP_RUNTIME_HOOK_REGISTRATION } from './productRuntimeHooks'

const desktopRuntimeHookDependencies = [{
  id: DESKTOP_RUNTIME_HOOK_REGISTRATION.id,
  version: DESKTOP_RUNTIME_HOOK_REGISTRATION.version,
  fingerprint: 'desktop-runtime-hooks-v9',
}]

const createRuntimeDependencyManifest = (
  provider: Parameters<typeof createManifest>[0],
  tools: Parameters<typeof createManifest>[1],
) => createManifest(provider, tools, desktopRuntimeHookDependencies, { schemaVersion: 1, skills: [] })

const tool = (
  name: string,
  runtimeVersion = '1',
  recoveryPolicy: AgentTool['recoveryPolicy'] = 'never',
): AgentTool => ({
  name,
  label: name,
  description: `${name} tool`,
  inputSchema: { type: 'object' },
  runtimeVersion,
  recoveryPolicy,
  ...(recoveryPolicy === 'idempotent'
    ? { idempotencyKey: () => `${name}:stable` }
    : {}),
  validate: (input) => ({ ok: true, value: input }),
  execute: async () => ({ content: 'done' }),
})

describe('Runtime dependency manifest', () => {
  it('decodes the shared runtime manifest v4 contract', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../../../contracts/runtime-dependency-manifest-v4.json', import.meta.url),
      'utf8',
    )) as unknown

    expect(decodeRuntimeDependencyManifest(fixture)).toMatchObject({
      schemaVersion: 4,
      provider: {
        providerId: 'generic-anthropic-compatible',
        apiFormat: 'anthropic-compatible',
      },
      hooks: [{ fingerprint: 'shared-contract-v4' }],
      skills: { schemaVersion: 1, skills: [] },
    })
  })

  it('rejects unknown fields from the shared invalid runtime manifest contract', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../../../contracts/runtime-dependency-manifest-v4.invalid-extra.json', import.meta.url),
      'utf8',
    )) as unknown

    expect(() => decodeRuntimeDependencyManifest(fixture)).toThrow('未知字段')
  })

  it('compares manifests canonically without depending on dependency array order', () => {
    const manifest = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('read'), tool('discover')],
    )
    const reordered = structuredClone(manifest)
    reordered.tools.reverse()

    expect(runtimeDependencyManifestsEqual(manifest, reordered)).toBe(true)
    reordered.hooks[0] = { ...reordered.hooks[0], fingerprint: 'changed' }
    expect(runtimeDependencyManifestsEqual(manifest, reordered)).toBe(false)
  })

  it('accepts an identical Provider, active tool contract, and Hook set', () => {
    const manifest = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover', '1', 'idempotent')],
    )

    expect(() => assertRuntimeDependenciesCompatible(
      manifest,
      structuredClone(manifest),
      ['discover'],
    )).not.toThrow()
  })

  it('rejects a missing active tool dependency', () => {
    const stored = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [],
    )

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover']))
      .toThrow('活动工具依赖缺失')
  })

  it.each([
    [tool('discover', '2'), '工具依赖不兼容'],
    [tool('discover', '1', 'idempotent'), '工具依赖不兼容'],
  ])('rejects an incompatible active tool version or recovery policy', (nextTool, message) => {
    const stored = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [nextTool],
    )

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover']))
      .toThrow(message)
  })

  // Mirrors the exact (name, version, recoveryPolicy) tuples persisted in real
  // user SQLite databases before the compatibility table caught up with the
  // version bumps. Every stored historical version must recover against the
  // live contract so existing sessions are not blocked on upgrade.
  it.each([
    ['discover_agent_tools', '2', 'idempotent', '4'],
    ['discover_agent_tools', '3', 'idempotent', '4'],
    ['read', '3', 'idempotent', '6'],
    ['read', '4', 'idempotent', '6'],
    ['read', '5', 'idempotent', '6'],
    ['ls', '2', 'idempotent', '4'],
    ['ls', '3', 'idempotent', '4'],
    ['grep', '3', 'idempotent', '5'],
    ['grep', '4', 'idempotent', '5'],
    ['find', '2', 'idempotent', '5'],
    ['find', '3', 'idempotent', '5'],
    ['find', '4', 'idempotent', '5'],
    ['write', '2', 'idempotent', '6'],
    ['write', '3', 'idempotent', '6'],
    ['write', '4', 'idempotent', '6'],
    ['write', '5', 'idempotent', '6'],
    ['edit', '3', 'idempotent', '7'],
    ['edit', '4', 'idempotent', '7'],
    ['edit', '5', 'idempotent', '7'],
    ['edit', '6', 'idempotent', '7'],
    ['apply_changes', '3', 'never', '5'],
    ['apply_changes', '4', 'never', '5'],
    ['restore_trash', '2', 'never', '3'],
    ['bash', '2', 'never', '15'],
    ['bash', '3', 'never', '15'],
    ['bash', '4', 'never', '15'],
    ['bash', '5', 'never', '15'],
    ['bash', '6', 'never', '15'],
    ['bash', '7', 'never', '15'],
    ['bash', '8', 'never', '15'],
    ['bash', '9', 'never', '15'],
    ['bash', '10', 'never', '15'],
    ['bash', '11', 'never', '15'],
    ['bash', '12', 'never', '15'],
    // bash 曾随未合入主干的 sudo 词边界扩展 bump 到 v13（已回滚）；两版 v13 的
    // schema 一致（command/cwd/timeout/network），存储的旧 v13 无需迁移即可恢复。
    ['bash', '13', 'never', '15'],
  ])('migrates stored %s@%s/%s to the live %s contract', (name, previousVersion, recoveryPolicy, liveVersion) => {
    const stored = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool(name, previousVersion, recoveryPolicy as AgentTool['recoveryPolicy'])],
    )
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool(name, liveVersion, recoveryPolicy as AgentTool['recoveryPolicy'])],
    )

    expect(() => assertRuntimeDependenciesCompatible(stored, current, [name])).not.toThrow()
  })

  it('rejects a migration whose declared currentVersion lags behind the live contract', () => {
    // Simulate a forgotten migration bump: the table still points an old
    // version forward to a stale currentVersion while the live tool has moved
    // past it. The restore check must fail loudly instead of silently accepting.
    const stored = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover_agent_tools', '2', 'idempotent')],
    )
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover_agent_tools', '5', 'idempotent')], // live moved past the table's declared '4'
    )

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover_agent_tools']))
      .toThrow('工具依赖不兼容')
  })

  it('rejects a different Provider kind or model', () => {
    const stored = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )
    const current = createRuntimeDependencyManifest(
      { ...defaultProviderProfile('generic-openai-compatible'), modelId: 'gpt-test' },
      [tool('discover')],
    )

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover']))
      .toThrow('Provider 依赖不匹配')
  })

  it('migrates a v1 manifest through an explicit compatibility path', () => {
    const stored = decodeRuntimeDependencyManifest({
      schemaVersion: 1,
      provider: { kind: 'anthropic-compatible', model: 'claude-test' },
      tools: [{ name: 'discover', version: '1', recoveryPolicy: 'never' }],
      hooks: [{ id: 'axiom.desktop.runtime-hooks', version: '1' }],
    })
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )

    expect(stored.migratedFromSchemaVersion).toBe(1)
    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover'])).not.toThrow()
  })

  it('accepts current Hook versions backfilled into a v1 manifest without fingerprints', () => {
    const stored = decodeRuntimeDependencyManifest({
      schemaVersion: 1,
      provider: { kind: 'anthropic-compatible', model: 'claude-test' },
      tools: [{ name: 'discover', version: '1', recoveryPolicy: 'never' }],
      hooks: [{ id: 'axiom.desktop.runtime-hooks', version: DESKTOP_RUNTIME_HOOK_REGISTRATION.version, fingerprint: 'ignored' }],
    })
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )

    expect(stored.hooks[0]?.fingerprint).toBe('legacy-v1')
    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover'])).not.toThrow()
  })

  it('migrates a v2 manifest without inventing a persisted Hook fingerprint', () => {
    const stored = decodeRuntimeDependencyManifest({
      schemaVersion: 2,
      provider: {
        providerId: 'generic-anthropic-compatible',
        apiFormat: 'anthropic-compatible',
        modelId: 'claude-test',
        transportVersion: '2',
      },
      tools: [{ name: 'discover', version: '1', recoveryPolicy: 'never' }],
      hooks: [{ id: 'axiom.desktop.runtime-hooks', version: '4' }],
    })
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )

    expect(stored.migratedFromSchemaVersion).toBe(2)
    expect(stored.hooks[0]?.fingerprint).toBe('legacy-v2')
    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover'])).not.toThrow()
  })

  it('migrates a stored older provider transport version to the live contract', () => {
    const stored = decodeRuntimeDependencyManifest({
      schemaVersion: 2,
      provider: {
        providerId: 'generic-anthropic-compatible',
        apiFormat: 'anthropic-compatible',
        modelId: 'claude-test',
        transportVersion: '1',
      },
      tools: [{ name: 'discover', version: '1', recoveryPolicy: 'never' }],
      hooks: [{ id: 'axiom.desktop.runtime-hooks', version: '4' }],
    })
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover'])).not.toThrow()
  })

  it('restores sessions persisted during the rolled-back v7 transport window', () => {
    // 一等公民 provider 曾随未合入主干的改动 bump 到 v7；回滚后 live 为 v6。
    // 旧会话必须能经单跳迁移恢复，否则桌面能力初始化被 Provider 依赖不匹配阻塞。
    const stored = decodeRuntimeDependencyManifest({
      schemaVersion: 3,
      provider: {
        providerId: 'minimax-chat',
        apiFormat: 'openai-compatible',
        modelId: 'MiniMax-M3',
        transportVersion: '7',
      },
      tools: [{ name: 'discover', version: '1', recoveryPolicy: 'never' }],
      hooks: desktopRuntimeHookDependencies,
    })
    const current = createRuntimeDependencyManifest(
      { ...defaultProviderProfile('minimax-chat'), modelId: 'MiniMax-M3' },
      [tool('discover')],
    )

    expect(current.provider.transportVersion).toBe('6')
    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover'])).not.toThrow()
  })

  it('rejects a provider transport version with no migration path', () => {
    const stored = decodeRuntimeDependencyManifest({
      schemaVersion: 2,
      provider: {
        providerId: 'generic-anthropic-compatible',
        apiFormat: 'anthropic-compatible',
        modelId: 'claude-test',
        transportVersion: '9',
      },
      tools: [{ name: 'discover', version: '1', recoveryPolicy: 'never' }],
      hooks: [{ id: 'axiom.desktop.runtime-hooks', version: '4' }],
    })
    const current = createRuntimeDependencyManifest(
      TEST_ANTHROPIC_PROFILE,
      [tool('discover')],
    )

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover']))
      .toThrow('Provider 依赖不匹配')
  })

  it('migrates registered Hook contracts and rejects unknown Hook drift', () => {
    const current = createRuntimeDependencyManifest(TEST_ANTHROPIC_PROFILE, [tool('discover')])
    const previous = structuredClone(current)
    for (const version of ['2', '3', '4', '5', '6', '7', '8']) {
      previous.hooks = [{ id: 'axiom.desktop.runtime-hooks', version, fingerprint: 'legacy' }]
      expect(() => assertRuntimeDependenciesCompatible(previous, current, ['discover'])).not.toThrow()
    }

    const harnessCurrent = structuredClone(current)
    harnessCurrent.hooks = [{
      id: 'axiom.runtime.harness-options-hooks',
      version: '7',
      fingerprint: 'current',
    }]
    for (const version of ['1', '2', '3', '4', '5', '6']) {
      const harnessPrevious = structuredClone(current)
      harnessPrevious.hooks = [{
        id: 'axiom.runtime.harness-options-hooks',
        version,
        fingerprint: 'legacy',
      }]
      expect(() => assertRuntimeDependenciesCompatible(
        harnessPrevious,
        harnessCurrent,
        ['discover'],
      )).not.toThrow()
    }

    previous.hooks = [{ id: 'unknown.runtime-hooks', version: '1', fingerprint: 'unknown' }]
    expect(() => assertRuntimeDependenciesCompatible(previous, current, ['discover']))
      .toThrow('Hook 依赖不兼容')
  })

  it('rejects a Hook newly required by the current Registry', () => {
    const stored = createRuntimeDependencyManifest(TEST_ANTHROPIC_PROFILE, [tool('discover')])
    const current = structuredClone(stored)
    current.hooks.push({ id: 'axiom.desktop.required-hook', version: '1', fingerprint: 'required' })

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover']))
      .toThrow('缺少当前 Hook 依赖')
  })

  it('rejects Hook policy drift without a version change', () => {
    const stored = createRuntimeDependencyManifest(TEST_ANTHROPIC_PROFILE, [tool('discover')])
    const current = structuredClone(stored)
    current.hooks[0] = { ...current.hooks[0], fingerprint: 'drifted-policy' }

    expect(() => assertRuntimeDependenciesCompatible(stored, current, ['discover']))
      .toThrow('Hook 依赖不兼容')
  })

  it('rejects an idempotent tool without an idempotency key contract', () => {
    expect(() => validateToolRegistry([{
      ...tool('discover'),
      recoveryPolicy: 'idempotent',
    }])).toThrow('必须提供 idempotencyKey')
  })

  it('rejects a tool without an explicit Runtime version', () => {
    expect(() => validateToolRegistry([{
      ...tool('discover'),
      runtimeVersion: '',
    }])).toThrow('Runtime version 不能为空')
  })
})
