import { describe, expect, it } from 'vitest'
import { PROVIDER_CONSTANTS } from './generatedProviderData'
import { validateProviderNumericDraft } from './providerDraftValidation'

const validDraft = {
  timeoutMs: PROVIDER_CONSTANTS.timeoutDefaultMs,
  maxOutputTokens: PROVIDER_CONSTANTS.maxOutputDefault,
  contextWindow: PROVIDER_CONSTANTS.contextDefault,
}

describe('validateProviderNumericDraft', () => {
  it('合法取值通过', () => {
    expect(validateProviderNumericDraft(validDraft)).toBeUndefined()
    expect(validateProviderNumericDraft({
      ...validDraft,
      timeoutMs: PROVIDER_CONSTANTS.timeoutMaxMs,
      maxOutputTokens: PROVIDER_CONSTANTS.maxOutputMax,
      contextWindow: PROVIDER_CONSTANTS.contextMax,
    })).toBeUndefined()
  })

  it('最大输出 token 超过上限即拒绝（Rust 会静默 clamp，必须在此失败）', () => {
    // 真实形态：用户把 64000 改成 600000（超出 512000 上限），此前一路「配置已保存」
    // 而实际存的是被裁剪后的值。
    expect(validateProviderNumericDraft({ ...validDraft, maxOutputTokens: 600_000 }))
      .toEqual({
        field: 'maxOutputTokens',
        value: 600_000,
        min: PROVIDER_CONSTANTS.maxOutputMin,
        max: PROVIDER_CONSTANTS.maxOutputMax,
      })
  })

  it('低于下限（输入框清空得到 0）与 NaN 同样拒绝', () => {
    expect(validateProviderNumericDraft({ ...validDraft, maxOutputTokens: 0 })?.field)
      .toBe('maxOutputTokens')
    expect(validateProviderNumericDraft({ ...validDraft, timeoutMs: Number.NaN })?.field)
      .toBe('timeoutMs')
    expect(Number.isNaN(
      validateProviderNumericDraft({ ...validDraft, contextWindow: Number.NaN })?.value ?? 0,
    )).toBe(true)
  })

  it('上下文窗口与超时各自独立校验', () => {
    expect(validateProviderNumericDraft({ ...validDraft, contextWindow: 4_000_000 })?.field)
      .toBe('contextWindow')
    expect(validateProviderNumericDraft({ ...validDraft, timeoutMs: 10 })?.field)
      .toBe('timeoutMs')
  })
})
