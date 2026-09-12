import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { ArrowUp, ChevronDown, Folder, FolderOpen, Pencil, ShieldCheck, Square, X } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import type { AccessMode } from '@/stores/uiStore'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import { MentionPopover } from '@/components/composer/MentionPopover'
import { useUpwardMenuClamp } from '@/components/composer/useUpwardMenuClamp'
import {
  detectActiveMention,
  formatMentionToken,
  parseMentions,
  type ActiveMention,
  type MentionCandidate,
} from '@/components/composer/mentionParser'
import {
  isCaretOnFirstLine,
  loadComposerHistory,
  recordComposerHistoryEntry,
} from '@/components/composer/inputHistory'
import { useMentionCandidates } from '@/components/composer/useMentionCandidates'
import { ContextBudgetControl } from '@/components/composer/ContextBudgetControl'
import { SessionUsageControl } from '@/components/composer/SessionUsageControl'
import { useT } from '@/i18n'
import { localizedProviderLabel } from '@/i18n/providerLabels'

const accessModeOptions: Array<{ value: AccessMode; labelKey: string; descriptionKey: string }> = [
  { value: 'standard', labelKey: 'app.composer.access.standard', descriptionKey: 'app.composer.access.standardDesc' },
  { value: 'no-approval', labelKey: 'app.composer.access.noApproval', descriptionKey: 'app.composer.access.noApprovalDesc' },
]

/**
 * 下拉框「最近打开」数据派生：recentWorkspacePaths 顺序优先，
 * 只保留当前仍授权的工作目录（与左侧工作区成员一致）。
 */
export const recentWorkspaceEntries = (
  authorizedWorkspaces: AuthorizedWorkspace[],
  recentWorkspacePaths: string[],
): AuthorizedWorkspace[] => {
  const byPath = new Map(authorizedWorkspaces.map((workspace) => [workspace.path, workspace]))
  return recentWorkspacePaths
    .map((path) => byPath.get(path))
    .filter((workspace): workspace is AuthorizedWorkspace => Boolean(workspace))
}

export interface ComposerAvailability {
  providerReady: boolean
  providerSetupRequired: boolean
  workspaceReady: boolean
  sessionBusy: boolean
  compactionRunning: boolean
}

export const isComposerAvailable = (state: ComposerAvailability): boolean => (
  state.providerReady
  && !state.providerSetupRequired
  && state.workspaceReady
  && !state.sessionBusy
  && !state.compactionRunning
)

export const deliverQueuedContent = async (
  action: (content: string) => Promise<boolean>,
  content: string,
  onAccepted: () => void,
): Promise<boolean> => {
  const accepted = await action(content)
  if (accepted) onAccepted()
  return accepted
}

export interface ComposerKeyEvent {
  key: string
  altKey: boolean
  nativeEvent: {
    isComposing?: boolean
    keyCode?: number
  }
}

export const isComposerSendKey = (event: ComposerKeyEvent, composing = false): boolean => (
  event.key === 'Enter'
  && !event.altKey
  && !composing
  && event.nativeEvent.isComposing !== true
  && event.nativeEvent.keyCode !== 229
)

export interface ComposerHistoryKeyEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  nativeEvent: {
    isComposing?: boolean
    keyCode?: number
  }
}

/** ↑/↓ 触发历史导航的按键面：排除全部修饰键（保留 ⌘↑/⌥↑/⇧↑ 选区等原生语义）与 IME 组合。 */
export const isComposerHistoryKey = (event: ComposerHistoryKeyEvent, composing = false): boolean => (
  (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  && !event.metaKey
  && !event.ctrlKey
  && !event.altKey
  && !event.shiftKey
  && !composing
  && event.nativeEvent.isComposing !== true
  && event.nativeEvent.keyCode !== 229
)

const mentionKey = (mention: ActiveMention | null): string | null => mention
  ? `${mention.kind}:${mention.triggerStart}:${mention.queryEnd}:${mention.query}`
  : null

const queueKindKey = (kind: string): string => {
  if (kind === 'steering') return 'app.composer.queueKind.steering'
  if (kind === 'follow-up') return 'app.composer.queueKind.followUp'
  return 'app.composer.queueKind.nextTurn'
}

export interface ComposerProps {
  variant?: 'new-task' | 'session'
}

export const Composer = ({ variant = 'session' }: ComposerProps) => {
  const { t } = useT()
  const [input, setInput] = useState('')
  const [caret, setCaret] = useState(0)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [accessMenuOpen, setAccessMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [budgetMenuOpen, setBudgetMenuOpen] = useState(false)
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  // 输入历史浏览态：index -1 表示草稿态；进入浏览前把草稿存入 draftRef，
  // ↓ 越过最新一条时恢复。放 ref 而非 state——只有 input 驱动渲染。
  const historyRef = useRef<string[]>(loadComposerHistory())
  const historyIndexRef = useRef(-1)
  const draftRef = useRef('')
  // 四个下拉菜单的宿主容器 ref：用于「点击菜单外部收起」的边界判断。
  const workspacePickerRef = useRef<HTMLDivElement | null>(null)
  const accessPickerRef = useRef<HTMLDivElement | null>(null)
  const modelPickerRef = useRef<HTMLDivElement | null>(null)
  const budgetPickerRef = useRef<HTMLDivElement | null>(null)
  // 挂载后聚焦输入框：设置面板/原生对话框交互后 textarea 会失去 DOM 焦点，
  // 自动聚焦保证用户（以及原生 E2E 的键盘输入）能直接输入。
  useEffect(() => {
    queueMicrotask(() => textareaRef.current?.focus())
  }, [])

  // 点击菜单外部或按 Escape 收起菜单：菜单项自身的 onClick 负责选择后关闭，
  // 这里只处理「点击落在对应 picker 容器之外」与键盘 Esc 两条路径。
  useEffect(() => {
    const anyOpen = workspaceMenuOpen || accessMenuOpen || modelMenuOpen || budgetMenuOpen
    if (!anyOpen) return
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return
      if (workspaceMenuOpen && !workspacePickerRef.current?.contains(event.target)) {
        setWorkspaceMenuOpen(false)
      }
      if (accessMenuOpen && !accessPickerRef.current?.contains(event.target)) {
        setAccessMenuOpen(false)
      }
      if (modelMenuOpen && !modelPickerRef.current?.contains(event.target)) {
        setModelMenuOpen(false)
      }
      if (budgetMenuOpen && !budgetPickerRef.current?.contains(event.target)) {
        setBudgetMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setWorkspaceMenuOpen(false)
      setAccessMenuOpen(false)
      setModelMenuOpen(false)
      setBudgetMenuOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [workspaceMenuOpen, accessMenuOpen, modelMenuOpen, budgetMenuOpen])

  const closeAllMenus = useCallback(() => {
    setWorkspaceMenuOpen(false)
    setAccessMenuOpen(false)
    setModelMenuOpen(false)
    setBudgetMenuOpen(false)
  }, [])

  // 打开一个菜单时互斥关闭其他三个；重复点击已打开的菜单则收起。
  const toggleMenu = useCallback((menu: 'workspace' | 'access' | 'model' | 'budget') => {
    const isOpen = menu === 'workspace' ? workspaceMenuOpen
      : menu === 'access' ? accessMenuOpen
        : menu === 'model' ? modelMenuOpen
          : budgetMenuOpen
    closeAllMenus()
    if (isOpen) return
    if (menu === 'workspace') setWorkspaceMenuOpen(true)
    else if (menu === 'access') setAccessMenuOpen(true)
    else if (menu === 'model') setModelMenuOpen(true)
    else setBudgetMenuOpen(true)
  }, [accessMenuOpen, budgetMenuOpen, closeAllMenus, modelMenuOpen, workspaceMenuOpen])
  // 四个弹层都向上展开，打开期间实测触发器上方空间钳高，
  // 防止条目过多时弹层顶缘被窗口顶部裁剪（欢迎页 Composer 居中时尤其如此）。
  useUpwardMenuClamp(workspacePickerRef, workspaceMenuOpen)
  useUpwardMenuClamp(accessPickerRef, accessMenuOpen)
  useUpwardMenuClamp(modelPickerRef, modelMenuOpen)
  useUpwardMenuClamp(budgetPickerRef, budgetMenuOpen)
  const send = useAgentStore((state) => state.send)
  const stop = useAgentStore((state) => state.stop)
  const queueSteering = useAgentStore((state) => state.queueSteering)
  const queueFollowUp = useAgentStore((state) => state.queueFollowUp)
  const clearQueuedMessages = useAgentStore((state) => state.clearQueuedMessages)
  const restoreQueuedMessage = useAgentStore((state) => state.restoreQueuedMessage)
  const editUserMessage = useAgentStore((state) => state.editUserMessage)
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const discardRecoveredMessage = useAgentStore((state) => state.discardRecoveredMessage)
  const cancelBranchSummary = useAgentStore((state) => state.cancelBranchSummary)
  const authorizeFile = useAgentStore((state) => state.authorizeFile)
  const authorizeDirectory = useAgentStore((state) => state.authorizeDirectory)
  const addWorkspace = useAgentStore((state) => state.addWorkspace)
  const activateWorkspace = useAgentStore((state) => state.activateWorkspace)
  const running = useAgentStore((state) => state.running)
  const sessionBusy = useAgentStore((state) => state.sessionBusy)
  const compactionRunning = useAgentStore((state) => state.compactionRunning)
  const branchSummaryRunning = useAgentStore((state) => state.branchSummaryRunning)
  const provider = useAgentStore((state) => state.provider)
  const providerProfiles = useAgentStore((state) => state.providerProfiles)
  const providerSaving = useAgentStore((state) => state.providerSaving)
  const switchProviderProfile = useAgentStore((state) => state.switchProviderProfile)
  const providerReady = useAgentStore((state) => state.providerReady)
  const providerSetupRequired = useAgentStore((state) => state.providerSetupRequired)
  const authorizedWorkspace = useAgentStore((state) => state.authorizedWorkspace)
  const authorizedWorkspaces = useAgentStore((state) => state.authorizedWorkspaces)
  const recentWorkspacePaths = useUiStore((state) => state.recentWorkspacePaths)
  const pendingSteeringCount = useAgentStore((state) => state.pendingSteeringCount)
  const pendingFollowUpCount = useAgentStore((state) => state.pendingFollowUpCount)
  const pendingNextTurnCount = useAgentStore((state) => state.pendingNextTurnCount)
  const queuedMessages = useAgentStore((state) => state.queuedMessages)
  const recoveredQueuedMessages = useAgentStore((state) => state.recoveredQueuedMessages)
  const accessMode = useUiStore((state) => state.accessMode)
  const setAccessMode = useUiStore((state) => state.setAccessMode)
  const messageEditRequest = useUiStore((state) => state.messageEditRequest)
  const setMessageEditRequest = useUiStore((state) => state.setMessageEditRequest)
  // 编辑请求按会话隔离：切到别的会话后残留的请求不得回填到当前输入框。
  const editRequest = messageEditRequest?.sessionId === activeSessionId ? messageEditRequest : null
  const setSettingsSection = useUiStore((state) => state.setSettingsSection)
  const setView = useUiStore((state) => state.setView)
  const composerAvailable = isComposerAvailable({
    providerReady,
    providerSetupRequired,
    workspaceReady: Boolean(authorizedWorkspace),
    sessionBusy,
    compactionRunning,
  })
  const placeholder = providerSetupRequired
    ? t('app.composer.placeholder.provider')
    : sessionBusy
      ? t('app.composer.placeholder.preparing')
      : !authorizedWorkspace
        ? t('app.composer.placeholder.workspace')
        : compactionRunning
          ? t('app.composer.placeholder.compacting')
          : running
            ? t('app.composer.placeholder.steering')
            : variant === 'new-task'
              ? t('app.composer.placeholder.default')
              : t('app.composer.placeholder.newTask')

  const clearAcceptedInput = useCallback(() => {
    setInput('')
    setCaret(0)
    setDismissedMentionKey(null)
    historyIndexRef.current = -1
  }, [])

  const deliverInput = useCallback(async (delivery: 'automatic' | 'follow-up' = 'automatic') => {
    const content = input.trim()
    if (!content || !composerAvailable) return false
    // 被接受即入史（直接发送与排队/跟进同权），与清空输入绑成单点。
    const accept = () => {
      historyRef.current = recordComposerHistoryEntry(content)
      clearAcceptedInput()
    }
    // 编辑态提交：从该消息之前的分支边界重发；只有成功才清空输入，失败时保留
    // 用户改过的文本（失败原因由 store 写入 error 区）。
    if (editRequest) {
      const accepted = await editUserMessage(editRequest.messageId, content)
      if (!accepted) return false
      setMessageEditRequest(null)
      accept()
      return true
    }

    if (running) {
      return deliverQueuedContent(
        delivery === 'follow-up' ? queueFollowUp : queueSteering,
        content,
        accept,
      )
    }

    const latest = useAgentStore.getState()
    if (!isComposerAvailable({
      providerReady: latest.providerReady,
      providerSetupRequired: latest.providerSetupRequired,
      workspaceReady: Boolean(latest.authorizedWorkspace),
      sessionBusy: latest.sessionBusy,
      compactionRunning: latest.compactionRunning,
    }) || latest.running) return false
    void send(content)
    accept()
    if (variant === 'new-task') setView('session')
    return true
  }, [
    clearAcceptedInput,
    composerAvailable,
    editRequest,
    editUserMessage,
    input,
    queueFollowUp,
    queueSteering,
    running,
    send,
    setMessageEditRequest,
    setView,
    variant,
  ])

  const submit = useCallback((event: FormEvent) => {
    event.preventDefault()
    void deliverInput()
  }, [deliverInput])

  const updateSelection = (target: HTMLTextAreaElement | null) => {
    if (!target) return
    setCaret(target.selectionStart ?? target.value.length)
  }

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value)
    setDismissedMentionKey(null)
    // 手动编辑即退出历史浏览态，下次 ↑ 从最新条目重新回溯。
    historyIndexRef.current = -1
    updateSelection(event.target)
  }

  const onSelectEvent = (event: { currentTarget: EventTarget & HTMLTextAreaElement }) => {
    updateSelection(event.currentTarget)
  }

  const detectedMention = useMemo(() => detectActiveMention(input, caret), [input, caret])
  const detectedMentionKey = mentionKey(detectedMention)
  const activeMention = detectedMentionKey === dismissedMentionKey ? null : detectedMention
  const candidatesByKind = useMentionCandidates()

  // 以历史条目整体替换输入并把光标挪到末尾（终端习惯）；
  // 程序化赋值不走 onChange，浏览态得以保留。
  const replaceComposerText = (next: string) => {
    setInput(next)
    setCaret(next.length)
    queueMicrotask(() => {
      const target = textareaRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(next.length, next.length)
    })
  }

  // ↑ 回溯更旧、↓ 前进更新，越过最新一条时恢复进入浏览前的草稿。
  // 返回是否消费了按键；未消费时放行 textarea 原生光标移动。
  const applyHistoryKey = (key: 'ArrowUp' | 'ArrowDown', caretPos: number): boolean => {
    const history = historyRef.current
    const browsing = historyIndexRef.current !== -1
    if (key === 'ArrowUp') {
      if (!browsing) {
        // 只在第一行回溯：多行草稿的光标上移仍是移动光标。
        if (history.length === 0 || !isCaretOnFirstLine(input, caretPos)) return false
        draftRef.current = input
      } else if (historyIndexRef.current >= history.length - 1) {
        return false
      }
      const nextIndex = browsing ? historyIndexRef.current + 1 : 0
      const entry = history[nextIndex]
      if (entry === undefined) return false
      historyIndexRef.current = nextIndex
      replaceComposerText(entry)
      return true
    }
    if (!browsing) return false
    const currentIndex = historyIndexRef.current
    if (currentIndex > 0) {
      const entry = history[currentIndex - 1]
      if (entry === undefined) return false
      historyIndexRef.current = currentIndex - 1
      replaceComposerText(entry)
      return true
    }
    historyIndexRef.current = -1
    replaceComposerText(draftRef.current)
    return true
  }

  // 定义在 activeMention 之后：提及弹层激活时 ↑/↓ 属于候选导航，
  // 本 handler 先于 MentionPopover 的 window 级监听触发，必须主动让路。
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerHistoryKey(event, composingRef.current) && !activeMention) {
      const caretPos = textareaRef.current?.selectionStart ?? caret
      if (applyHistoryKey(event.key === 'ArrowUp' ? 'ArrowUp' : 'ArrowDown', caretPos)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }
    if (!isComposerSendKey(event, composingRef.current) || !input.trim()) return
    event.preventDefault()
    event.stopPropagation()
    void deliverInput()
  }

  const insertMention = useCallback((candidate: MentionCandidate) => {
    const mention = detectActiveMention(input, caret)
    if (!mention) return
    const before = input.slice(0, mention.triggerStart)
    const after = input.slice(mention.queryEnd)
    const replacement = formatMentionToken(mention.kind, candidate)
    const next = `${before}${replacement}${after}`
    const nextCaret = before.length + replacement.length
    setInput(next)
    setCaret(nextCaret)
    setDismissedMentionKey(null)
    queueMicrotask(() => {
      const target = textareaRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(nextCaret, nextCaret)
    })
  }, [input, caret])

  const restoreToComposer = useCallback(async (messageId: string) => {
    const restored = await restoreQueuedMessage(messageId)
    if (!restored) return
    setInput((current) => current.trim()
      ? `${current.trimEnd()}\n\n${restored.content}`
      : restored.content)
    setDismissedMentionKey(null)
    historyIndexRef.current = -1
    queueMicrotask(() => textareaRef.current?.focus())
  }, [restoreQueuedMessage])

  // 「编辑消息」请求到达时回填原文并聚焦：请求本身由提交或放弃消费。
  useEffect(() => {
    if (!editRequest) return
    const content = editRequest.content
    setInput(content)
    setCaret(content.length)
    setDismissedMentionKey(null)
    historyIndexRef.current = -1
    queueMicrotask(() => {
      const target = textareaRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(content.length, content.length)
    })
  }, [editRequest])

  const cancelEdit = useCallback(() => {
    setMessageEditRequest(null)
    clearAcceptedInput()
  }, [clearAcceptedInput, setMessageEditRequest])

  const mentionBadges = useMemo(() => parseMentions(input), [input])
  const recentWorkspaces = useMemo(
    () => recentWorkspaceEntries(authorizedWorkspaces, recentWorkspacePaths ?? []),
    [authorizedWorkspaces, recentWorkspacePaths],
  )
  const project = authorizedWorkspace?.name ?? t('app.composer.project.choose')
  const currentAccessMode = accessModeOptions.find((option) => option.value === accessMode) ?? accessModeOptions[0]!
  const hasQueuedMessages = pendingSteeringCount > 0 || pendingFollowUpCount > 0 || pendingNextTurnCount > 0

  return (
    <form className="composer" onSubmit={submit} aria-label="Composer">
      <div className="composer__selectors">
        <div className="composer__workspace-picker" ref={workspacePickerRef}>
          <button
            aria-expanded={workspaceMenuOpen}
            aria-label={t('app.composer.project.aria')}
            className="composer__selector"
            disabled={sessionBusy}
            onClick={() => toggleMenu('workspace')}
            title={t('app.composer.project.title')}
            type="button"
          >
            <Folder size={14} className="composer__selector-icon" />
            <span className="composer__project-label">
              <span>{project}</span>
              {authorizedWorkspace?.gitBranch && (
                <span className="composer__project-branch">{authorizedWorkspace.gitBranch}</span>
              )}
            </span>
            <ChevronDown size={13} className="composer__selector-chevron" />
          </button>
          {workspaceMenuOpen && (
            <div className="composer__workspace-menu" role="menu">
              <div className="composer__menu-title">{t('app.composer.project.recent')}</div>
              <div className="composer__menu-list">
                {recentWorkspaces.length === 0 ? (
                  <div className="composer__menu-item composer__menu-item--row">
                    <span>{t('app.composer.project.none')}</span>
                  </div>
                ) : (
                  recentWorkspaces.map((workspace) => (
                    <button
                      className={`composer__menu-item composer__menu-item--row ${
                        workspace.path === authorizedWorkspace?.path ? 'composer__menu-item--active' : ''
                      }`}
                      key={workspace.path}
                      onClick={() => {
                        setWorkspaceMenuOpen(false)
                        void activateWorkspace(workspace.path)
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Folder size={14} />
                      <span className="composer__menu-item-label">
                        {workspace.name}
                        {workspace.gitBranch ? ` · ${workspace.gitBranch}` : ''}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <button
                className="composer__menu-item composer__menu-item--row"
                disabled={running}
                onClick={() => {
                  setWorkspaceMenuOpen(false)
                  void addWorkspace()
                }}
                role="menuitem"
                type="button"
              >
                <FolderOpen size={14} />
                <span>{t('app.composer.project.open')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="composer__input-wrap" style={{ position: 'relative' }}>
        {activeMention && (
          <MentionPopover
            active={activeMention}
            candidates={candidatesByKind[activeMention.kind]}
            onClose={() => setDismissedMentionKey(detectedMentionKey)}
            onSelect={insertMention}
            onAuthorizeFile={() => { void authorizeFile() }}
            onAuthorizeDirectory={() => { void authorizeDirectory() }}
          />
        )}
        <textarea
          aria-label={t('app.composer.aria.send')}
          className="composer__textarea"
          disabled={!composerAvailable}
          onChange={onChange}
          onCompositionEnd={() => { composingRef.current = false }}
          onCompositionStart={() => { composingRef.current = true }}
          onKeyDown={onKeyDown}
          onSelect={onSelectEvent}
          onClick={onSelectEvent}
          onKeyUp={onSelectEvent}
          placeholder={placeholder}
          ref={textareaRef}
          rows={3}
          value={input}
        />
        {editRequest && (
          <div aria-live="polite" className="composer__edit-banner" role="status">
            <Pencil size={12} />
            <span className="composer__edit-text">
              <span className="composer__edit-title">{t('app.sessionView.editing')}</span>
              <span className="composer__edit-hint">{t('app.sessionView.editingHint')}</span>
            </span>
            <button
              aria-label={t('app.sessionView.editCancel')}
              className="composer__edit-cancel"
              onClick={cancelEdit}
              title={t('app.sessionView.editCancel')}
              type="button"
            >
              <X size={12} />
            </button>
          </div>
        )}
        {mentionBadges.length > 0 && (
          <div className="composer__mention-badges" aria-label={t('app.composer.badgesAria')}>
            {mentionBadges.map((badge) => (
              <span className="composer__mention-badge" key={`${badge.kind}-${badge.start}-${badge.id ?? badge.label}`}>
                {badge.kind} · {badge.label}
              </span>
            ))}
          </div>
        )}
        {hasQueuedMessages && (
          <div aria-live="polite" className="composer__queue" role="status">
            <div className="composer__queue-heading">
              <span>
                {t('app.composer.queue.pending', { steering: pendingSteeringCount, followUp: pendingFollowUpCount, nextTurn: pendingNextTurnCount })}
              </span>
              <button onClick={() => { void clearQueuedMessages() }} type="button">{t('app.composer.queue.clear')}</button>
            </div>
            <ul className="composer__queue-list">
              {queuedMessages.map((message) => (
                <li key={message.id}>
                  <span className="composer__queue-kind">{t(queueKindKey(message.kind))}</span>
                  <span className="composer__queue-preview">{message.content}</span>
                  <button onClick={() => { void restoreToComposer(message.id) }} type="button">{t('app.composer.queue.restore')}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {recoveredQueuedMessages.length > 0 && (
          <div aria-live="polite" className="composer__queue composer__queue--recovered" role="status">
            <div className="composer__queue-heading">
              <span>{t('app.composer.queue.recovered', { count: recoveredQueuedMessages.length })}</span>
            </div>
            <ul className="composer__queue-list">
              {recoveredQueuedMessages.map((message) => (
                <li key={message.id}>
                  <span className="composer__queue-kind">{t(queueKindKey(message.kind))}</span>
                  <span className="composer__queue-preview">{message.content}</span>
                  <button onClick={() => { void restoreToComposer(message.id) }} type="button">{t('app.composer.queue.restore')}</button>
                  <button
                    className="composer__queue-discard"
                    onClick={() => { void discardRecoveredMessage(message.id) }}
                    type="button"
                  >
                    {t('app.composer.queue.discard')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="composer__controls">
          <div className="composer__access-picker" ref={accessPickerRef}>
            <button
              type="button"
              className="composer__access-mode"
              data-mode={accessMode}
              aria-expanded={accessMenuOpen}
              aria-label={t('app.composer.access.aria')}
              onClick={() => toggleMenu('access')}
            >
              <ShieldCheck size={14} />
              <span>{t(currentAccessMode.labelKey)}</span>
              <ChevronDown size={13} />
            </button>
            {accessMenuOpen && (
              <div className="composer__access-menu" role="menu">
                <div className="composer__menu-title">{t('app.composer.access.title')}</div>
                {accessModeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`composer__menu-item ${option.value === accessMode ? 'composer__menu-item--active' : ''}`}
                    onClick={() => {
                      setAccessMode(option.value)
                      setAccessMenuOpen(false)
                    }}
                  >
                    <span className="composer__menu-item-label">{t(option.labelKey)}</span>
                    <span className="composer__menu-item-desc">{t(option.descriptionKey)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="composer__controls-spacer" />
          {variant === 'session' && <SessionUsageControl />}
          {variant === 'session' && (
            <ContextBudgetControl
              containerRef={budgetPickerRef}
              onCompacted={() => setBudgetMenuOpen(false)}
              onToggle={() => toggleMenu('budget')}
              open={budgetMenuOpen}
            />
          )}
          <div className="composer__model-picker" ref={modelPickerRef}>
            <button
              aria-expanded={modelMenuOpen}
              aria-label={t('app.composer.model.aria')}
              className="composer__model-selector"
              disabled={running || sessionBusy || providerSaving}
              onClick={() => toggleMenu('model')}
              title={t('app.composer.model.title')}
              type="button"
            >
              <span>{provider.modelName || provider.modelId}</span>
              <ChevronDown size={12} />
            </button>
            {modelMenuOpen && (
              <div className="composer__model-menu" role="menu">
                <div className="composer__menu-title">{t('app.composer.model.titleMenu')}</div>
                <div className="composer__menu-list">
                  {providerProfiles.map((profile) => (
                    <button
                      key={profile.profileId}
                      className={`composer__menu-item ${profile.profileId === provider.profileId ? 'composer__menu-item--active' : ''}`}
                      onClick={() => {
                        setModelMenuOpen(false)
                        void switchProviderProfile(profile.profileId)
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <span className="composer__menu-item-label">
                        {localizedProviderLabel(t, profile.providerId)}
                      </span>
                      <span className="composer__menu-item-desc">{profile.modelName || profile.modelId}</span>
                    </button>
                  ))}
                </div>
                <button
                  className="composer__menu-item composer__menu-item--row composer__model-settings-link"
                  onClick={() => {
                    setModelMenuOpen(false)
                    setSettingsSection('models')
                    setView('settings')
                  }}
                  role="menuitem"
                  type="button"
                >
                  {t('app.composer.model.manage')}
                </button>
              </div>
            )}
          </div>
          {running && (
            <button
              className="composer__follow-up"
              disabled={!composerAvailable || !input.trim()}
              onClick={() => { void deliverInput('follow-up') }}
              type="button"
            >
              {t('app.composer.followUp')}
            </button>
          )}
          {branchSummaryRunning && !running && (
            <button
              aria-label={t('app.composer.cancelSummary.aria')}
              className="composer__stop"
              onClick={cancelBranchSummary}
              title={t('app.composer.cancelSummary.title')}
              type="button"
            >
              <Square size={12} fill="currentColor" />
            </button>
          )}
          <button
            type="submit"
            className={`composer__send ${composerAvailable && input.trim() ? 'composer__send--ready' : ''}`}
            aria-label={editRequest
              ? t('app.composer.send.edit')
              : running
                ? t('app.composer.send.running')
                : t('app.composer.send.idle')}
            disabled={!composerAvailable || !input.trim()}
          >
            <ArrowUp size={15} />
          </button>
          {running && (
            <button
              aria-label={t('app.composer.stop.aria')}
              className="composer__stop"
              onClick={() => { void stop() }}
              title={t('app.composer.stop.title')}
              type="button"
            >
              <Square size={12} fill="currentColor" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
