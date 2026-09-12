import { useAgentStore } from '@/stores/agentStore'
import { useTerminalStore } from '@/stores/terminalStore'

/**
 * 监视已授权工作区集合，对从集合中消失的工作区清理其终端条目与承载 DOM。
 *
 * 职责边界：Rust 侧 `revoke_workspace` → `TerminalState::kill_for_workspace` 是权威回收
 * （结束该工作区的 PTY 进程）；本模块只做前端状态与 DOM 的幂等清理，不依赖后端回调顺序。
 * 撤销后迟到的 PTY 事件由 `terminalId` 守卫丢弃，不会复活已清条目
 * （`.specs/tasks/terminal-per-workspace.md` 验收 6）。
 *
 * 终端运行时**动态导入**：它静态依赖 xterm（模块顶层引用浏览器全局），而本模块被
 * App 在启动期静态引入；静态连边会把 xterm 拉进主包并在 node 测试环境直接报
 * `self is not defined`（终端面板本身也是 lazy 加载的，意图就是让 xterm 不进启动图）。
 *
 * 返回取消订阅函数；在应用层调用一次即可（重复调用会叠加订阅）。
 */
export const watchAuthorizedWorkspaces = (): (() => void) => {
  let previous = new Set(useAgentStore.getState().authorizedWorkspaces.map((workspace) => workspace.path))
  return useAgentStore.subscribe((state) => {
    const next = new Set(state.authorizedWorkspaces.map((workspace) => workspace.path))
    for (const workspacePath of previous) {
      if (next.has(workspacePath)) continue
      // 同步捕获撤销那一刻的终端身份：清理经动态导入是异步的，期间用户可能重新授权并
      // 激活同一工作区（已新建终端），按 id 守卫后不会误杀新实例。
      const revokedTerminalId = useTerminalStore.getState().entries[workspacePath]?.terminalId
      void import('./terminalRuntime').then((runtime) => {
        if (useTerminalStore.getState().entries[workspacePath]?.terminalId !== revokedTerminalId) return
        runtime.disposeTerminal(workspacePath)
      })
    }
    previous = next
  })
}
