import type { TFunction } from '@/i18n'

/**
 * Rust `usage_query.rs` 产出的指标 label/detail 是面向展示的中文常量（wire 契约
 * 只有一份，不随界面语言变化），这里在渲染前映射为当前语言文案。zh 模板与
 * Rust 格式逐字一致，保证中文界面 round-trip 原样；未识别的文本原样透传，
 * 与「不静默缩窄」的展示原则一致。
 */

const EXACT_TEXT_KEYS: Record<string, string> = {
  '账户余额': 'settings.usage.metric.accountBalance',
  '可用余额': 'settings.usage.metric.availableBalance',
  '5 小时窗口': 'settings.usage.metric.fiveHourWindow',
  '周窗口': 'settings.usage.metric.weeklyWindow',
  '余额不可用（可能已欠费）': 'settings.usage.metric.balanceUnavailable',
}

// 智谱 label 由固定前缀（Token/额度）+ 窗口名拼接。
const WINDOW_SUFFIXES: readonly (readonly [suffix: string, key: string])[] = [
  ['5 小时窗口', 'settings.usage.metric.fiveHourWindow'],
  ['周窗口', 'settings.usage.metric.weeklyWindow'],
]

const PLAN_PREFIX = '套餐：'
const QUOTA_REMAINING_PREFIX = '额度余量 '
const VOUCHER_CASH_PATTERN = /^代金券 (.+) · 现金 (.+)$/u

export const localizeUsageMetricText = (t: TFunction, text: string): string => {
  const exact = EXACT_TEXT_KEYS[text]
  if (exact) return t(exact)
  if (text.startsWith(PLAN_PREFIX)) {
    return t('settings.usage.metric.plan', { plan: text.slice(PLAN_PREFIX.length) })
  }
  if (text.startsWith(QUOTA_REMAINING_PREFIX)) {
    return t('settings.usage.metric.quotaRemaining', {
      values: text.slice(QUOTA_REMAINING_PREFIX.length),
    })
  }
  const voucherCash = VOUCHER_CASH_PATTERN.exec(text)
  if (voucherCash) {
    return t('settings.usage.metric.voucherCash', {
      voucher: voucherCash[1]!,
      cash: voucherCash[2]!,
    })
  }
  for (const [suffix, windowKey] of WINDOW_SUFFIXES) {
    if (text.startsWith('Token') && text.endsWith(suffix)) {
      return t('settings.usage.metric.tokenWindow', { window: t(windowKey) })
    }
    if (text.startsWith('额度') && text.endsWith(suffix)) {
      return t('settings.usage.metric.creditWindow', { window: t(windowKey) })
    }
  }
  return text
}
