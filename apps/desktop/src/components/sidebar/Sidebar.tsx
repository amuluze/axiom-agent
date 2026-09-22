import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useConnectStore } from '@/stores/connectStore'
import { useUiStore } from '@/stores/uiStore'
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
  SendHorizontal,
  Server,
  Settings,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import type { StoredAgentSession } from '@/persistence/types'
import { useT, type TFunction } from '@/i18n'
import { displaySessionTitle } from '@/i18n/sessionTitle'

/** 侧边栏头像里的小号平台图标（固定 9px，两枚并排 + 状态点刚好放下）。 */
const CONNECT_ICONS_SMALL: Record<ConnectPlatform, ReactNode> = {
  feishu: <FeishuIcon size={9} />,
  dingtalk: <DingtalkIcon size={9} />,
  weixin: <WeixinIcon size={9} />,
}

/** 平台展示顺序固定（与面板卡片一致），不受 store 数组顺序影响。 */
const CONNECT_PLATFORM_ORDER: ConnectPlatform[] = ['feishu', 'dingtalk', 'weixin']

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
  const sessions = useAgentStore((state) => state.sessions)
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const awaitingApprovalSessionIds = useAgentStore((state) => state.awaitingApprovalSessionIds)
  const authorizedWorkspace = useAgentStore((state) => state.authorizedWorkspace)
  const authorizedWorkspaces = useAgentStore((state) => state.authorizedWorkspaces)
  const selectSession = useAgentStore((state) => state.selectSession)
  const createNewSession = useAgentStore((state) => state.createNewSession)
  const addWorkspace = useAgentStore((state) => state.addWorkspace)
  const activateWorkspace = useAgentStore((state) => state.activateWorkspace)
  const revokeWorkspace = useAgentStore((state) => state.revokeWorkspace)
  const archiveSession = useAgentStore((state) => state.archiveSession)
  const stopSession = useAgentStore((state) => state.stopSession)
  const sendToSession = useAgentStore((state) => state.sendToSession)
  const releaseQueuedForSession = useAgentStore((state) => state.releaseQueuedForSession)
  const sessionQueueCounts = useAgentStore((state) => state.sessionQueueCounts)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const setView = useUiStore((state) => state.setView)
  const setSettingsSection = useUiStore((state) => state.setSettingsSection)
  const closeSidebarOverlay = useUiStore((state) => state.closeSidebarOverlay)
  const view = useUiStore((state) => state.view)
  const availableUpdate = useUiStore((state) => state.availableUpdate)
  const setConnectPanelOpen = useUiStore((state) => state.setConnectPanelOpen)
  const connectPanelOpen = useUiStore((state) => state.connectPanelOpen)
  const connectPlatforms = useConnectStore((state) => state.config.platforms)
  const connectBindingsCount = useConnectStore((state) => state.config.bindings.length)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set())
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set())
  // 后台快捷发送：当前展开输入的目标会话 id。一次只展开一行，切换目标即重置草稿。
  const [quickSendId, setQuickSendId] = useState<string | null>(null)
  const [quickSendDraft, setQuickSendDraft] = useState('')
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

  const sidebarClass = variant === 'overlay' ? 'sidebar sidebar--overlay' : 'sidebar'
  const titlebarClass = variant === 'overlay'
    ? 'sidebar__titlebar sidebar__titlebar--overlay'
    : 'sidebar__titlebar'

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
          className="sidebar__nav-item"
          title={t('app.sidebar.sshTitle')}
          onClick={() => {
            // SSH 是独立全窗口视图（设计稿「Axiom — SSH」）：主机管理与远程
            // 终端同屏分栏，返回按钮回到上一视图。
            setView('ssh')
            closeSidebarOverlay()
          }}
        >
          <Server size={15} className="sidebar__nav-item-icon" />
          <span>{t('app.sidebar.ssh')}</span>
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
