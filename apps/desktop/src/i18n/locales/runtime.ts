/**
 * 设置界面语言包 —— 上下文策略 / 队列模式 / 运行预算。
 */

export const contextPolicyZh = {
  'settings.context.title': '上下文高级策略',
  'settings.context.hardLimit': '硬限制：2 MiB',
  'settings.context.reserveTokens': '输出预留 token',
  'settings.context.keepRecent': '保留最近 token',
  'settings.context.byteThreshold': '字节软阈值（KiB）',
  'settings.context.tokenSoftThreshold': 'token 软阈值 {tokens}',
  'settings.context.keepRecentTarget': '最近上下文目标 {tokens}',
  'settings.context.byteBuffer': '字节缓冲 {kib} KiB',
  'settings.context.saving': '保存中…',
  'settings.context.save': '保存上下文策略',
  'settings.context.reset': '恢复安全默认值',
  'settings.context.note': '自动 Compaction 和 Rust 2 MiB 硬限制不可关闭。参数越保守，模型请求越早压缩，但 SQLite 完整历史不会被删除。',
} satisfies Record<string, string>

export const contextPolicyEn: Record<string, string> = {
  'settings.context.title': 'Advanced context policy',
  'settings.context.hardLimit': 'Hard limit: 2 MiB',
  'settings.context.reserveTokens': 'Output reserve tokens',
  'settings.context.keepRecent': 'Keep recent tokens',
  'settings.context.byteThreshold': 'Byte soft threshold (KiB)',
  'settings.context.tokenSoftThreshold': 'Token soft threshold {tokens}',
  'settings.context.keepRecentTarget': 'Recent context target {tokens}',
  'settings.context.byteBuffer': 'Byte buffer {kib} KiB',
  'settings.context.saving': 'Saving…',
  'settings.context.save': 'Save context policy',
  'settings.context.reset': 'Restore safe defaults',
  'settings.context.note': 'Automatic compaction and the Rust 2 MiB hard limit cannot be disabled. More conservative parameters compact model requests earlier, but the full SQLite history is never deleted.',
}

export const queueModesZh = {
  'settings.queue.title': '运行中消息队列',
  'settings.queue.state': '可恢复',
  'settings.queue.steering': 'Steering 投递',
  'settings.queue.followUp': 'Follow-up 投递',
  'settings.queue.oneAtATime': '每轮一条',
  'settings.queue.steeringAll': '下一轮全部',
  'settings.queue.followUpAll': '结束后全部',
  'settings.queue.save': '保存队列模式',
  'settings.queue.autoDrain': '自动逐条发送',
  'settings.queue.autoDrainOn': '开启',
  'settings.queue.autoDrainOff': '暂停（手动逐条放行）',
  'settings.queue.autoDrainHint': '关闭后队列暂停在 turn 边界自动消费，改由 Composer 的「立即发送」逐条放行；run 结束后残留保留在队列，不转为恢复草稿。',
  'settings.queue.note': '排队正文会在 Composer 中显示。自动发送开启时，停止运行后尚未进入模型上下文的消息会转为恢复草稿，不会静默带入下一次运行；自动发送关闭时队列保留待发送，由用户逐条放行。',
} satisfies Record<string, string>

export const queueModesEn: Record<string, string> = {
  'settings.queue.title': 'In-flight message queue',
  'settings.queue.state': 'Recoverable',
  'settings.queue.steering': 'Steering delivery',
  'settings.queue.followUp': 'Follow-up delivery',
  'settings.queue.oneAtATime': 'One per turn',
  'settings.queue.steeringAll': 'All next turn',
  'settings.queue.followUpAll': 'All after finish',
  'settings.queue.save': 'Save queue modes',
  'settings.queue.autoDrain': 'Auto-send queue',
  'settings.queue.autoDrainOn': 'On',
  'settings.queue.autoDrainOff': 'Paused (release manually)',
  'settings.queue.autoDrainHint': 'When off, the queue stops auto-consuming at turn boundaries and is released one item at a time from the Composer "Send now" button; leftover items stay queued after a run instead of becoming recovery drafts.',
  'settings.queue.note': 'Queued text appears in the Composer. With auto-send on, messages that never entered the model context after a run stops become recovery drafts and are not silently carried into the next run; with auto-send off the queue stays pending until you release it item by item.',
}

export const limitsZh = {
  'settings.limits.title': '运行预算',
  'settings.limits.state': '下次会话生效',
  'settings.limits.maxTurns': '最大轮次',
  'settings.limits.maxToolCalls': '最大工具调用数',
  'settings.limits.maxTotalTokens': 'Token 预算（billable）',
  'settings.limits.saving': '保存中…',
  'settings.limits.save': '保存运行预算',
  'settings.limits.reset': '恢复安全默认值',
  'settings.limits.note': '轮次/工具调用预算决定单次任务的规模上限；token 预算按计费量（输出 + 非缓存输入）在 75% 软提醒、90% 硬约束时提示收口，不硬停。修改后于下一次会话生效，时间上限与字节限制不可配置。',
} satisfies Record<string, string>

export const limitsEn: Record<string, string> = {
  'settings.limits.title': 'Run budget',
  'settings.limits.state': 'Applies next session',
  'settings.limits.maxTurns': 'Max turns',
  'settings.limits.maxToolCalls': 'Max tool calls',
  'settings.limits.maxTotalTokens': 'Token budget (billable)',
  'settings.limits.saving': 'Saving…',
  'settings.limits.save': 'Save run budget',
  'settings.limits.reset': 'Restore safe defaults',
  'settings.limits.note': 'Turn and tool-call budgets cap the size of a single task; the token budget counts billable tokens (output + non-cached input) and nudges toward convergence at 75% soft / 90% hard without stopping the run. Changes apply from the next session; time and byte limits are not configurable.',
}
