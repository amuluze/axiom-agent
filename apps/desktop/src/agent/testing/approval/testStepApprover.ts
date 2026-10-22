import type { TestStepApprovalActor, TestStepApprovalCard } from './testStepApproval'

export interface TestStepApprovalRequest {
  actor: TestStepApprovalActor
  card: TestStepApprovalCard
}

export interface PendingTestStepApproval extends TestStepApprovalRequest {
  key: string
}

/**
 * 测试步骤的人工审批队列。`approve` 挂起直到用户通过 `respond` 决定，或运行被停止（视为拒绝）。
 * 同一 run 内同一步骤只允许一个待决请求，重复提交被拒绝而不是覆盖前一个。
 */
export const createTestStepApprover = () => {
  const pending = new Map<string, { request: TestStepApprovalRequest; resolve: (approved: boolean) => void }>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }

  const keyOf = (actor: TestStepApprovalActor) => `${actor.testRunId}:${actor.stepId}`

  return {
    approve: (request: TestStepApprovalRequest, signal: AbortSignal): Promise<boolean> => {
      const key = keyOf(request.actor)
      if (pending.has(key)) return Promise.resolve(false)
      if (signal.aborted) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        const finish = (approved: boolean) => {
          signal.removeEventListener('abort', onAbort)
          pending.delete(key)
          notify()
          resolve(approved)
        }
        const onAbort = () => finish(false)
        signal.addEventListener('abort', onAbort, { once: true })
        pending.set(key, { request, resolve: finish })
        notify()
      })
    },
    respond: (key: string, approved: boolean): boolean => {
      const entry = pending.get(key)
      if (!entry) return false
      entry.resolve(approved)
      return true
    },
    list: (): PendingTestStepApproval[] =>
      [...pending.entries()].map(([key, entry]) => ({ key, ...entry.request })),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type TestStepApprover = ReturnType<typeof createTestStepApprover>
