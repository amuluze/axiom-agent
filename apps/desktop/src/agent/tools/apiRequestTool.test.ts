import { describe, expect, it, vi } from 'vitest'
import type { AgentToolExecutionContext, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment, ApiTestStepResult } from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { MAX_API_REQUEST_BODY_BYTES, MAX_API_TIMEOUT_MS, createApiRequestTool } from './apiRequestTool'

/** H1-5 发布档默认取生产档（放行外部目标）；要验证开发档门时显式传 `externalTargets: false`。 */
const createTool = (
  environment: AgentEnvironment = createFakeAgentEnvironment(),
  externalTargets = true,
) => createApiRequestTool(environment, { externalTargets, agentGeneration: true })

const context = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'call-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

const received = (overrides: Partial<ApiTestStepResult> = {}): ApiTestStepResult => ({
  verdict: 'passed',
  runnerVerdict: 'passed',
  transport: 'received',
  message: 'HTTP 200 · 18 ms',
  evidenceContentHash: 'a'.repeat(64),
  statusCode: 200,
  elapsedMs: 18,
  extracted: {},
  ...overrides,
})

/** 记录请求的宿主桩：默认返回一次 200，断言只看工具层怎么组包/映射。 */
const hostWith = (result: ApiTestStepResult = received()) => {
  const host = createFakeAgentEnvironment()
  host.api.runStep = vi.fn(async () => result)
  return host
}

describe('api_request 参数校验', () => {
  const tool = createTool(createFakeAgentEnvironment())
  const invalid: Array<[string, JsonValue]> = [
    ['未知字段', { method: 'GET', url: 'https://api.example.test/v1', tabId: 'x' }],
    ['缺少 url', { method: 'GET' }],
    ['非法 method', { method: 'TRACE', url: 'https://api.example.test/v1' }],
    ['非 http(s) 协议', { method: 'GET', url: 'file:///etc/passwd' }],
    ['内嵌凭据', { method: 'GET', url: 'https://user:pass@api.example.test/v1' }],
    ['带 fragment', { method: 'GET', url: 'https://api.example.test/v1#frag' }],
    ['相对 URL', { method: 'GET', url: '/v1/orders' }],
    ['query 非标量', { method: 'GET', url: 'https://api.example.test/v1', query: { ids: [1, 2] } }],
    ['header 名非法', { method: 'GET', url: 'https://api.example.test/v1', headers: { 'bad name': 'x' } }],
    ['宿主保留 header', { method: 'GET', url: 'https://api.example.test/v1', headers: { Host: 'evil.test' } }],
    ['敏感 header 明文', { method: 'GET', url: 'https://api.example.test/v1', headers: { Authorization: 'Bearer x' } }],
    ['secret 引用缺 id', { method: 'GET', url: 'https://api.example.test/v1', headers: { Authorization: {} } }],
    ['GET 带 body', { method: 'GET', url: 'https://api.example.test/v1', body: { a: 1 } }],
    ['text bodyMode 非字符串', { method: 'POST', url: 'https://api.example.test/v1', bodyMode: 'text', body: { a: 1 } }],
    ['form bodyMode 非对象', { method: 'POST', url: 'https://api.example.test/v1', bodyMode: 'form', body: 'a=1' }],
    ['bodyMode 非法', { method: 'POST', url: 'https://api.example.test/v1', body: 'x', bodyMode: 'yaml' }],
    ['redirect 非法', { method: 'GET', url: 'https://api.example.test/v1', redirect: 'follow' }],
    ['timeoutMs 越界', { method: 'GET', url: 'https://api.example.test/v1', timeoutMs: MAX_API_TIMEOUT_MS + 1 }],
    ['timeoutMs 非整数', { method: 'GET', url: 'https://api.example.test/v1', timeoutMs: 1.5 }],
    ['environmentId 空', { method: 'GET', url: 'https://api.example.test/v1', environmentId: ' ' }],
    ['body 超上限', {
      method: 'POST',
      url: 'https://api.example.test/v1',
      body: 'x'.repeat(MAX_API_REQUEST_BODY_BYTES + 1),
    }],
  ]

  it.each(invalid)('拒绝 %s', (_label, input) => {
    const result = tool.validate(input)
    expect(result.ok).toBe(false)
  })

  it('method 大小写归一化为大写并保留其它字段', () => {
    const result = tool.validate({ method: 'post', url: 'https://api.example.test/v1', timeoutMs: 5000 })
    expect(result).toMatchObject({ ok: true, value: { method: 'POST', timeoutMs: 5000 } })
  })

  it('接受 Secret 引用、标量 query 与合法 redirect/bodyMode', () => {
    const result = tool.validate({
      method: 'POST',
      url: 'https://api.example.test/v1/orders',
      query: { page: 2, active: true, note: null },
      headers: { Authorization: { secretId: 'apitest.orders-token' }, 'X-Trace': 'abc' },
      bodyMode: 'json',
      redirect: 'same-origin',
      environmentId: 'staging',
      body: { sku: 'a-1' },
    })
    expect(result.ok).toBe(true)
  })
})

describe('api_request 发布档目标门（H1-5 feature flag）', () => {
  const development = createTool(createFakeAgentEnvironment(), false)
  const production = createTool(createFakeAgentEnvironment(), true)

  it.each([
    ['localhost', 'http://localhost:8080/health'],
    ['localhost 子域', 'https://app.localhost/api'],
    ['.local（mDNS）', 'https://fixture.local/api/orders'],
    ['IPv4 回环', 'http://127.0.0.1:8080/health'],
    ['IPv4 回环网段内其它地址', 'http://127.9.8.7/v1'],
    ['IPv6 回环', 'http://[::1]:8080/health'],
    ['回环上的 HTTPS', 'https://127.0.0.1:8443/v1'],
  ])('开发档放行本地目标（%s）', (_label, url) => {
    expect(development.validate({ method: 'GET', url })).toMatchObject({ ok: true })
  })

  it.each([
    ['公网 HTTPS', 'https://api.example.test/v1/orders'],
    ['公网明文 HTTP', 'http://api.example.test/v1'],
    ['私网字面量（RFC1918 由宿主策略判定）', 'http://192.168.1.10:8080/v1'],
    ['未指定地址', 'https://0.0.0.0:8080/v1'],
    ['IPv4-mapped 折算形式', 'http://[::ffff:127.0.0.1]:8080/v1'],
    ['把 localhost 当前缀的子域伪装', 'https://localhost.evil.test/v1'],
  ])('开发档拒绝非本地目标（%s）', (_label, url) => {
    const result = development.validate({ method: 'GET', url })
    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain('只允许访问本地回环目标')
    expect(error).toContain('内测档')
    expect(error).toContain('不要改用 IP 直连、代理绕过')
  })

  it('生产档放行公网 HTTPS，本地目标不受影响（与历史行为一致）', () => {
    expect(production.validate({ method: 'GET', url: 'https://api.example.test/v1' }))
      .toMatchObject({ ok: true })
    expect(production.validate({ method: 'POST', url: 'http://127.0.0.1:8080/v1', body: { a: 1 } }))
      .toMatchObject({ ok: true })
  })

  it('工具门不镜像「公网明文 HTTP 恒拒」：那份判定属宿主（DNS 后才成立）', () => {
    // 生产档里 http:// 公网目标由 Rust 在解析地址后拒绝；工具层无法在无 DNS 的情况下
    // 区分「解析到公网」与「解析到已授权的私网」，复制该判定会误拒后者。
    expect(production.validate({ method: 'GET', url: 'http://api.example.test/v1' }))
      .toMatchObject({ ok: true })
    expect(development.validate({ method: 'GET', url: 'http://api.example.test/v1' }).ok).toBe(false)
  })
})

describe('api_request 审批展示', () => {
  const tool = createTool(createFakeAgentEnvironment())

  it('只展示 method/scheme/host/path 与参数数量，不泄漏 header 值与 body 明文', () => {
    const card = tool.approvalPresentation?.({
      method: 'POST',
      url: 'https://api.example.test/v1/orders?view=full',
      query: { page: 1 },
      headers: {
        Authorization: { secretId: 'apitest.orders-token' },
        'X-Debug': 'super-secret-value',
      },
      body: { password: 'hunter2' },
      environmentId: 'staging',
    })
    expect(card?.title).toBe('发送 POST /v1/orders？')
    expect(card?.description).toContain('https://api.example.test')
    expect(card?.description).toContain('api.example.test')
    expect(card?.description).toContain('1 个查询参数')
    expect(card?.description).toContain('2 个自定义请求头')
    expect(card?.description).toContain('apitest.* Secret 引用')
    expect(JSON.stringify(card)).not.toContain('super-secret-value')
    expect(JSON.stringify(card)).not.toContain('hunter2')
    expect(JSON.stringify(card)).not.toContain('apitest.orders-token')
  })
})

describe('api_request 执行', () => {
  it('按 Agent run 身份与规范化参数组 api.request 步骤', async () => {
    const host = hostWith()
    const tool = createTool(host)
    const result = await tool.execute({
      method: 'post',
      url: 'https://api.example.test/v1/orders',
      query: { page: 2 },
      headers: {
        Authorization: { secretId: 'apitest.orders-token' },
        'X-Trace': 'abc',
      },
      body: { sku: 'a-1' },
      bodyMode: 'json',
      timeoutMs: 5000,
      redirect: 'manual',
      environmentId: 'staging',
    }, context())

    expect(host.api.runStep).toHaveBeenCalledWith({
      runId: 'run-1',
      stepId: 'call-1',
      environmentId: 'staging',
      step: {
        id: 'call-1',
        action: 'api.request',
        method: 'POST',
        url: 'https://api.example.test/v1/orders',
        query: { page: 2 },
        headers: { Authorization: { secretId: 'apitest.orders-token' }, 'X-Trace': 'abc' },
        body: { sku: 'a-1' },
        bodyMode: 'json',
        timeoutMs: 5000,
        redirect: 'manual',
      },
    }, expect.anything())
    expect(result.content).toContain('POST https://api.example.test/v1/orders')
    expect(result.content).toContain('passed（宿主判定通过）')
    expect(result.content).toContain('状态码：200')
    expect(result.content).toContain('耗时：18 ms')
    expect(result.content).toContain('received（已收到响应）')
    expect(result.content).toContain(`sha256 ${'a'.repeat(64)}`)
    // 正文与 Secret 不回灌：结果里只有脱敏摘要与证据引用。
    expect(result.content).not.toContain('apitest.orders-token')
    expect(result.details).toMatchObject({
      verdict: 'passed',
      transport: 'received',
      statusCode: 200,
      elapsedMs: 18,
      environmentId: 'staging',
      extractedCount: 0,
    })
  })

  it('省略 environmentId 时按「无测试环境」执行并把范围写进摘要', async () => {
    const host = hostWith()
    const tool = createTool(host)
    const result = await tool.execute({
      method: 'GET',
      url: 'https://api.example.test/v1/orders',
    }, context())
    expect(host.api.runStep).toHaveBeenCalledWith({
      runId: 'run-1',
      stepId: 'call-1',
      step: { id: 'call-1', action: 'api.request', method: 'GET', url: 'https://api.example.test/v1/orders' },
    }, expect.anything())
    expect(result.content).toContain('无测试环境')
  })

  it('私网未授权：如实报策略拒绝并要求在测试环境里授权私网', async () => {
    const host = hostWith(received({
      verdict: 'not_evaluated',
      runnerVerdict: 'error',
      transport: 'blocked',
      statusCode: null,
      message: 'API 测试环境未授权访问回环或私网地址',
    }))
    const tool = createTool(host)
    const result = await tool.execute({
      method: 'GET',
      url: 'http://127.0.0.1:8080/health',
    }, context())

    expect(result.content).toContain('not_evaluated（未评估：没有可用于判定的响应）')
    expect(result.content).toContain('blocked（被宿主网络策略拒绝，请求未发出）')
    expect(result.content).toContain('不可绕过')
    expect(result.content).toContain('允许访问回环/私网 API')
    expect(result.content).toContain('不要改用 IP 直连、代理或其它地址绕过')
    // 未评估就不该出现证据引用（没有可引用的响应证据）。
    expect(result.content).not.toContain('证据：宿主脱敏后')
    expect(host.api.runStep).toHaveBeenCalledOnce()
  })

  it('已 abort 的信号不触达宿主', async () => {
    const host = hostWith()
    const tool = createTool(host)
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ method: 'GET', url: 'https://api.example.test/v1' },
      context({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(host.api.runStep).not.toHaveBeenCalled()
  })

  it('宿主返回 canceled 时按 Runtime 取消语义抛 AbortError', async () => {
    const host = hostWith(received({
      verdict: 'not_evaluated',
      runnerVerdict: 'canceled',
      transport: 'canceled',
      statusCode: null,
      message: '运行已停止',
    }))
    const tool = createTool(host)
    await expect(tool.execute({ method: 'GET', url: 'https://api.example.test/v1' }, context()))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('宿主抛错（如环境不存在）时原样向上抛，不伪造结果', async () => {
    const host = createFakeAgentEnvironment()
    host.api.runStep = vi.fn(async () => {
      throw new Error('API 测试环境不存在或不属于当前工作区')
    })
    const tool = createTool(host)
    await expect(tool.execute({
      method: 'GET',
      url: 'https://api.example.test/v1',
      environmentId: 'ghost',
    }, context())).rejects.toThrow('API 测试环境不存在或不属于当前工作区')
  })
})
