/// <reference types="node" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AgentCapability } from '@/config/runtimePolicy'
import { BUILTIN_PROVIDER_DESCRIPTORS } from '@/agent/transport/builtinProviderDescriptors'
import { createDiscoverAgentToolsTool } from '@/agent/tools/discoverAgentToolsTool'
import { createToolRegistry } from '@/agent/tools/createToolRegistry'
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
