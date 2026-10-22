import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'

/**
 * 迁移兼容：识别**非结构化**宿主错误的 not_found 文案。
 *
 * 现行契约（`find_workspace_files`）：目录不存在 = 结构化空结果（`matches: []`），
 * 命令错误是 `{ code, message }` 信封并被 `platform/workspace` 转成
 * `AgentEnvironmentError`。因此新宿主不会走到这里——只有未升级的宿主仍以字符串
 * 错误表达 not_found，调用方需要靠文案兜底一次（否则新项目首次扫描 `tests/`、
 * `tests/environments/` 会显示成「扫描失败」而不是空态）。
 *
 * 边界：结构化错误一律返回 false（即使 message 里出现 not found 字样）——不允许
 * 用文案猜测覆盖 code。宿主版本对齐后删除本模块。
 */
const LEGACY_MISSING_PATTERNS = ['no such file or directory', 'not found', 'cannot find'] as const

export const isLegacyMissingDirectory = (error: unknown): boolean => {
  if (error instanceof AgentEnvironmentError) return false
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return LEGACY_MISSING_PATTERNS.some((pattern) => message.includes(pattern))
}
