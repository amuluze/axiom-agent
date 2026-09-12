import type { SubAgentObservationSink } from '@/agent/subagent/contracts'

/**
 * 子会话 Provider 观察 sink：把 child request/response 归并到父 run，不调用 repository、
 * 不写父 mutation journal、不创建临时 childSessionId 的持久化记录。
 *
 * 首版状态（已明确）：**观察 sink 为空实现**——不提供 onModelRequest/onModelResponse
 * 回调，child request/response 未接入 diagnostics。子会话的诊断信息仅由
 * SubAgentRuntime 的 ledger（token/cost/count 内存累加）与
 * AgentDelegationResult.details/parentRunUsage 承载，会话关闭或重启后丢失。
 *
 * 首版约束：
 * - budget ledger（token/cost/count）已在 SubAgentRuntime 的 response 路径累计到
 *   父 run 内存 ledger，这里不再重复聚合；
 * - 不落库、不更新父投影：未来计费/usage sink 必须按父 run 聚合，禁止以临时
 *   childSessionId 建独立持久化记录。
 */
export const createSubAgentObservationSink = (): SubAgentObservationSink => ({
  // 首版为空实现：观察与诊断由 SubAgentRuntime 的 ledger 与 AgentDelegationResult.details 承载。
  onModelRequest: undefined,
  onModelResponse: undefined,
})
