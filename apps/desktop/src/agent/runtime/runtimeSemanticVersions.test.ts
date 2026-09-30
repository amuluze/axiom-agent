/// <reference types="node" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AgentCapability } from '@/config/runtimePolicy'
import { BUILTIN_PROVIDER_DESCRIPTORS } from '@/agent/transport/builtinProviderDescriptors'
import { createDiscoverAgentToolsTool } from '@/agent/tools/discoverAgentToolsTool'
import { createToolRegistry } from '@/agent/tools/createToolRegistry'
import { RUNTIME_TOOL_COMPATIBILITY_MIGRATIONS } from '@/agent/tools/toolNameMigrations'
import { describe, expect, it } from 'vitest'
import { HARNESS_OPTIONS_HOOK_REGISTRATION } from './AgentHarness'
import { DESKTOP_RUNTIME_HOOK_REGISTRATION } from './productRuntimeHooks'

interface RuntimeSemanticComponent {
  id: string
  version: string
  sourceFiles: string[]
  semanticDigest: string
}

interface RuntimeSemanticContract {
  schemaVersion: 1
  components: RuntimeSemanticComponent[]
}

const contract = JSON.parse(readFileSync(
  new URL('../../../contracts/runtime-semantic-versions.json', import.meta.url),
  'utf8',
)) as RuntimeSemanticContract

const allCapabilities: AgentCapability[] = [
  'filesystem:read',
  'workspace:read',
  'workspace:write',
  'workspace:execute',
  'subagent:explore',
  'subagent:review',
  'web:read',
  'web:browser',
  'computer:control',
  'ssh:remote',
]

const productTools = createToolRegistry({ capabilities: allCapabilities })
const tools = [createDiscoverAgentToolsTool(productTools), ...productTools]
const currentVersions = new Map<string, string>([
  [`hook:${DESKTOP_RUNTIME_HOOK_REGISTRATION.id}`, DESKTOP_RUNTIME_HOOK_REGISTRATION.version],
  [`hook:${HARNESS_OPTIONS_HOOK_REGISTRATION.id}`, HARNESS_OPTIONS_HOOK_REGISTRATION.version],
  ...BUILTIN_PROVIDER_DESCRIPTORS.map((provider) => [
    `provider:${provider.providerId}`,
    provider.transportVersion,
  ] as const),
  ...tools.map((tool) => [`tool:${tool.name}`, tool.runtimeVersion] as const),
])

const semanticSourceDigest = (sourceFiles: string[]): string => {
  const digest = createHash('sha256')
  for (const sourceFile of sourceFiles.slice().sort()) {
    digest.update(sourceFile)
    digest.update('\0')
    digest.update(readFileSync(
      new URL(`../../../${sourceFile}`, import.meta.url),
      'utf8',
    ).replace(/\r\n/gu, '\n'))
    digest.update('\0')
  }
  return digest.digest('hex')
}

describe('Runtime semantic version audit', () => {
  it('covers every Hook bundle, Provider transport, and Tool contract exactly once', () => {
    expect(contract.schemaVersion).toBe(1)
    expect(new Set(contract.components.map((component) => component.id)).size)
      .toBe(contract.components.length)
    expect(contract.components.map((component) => component.id).sort())
      .toEqual([...currentVersions.keys()].sort())
  })

  it.each(contract.components)('$id keeps source semantics bound to its explicit version', (component) => {
    expect(currentVersions.get(component.id)).toBe(component.version)
    expect(component.sourceFiles.length).toBeGreaterThan(0)
    expect(
      semanticSourceDigest(component.sourceFiles),
      `${component.id} 源码已变化；请提升显式 semantic version 并更新审计契约`,
    ).toBe(component.semanticDigest)
  })
})

// 回归：design_query 从 v7 bump 到 v9 时迁移表未同步（表项仍指 v7 且缺 v7/v8），
// 导致任何持久化过该工具的旧会话在恢复时被 assertRuntimeDependenciesCompatible
// 拒绝（currentVersion !== live 时 toolMigration 返回 null）。该表无自带测试，
// 故在此补一条「表项目标版本必须等于 live」的全表审计。
describe('工具兼容迁移表与 live 版本一致性', () => {
  // 只守「表项目标版本 = live」这一条：它直接对应恢复路径的判定
  //（currentVersion !== live 时 toolMigration 返回 null → 恢复被拒）。
  // 不断言历史版本覆盖率——部分版本从未进入恢复路径（如早期
  // explore_subagent），缺条目是既有有意决策而非缺陷。
  it('每条表项的 currentName/currentVersion 都等于该工具的 live 版本', () => {
    const stale = RUNTIME_TOOL_COMPATIBILITY_MIGRATIONS.flatMap((migration) => {
      const live = currentVersions.get(`tool:${migration.currentName}`)
      if (live !== undefined && migration.currentVersion === live) return []
      return [`${migration.previousName}@${migration.previousVersion} → `
        + `${migration.currentName}@${migration.currentVersion}（live ${live ?? '未注册'}）`]
    })
    expect(stale).toEqual([])
  })
})
