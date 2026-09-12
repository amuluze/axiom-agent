import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./environment', () => ({ isTauriRuntime: mocks.isTauriRuntime }))

import {
  formatUsageResetsAt,
  isUsageQueryableProvider,
  queryProviderUsage,
  USAGE_QUERY_PROVIDER_IDS,
} from './usageQuery'

beforeEach(() => {
  mocks.isTauriRuntime.mockReturnValue(true)
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('queryProviderUsage', () => {
  it('非桌面运行时短路，不触发 invoke', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(queryProviderUsage({ providerId: 'deepseek' }))
      .rejects.toThrow('仅在 Axiom 桌面应用中可用')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('以 query_provider_usage command 转发请求并透传结果', async () => {
    const result = {
      providerId: 'zhipu-glm',
      kind: 'quota',
      metrics: [{ label: 'Token5 小时窗口', used: 12.5, total: 100, unit: '%' }],
      checkedAtMs: 1_700_000_000_000,
    }
    mocks.invoke.mockResolvedValueOnce(result)
    await expect(queryProviderUsage({
      providerId: 'zhipu-glm',
      secretId: 'provider.zhipu-glm.api-key',
      endpointHint: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    }))
      .resolves.toEqual(result)
    expect(mocks.invoke).toHaveBeenCalledWith('query_provider_usage', {
      request: {
        providerId: 'zhipu-glm',
        secretId: 'provider.zhipu-glm.api-key',
        endpointHint: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
      },
    })
  })

  it('归一化 wire 数据中的 null 可选字段为 undefined（防 null.toFixed 崩溃）', async () => {
    // 模拟修复前 Rust serde 的输出形态：None → null 而非字段缺失。
    mocks.invoke.mockResolvedValueOnce({
      providerId: 'kimi-coding',
      kind: 'quota',
      metrics: [{
        label: '5 小时窗口',
        used: null,
        total: null,
        remaining: null,
        unit: '%',
        resetsAt: null,
        detail: null,
      }],
      checkedAtMs: 1,
    })
    const result = await queryProviderUsage({ providerId: 'kimi-coding' })
    expect(result.metrics[0]).toEqual({
      label: '5 小时窗口',
      used: undefined,
      total: undefined,
      remaining: undefined,
      unit: '%',
      resetsAt: undefined,
      detail: undefined,
    })
    // 有效值原样保留。
    mocks.invoke.mockResolvedValueOnce({
      providerId: 'deepseek',
      kind: 'balance',
      metrics: [{ label: '账户余额', remaining: 110, unit: 'CNY' }],
      checkedAtMs: 2,
    })
    const preserved = await queryProviderUsage({ providerId: 'deepseek' })
    expect(preserved.metrics[0].remaining).toBe(110)
  })
})

describe('isUsageQueryableProvider', () => {
  it('覆盖五个受支持的 Provider，与 Rust 端点表一致', () => {
    expect(USAGE_QUERY_PROVIDER_IDS).toEqual([
      'deepseek',
      'zhipu-glm',
      'kimi',
      'kimi-coding',
      'minimax-chat',
    ])
    for (const providerId of USAGE_QUERY_PROVIDER_IDS) {
      expect(isUsageQueryableProvider(providerId)).toBe(true)
    }
    for (const providerId of ['openai', 'gemini', 'ollama', 'demo', '']) {
      expect(isUsageQueryableProvider(providerId)).toBe(false)
    }
  })
})

describe('formatUsageResetsAt', () => {
  it('毫秒时间戳字符串与 ISO 字符串都能解析为本地时间', () => {
    expect(formatUsageResetsAt('1700000000000')).toBe(
      new Date(1_700_000_000_000).toLocaleString(),
    )
    expect(formatUsageResetsAt('2024-01-01T00:00:00Z')).toBe(
      new Date('2024-01-01T00:00:00Z').toLocaleString(),
    )
  })

  it('缺失或无法解析的值原样/不展示', () => {
    expect(formatUsageResetsAt(undefined)).toBeUndefined()
    expect(formatUsageResetsAt('not-a-date')).toBe('not-a-date')
  })
})
