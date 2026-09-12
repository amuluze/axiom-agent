import { describe, expect, it } from 'vitest'
import { localizeUsageMetricText } from './usageMetricLabels'
import { translate } from '@/i18n'

const tEn = (key: string, params?: Record<string, string | number>) => translate('en', key, params)
const tZh = (key: string, params?: Record<string, string | number>) => translate('zh-CN', key, params)

describe('localizeUsageMetricText', () => {
  it('英文界面翻译 Rust 产出的中文标签与明细', () => {
    expect(localizeUsageMetricText(tEn, '账户余额')).toBe('Account balance')
    expect(localizeUsageMetricText(tEn, '可用余额')).toBe('Available balance')
    expect(localizeUsageMetricText(tEn, '5 小时窗口')).toBe('5-hour window')
    expect(localizeUsageMetricText(tEn, '周窗口')).toBe('Weekly window')
    expect(localizeUsageMetricText(tEn, 'Token5 小时窗口')).toBe('Token 5-hour window')
    expect(localizeUsageMetricText(tEn, 'Token周窗口')).toBe('Token Weekly window')
    expect(localizeUsageMetricText(tEn, '额度5 小时窗口')).toBe('Credit 5-hour window')
    expect(localizeUsageMetricText(tEn, '套餐：pro')).toBe('Plan: pro')
    expect(localizeUsageMetricText(tEn, '额度余量 41 / 100')).toBe('Remaining 41 / 100')
    expect(localizeUsageMetricText(tEn, '代金券 12.34 · 现金 56.78')).toBe('Voucher 12.34 · Cash 56.78')
    expect(localizeUsageMetricText(tEn, '余额不可用（可能已欠费）'))
      .toBe('Balance unavailable (account may be in arrears)')
  })

  it('中文界面 round-trip 保持 Rust 原文逐字不变', () => {
    for (const text of [
      '账户余额',
      '可用余额',
      '5 小时窗口',
      '周窗口',
      'Token5 小时窗口',
      '额度周窗口',
      '套餐：pro',
      '额度余量 41 / 100',
      '代金券 12.34 · 现金 56.78',
      '余额不可用（可能已欠费）',
    ]) {
      expect(localizeUsageMetricText(tZh, text)).toBe(text)
    }
  })

  it('未识别文本原样透传', () => {
    expect(localizeUsageMetricText(tEn, 'Mystery metric')).toBe('Mystery metric')
  })
})
