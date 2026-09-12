// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageSection } from './UsageSection'
import type { ProviderProfile } from '@/agent/transport/provider'

const mocks = vi.hoisted(() => ({
  providerProfiles: [] as ProviderProfile[],
  isTauriRuntime: vi.fn(() => true),
  queryProviderUsage: vi.fn(),
}))

// 完全 mock store：统计页只消费 providerProfiles 一个字段。jsdom 环境下经
// importOriginal 加载完整真实 agentStore 会拖入整个运行时装配链（体积大且
// 与 DOM 环境耦合），对本组件的交互断言没有增益。
vi.mock('@/stores/agentStore', () => ({
  useAgentStore: <T,>(selector: (state: { providerProfiles: ProviderProfile[] }) => T): T =>
    selector({ providerProfiles: mocks.providerProfiles }),
}))

vi.mock('@/platform/environment', () => ({ isTauriRuntime: mocks.isTauriRuntime }))
vi.mock('@/platform/usageQuery', () => ({
  queryProviderUsage: mocks.queryProviderUsage,
  formatUsageResetsAt: (value?: string) => value,
  isUsageQueryableProvider: (providerId: string) => (
    ['deepseek', 'zhipu-glm', 'kimi', 'kimi-coding', 'minimax-chat'].includes(providerId)
  ),
}))

const mockQuery = mocks.queryProviderUsage

const deepseekProfile: ProviderProfile = {
  schemaVersion: 4,
  profileId: 'builtin.deepseek',
  providerId: 'deepseek',
  apiFormat: 'openai-compatible',
  endpoint: 'https://api.deepseek.com/chat/completions',
  modelId: 'deepseek-v4-flash',
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  contextWindow: 1_000_000,
  capabilities: { toolReferences: false, toolSearch: false },
  secretId: 'provider.deepseek.api-key',
}

const ollamaProfile: ProviderProfile = {
  schemaVersion: 4,
  profileId: 'builtin.ollama',
  providerId: 'ollama',
  apiFormat: 'openai-compatible',
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  modelId: 'llama3.3',
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  contextWindow: 128_000,
  capabilities: { toolReferences: false, toolSearch: false },
}

const installProfiles = (profiles: ProviderProfile[]): void => {
  mocks.providerProfiles = profiles
}

beforeEach(() => {
  mockQuery.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
  installProfiles([])
  mocks.isTauriRuntime.mockReturnValue(true)
})

describe('UsageSection', () => {
  it('未配置任何 Provider 时给出引导且不发起查询', async () => {
    installProfiles([])
    render(<UsageSection />)
    expect(screen.getByText('模型用量统计')).toBeTruthy()
    expect(screen.getByText(/尚未配置任何模型/)).toBeTruthy()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('浏览器开发模式下不发起查询并提示仅桌面可用', () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    installProfiles([deepseekProfile])
    render(<UsageSection />)
    expect(screen.getByText(/用量查询仅在 Axiom 桌面应用中可用/)).toBeTruthy()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('仅对受支持的 Provider 自动发起用量查询并渲染指标', async () => {
    installProfiles([deepseekProfile, ollamaProfile])
    mockQuery.mockResolvedValueOnce({
      providerId: 'deepseek',
      kind: 'balance',
      metrics: [{
        label: '账户余额',
        remaining: 110,
        unit: 'CNY',
      }],
      checkedAtMs: new Date('2026-01-01T08:00:00Z').getTime(),
    })
    render(<UsageSection />)

    await waitFor(() => expect(mockQuery).toHaveBeenCalledTimes(1))
    expect(mockQuery).toHaveBeenCalledWith({
      providerId: 'deepseek',
      secretId: 'provider.deepseek.api-key',
      endpointHint: 'https://api.deepseek.com/chat/completions',
    })
    expect(await screen.findByText('账户余额')).toBeTruthy()
    expect(screen.getByText('剩余 110.00 CNY')).toBeTruthy()
    // ollama 归入暂不支持区，并标注本地推理无账户用量。
    expect(screen.getByText(/暂不支持用量查询的 Provider/)).toBeTruthy()
    expect(screen.getByText('本地推理 Provider，无账户用量。')).toBeTruthy()
  })

  it('额度类指标渲染进度条与重置时间', async () => {
    installProfiles([deepseekProfile])
    mockQuery.mockResolvedValueOnce({
      providerId: 'deepseek',
      kind: 'quota',
      metrics: [{
        label: 'Token5 小时窗口',
        used: 75,
        total: 100,
        unit: '%',
        resetsAt: '2026-01-01T12:00:00Z',
      }],
      checkedAtMs: Date.now(),
    })
    render(<UsageSection />)
    const bar = await screen.findByRole('progressbar', { name: 'Token5 小时窗口' })
    expect(bar.getAttribute('aria-valuenow')).toBe('75')
    expect(screen.getByText('已用 75.0%')).toBeTruthy()
    // formatUsageResetsAt 被 mock 为恒等透传（本地化格式由 platform 单测覆盖）。
    expect(screen.getByText('重置于 2026-01-01T12:00:00Z')).toBeTruthy()
  })

  it('MiniMax 剩余百分比指标渲染剩余额度与进度条', async () => {
    const minimaxProfile: ProviderProfile = {
      ...ollamaProfile,
      profileId: 'builtin.minimax-chat',
      providerId: 'minimax-chat',
      endpoint: 'https://api.minimaxi.com/v1/chat/completions',
      modelId: 'MiniMax-M3',
      secretId: 'provider.minimax-chat.api-key',
    }
    installProfiles([minimaxProfile])
    mockQuery.mockResolvedValueOnce({
      providerId: 'minimax-chat',
      kind: 'quota',
      metrics: [{
        label: '5 小时窗口',
        used: 2,
        total: 100,
        remaining: 98,
        unit: '%',
      }],
      checkedAtMs: Date.now(),
    })
    render(<UsageSection />)
    expect(await screen.findByText('5 小时窗口')).toBeTruthy()
    // 百分比取整展示，避免"98.00 %"的冗余小数。
    expect(screen.getByText('剩余 98 %')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '5 小时窗口' })).toBeTruthy()
    // minimax-chat 已支持查询，不再进入暂不支持区。
    expect(screen.queryByText(/暂不支持用量查询的 Provider/)).toBeNull()
  })

  it('Kimi Coding 窗口渲染剩余百分比与额度余量明细', async () => {
    const kimiCodingProfile: ProviderProfile = {
      ...ollamaProfile,
      profileId: 'builtin.kimi-coding',
      providerId: 'kimi-coding',
      endpoint: 'https://api.kimi.com/coding/v1/messages',
      modelId: 'kimi-for-coding',
      secretId: 'provider.kimi-coding.api-key',
    }
    installProfiles([kimiCodingProfile])
    mockQuery.mockResolvedValueOnce({
      providerId: 'kimi-coding',
      kind: 'quota',
      metrics: [{
        label: '5 小时窗口',
        used: 25,
        total: 100,
        remaining: 75,
        unit: '%',
        detail: '额度余量 1.5 / 2',
      }],
      checkedAtMs: Date.now(),
    })
    render(<UsageSection />)
    expect(await screen.findByText('5 小时窗口')).toBeTruthy()
    // 剩余百分比与 MiniMax 形态一致；额度余量绝对值经 detail 补充。
    expect(screen.getByText('剩余 75 %')).toBeTruthy()
    expect(screen.getByText('额度余量 1.5 / 2')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '5 小时窗口' })).toBeTruthy()
  })

  it('null 形态的可选字段（serde None 的历史 wire 格式）不再打崩页面', async () => {
    // 回归复现：Rust serde 曾把 Option::None 序列化为 `remaining: null`，
    // `metric.remaining !== undefined` 对 null 为真 → `null.toFixed` 抛
    // TypeError → 整页黑屏。GLM 的 remaining 恒为 None 必然触发。
    const zhipuProfile: ProviderProfile = {
      ...ollamaProfile,
      profileId: 'builtin.zhipu-glm',
      providerId: 'zhipu-glm',
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      modelId: 'glm-5.2',
      secretId: 'provider.zhipu-glm.api-key',
    }
    installProfiles([zhipuProfile])
    mockQuery.mockResolvedValueOnce({
      providerId: 'zhipu-glm',
      kind: 'quota',
      metrics: [{
        label: 'Token5 小时窗口',
        used: 12.5,
        total: 100,
        remaining: null,
        unit: '%',
        resetsAt: null,
        detail: null,
      }],
      checkedAtMs: Date.now(),
    })
    render(<UsageSection />)
    // 渲染不抛异常：回落到"已用"形态。
    expect(await screen.findByText('Token5 小时窗口')).toBeTruthy()
    expect(screen.getByText('已用 12.5%')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Token5 小时窗口' })).toBeTruthy()
  })

  it('查询失败时展示错误', async () => {
    installProfiles([deepseekProfile])
    mockQuery.mockRejectedValueOnce(new Error('未配置 API Key，无法查询用量'))
    render(<UsageSection />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('未配置 API Key，无法查询用量')).toBeTruthy()
  })

  it('手动刷新对全部受支持 Provider 重新发起查询', async () => {
    installProfiles([deepseekProfile, ollamaProfile])
    mockQuery.mockResolvedValue({
      providerId: 'deepseek',
      kind: 'balance',
      metrics: [{ label: '账户余额', remaining: 1, unit: 'CNY' }],
      checkedAtMs: Date.now(),
    })
    render(<UsageSection />)
    await waitFor(() => expect(mockQuery).toHaveBeenCalledTimes(1))

    const refresh = screen.getByRole('button', { name: /刷新全部/ }) as HTMLButtonElement
    await waitFor(() => expect(refresh.disabled).toBe(false))
    fireEvent.click(refresh)
    await waitFor(() => expect(mockQuery).toHaveBeenCalledTimes(2))
  })
})
