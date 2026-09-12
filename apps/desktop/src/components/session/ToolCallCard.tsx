import { useMemo } from 'react'
import { Check, ChevronDown, Compass, FileText, SquarePen, Sparkles, Folder, Plug, ListChecks, Search, Globe, Loader2 } from 'lucide-react'
import type { AssistantMessage, ToolResultMessage } from '@/agent/core/types'
import { useAgentStore } from '@/stores/agentStore'
import { useT } from '@/i18n'

const formatSize = (bytes: number): string => bytes < 1024
  ? `${bytes} B`
  : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`

const capitalize = (value: string): string => value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value

const renderIconForTool = (toolName: string) => {
  switch (toolName) {
    case 'read':
    case 'find':
    case 'grep':
      return FileText
    case 'edit':
    case 'apply_changes':
    case 'write':
      return SquarePen
    case 'ls':
      return ListChecks
    case 'restore_trash':
      return Folder
    case 'bash':
      return Sparkles
    case 'discover_agent_tools':
      return Plug
    case 'explore_subagent':
      return Compass
    case 'web_search':
    case 'web_fetch':
      return Globe
    case 'browser':
      return Globe
    default:
      return Search
  }
}

interface ToolCallCardProps {
  toolCallId?: string
  toolName: string
  call?: AssistantMessage
  result?: ToolResultMessage
}

interface ToolCallArgs {
  path?: string
  pattern?: string
  command?: string
  executable?: string
  args?: unknown[]
  operations?: unknown[]
  task?: string
  scope?: unknown[]
  query?: string
  url?: string
}

const readToolArgs = (
  call: AssistantMessage | undefined,
  toolCallId: string | undefined,
): ToolCallArgs => {
  if (!call) return {}
  for (const block of call.contentBlocks ?? []) {
    if (block.type === 'tool_call' && (!toolCallId || block.id === toolCallId)) {
      const value = block.arguments
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as ToolCallArgs
      }
    }
  }
  const toolCall = call.toolCalls.find((candidate) => !toolCallId || candidate.id === toolCallId)
  if (toolCall?.arguments && typeof toolCall.arguments === 'object' && !Array.isArray(toolCall.arguments)) {
    return toolCall.arguments as ToolCallArgs
  }
  return {}
}

const resolveTitle = (
  toolName: string,
  toolCallId?: string,
  call?: AssistantMessage,
  result?: ToolResultMessage,
): string => {
  const args = readToolArgs(call, toolCallId)
  if (args.path) {
    return toolName === 'restore_trash' ? `Restore ${args.path}` : `${capitalize(toolName)} ${args.path}`
  }
  if (args.pattern) return `${capitalize(toolName)} ${args.pattern}`
  if (toolName === 'web_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const preview = query.length > 64 ? `${query.slice(0, 64)}…` : query
    return preview ? `Search web ${preview}` : 'Search web'
  }
  if (toolName === 'web_fetch') {
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    const preview = url.length > 80 ? `${url.slice(0, 80)}…` : url
    return preview ? `Fetch ${preview}` : 'Fetch web'
  }
  if (toolName === 'bash') {
    const cmd = typeof args.command === 'string' ? args.command : ''
    const preview = cmd.length > 60 ? `${cmd.slice(0, 60)}...` : cmd
    return preview ? `Run ${preview}` : 'Run bash'
  }
  if (toolName === 'apply_changes' && Array.isArray(args.operations)) {
    const operations = args.operations.length
    return `Apply ${operations} workspace change${operations === 1 ? '' : 's'}`
  }
  if (toolName === 'explore_subagent') {
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    const scope = Array.isArray(args.scope)
      ? args.scope.filter((s): s is string => typeof s === 'string')
      : []
    // scope 最多展示 3 项，超出用省略号表示；让用户直观看到 Explore 的搜索边界。
    const scopeNote = scope.length > 0
      ? ` [${scope.slice(0, 3).join(', ')}${scope.length > 3 ? '…' : ''}]`
      : ''
    const preview = task.length > 64 ? `${task.slice(0, 64)}…` : task
    return preview || scopeNote
      ? `Explore ${preview}${scopeNote}`
      : 'Explore'
  }
  if ((result?.contentBlocks?.length ?? 0) > 0) {
    return capitalize(toolName)
  }
  return capitalize(toolName)
}

interface DetailNumbers {
  diffAdded?: number
  diffRemoved?: number
  sizeBytes?: number
}

const readNumbers = (details: unknown): DetailNumbers => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {}
  return details as DetailNumbers
}

/** 结果 details 里的 diff 预览文本（写工具成功时由工具层注入，空串视为缺失）。 */
const readDiffPreview = (details: unknown): string | undefined => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const preview = (details as Record<string, unknown>).diffPreview
  return typeof preview === 'string' && preview.trim().length > 0 ? preview : undefined
}

/** 注入 diff details 的写工具白名单：其余工具不带该字段，也不进入折叠视图。 */
const DIFF_TOOLS = new Set(['write', 'edit', 'apply_changes'])

/** diff 行着色分类：文件头/hunk 头为 meta，其余按行首 +/- 分列。 */
const diffLineKind = (line: string): 'add' | 'remove' | 'meta' | 'context' => {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}

/** Explore 子代理结果 details：status/endReason/turns/toolCalls/modelRequests/durationMs/usage。 */
interface ExploreDetails {
  status?: string
  endReason?: string
  turns?: number
  toolCalls?: number
  modelRequests?: number
  durationMs?: number
  /** 父 run 累计 token/cost 快照（内存累计，不持久化）。 */
  usage?: { inputTokens: number; outputTokens: number; costTotal: number }
}

const readExploreDetails = (details: unknown): ExploreDetails => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {}
  const value = details as Record<string, unknown>
  const asNumber = (key: string): number | undefined =>
    typeof value[key] === 'number' ? (value[key] as number) : undefined
  const asString = (key: string): string | undefined =>
    typeof value[key] === 'string' ? (value[key] as string) : undefined
  // parentRunUsage 是嵌套对象，独立解析三个数值字段。
  const usageRaw = value.parentRunUsage
  let usage: ExploreDetails['usage']
  if (usageRaw && typeof usageRaw === 'object' && !Array.isArray(usageRaw)) {
    const u = usageRaw as Record<string, unknown>
    const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : undefined
    const outputTokens = typeof u.outputTokens === 'number' ? u.outputTokens : undefined
    const costTotal = typeof u.costTotal === 'number' ? u.costTotal : undefined
    if (inputTokens !== undefined && outputTokens !== undefined && costTotal !== undefined) {
      usage = { inputTokens, outputTokens, costTotal }
    }
  }
  return {
    status: asString('status'),
    endReason: asString('endReason'),
    turns: asNumber('turns'),
    toolCalls: asNumber('toolCalls'),
    modelRequests: asNumber('modelRequests'),
    durationMs: asNumber('durationMs'),
    ...(usage ? { usage } : {}),
  }
}

/** 从运行时 progress details 提取累计失败次数（子 Agent 工具调用 isError 计数）。 */
const readProgressErrors = (details: unknown): number | undefined => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const value = details as Record<string, unknown>
  return typeof value.errors === 'number' ? value.errors : undefined
}

export const ToolCallCard = ({ toolCallId, toolName, call, result }: ToolCallCardProps) => {
  const { t } = useT()
  const Icon = renderIconForTool(toolName)
  const title = useMemo(
    () => resolveTitle(toolName, toolCallId, call, result),
    [toolName, toolCallId, call, result],
  )
  const completed = result !== undefined && !result.isError
  const errored = result?.isError === true
  const numbers = readNumbers(result?.details)
  const added = numbers.diffAdded ?? 0
  const removed = numbers.diffRemoved ?? 0
  const sizeBytes = numbers.sizeBytes ?? 0
  // 粒度订阅：仅本 toolCallId 的 activeTools 条目变化才触发重渲染
  // （zustand selector 对对象引用做 Object.is 比较，其他工具更新不影响本卡片）。
  const activeTool = useAgentStore((state) => (toolCallId ? state.activeTools[toolCallId] : undefined))
  const running = activeTool !== undefined && result === undefined
  const explore = toolName === 'explore_subagent' ? readExploreDetails(result?.details) : undefined
  const progressErrors = readProgressErrors(activeTool?.details)
  // Explore 摘要（结论/调用链/证据）对用户可展开查看——不再只喂给模型。
  const summaryContent = toolName === 'explore_subagent' && !running
    && typeof result?.content === 'string' && result.content.trim()
    ? result.content
    : undefined
  // 写工具（write/edit/apply_changes）成功结果的 diff 预览：可展开回看改动内容。
  const diffPreview = completed && DIFF_TOOLS.has(toolName)
    ? readDiffPreview(result?.details)
    : undefined

  const cardClassName = `tool-card${running ? ' tool-card--running' : ''}`
  const ariaLabel = `Tool call ${toolName}`

  const headerChildren = (
    <>
      <Icon size={15} className="tool-card__icon" />
      <span className="tool-card__title">{title}</span>
      <span className="tool-card__meta">
        {running && (
          <>
            <span className="tool-card__meta-progress">{activeTool.content || t('app.session.toolCard.running')}</span>
            {progressErrors ? (
              <span className="tool-card__meta-reason"> {t('app.session.toolCard.failedCount', { count: progressErrors })}</span>
            ) : null}
          </>
        )}
        {!running && explore && (
          <>
            {explore.status && (
              <span className={`tool-card__meta-status tool-card__meta-status--${explore.status}`}>
                {explore.status}
              </span>
            )}
            {typeof explore.turns === 'number' && <span> · {explore.turns} turns</span>}
            {typeof explore.toolCalls === 'number' && <span> · {explore.toolCalls} calls</span>}
            {typeof explore.durationMs === 'number' && (
              <span> · {(explore.durationMs / 1000).toFixed(1)}s</span>
            )}
            {explore.usage && (
              <span> · {(explore.usage.inputTokens + explore.usage.outputTokens).toLocaleString()} tokens</span>
            )}
            {explore.status === 'partial' && explore.endReason && (
              <span className="tool-card__meta-reason"> ({explore.endReason})</span>
            )}
          </>
        )}
        {!running && !explore && (
          <>
            {added > 0 && <span className="tool-card__meta-diff-add">+{added}</span>}
            {removed > 0 && <span className="tool-card__meta-diff-remove">−{removed}</span>}
            {!added && !removed && sizeBytes > 0 && <span>{formatSize(sizeBytes)}</span>}
          </>
        )}
      </span>
      {running && <Loader2 size={14} className="tool-card__spinner" aria-hidden />}
      {completed && <Check size={14} className="tool-card__done" aria-hidden />}
      {errored && <ChevronDown size={14} className="tool-card__chevron" aria-hidden />}
    </>
  )

  if (summaryContent || diffPreview) {
    return (
      <details className={`${cardClassName} tool-card--expandable`} aria-label={ariaLabel}>
        <summary className="tool-card__summary-toggle">{headerChildren}</summary>
        {summaryContent ? (
          <div className="tool-card__summary-body">{summaryContent}</div>
        ) : (
          <div className="tool-card__diff-body" aria-label={t('app.session.toolCard.diffAria')}>
            {(diffPreview as string).split('\n').map((line, index) => (
              <div
                key={index}
                className={`tool-card__diff-line tool-card__diff-line--${diffLineKind(line)}`}
              >
                {line.length > 0 ? line : ' '}
              </div>
            ))}
          </div>
        )}
      </details>
    )
  }

  return (
    <div className={cardClassName} role="group" aria-label={ariaLabel}>
      {headerChildren}
    </div>
  )
}
