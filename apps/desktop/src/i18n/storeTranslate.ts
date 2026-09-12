import { useUiStore } from '@/stores/uiStore'
import { detectSystemLanguage, resolveLanguage } from './locale'
import { translate, type TFunction } from './index'

/**
 * store 层的翻译入口：动作发生时按「用户偏好 → 系统语言」解析生效语言，
 * 直接产出目标语文本存进 state（providerMessage/settingsError 等瞬时消息），
 * UI 原样渲染。与 useT 共用同一 catalog，zh 值与历史字符串逐字一致。
 */
export const storeT: TFunction = (key, params) =>
  translate(
    resolveLanguage(useUiStore.getState().language, detectSystemLanguage()),
    key,
    params,
  )
