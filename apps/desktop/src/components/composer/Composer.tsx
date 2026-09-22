import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { ArrowUp, Check, ChevronDown, FileText, Folder, FolderOpen, GripVertical, Hash, Pencil, ShieldCheck, ShieldOff, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import type { AccessMode } from '@/stores/uiStore'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import type { QueuedMessageSnapshot } from '@/agent/runtime/AgentSession'
import type {
  QueueAcceptance,
  QueueMoveTarget,
  QueueMutationResult,
  QueueRejectionReason,
} from '@/agent/runtime/queueContracts'
import { MentionPopover } from '@/components/composer/MentionPopover'
import { useUpwardMenuClamp } from '@/components/composer/useUpwardMenuClamp'
import {
  detectActiveMention,
  formatMentionToken,
  parseMentions,
  type ActiveMention,
  type MentionCandidate,
  type ParsedMention,
} from '@/components/composer/mentionParser'
import {
  mergeFileCandidates,
  useWorkspaceFileCandidates,
} from '@/components/composer/useWorkspaceFileCandidates'
import {
  isCaretOnFirstLine,
  loadComposerHistory,
  recordComposerHistoryEntry,
} from '@/components/composer/inputHistory'
import { useMentionCandidates } from '@/components/composer/useMentionCandidates'
import { splitMentionSegments } from '@/components/composer/mentionHighlight'
import {
  MAX_PASTE_IMAGES,
  ImageTooLargeError,
  attachmentFromImageBlock,
  compressPastedImage,
  imageFilesFromClipboard,
  objectUrlForFile,
  revokeObjectUrl,
  toImageContentBlock,
} from '@/components/composer/imagePaste'
import { resolveModelDescriptor } from '@/agent/transport/modelCatalog'
import { ContextBudgetControl } from '@/components/composer/ContextBudgetControl'
import { ReasoningPicker } from '@/components/composer/ReasoningPicker'
import { useT } from '@/i18n'
import { localizedProviderLabel } from '@/i18n/providerLabels'
import type { ImageContentBlock } from '@/agent/core/types'

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
  action: (content: string, images?: ImageContentBlock[]) => Promise<QueueAcceptance>,
  content: string,
  onAccepted: () => void,
  images?: ImageContentBlock[],
): Promise<QueueAcceptance> => {
  const acceptance = await action(content, images)
  if (acceptance.accepted) onAccepted()
  return acceptance
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

/** chip 的类型标签与图标：目录/文件按标签尾斜杠约定判定（目录 token 以 / 结尾，
    见 formatMentionToken——折叠 token 不携带元数据，类型只能编码进文本），
    技能/会话按 trigger 区分。displayLabel 去掉目录尾斜杠仅供展示。 */
export const mentionChipMeta = (
  mention: ParsedMention,
): { Icon: typeof FileText; kindKey: string; displayLabel: string } => {
  if (mention.kind === 'skill') {
    return { Icon: Sparkles, kindKey: 'app.mention.kind.skill', displayLabel: mention.label }
  }
  if (mention.kind === 'thread') {
    return { Icon: Hash, kindKey: 'app.mention.kind.thread', displayLabel: mention.label }
  }
  if (mention.label.endsWith('/')) {
    return {
      Icon: Folder,
      kindKey: 'app.mention.kind.directory',
      displayLabel: mention.label.slice(0, -1),
    }
  }
  return { Icon: FileText, kindKey: 'app.mention.kind.file', displayLabel: mention.label }
}

const mentionKey = (mention: ActiveMention | null): string | null => mention
  ? `${mention.kind}:${mention.triggerStart}:${mention.queryEnd}:${mention.query}`
  : null

const queueKindKey = (kind: string): string => {
  if (kind === 'steering') return 'app.composer.queueKind.steering'
  if (kind === 'follow-up') return 'app.composer.queueKind.followUp'
  return 'app.composer.queueKind.nextTurn'
}

const queueRejectionKey = (reason: QueueRejectionReason): string =>
  `app.composer.queue.reject.${reason}`

interface ComposerAttachment {
  id: string
  mediaType: string
  base64: string
  previewUrl: string
}

let attachmentIdCounter = 0

const createAttachment = async (file: File): Promise<ComposerAttachment> => {
  const image = await compressPastedImage(file)
  attachmentIdCounter += 1
  return {
    id: `paste-${attachmentIdCounter}`,
    mediaType: image.mediaType,
    base64: image.base64,
    previewUrl: objectUrlForFile(file),
  }
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
  // 提及弹层的目录下钻状态：工作区相对路径，null = 工作区根。
  const [mentionBrowseDir, setMentionBrowseDir] = useState<string | null>(null)
  // 粘贴截图附件：chips 预览 + 随消息一起发送；attachHint 为临时错误提示。
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachHint, setAttachHint] = useState<string | null>(null)
  const attachHintTimerRef = useRef<number | null>(null)
  // 排队被拒的原因：不再静默吞掉（结算窗口关闭 / 目标队列项已被消费等）。
  const [queueRejection, setQueueRejection] = useState<QueueRejectionReason | null>(null)
  // 队列项行内编辑态：id 为编辑中的队列项，draft 为其文本。
  const [queueEditId, setQueueEditId] = useState<string | null>(null)
  const [queueEditDraft, setQueueEditDraft] = useState('')
  // 拖拽排序的在拖项：grip 把手发起，整行 draggable；落在目标行上/下半决定 above/below。
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // 提及高亮层：只画 token 背景，随 textarea 滚动同步位移。
  const highlightRef = useRef<HTMLDivElement | null>(null)
  const syncHighlightScroll = useCallback((event: { currentTarget: HTMLTextAreaElement }) => {
    const layer = highlightRef.current
    if (!layer) return
    layer.scrollTop = event.currentTarget.scrollTop
    layer.scrollLeft = event.currentTarget.scrollLeft
  }, [])
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
  const editQueuedMessage = useAgentStore((state) => state.editQueuedMessage)
  const moveQueuedMessage = useAgentStore((state) => state.moveQueuedMessage)
  const deleteQueuedMessage = useAgentStore((state) => state.deleteQueuedMessage)
  const sendQueuedNow = useAgentStore((state) => state.sendQueuedNow)
  const saveQueueAutoDrain = useAgentStore((state) => state.saveQueueAutoDrain)
  const queueAutoDrain = useAgentStore((state) => state.queueModeSettings.autoDrain)
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
  const armedQueueMessageId = useAgentStore((state) => state.armedQueueMessageId)
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
  const hasQueuedMessages = pendingSteeringCount > 0 || pendingFollowUpCount > 0 || pendingNextTurnCount > 0
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
            : hasQueuedMessages
              ? t('app.composer.placeholder.queued')
              : variant === 'new-task'
                ? t('app.composer.placeholder.default')
                : t('app.composer.placeholder.newTask')

  const clearAcceptedInput = useCallback(() => {
    setInput('')
    setCaret(0)
    setDismissedMentionKey(null)
    historyIndexRef.current = -1
  }, [])

  const clearAttachments = useCallback(() => {
    setAttachments((current) => {
      for (const attachment of current) revokeObjectUrl(attachment.previewUrl)
      return []
    })
  }, [])

  const showAttachHint = useCallback((message: string) => {
    setAttachHint(message)
    if (attachHintTimerRef.current !== null) window.clearTimeout(attachHintTimerRef.current)
    attachHintTimerRef.current = window.setTimeout(() => setAttachHint(null), 5000)
  }, [])

  useEffect(() => () => {
    if (attachHintTimerRef.current !== null) window.clearTimeout(attachHintTimerRef.current)
  }, [])

  // 队列提示与行内编辑态按会话隔离：切会话后残留的拒绝原因/编辑目标不得延续到新会话。
  useEffect(() => {
    setQueueRejection(null)
    setQueueEditId(null)
    setQueueEditDraft('')
  }, [activeSessionId])

  // 附件的函数式读取：粘贴压缩是异步链，避免闭包里的旧列表覆盖并发新增。
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // 非视觉模型直接拒绝附加（对齐运行时 model.input 校验，避免可预知的失败）；
  // profile 缺失等未知情形放行，交由运行时兜底。
  const modelAcceptsImages = useMemo(() => {
    try {
      return resolveModelDescriptor(provider).input?.includes('image') ?? false
    } catch {
      return true
    }
  }, [provider])

  const addAttachmentFiles = useCallback(async (files: File[]) => {
    if (!modelAcceptsImages) {
      showAttachHint(t('app.composer.attach.modelUnsupported'))
      return
    }
    const existing = attachmentsRef.current
    const room = MAX_PASTE_IMAGES - existing.length
    if (files.length > room) {
      showAttachHint(t('app.composer.attach.tooMany', { max: MAX_PASTE_IMAGES }))
    }
    const batch = files.slice(0, Math.max(0, room))
    const added: ComposerAttachment[] = []
    for (const file of batch) {
      try {
        added.push(await createAttachment(file))
      } catch (error) {
        showAttachHint(t(error instanceof ImageTooLargeError
          ? 'app.composer.attach.tooLarge'
          : 'app.composer.attach.failed'))
      }
    }
    if (added.length > 0) setAttachments((current) => [...current, ...added])
  }, [modelAcceptsImages, showAttachHint, t])

  // 剪贴板带图像时拦截默认粘贴，压缩后加入附件；纯文本粘贴走浏览器默认。
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (editRequest) return
    const files = imageFilesFromClipboard(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void addAttachmentFiles(files)
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id)
      if (target) revokeObjectUrl(target.previewUrl)
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  const deliverInput = useCallback(async (delivery: 'automatic' | 'follow-up' = 'automatic') => {
    const content = input.trim()
    const images = attachments
      .map((attachment) => toImageContentBlock(attachment))
    if ((!content && images.length === 0) || !composerAvailable) return false
    // 被接受即入史（直接发送与排队/跟进同权），与清空输入绑成单点。
    const accept = () => {
      if (content) historyRef.current = recordComposerHistoryEntry(content)
      clearAcceptedInput()
      clearAttachments()
    }
    // 编辑态提交：从该消息之前的分支边界重发；只有成功才清空输入，失败时保留
    // 用户改过的文本（失败原因由 store 写入 error 区）。新贴的图片不进入编辑链路，
    // 但原消息自带的图片块随重发保留（editRequest.images）。
    if (editRequest) {
      const accepted = await editUserMessage(editRequest.messageId, content, editRequest.images)
      if (!accepted) return false
      setMessageEditRequest(null)
      accept()
      return true
    }

    if (running) {
      const acceptance = await deliverQueuedContent(
        delivery === 'follow-up' ? queueFollowUp : queueSteering,
        content,
        accept,
        images.length > 0 ? images : undefined,
      )
      // 入队被拒（结算窗口关闭等）时保留输入并解释原因，不再静默丢弃。
      setQueueRejection(acceptance.accepted ? null : acceptance.reason)
      return acceptance.accepted
    }
    setQueueRejection(null)

    const latest = useAgentStore.getState()
    if (!isComposerAvailable({
      providerReady: latest.providerReady,
      providerSetupRequired: latest.providerSetupRequired,
      workspaceReady: Boolean(latest.authorizedWorkspace),
      sessionBusy: latest.sessionBusy,
      compactionRunning: latest.compactionRunning,
    }) || latest.running) return false
    void send(content, images.length > 0 ? images : undefined)
    accept()
    if (variant === 'new-task') setView('session')
    return true
  }, [
    attachments,
    clearAcceptedInput,
    clearAttachments,
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
  // `@` 模式的自动工作区候选（防抖检索 + 手动引用合并）：无工作区/非 Tauri 时空列表。
  const workspaceFileCandidates = useWorkspaceFileCandidates(
    activeMention?.kind === 'file' ? activeMention.query : null,
    mentionBrowseDir,
  )
  // 弹层关闭即回到工作区根：下钻态不跨会话/跨次提及残留。
  useEffect(() => {
    if (!activeMention) setMentionBrowseDir(null)
  }, [activeMention])
  const mentionCandidatesByKind = useMemo(() => ({
    ...candidatesByKind,
    file: mergeFileCandidates(candidatesByKind.file, workspaceFileCandidates),
  }), [candidatesByKind, workspaceFileCandidates])

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
    if (!isComposerSendKey(event, composingRef.current)) return
    if (!input.trim() && attachmentsRef.current.length === 0) return
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
    // 图片块回填为附件：不回填就等于「恢复编辑」静默丢图。
    const restoredAttachments = restored.images.flatMap((block) => {
      const attachment = attachmentFromImageBlock(block)
      if (!attachment) return []
      attachmentIdCounter += 1
      return [{ id: `attachment-${attachmentIdCounter}`, ...attachment }]
    })
    if (restoredAttachments.length > 0) {
      setAttachments((current) => [...current, ...restoredAttachments])
    }
    setDismissedMentionKey(null)
    historyIndexRef.current = -1
    queueMicrotask(() => textareaRef.current?.focus())
  }, [restoreQueuedMessage])

  /** 队列项行内编辑：打开时把当前文本带入编辑态（图片保留在队列项里，不进入编辑态）。 */
  const beginQueueEdit = useCallback((message: QueuedMessageSnapshot) => {
    setQueueEditId(message.id)
    setQueueEditDraft(message.content)
  }, [])

  const cancelQueueEdit = useCallback(() => {
    setQueueEditId(null)
    setQueueEditDraft('')
  }, [])

  // 队列操作统一收敛拒绝原因：不再静默吞掉（结算窗口关闭、队列项已被消费等）。
  const runQueueMutation = useCallback(async (
    operation: () => Promise<QueueMutationResult>,
  ): Promise<boolean> => {
    const result = await operation()
    setQueueRejection(result.updated ? null : result.reason)
    return result.updated
  }, [])

  const submitQueueEdit = useCallback(async (message: QueuedMessageSnapshot) => {
    const updated = await runQueueMutation(() => editQueuedMessage(message.id, queueEditDraft))
    if (updated) cancelQueueEdit()
  }, [cancelQueueEdit, editQueuedMessage, queueEditDraft, runQueueMutation])

  /** 上移/下移/置顶/提升为引导：全部表达为「相对显示序的移动」。 */
  const moveQueueItem = useCallback(async (
    messageId: string,
    target: QueueMoveTarget,
  ) => runQueueMutation(() => moveQueuedMessage(messageId, target)), [moveQueuedMessage, runQueueMutation])

  // 拖拽排序（取代上移/下移/置顶按钮）：显示序即 drain 序，跨类别 above/below 移动
  // 由 moveQueuedMessage 按落点重建队列；「提升为引导」由「立即」覆盖（steering 队首 + 武装）。
  const onQueueDragStart = useCallback((messageId: string, event: ReactDragEvent<HTMLLIElement>) => {
    setDraggingId(messageId)
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', messageId)
      event.dataTransfer.effectAllowed = 'move'
    }
  }, [])

  const onQueueDragOver = useCallback((messageId: string, event: ReactDragEvent<HTMLLIElement>) => {
    if (!draggingId || draggingId === messageId) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }, [draggingId])

  const onQueueDrop = useCallback((targetId: string, event: ReactDragEvent<HTMLLIElement>) => {
    event.preventDefault()
    const sourceId = draggingId ?? event.dataTransfer?.getData('text/plain') ?? null
    setDraggingId(null)
    if (!sourceId || sourceId === targetId) return
    const source = queuedMessages.find((message) => message.id === sourceId)
    if (!source) return
    // 行中线上半 → 插到目标上方，下半 → 下方；jsdom/测试事件无几何信息时默认「下方」。
    const rect = event.currentTarget.getBoundingClientRect()
    const before = event.clientY < rect.top + rect.height / 2
    void moveQueueItem(sourceId, {
      kind: source.kind,
      placement: { position: before ? 'above' : 'below', anchorId: targetId },
    })
  }, [draggingId, moveQueueItem, queuedMessages])

  // 键盘重排（拖拽的等价操作）：⌥↑/⌥↓ 相对显示序移动一行。行内编辑态与文本输入
  // 目标不拦截（编辑框的 ⌥↑ 仍是光标语义）。
  const onQueueRowKeyDown = useCallback((
    message: QueuedMessageSnapshot,
    index: number,
    event: ReactKeyboardEvent<HTMLLIElement>,
  ) => {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (queueEditId === message.id) return
    const target = event.target instanceof HTMLElement
      && (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
      ? null
      : (event.key === 'ArrowUp' ? queuedMessages[index - 1] : queuedMessages[index + 1])
    if (!target) return
    event.preventDefault()
    void moveQueueItem(message.id, {
      kind: message.kind,
      placement: { position: event.key === 'ArrowUp' ? 'above' : 'below', anchorId: target.id },
    })
  }, [moveQueueItem, queueEditId, queuedMessages])

  /** 立即发送一条队列项：运行中注入当前 run，空闲时取出该条走完整发送链路。 */
  const sendQueueItemNow = useCallback(async (messageId: string) => {
    const acceptance = await sendQueuedNow(messageId)
    setQueueRejection(acceptance.accepted ? null : acceptance.reason)
  }, [sendQueuedNow])

  // 「编辑消息」请求到达时回填原文并聚焦：请求本身由提交或放弃消费。
  // 编辑链路仅支持文本，进入编辑态时丢弃未发送的图片附件。
  useEffect(() => {
    if (!editRequest) return
    const content = editRequest.content
    setInput(content)
    setCaret(content.length)
    setDismissedMentionKey(null)
    historyIndexRef.current = -1
    clearAttachments()
    queueMicrotask(() => {
      const target = textareaRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(content.length, content.length)
    })
  }, [editRequest, clearAttachments])

  const cancelEdit = useCallback(() => {
    setMessageEditRequest(null)
    clearAcceptedInput()
  }, [clearAcceptedInput, setMessageEditRequest])

  const mentionBadges = useMemo(() => parseMentions(input), [input])
  const highlightSegments = useMemo(
    () => splitMentionSegments(input, mentionBadges),
    [input, mentionBadges],
  )

  /** chip 上的移除：按 token 完整范围切掉引用，并合并两侧空白。
      合并用两个空格：与 formatMentionToken 的尾随双空格一致，否则删掉中间一个引用后
      剩下的两个引用会塔回单空格、胶囊重新粘在一起（散文场景多一个空格无副作用）。 */
  const removeMention = useCallback((mention: ParsedMention) => {
    const before = input.slice(0, mention.tokenStart).replace(/\s+$/u, '')
    const after = input.slice(mention.tokenEnd).replace(/^\s+/u, '')
    const next = before.length > 0 && after.length > 0 ? `${before}  ${after}` : `${before}${after}`
    setInput(next)
    setCaret(next.length)
    queueMicrotask(() => textareaRef.current?.focus())
  }, [input])
  const recentWorkspaces = useMemo(
    () => recentWorkspaceEntries(authorizedWorkspaces, recentWorkspacePaths ?? []),
    [authorizedWorkspaces, recentWorkspacePaths],
  )
  const project = authorizedWorkspace?.name ?? t('app.composer.project.choose')
  const currentAccessMode = accessModeOptions.find((option) => option.value === accessMode) ?? accessModeOptions[0]!

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
        {hasQueuedMessages && (
          <div aria-live="polite" className="composer__queue" role="status">
            {!queueAutoDrain && (
              // 暂停通知（设计稿 W3wHMK）：中断后队列保留，「继续」恢复自动逐条发送。
              <>
                <div className="composer__queue-head">
                  <span className="composer__queue-head-text">{t('app.composer.queue.pausedNotice')}</span>
                  <button
                    className="composer__queue-textbtn"
                    onClick={() => { void clearQueuedMessages() }}
                    type="button"
                  >
                    {t('app.composer.queue.clear')}
                  </button>
                  <button
                    className="composer__queue-textbtn"
                    onClick={() => { saveQueueAutoDrain(true) }}
                    type="button"
                  >
                    {t('app.composer.queue.resume')}
                  </button>
                </div>
                <div className="composer__queue-divider" />
              </>
            )}
            <ul className="composer__queue-list">
              {queuedMessages.map((message, index) => (
                <li
                  data-dragging={draggingId === message.id || undefined}
                  draggable={queueEditId !== message.id}
                  key={message.id}
                  onDragEnd={() => { setDraggingId(null) }}
                  onDragOver={(event) => { onQueueDragOver(message.id, event) }}
                  onDragStart={(event) => { onQueueDragStart(message.id, event) }}
                  onDrop={(event) => { onQueueDrop(message.id, event) }}
                  onKeyDown={(event) => { onQueueRowKeyDown(message, index, event) }}
                >
                  {queueEditId === message.id ? (
                    <>
                      <textarea
                        aria-label={t('app.composer.queue.editAria')}
                        className="composer__queue-edit"
                        onChange={(event) => setQueueEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelQueueEdit()
                          } else if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault()
                            void submitQueueEdit(message)
                          }
                        }}
                        value={queueEditDraft}
                      />
                      <span className="composer__queue-note">
                        {message.images.length > 0
                          ? t('app.composer.queue.imagesKept', { count: message.images.length })
                          : null}
                      </span>
                      <div className="composer__queue-actions">
                        <button
                          aria-label={t('app.composer.queue.save')}
                          className="composer__queue-textbtn"
                          onClick={() => { void submitQueueEdit(message) }}
                          type="button"
                        >
                          <Check size={12} />
                          <span>{t('app.composer.queue.save')}</span>
                        </button>
                        <button
                          aria-label={t('app.composer.queue.cancel')}
                          className="composer__queue-iconbtn"
                          onClick={cancelQueueEdit}
                          type="button"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="composer__queue-grip" title={t('app.composer.queue.gripTitle')}>
                        <GripVertical aria-hidden="true" size={14} />
                      </span>
                      <span className="composer__queue-kind">{t(queueKindKey(message.kind))}</span>
                      <span className="composer__queue-preview">
                        {message.content || t('app.composer.queue.imagesOnly', { count: message.images.length })}
                      </span>
                      {message.content && message.images.length > 0 && (
                        <span className="composer__queue-note">
                          {t('app.composer.queue.images', { count: message.images.length })}
                        </span>
                      )}
                      <div className="composer__queue-actions">
                        <button
                          aria-label={message.id === armedQueueMessageId
                            ? t('app.composer.queue.armed')
                            : running
                              ? t('app.composer.queue.sendNow')
                              : t('app.composer.queue.sendNowNewRun')}
                          className={message.id === armedQueueMessageId
                            ? 'composer__queue-send composer__queue-send--armed'
                            : 'composer__queue-send'}
                          // 「队首引导会被自动消费」只在运行中成立：空闲时（崩溃恢复、
                          // 暂停期残留）禁用会让唯一入口失效，应允许点击走新 run 发送。
                          disabled={running && index === 0 && message.kind === 'steering' && queueAutoDrain}
                          onClick={() => { void sendQueueItemNow(message.id) }}
                          title={message.id === armedQueueMessageId ? t('app.composer.queue.armed') : undefined}
                          type="button"
                        >
                          <ArrowUp size={13} />
                          <span>{t('app.composer.queue.sendNowShort')}</span>
                        </button>
                        <button
                          aria-label={t('app.composer.queue.edit')}
                          className="composer__queue-iconbtn composer__queue-iconbtn--edit"
                          onClick={() => beginQueueEdit(message)}
                          type="button"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          aria-label={t('app.composer.queue.delete')}
                          className="composer__queue-iconbtn composer__queue-iconbtn--delete"
                          onClick={() => { void runQueueMutation(() => deleteQueuedMessage(message.id)) }}
                          type="button"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {queueRejection && (
              <div aria-live="polite" className="composer__queue-hint" role="status">
                {t(queueRejectionKey(queueRejection))}
              </div>
            )}
          </div>
        )}
        {recoveredQueuedMessages.length > 0 && (
          // 恢复草稿卡（设计稿 K38RI）：accent 低饱和描边与待发送队列区分。
          <div aria-live="polite" className="composer__queue composer__queue--recovered" role="status">
            <div className="composer__queue-head">
              <span className="composer__queue-head-text">
                {t('app.composer.queue.recovered', { count: recoveredQueuedMessages.length })}
              </span>
            </div>
            <div className="composer__queue-divider" />
            <ul className="composer__queue-list">
              {recoveredQueuedMessages.map((message) => (
                <li key={message.id}>
                  <span className="composer__queue-preview">{message.content}</span>
                  <button
                    className="composer__queue-textbtn"
                    onClick={() => { void restoreToComposer(message.id) }}
                    type="button"
                  >
                    {t('app.composer.queue.restore')}
                  </button>
                  <button
                    className="composer__queue-textbtn composer__queue-textbtn--discard"
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
      <div className="composer__input-wrap" style={{ position: 'relative' }}>
        {activeMention && (
          <MentionPopover
            active={activeMention}
            candidates={mentionCandidatesByKind[activeMention.kind]}
            onClose={() => setDismissedMentionKey(detectedMentionKey)}
            onSelect={insertMention}
            onAuthorizeFile={() => { void authorizeFile() }}
            onAuthorizeDirectory={() => { void authorizeDirectory() }}
            browsePath={mentionBrowseDir}
            onEnterDirectory={(candidate) => {
              setMentionBrowseDir(candidate.relativePath ?? null)
              // 下钻 = 「浏览该目录」：清掉已输入的检索词，展示新目录的内容。
              if (!activeMention) return
              const next = input.slice(0, activeMention.triggerStart + 1)
              setInput(next)
              setCaret(next.length)
            }}
            onExitDirectory={() => setMentionBrowseDir((current) => {
              if (!current) return null
              const parent = current.split('/').slice(0, -1).join('/')
              return parent.length > 0 ? parent : null
            })}
          />
        )}
        <div className="composer__editor">
          <div aria-hidden className="composer__editor-highlight" ref={highlightRef}>
            {highlightSegments.map((segment, index) => (
              segment.isMention
                ? (
                  <span className="composer__mention-token" key={index}>
                    {segment.text}
                  </span>
                )
                : <span key={index}>{segment.text}</span>
            ))}
            {'\u200b'}
          </div>
          <textarea
            aria-label={t('app.composer.aria.send')}
            className="composer__textarea"
            disabled={!composerAvailable}
            onChange={onChange}
            onCompositionEnd={() => { composingRef.current = false }}
            onCompositionStart={() => { composingRef.current = true }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onScroll={syncHighlightScroll}
            onSelect={onSelectEvent}
            onClick={onSelectEvent}
            onKeyUp={onSelectEvent}
            placeholder={placeholder}
            ref={textareaRef}
            rows={3}
            value={input}
          />
        </div>
        {attachHint && (
          <div aria-live="polite" className="composer__attach-hint" role="status">
            {attachHint}
          </div>
        )}
        {attachments.length > 0 && (
          <div aria-label={t('app.composer.attach.aria')} className="composer__attachments">
            {attachments.map((attachment) => (
              <span className="composer__attachment" key={attachment.id}>
                <img alt="" src={attachment.previewUrl} />
                <button
                  aria-label={t('app.composer.attach.remove')}
                  className="composer__attachment-remove"
                  onClick={() => removeAttachment(attachment.id)}
                  title={t('app.composer.attach.remove')}
                  type="button"
                >
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        {editRequest && (
          <div aria-live="polite" className="composer__edit-banner" role="status">
            <Pencil size={12} />
            <span className="composer__edit-text">
              <span className="composer__edit-title">{t('app.sessionView.editing')}</span>
              <span className="composer__edit-hint">
                {(editRequest.images?.length ?? 0) > 0
                  ? t('app.sessionView.editingHintImages', { count: editRequest.images?.length ?? 0 })
                  : t('app.sessionView.editingHint')}
              </span>
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
            {mentionBadges.map((badge) => {
              const { Icon: BadgeIcon, kindKey, displayLabel } = mentionChipMeta(badge)
              return (
                <span
                  className="composer__mention-badge"
                  key={`${badge.kind}-${badge.tokenStart}-${badge.id ?? badge.label}`}
                  title={badge.id ?? badge.label}
                >
                  <BadgeIcon className="composer__mention-badge-icon" size={12} />
                  <span className="composer__mention-badge-kind">{t(kindKey)}</span>
                  <span className="composer__mention-badge-label">{displayLabel}</span>
                  <button
                    aria-label={t('app.composer.mention.remove')}
                    className="composer__mention-badge-remove"
                    onClick={() => removeMention(badge)}
                    type="button"
                  >
                    <X size={10} />
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <div className="composer__controls">
          <div className="composer__access-picker" ref={accessPickerRef}>
            <button
              type="button"
              className="composer__access-mode"
              data-mode={accessMode}
              aria-expanded={accessMenuOpen}
              aria-label={t('app.composer.access.ariaCurrent', { mode: t(currentAccessMode.labelKey) })}
              onClick={() => toggleMenu('access')}
            >
              {accessMode === 'no-approval' ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
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
          <ReasoningPicker disabled={running || sessionBusy || providerSaving} />
          {running && (
            <button
              className="composer__follow-up"
              aria-label={t('app.composer.followUpTitle')}
              disabled={!composerAvailable || (!input.trim() && attachments.length === 0)}
              onClick={() => { void deliverInput('follow-up') }}
              title={t('app.composer.followUpTitle')}
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
            className={`composer__send ${composerAvailable && (input.trim() || attachments.length > 0) ? 'composer__send--ready' : ''}`}
            aria-label={editRequest
              ? t('app.composer.send.edit')
              : running
                ? t('app.composer.send.running')
                : t('app.composer.send.idle')}
            disabled={!composerAvailable || (!input.trim() && attachments.length === 0)}
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
