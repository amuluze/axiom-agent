import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, AgentToolExecutionContext, ArtifactReference } from '@/agent/core/types'
import type { BrowserCommandRequest, BrowserCommandResponse } from '@/agent/environment/AgentEnvironment'
import { SUBAGENT_READONLY_TOOL_NAMES } from '@/agent/subagent/readonlyTools'
import { createScopedReadEnvironment } from '@/agent/subagent/scopedReadEnvironment'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createUiAssertTool } from './uiAssertTool'
import { createUiFindTool } from './uiFindTool'
import { createUiScreenshotTool } from './uiScreenshotTool'
import { createUiSnapshotTool } from './uiSnapshotTool'
import { createUiWaitTool } from './uiWaitTool'

const context = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'call-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

const ACTIVE_TAB: BrowserCommandResponse = {
  type: 'tabs',
  tabs: [{
    tabId: 'tab-1',
    url: 'https://shop.test/cart',
    title: '购物车',
    active: true,
    hasDialog: false,
  }],
}

/** 记录请求的浏览器通道桩：未声明的动作直接抛错，避免测试静默依赖未断言的行为。 */
const hostWith = (
  routes: Partial<Record<BrowserCommandRequest['action'], BrowserCommandResponse>>,
) => {
  const requests: BrowserCommandRequest[] = []
  const host = createFakeAgentEnvironment()
  host.browser.command = vi.fn(async (request: BrowserCommandRequest): Promise<BrowserCommandResponse> => {
    requests.push(request)
    const response = routes[request.action]
    if (!response) throw new Error(`unexpected browser action: ${request.action}`)
    return response
  })
  return { host, requests }
}

const imageArtifact = (): ArtifactReference => ({
  id: 'artifact-image',
  kind: 'image',
  mediaType: 'image/png',
  relativePath: 'artifacts/ui/shot.png',
  contentHash: 'd'.repeat(64),
  sizeBytes: 1234,
  createdAt: 0,
})

describe('幂等键长度', () => {
  const tools: AgentTool[] = [
    createUiSnapshotTool(createFakeAgentEnvironment()),
    createUiFindTool(createFakeAgentEnvironment()),
    createUiWaitTool(createFakeAgentEnvironment()),
    createUiAssertTool(createFakeAgentEnvironment()),
    createUiScreenshotTool(createFakeAgentEnvironment()),
  ]

  it('在 512 bytes 上限内（超长文本/定位器不会让工具调用直接失败）', async () => {
    // Runtime 在 idempotencyKey > 512 bytes 时把调用判为 error（见 toolExecution.ts）：
    // 五个只读工具的键都必须压缩内容，而不是把文本/定位器明文拼进去。
    const longTab = 't'.repeat(200)
    const longText = '优'.repeat(500)
    const cases: Array<Record<string, unknown>> = [
      { tabId: longTab, maxBytes: 65_536 },
      { tabId: longTab, text: longText, limit: 50 },
      { tabId: longTab, text: longText, durationMs: 15_000 },
      { tabId: longTab, locator: { css: `.${'a'.repeat(400)}` }, expect: { valueEquals: longText } },
      { tabId: longTab, ref: 999 },
    ]
    for (const [index, input] of cases.entries()) {
      const key = await tools[index]!.idempotencyKey?.(input as never)
      expect(key).toBeTruthy()
      const bytes = new TextEncoder().encode(key!).length
      expect(bytes, `${tools[index]!.name} 幂等键 ${bytes} bytes`).toBeLessThanOrEqual(512)
    }
  })
})

describe('ui_snapshot', () => {
  it('省略 tabId 时先解析活动标签页，并把快照事实映射为可读结果', async () => {
    const { host, requests } = hostWith({
      tabs: ACTIVE_TAB,
      snapshot: {
        type: 'snapshot',
        url: 'https://shop.test/cart',
        title: '购物车',
        text: '- button "去支付"\n- text "应付金额 ¥240.00"',
        truncated: false,
        dialog: { kind: 'alert', message: '库存不足' },
      },
    })
    const result = await createUiSnapshotTool(host).execute({}, context())
    expect(requests[0]).toEqual({ action: 'tabs' })
    expect(requests[1]).toEqual({ action: 'snapshot', tabId: 'tab-1' })
    expect(result.content).toContain('浏览器快照 · 购物车')
    expect(result.content).toContain('应付金额 ¥240.00')
    expect(result.content).toContain('页面弹窗：alert「库存不足」')
    expect(result.details).toMatchObject({
      tabId: 'tab-1',
      url: 'https://shop.test/cart',
      truncated: false,
      axTreeTruncated: false,
      inlineTruncated: false,
    })
  })

  it('显式 tabId 不解析标签页，超预算时明确截断', async () => {
    const { host, requests } = hostWith({
      snapshot: {
        type: 'snapshot',
        url: 'https://shop.test/cart',
        title: '购物车',
        text: 'x'.repeat(4096),
        truncated: true,
      },
    })
    const result = await createUiSnapshotTool(host).execute({ tabId: 'tab-9', maxBytes: 1024 }, context())
    expect(requests).toEqual([{ action: 'snapshot', tabId: 'tab-9' }])
    expect(result.content).toContain('快照已按 1024 字节预算截断')
    expect(result.details).toMatchObject({ truncated: true, axTreeTruncated: true, inlineTruncated: true })
  })

  it('校验参数形状与预算范围', () => {
    const tool = createUiSnapshotTool(createFakeAgentEnvironment())
    expect(tool.validate({}).ok).toBe(true)
    expect(tool.validate({ tabId: '   ' }).ok).toBe(false)
    expect(tool.validate({ maxBytes: 1024 }).ok).toBe(true)
    expect(tool.validate({ maxBytes: 512 }).ok).toBe(false)
    expect(tool.validate({ maxBytes: 65_537 }).ok).toBe(false)
    expect(tool.validate({ tabId: 'tab-1', zoom: 2 }).ok).toBe(false)
  })

  it('无活动标签页时返回可读错误，而不是猜一个', async () => {
    const { host } = hostWith({
      tabs: {
        type: 'tabs',
        tabs: [{ tabId: 'tab-2', url: 'https://shop.test/', title: '首页', active: false, hasDialog: false }],
      },
    })
    await expect(createUiSnapshotTool(host).execute({}, context()))
      .rejects.toThrow('当前没有活动的浏览器标签页')
  })

  it('宿主返回非快照响应时以错误收口', async () => {
    const { host } = hostWith({ snapshot: { type: 'done' } })
    await expect(createUiSnapshotTool(host).execute({ tabId: 'tab-1' }, context()))
      .rejects.toThrow('浏览器返回了非快照结果：done')
  })
})

describe('ui_find', () => {
  it('转发检索词与 limit，并报告命中总数与未列出数量', async () => {
    const { host, requests } = hostWith({
      find: {
        type: 'found',
        url: 'https://shop.test/cart',
        title: '购物车',
        matches: ['- text "应付金额 ¥240.00"'],
        total: 3,
        truncated: true,
      },
    })
    const result = await createUiFindTool(host).execute({ tabId: 'tab-1', text: '¥240', limit: 1 }, context())
    expect(requests).toEqual([{ action: 'find', tabId: 'tab-1', text: '¥240', limit: 1 }])
    expect(result.content).toContain('命中 3 行（列出前 1 行）')
    expect(result.content).toContain('另有 2 行未列出')
    expect(result.details).toMatchObject({ total: 3, listed: 1, truncated: true })
  })

  it('省略 limit 时不传该字段（由宿主用默认值）', async () => {
    const { host, requests } = hostWith({
      tabs: ACTIVE_TAB,
      find: { type: 'found', url: 'https://shop.test/', title: '首页', matches: [], total: 0, truncated: false },
    })
    const result = await createUiFindTool(host).execute({ text: '不存在的文案' }, context())
    expect(requests[0]).toEqual({ action: 'tabs' })
    expect(requests[1]).toEqual({ action: 'find', tabId: 'tab-1', text: '不存在的文案' })
    expect(result.content).toContain('命中 0 行')
  })

  it('校验检索词与 limit', () => {
    const tool = createUiFindTool(createFakeAgentEnvironment())
    expect(tool.validate({ text: '去支付' }).ok).toBe(true)
    expect(tool.validate({}).ok).toBe(false)
    expect(tool.validate({ text: '  ' }).ok).toBe(false)
    expect(tool.validate({ text: 'x', limit: 51 }).ok).toBe(false)
    expect(tool.validate({ text: 'x', limit: 0 }).ok).toBe(false)
  })
})

describe('ui_wait', () => {
  it('同时转发 text 与 durationMs，并如实报告文本命中结论', async () => {
    const { host, requests } = hostWith({ wait: { type: 'waited', textMatched: false, waitedMs: 1500 } })
    const result = await createUiWaitTool(host).execute({ tabId: 'tab-1', text: '下单成功', durationMs: 1500 }, context())
    expect(requests).toEqual([{ action: 'wait', tabId: 'tab-1', text: '下单成功', durationMs: 1500 }])
    expect(result.content).toContain('实际耗时 1500 ms')
    expect(result.content).toContain('在等待窗口内未出现（不代表之后不会出现）')
    expect(result.details).toMatchObject({ textMatched: false, waitedMs: 1500 })
  })

  it('只给 durationMs 时不宣称等待过文本', async () => {
    const { host, requests } = hostWith({ wait: { type: 'waited', textMatched: false, waitedMs: 200 } })
    const result = await createUiWaitTool(host).execute({ tabId: 'tab-1', durationMs: 200 }, context())
    expect(requests[0]).toEqual({ action: 'wait', tabId: 'tab-1', durationMs: 200 })
    expect(result.content).toContain('未要求等待文本')
  })

  it('至少需要 text 或 durationMs，且 durationMs 不超过宿主上限', () => {
    const tool = createUiWaitTool(createFakeAgentEnvironment())
    expect(tool.validate({ tabId: 'tab-1' }).ok).toBe(false)
    expect(tool.validate({ text: '稳定' }).ok).toBe(true)
    expect(tool.validate({ durationMs: 15_000 }).ok).toBe(true)
    expect(tool.validate({ durationMs: 15_001 }).ok).toBe(false)
  })
})

const resolutionUnique = { status: 'unique' as const, candidate: { ref: 7, role: 'button', name: '去支付', value: undefined, disabled: false } }

describe('ui_assert', () => {
  const run = async (
    input: Parameters<AgentTool['execute']>[0],
    routes: Partial<Record<BrowserCommandRequest['action'], BrowserCommandResponse>>,
  ) => {
    const { host, requests } = hostWith(routes)
    const tool = createUiAssertTool(host)
    return { result: await tool.execute(input, context()), requests, tool }
  }

  it('exists 用定位结果判定，不成立时返回 verdict=failed 而不是错误', async () => {
    const { result } = await run(
      { tabId: 'tab-1', locator: { testId: 'payable' }, expect: { exists: false } },
      { resolveLocator: { type: 'locatorResolved', resolution: resolutionUnique } },
    )
    expect(result.content).toContain('ui_assert 判定：不通过')
    expect(result.content).toContain('期望：exists=false')
    expect(result.content).toContain('实际：匹配到元素')
    expect(result.details).toMatchObject({ assertion: 'exists', expected: false, verdict: 'failed' })
  })

  it('count 计入歧义候选总数', async () => {
    const { result } = await run(
      { tabId: 'tab-1', locator: { role: 'row' }, expect: { count: 3 } },
      {
        resolveLocator: {
          type: 'locatorResolved',
          resolution: { status: 'ambiguous', total: 3, candidates: [] },
        },
      },
    )
    expect(result.content).toContain('期望：count=3')
    expect(result.content).toContain('实际：匹配数 3')
    expect(result.content).toContain('ui_assert 判定：通过')
  })

  it('enabled 与 valueEquals 用唯一命中的 AX 事实判定', async () => {
    const disabled = await run(
      { tabId: 'tab-1', locator: { testId: 'submit' }, expect: { enabled: false } },
      {
        resolveLocator: {
          type: 'locatorResolved',
          resolution: { status: 'unique', candidate: { ref: 3, role: 'button', name: '提交', value: undefined, disabled: true } },
        },
      },
    )
    expect(disabled.result.content).toContain('宿主报告的 enabled=false')
    expect(disabled.result.details).toMatchObject({ verdict: 'passed' })

    const value = await run(
      { tabId: 'tab-1', locator: { role: 'textbox', name: '优惠券' }, expect: { valueEquals: 'SHOPAIM10' } },
      {
        resolveLocator: {
          type: 'locatorResolved',
          resolution: { status: 'unique', candidate: { ref: 4, role: 'textbox', name: '优惠券', value: 'shopaim10', disabled: false } },
        },
      },
    )
    expect(value.result.content).toContain('ui_assert 判定：不通过')
    expect(value.result.content).toContain('AX value「shopaim10」')
  })

  it('nameContains 折叠空白后比较可访问名', async () => {
    const { result } = await run(
      { tabId: 'tab-1', locator: { role: 'button' }, expect: { nameContains: '去 支付' } },
      {
        resolveLocator: {
          type: 'locatorResolved',
          resolution: { status: 'unique', candidate: { ref: 7, role: 'button', name: '去\n支付', value: undefined, disabled: false } },
        },
      },
    )
    expect(result.content).toContain('ui_assert 判定：通过')
    expect(result.content).toContain('可访问名「去\n支付」')
  })

  it('pageTextContains 走页面检索、urlContains 走标签页 URL，都不需要定位器', async () => {
    const page = await run(
      { tabId: 'tab-1', expect: { pageTextContains: '¥240.00' } },
      {
        find: { type: 'found', url: 'https://shop.test/cart', title: '购物车', matches: ['- text "¥240.00"'], total: 2, truncated: true },
      },
    )
    expect(page.requests).toEqual([{ action: 'find', tabId: 'tab-1', text: '¥240.00', limit: 1 }])
    expect(page.result.content).toContain('页面可访问性文本有 2 行包含该串')

    const url = await run(
      { tabId: 'tab-1', expect: { urlContains: '/cart' } },
      { tabs: ACTIVE_TAB },
    )
    expect(url.result.content).toContain('当前 URL：https://shop.test/cart')
    expect(url.result.details).toMatchObject({ verdict: 'passed' })
  })

  it('零匹配与歧义属于无法判定（错误），不是断言不成立', async () => {
    await expect(run(
      { tabId: 'tab-1', locator: { testId: 'payable' }, expect: { enabled: true } },
      { resolveLocator: { type: 'locatorResolved', resolution: { status: 'notFound' } } },
    )).rejects.toThrow('零匹配')

    await expect(run(
      { tabId: 'tab-1', locator: { role: 'button' }, expect: { exists: true } },
      {
        resolveLocator: {
          type: 'locatorResolved',
          resolution: { status: 'ambiguous', total: 2, candidates: [] },
        },
      },
    )).rejects.toThrow('无法判定存在性')
  })

  it('元素级断言要求 locator，页面级断言拒绝 locator', () => {
    const tool = createUiAssertTool(createFakeAgentEnvironment())
    expect(tool.validate({ locator: { testId: 'x' }, expect: { exists: true } }).ok).toBe(true)
    expect(tool.validate({ expect: { exists: true } }).ok).toBe(false)
    expect(tool.validate({ locator: {}, expect: { exists: true } }).ok).toBe(false)
    expect(tool.validate({ expect: { urlContains: '/cart' } }).ok).toBe(true)
    const rejected = tool.validate({ locator: { testId: 'x' }, expect: { urlContains: '/cart' } })
    expect(rejected.ok).toBe(false)
    expect(rejected.ok === false && rejected.error).toContain('take no locator')
  })

  it('expect 只接受单键且值型正确', () => {
    const tool = createUiAssertTool(createFakeAgentEnvironment())
    expect(tool.validate({ locator: { testId: 'x' }, expect: { exists: true, enabled: true } }).ok).toBe(false)
    expect(tool.validate({ locator: { testId: 'x' }, expect: { exists: 'yes' } }).ok).toBe(false)
    expect(tool.validate({ locator: { testId: 'x' }, expect: { count: -1 } }).ok).toBe(false)
    expect(tool.validate({ locator: { testId: 'x' }, expect: { count: 1.5 } }).ok).toBe(false)
    expect(tool.validate({ locator: { testId: 'x' }, expect: { nameContains: '' } }).ok).toBe(false)
    expect(tool.validate({ expect: {} }).ok).toBe(false)
  })
})

describe('ui_screenshot', () => {
  const shot: BrowserCommandResponse = {
    type: 'screenshot',
    imageBase64: 'iVBORw0KGgo=',
    mimeType: 'image/png',
    width: 800,
    height: 600,
    resized: true,
  }

  it('图片写入 Artifact 并回灌图像块，文本只给摘要与引用', async () => {
    const { host, requests } = hostWith({ screenshot: shot })
    host.artifacts.writeImage = vi.fn(async () => imageArtifact())
    const result = await createUiScreenshotTool(host).execute({ tabId: 'tab-1', ref: 7 }, context())
    expect(requests).toEqual([{ action: 'screenshot', tabId: 'tab-1', ref: 7 }])
    expect(host.artifacts.writeImage).toHaveBeenCalledWith({ contentBase64: 'iVBORw0KGgo=', mediaType: 'image/png' })
    expect(result.content).toContain('尺寸：800×600（已由宿主下采样到上限内）')
    expect(result.content).toContain('artifacts/ui/shot.png')
    expect(result.content).not.toContain('iVBORw0KGgo=')
    expect(result.contentBlocks).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
    ])
    expect(result.artifact).toMatchObject({ id: 'artifact-image', kind: 'image' })
    expect(result.details).toMatchObject({ imageDelivered: true, resized: true })
  })

  it('模型不支持图片时降级为文字说明（不产图像块，仍留 Artifact 引用）', async () => {
    const { host } = hostWith({ screenshot: shot })
    host.artifacts.writeImage = vi.fn(async () => imageArtifact())
    const result = await createUiScreenshotTool(host)
      .execute({ tabId: 'tab-1' }, context({ modelAcceptsImage: false }))
    expect(result.contentBlocks).toBeUndefined()
    expect(result.content).toContain('[图片已省略：当前模型不支持图片输入]')
    expect(result.content).toContain('截图本身已成功')
    expect(result.content).toContain('当前模型不接受图片输入')
    expect(result.details).toMatchObject({ imageDelivered: false })
    expect(result.artifact).toMatchObject({ id: 'artifact-image' })
  })

  it('Artifact 写入失败不假装成功：如实报告并保留图像块', async () => {
    const { host } = hostWith({ screenshot: shot })
    host.artifacts.writeImage = vi.fn(async () => { throw new Error('磁盘已满') })
    const result = await createUiScreenshotTool(host).execute({ tabId: 'tab-1' }, context())
    expect(result.artifact).toBeUndefined()
    expect(result.content).toContain('截图未能写入 Artifact')
    expect(result.content).toContain('磁盘已满')
    expect(result.details).toMatchObject({ artifactError: expect.stringContaining('截图未能写入 Artifact') })
    expect(result.contentBlocks).toHaveLength(1)
  })

  it('校验 ref 为非负整数', () => {
    const tool = createUiScreenshotTool(createFakeAgentEnvironment())
    expect(tool.validate({}).ok).toBe(true)
    expect(tool.validate({ ref: 1 }).ok).toBe(true)
    expect(tool.validate({ ref: 0 }).ok).toBe(false)
    expect(tool.validate({ ref: 1.5 }).ok).toBe(false)
  })
})

describe('UI 探索工具的子代理隔离', () => {
  const UI_TOOL_NAMES = ['ui_snapshot', 'ui_find', 'ui_screenshot', 'ui_wait', 'ui_assert']

  it('子代理只读工厂表不含任何 ui_* 工具', () => {
    for (const name of UI_TOOL_NAMES) {
      expect(SUBAGENT_READONLY_TOOL_NAMES).not.toContain(name)
    }
  })

  it('子会话环境结构性不可达浏览器通道与图片 Artifact 写入', async () => {
    const scoped = createScopedReadEnvironment(createFakeAgentEnvironment(), [], {
      allowedToolNames: [...SUBAGENT_READONLY_TOOL_NAMES],
      signal: new AbortController().signal,
    })
    await expect(scoped.browser.command({ action: 'tabs' }))
      .rejects.toMatchObject({ code: 'not_authorized' })
    await expect(scoped.artifacts.writeImage({ contentBase64: 'AAAA', mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'not_authorized' })
  })
})

describe('ui 工具幂等键', () => {
  it('把影响结果的输入编进 key，形状稳定且内容有界', async () => {
    const host = createFakeAgentEnvironment()
    // 只读快照/截图：键只含短标识，可读且直接断言形状。
    expect(await createUiSnapshotTool(host).idempotencyKey?.({ tabId: 'tab-1', maxBytes: 2048 }))
      .toBe('ui_snapshot:tab-1:2048')
    expect(await createUiScreenshotTool(host).idempotencyKey?.({ tabId: 'tab-1', ref: 7 }))
      .toBe('ui_screenshot:tab-1:7')
    // 含文本/定位器的键：内容以 sha256 摘要编码（明文会顶穿 runtime 的 512 bytes
    // 上限把调用判为 error），故只断言前缀、确定性与区分度，不钉具体摘要值。
    const findA = await createUiFindTool(host).idempotencyKey?.({ text: '去支付' })
    const findB = await createUiFindTool(host).idempotencyKey?.({ text: '去支付' })
    const findC = await createUiFindTool(host).idempotencyKey?.({ text: '去支付', limit: 5 })
    expect(findA).toMatch(/^ui_find::[0-9a-f]{64}:$/)
    expect(findB).toBe(findA)
    expect(findC).not.toBe(findA)
    expect(await createUiWaitTool(host).idempotencyKey?.({ text: '稳定', durationMs: 500 }))
      .toMatch(/^ui_wait::[0-9a-f]{64}:500$/)
    expect(await createUiAssertTool(host).idempotencyKey?.({
      tabId: 'tab-1',
      locator: { testId: 'payable' },
      expect: { exists: true },
    })).toMatch(/^ui_assert:tab-1:[0-9a-f]{64}$/)
  })
})
