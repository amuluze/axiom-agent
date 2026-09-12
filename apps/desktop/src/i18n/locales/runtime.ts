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
  'settings.queue.note': '排队正文会在 Composer 中显示。停止运行后，尚未进入模型上下文的消息会转为恢复草稿，不会静默带入下一次运行。',
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
  'settings.queue.note': 'Queued text appears in the Composer. After a run stops, messages that never entered the model context become recovery drafts and are not silently carried into the next run.',
}

export const limitsZh = {
  'settings.limits.title': '运行预算',
  'settings.limits.state': '下次会话生效',
  'settings.limits.maxTurns': '最大轮次',
  'settings.limits.maxToolCalls': '最大工具调用数',
  'settings.limits.saving': '保存中…',
  'settings.limits.save': '保存运行预算',
  'settings.limits.reset': '恢复安全默认值',
  'settings.limits.note': '轮次与工具调用预算决定单次任务的规模上限；预算提示按剩余比例自适应（约 50% 软提醒、10% 硬约束）。修改后于下一次会话生效，时间上限与字节限制不可配置。',
} satisfies Record<string, string>

export const limitsEn: Record<string, string> = {
  'settings.limits.title': 'Run budget',
  'settings.limits.state': 'Applies next session',
  'settings.limits.maxTurns': 'Max turns',
  'settings.limits.maxToolCalls': 'Max tool calls',
  'settings.limits.saving': 'Saving…',
  'settings.limits.save': 'Save run budget',
  'settings.limits.reset': 'Restore safe defaults',
  'settings.limits.note': 'Turn and tool-call budgets cap the size of a single task; budget hints adapt by remaining ratio (roughly 50% soft reminder, 10% hard constraint). Changes apply from the next session; time and byte limits are not configurable.',
}
