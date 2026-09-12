/**
 * 语言偏好解析的纯函数层：只依赖显式入参，不触达 React / uiStore / DOM，
 * 便于 SSR 与测试注入系统语言。偏好枚举与 uiStore.UiLanguage 保持一致。
 */

export type UiLanguagePreference = 'system' | 'zh-CN' | 'en'
/** 实际生效的语言（偏好 system 经系统语言解析后收敛到两者之一）。 */
export type ResolvedLanguage = 'zh-CN' | 'en'

/**
 * 判断系统语言是否为中文系：按 BCP 47 前缀匹配（zh / zh-Hans / zh-CN …）。
 * systemLanguage 缺失（如部分 SSR 环境）时保守回退 zh-CN，避免默认界面漂到英文。
 */
export const isChineseSystemLanguage = (systemLanguage: string | undefined): boolean =>
  typeof systemLanguage === 'string' && systemLanguage.toLowerCase().replace('_', '-').startsWith('zh')

/** 偏好 → 生效语言。language='system' 时读取 systemLanguage（undefined 回退 zh-CN）。 */
export const resolveLanguage = (
  language: UiLanguagePreference,
  systemLanguage?: string,
): ResolvedLanguage => {
  if (language === 'zh-CN') return 'zh-CN'
  if (language === 'en') return 'en'
  // system：系统语言缺失（SSR node / navigator 被禁用）时保守回退中文，
  // 避免默认界面漂到英文——Axiom 存量 UI 以中文为基线。
  if (systemLanguage === undefined) return 'zh-CN'
  return isChineseSystemLanguage(systemLanguage) ? 'zh-CN' : 'en'
}

/** 读取运行时系统语言；仅浏览器 / WebView / jsdom 可用，node SSR 环境返回 undefined。 */
export const detectSystemLanguage = (): string | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.language
