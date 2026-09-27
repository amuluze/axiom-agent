import { Suspense, lazy, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useConnectStore } from '@/stores/connectStore'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  sidebarMaxWidth,
  useUiStore,
} from '@/stores/uiStore'
import { useDesignAgentPreview, useDesignConnectPreview, useDesignUiPreview } from '@/components/design/ax/previewContext'
import { DingtalkIcon, FeishuIcon, getPlatformLabel, WeixinIcon } from '@/components/connect/ConnectIcons'
import type { ConnectPlatform } from '@/platform/connect'
import {
  Archive,
  CircleArrowDown,
  CirclePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  PanelLeft,
  PenTool,
  SendHorizontal,
  Settings,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import type { StoredAgentSession } from '@/persistence/types'
import { useT, type TFunction } from '@/i18n'
import { displaySessionTitle } from '@/i18n/sessionTitle'

// 设计助手侧栏懒加载：设计视图专用，Composer/消息流的 chunk 不进主包。
const DesignAssistantPanel = lazy(async () => {
  const module = await import('@/components/design/DesignAssistantPanel')
  return { default: module.default }
})

/** 侧边栏头像里的小号平台图标（固定 9px，两枚并排 + 状态点刚好放下）。 */
const CONNECT_ICONS_SMALL: Record<ConnectPlatform, ReactNode> = {
  feishu: <FeishuIcon size={9} />,
  dingtalk: <DingtalkIcon size={9} />,
  weixin: <WeixinIcon size={9} />,
}

/** 平台展示顺序固定（与面板卡片一致），不受 store 数组顺序影响。 */
const CONNECT_PLATFORM_ORDER: ConnectPlatform[] = ['feishu', 'dingtalk', 'weixin']

/** 键盘调整步长（px）：resizer 聚焦后 ArrowLeft/ArrowRight 增减宽度（对齐 RuntimeRail）。 */
const KEYBOARD_RESIZE_STEP = 16
/** 拖拽期间挂在 <html> 上的类名：全局 col-resize 光标 + 禁止文本选择。 */
const RESIZING_CLASS = 'sidebar--resizing'

interface SidebarWorkspaceGroup {
  key: string
  path: string | null
  name: string
  gitBranch: string | null
  authorized: boolean
  sessions: StoredAgentSession[]
}

const workspaceGroups = (
  sessions: StoredAgentSession[],
  authorizedWorkspaces: Array<{ path: string; name: string; gitBranch?: string | null }>,
  t: TFunction,
): SidebarWorkspaceGroup[] => {
  const groups = new Map<string, SidebarWorkspaceGroup>()
  for (const workspace of authorizedWorkspaces) {
    groups.set(workspace.path, {
      key: workspace.path,
      path: workspace.path,
      name: workspace.name,
      gitBranch: workspace.gitBranch ?? null,
      authorized: true,
      sessions: [],
    })
  }
  for (const session of sessions) {
    const workspace = session.workspace
    const key = workspace?.path ?? '__unbound__'
    const group = groups.get(key) ?? {
      key,
      path: workspace?.path ?? null,
      name: workspace?.name ?? t('app.sidebar.workspaceUnbound'),
      gitBranch: workspace?.gitBranch ?? null,
      authorized: false,
      sessions: [],
    }
    group.sessions.push(session)
    groups.set(key, group)
  }
  if (groups.size === 0) {
    groups.set('__empty__', {
      key: '__empty__',
      path: null,
      name: t('app.sidebar.workspaceNone'),
      gitBranch: null,
      authorized: false,
      sessions: [],
    })
  }
  const authorizedPaths = new Set(authorizedWorkspaces.map((workspace) => workspace.path))
  return Array.from(groups.values())
    .filter((group) => {
      // 工作目录被撤销授权后，session 列表里仍可能引用旧 path。
      // 隐藏整组（包括其下 session 列表），避免与"已移除但数据库未清"
      // 的中间态出现视觉错位。__empty__ 保留为无工作区时的占位提示，
      // __unbound__（未绑定工作目录的会话）按需求不显示在工作区列表中。
      if (group.key === '__empty__') return true
      if (group.path === null) return false
      return authorizedPaths.has(group.path)
    })
    .map((group) => ({
      ...group,
      sessions: group.sessions.slice().sort((left, right) => right.updatedAt - left.updatedAt),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

export interface SidebarProps {
  variant?: 'default' | 'overlay'
}

export const Sidebar = ({ variant = 'default' }: SidebarProps = {}) => {
  const { t } = useT()
  // 预览接缝（design canvas 真组件渲染，docs/ax-format.md §4.2）：三 store 切片在
  // 画布内提供数据与 no-op 动作；画布外为 null，取值与改写前逐字节一致。
  // 惯用法：store hook 无条件调用，只在取值上分支——不能条件调用 hook。
  const agentPreview = useDesignAgentPreview()
  const uiPreview = useDesignUiPreview()
  const connectPreview = useDesignConnectPreview()
  const storeSessions = useAgentStore((state) => state.sessions)
  const sessions = agentPreview?.sessions ?? storeSessions
  const storeActiveSessionId = useAgentStore((state) => state.activeSessionId)
  const activeSessionId = agentPreview?.activeSessionId ?? storeActiveSessionId
  const storeAwaitingApprovalSessionIds = useAgentStore((state) => state.awaitingApprovalSessionIds)
  const awaitingApprovalSessionIds = agentPreview?.awaitingApprovalSessionIds ?? storeAwaitingApprovalSessionIds
  const storeAuthorizedWorkspace = useAgentStore((state) => state.authorizedWorkspace)
  const authorizedWorkspace = agentPreview?.authorizedWorkspace ?? storeAuthorizedWorkspace
  const storeAuthorizedWorkspaces = useAgentStore((state) => state.authorizedWorkspaces)
  const authorizedWorkspaces = agentPreview?.authorizedWorkspaces ?? storeAuthorizedWorkspaces
  const storeSelectSession = useAgentStore((state) => state.selectSession)
  const selectSession = agentPreview?.selectSession ?? storeSelectSession
  const storeCreateNewSession = useAgentStore((state) => state.createNewSession)
  const createNewSession = agentPreview?.createNewSession ?? storeCreateNewSession
  const storeAddWorkspace = useAgentStore((state) => state.addWorkspace)
  const addWorkspace = agentPreview?.addWorkspace ?? storeAddWorkspace
  const storeActivateWorkspace = useAgentStore((state) => state.activateWorkspace)
  const activateWorkspace = agentPreview?.activateWorkspace ?? storeActivateWorkspace
  const storeRevokeWorkspace = useAgentStore((state) => state.revokeWorkspace)
  const revokeWorkspace = agentPreview?.revokeWorkspace ?? storeRevokeWorkspace
  const storeArchiveSession = useAgentStore((state) => state.archiveSession)
  const archiveSession = agentPreview?.archiveSession ?? storeArchiveSession
  const storeStopSession = useAgentStore((state) => state.stopSession)
  const stopSession = agentPreview?.stopSession ?? storeStopSession
  const storeSendToSession = useAgentStore((state) => state.sendToSession)
  const sendToSession = agentPreview?.sendToSession ?? storeSendToSession
  const storeReleaseQueuedForSession = useAgentStore((state) => state.releaseQueuedForSession)
  const releaseQueuedForSession = agentPreview?.releaseQueuedForSession ?? storeReleaseQueuedForSession
  const storeSessionQueueCounts = useAgentStore((state) => state.sessionQueueCounts)
  const sessionQueueCounts = agentPreview?.sessionQueueCounts ?? storeSessionQueueCounts
  const storeToggleSidebar = useUiStore((state) => state.toggleSidebar)
  const toggleSidebar = uiPreview?.toggleSidebar ?? storeToggleSidebar
  const storeSidebarWidth = useUiStore((state) => state.sidebarWidth)
  const sidebarWidth = uiPreview?.sidebarWidth ?? storeSidebarWidth
  const storeSetSidebarWidth = useUiStore((state) => state.setSidebarWidth)
  const setSidebarWidth = uiPreview?.setSidebarWidth ?? storeSetSidebarWidth
  const storeSetView = useUiStore((state) => state.setView)
  const setView = uiPreview?.setView ?? storeSetView
  const storeSetSettingsSection = useUiStore((state) => state.setSettingsSection)
  const setSettingsSection = uiPreview?.setSettingsSection ?? storeSetSettingsSection
  const storeCloseSidebarOverlay = useUiStore((state) => state.closeSidebarOverlay)
  const closeSidebarOverlay = uiPreview?.closeSidebarOverlay ?? storeCloseSidebarOverlay
  const storeView = useUiStore((state) => state.view)
  const view = uiPreview?.view ?? storeView
  const storeAvailableUpdate = useUiStore((state) => state.availableUpdate)
  const availableUpdate = uiPreview?.availableUpdate ?? storeAvailableUpdate
  const storeSetConnectPanelOpen = useUiStore((state) => state.setConnectPanelOpen)
  const setConnectPanelOpen = uiPreview?.setConnectPanelOpen ?? storeSetConnectPanelOpen
  const storeConnectPanelOpen = useUiStore((state) => state.connectPanelOpen)
  const connectPanelOpen = uiPreview?.connectPanelOpen ?? storeConnectPanelOpen
  const storeConnectPlatforms = useConnectStore((state) => state.config.platforms)
  const connectPlatforms = connectPreview?.config?.platforms ?? storeConnectPlatforms
  const storeConnectBindingsCount = useConnectStore((state) => state.config.bindings.length)
  const connectBindingsCount = connectPreview?.config?.bindings.length ?? storeConnectBindingsCount
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set())
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set())
  // 后台快捷发送：当前展开输入的目标会话 id。一次只展开一行，切换目标即重置草稿。
  const [quickSendId, setQuickSendId] = useState<string | null>(null)
  const [quickSendDraft, setQuickSendDraft] = useState('')
  // 把手拖拽起点：pointer down 时记录，move 期间计算增量（对齐 RuntimeRail）。
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [quickSendSending, setQuickSendSending] = useState(false)

  // 后台快捷发送：非激活、且绑定仍在授权集内的工作目录——与 sendToSession 的
  // gating 同口径（激活会话用前台 composer；工作区被撤销的会话不可发）。
  // 运行中的后台会话可发：消息作为 steering 排队，在下一个 turn 边界注入。
  const authorizedWorkspacePaths = useMemo(
    () => new Set(authorizedWorkspaces.map((workspace) => workspace.path)),
    [authorizedWorkspaces],
  )
  const canQuickSend = (stored: StoredAgentSession): boolean => (
    stored.id !== activeSessionId
    && Boolean(stored.workspace && authorizedWorkspacePaths.has(stored.workspace.path))
  )

  const submitQuickSend = async (event: FormEvent, sessionId: string) => {
    event.preventDefault()
    const content = quickSendDraft.trim()
    if (!content || quickSendSending) return
    setQuickSendSending(true)
    try {
      // 成功发起才收起输入；失败保持打开（错误已写入该会话投影，切回可见），
      // 保留草稿便于重试。await 的是整个后台 run——期间按钮显示运行中，
      // Escape 可随时收起输入而不影响 run。
      if (await sendToSession(sessionId, content)) {
        setQuickSendId(null)
        setQuickSendDraft('')
      }
    } finally {
      setQuickSendSending(false)
    }
  }
  const groups = useMemo(
    () => workspaceGroups(sessions, authorizedWorkspaces, t),
    [authorizedWorkspaces, sessions, t],
  )

  // 侧边栏连接入口的投影：只反映「有没有平台连着 / 配对了几个聊天」，
  // 详情仍在面板里看。状态点优先级：已连接 > 连接中 > 异常 > 已配置未连接。
  const connectedPlatforms = CONNECT_PLATFORM_ORDER.filter((platform) =>
    connectPlatforms.some((item) => item.platform === platform && item.status === 'connected'),
  )
  const connectHasConnecting = connectPlatforms.some((item) => item.status === 'connecting')
  const connectHasError = connectPlatforms.some((item) => item.status === 'error')
  const connectHasConfigured = connectPlatforms.some((item) => item.configured)
  const connectDotClass = connectedPlatforms.length > 0
    ? 'sidebar__connect-dot--connected'
    : connectHasConnecting
      ? 'sidebar__connect-dot--connecting'
      : connectHasError
        ? 'sidebar__connect-dot--error'
        : connectHasConfigured
          ? 'sidebar__connect-dot--configured'
          : null
  const connectTitle = connectedPlatforms.length > 0
    ? t('app.sidebar.connectConnected', { platforms: connectedPlatforms.map((platform) => getPlatformLabel(platform, t)).join('、') }) +
      (connectBindingsCount > 0 ? t('app.sidebar.connectBindings', { count: connectBindingsCount }) : '') +
      (connectHasError ? t('app.sidebar.connectPartialError') : '')
    : connectHasError
      ? t('app.sidebar.connectError')
      : connectHasConnecting
        ? t('app.sidebar.connectConnecting')
        : t('app.sidebar.connectConfigured')

  const selectTask = async (sessionId: string): Promise<void> => {
    const selected = await selectSession(sessionId)
    if (!selected && sessionId !== activeSessionId) return
    setView('session')
    closeSidebarOverlay()
  }



  const toggleKey = (
    setter: (value: Set<string>) => void,
    current: Set<string>,
    key: string,
  ): void => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  // 设计视图整页独占：侧栏切成设计助手（设计稿 XjPQ 的侧栏覆写形态）。
  const designMode = view === 'design'
  const sidebarClass = variant === 'overlay' ? 'sidebar sidebar--overlay' : 'sidebar'
  const titlebarClass = variant === 'overlay'
    ? 'sidebar__titlebar sidebar__titlebar--overlay'
    : 'sidebar__titlebar'

  // 右缘拖拽把手：pointer capture 保证指针移出把手仍持续收到 move/up；sidebar
  // 靠左，向右拖增大宽度。clamp 集中在 uiStore 的 setSidebarWidth。
  const onResizerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.currentTarget.setPointerCapture) return
    event.preventDefault()
    dragStateRef.current = { startX: event.clientX, startWidth: sidebarWidth }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      dragStateRef.current = null
      return
    }
    document.documentElement.classList.add(RESIZING_CLASS)
  }

  const onResizerPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragStateRef.current
    if (!drag) return
    const next = drag.startWidth + (event.clientX - drag.startX)
    if (next !== useUiStore.getState().sidebarWidth) setSidebarWidth(next)
  }

  const onResizerPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStateRef.current) return
    dragStateRef.current = null
    document.documentElement.classList.remove(RESIZING_CLASS)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onResizerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP
    setSidebarWidth(useUiStore.getState().sidebarWidth + delta)
  }

  const resizer = variant === 'default' && (
    <div
      className="sidebar__resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('app.sidebar.resizerAria')}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={sidebarMaxWidth()}
      aria-valuenow={sidebarWidth}
      tabIndex={0}
      onPointerDown={onResizerPointerDown}
      onPointerMove={onResizerPointerMove}
      onPointerUp={onResizerPointerEnd}
      onPointerCancel={onResizerPointerEnd}
      onKeyDown={onResizerKeyDown}
      onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
    />
  )

  const inner = (
    <nav aria-label={t('app.sidebar.aria')} className={sidebarClass}>
      <div className={titlebarClass} data-tauri-drag-region>
        <div className="sidebar__titlebar-actions">
          {availableUpdate && (
            <button
              type="button"
              className="sidebar__icon-button sidebar__icon-button--update"
              aria-label={t('app.sidebar.updateAvailable', { version: availableUpdate.version })}
              title={t('app.sidebar.updateAvailable', { version: availableUpdate.version })}
              onClick={() => {
                setSettingsSection('about')
                setView('settings')
                closeSidebarOverlay()
              }}
            >
              <CircleArrowDown size={16} />
            </button>
          )}
          <button
            type="button"
            className="sidebar__icon-button"
            aria-label={t('app.sidebar.collapse')}
            onClick={toggleSidebar}
          >
            <PanelLeft size={16} />
          </button>
        </div>
      </div>
      {designMode ? (
        // 设计页侧栏（.pen 设计稿 XjPQ 覆写）：Nav / 工作区 / 任务列表 / 底栏
        // 全部让位给设计助手面板，仅保留 Title Bar（红绿灯区 + 收起按钮）。
        <Suspense fallback={null}>
          <DesignAssistantPanel />
        </Suspense>
      ) : (
        <>
      <div className="sidebar__nav">
        <button
          type="button"
          className={`sidebar__nav-item ${view === 'new-task' ? 'sidebar__nav-item--active' : ''}`}
          onClick={() => {
            const create = authorizedWorkspace
              ? createNewSession(authorizedWorkspace.path)
              : addWorkspace()
            void create.then((created) => {
              if (!created) return
              setView('new-task')
              closeSidebarOverlay()
            })
          }}
        >
          <CirclePlus size={15} className="sidebar__nav-item-icon" />
          <span>{t('app.sidebar.newTask')}</span>
          <span className="sidebar__nav-item-spacer" />
          <span className="sidebar__nav-item-shortcut">⌘⇧N</span>
        </button>
        <button
          type="button"
          className="sidebar__nav-item"
          title={t('app.sidebar.skillsTitle')}
          onClick={() => {
            setSettingsSection('skills')
            setView('settings')
            closeSidebarOverlay()
          }}
        >
          <Sparkles size={15} className="sidebar__nav-item-icon" />
          <span>{t('app.sidebar.skills')}</span>
        </button>
        <button
          type="button"
          className={`sidebar__nav-item ${designMode ? 'sidebar__nav-item--active' : ''}`}
          onClick={() => {
            setView('design')
            closeSidebarOverlay()
          }}
        >
          <PenTool size={15} className="sidebar__nav-item-icon" />
          <span>{t('app.sidebar.design')}</span>
        </button>
      </div>
      <div className="sidebar__workspace-header">
        <span>{t('app.sidebar.workspaces')}</span>
        <button
          aria-label={t('app.sidebar.addWorkspace')}
          className="sidebar__workspace-add"
          onClick={() => { void addWorkspace() }}
          title={t('app.sidebar.addWorkspace')}
          type="button"
        >
          <FolderPlus size={14} />
        </button>
      </div>
      <div className="sidebar__workspace-list">
        {groups.map((group) => {
          const activeSessions = group.sessions.filter((stored) => !stored.archivedAt)
          const hasRunningSessions = group.sessions.some((stored) => stored.status === 'running')
          const expanded = expandedWorkspaces.has(group.key)
          const collapsed = collapsedWorkspaces.has(group.key)
          const visibleSessions = expanded ? activeSessions : activeSessions.slice(0, 5)
          return (
            <section className="sidebar__workspace-group" key={group.key}>
              <div
                className={`sidebar__project-row ${authorizedWorkspace?.path === group.path ? 'sidebar__project-row--active' : ''}`}
                role="button"
                tabIndex={group.path ? 0 : -1}
                onClick={() => {
                  if (!group.path) return
                  // 展开/收起控制扩展到整行：点击行内任意位置（操作按钮除外）
                  // 都切换会话列表显隐，同时保留原有的激活工作目录行为。
                  toggleKey(setCollapsedWorkspaces, collapsedWorkspaces, group.key)
                  void activateWorkspace(group.path)
                }}
                onKeyDown={(event) => {
                  if (!group.path) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggleKey(setCollapsedWorkspaces, collapsedWorkspaces, group.key)
                    void activateWorkspace(group.path)
                  }
                }}
                aria-disabled={!group.path}
                aria-label={group.path ? t('app.sidebar.toggleWorkspaceAria', { name: group.name }) : group.name}
              >
                {group.path ? (
                  <button
                    type="button"
                    className="sidebar__project-folder-toggle"
                    aria-label={collapsed ? t('app.sidebar.expandWorkspaceAria', { name: group.name }) : t('app.sidebar.collapseWorkspaceAria', { name: group.name })}
                    title={collapsed ? t('app.sidebar.expandWorkspaceTitle') : t('app.sidebar.collapseWorkspaceTitle')}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleKey(setCollapsedWorkspaces, collapsedWorkspaces, group.key)
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}
                  </button>
                ) : (
                  <Folder size={15} />
                )}
                <span className="sidebar__project-name">{group.name}</span>
                {group.gitBranch && <span className="sidebar__project-branch">{group.gitBranch}</span>}
                {/* 授权态点已移除：未授权工作区整组隐藏，绿点恒亮不携带信息。
                    现在仅在该工作目录下有运行中会话时亮起，提示后台活动。 */}
                {group.path && hasRunningSessions && (
                  <span
                    className="sidebar__workspace-state sidebar__workspace-state--running"
                    title={t('app.sidebar.workspaceRunningTitle')}
                  />
                )}
                {group.path && group.authorized && (
                  <span
                    className="sidebar__project-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      aria-label={t('app.sidebar.newSessionIn', { name: group.name })}
                      title={t('app.sidebar.newSessionTitle')}
                      className="sidebar__workspace-new-session"
                      onClick={() => {
                        const workspacePath = group.path
                        if (!workspacePath) return
                        void createNewSession(workspacePath).then((created) => {
                          if (!created) return
                          setView('new-task')
                          closeSidebarOverlay()
                        })
                      }}
                    >
                      <MessageSquarePlus size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('app.sidebar.removeWorkspaceAria', { name: group.name })}
                      title={t('app.sidebar.removeWorkspaceTitle')}
                      onClick={() => {
                        if (!group.path) return
                        // 预览态（画布评审）不弹原生 confirm：撤销动作本身已是 no-op，
                        // 原生对话框是不经 store 的真副作用，必须一并挡住。
                        if (agentPreview) return
                        const confirmed = window.confirm(
                          t('app.sidebar.removeWorkspaceConfirm', { name: group.name }),
                        )
                        if (!confirmed) return
                        void revokeWorkspace(group.path)
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </div>
              {!collapsed && (
                <>
                  <div className="sidebar__task-list">
                    {visibleSessions.map((stored) => (
                      <div
                        className={`sidebar__task-row ${stored.id === activeSessionId ? 'sidebar__task-row--active' : ''}`}
                        key={stored.id}
                      >
                        <button
                          type="button"
                          className="sidebar__task-row-main"
                          onClick={() => { void selectTask(stored.id) }}
                        >
                          {stored.status === 'running' && <span className="sidebar__task-running" title={t('app.sidebar.taskRunningTitle')} />}
                          {(sessionQueueCounts[stored.id] ?? 0) > 0 && (
                            <span
                              className="sidebar__task-queued"
                              title={t('app.sidebar.taskQueuedTitle', { count: sessionQueueCounts[stored.id] })}
                            >
                              {sessionQueueCounts[stored.id]}
                            </span>
                          )}
                          {awaitingApprovalSessionIds.includes(stored.id) && (
                            <span className="sidebar__task-awaiting-approval" title={t('app.sidebar.taskAwaitingTitle')}>
                              {t('app.sidebar.taskAwaitingApproval')}
                            </span>
                          )}
                          <span className="sidebar__task-row-title">
                            {displaySessionTitle(t, stored.title)}
                          </span>
                        </button>
                        <div className="sidebar__task-actions">
                          {canQuickSend(stored) && (sessionQueueCounts[stored.id] ?? 0) > 0 && (
                            <button
                              type="button"
                              aria-label={t('app.sidebar.releaseQueuedAria', { title: displaySessionTitle(t, stored.title) })}
                              title={t(stored.status === 'running'
                                ? 'app.sidebar.releaseQueuedRunningTitle'
                                : 'app.sidebar.releaseQueuedTitle')}
                              onClick={() => { void releaseQueuedForSession(stored.id) }}
                            >
                              <SendHorizontal size={13} />
                            </button>
                          )}
                          {canQuickSend(stored) && (
                            <button
                              type="button"
                              aria-label={t('app.sidebar.quickSendAria', { title: displaySessionTitle(t, stored.title) })}
                              title={t(stored.status === 'running'
                                ? 'app.sidebar.quickSendRunningTitle'
                                : 'app.sidebar.quickSendTitle')}
                              onClick={() => {
                                setQuickSendDraft('')
                                setQuickSendId(quickSendId === stored.id ? null : stored.id)
                              }}
                            >
                              <MessageSquarePlus size={13} />
                            </button>
                          )}
                          {stored.status === 'running' && (
                            <button
                              type="button"
                              aria-label={t('app.sidebar.stopAria', { title: displaySessionTitle(t, stored.title) })}
                              title={t('app.sidebar.stopTitle')}
                              onClick={() => { void stopSession(stored.id) }}
                            >
                              <Square size={13} />
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={t('app.sidebar.archiveAria', { title: displaySessionTitle(t, stored.title) })}
                            title={stored.status === 'running' ? t('app.sidebar.archiveDisabledTitle') : t('app.sidebar.archiveTitle')}
                            disabled={stored.status === 'running'}
                            onClick={() => { void archiveSession(stored.id) }}
                          >
                            <Archive size={13} />
                          </button>
                        </div>
                        {quickSendId === stored.id && (
                          <form
                            className="sidebar__task-quick-send"
                            onSubmit={(event) => { void submitQuickSend(event, stored.id) }}
                          >
                            <input
                              aria-label={t('app.sidebar.quickSendInputAria', { title: displaySessionTitle(t, stored.title) })}
                              autoFocus
                              onChange={(event) => setQuickSendDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  setQuickSendId(null)
                                  setQuickSendDraft('')
                                }
                              }}
                              placeholder={t(stored.status === 'running'
                                ? 'app.sidebar.quickSendRunningPlaceholder'
                                : 'app.sidebar.quickSendPlaceholder')}
                              value={quickSendDraft}
                            />
                            <button disabled={quickSendSending || !quickSendDraft.trim()} type="submit">
                              {quickSendSending ? t('app.sidebar.quickSendSending') : t('app.sidebar.quickSendSend')}
                            </button>
                          </form>
                        )}
                      </div>
                    ))}
                  </div>
                  {activeSessions.length > 5 && (
                    <button
                      type="button"
                      className="sidebar__show-more"
                      onClick={() => toggleKey(setExpandedWorkspaces, expandedWorkspaces, group.key)}
                    >
                      {expanded ? t('app.sidebar.collapseMore') : t('app.sidebar.showMore', { count: activeSessions.length - 5 })}
                    </button>
                  )}
                </>
              )}
            </section>
          )
        })}
      </div>
      <div className="sidebar__spacer" />
      <div className="sidebar__bottom-bar">
        <button
          type="button"
          className={`sidebar__connect ${connectPanelOpen ? 'sidebar__connect--active' : ''}`}
          title={connectTitle}
          onClick={() => setConnectPanelOpen(!connectPanelOpen)}
        >
          <span className="sidebar__connect-avatar">
            {connectedPlatforms.length > 0
              ? connectedPlatforms.slice(0, 2).map((platform) => (
                  <span className="sidebar__connect-avatar-icon" key={platform}>
                    {CONNECT_ICONS_SMALL[platform]}
                  </span>
                ))
              : <CirclePlus size={13} />}
            {connectDotClass && <span className={`sidebar__connect-dot ${connectDotClass}`} />}
          </span>
          <span className="sidebar__connect-label">{t('app.sidebar.connect')}</span>
          {connectBindingsCount > 0 && (
            <span className="sidebar__connect-badge" title={t('app.sidebar.connectBadgeTitle', { count: connectBindingsCount })}>
              {connectBindingsCount}
            </span>
          )}
        </button>
        <span className="sidebar__nav-item-spacer" />
        <button
          type="button"
          className="sidebar__settings-button"
          aria-label={t('app.sidebar.settingsAria')}
          onClick={() => {
            setSettingsSection('general')
            setView('settings')
            closeSidebarOverlay()
          }}
        >
          <Settings size={15} />
        </button>
      </div>
        </>
      )}
      {resizer}
    </nav>
  )

  if (variant === 'overlay') {
    return (
      <div className="sidebar__overlay" role="presentation" onClick={toggleSidebar}>
        <div onClick={(event) => event.stopPropagation()}>{inner}</div>
      </div>
    )
  }

  return inner
}
