import type { QueuedMessageKind } from './mutationJournal'

export type { QueuedMessageKind } from './mutationJournal'

/**
 * 队列写操作的拒绝原因：让「消息没进队列」可解释（对照 ZCode 的带 ack 队列命令）。
 * 出现在 UI 的文案一律由调用方按 reason 翻译，运行时只产出原因码。
 */
export type QueueRejectionReason =
  /** 当前没有可追加的 run（未运行，或 run 已进入收尾结算窗口）。 */
  | 'runtime-not-accepting'
  /** 输入既无文本也无图片。 */
  | 'empty-input'
  /** 目标队列项不存在（已被消费或删除）。 */
  | 'unknown-message'

export type QueueAcceptance =
  | { accepted: true; id: string }
  | { accepted: false; reason: QueueRejectionReason }

export type QueueMutationResult =
  | { updated: true; messageId: string; kind: QueuedMessageKind }
  | { updated: false; reason: QueueRejectionReason }

/** 队列项目标位置：相对「显示序」（三队列按 order 归并后的顺序）表达，由运行时解析成 order。 */
export type QueuePlacement =
  | { position: 'top' }
  | { position: 'bottom' }
  | { position: 'above'; anchorId: string }
  | { position: 'below'; anchorId: string }

export type QueueMoveTarget = {
  kind: QueuedMessageKind
  placement: QueuePlacement
}

export const acceptedQueueMessage = (id: string): QueueAcceptance => ({ accepted: true, id })

export const rejectedQueueMessage = (reason: QueueRejectionReason): QueueAcceptance => ({
  accepted: false,
  reason,
})
