import type { AgentMutationBatch, AgentMutationReceipt } from '@/agent/core/types'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'
import { createSessionMutationRequest } from '@/persistence/sessionMutationPayload'
import { invoke } from '@tauri-apps/api/core'

/**
 * 把 wire receipt 中的 `null` 可选字段归一为 undefined（双保险：Rust 侧已用
 * skip_serializing_if 让 None 不进 JSON，此处防御任何残留的 null 形态）——
 * AgentSession / runAgentLoop 的 ownership 校验对 receipt 字段做严格比较，
 * `null !== undefined` 会把每次成功的空闲 mutation 误判为 ownership 不一致。
 */
const normalizeMutationReceipt = (receipt: AgentMutationReceipt): AgentMutationReceipt => ({
  batchId: receipt.batchId,
  sessionId: receipt.sessionId,
  runId: receipt.runId ?? undefined,
  turn: receipt.turn ?? undefined,
  committedAt: receipt.committedAt,
  replayed: receipt.replayed,
})

export const commitSessionMutationBatch = async (
  batch: AgentMutationBatch,
  runtimeManifest?: RuntimeDependencyManifest,
): Promise<AgentMutationReceipt> => {
  const receipt = await invoke<AgentMutationReceipt>('commit_session_mutation_batch', {
    request: createSessionMutationRequest(batch, runtimeManifest),
  })
  return normalizeMutationReceipt(receipt)
}
