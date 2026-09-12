import { useEffect, useRef } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { resolveAutoView, resolveShortcut } from './viewRouter'

/**
 * Drives the app view state based on agent readiness, message presence, and
 * global keyboard shortcuts. Keeps uiStore as the single source of truth.
 */
export const useViewRouter = (): void => {
  const initialize = useAgentStore((state) => state.initialize)
  const providerSetupRequired = useAgentStore((state) => state.providerSetupRequired)
  const messages = useAgentStore((state) => state.messages)
  const pendingApproval = useAgentStore((state) => state.pendingApproval)
  const createNewSession = useAgentStore((state) => state.createNewSession)
  const addWorkspace = useAgentStore((state) => state.addWorkspace)
  const authorizedWorkspace = useAgentStore((state) => state.authorizedWorkspace)
  const continueConversation = useAgentStore((state) => state.continueConversation)
  const running = useAgentStore((state) => state.running)
  const sessionBusy = useAgentStore((state) => state.sessionBusy)
  const providerReady = useAgentStore((state) => state.providerReady)
  const view = useUiStore((state) => state.view)
  const summaryRequest = useUiStore((state) => state.summaryRequest)
  const setView = useUiStore((state) => state.setView)
  const setSettingsSection = useUiStore((state) => state.setSettingsSection)

  useEffect(() => { void initialize() }, [initialize])

  // providerSetupRequired 初始为 `!allowDemoProvider`（生产模式启动早期为 true），
  // view 因此会先进入设置界面；配置读取/初始化完成后变为 false。resolveAutoView 的
  // settings sticky 分支会让 view 一旦进入设置就出不来（用户手动打开设置也依赖它），
  // 因此在 providerSetupRequired 由 true 降为 false 时显式切走设置界面。
  const previousSetupRequired = useRef(providerSetupRequired)
  useEffect(() => {
    const autoView = resolveAutoView(providerSetupRequired, messages.length > 0, view)
    if (providerSetupRequired) setSettingsSection('models')
    if (previousSetupRequired.current && !providerSetupRequired) {
      // provider 配置要求已解除（启动后读到有效配置 / 首次配置完成）：离开设置界面。
      setView(messages.length > 0 ? 'session' : 'new-task')
    } else if (autoView !== view) {
      setView(autoView)
    }
    previousSetupRequired.current = providerSetupRequired
  }, [providerSetupRequired, messages.length, setSettingsSection, setView, view])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (pendingApproval || summaryRequest) return
      if (
        (event.metaKey || event.ctrlKey)
        && !event.altKey
        && event.shiftKey
        && event.key === 'Enter'
      ) {
        if (!running && !sessionBusy && providerReady && !providerSetupRequired && messages.length > 0) {
          event.preventDefault()
          void continueConversation()
        }
        return
      }
      const result = resolveShortcut({
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        key: event.key,
        preventDefault: () => event.preventDefault(),
      })
      if (!result) return
      if (result.view === 'new-task') {
        const create = authorizedWorkspace
          ? createNewSession(authorizedWorkspace.path)
          : addWorkspace()
        void create.then((created) => {
          if (created) setView('new-task')
        })
        return
      }
      if (result.section) setSettingsSection(result.section)
      setView(result.view)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    addWorkspace,
    authorizedWorkspace,
    continueConversation,
    createNewSession,
    messages.length,
    pendingApproval,
    providerReady,
    providerSetupRequired,
    running,
    sessionBusy,
    setSettingsSection,
    setView,
    summaryRequest,
  ])
}
