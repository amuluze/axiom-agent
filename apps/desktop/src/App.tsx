import {
  lazy,
  Suspense,
  useEffect,
  type ReactNode,
} from 'react'
import { PanelLeft } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { watchAuthorizedWorkspaces } from '@/components/terminal/terminalWorkspaceWatch'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { useResponsiveSidebar } from '@/components/sidebar/useResponsiveSidebar'
import { useViewRouter } from '@/components/shell/useViewRouter'
import { resolveViewRender } from '@/components/shell/viewRouter'
import { NewTaskView } from '@/components/new-task/NewTaskView'
import { SummaryInstructionsDialog } from '@/components/SummaryInstructionsDialog'
import { FeedbackDialog } from '@/components/feedback/FeedbackDialog'
import { ImageLightbox } from '@/components/session/ImageLightbox'
import { useT } from '@/i18n'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'

const SessionView = lazy(async () => {
  const module = await import('@/components/session/SessionView')
  return { default: module.SessionView }
})

const SettingsView = lazy(async () => {
  const module = await import('@/components/settings/SettingsView')
  return { default: module.SettingsView }
})

const SshView = lazy(async () => {
  const module = await import('@/components/runtime/SshView')
  return { default: module.SshView }
})

const TerminalPanel = lazy(async () => {
  const module = await import('@/components/terminal/WorkspaceTerminalPanel')
  return { default: module.WorkspaceTerminalPanel }
})

const ConnectPanel = lazy(async () => {
  const module = await import('@/components/connect/ConnectPanel')
  return { default: module.ConnectPanel }
})

const RuntimeRail = lazy(async () => {
  const module = await import('@/components/runtime/RuntimeRail')
  return { default: module.RuntimeRail }
})

const ShellLayout = ({ children }: { children: ReactNode }) => {
  const { t } = useT()
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const sidebarCompact = useUiStore((state) => state.sidebarCompact)
  const sidebarOverlayOpen = useUiStore((state) => state.sidebarOverlayOpen)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const terminalPanelOpen = useUiStore((state) => state.terminalPanelOpen)
  const connectPanelOpen = useUiStore((state) => state.connectPanelOpen)
  const runtimeRailOpen = useUiStore((state) => state.runtimeRailOpen)
  const runtimeRailWidth = useUiStore((state) => state.runtimeRailWidth)
  useResponsiveSidebar()
  const sidebarHidden = sidebarCollapsed || sidebarCompact
  return (
    <div className={`app-shell ${sidebarHidden ? 'app-shell--no-sidebar' : ''}`}>
      {sidebarHidden && (
        <button
          type="button"
          aria-label={t('app.sidebar.reopenAria')}
          className="app-shell__reopen"
          onClick={toggleSidebar}
        >
          <PanelLeft size={16} />
        </button>
      )}
      {!sidebarHidden && <Sidebar />}
      {sidebarCompact && sidebarOverlayOpen && <Sidebar variant="overlay" />}
      {connectPanelOpen && (
        <Suspense fallback={null}>
          <ConnectPanel />
        </Suspense>
      )}
      <main className={`app-main ${sidebarHidden ? 'app-main--sidebar-hidden' : ''}`}>
        <div
          className="app-main__body"
          // rail 的宽度与把手定位都由该变量驱动（拖拽/键盘调宽经 uiStore 更新），
          // 视图内容与 aside 同源消费，避免两侧宽度不一致。
          style={{ '--rail-current-width': `${runtimeRailWidth}px` } as React.CSSProperties}
        >
          <div className="app-main__content">{children}</div>
          {runtimeRailOpen && (
            <Suspense fallback={null}>
              <RuntimeRail />
            </Suspense>
          )}
        </div>
        {terminalPanelOpen && (
          <Suspense fallback={null}>
            <TerminalPanel />
          </Suspense>
        )}
      </main>
    </div>
  )
}

export const App = () => {
  const { t } = useT()
  const providerReady = useAgentStore((state) => state.providerReady)
  const pendingApproval = useAgentStore((state) => state.pendingApproval)
  const branchFromMessage = useAgentStore((state) => state.branchFromMessage)
  const compactContext = useAgentStore((state) => state.compactContext)
  const view = useUiStore((state) => state.view)
  const terminalPanelOpen = useUiStore((state) => state.terminalPanelOpen)
  const summaryRequest = useUiStore((state) => state.summaryRequest)
  const setSummaryRequest = useUiStore((state) => state.setSummaryRequest)
  const feedbackRequest = useUiStore((state) => state.feedbackRequest)
  useViewRouter()
  // 定期刷新已授权工作区的 git 分支显示：分支在外部（终端/IDE）切换后，
  // 输入框与侧边栏的分支名跟随更新（Rust 实时读 .git/HEAD，开销极小）。
  useEffect(() => {
    const refresh = (): void => {
      void useAgentStore.getState().refreshWorkspaceBranchInfo()
    }
    refresh()
    // 撤销工作区授权时清理其终端条目与承载 DOM（Rust 侧 kill_for_workspace 是权威回收）。
    const unwatchWorkspaces = watchAuthorizedWorkspaces()
    const interval = window.setInterval(refresh, 10_000)
    window.addEventListener('focus', refresh)
    return () => {
      unwatchWorkspaces()
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const { settingsScreen, shell, session, ssh } = resolveViewRender(view)

  const submitSummaryInstructions = (options: SummaryInstructionOptions): void => {
    const request = summaryRequest
    setSummaryRequest(null)
    if (!request) return
    if (request.mode === 'compaction') void compactContext(options)
    else void branchFromMessage(request.messageId, true, options)
  }

  const content = settingsScreen
    ? (
      <Suspense fallback={<div className="settings-overlay" role="status">{t('app.settings.loadingFallback')}</div>}>
        <SettingsView blocking={!providerReady} />
      </Suspense>
    )
    : ssh
      ? (
        // SSH 独立全窗口视图：与设置页同级（不挂 ShellLayout 侧栏）；终端
        // 面板开关在视图窗口栏，面板本体由该开关门控（与 ShellLayout 同款）。
        <div className="ssh-view-shell">
          <Suspense fallback={null}>
            <SshView />
          </Suspense>
          {terminalPanelOpen && (
            <Suspense fallback={null}>
              <TerminalPanel />
            </Suspense>
          )}
        </div>
      )
      : (
        <ShellLayout>
          {shell && session ? (
            <Suspense fallback={null}>
              <SessionView />
            </Suspense>
          ) : <NewTaskView />}
        </ShellLayout>
      )
  return (
    <>
      {content}
      <ImageLightbox />
      <SummaryInstructionsDialog
        mode={pendingApproval ? null : summaryRequest?.mode ?? null}
        onCancel={() => setSummaryRequest(null)}
        onSubmit={submitSummaryInstructions}
      />
      {feedbackRequest && <FeedbackDialog request={feedbackRequest} />}
    </>
  )
}
