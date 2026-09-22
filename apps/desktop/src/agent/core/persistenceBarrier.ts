/**
 * 持久化屏障失败的分类标记。
 *
 * `message_end` 是消息的持久化屏障：AgentSession 顺序 await 各监听器，store 的运行时监听器
 * 在其中完成落库（先写库、再推进 UI 投影、最后把写库错误原样上抛）。由此得到 agent 层的
 * 默认语义：**监听器抛错即该消息未落库**——runAgentLoop 据此回滚刚登记的内存消息，
 * AgentSession 据此把已 drain 的队列消息恢复回队列。
 *
 * 唯一例外是 store 监听器在**写库成功之后**发生的 UI 投影错误：它不代表消息未落库。这类
 * 错误必须显式标记，否则会回滚已落库消息的内存边界（Save Point 与持久化边界失配），并把
 * 已 applied 的队列消息重新入队（重复投递）。
 */
const PERSISTENCE_UNRELATED = Symbol('axiom.persistenceUnrelatedFailure')

/** 标记「该监听器错误与消息落库结果无关」。 */
export const markPersistenceUnrelated = <T>(error: T): T => {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    Object.defineProperty(error, PERSISTENCE_UNRELATED, {
      value: true,
      enumerable: false,
      configurable: true,
    })
  }
  return error
}

/** 判断该监听器错误是否被显式标记为与消息落库结果无关。 */
export const isPersistenceUnrelated = (error: unknown): boolean =>
  ((typeof error === 'object' && error !== null) || typeof error === 'function')
  && (error as Record<symbol, unknown>)[PERSISTENCE_UNRELATED] === true

/** emit 的默认语义：监听器抛错即消息未落库，除非被显式标记为与落库无关。 */
export const impliesMessageNotPersisted = (error: unknown): boolean =>
  !isPersistenceUnrelated(error)
