import { providerLabel, type ProviderId } from '@/agent/transport/provider'
import type { TFunction } from './index'

/**
 * 内置 Provider 目录的 label 来自 contracts/providers.json 生成数据（语言无关的
 * 单一来源），其中「自定义」两个 kind 是中文硬编码，不能随界面语言变化。展示层
 * 统一经此函数取本地化名：有对应 key 走语言包，其余 label 本身已是英文，原样返回。
 */
const LOCALIZED_PROVIDER_KIND_KEYS: Partial<Record<ProviderId, string>> = {
  'custom-openai-compatible': 'settings.provider.kind.custom-openai-compatible',
  'custom-anthropic-compatible': 'settings.provider.kind.custom-anthropic-compatible',
}

export const localizedProviderLabel = (t: TFunction, providerId: ProviderId): string => {
  const key = LOCALIZED_PROVIDER_KIND_KEYS[providerId]
  return key ? t(key) : providerLabel(providerId)
}
