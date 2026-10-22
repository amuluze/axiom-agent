import type { AgentMutationBatch } from '@/agent/core/types'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'
import { encodeAgentMessage } from './messageCodec'

/**
 * `commit_session_mutation_batch` 的 wire request 与幂等身份。
 *
 * 这是**纯编码层**：不 import Tauri、不调用宿主。放在 persistence 而不是
 * platform，是为了让 MemorySessionRepository 与 SqliteSessionRepository 共享
 * 同一份 effect identity，并保持内存仓储可脱离 Tauri 适配层测试。
 */

interface SessionMutationMessage {
  id: string
  role: string
  contentJson: string
  createdAt: number
}

export interface CommitSessionMutationBatchRequest {
  batchId: string
  sessionId: string
  runId?: string
  turn?: number
  eventCount: number
  messages: SessionMutationMessage[]
  systemPrompt?: string
  modelProvider?: string
  modelId?: string
  reasoningUpdated: boolean
  reasoningJson?: string | null
  activeToolNames?: string[]
  runtimeManifestJson?: string
  /** runtime_dependencies_update：原子替换 dependencies 并在同一事务删除 checkpoint。 */
  runtimeDependenciesUpdated: boolean
  journalEntryIds: string[]
  createdAt: number
}

export const createSessionMutationRequest = (
  batch: AgentMutationBatch,
  runtimeManifest?: RuntimeDependencyManifest,
): CommitSessionMutationBatchRequest => {
  const messages: SessionMutationMessage[] = []
  let systemPrompt: string | undefined
  let modelProvider: string | undefined
  let modelId: string | undefined
  let reasoningUpdated = false
  let reasoningJson: string | null | undefined
  let activeToolNames: string[] | undefined
  let runtimeDependenciesUpdated = false

  for (const event of batch.events) {
    if (event.type === 'session_message_append') {
      messages.push({
        id: event.message.id,
        role: event.message.role,
        contentJson: encodeAgentMessage(event.message),
        createdAt: event.message.createdAt,
      })
    } else if (event.type === 'runtime_system_prompt_update') {
      systemPrompt = event.current
    } else if (event.type === 'runtime_model_update') {
      modelProvider = event.current.provider
      modelId = event.current.model
    } else if (event.type === 'runtime_reasoning_update') {
      reasoningUpdated = true
      reasoningJson = event.current ? JSON.stringify(event.current) : null
    } else if (event.type === 'runtime_tools_update') {
      activeToolNames = event.current.activeToolNames.slice()
    } else if (event.type === 'runtime_dependencies_update') {
      runtimeDependenciesUpdated = true
      systemPrompt = event.current.systemPrompt
      activeToolNames = event.current.activeToolNames.slice()
    }
  }

  if (runtimeDependenciesUpdated && batch.events.some((event) =>
    event.type !== 'runtime_dependencies_update' && event.type !== 'session_message_append')) {
    throw new Error('runtime_dependencies_update 不能与其他 Runtime mutation event 混用')
  }

  if ((activeToolNames !== undefined) !== (runtimeManifest !== undefined)) {
    throw new Error('Runtime 工具更新必须原子携带 dependency manifest')
  }

  return {
    batchId: batch.id,
    sessionId: batch.sessionId,
    ...(batch.runId ? { runId: batch.runId } : {}),
    ...(batch.turn !== undefined ? { turn: batch.turn } : {}),
    eventCount: batch.events.length,
    messages,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(modelProvider !== undefined ? { modelProvider, modelId } : {}),
    reasoningUpdated,
    ...(reasoningUpdated ? { reasoningJson: reasoningJson ?? null } : {}),
    ...(activeToolNames ? { activeToolNames } : {}),
    ...(runtimeManifest ? { runtimeManifestJson: JSON.stringify(runtimeManifest) } : {}),
    runtimeDependenciesUpdated,
    journalEntryIds: batch.journalEntryIds?.slice() ?? [],
    createdAt: batch.createdAt,
  }
}

export const createSessionMutationEffectIdentity = (
  batch: AgentMutationBatch,
  runtimeManifest?: RuntimeDependencyManifest,
): string => {
  const request = createSessionMutationRequest(batch, runtimeManifest)
  return JSON.stringify({
    sessionId: request.sessionId,
    messages: request.messages.map((message) => JSON.parse(message.contentJson)),
    systemPrompt: request.systemPrompt,
    modelProvider: request.modelProvider,
    modelId: request.modelId,
    reasoningUpdated: request.reasoningUpdated,
    reasoning: request.reasoningJson === undefined ? undefined : JSON.parse(request.reasoningJson ?? 'null'),
    activeToolNames: request.activeToolNames,
    runtimeManifest: request.runtimeManifestJson === undefined
      ? undefined
      : JSON.parse(request.runtimeManifestJson),
    runtimeDependenciesUpdated: request.runtimeDependenciesUpdated,
    journalEntryIds: request.journalEntryIds.slice().sort(),
  })
}
