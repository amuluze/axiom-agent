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
      { path: '$.recipe.readiness', message: 'local 档必须给出就绪命令' },
    ])
    expect(issuesOf({ vars: { WEB_BASE_URL: 'http://127.0.0.1:5173' } })).toEqual([
      { path: '$.vars.API_BASE_URL', message: 'local 档必须给出真实接口地址（第 3 级探针要真打一次接口）' },
    ])
    expect(issuesOf({ recipe: { timeoutMs: 120_000 } })).toEqual([
      { path: '$.recipe', message: '配方至少要给出启动命令、就绪命令或就绪探针' },
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
    expect(issuesOf({ vars: { WEB_BASE_URL: 'http://127.0.0.1:1', db_url: 'postgres://x' } })).toEqual([
      { path: '$.vars.db_url', message: 'v1 档只允许 WEB_BASE_URL/API_BASE_URL；自定义变量请把 version 升到 2' },
    ])
    // v1 档出现自定义大写变量 → 明确要求升版本（多服务端点是 v2 能力）。
    expect(issuesOf({ vars: { WEB_BASE_URL: 'http://127.0.0.1:1', DETECTOR_MGMT_URL: 'http://127.0.0.1:2' } })).toEqual([
      { path: '$.vars.DETECTOR_MGMT_URL', message: 'v1 档只允许 WEB_BASE_URL/API_BASE_URL；自定义变量请把 version 升到 2' },
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
    expect(issuesOf({ version: 4 })).toEqual([
      { path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' },
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

describe('parseEnvironmentFile v2（多服务拓扑）', () => {
  const v2Base = {
    ...base,
    version: 2,
    vars: {
      WEB_BASE_URL: 'http://127.0.0.1:5173',
      API_BASE_URL: 'http://127.0.0.1:8090',
      DETECTOR_MGMT_URL: 'http://127.0.0.1:18081',
      DATA_PLANE_URL: 'http://127.0.0.1:8081',
    },
  }
  const v2File = (overrides: Record<string, unknown> = {}) =>
    parseEnvironmentFile(JSON.stringify({ ...v2Base, ...overrides }))
  const v2Issues = (overrides: Record<string, unknown> = {}) => {
    const result = v2File(overrides)
    if (result.ok) throw new Error('预期解析失败')
    return result.issues
  }

  it('accepts custom service vars, secretOrigins and multi-service probes', () => {
    const result = v2File({
      secretOrigins: ['http://127.0.0.1:18081', 'http://127.0.0.1:8081'],
      recipe: {
        ...base.recipe,
        probes: [
          { var: 'API_BASE_URL', path: '/api/v1/health', expectStatus: [200] },
          { var: 'DETECTOR_MGMT_URL', path: '/ready', expectStatus: [200] },
          { var: 'DATA_PLANE_URL', path: '/', expectStatus: [200, 404] },
        ],
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(2)
    expect(result.file.vars.DETECTOR_MGMT_URL).toBe('http://127.0.0.1:18081')
    expect(result.file.secretOrigins).toEqual(['http://127.0.0.1:18081', 'http://127.0.0.1:8081'])
    expect(result.file.recipe?.probes).toHaveLength(3)
    expect(result.file.recipe?.probes?.[1]).toMatchObject({ var: 'DETECTOR_MGMT_URL', path: '/ready' })
  })

  it('maps custom vars and origins into the record draft (reserved names stay in their columns)', () => {
    const result = v2File({ secretOrigins: ['http://127.0.0.1:18081'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const draft = environmentRecordDraftFromFile(result.file)
    expect(draft.webBaseUrl).toBe('http://127.0.0.1:5173')
    expect(draft.apiBaseUrl).toBe('http://127.0.0.1:8090')
    expect(JSON.parse(draft.extraVarsJson ?? '{}')).toEqual({
      DATA_PLANE_URL: 'http://127.0.0.1:8081',
      DETECTOR_MGMT_URL: 'http://127.0.0.1:18081',
    })
    expect(JSON.parse(draft.secretOriginsJson ?? '[]')).toEqual(['http://127.0.0.1:18081'])
  })

  it('rejects probes pointing at undeclared vars and mixed probe/probes', () => {
    expect(v2Issues({
      recipe: { ...base.recipe, probes: [{ var: 'MISSING_URL', path: '/ready' }] },
    })).toContainEqual({
      path: '$.recipe.probes[0].var',
      message: '探针指向的变量「MISSING_URL」未在 vars 中声明',
    })
    expect(v2Issues({
      recipe: { ...base.recipe, probe: { path: '/' }, probes: [{ var: 'API_BASE_URL', path: '/ready' }] },
    })).toContainEqual({
      path: '$.recipe',
      message: 'probe 与 probes 互斥：多服务形态请只用 probes',
    })
    expect(v2Issues({
      recipe: {
        ...base.recipe,
        probes: [
          { var: 'API_BASE_URL', path: '/ready' },
          { var: 'API_BASE_URL', path: '/healthz' },
        ],
      },
    })).toContainEqual({
      path: '$.recipe.probes[1].var',
      message: '服务「API_BASE_URL」已有探针，不要重复声明',
    })
  })

  it('rejects secretOrigins without an origin shape and in v1 files', () => {
    expect(v2Issues({ secretOrigins: ['http://127.0.0.1:18081/api'] })).toEqual([
      { path: '$.secretOrigins[0]', message: 'Secret 目标必须是 origin（http(s)://host[:port]），不能带路径、查询或凭据' },
    ])
    expect(v2Issues({ secretOrigins: ['http://user:pass@127.0.0.1:18081'] })).toEqual([
      { path: '$.secretOrigins[0]', message: 'Secret 目标必须是 origin（http(s)://host[:port]），不能带路径、查询或凭据' },
    ])
    expect(issuesOf({ secretOrigins: ['http://127.0.0.1:18081'] })).toEqual([
      { path: '$.secretOrigins', message: 'secretOrigins 是 v2 增量；请把 version 升到 2' },
    ])
  })

  it('rejects multi-service probes in v1 files', () => {
    expect(issuesOf({
      recipe: { ...base.recipe, probes: [{ var: 'API_BASE_URL', path: '/ready' }] },
    })).toContainEqual({
      path: '$.recipe.probes',
      message: '多服务探针是 v2 增量；请把 version 升到 2',
    })
  })

  it('lets a remote file declare only a readiness probe', () => {
    const result = parse({
      mode: 'remote',
      recipe: { probe: { method: 'GET', path: '/ready', expectStatus: [200] } },
      vars: { API_BASE_URL: 'https://staging.test' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.recipe?.probe).toEqual({ method: 'GET', path: '/ready', expectStatus: [200] })
    expect(result.file.recipe?.readiness).toEqual([])
  })
})

describe('parseEnvironmentFile v3（快捷基址 / 证书策略 / 审批档）', () => {
  const v3Base = {
    kind: ENVIRONMENT_FILE_KIND,
    version: 3,
    id: 'beacon-remote',
    name: 'Beacon 远程环境',
    mode: 'remote',
    headers: {},
    secretNames: [],
  }

  const v3 = (overrides: Record<string, unknown> = {}) =>
    parseEnvironmentFile(JSON.stringify({ ...v3Base, ...overrides }))

  const v3Issues = (overrides: Record<string, unknown> = {}) => {
    const result = v3(overrides)
    if (result.ok) throw new Error('预期解析失败')
    return result.issues
  }

  it('derives WEB/API base URLs from a single baseUrl', () => {
    const result = v3({ baseUrl: 'https://10.9.35.5:1443' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.vars).toEqual({
      WEB_BASE_URL: 'https://10.9.35.5:1443',
      API_BASE_URL: 'https://10.9.35.5:1443',
    })
    expect(result.file.baseUrl).toBe('https://10.9.35.5:1443')
  })

  it('lets explicit vars win over the derived base URL', () => {
    const result = v3({
      baseUrl: 'https://10.9.35.5:1443',
      vars: { API_BASE_URL: 'https://10.9.35.5:1443/api' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.vars).toEqual({
      WEB_BASE_URL: 'https://10.9.35.5:1443',
      API_BASE_URL: 'https://10.9.35.5:1443/api',
    })
  })

  it('derives private-network access from the declared address', () => {
    const privateResult = v3({ baseUrl: 'https://10.9.35.5:1443' })
    expect(privateResult.ok).toBe(true)
    if (privateResult.ok) expect(privateResult.file.allowPrivateNetwork).toBe(true)

    const publicResult = v3({ baseUrl: 'https://staging.example.com' })
    expect(publicResult.ok).toBe(true)
    if (publicResult.ok) expect(publicResult.file.allowPrivateNetwork).toBe(false)
  })

  it('keeps an explicit allowPrivateNetwork over the derived value', () => {
    const result = v3({ baseUrl: 'https://10.9.35.5:1443', allowPrivateNetwork: false })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.file.allowPrivateNetwork).toBe(false)
  })

  it('keeps the legacy default for v1/v2 files', () => {
    const result = parseEnvironmentFile(JSON.stringify({
      ...base,
      mode: 'remote',
      recipe: undefined,
      vars: { API_BASE_URL: 'http://127.0.0.1:8080' },
    }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.file.allowPrivateNetwork).toBe(false)
  })

  it('allows skipping certificate verification only for private targets', () => {
    const privateResult = v3({ baseUrl: 'https://10.9.35.5:1443', tlsTrust: 'insecure' })
    expect(privateResult.ok).toBe(true)
    if (privateResult.ok) expect(privateResult.file.tlsTrust).toBe('insecure')

    expect(v3Issues({ baseUrl: 'https://staging.example.com', tlsTrust: 'insecure' })).toEqual([
      { path: '$.tlsTrust', message: '关闭证书校验只允许用于回环或私网地址' },
    ])
    expect(v3Issues({ tlsTrust: 'whatever' })).toEqual([
      { path: '$.tlsTrust', message: '只允许 system 或 insecure' },
    ])
  })

  it('allows the trusted approval mode only for remote environments', () => {
    const remoteResult = v3({ baseUrl: 'https://10.9.35.5:1443', approvalMode: 'trusted' })
    expect(remoteResult.ok).toBe(true)
    if (remoteResult.ok) expect(remoteResult.file.approvalMode).toBe('trusted')

    expect(v3Issues({
      baseUrl: 'https://10.9.35.5:1443',
      approvalMode: 'trusted',
      mode: 'local',
      recipe: base.recipe,
    })).toContainEqual({
      path: '$.approvalMode',
      message: '本地档不支持受信（免逐次审批）模式',
    })
  })

  it('rejects v3 fields in older files and forwards them to the record draft', () => {
    expect(issuesOf({ baseUrl: 'https://10.9.35.5:1443' })).toEqual([
      { path: '$.baseUrl', message: 'baseUrl 是 v3 增量；请把 version 升到 3' },
    ])
    const result = v3({ baseUrl: 'https://10.9.35.5:1443', tlsTrust: 'insecure', approvalMode: 'trusted' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(environmentRecordDraftFromFile(result.file)).toMatchObject({
      webBaseUrl: 'https://10.9.35.5:1443',
      apiBaseUrl: 'https://10.9.35.5:1443',
      allowPrivateNetwork: true,
      tlsTrust: 'insecure',
      approvalMode: 'trusted',
    })
  })
})
