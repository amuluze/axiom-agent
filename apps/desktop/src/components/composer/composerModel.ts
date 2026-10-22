/**
 * Composer 的纯规则与派生层（自 Composer 抽出的无状态部分）。
 *
 * 这里只放不碰 React 状态的判定与派生：可用性、发送/历史按键语义、提及 chip
 * 元数据、队列键、工作区「最近打开」派生与粘贴附件构造。组件保留交互状态机
 * （菜单、提及、拖拽、队列编辑），单向消费本模块。
 */
import { FileText, Folder, Hash, Sparkles } from 'lucide-react'
import type { AccessMode } from '@/agent/approval/ApprovalCoordinator'
import type { ImageContentBlock } from '@/agent/core/types'
import type { QueueAcceptance, QueueRejectionReason } from '@/agent/runtime/queueContracts'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import {
  attachmentFromImageBlock,
  compressPastedImage,
  objectUrlForFile,
} from '@/components/composer/imagePaste'
import type { ActiveMention, ParsedMention } from '@/components/composer/mentionParser'

export const accessModeOptions: Array<{
  value: AccessMode
  labelKey: string
  descriptionKey: string
}> = [
  { value: 'standard', labelKey: 'app.composer.access.standard', descriptionKey: 'app.composer.access.standardDesc' },
  { value: 'no-approval', labelKey: 'app.composer.access.fullAccess', descriptionKey: 'app.composer.access.fullAccessDesc' },
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

export const mentionKey = (mention: ActiveMention | null): string | null => mention
  ? `${mention.kind}:${mention.triggerStart}:${mention.queryEnd}:${mention.query}`
  : null

export const queueKindKey = (kind: string): string => {
  if (kind === 'steering') return 'app.composer.queueKind.steering'
  if (kind === 'follow-up') return 'app.composer.queueKind.followUp'
  return 'app.composer.queueKind.nextTurn'
}

export const queueRejectionKey = (reason: QueueRejectionReason): string =>
  `app.composer.queue.reject.${reason}`

export interface ComposerAttachment {
  id: string
  mediaType: string
  base64: string
  previewUrl: string
}

let attachmentIdCounter = 0

export const createAttachment = async (file: File): Promise<ComposerAttachment> => {
  const image = await compressPastedImage(file)
  attachmentIdCounter += 1
  return {
    id: `paste-${attachmentIdCounter}`,
    mediaType: image.mediaType,
    base64: image.base64,
    previewUrl: objectUrlForFile(file),
  }
}

/** 队列项恢复编辑时的图片回填：不回填就等于「恢复编辑」静默丢图。 */
export const attachmentsFromImageBlocks = (blocks: ImageContentBlock[]): ComposerAttachment[] =>
  blocks.flatMap((block) => {
    const attachment = attachmentFromImageBlock(block)
    if (!attachment) return []
    attachmentIdCounter += 1
    return [{ id: `attachment-${attachmentIdCounter}`, ...attachment }]
  })
