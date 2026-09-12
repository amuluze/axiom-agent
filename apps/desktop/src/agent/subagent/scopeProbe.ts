import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'

/**
 * scope 存在性执行前快速校验：在子 agent 启动前确认 scope 引用的路径确实位于
 * 授权工作区内，避免子 agent 按任务目录（而非授权工作区根）猜结构，空转多轮后
 * 才发现路径不存在。
 *
 * 这是附加防御：安全边界仍由 Rust 的 authorized_root_for 强制，这里只负责
 * "尽早失败 + 给出可诊断的错误"。探测不依赖 Rust 错误文案——list 失败后用
 * readText 回退确认路径是否为文件，误判最多导致本应通过的请求被拒绝或退回
 * 原空转行为，不会引入越权风险。
 */
export interface ScopeProbeResult {
  /** 判定为不存在或解析到授权工作区外的 scope 条目（原样相对路径）。 */
  invalid: string[]
}

/**
 * 单个 scope 条目是否在授权工作区内存在。
 * - workspace.list 成功 → 存在（目录）。
 * - list 失败后 readText 成功 → 路径存在但是文件（scope 允许文件路径），有效。
 * - list 与 readText 均失败 → 无法确认存在 → fail-closed。
 *
 * 不依赖 Rust 错误文案区分"文件"与"不存在"，避免 Rust 侧文案漂移导致静默失配。
 */
const scopeEntryExists = async (environment: AgentEnvironment, entry: string): Promise<boolean> => {
  try {
    await environment.workspace.list(entry)
    return true
  } catch {
    try {
      await environment.workspace.readText(entry, 0, 1)
      return true
    } catch {
      return false
    }
  }
}

export const probeScopeEntries = async (
  environment: AgentEnvironment,
  scope: string[],
): Promise<ScopeProbeResult> => {
  const invalid: string[] = []
  for (const entry of scope) {
    if (!(await scopeEntryExists(environment, entry))) invalid.push(entry)
  }
  return { invalid }
}
