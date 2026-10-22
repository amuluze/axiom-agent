#!/usr/bin/env node
// Provider 单一数据来源（contracts/providers.json）→ Rust/TS 数据段 + runtime 语义版本契约。
// 写模式：npm run generate:providers（对 Rust 产物跑 rustfmt）。
// 校验模式：npm run generate:providers:check（与磁盘逐字节比较，任一不一致非零退出）。
//
// 生成产物提交进 git，不做 prebuild hook。修改 providers.json 后必须重新生成并提交。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT_PATH = 'apps/desktop/contracts/providers.json'
const TS_OUTPUT = 'apps/desktop/src/agent/transport/generatedProviderData.ts'
const RUST_OUTPUT = 'apps/desktop/src-tauri/src/generated_provider_table.rs'
const SEMVER_CONTRACT = 'apps/desktop/contracts/runtime-semantic-versions.json'
const APP_SOURCE_BASE = path.join(root, 'apps/desktop')

const checkOnly = process.argv.includes('--check')
const readText = async (relativePath) => readFile(path.join(root, relativePath), 'utf8')
const writeText = (relativePath, text) => writeFile(path.join(root, relativePath), text)

const API_FORMATS = ['openai-compatible', 'openai-responses', 'anthropic-compatible']
const API_FORMAT_TO_RUST_ENUM = {
  'openai-compatible': 'OpenaiCompatible',
  'openai-responses': 'OpenaiResponses',
  'anthropic-compatible': 'AnthropicCompatible',
}

const quote = (value) => `'${value
  .replace(/\\/gu, '\\\\')
  .replace(/'/gu, "\\'")
  .replace(/\n/gu, '\\n')}'`
const rustQuote = (value) => `"${value
  .replace(/\\/gu, '\\\\')
  .replace(/"/gu, '\\"')
  .replace(/\n/gu, '\\n')}"`
const fmtNumber = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, '_')
const indent = (text, spaces) => text
  .split('\n')
  .map((line) => (line ? `${' '.repeat(spaces)}${line}` : line))
  .join('\n')

// ---- schema 校验（fail-closed）----

const assertIdentifier = (value, label) => {
  assert.ok(
    typeof value === 'string' && /^[a-z][a-z0-9._-]*$/u.test(value) && value.length <= 128,
    `${label} 无效：${JSON.stringify(value)}`,
  )
}

// modelId 是上游模型名，允许带前缀分隔符 `/`（如 `openai/gpt-4o-mini`、OrcaRouter
// 的 `orcarouter/auto`）。仅放宽字符集与分隔符，仍拒绝空串、非小写字母开头、
// 连续/前导/尾随 `/` 与超长（每段至少一个字符）。
const assertModelIdentifier = (value, label) => {
  assert.ok(
    typeof value === 'string' && /^[a-z][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/u.test(value) && value.length <= 128,
    `${label} 无效：${JSON.stringify(value)}`,
  )
}

// HTTP 头名（小写，RFC 7230 token 子集）。值允许 `{version}` 占位：生成物保持字面量，
// 由 Rust 在发送时替换为应用版本（避免每次发版都让生成产物漂移）。
const assertHeaderName = (value, label) => {
  assert.ok(
    typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(value) && value.length <= 64,
    `${label} 无效（须为小写 HTTP 头名）：${JSON.stringify(value)}`,
  )
}

const urlOrigin = (url) => `${url.protocol}//${url.host}`

const validateContract = (contract) => {
  assert.equal(contract.schemaVersion, 1, 'providers.json schemaVersion must be 1')
  const c = contract.constants
  const ints = [
    ['timeoutMinMs', 'timeoutMaxMs', 'timeoutDefaultMs'],
    ['maxOutputMin', 'maxOutputMax', 'maxOutputDefault'],
    ['contextMin', 'contextMax', 'contextDefault'],
  ]
  for (const [minKey, maxKey, defaultKey] of ints) {
    for (const key of [minKey, maxKey, defaultKey]) {
      assert.ok(Number.isInteger(c[key]) && c[key] > 0, `constants.${key} must be a positive integer`)
    }
    assert.ok(c[minKey] <= c[defaultKey] && c[defaultKey] <= c[maxKey],
      `constants bounds invalid: ${minKey}/${defaultKey}/${maxKey}`)
  }
  for (const key of ['identifierMaxBytes', 'endpointMaxBytes', 'modelIdMaxBytes']) {
    assert.ok(Number.isInteger(c[key]) && c[key] > 0, `constants.${key} must be a positive integer`)
  }

  assert.ok(Array.isArray(contract.providers) && contract.providers.length > 0, 'providers must not be empty')
  const ids = new Set()
  const currentSecretIds = new Set()
  for (const provider of contract.providers) {
    assert.ok(!ids.has(provider.id), `duplicate provider id: ${provider.id}`)
    ids.add(provider.id)
    assertIdentifier(provider.id, `provider id ${provider.id}`)
    assert.ok(provider.id !== 'demo' && provider.id !== 'minimax',
      `reserved provider id: ${provider.id}`)
    assert.ok(typeof provider.label === 'string' && provider.label, `provider ${provider.id} label`)
    assert.ok(API_FORMATS.includes(provider.apiFormat),
      `provider ${provider.id} unknown apiFormat ${provider.apiFormat}`)
    assert.ok(typeof provider.transportVersion === 'string' && provider.transportVersion,
      `provider ${provider.id} transportVersion`)

    const { kind } = provider.auth
    assert.ok(kind === 'none' || kind === 'api-key', `provider ${provider.id} auth.kind`)
    if (kind === 'api-key') {
      assertIdentifier(provider.auth.defaultSecretId, `provider ${provider.id} defaultSecretId`)
      assert.ok(provider.auth.defaultSecretId.startsWith('provider.'), `provider ${provider.id} secret prefix`)
      assert.ok(!currentSecretIds.has(provider.auth.defaultSecretId), `duplicate secret id`)
      currentSecretIds.add(provider.auth.defaultSecretId)
      assert.ok(typeof provider.auth.required === 'boolean', `provider ${provider.id} auth.required`)
    } else {
      assert.equal(provider.auth.defaultSecretId, undefined, `provider ${provider.id} none auth secret`)
      assert.equal(provider.auth.required, undefined, `provider ${provider.id} none auth required`)
    }

    // per-provider 可信 host：该 provider 允许的官方/可信模型服务 host（不含默认
    // endpoint host——默认 origin 由 resolve_profile 的 origin 匹配放行）。Provider A
    // 的 Secret 不得发往 Provider B 的官方域名，因此按 provider 收窄而非全局第三方表。
    assert.ok(
      Array.isArray(provider.trustedHosts ?? []),
      `provider ${provider.id} trustedHosts must be an array`,
    )
    const trustedHosts = provider.trustedHosts ?? []
    assert.ok(
      new Set(trustedHosts).size === trustedHosts.length,
      `provider ${provider.id} trustedHosts must be unique`,
    )
    for (const host of trustedHosts) {
      assert.ok(
        typeof host === 'string' && host.length > 0 && host === host.toLowerCase(),
        `provider ${provider.id} trustedHost must be a non-empty lowercase string`,
      )
    }

    assert.ok(
      provider.allowPublicEndpoints === undefined || typeof provider.allowPublicEndpoints === 'boolean',
      `provider ${provider.id} allowPublicEndpoints must be a boolean`,
    )

    // 静态请求头与会话头（可选）：Rust 侧发送时注入。值里的 `{version}` 由 model_http
    // 替换为应用版本；会话头的值取请求携带的 sessionId（不接受自定义值）。
    if (provider.requestHeaders !== undefined) {
      assert.ok(
        typeof provider.requestHeaders === 'object' && provider.requestHeaders !== null
        && !Array.isArray(provider.requestHeaders),
        `provider ${provider.id} requestHeaders must be an object`,
      )
      const headerNames = Object.keys(provider.requestHeaders)
      assert.ok(headerNames.length > 0, `provider ${provider.id} requestHeaders must not be empty`)
      for (const name of headerNames) {
        assertHeaderName(name, `provider ${provider.id} requestHeaders name`)
        assert.ok(
          typeof provider.requestHeaders[name] === 'string' && provider.requestHeaders[name].length > 0,
          `provider ${provider.id} requestHeaders ${name} value must be a non-empty string`,
        )
      }
    } else {
      assert.equal(provider.requestHeaders, undefined, `provider ${provider.id} requestHeaders`)
    }
    if (provider.sessionHeader !== undefined) {
      assertHeaderName(provider.sessionHeader, `provider ${provider.id} sessionHeader`)
    }

    // 展示用链接（UI-only，不进 Rust 表）：官网与邀请/优惠链接。只允许 https 绝对 URL
    // 且不含内嵌凭据——生成期 fail-closed 拒绝，UI 只把它们渲染成 <a>（实际打开仍经
    // `open_external_url` 的协议校验）。
    for (const key of ['website', 'inviteUrl']) {
      const value = provider[key]
      if (value === undefined) continue
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `provider ${provider.id} ${key} must be a non-empty string`,
      )
      const parsed = new URL(value)
      assert.equal(parsed.protocol, 'https:', `provider ${provider.id} ${key} must be https`)
      assert.equal(parsed.username, '', `provider ${provider.id} ${key} must not embed credentials`)
      assert.equal(parsed.password, '', `provider ${provider.id} ${key} must not embed credentials`)
    }

    const caps = provider.supportedCapabilities
    assert.ok(typeof caps.toolReferences === 'boolean' && typeof caps.toolSearch === 'boolean',
      `provider ${provider.id} supportedCapabilities`)
    const profile = provider.defaultProfile
    assertIdentifier(profile.profileId, `provider ${provider.id} profileId`)
    const endpoint = new URL(profile.endpoint)
    assert.ok(endpoint.protocol === 'http:' || endpoint.protocol === 'https:',
      `provider ${provider.id} endpoint scheme`)
    assert.ok(endpoint.hostname, `provider ${provider.id} endpoint host`)
    assert.ok(
      profile.timeoutMs >= c.timeoutMinMs && profile.timeoutMs <= c.timeoutMaxMs,
      `provider ${provider.id} timeoutMs out of bounds`,
    )
    assert.ok(
      profile.maxOutputTokens >= c.maxOutputMin && profile.maxOutputTokens <= c.maxOutputMax,
      `provider ${provider.id} maxOutputTokens out of bounds`,
    )
    assert.ok(
      profile.contextWindow >= c.contextMin && profile.contextWindow <= c.contextMax,
      `provider ${provider.id} contextWindow out of bounds`,
    )
    assert.ok(typeof profile.modelId === 'string', `provider ${provider.id} modelId`)
    assert.ok(typeof profile.capabilities.toolReferences === 'boolean'
      && typeof profile.capabilities.toolSearch === 'boolean',
      `provider ${provider.id} defaultProfile.capabilities`)

    assert.ok(Array.isArray(provider.legacySecretIdPrefixes), `provider ${provider.id} legacySecretIdPrefixes`)
    for (const legacy of provider.legacySecretIdPrefixes) {
      assertIdentifier(legacy, `provider ${provider.id} legacy prefix`)
      assert.ok(!currentSecretIds.has(legacy), `provider ${provider.id} legacy prefix conflicts with current`)
    }

    assert.ok(Array.isArray(provider.models), `provider ${provider.id} models`)
    const modelIds = new Set()
    for (const model of provider.models) {
      assert.ok(!modelIds.has(model.modelId), `provider ${provider.id} duplicate model ${model.modelId}`)
      modelIds.add(model.modelId)
      assertModelIdentifier(model.modelId, `provider ${provider.id} model ${model.modelId}`)
      assert.ok(typeof model.label === 'string' && model.label, `provider ${provider.id} model label`)
      assert.ok(model.contextWindow >= c.contextMin && model.contextWindow <= c.contextMax,
        `provider ${provider.id} model ${model.modelId} contextWindow`)
      assert.ok(Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0,
        `provider ${provider.id} model ${model.modelId} maxOutputTokens`)
      assert.ok(Array.isArray(model.input) && model.input.every((item) => item === 'text' || item === 'image'),
        `provider ${provider.id} model ${model.modelId} input`)
      assert.ok(typeof model.supportsReasoning === 'boolean', `provider ${provider.id} model supportsReasoning`)

      // 模型级 wire（可选）：一个订阅下多协议网关用（如 OpenCode Go 的 chat/responses/
      // messages 三形状）。约束是「同 origin 的不同 path」——Rust resolve_profile 的端点
      // 覆盖规则（换 host 保留协议 path）只有在同 origin 下才是良定义的。
      if (model.wire === undefined) continue
      const wire = model.wire
      const modelLabel = `provider ${provider.id} model ${model.modelId} wire`
      assert.ok(API_FORMATS.includes(wire.apiFormat), `${modelLabel} unknown apiFormat ${wire.apiFormat}`)
      const wireUrl = new URL(wire.endpoint)
      assert.equal(wireUrl.protocol, 'https:', `${modelLabel} endpoint must be https`)
      assert.equal(
        urlOrigin(wireUrl),
        urlOrigin(endpoint),
        `${modelLabel} endpoint must share the provider default origin`,
      )
      assert.ok(
        wire.apiFormat !== provider.apiFormat || wire.endpoint !== profile.endpoint,
        `${modelLabel} is a no-op (same apiFormat and endpoint as the provider default)`,
      )
    }
  }
}

// ---- TS 产物 ----

const tsModel = (model) => `{
    modelId: ${quote(model.modelId)},
    label: ${quote(model.label)},
    contextWindow: ${fmtNumber(model.contextWindow)},
    maxOutputTokens: ${fmtNumber(model.maxOutputTokens)},
    input: [${model.input.map((item) => quote(item)).join(', ')}],
    supportsReasoning: ${model.supportsReasoning},${model.wire ? `
    wire: {
      apiFormat: ${quote(model.wire.apiFormat)},
      endpoint: ${quote(model.wire.endpoint)},
    },` : ''}
  }`

const tsHeaders = (headers) => Object.entries(headers)
  .map(([name, value]) => `${quote(name)}: ${quote(value)}`)
  .join(', ')

const tsProvider = (provider) => `{
    id: ${quote(provider.id)},
    label: ${quote(provider.label)},
    apiFormat: ${quote(provider.apiFormat)},
    transportVersion: ${quote(provider.transportVersion)},
    auth: ${provider.auth.kind === 'none'
      ? `{ kind: 'none' }`
      : `{
      kind: 'api-key',
      defaultSecretId: ${quote(provider.auth.defaultSecretId)},
      required: ${provider.auth.required},
    }`},${provider.requestHeaders ? `
    requestHeaders: { ${tsHeaders(provider.requestHeaders)} },` : ''}${provider.sessionHeader ? `
    sessionHeader: ${quote(provider.sessionHeader)},` : ''}${provider.website ? `
    website: ${quote(provider.website)},` : ''}${provider.inviteUrl ? `
    inviteUrl: ${quote(provider.inviteUrl)},` : ''}
    supportedCapabilities: {
      toolReferences: ${provider.supportedCapabilities.toolReferences},
      toolSearch: ${provider.supportedCapabilities.toolSearch},
    },
    defaultProfile: {
      profileId: ${quote(provider.defaultProfile.profileId)},
      endpoint: ${quote(provider.defaultProfile.endpoint)},
      modelId: ${quote(provider.defaultProfile.modelId)},
      timeoutMs: ${fmtNumber(provider.defaultProfile.timeoutMs)},
      maxOutputTokens: ${fmtNumber(provider.defaultProfile.maxOutputTokens)},
      contextWindow: ${fmtNumber(provider.defaultProfile.contextWindow)},
      capabilities: {
        toolReferences: ${provider.defaultProfile.capabilities.toolReferences},
        toolSearch: ${provider.defaultProfile.capabilities.toolSearch},
      },
    },
    legacySecretIdPrefixes: [${provider.legacySecretIdPrefixes.map(quote).join(', ')}],
    models: [${provider.models.map(tsModel).join(',\n    ')}],
  }`

const generateTs = (contract) => {
  const c = contract.constants
  const header = '// @generated by scripts/generate-provider-sources.mjs — DO NOT EDIT.'
  const providerData = contract.providers.map(tsProvider).join(',\n  ')
  const providerIds = contract.providers.map((provider) => quote(provider.id)).join(', ')
  return `${header}
//
// Provider 声明数据段（contracts/providers.json 单一来源）。只含类型与字面量，
// 不得 import 任何 Provider Runtime / Registry / CredentialRuntime。

export interface GeneratedProviderModel {
  readonly modelId: string
  readonly label: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly input: readonly ('text' | 'image')[]
  readonly supportsReasoning: boolean
  /**
   * 模型级 wire（多协议网关专用）：该模型不走 provider 默认 apiFormat/endpoint，而是走
   * 自己的协议与路径（如 OpenCode Go 的 /responses、/messages）。缺省时用 provider 默认。
   */
  readonly wire?: GeneratedProviderWire
}

export interface GeneratedProviderWire {
  readonly apiFormat: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible'
  readonly endpoint: string
}

export interface GeneratedProviderCapabilities {
  readonly toolReferences: boolean
  readonly toolSearch: boolean
}

export type GeneratedProviderAuth =
  | { readonly kind: 'none' }
  | { readonly kind: 'api-key'; readonly defaultSecretId: string; readonly required: boolean }

export interface GeneratedProviderProfile {
  readonly profileId: string
  readonly endpoint: string
  readonly modelId: string
  readonly timeoutMs: number
  readonly maxOutputTokens: number
  readonly contextWindow: number
  readonly capabilities: GeneratedProviderCapabilities
}

export interface GeneratedProviderData {
  readonly id: string
  readonly label: string
  readonly apiFormat: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible'
  readonly transportVersion: string
  readonly auth: GeneratedProviderAuth
  /**
   * 静态请求头（发送值，{version} 占位由 Rust 侧替换为应用版本）；TS 不消费，
   * 只为与 Rust 生成表保持单一数据源与可审计性。
   */
  readonly requestHeaders?: Readonly<Record<string, string>>
  /** 会话头名：值取请求携带的 sessionId（Rust 侧注入）。 */
  readonly sessionHeader?: string
  /**
   * 官网地址（UI-only 展示字段，不进 Rust 表）：设置页把订阅型 provider 的官方入口与
   * 邀请/优惠链接呈现给用户。生成期已校验 https 且无内嵌凭据。
   */
  readonly website?: string
  /** 邀请/优惠链接（UI-only）：与官网并列展示，供用户订阅时获得优惠。 */
  readonly inviteUrl?: string
  readonly supportedCapabilities: GeneratedProviderCapabilities
  readonly defaultProfile: GeneratedProviderProfile
  readonly legacySecretIdPrefixes: readonly string[]
  readonly models: readonly GeneratedProviderModel[]
}

export const PROVIDER_CONSTANTS = {
  timeoutMinMs: ${fmtNumber(c.timeoutMinMs)},
  timeoutMaxMs: ${fmtNumber(c.timeoutMaxMs)},
  timeoutDefaultMs: ${fmtNumber(c.timeoutDefaultMs)},
  maxOutputMin: ${fmtNumber(c.maxOutputMin)},
  maxOutputMax: ${fmtNumber(c.maxOutputMax)},
  maxOutputDefault: ${fmtNumber(c.maxOutputDefault)},
  contextMin: ${fmtNumber(c.contextMin)},
  contextMax: ${fmtNumber(c.contextMax)},
  contextDefault: ${fmtNumber(c.contextDefault)},
  identifierMaxBytes: ${fmtNumber(c.identifierMaxBytes)},
  endpointMaxBytes: ${fmtNumber(c.endpointMaxBytes)},
  modelIdMaxBytes: ${fmtNumber(c.modelIdMaxBytes)},
} as const

export const PROVIDER_IDS = [${providerIds}] as const

export const PROVIDER_DATA: readonly GeneratedProviderData[] = [
  ${providerData},
]
`
}

// ---- Rust 产物 ----

const rustProvider = (provider) => {
  const auth = provider.auth.kind === 'none'
    ? `ProviderAuth {
            kind: AuthKind::None,
            default_secret_id: None,
            required: false,
        }`
    : `ProviderAuth {
            kind: AuthKind::ApiKey,
            default_secret_id: Some(${rustQuote(provider.auth.defaultSecretId)}),
            required: ${provider.auth.required},
        }`
  const wires = provider.models.filter((model) => model.wire)
  const modelWires = wires.length === 0
    ? '&[]'
    : `&[
            ${wires.map((model) => `ProviderModelWire {
                model_id: ${rustQuote(model.modelId)},
                api_format: ModelApiFormat::${API_FORMAT_TO_RUST_ENUM[model.wire.apiFormat]},
                endpoint: ${rustQuote(model.wire.endpoint)},
            }`).join(',\n            ')},
        ]`
  return `ProviderProfileEntry {
        provider_id: ${rustQuote(provider.id)},
        api_format: ModelApiFormat::${API_FORMAT_TO_RUST_ENUM[provider.apiFormat]},
        auth: ${auth},
        supported_capabilities: ProviderCapabilities {
            tool_references: ${provider.supportedCapabilities.toolReferences},
            tool_search: ${provider.supportedCapabilities.toolSearch},
        },
        default_profile: ProviderDefaultProfile {
            profile_id: ${rustQuote(provider.defaultProfile.profileId)},
            endpoint: ${rustQuote(provider.defaultProfile.endpoint)},
            model_id: ${rustQuote(provider.defaultProfile.modelId)},
            timeout_ms: ${fmtNumber(provider.defaultProfile.timeoutMs)},
            max_output_tokens: ${fmtNumber(provider.defaultProfile.maxOutputTokens)},
            context_window: ${fmtNumber(provider.defaultProfile.contextWindow)},
            capabilities: ProviderCapabilities {
                tool_references: ${provider.defaultProfile.capabilities.toolReferences},
                tool_search: ${provider.defaultProfile.capabilities.toolSearch},
            },
        },
        allow_public_endpoints: ${provider.allowPublicEndpoints ?? false},
        model_wires: ${modelWires},
        legacy_secret_id_prefixes: &[${provider.legacySecretIdPrefixes.map(rustQuote).join(', ')}],
    }`
}

const generateRust = (contract) => {
  const c = contract.constants
  const currentSecrets = contract.providers
    .filter((provider) => provider.auth.kind === 'api-key')
    .map((provider) => provider.auth.defaultSecretId)
  const legacySecrets = contract.providers.flatMap((provider) => provider.legacySecretIdPrefixes)
  const providerTrustedHosts = contract.providers.map((provider) => {
    const providerHosts = (provider.trustedHosts ?? []).map(rustQuote).join(', ')
    return `(${rustQuote(provider.id)}, &[${providerHosts}])`
  }).join(',\n    ')
  // 静态请求头/会话头表：只列声明了的 provider（查表未命中 = 无附加头）。
  const staticHeaders = contract.providers
    .filter((provider) => provider.requestHeaders)
    .map((provider) => {
      const pairs = Object.entries(provider.requestHeaders)
        .map(([name, value]) => `(${rustQuote(name)}, ${rustQuote(value)})`)
        .join(', ')
      return `(${rustQuote(provider.id)}, &[${pairs}])`
    })
    .join(',\n    ')
  const sessionHeaders = contract.providers
    .filter((provider) => provider.sessionHeader)
    .map((provider) => `(${rustQuote(provider.id)}, ${rustQuote(provider.sessionHeader)})`)
    .join(',\n    ')
  // 会话头的 host 级声明：上游的要求属于**服务**（「opencode.ai 上的所有推理请求」），
  // 而不是 provider 条目——把该服务配成自定义 provider 的用户同样必须带这个头，否则
  // 400 MissingSessionID。host 集合取自声明了 sessionHeader 的 provider 的默认 endpoint
  // host ∪ trustedHosts（已声明过的域名），因此不需要额外配置项。
  const sessionHeaderHosts = [...new Map(contract.providers
    .filter((provider) => provider.sessionHeader)
    .flatMap((provider) => {
      const hosts = new Set([
        new URL(provider.defaultProfile.endpoint).host,
        ...(provider.trustedHosts ?? []),
      ])
      return [...hosts].map((host) => [host, provider.sessionHeader])
    })).entries()]
    .map(([host, header]) => `(${rustQuote(host)}, ${rustQuote(header)})`)
    .join(',\n    ')
  const entries = contract.providers.map(rustProvider).join(',\n    ')
  return `// @generated by scripts/generate-provider-sources.mjs — DO NOT EDIT.
// Provider 内置表数据段（contracts/providers.json 单一来源）。字段语义见
// provider_profiles.rs 的 ProviderProfileEntry 注释。

#![allow(dead_code)]

use crate::model_http::ModelApiFormat;
use crate::provider_profiles::{
    AuthKind, ProviderAuth, ProviderCapabilities, ProviderDefaultProfile, ProviderModelWire,
    ProviderProfileEntry,
};

pub(crate) const TIMEOUT_MIN_MS: u64 = ${fmtNumber(c.timeoutMinMs)};
pub(crate) const TIMEOUT_MAX_MS: u64 = ${fmtNumber(c.timeoutMaxMs)};
pub(crate) const TIMEOUT_DEFAULT_MS: u64 = ${fmtNumber(c.timeoutDefaultMs)};
pub(crate) const MAX_OUTPUT_MIN: u64 = ${fmtNumber(c.maxOutputMin)};
pub(crate) const MAX_OUTPUT_MAX: u64 = ${fmtNumber(c.maxOutputMax)};
pub(crate) const MAX_OUTPUT_DEFAULT: u64 = ${fmtNumber(c.maxOutputDefault)};
pub(crate) const CONTEXT_MIN: u64 = ${fmtNumber(c.contextMin)};
pub(crate) const CONTEXT_MAX: u64 = ${fmtNumber(c.contextMax)};
pub(crate) const CONTEXT_DEFAULT: u64 = ${fmtNumber(c.contextDefault)};
pub(crate) const IDENTIFIER_MAX_BYTES: usize = ${fmtNumber(c.identifierMaxBytes)};
pub(crate) const ENDPOINT_MAX_BYTES: usize = ${fmtNumber(c.endpointMaxBytes)};
pub(crate) const MODEL_ID_MAX_BYTES: usize = ${fmtNumber(c.modelIdMaxBytes)};

pub(crate) const CURRENT_PROVIDER_SECRET_PREFIXES: &[&str] = &[${currentSecrets.map(rustQuote).join(', ')}];
pub(crate) const LEGACY_PROVIDER_SECRET_PREFIXES: &[&str] = &[${legacySecrets.map(rustQuote).join(', ')}];
/// 每个 provider 允许的官方/可信模型服务 host（providers.json 每项 trustedHosts 生成，
/// 小写精确匹配）。自定义端点 host 必须命中该 provider 自己的表——Provider A 的
/// Secret 不会被发往 Provider B 的官方域名（provider→origin 强绑定）。
pub(crate) const PROVIDER_TRUSTED_HOSTS: &[(&str, &[&str])] = &[
    ${providerTrustedHosts},
];

/// provider 静态请求头（providers.json requestHeaders 生成）。值是**发送值**，{version}
/// 占位由 model_http 在请求期替换为应用版本（生成物保持字面量，发版不触发 digest 漂移）。
pub(crate) const PROVIDER_REQUEST_HEADERS: &[(&str, &[(&str, &str)])] = &[
    ${staticHeaders},
];

/// provider 会话头名（providers.json sessionHeader 生成）：值取请求携带的 sessionId，
/// 上游按它做路由/提示缓存亲和（缺失即 400 MissingSessionID，因此恒不省略）。
pub(crate) const PROVIDER_SESSION_HEADERS: &[(&str, &str)] = &[
    ${sessionHeaders},
];

/// 会话头的 host 级声明（由声明了 sessionHeader 的 provider 的默认 endpoint host 与
/// trustedHosts 派生）：要求属于服务而非 provider 条目——把该服务配成自定义 provider
/// 的请求同样必须带这个头。匹配为「精确 host 或子域」。
pub(crate) const PROVIDER_SESSION_HEADER_HOSTS: &[(&str, &str)] = &[
    ${sessionHeaderHosts},
];

pub(crate) const GENERATED_PROVIDER_ENTRIES: &[ProviderProfileEntry] = &[
    ${entries},
];
`
}

// ---- runtime 语义版本契约 ----

// 刻意纳入生成的 generatedProviderData.ts：Provider 数据变更（新增模型/改 endpoint/
// bump transportVersion）必须触发 semantic digest 漂移，强制"改了数据就重新生成并提交"。
const PROVIDER_SOURCE_FILES = {
  'openai-compatible': [
    'src/agent/transport/builtinProviderDescriptors.ts',
    'src/agent/transport/OpenAICompatibleTransport.ts',
    'src/agent/transport/sse.ts',
    'src/agent/transport/generatedProviderData.ts',
    // 跨 transport 共享的模型可见语义：错误分类决定自动重试，图片降级决定模型收到什么。
    'src/agent/core/providerError.ts',
    'src/agent/core/streamAssistantMessage.ts',
  ],
  'openai-responses': [
    'src/agent/transport/builtinProviderDescriptors.ts',
    'src/agent/transport/OpenAIResponsesTransport.ts',
    'src/agent/transport/sse.ts',
    'src/agent/transport/generatedProviderData.ts',
    'src/agent/core/providerError.ts',
    'src/agent/core/streamAssistantMessage.ts',
  ],
  'anthropic-compatible': [
    'src/agent/transport/builtinProviderDescriptors.ts',
    'src/agent/transport/AnthropicCompatibleTransport.ts',
    'src/agent/transport/sse.ts',
    'src/agent/transport/generatedProviderData.ts',
    'src/agent/core/providerError.ts',
    'src/agent/core/streamAssistantMessage.ts',
  ],
}
const DEMO_SOURCE_FILES = [
  'src/agent/transport/builtinProviderDescriptors.ts',
  'src/agent/transport/DemoModelTransport.ts',
  'src/agent/transport/generatedProviderData.ts',
]

// 与 runtimeSemanticVersions.test.ts 的 semanticSourceDigest 逐字节一致
// （统一实现见 scripts/lib/semantic-digest.mjs）。
import { semanticSourceDigest } from './lib/semantic-digest.mjs'

const generatedProviderSections = (contract) => {
  const demo = {
    id: 'provider:demo',
    version: '3',
    sourceFiles: DEMO_SOURCE_FILES,
  }
  const entries = contract.providers.map((provider) => {
    // 多协议 provider（模型级 wire）：审计范围必须覆盖它实际会用到的**全部** transport
    // 实现，否则某个 wire 的解析代码改了却不会让 digest 漂移。单协议 provider 的列表与
    // 顺序保持逐字不变（避免无谓 diff）。
    const formats = new Set([provider.apiFormat])
    for (const model of provider.models) {
      if (model.wire) formats.add(model.wire.apiFormat)
    }
    const sourceFiles = formats.size === 1
      ? PROVIDER_SOURCE_FILES[provider.apiFormat]
      : [...new Set([...formats].flatMap((format) => PROVIDER_SOURCE_FILES[format]))].sort()
    return {
      id: `provider:${provider.id}`,
      version: provider.transportVersion,
      sourceFiles,
    }
  })
  return [demo, ...entries].map((entry) => ({
    id: entry.id,
    version: entry.version,
    sourceFiles: entry.sourceFiles,
    semanticDigest: semanticSourceDigest(entry.sourceFiles, APP_SOURCE_BASE),
  }))
}

const rewriteSemverContract = (oldContract, sections) => {
  const firstProviderIndex = oldContract.components.findIndex((component) => (
    component.id.startsWith('provider:')
  ))
  assert.ok(firstProviderIndex >= 0, 'semver contract must contain a provider component')
  const providerPrefix = oldContract.components.slice(0, firstProviderIndex)
  const providerSuffix = oldContract.components
    .slice(firstProviderIndex)
    .filter((component) => !component.id.startsWith('provider:'))
  return {
    schemaVersion: oldContract.schemaVersion,
    components: [...providerPrefix, ...sections, ...providerSuffix],
  }
}

// ---- rustfmt 包装 ----

const runRustfmt = (rustText) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'axiom-provider-gen-'))
  const filePath = path.join(directory, 'generated_provider_table.rs')
  writeFileSync(filePath, rustText)
  try {
    const result = spawnSync(
      'node',
      [path.join(root, 'scripts/with-rust-toolchain.mjs'), 'rustfmt', '--edition', '2021', filePath],
      { encoding: 'utf8', cwd: root },
    )
    assert.equal(result.status, 0, `rustfmt failed:\n${result.stderr}`)
    return readFileSync(filePath, 'utf8')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// ---- 主流程 ----

const contract = JSON.parse(await readText(CONTRACT_PATH))
validateContract(contract)

const tsText = generateTs(contract)
const rustText = runRustfmt(generateRust(contract))
const semverContract = JSON.parse(await readText(SEMVER_CONTRACT))
const readDiskOrNull = (relativePath) => {
  try { return readFileSync(path.join(root, relativePath), 'utf8') } catch { return null }
}

if (checkOnly) {
  const failures = []
  if (readDiskOrNull(TS_OUTPUT) !== tsText) failures.push('TS 产物')
  if (readDiskOrNull(RUST_OUTPUT) !== rustText) failures.push('Rust 产物')
  if (failures.length > 0) {
    console.error(`Provider 生成产物已过期或缺失：${failures.join('、')}`)
    console.error('请运行 `npm run generate:providers` 并提交生成产物。')
    process.exit(1)
  }
  const sections = generatedProviderSections(contract)
  const nextSemver = rewriteSemverContract(semverContract, sections)
  const semverText = `${JSON.stringify(nextSemver, null, 2)}\n`
  if (readDiskOrNull(SEMVER_CONTRACT) !== semverText) {
    console.error('runtime 语义版本契约的 provider 段已过期。请运行 `npm run generate:providers`。')
    process.exit(1)
  }
  console.log('Provider 生成产物与契约一致。')
} else {
  await writeText(TS_OUTPUT, tsText)
  await writeText(RUST_OUTPUT, rustText)
  const sections = generatedProviderSections(contract)
  const nextSemver = rewriteSemverContract(semverContract, sections)
  const semverText = `${JSON.stringify(nextSemver, null, 2)}\n`
  await writeText(SEMVER_CONTRACT, semverText)
  console.log(`已生成：${TS_OUTPUT}、${RUST_OUTPUT}，并重写 ${SEMVER_CONTRACT} 的 provider 段。`)
}
