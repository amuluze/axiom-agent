import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { SshHostsPanel } from './SshHostsPanel'
import { SshTerminalPanel } from './SshTerminalPanel'

/**
 * SSH 独立全窗口视图（设计稿「Axiom — SSH · 1180×780」，侧栏导航「SSH」入口）：
 * 左侧主机管理（340px）+ 右侧远程终端同屏分栏。SSH 自运行时面板迁出后
 * 不再作为 rail 标签页出现（picker 只保留浏览器/电脑控制）。
 *
 * - 窗口栏：仅可拖拽区（macOS 交通灯由系统绘制，前端不绘按钮/标题）；
 *   返回键在左栏主机管理上方（SshHostsPanel 的 onBack），SSH 视图退出靠它。
 * - 主机/终端状态投影与宿主通道全部复用 sshStore（见 SshHostsPanel / 
 *   SshTerminalPanel），本组件只负责布局与窗口栏接线。
 */
export const SshView = () => {
  const setView = useUiStore((state) => state.setView)

  /** 返回打开的视图：有激活会话回会话页，否则回新任务页（与 Close 同语义）。 */
  const exitSshView = (): void => {
    setView(useAgentStore.getState().activeSessionId ? 'session' : 'new-task')
  }

  return (
    <div className="sshview">
      <div className="sshview__windowbar" data-tauri-drag-region />
      <div className="sshview__body">
        <SshHostsPanel onBack={exitSshView} />
        <div className="sshview__divider" aria-hidden />
        <SshTerminalPanel />
      </div>
    </div>
  )
}
