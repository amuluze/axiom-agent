import type { AppView, SettingsSection } from '@/stores/uiStore'

/** Determine which view the app should show given provider readiness and message count. */
export const resolveAutoView = (
  providerSetupRequired: boolean,
  hasMessages: boolean,
  currentView: AppView = 'new-task',
): AppView => {
  if (providerSetupRequired) return 'settings'
  // 用户启动的独立窗口（设置/SSH）不进自动视图切换：SSH 面板挂载期间
  // 会话消息变更不应把视图从 SSH 拽回会话页。
  if (currentView === 'settings' || currentView === 'ssh') return currentView
  if (hasMessages) return 'session'
  return 'new-task'
}

export interface ShortcutResult {
  view: AppView
  section?: SettingsSection
}

export interface ShortcutEventInput {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
  preventDefault: () => void
}

/**
 * Returns a target view + optional settings section when the keyboard event
 * matches a registered shortcut. Returns null when no shortcut was triggered.
 */
export const resolveShortcut = (event: ShortcutEventInput): ShortcutResult | null => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === ',') {
    event.preventDefault()
    return { view: 'settings', section: 'general' }
  }
  if (event.shiftKey && key === 'n') {
    event.preventDefault()
    return { view: 'new-task' }
  }
  return null
}

export interface ViewRenderResult {
  /** True when App should return the SettingsView (full-screen, no ShellLayout). */
  settingsScreen: boolean
  /** True when App renders inside ShellLayout. Always the inverse of settingsScreen. */
  shell: boolean
  /** True when the active content is SessionView, false for NewTaskView (only meaningful inside the shell). */
  session: boolean
  /** True when App should render the SSH full-window view（SSH 已迁出右侧 rail）。 */
  ssh: boolean
}

export const resolveViewRender = (view: AppView): ViewRenderResult => ({
  settingsScreen: view === 'settings',
  shell: view !== 'settings' && view !== 'ssh',
  session: view === 'session',
  ssh: view === 'ssh',
})
