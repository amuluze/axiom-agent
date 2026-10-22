import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_FILE_KIND,
  environmentRecordDraftFromFile,
  parseEnvironmentFile,
} from './environmentFile'

const base = {
  kind: ENVIRONMENT_FILE_KIND,
  version: 1,
  id: 'local-shop',
  name: '本地开发环境',
  mode: 'local',
  vars: { WEB_BASE_URL: 'http://127.0.0.1:5173', API_BASE_URL: 'http://127.0.0.1:9/api' },
  headers: { 'x-tenant': 'demo' },
  secretNames: ['apitest.orders-token'],
  recipe: {
    start: ['docker compose up -d'],
    stop: ['docker compose down'],
    readiness: ['curl -fsS http://127.0.0.1:5173/health'],
    timeoutMs: 180_000,
  },
}

const parse = (overrides: Record<string, unknown> = {}) =>
  parseEnvironmentFile(JSON.stringify({ ...base, ...overrides }))

const issuesOf = (overrides: Record<string, unknown> = {}) => {
  const result = parse(overrides)
  if (result.ok) throw new Error('预期解析失败')
  return result.issues
}

describe('parseEnvironmentFile', () => {
  it('accepts a local environment file and maps it to a record draft', () => {
    const result = parse()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.mode).toBe('local')
    expect(result.file.recipe?.timeoutMs).toBe(180_000)
    expect(environmentRecordDraftFromFile(result.file)).toEqual({
      id: 'local-shop',
      name: '本地开发环境',
      kind: 'local',
      recipeJson: JSON.stringify(base.recipe),
      webBaseUrl: 'http://127.0.0.1:5173',
      apiBaseUrl: 'http://127.0.0.1:9/api',
      allowPrivateNetwork: false,
      headersJson: JSON.stringify({ 'x-tenant': 'demo' }),
      secretIdsJson: JSON.stringify(['apitest.orders-token']),
    })
  })

  it('accepts a remote environment file without a recipe', () => {
    const result = parse({
      mode: 'remote',
      recipe: undefined,
      vars: { API_BASE_URL: 'https://staging.test/api' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.recipe).toBeUndefined()
    expect(environmentRecordDraftFromFile(result.file).recipeJson).toBeNull()
  })

  it('rejects a remote file that declares start or stop commands', () => {
    const readiness = ['curl -fsS https://staging.test/health']
    expect(issuesOf({ mode: 'remote', recipe: { start: ['docker compose up -d'], readiness } })).toEqual([
      { path: '$.recipe.start', message: 'remote 档不得声明启动命令（共享环境只做只读校验）' },
    ])
    expect(issuesOf({
      mode: 'remote',
      recipe: { stop: ['docker compose down'], readiness },
    })).toEqual([
      { path: '$.recipe.stop', message: 'remote 档不得声明停止命令（共享环境只做只读校验）' },
    ])
  })

  it('requires a recipe and a real API base for local files', () => {
    expect(issuesOf({ recipe: undefined })).toEqual([
      { path: '$.recipe', message: 'local 档必须给出发起停与就绪配方' },
    ])
    expect(issuesOf({ recipe: { start: ['up'], readiness: [] } })).toEqual([
      { path: '$.recipe.readiness', message: '至少需要 1 项' },
    ])
    expect(issuesOf({ vars: { WEB_BASE_URL: 'http://127.0.0.1:5173' } })).toEqual([
      { path: '$.vars.API_BASE_URL', message: 'local 档必须给出真实接口地址（第 3 级探针要真打一次接口）' },
    ])
    expect(issuesOf({ recipe: { timeoutMs: 120_000 } })).toEqual([
      { path: '$.recipe', message: '配方至少要给出启动命令或就绪命令' },
    ])
  })

  it('rejects plaintext credentials and host absolute paths anywhere in the file', () => {
    expect(issuesOf({ headers: { 'x-token': 'Bearer abc123' } })).toEqual([
      { path: '$.headers.x-token', message: '不允许出现明文凭据；请改用 Secret 引用（apitest.*）' },
    ])
    expect(issuesOf({ headers: { 'x-key': 'sk-live-0123456789' } })).toEqual([
      { path: '$.headers.x-key', message: '不允许出现明文凭据；请改用 Secret 引用（apitest.*）' },
    ])
    expect(issuesOf({ vars: { WEB_BASE_URL: 'http://127.0.0.1:5173', API_BASE_URL: '/Users/amu/app' } })).toEqual([
      { path: '$.vars.API_BASE_URL', message: '不允许出现宿主绝对路径；环境档需要能在其它机器上复用' },
    ])
  })

  it('rejects sensitive header names and non-Secret-shaped names', () => {
    expect(issuesOf({ headers: { Authorization: 'whatever' } })).toEqual([
      { path: '$.headers.Authorization', message: '敏感请求头必须走 Secret 引用，不能写进环境档' },
    ])
    expect(issuesOf({ secretNames: ['orders-token-secret-value'] })).toEqual([
      { path: '$.secretNames[0]', message: '只允许写 Secret 名（apitest.*），不能写明文' },
    ])
    const deduped = parse({ secretNames: ['apitest.b', 'apitest.a', 'apitest.b'] })
    expect(deduped.ok).toBe(true)
    if (!deduped.ok) return
    expect(deduped.file.secretNames).toEqual(['apitest.b', 'apitest.a'])
  })

  it('rejects unknown fields, unknown variable names and unknown modes', () => {
    expect(issuesOf({ owner: 'team' })).toEqual([{ path: '$.owner', message: '未知字段「owner」' }])
    expect(issuesOf({ vars: { WEB_BASE_URL: 'http://127.0.0.1:1', DB_URL: 'postgres://x' } })).toEqual([
      { path: '$.vars.DB_URL', message: '未知字段「DB_URL」' },
    ])
    expect(issuesOf({ mode: 'cluster' })).toEqual([{ path: '$.mode', message: '只允许 local 或 remote' }])
  })

  it('rejects other documents, unknown versions and malformed JSON', () => {
    expect(parseEnvironmentFile('{ not json')).toEqual({
      ok: false,
      issues: [{ path: '$', message: 'JSON 解析失败' }],
    })
    expect(parseEnvironmentFile(JSON.stringify({ ...base, kind: 'axiom.test' }))).toEqual({
      ok: false,
      issues: [{ path: '$.kind', message: `必须为 "${ENVIRONMENT_FILE_KIND}"` }],
    })
    expect(issuesOf({ version: 2 })).toEqual([
      { path: '$.version', message: '不支持的版本，当前支持 1' },
    ])
  })

  it('validates the declared readiness probe', () => {
    const declared = parse({ recipe: { ...base.recipe, probe: { method: 'HEAD', path: '/healthz', expectStatus: [204] } } })
    expect(declared.ok).toBe(true)
    if (!declared.ok) return
    expect(declared.file.recipe?.probe).toEqual({ method: 'HEAD', path: '/healthz', expectStatus: [204] })

    // 未声明探针时缺省 GET / 期望 200 由 readiness 模块补齐，配方里不写死。
    const withoutProbe = parse()
    expect(withoutProbe.ok).toBe(true)
    if (!withoutProbe.ok) return
    expect(withoutProbe.file.recipe?.probe).toBeUndefined()

    expect(issuesOf({ recipe: { ...base.recipe, probe: { method: 'TRACE' } } })).toEqual([
      { path: '$.recipe.probe.method', message: 'method 必须是 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS 之一' },
    ])
    expect(issuesOf({ recipe: { ...base.recipe, probe: { path: 'health' } } })).toEqual([
      { path: '$.recipe.probe.path', message: '探针路径必须以 / 开头（相对 API Base URL）' },
    ])
    expect(issuesOf({ recipe: { ...base.recipe, probe: { path: '/health', expectStatus: [] } } })).toEqual([
      { path: '$.recipe.probe.expectStatus', message: 'expectStatus 必须是 1–8 个 100–599 的整数' },
    ])
  })

  it('rejects invalid ids, viewport pairs and oversize values', () => {
    expect(issuesOf({ id: 'Local_Shop' })).toEqual([
      { path: '$.id', message: 'ID 必须以小写字母开头，仅含小写字母、数字与连字符，长度 1–64' },
    ])
    expect(issuesOf({ viewport: { width: 100, height: 800 } })).toEqual([
      { path: '$.viewport.width', message: '必须在 320 到 3840 之间' },
    ])
    expect(issuesOf({ headers: { 'x-big': 'a'.repeat(4097) } })).toEqual([
      { path: '$.headers.x-big', message: '长度不能超过 4096 字符' },
    ])
  })
})
