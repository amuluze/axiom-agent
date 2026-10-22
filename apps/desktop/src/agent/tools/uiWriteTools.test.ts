import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, AgentToolExecutionContext } from '@/agent/core/types'
import type {
  AgentEnvironment,
  BrowserReadCommandRequest,
  BrowserCommandResponse,
  BrowserWriteCommandRequest,
} from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createUiClickTool } from './uiClickTool'
import { createUiInputTool } from './uiInputTool'
import { createUiNavigateTool } from './uiNavigateTool'
import { createUiPressTool } from './uiPressTool'
import { createUiSelectTool } from './uiSelectTool'

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
  tabs: [{ tabId: 'tab-1', url: 'https://shop.test/cart', title: '购物车', active: true, hasDialog: false }],
}

/** 记录读写两条通道的桩：读通道按动作查表（tabs 恒定返回活动标签页），写通道按动作查表、未声明即抛。 */
const hostWith = (
  routes: Partial<Record<BrowserWriteCommandRequest['action'], BrowserCommandResponse>>,
  readRoutes: Partial<Record<BrowserReadCommandRequest['action'], BrowserCommandResponse>> = {},
) => {
  const reads: BrowserReadCommandRequest[] = []
  const writes: BrowserWriteCommandRequest[] = []
  const host: AgentEnvironment = createFakeAgentEnvironment()
  host.browser.command = vi.fn(async (request: BrowserReadCommandRequest): Promise<BrowserCommandResponse> => {
    reads.push(request)
    if (request.action === 'tabs') return ACTIVE_TAB
    const response = readRoutes[request.action]
    if (!response) throw new Error(`unexpected browser read action: ${request.action}`)
    return response
  })
  host.browser.write = vi.fn(async (request: BrowserWriteCommandRequest): Promise<BrowserCommandResponse> => {
    writes.push(request)
    const response = routes[request.action]
    if (!response) throw new Error(`unexpected browser write action: ${request.action}`)
    return response
  })
  return { host, reads, writes }
}

const DONE: BrowserCommandResponse = { type: 'done' }

const UNIQUE_RESOLUTION: BrowserCommandResponse = {
  type: 'locatorResolved',
  resolution: {
    status: 'unique',
    candidate: { ref: 42, role: 'button', name: '去支付', disabled: false },
  },
}

const NOT_FOUND_RESOLUTION: BrowserCommandResponse = {
  type: 'locatorResolved',
  resolution: { status: 'notFound' },
}

const AMBIGUOUS_RESOLUTION: BrowserCommandResponse = {
  type: 'locatorResolved',
  resolution: {
    status: 'ambiguous',
    total: 2,
    candidates: [
      { ref: 1, role: 'button', name: '提交', disabled: false },
      { ref: 2, role: 'button', name: '提交', disabled: false },
    ],
  },
}

const approvalOf = (tool: AgentTool, input: unknown) => {
  if (!tool.approvalPresentation) throw new Error(`${tool.name} 未声明 approvalPresentation`)
  return tool.approvalPresentation(input as never)
}

describe('ui 写探索工具的公共契约', () => {
  const tools: AgentTool[] = [
    createUiNavigateTool(createFakeAgentEnvironment()),
    createUiClickTool(createFakeAgentEnvironment()),
    createUiInputTool(createFakeAgentEnvironment()),
    createUiSelectTool(createFakeAgentEnvironment()),
    createUiPressTool(createFakeAgentEnvironment()),
  ]

  it('全部要求逐次审批、串行执行、幂等且带 idempotencyKey', () => {
    for (const tool of tools) {
      expect(tool.requiresApproval).toBe(true)
      expect(tool.executionMode).toBe('sequential')
      expect(tool.recoveryPolicy).toBe('idempotent')
      expect(tool.runtimeVersion).toBe(
        ['ui_click', 'ui_input', 'ui_select'].includes(tool.name) ? '2' : '1',
      )
      expect(tool.idempotencyKey).toBeDefined()
      // 不设租约绑定输入：browser_command 不消费审批租约，Agent 层审批即门。
      expect(tool.approvalLeaseInput).toBeUndefined()
    }
  })

  it('描述与 guideline 明写写动作后 ref 失效', () => {
    for (const tool of tools) {
      expect(tool.description).toMatch(/invalidates every ref/i)
      expect(tool.promptGuidelines?.join('\n')).toContain('旧 ref 立即作废')
    }
  })

  it('审批卡用中文给出动作与目标，且不携带 category', () => {
    const cases: Array<[AgentTool, unknown, string[]]> = [
      [tools[0]!, { url: 'https://shop.test/cart' }, ['导航到 https://shop.test/cart？', '当前活动标签页']],
      [tools[1]!, { ref: 7 }, ['点击元素 ref=7？', '当前活动标签页']],
      [tools[2]!, { ref: 3, text: '优惠券' }, ['向元素 ref=3 写入 3 个字符？', '当前活动标签页']],
      [tools[3]!, { ref: 4, text: ' 北京 ' }, ['在 ref=4 中选中「北京」？', '当前活动标签页']],
      [tools[4]!, { key: 'Enter' }, ['按下 Enter？', '当前活动标签页']],
      [tools[4]!, { key: 'Tab', ref: 9, tabId: 'tab-2' }, ['按下 Tab（先聚焦 ref=9）？', '标签页 tab-2']],
    ]
    for (const [tool, input, expectations] of cases) {
      const presentation = approvalOf(tool, input)
      for (const expected of expectations) {
        expect(`${presentation.title}\n${presentation.description}`).toContain(expected)
      }
      expect(presentation.category).toBeUndefined()
    }
  })

  it('取消（aborted）时在任何宿主调用前中止', async () => {
    const { host, reads, writes } = hostWith({ click: DONE })
    const aborted = context({ signal: AbortSignal.abort() })
    await expect(createUiClickTool(host).execute({ ref: 1 }, aborted)).rejects.toMatchObject({ name: 'AbortError' })
    expect(reads).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it('幂等键在 512 bytes 上限内（超长 tabId/URL/文本不会让工具调用直接失败）', async () => {
    // Runtime 在 idempotencyKey > 512 bytes 时直接把调用判为 error（见 toolExecution）：
    // 五个写工具的键都必须压缩内容，而不是把 URL/文本明文拼进去。
    const longTab = 't'.repeat(200)
    const longUrl = `https://shop.test/${'a'.repeat(2048 - 'https://shop.test/'.length)}`
    const cases: Array<[number, Record<string, unknown>]> = [
      [0, { tabId: longTab, url: longUrl }],
      [1, { tabId: longTab, ref: 1 }],
      [2, { tabId: longTab, ref: 1, text: 'x'.repeat(20_000) }],
      [3, { tabId: longTab, ref: 1, text: 'x'.repeat(20_000) }],
      [4, { tabId: longTab, ref: 1, key: 'PageDown' }],
    ]
    for (const [index, input] of cases) {
      const key = await tools[index]!.idempotencyKey?.(input as never)
      expect(key).toBeTruthy()
      const bytes = new TextEncoder().encode(key!).length
      expect(bytes, `${tools[index]!.name} 幂等键 ${bytes} bytes`).toBeLessThanOrEqual(512)
    }
  })
})

describe('ui_navigate', () => {
  it('省略 tabId 时先解析活动标签页，再经写通道导航并回报 url/标题', async () => {
    const { host, reads, writes } = hostWith({
      navigate: { type: 'navigated', url: 'https://shop.test/cart', title: '购物车' },
    })
    const result = await createUiNavigateTool(host).execute({ url: 'https://shop.test/cart' }, context())
    expect(reads).toEqual([{ action: 'tabs' }])
    expect(writes).toEqual([{ action: 'navigate', tabId: 'tab-1', url: 'https://shop.test/cart' }])
    expect(result.content).toContain('已在标签页 tab-1导航到 https://shop.test/cart')
    expect(result.content).toContain('页面标题：购物车')
    expect(result.content).toContain('写动作已生效')
    expect(result.details).toMatchObject({ tabId: 'tab-1', url: 'https://shop.test/cart', title: '购物车' })
  })

  it('显式 tabId 不解析标签页，且非 navigated 响应显式失败', async () => {
    const { host, reads } = hostWith({ navigate: DONE })
    await expect(createUiNavigateTool(host).execute({ tabId: 'tab-9', url: 'https://shop.test/' }, context()))
      .rejects.toThrow('非预期的写动作结果：done（期望 navigated）')
    expect(reads).toHaveLength(0)
  })

  it('URL 校验拒绝相对地址、非 http(s) 协议、userinfo 与超长地址', () => {
    const tool = createUiNavigateTool(createFakeAgentEnvironment())
    expect(tool.validate({ url: 'https://shop.test/cart' }).ok).toBe(true)
    expect(tool.validate({ url: '/cart' }).ok).toBe(false)
    expect(tool.validate({ url: 'file:///etc/passwd' }).ok).toBe(false)
    expect(tool.validate({ url: 'javascript:alert(1)' }).ok).toBe(false)
    expect(tool.validate({ url: 'https://user:pass@shop.test/' }).ok).toBe(false)
    expect(tool.validate({ url: `https://shop.test/${'a'.repeat(2048)}` }).ok).toBe(false)
    expect(tool.validate({ url: '   ' }).ok).toBe(false)
    expect(tool.validate({ url: 'https://shop.test/', extra: 1 }).ok).toBe(false)
    expect(tool.validate({ url: 'https://shop.test/', tabId: '' }).ok).toBe(false)
  })
})

describe('ui_click', () => {
  it('省略 tabId 时解析活动标签页并点击 ref', async () => {
    const { host, reads, writes } = hostWith({ click: DONE })
    const result = await createUiClickTool(host).execute({ ref: 7 }, context())
    expect(reads).toEqual([{ action: 'tabs' }])
    expect(writes).toEqual([{ action: 'click', tabId: 'tab-1', ref: 7 }])
    expect(result.content).toContain('已点击标签页 tab-1中 ref=7 的元素')
    expect(result.details).toMatchObject({ tabId: 'tab-1', ref: 7, applied: true })
  })

  it('ref 缺失或非法时校验失败（不会把 0 当默认值）', () => {
    const tool = createUiClickTool(createFakeAgentEnvironment())
    expect(tool.validate({ ref: 1 }).ok).toBe(true)
    expect(tool.validate({}).ok).toBe(false)
    expect(tool.validate({ ref: 0 }).ok).toBe(false)
    expect(tool.validate({ ref: 1.5 }).ok).toBe(false)
    expect(tool.validate({ ref: '7' }).ok).toBe(false)
    expect(tool.validate({ ref: 7, locator: { testId: 'pay' } }).ok).toBe(false)
  })

  it('locator 唯一解析后点击解析出的 ref（写通道收到解析结果而非原 ref）', async () => {
    const { host, reads, writes } = hostWith({ click: DONE }, { resolveLocator: UNIQUE_RESOLUTION })
    const result = await createUiClickTool(host).execute({ locator: { role: 'button', name: '去支付' } }, context())
    expect(reads).toEqual([
      { action: 'tabs' },
      { action: 'resolveLocator', tabId: 'tab-1', locator: { role: 'button', name: '去支付' } },
    ])
    expect(writes).toEqual([{ action: 'click', tabId: 'tab-1', ref: 42 }])
    expect(result.content).toContain('role=button name=「去支付」（解析为 ref=42）')
    expect(result.details).toMatchObject({ tabId: 'tab-1', ref: 42, locator: { role: 'button', name: '去支付' }, applied: true })
  })

  it('locator 零匹配/歧义都在写动作前以错误收口（不取第一个候选）', async () => {
    const notFound = hostWith({ click: DONE }, { resolveLocator: NOT_FOUND_RESOLUTION })
    await expect(createUiClickTool(notFound.host).execute({ locator: { testId: 'pay' } }, context()))
      .rejects.toThrow('无法唯一定位：定位器 testId=pay 零匹配')
    expect(notFound.writes).toHaveLength(0)

    const ambiguous = hostWith({ click: DONE }, { resolveLocator: AMBIGUOUS_RESOLUTION })
    await expect(createUiClickTool(ambiguous.host).execute({ locator: { role: 'button', name: '提交' } }, context()))
      .rejects.toThrow('歧义（2 个候选）')
    expect(ambiguous.writes).toHaveLength(0)
  })

  it('locator 路径校验：合法 locator 通过，形状非法或与 ref 同时给出被拒绝', () => {
    const tool = createUiClickTool(createFakeAgentEnvironment())
    expect(tool.validate({ locator: { testId: 'pay' } }).ok).toBe(true)
    expect(tool.validate({ locator: {} }).ok).toBe(false)
    expect(tool.validate({ locator: { testId: '  ' } }).ok).toBe(false)
    expect(tool.validate({ locator: { testId: 'pay' }, ref: 1 }).ok).toBe(false)
  })

  it('审批卡在 locator 路径展示即将解析的定位描述', () => {
    const presentation = approvalOf(createUiClickTool(createFakeAgentEnvironment()), {
      locator: { role: 'button', name: '去支付' },
    })
    expect(presentation.title).toContain('点击定位器 role=button name=「去支付」')
    expect(presentation.description).toContain('定位器 role=button name=「去支付」')
  })
})

describe('ui_input', () => {
  it('映射为宿主 fill（覆盖式写入），文本不进入结果正文', async () => {
    const { host, reads, writes } = hostWith({ fill: DONE })
    const result = await createUiInputTool(host).execute({ ref: 3, text: 'SHOP10' }, context())
    expect(reads).toEqual([{ action: 'tabs' }])
    expect(writes).toEqual([{ action: 'fill', tabId: 'tab-1', ref: 3, text: 'SHOP10' }])
    expect(result.content).toContain('已向标签页 tab-1中 ref=3 的控件写入 6 个字符')
    expect(result.details).toMatchObject({ tabId: 'tab-1', ref: 3, chars: 6, applied: true })
  })

  it('空字符串表示清空字段，超长文本与缺参被拒绝', () => {
    const tool = createUiInputTool(createFakeAgentEnvironment())
    expect(tool.validate({ ref: 3, text: '' }).ok).toBe(true)
    expect(tool.validate({ ref: 3, text: 'a'.repeat(20_000) }).ok).toBe(true)
    expect(tool.validate({ ref: 3, text: 'a'.repeat(20_001) }).ok).toBe(false)
    expect(tool.validate({ ref: 3 }).ok).toBe(false)
    expect(tool.validate({ text: 'x' }).ok).toBe(false)
    expect(tool.validate({ ref: 0, text: 'x' }).ok).toBe(false)
  })

  it('idempotencyKey 区分内容不同但长度相同的两次写入', async () => {
    const tool = createUiInputTool(createFakeAgentEnvironment())
    const first = await tool.idempotencyKey?.({ ref: 3, text: 'AAAA' })
    const second = await tool.idempotencyKey?.({ ref: 3, text: 'BBBB' })
    expect(first).not.toBe(second)
    expect(first).toBe(await tool.idempotencyKey?.({ ref: 3, text: 'AAAA' }))
    expect(first).toMatch(/^ui_input::ref=3:[0-9a-f]{64}$/)
  })

  it('locator 唯一解析后经 fill 写入解析出的 ref', async () => {
    const { host, reads, writes } = hostWith({ fill: DONE }, { resolveLocator: UNIQUE_RESOLUTION })
    const result = await createUiInputTool(host).execute({ locator: { label: '优惠券' }, text: 'SHOP10' }, context())
    expect(reads[1]).toEqual({ action: 'resolveLocator', tabId: 'tab-1', locator: { label: '优惠券' } })
    expect(writes).toEqual([{ action: 'fill', tabId: 'tab-1', ref: 42, text: 'SHOP10' }])
    expect(result.content).toContain('label=「优惠券」（解析为 ref=42）')
  })

  it('locator 零匹配以错误收口且不发出 fill', async () => {
    const { host, writes } = hostWith({ fill: DONE }, { resolveLocator: NOT_FOUND_RESOLUTION })
    await expect(createUiInputTool(host).execute({ locator: { testId: 'coupon' }, text: 'a' }, context()))
      .rejects.toThrow('零匹配')
    expect(writes).toHaveLength(0)
  })

  it('目标二选一：都给或都缺被拒绝', () => {
    const tool = createUiInputTool(createFakeAgentEnvironment())
    expect(tool.validate({ locator: { testId: 'coupon' }, text: 'a' }).ok).toBe(true)
    expect(tool.validate({ text: 'a' }).ok).toBe(false)
    expect(tool.validate({ ref: 3, locator: { testId: 'coupon' }, text: 'a' }).ok).toBe(false)
  })

  it('审批卡在 locator 路径展示定位描述', () => {
    const presentation = approvalOf(createUiInputTool(createFakeAgentEnvironment()), {
      locator: { label: '优惠券' },
      text: 'AB',
    })
    expect(presentation.title).toContain('向定位器 label=「优惠券」 的控件写入 2 个字符？')
  })
})

describe('ui_select', () => {
  it('映射为宿主 selectOption，并如实报告宿主已回读确认', async () => {
    const { host, reads, writes } = hostWith({ selectOption: DONE })
    const result = await createUiSelectTool(host).execute({ ref: 4, text: ' 北京 ' }, context())
    expect(reads).toEqual([{ action: 'tabs' }])
    expect(writes).toEqual([{ action: 'selectOption', tabId: 'tab-1', ref: 4, text: ' 北京 ' }])
    expect(result.content).toContain('已在标签页 tab-1中把 ref=4 的选中项切换为「北京」')
    expect(result.content).toContain('宿主已回读该节点确认')
    expect(result.details).toMatchObject({ tabId: 'tab-1', ref: 4, option: '北京', applied: true })
  })

  it('选项文本必须非空且不超上限', () => {
    const tool = createUiSelectTool(createFakeAgentEnvironment())
    expect(tool.validate({ ref: 4, text: '北京' }).ok).toBe(true)
    expect(tool.validate({ ref: 4, text: '  ' }).ok).toBe(false)
    expect(tool.validate({ ref: 4 }).ok).toBe(false)
    expect(tool.validate({ ref: 4, text: 'a'.repeat(20_001) }).ok).toBe(false)
  })

  it('locator 唯一解析后经 selectOption 作用于解析出的 ref', async () => {
    const { host, reads, writes } = hostWith({ selectOption: DONE }, { resolveLocator: UNIQUE_RESOLUTION })
    const result = await createUiSelectTool(host).execute({ locator: { label: '城市' }, text: '北京' }, context())
    expect(reads[1]).toEqual({ action: 'resolveLocator', tabId: 'tab-1', locator: { label: '城市' } })
    expect(writes).toEqual([{ action: 'selectOption', tabId: 'tab-1', ref: 42, text: '北京' }])
    expect(result.content).toContain('label=「城市」（解析为 ref=42）')
  })

  it('locator 歧义以错误收口且不发出 selectOption', async () => {
    const { host, writes } = hostWith({ selectOption: DONE }, { resolveLocator: AMBIGUOUS_RESOLUTION })
    await expect(createUiSelectTool(host).execute({ locator: { role: 'combobox' }, text: '北京' }, context()))
      .rejects.toThrow('歧义')
    expect(writes).toHaveLength(0)
  })

  it('目标二选一：都给或都缺被拒绝', () => {
    const tool = createUiSelectTool(createFakeAgentEnvironment())
    expect(tool.validate({ locator: { label: '城市' }, text: '北京' }).ok).toBe(true)
    expect(tool.validate({ text: '北京' }).ok).toBe(false)
    expect(tool.validate({ ref: 4, locator: { label: '城市' }, text: '北京' }).ok).toBe(false)
  })
})

describe('ui_press', () => {
  it('省略 ref 时按键发给当前焦点元素', async () => {
    const { host, reads, writes } = hostWith({ press: DONE })
    const result = await createUiPressTool(host).execute({ key: 'Enter' }, context())
    expect(reads).toEqual([{ action: 'tabs' }])
    expect(writes).toEqual([{ action: 'press', tabId: 'tab-1', key: 'Enter' }])
    expect(result.content).toContain('已在标签页 tab-1中按下 Enter')
    expect(result.details).toMatchObject({ tabId: 'tab-1', key: 'Enter', ref: null, applied: true })
  })

  it('带 ref 时先聚焦再按键', async () => {
    const { host, writes } = hostWith({ press: DONE })
    const result = await createUiPressTool(host).execute({ tabId: 'tab-2', key: 'Escape', ref: 9 }, context())
    expect(writes).toEqual([{ action: 'press', tabId: 'tab-2', key: 'Escape', ref: 9 }])
    expect(result.content).toContain('（先聚焦 ref=9）')
    expect(result.details).toMatchObject({ tabId: 'tab-2', key: 'Escape', ref: 9 })
  })

  it('按键白名单镜像宿主：具名键与单字符放行，组合键与空键拒绝', () => {
    const tool = createUiPressTool(createFakeAgentEnvironment())
    for (const key of ['Enter', 'return', 'Tab', 'escape', 'PageDown', 'Space', 'a', '中']) {
      expect(tool.validate({ key }).ok, key).toBe(true)
    }
    for (const key of ['', 'ctrl+a', 'Meta+Enter', 'Enter ']) {
      expect(tool.validate({ key }).ok, key).toBe(false)
    }
    expect(tool.validate({}).ok).toBe(false)
    expect(tool.validate({ key: 'Enter', ref: 0 }).ok).toBe(false)
    expect(tool.validate({ key: 'Enter', extra: true }).ok).toBe(false)
  })

  it('idempotencyKey 记录 tabId/ref/key', () => {
    const tool = createUiPressTool(createFakeAgentEnvironment())
    expect(tool.idempotencyKey?.({ key: 'Enter', ref: 2, tabId: 'tab-1' })).toBe('ui_press:tab-1:2:Enter')
  })
})
