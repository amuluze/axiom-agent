import type {
  RuntimeHookDiagnostic,
  RuntimeHookDiagnosticSink,
} from '@/agent/runtime/RuntimeHookRegistry'

/**
 * 慢 hook 告警阈值（毫秒）。产品 hook 注册 timeoutMs 为 5_000，1_000ms 既
 * 能捕捉明显变慢的 hook（prepare_next_turn 每轮触发），又远离超时边界，留
 * 4× 余量。这是观测性信号，非硬失败——超过阈值只告警，不阻断运行。
 */
export const SLOW_HOOK_THRESHOLD_MS = 1_000

/**
 * 慢 hook 观测器接口。仅接收 content-free 的元数据（stage/hookType/id/
 * durationMs/status），绝不接收 hook 入参或返回值。遵循 observability.ts
 * 的 "content-free" 约定，避免敏感数据进入告警通道。
 */
export type SlowHookObserver = (alert: SlowHookAlert) => void

export interface SlowHookAlert {
  stage: RuntimeHookDiagnostic['stage']
  hookType: RuntimeHookDiagnostic['hookType']
  id: RuntimeHookDiagnostic['id']
  durationMs: RuntimeHookDiagnostic['durationMs']
}

const defaultSlowHookObserver = (alert: SlowHookAlert): void => {
  // 告警正文只含元数据形状，不含 hook 内容或错误细节。
  const message = `[slow-hook] ${alert.stage} ${alert.hookType} ${alert.id} 耗时 ${alert.durationMs}ms`
  console.warn(message)
}

/**
 * 装饰一个诊断 sink，在记录完成后观察 invocation 阶段的成功 hook 耗时。
 * 超过阈值的记录会经 observer 告警，不影响记录本身或运行流程。
 *
 * 仅观察 `stage === 'invocation'` 且 `status === 'completed'` 的记录：
 * - deferred / deferred_late 阶段有独立的超时机制（AgentHarness deferred task），
 *   此处不重复告警。
 * - failed / timed_out / aborted 已有对应错误处理路径，告警会冗余。
 */
export const wrapSlowHookDiagnostics = (
  inner: RuntimeHookDiagnosticSink,
  thresholdMs: number = SLOW_HOOK_THRESHOLD_MS,
  observer: SlowHookObserver = defaultSlowHookObserver,
): RuntimeHookDiagnosticSink => {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new Error(`慢 hook 阈值无效：${thresholdMs}`)
  }
  return {
    record: (diagnostic: RuntimeHookDiagnostic): void => {
      inner.record(diagnostic)
      if (
        diagnostic.stage === 'invocation'
        && diagnostic.status === 'completed'
        && diagnostic.durationMs >= thresholdMs
      ) {
        observer({
          stage: diagnostic.stage,
          hookType: diagnostic.hookType,
          id: diagnostic.id,
          durationMs: diagnostic.durationMs,
        })
      }
    },
  }
}
