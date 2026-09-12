/**
 * Composer 输入历史（↑/↓ 键回溯最近发送过的输入，终端 shell 风格）。
 *
 * 与 mentionParser.ts 同级的叶子模块：不 import 任何业务层，localStorage key
 * 沿用 `axiom.<域>.<名>.v1` 约定。历史是全局的（跨会话、跨新任务视图），
 * 数组头部为最新条目；损坏载荷 fail-safe 回退空历史，不阻断输入框可用。
 */

const COMPOSER_HISTORY_STORAGE_KEY = 'axiom.composer.history.v1'

/** 上限 100 条：覆盖日常回溯深度，同时给 localStorage 留足余量。 */
const COMPOSER_HISTORY_MAX_ENTRIES = 100

/** 超长输入（粘贴大段材料）重放价值低且挤占配额，不进历史。 */
const COMPOSER_HISTORY_MAX_ENTRY_LENGTH = 20_000

/**
 * 记录一条输入并返回新历史（纯函数）：空串忽略；与最新条目重复跳过
 * （连续重发同一内容不刷屏）；旧条目重复则提升到最前（MRU）。
 */
export const recordComposerInput = (history: string[], content: string): string[] => {
  const trimmed = content.trim()
  if (!trimmed || trimmed.length > COMPOSER_HISTORY_MAX_ENTRY_LENGTH) return history
  if (history[0] === trimmed) return history
  return [trimmed, ...history.filter((entry) => entry !== trimmed)]
    .slice(0, COMPOSER_HISTORY_MAX_ENTRIES)
}

/** ↑ 触发条件：光标位于第一行（光标之前无换行符），否则保持原生光标移动。 */
export const isCaretOnFirstLine = (value: string, caret: number): boolean =>
  !value.slice(0, caret).includes('\n')

export const loadComposerHistory = (): string[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(COMPOSER_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    )
  } catch {
    return []
  }
}

/**
 * 持久化一条输入：load → record → persist（不做模块级缓存——发送频率低，
 * 无缓存则测试与多 Composer 实例间天然隔离）。持久化失败静默，
 * 历史只是便利功能，不应打断发送主流程。
 */
export const recordComposerHistoryEntry = (content: string): string[] => {
  const next = recordComposerInput(loadComposerHistory(), content)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(COMPOSER_HISTORY_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // localStorage 写满/不可用时放弃持久化，内存中的新数组照常返回。
    }
  }
  return next
}
