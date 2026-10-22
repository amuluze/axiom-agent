/**
 * 探索轨迹抽取：把一次探索会话的消息序列压成「按发生顺序排列的工具步骤」。
 *
 * 轨迹本身没有独立的 ToolCallMessage——工具调用挂在 `AssistantMessage.toolCalls`
 * 上，结果挂在 `ToolResultMessage` 上，两者按 `toolCallId` 配对。本模块只做纯数据
 * 整理（不读 platform、不碰 store），供固化层消费。
 */

import type { AgentMessage, JsonValue } from '../../core/types'

/**
 * 可固化的探索工具集合。只读探索工具（`ui_snapshot` / `ui_find`）与其它非探索工具
 * 不进入轨迹——它们是取证手段，不是可重放的测试步骤。
 */
export const EXPLORER_TOOL_NAMES = [
  'ui_navigate',
  'ui_click',
  'ui_input',
  'ui_select',
  'ui_press',
  'ui_wait',
  'ui_assert',
  'ui_screenshot',
  'api_request',
] as const

export type ExplorerToolName = (typeof EXPLORER_TOOL_NAMES)[number]

const EXPLORER_TOOL_TABLE: Record<string, true> = Object.fromEntries(
  EXPLORER_TOOL_NAMES.map((name) => [name, true]),
)

export const isExplorerToolName = (name: string): name is ExplorerToolName =>
  EXPLORER_TOOL_TABLE[name] === true

/** 工具结果的投影：只保留固化需要的三个字段。 */
export interface ExplorerStepResult {
  isError: boolean
  content: string
  details?: JsonValue
}

export interface ExplorerStep {
  /** 配对键：assistant 工具调用与 tool 结果共有的 `toolCallId`。 */
  toolCallId: string
  toolName: ExplorerToolName
  /** 原始工具入参（即 `ToolCall.arguments`）。 */
  input: JsonValue
  /** 未配对（轨迹被截断、结果尚未回填）时为 `undefined`。 */
  result?: ExplorerStepResult
}

/**
 * 按消息出现顺序抽取探索步骤。稳健性约束：任何形状异常（缺 toolCalls、名字非字符串、
 * 结果无对应调用、同一调用重复出现）都不抛错——最坏情况是丢掉一个步骤或保留
 * `result: undefined`，由固化层标 `result-missing`。
 */
export const extractExplorerSteps = (messages: readonly AgentMessage[]): ExplorerStep[] => {
  const steps: ExplorerStep[] = []
  const byCallId = new Map<string, ExplorerStep>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
      for (const call of toolCalls) {
        if (typeof call?.id !== 'string' || typeof call.name !== 'string') continue
        if (!isExplorerToolName(call.name)) continue
        const step: ExplorerStep = {
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
        }
        steps.push(step)
        // 同一 id 只登记首个步骤；后续重复调用仍出现在 steps 里，但配对锚点保持首个。
        if (!byCallId.has(call.id)) byCallId.set(call.id, step)
      }
      continue
    }

    if (message.role === 'tool') {
      const step = byCallId.get(message.toolCallId)
      if (!step) continue
      // 首个结果生效，忽略重复回填。
      if (step.result) continue
      step.result = {
        isError: message.isError === true,
        content: message.content,
        ...(message.details === undefined ? {} : { details: message.details }),
      }
    }
  }

  return steps
}

/**
 * 写入类工具：它们的目标路径就是"会话声称产出的文件"。只读工具（read/ls/grep/find）
 * 是取证手段，不是产出；`restore_trash` 是恢复既有文件，也不算产出。
 */
export const FILE_PRODUCING_TOOL_NAMES = ['write', 'edit', 'apply_changes'] as const

export type FileProducingToolName = (typeof FILE_PRODUCING_TOOL_NAMES)[number]

const FILE_PRODUCING_TOOL_TABLE: Record<string, true> = Object.fromEntries(
  FILE_PRODUCING_TOOL_NAMES.map((name) => [name, true]),
)

/** 工作区用例文件路径：`tests/**\/*.testspec.json`（相对路径），旧后缀 `.testspec.json` 仍被识别。 */
const SPEC_FILE_PATH_PATTERN = /^tests\/(?:[^/\n]+\/)*[^/\n]+\.(?:testspec\.json|test\.ax)$/u

/**
 * 归一化一个可能是用例文件的路径：接受工作区相对路径，也接受绝对路径（取最后一个
 * `/tests/` 之后的部分）。不是用例文件则返回 `null`——写入产品源码、文档或其它
 * `.ax` 文件都不属于"用例产物"。
 */
export const normalizeSpecPath = (raw: string): string | null => {
  const trimmed = raw.trim()
  const marker = '/tests/'
  const candidate = trimmed.startsWith('/') && trimmed.includes(marker)
    ? trimmed.slice(trimmed.lastIndexOf(marker) + 1)
    : trimmed
  return SPEC_FILE_PATH_PATTERN.test(candidate) ? candidate : null
}

/** 会话对某个用例文件的一次写入声明。 */
export interface WrittenSpecFile {
  path: string
  toolName: FileProducingToolName
  /**
   * 该路径的写入结果：`true` = 所有写入都报错，`false` = 至少成功一次，
   * `undefined` = 结果未配对（轨迹被截断或结果尚未回填）。
   */
  isError: boolean | undefined
}

const specPathOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? normalizeSpecPath(value) : null

/** 从一次写入调用的入参里取出它触达的用例文件路径（`apply_changes` 可能一次多条）。 */
const specPathsFromArguments = (toolName: FileProducingToolName, args: JsonValue): string[] => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return []
  const record = args as Record<string, unknown>
  if (toolName !== 'apply_changes') {
    const path = specPathOf(record.path)
    return path === null ? [] : [path]
  }
  const changes = Array.isArray(record.changes) ? record.changes : []
  const paths: string[] = []
  for (const change of changes) {
    if (typeof change !== 'object' || change === null || Array.isArray(change)) continue
    const operation = change as Record<string, unknown>
    // `path` 覆盖 create-file / patch-file / create-directory / trash；
    // move 用 from → to，两端都算（源曾是用例文件，目标成为用例文件）。
    for (const key of ['path', 'from', 'to'] as const) {
      const path = specPathOf(operation[key])
      if (path !== null) paths.push(path)
    }
  }
  return paths
}

/**
 * 抽取会话"声称产出的用例文件"：按出现顺序去重，同一路径重复写入时**成功优先**
 * （一次成功即算产出，即使另有失败尝试）。
 *
 * 稳健性同 {@link extractExplorerSteps}：任何形状异常都不抛错。
 */
export const extractWrittenSpecFiles = (messages: readonly AgentMessage[]): WrittenSpecFile[] => {
  const order: string[] = []
  const byPath = new Map<string, WrittenSpecFile>()
  const pathsByCallId = new Map<string, string[]>()

  const record = (path: string, toolName: FileProducingToolName): void => {
    if (byPath.has(path)) return
    order.push(path)
    byPath.set(path, { path, toolName, isError: undefined })
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
      for (const call of toolCalls) {
        if (typeof call?.id !== 'string' || typeof call.name !== 'string') continue
        if (FILE_PRODUCING_TOOL_TABLE[call.name] !== true) continue
        const toolName = call.name as FileProducingToolName
        const paths = specPathsFromArguments(toolName, call.arguments)
        if (paths.length === 0) continue
        for (const path of paths) record(path, toolName)
        pathsByCallId.set(call.id, paths)
      }
      continue
    }
    if (message.role === 'tool') {
      const paths = pathsByCallId.get(message.toolCallId)
      if (paths === undefined) continue
      for (const path of paths) {
        const entry = byPath.get(path)
        if (entry === undefined) continue
        entry.isError = message.isError === true ? (entry.isError === false ? false : true) : false
      }
    }
  }

  return order.map((path) => byPath.get(path)!)
}
