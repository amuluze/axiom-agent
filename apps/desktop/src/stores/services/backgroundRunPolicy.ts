/**
 * 后台会话并发策略。
 *
 * `runtimeCaches` 的 LRU 只逐出**非运行中** harness；运行中的会话没有缓存上界，
 * 也没有全局并发上限。后台快捷发送可以持续拉起新 run，多个模型流 + SQLite 写
 * 会一起挤压内存与 Provider 配额。这里给「启动新后台 run」设一个保守上界；
 * 对已运行会话的 steering 不设限（只是排队，不新增并发模型流）。
 *
 * 上限取 4：与 SessionRepository 连接池上限一致，避免后台 run 数量远超 DB 并发。
 * 不是硬安全边界，只是资源保护；超过时保留草稿并给用户可读原因。
 */
export const MAX_CONCURRENT_BACKGROUND_RUNS = 4

export const backgroundRunCapacityError = (runningCount: number): string | null =>
  runningCount >= MAX_CONCURRENT_BACKGROUND_RUNS
    ? `同时运行的后台会话已达上限（${MAX_CONCURRENT_BACKGROUND_RUNS} 个）。请先停止一个会话再发送。`
    : null
