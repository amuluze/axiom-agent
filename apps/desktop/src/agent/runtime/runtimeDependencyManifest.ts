import type { AgentTool, ProviderApiFormat, ToolRecoveryPolicy } from '@/agent/core/types'

import { BUILTIN_PROVIDER_RUNTIME, type ProviderProfile } from '@/agent/transport/provider'
import { RUNTIME_TOOL_COMPATIBILITY_MIGRATIONS } from '@/agent/tools/toolNameMigrations'
import type { RuntimeHookBundleDependency } from './RuntimeHookRegistry'
import type { ProjectSkillInventorySnapshot } from '@/agent/skills/types'
import { EMPTY_PROJECT_SKILL_INVENTORY } from '@/agent/skills/types'

export const RUNTIME_DEPENDENCY_SCHEMA_VERSION = 4

export interface RuntimeToolDependency {
  name: string
  version: string
  recoveryPolicy: ToolRecoveryPolicy
}

export type RuntimeHookDependency = RuntimeHookBundleDependency

export interface RuntimeDependencyManifest {
  schemaVersion: typeof RUNTIME_DEPENDENCY_SCHEMA_VERSION
  migratedFromSchemaVersion?: 1 | 2 | 3
  provider: {
    providerId: string
    apiFormat: ProviderApiFormat
    modelId: string
    transportVersion: string
  }
  tools: RuntimeToolDependency[]
  hooks: RuntimeHookDependency[]
  skills: ProjectSkillInventorySnapshot
}

interface RuntimeHookCompatibilityMigration {
  id: string
  fromVersion: string
  toVersion: string
  migratedFromSchemaVersion?: 1 | 2 | 3
}

/**
 * Provider transport 版本的向前兼容迁移表（语义同 RUNTIME_TOOL_COMPATIBILITY_MIGRATIONS）。
 * 每次 bump 某个 provider 的 `transportVersion` 时，必须为旧版本补一条
 * `previousVersion -> currentVersion` 条目；否则旧会话恢复会被拒绝。
 * `currentVersion` 必须等于 live transportVersion（校验在兼容检查中隐式完成）。
 */
export interface ProviderTransportCompatibilityMigration {
  providerId: string
  previousVersion: string
  currentVersion: string
}

export const PROVIDER_TRANSPORT_MIGRATIONS: readonly ProviderTransportCompatibilityMigration[] = [
  // v10：三个 transport 的流截断守卫（OpenAI-compatible 缺 [DONE]/finish_reason、
  // Anthropic 缺 message_stop、Responses 缺终态事件）从 unknown 不可重试改判为
  // network 可重试，交由 AgentSession 自动重试接管；wire 协议与持久化格式不变。
  // 刻意跳过已烧掉的 v7/v8/v9（历史窗口版本号），保持「同版本号 ⇒ 同语义」；
  // 单跳解析要求 previousVersion 直连 live currentVersion，历史条目全部指向 v10。
  //
  // v6：Provider Profile 文档/secretId 解析完全下沉 Rust（provider_profiles 权威），
  // transport 的 httpStream 默认经宿主注入；wire 协议仍为 providerId + endpoint。
  //
  // v7（openai v8/v9）：SSE 合帧与工具参数漂移修复曾随未合入主干的改动 bump 到
  // v7/v8/v9，该窗口内持久化的会话带这些版本；主干曾回滚到 v6，v10 起这些版本
  // 经显式迁移直连新 live。所有一等公民 provider 同样曾在 v7 短暂停留，逐一补 7→10。
  { providerId: 'demo', previousVersion: '1', currentVersion: '3' },
  { providerId: 'demo', previousVersion: '2', currentVersion: '3' },
  { providerId: 'generic-anthropic-compatible', previousVersion: '1', currentVersion: '10' },
  { providerId: 'generic-anthropic-compatible', previousVersion: '2', currentVersion: '10' },
  { providerId: 'generic-anthropic-compatible', previousVersion: '3', currentVersion: '10' },
  { providerId: 'generic-anthropic-compatible', previousVersion: '4', currentVersion: '10' },
  { providerId: 'generic-anthropic-compatible', previousVersion: '5', currentVersion: '10' },
  { providerId: 'generic-anthropic-compatible', previousVersion: '6', currentVersion: '10' },
  { providerId: 'generic-anthropic-compatible', previousVersion: '7', currentVersion: '10' },
  { providerId: 'generic-openai-compatible', previousVersion: '1', currentVersion: '10' },
  { providerId: 'generic-openai-compatible', previousVersion: '2', currentVersion: '10' },
  { providerId: 'generic-openai-compatible', previousVersion: '3', currentVersion: '10' },
  { providerId: 'generic-openai-compatible', previousVersion: '4', currentVersion: '10' },
  { providerId: 'generic-openai-compatible', previousVersion: '5', currentVersion: '10' },
  { providerId: 'generic-openai-compatible', previousVersion: '6', currentVersion: '10' },
  { providerId: 'generic-openai-compatible', previousVersion: '7', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '1', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '2', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '3', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '4', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '5', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '6', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '7', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '8', currentVersion: '10' },
  { providerId: 'openai', previousVersion: '9', currentVersion: '10' },
  // custom-* 与 orcarouter 自引入起即 v6，当前发布存量的会话都带 v6。
  { providerId: 'custom-openai-compatible', previousVersion: '6', currentVersion: '10' },
  { providerId: 'custom-anthropic-compatible', previousVersion: '6', currentVersion: '10' },
  { providerId: 'orcarouter', previousVersion: '6', currentVersion: '10' },
  // 一等公民 provider 在 v7 窗口内曾 bump 到 7，现与当前发布存量 v6 一并直连 v10。
  { providerId: 'zhipu-glm', previousVersion: '6', currentVersion: '10' },
  { providerId: 'zhipu-glm', previousVersion: '7', currentVersion: '10' },
  { providerId: 'deepseek', previousVersion: '6', currentVersion: '10' },
  { providerId: 'deepseek', previousVersion: '7', currentVersion: '10' },
  { providerId: 'minimax-chat', previousVersion: '6', currentVersion: '10' },
  { providerId: 'minimax-chat', previousVersion: '7', currentVersion: '10' },
  { providerId: 'ollama', previousVersion: '6', currentVersion: '10' },
  { providerId: 'ollama', previousVersion: '7', currentVersion: '10' },
  { providerId: 'gemini', previousVersion: '6', currentVersion: '10' },
  { providerId: 'gemini', previousVersion: '7', currentVersion: '10' },
  { providerId: 'kimi', previousVersion: '6', currentVersion: '10' },
  { providerId: 'kimi', previousVersion: '7', currentVersion: '10' },
  { providerId: 'kimi-coding', previousVersion: '6', currentVersion: '10' },
  { providerId: 'kimi-coding', previousVersion: '7', currentVersion: '10' },
  { providerId: 'opencode-go', previousVersion: '1', currentVersion: '2' },
]

const RUNTIME_HOOK_COMPATIBILITY_MIGRATIONS: readonly RuntimeHookCompatibilityMigration[] = [
  {
    id: 'axiom.desktop.runtime-hooks',
    fromVersion: '1',
    toVersion: '9',
    migratedFromSchemaVersion: 1,
  },
  { id: 'axiom.desktop.runtime-hooks', fromVersion: '2', toVersion: '9' },
  { id: 'axiom.desktop.runtime-hooks', fromVersion: '3', toVersion: '9' },
  { id: 'axiom.desktop.runtime-hooks', fromVersion: '4', toVersion: '9' },
  { id: 'axiom.desktop.runtime-hooks', fromVersion: '5', toVersion: '9' },
  { id: 'axiom.desktop.runtime-hooks', fromVersion: '6', toVersion: '9' },
  { id: 'axiom.desktop.runtime-hooks', fromVersion: '7', toVersion: '9' },
  {
    id: 'axiom.desktop.runtime-hooks',
    fromVersion: '7',
    toVersion: '9',
    migratedFromSchemaVersion: 1,
  },
  { id: 'axiom.desktop.runtime-hooks', fromVersion: '8', toVersion: '9' },
  {
    id: 'axiom.desktop.runtime-hooks',
    fromVersion: '8',
    toVersion: '9',
    migratedFromSchemaVersion: 1,
  },
  { id: 'axiom.runtime.harness-options-hooks', fromVersion: '1', toVersion: '7' },
  { id: 'axiom.runtime.harness-options-hooks', fromVersion: '2', toVersion: '7' },
  { id: 'axiom.runtime.harness-options-hooks', fromVersion: '3', toVersion: '7' },
  { id: 'axiom.runtime.harness-options-hooks', fromVersion: '4', toVersion: '7' },
  { id: 'axiom.runtime.harness-options-hooks', fromVersion: '5', toVersion: '7' },
  { id: 'axiom.runtime.harness-options-hooks', fromVersion: '6', toVersion: '7' },
  {
    id: 'axiom.runtime.harness-options-hooks',
    fromVersion: '6',
    toVersion: '7',
    migratedFromSchemaVersion: 1,
  },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertExactFields = (value: Record<string, unknown>, allowed: string[], label: string): void => {
  const unexpected = Object.keys(value).filter((field) => !allowed.includes(field))
  if (unexpected.length > 0) {
    throw new Error(`${label} 包含未知字段：${unexpected.join(', ')}`)
  }
}

const isProviderApiFormat = (value: unknown): value is ProviderApiFormat => [
  'demo',
  'openai-compatible',
  'openai-responses',
  'anthropic-compatible',
].includes(String(value))

const uniqueBy = <T>(values: T[], key: (value: T) => string, label: string): T[] => {
  const keys = values.map(key)
  if (new Set(keys).size !== keys.length) throw new Error(`Runtime manifest 包含重复${label}`)
  return values
}

export const createRuntimeDependencyManifest = (
  provider: ProviderProfile,
  tools: AgentTool[],
  hooks: readonly RuntimeHookDependency[],
  skills: ProjectSkillInventorySnapshot,
): RuntimeDependencyManifest => ({
  schemaVersion: RUNTIME_DEPENDENCY_SCHEMA_VERSION,
  provider: {
    providerId: provider.providerId,
    apiFormat: provider.apiFormat,
    modelId: provider.modelId,
    transportVersion: BUILTIN_PROVIDER_RUNTIME.getProvider(provider.providerId).transportVersion,
  },
  tools: uniqueBy(tools.map((tool) => ({
    name: tool.name,
    version: tool.runtimeVersion.trim(),
    recoveryPolicy: tool.recoveryPolicy ?? 'never',
  })), (tool) => tool.name, '工具'),
  hooks: uniqueBy(hooks.map((hook) => ({ ...hook })), (hook) => hook.id, ' Hook'),
  skills,
})

const decodeTools = (value: unknown[]): RuntimeToolDependency[] => value.map((candidate) => {
  if (!isRecord(candidate)
    || typeof candidate.name !== 'string' || !candidate.name
    || typeof candidate.version !== 'string' || !candidate.version
    || (candidate.recoveryPolicy !== 'never' && candidate.recoveryPolicy !== 'idempotent')) {
    throw new Error('SQLite Runtime dependency manifest 包含无效工具')
  }
  assertExactFields(candidate, ['name', 'version', 'recoveryPolicy'], 'Runtime manifest 工具')
  return {
    name: candidate.name,
    version: candidate.version,
    recoveryPolicy: candidate.recoveryPolicy,
  }
})

const decodeHooks = (
  value: unknown[],
  fallbackFingerprint?: string,
): RuntimeHookDependency[] => value.map((candidate) => {
  if (!isRecord(candidate)
    || typeof candidate.id !== 'string' || !candidate.id
    || typeof candidate.version !== 'string' || !candidate.version
    || (fallbackFingerprint === undefined
      && (typeof candidate.fingerprint !== 'string'
        || !candidate.fingerprint
        || candidate.fingerprint.length > 1_024))) {
    throw new Error('SQLite Runtime dependency manifest 包含无效 Hook')
  }
  assertExactFields(candidate, ['id', 'version', 'fingerprint'], 'Runtime manifest Hook')
  return {
    id: candidate.id,
    version: candidate.version,
    fingerprint: fallbackFingerprint ?? String(candidate.fingerprint),
  }
})

const PROJECT_SKILL_SOURCE_FIELDS = ['kind', 'root']
const PROJECT_SKILL_FIELDS = [
  'name',
  'description',
  'source',
  'relativePath',
  'baseRelativePath',
  'contentSha256',
  'disableModelInvocation',
]

/**
 * 解码 project Skill snapshot（manifest v4 新增）。与 Rust 侧责任一致：
 * - 校验字段 exact-fields、类型、64 位小写 hex contentSha256、name 唯一、
 *   skills 已按 ASCII name 规范顺序排列（无序直接拒绝，不在解码时重排）；
 * - 不读取工作区文件、不重算 digest（那是 agent 层 loader/load_skill 的职责）。
 */
const decodeSkills = (value: unknown): ProjectSkillInventorySnapshot => {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.skills)) {
    throw new Error('SQLite Runtime dependency manifest 包含无效 Skills snapshot')
  }
  assertExactFields(value, ['schemaVersion', 'skills'], 'Runtime manifest Skills')
  const skills = value.skills.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.name !== 'string' || !candidate.name
      || typeof candidate.description !== 'string'
      || !isRecord(candidate.source)
      || typeof candidate.relativePath !== 'string' || !candidate.relativePath
      || typeof candidate.baseRelativePath !== 'string'
      || typeof candidate.contentSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(candidate.contentSha256)
      || typeof candidate.disableModelInvocation !== 'boolean') {
      throw new Error('SQLite Runtime dependency manifest 包含无效 Skill')
    }
    assertExactFields(candidate, PROJECT_SKILL_FIELDS, 'Runtime manifest Skill')
    assertExactFields(candidate.source, PROJECT_SKILL_SOURCE_FIELDS, 'Runtime manifest Skill source')
    if (candidate.source.kind !== 'project' || candidate.source.root !== '.axiom/skills') {
      throw new Error('SQLite Runtime dependency manifest Skill source 非法')
    }
    return {
      name: candidate.name,
      description: candidate.description,
      source: { kind: 'project' as const, root: '.axiom/skills' as const },
      relativePath: candidate.relativePath,
      baseRelativePath: candidate.baseRelativePath,
      contentSha256: candidate.contentSha256,
      disableModelInvocation: candidate.disableModelInvocation,
    }
  })
  uniqueBy(skills, (skill) => skill.name, '技能')
  for (let index = 1; index < skills.length; index++) {
    if (skills[index - 1]!.name.localeCompare(skills[index]!.name, 'en') > 0) {
      throw new Error('Runtime manifest Skill 未按 ASCII name 规范顺序排列')
    }
  }
  return { schemaVersion: 1, skills }
}

const legacyProviderId = (kind: string): string => {
  if (kind === 'demo') return 'demo'
  if (kind === 'openai-compatible') return 'generic-openai-compatible'
  if (kind === 'openai-responses') return 'openai'
  if (kind === 'anthropic-compatible') return 'generic-anthropic-compatible'
  return `legacy.${kind}`
}

export const decodeRuntimeDependencyManifest = (value: unknown): RuntimeDependencyManifest => {
  if (!isRecord(value)
    || !isRecord(value.provider)
    || !Array.isArray(value.tools)
    || !Array.isArray(value.hooks)) {
    throw new Error('SQLite 中存在格式无效的 Runtime dependency manifest')
  }
  assertExactFields(value, ['schemaVersion', 'provider', 'tools', 'hooks', 'skills'], 'Runtime manifest')
  const tools = decodeTools(value.tools)
  const hooks = decodeHooks(
    value.hooks,
    value.schemaVersion === 1
      ? 'legacy-v1'
      : value.schemaVersion === 2 ? 'legacy-v2' : undefined,
  )
  uniqueBy(tools, (tool) => tool.name, '工具')
  uniqueBy(hooks, (hook) => hook.id, ' Hook')

  if (value.schemaVersion === 1) {
    assertExactFields(value.provider, ['kind', 'model'], 'Runtime manifest v1 Provider')
    if (typeof value.provider.kind !== 'string' || !value.provider.kind
      || typeof value.provider.model !== 'string' || !value.provider.model
      || !isProviderApiFormat(value.provider.kind)) {
      throw new Error('SQLite 中存在格式无效的 Runtime dependency manifest v1')
    }
    return {
      schemaVersion: RUNTIME_DEPENDENCY_SCHEMA_VERSION,
      migratedFromSchemaVersion: 1,
      provider: {
        providerId: legacyProviderId(value.provider.kind),
        apiFormat: value.provider.kind,
        modelId: value.provider.model,
        transportVersion: 'legacy-v1',
      },
      tools,
      hooks,
      skills: EMPTY_PROJECT_SKILL_INVENTORY,
    }
  }

  if (value.schemaVersion === 2) {
    assertExactFields(
      value.provider,
      ['providerId', 'apiFormat', 'modelId', 'transportVersion'],
      'Runtime manifest v2 Provider',
    )
    if (typeof value.provider.providerId !== 'string' || !value.provider.providerId
      || !isProviderApiFormat(value.provider.apiFormat)
      || typeof value.provider.modelId !== 'string' || !value.provider.modelId
      || typeof value.provider.transportVersion !== 'string' || !value.provider.transportVersion) {
      throw new Error('SQLite 中存在格式无效的 Runtime dependency manifest v2')
    }
    return {
      schemaVersion: RUNTIME_DEPENDENCY_SCHEMA_VERSION,
      migratedFromSchemaVersion: 2,
      provider: {
        providerId: value.provider.providerId,
        apiFormat: value.provider.apiFormat,
        modelId: value.provider.modelId,
        transportVersion: value.provider.transportVersion,
      },
      tools,
      hooks,
      skills: EMPTY_PROJECT_SKILL_INVENTORY,
    }
  }

  if (value.schemaVersion === 3) {
    assertExactFields(
      value.provider,
      ['providerId', 'apiFormat', 'modelId', 'transportVersion'],
      'Runtime manifest v3 Provider',
    )
    if (typeof value.provider.providerId !== 'string' || !value.provider.providerId
      || !isProviderApiFormat(value.provider.apiFormat)
      || typeof value.provider.modelId !== 'string' || !value.provider.modelId
      || typeof value.provider.transportVersion !== 'string' || !value.provider.transportVersion) {
      throw new Error('SQLite 中存在格式无效的 Runtime dependency manifest v3')
    }
    return {
      schemaVersion: RUNTIME_DEPENDENCY_SCHEMA_VERSION,
      migratedFromSchemaVersion: 3,
      provider: {
        providerId: value.provider.providerId,
        apiFormat: value.provider.apiFormat,
        modelId: value.provider.modelId,
        transportVersion: value.provider.transportVersion,
      },
      tools,
      hooks,
      skills: EMPTY_PROJECT_SKILL_INVENTORY,
    }
  }

  if (value.schemaVersion !== RUNTIME_DEPENDENCY_SCHEMA_VERSION
    || typeof value.provider.providerId !== 'string' || !value.provider.providerId
    || !isProviderApiFormat(value.provider.apiFormat)
    || typeof value.provider.modelId !== 'string' || !value.provider.modelId
    || typeof value.provider.transportVersion !== 'string' || !value.provider.transportVersion) {
    throw new Error('SQLite 中存在格式无效的 Runtime dependency manifest v4')
  }
  assertExactFields(
    value.provider,
    ['providerId', 'apiFormat', 'modelId', 'transportVersion'],
    'Runtime manifest v4 Provider',
  )
  return {
    schemaVersion: RUNTIME_DEPENDENCY_SCHEMA_VERSION,
    provider: {
      providerId: value.provider.providerId,
      apiFormat: value.provider.apiFormat,
      modelId: value.provider.modelId,
      transportVersion: value.provider.transportVersion,
    },
    tools,
    hooks,
    skills: decodeSkills(value.skills),
  }
}

const canonicalRuntimeDependencyManifest = (
  manifest: RuntimeDependencyManifest | null,
): RuntimeDependencyManifest | null => manifest
  ? {
      schemaVersion: RUNTIME_DEPENDENCY_SCHEMA_VERSION,
      ...(manifest.migratedFromSchemaVersion
        ? { migratedFromSchemaVersion: manifest.migratedFromSchemaVersion }
        : {}),
      provider: { ...manifest.provider },
      tools: manifest.tools
        .map((tool) => ({ ...tool }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      hooks: manifest.hooks
        .map((hook) => ({ ...hook }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      skills: {
        schemaVersion: 1,
        skills: manifest.skills.skills.map((skill) => ({ ...skill, source: { ...skill.source } }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      },
    }
  : null

export const runtimeDependencyManifestsEqual = (
  left: RuntimeDependencyManifest | null,
  right: RuntimeDependencyManifest | null,
): boolean => JSON.stringify(canonicalRuntimeDependencyManifest(left))
  === JSON.stringify(canonicalRuntimeDependencyManifest(right))

const dependencyMap = <T>(values: T[], key: (value: T) => string): Map<string, T> =>
  new Map(values.map((value) => [key(value), value]))

export const assertRuntimeDependenciesCompatible = (
  stored: RuntimeDependencyManifest | null,
  current: RuntimeDependencyManifest,
  activeToolNames: string[],
): void => {
  if (!stored) throw new Error('当前 Session 缺少 Runtime dependency manifest')
  const providerIdentityMatches = stored.provider.providerId === current.provider.providerId
    && stored.provider.apiFormat === current.provider.apiFormat
    && stored.provider.modelId === current.provider.modelId
  // transportVersion 允许严格相等，或经迁移表向前解析到当前版本
  // （currentVersion 必须等于 current manifest 的 transportVersion，即 live 值）。
  const providerTransportCompatible = stored.provider.transportVersion === current.provider.transportVersion
    || PROVIDER_TRANSPORT_MIGRATIONS.some((migration) => (
      migration.providerId === stored.provider.providerId
      && migration.previousVersion === stored.provider.transportVersion
      && migration.currentVersion === current.provider.transportVersion
    ))
  const providerCompatible = stored.migratedFromSchemaVersion === 1
    ? providerIdentityMatches // v1 manifest 为 legacy，无 transportVersion 可比较
    : providerIdentityMatches && providerTransportCompatible
  if (!providerCompatible) {
    throw new Error(
      `Session Provider 依赖不匹配：${stored.provider.providerId}/${stored.provider.apiFormat}/${stored.provider.modelId}@${stored.provider.transportVersion} -> ${current.provider.providerId}/${current.provider.apiFormat}/${current.provider.modelId}@${current.provider.transportVersion}`,
    )
  }
  const storedTools = dependencyMap(stored.tools, (tool) => tool.name)
  const currentTools = dependencyMap(current.tools, (tool) => tool.name)
  const toolMigration = (previousName: string, previousVersion: string): { name: string; version: string; recoveryPolicy: ToolRecoveryPolicy } | null => {
    const compat = RUNTIME_TOOL_COMPATIBILITY_MIGRATIONS.find((migration) =>
      migration.previousName === previousName
      && migration.previousVersion === previousVersion,
    )
    if (!compat) return null
    const current = currentTools.get(compat.currentName)
    // `currentVersion` is the migration's declared target. It MUST match the
    // live contract version — a mismatch means the table fell behind a version
    // bump, so we refuse rather than silently accept a stale forward path.
    if (!current || current.version !== compat.currentVersion) return null
    return { name: compat.currentName, version: current.version, recoveryPolicy: current.recoveryPolicy }
  }
  for (const name of activeToolNames) {
    const previous = storedTools.get(name)
    const next = currentTools.get(name)
    if (!previous || !next) throw new Error(`Session 活动工具依赖缺失：${name}`)
    if (previous.version !== next.version || previous.recoveryPolicy !== next.recoveryPolicy) {
      const migrated = toolMigration(previous.name, previous.version)
      const nextFromMigrated = migrated ? currentTools.get(migrated.name) : undefined
      if (!(migrated && nextFromMigrated && nextFromMigrated.name === next.name && nextFromMigrated.version === next.version && nextFromMigrated.recoveryPolicy === next.recoveryPolicy)) {
        throw new Error(
          `Session 工具依赖不兼容：${name}@${previous.version}/${previous.recoveryPolicy} -> ${next.version}/${next.recoveryPolicy}`,
        )
      }
    }
  }
  const currentHooks = dependencyMap(current.hooks, (hook) => hook.id)
  const storedHooks = dependencyMap(stored.hooks, (hook) => hook.id)
  const compatibleHook = (previous: RuntimeHookDependency, next: RuntimeHookDependency): boolean => {
    if (next.version === previous.version && (
      next.fingerprint === previous.fingerprint
      || (stored.migratedFromSchemaVersion === 1 && previous.fingerprint === 'legacy-v1')
      || (stored.migratedFromSchemaVersion === 2 && previous.fingerprint === 'legacy-v2')
    )) return true
    return RUNTIME_HOOK_COMPATIBILITY_MIGRATIONS.some((migration) => (
      migration.id === previous.id
      && migration.id === next.id
      && migration.fromVersion === previous.version
      && migration.toVersion === next.version
      && (migration.migratedFromSchemaVersion === undefined
        || migration.migratedFromSchemaVersion === stored.migratedFromSchemaVersion)
    ))
  }
  for (const hook of stored.hooks) {
    const next = currentHooks.get(hook.id)
    if (!next || !compatibleHook(hook, next)) {
      throw new Error(`Session Hook 依赖不兼容：${hook.id}@${hook.version}`)
    }
  }
  for (const hook of current.hooks) {
    const previous = storedHooks.get(hook.id)
    if (!previous || !compatibleHook(previous, hook)) {
      throw new Error(`Session 缺少当前 Hook 依赖：${hook.id}@${hook.version}`)
    }
  }
  // 项目 Skill 使用"会话冻结值"比较（对齐 docs/skills-extension.md §8.1）：
  // stored/current 必须 canonical 相等；磁盘变化只在 load_skill 调用时
  // fail-closed，不在恢复时阻断会话，也不把变化后的正文当作旧会话依赖。
  const storedSkills = stored.skills ?? EMPTY_PROJECT_SKILL_INVENTORY
  const currentSkills = current.skills ?? EMPTY_PROJECT_SKILL_INVENTORY
  if (JSON.stringify(storedSkills.skills) !== JSON.stringify(currentSkills.skills)) {
    throw new Error('Session 项目 Skill 依赖不兼容（快照已变化，请显式 reload 会话 Skill）')
  }
}
