/**
 * 语言包聚合：把各分区（core/general/…）的 zh/en 表合并成一份 catalog。
 * catalog['zh-CN'] 与 catalog['en'] 保持同构（key 集合一致），由 index.test 强制。
 */
import { coreEn, coreZh } from './core'
import { generalEn, generalZh } from './general'
import { providerEn, providerZh, reasoningEn, reasoningZh } from './provider'
import {
  contextPolicyEn,
  contextPolicyZh,
  limitsEn,
  limitsZh,
  queueModesEn,
  queueModesZh,
} from './runtime'
import { archivedEn, archivedZh, sessionsEn, sessionsZh } from './sessions'
import { aboutEn, aboutZh, usageEn, usageZh } from './usage'
import { browserEn, browserZh, computerEn, computerZh } from './browser'
import { skillsEn, skillsZh, subagentsEn, subagentsZh } from './skills'
import { appEn, appZh } from './app'
import { statusEn, statusZh } from './status'

export type MessageCatalog = Record<string, string>

export const messageCatalogs: Record<'zh-CN' | 'en', MessageCatalog> = {
  'zh-CN': {
    ...coreZh,
    ...generalZh,
    ...providerZh,
    ...reasoningZh,
    ...contextPolicyZh,
    ...queueModesZh,
    ...limitsZh,
    ...sessionsZh,
    ...archivedZh,
    ...usageZh,
    ...aboutZh,
    ...browserZh,
    ...computerZh,
    ...skillsZh,
    ...subagentsZh,
    ...appZh,
    ...statusZh,
  },
  en: {
    ...coreEn,
    ...generalEn,
    ...providerEn,
    ...reasoningEn,
    ...contextPolicyEn,
    ...queueModesEn,
    ...limitsEn,
    ...sessionsEn,
    ...archivedEn,
    ...usageEn,
    ...aboutEn,
    ...browserEn,
    ...computerEn,
    ...skillsEn,
    ...subagentsEn,
    ...appEn,
    ...statusEn,
  },
}

/** 汇总当前已接入的 key 命名空间，便于新增分区时扩展（调试/测试用）。 */
export const messageScopes = ['core', 'general', 'provider', 'reasoning', 'runtime', 'sessions', 'usage', 'browser', 'skills', 'app', 'status'] as const
