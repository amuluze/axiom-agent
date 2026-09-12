import { useCallback } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { detectSystemLanguage, resolveLanguage, type ResolvedLanguage } from './locale'
import { messageCatalogs } from './locales'

/**
 * 取当前生效语言的文案；key 缺失时依次回退中文包 → key 本身。
 * params 用 {name} 插值（未提供占位时保留原样，便于发现漏参）。
 */
export const translate = (
  language: ResolvedLanguage,
  key: string,
  params?: Record<string, string | number>,
): string => {
  const catalog = messageCatalogs[language]
  let text = catalog[key] ?? messageCatalogs['zh-CN'][key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** 翻译函数签名（语言已在闭包内解析，调用方只需 key 与可选插值）。 */
export type TFunction = (key: string, params?: Record<string, string | number>) => string

/**
 * 订阅 uiStore.language 偏好，返回当前生效语言与翻译函数。
 * 依赖 selector 返回原始偏好值；偏好变化（含 setLanguage）会触发重渲染。
 */
export const useT = (): { t: TFunction; language: ResolvedLanguage } => {
  const language = useUiStore((state) => state.language)
  const resolved = resolveLanguage(language, detectSystemLanguage())
  // 用 useCallback 固定 t 的引用：resolved 不变则引用不变，避免把 t 放进
  // useEffect 依赖数组时每个渲染都触发 effect。
  const t = useCallback<TFunction>(
    (key, params) => translate(resolved, key, params),
    [resolved],
  )
  return { t, language: resolved }
}
