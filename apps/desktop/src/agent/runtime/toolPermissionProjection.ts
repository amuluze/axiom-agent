import type { AgentTool } from '../core/types'
import { migrateToolName } from '../tools/toolNameMigrations'

const CAPABILITY_GATED_TOOL_NAMES = new Set([
  'bash', 'web_search', 'web_fetch', 'browser', 'computer', 'ssh', 'ssh_hosts',
  'explore_subagent', 'inspect_subagent', 'examine_subagent', 'review_subagent',
  // UI 只读探索（ui-test:read）：旧会话若持久化过这些名字，恢复时静默裁剪而不是
  // 拒绝；同时它们永远不进默认激活集，恢复不会静默获得新工具。
  'ui_snapshot', 'ui_find', 'ui_screenshot', 'ui_wait', 'ui_assert',
  // UI 写探索（ui-test:write）：同上——写工具更不允许在恢复时静默获得，未授予能力
  // 的会话里这些名字被静默裁剪（不拒绝恢复）。
  'ui_navigate', 'ui_click', 'ui_input', 'ui_select', 'ui_press',
  // API 探索（api-test:request）：同上——出网工具更不允许在恢复时静默获得，未授予能力
  // 的会话里该名字被静默裁剪（不拒绝恢复）。
  'api_request',
])

export const projectSessionActiveToolNames = (
  restored: readonly string[] | undefined,
  tools: readonly AgentTool[],
  required: readonly string[],
): string[] => {
  const registered = new Set(tools.map((tool) => tool.name))
  const migrated = (restored ?? []).map(migrateToolName)
  const unknown = migrated.filter((name) => !registered.has(name) && !CAPABILITY_GATED_TOOL_NAMES.has(name))
  if (unknown.length > 0) throw new Error(`Session 活动工具未注册：${unknown.join(', ')}`)
  const projected = Array.from(new Set(migrated.filter((name) => registered.has(name))))
  for (const name of required) {
    if (!registered.has(name)) throw new Error(`Session 必需工具未注册：${name}`)
  }
  return [...required.filter((name) => !projected.includes(name)), ...projected]
}
