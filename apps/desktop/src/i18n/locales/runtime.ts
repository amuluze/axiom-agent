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
  'settings.context.note': '自动压缩与 2 MiB 硬限制不可关闭；参数越保守越早压缩，完整历史不会删除。',
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
  'settings.context.note': 'Auto-compaction and the 2 MiB hard limit cannot be disabled; the full history is never deleted.',
}

export const queueModesZh = {
  'settings.queue.title': '运行中消息队列',
  'settings.queue.state': '可恢复',
  'settings.queue.steering': 'Steering 投递',
  'settings.queue.aside': 'Aside 投递',
  'settings.queue.followUp': 'Follow-up 投递',
  'settings.queue.oneAtATime': '每轮一条',
  'settings.queue.steeringAll': '下一轮全部',
  'settings.queue.asideAll': '下一轮全部（不中断）',
  'settings.queue.followUpAll': '结束后全部',
  'settings.queue.save': '保存队列模式',
  'settings.queue.autoDrain': '自动逐条发送',
  'settings.queue.autoDrainOn': '开启',
  'settings.queue.autoDrainOff': '暂停（手动逐条放行）',
  'settings.queue.autoDrainHint': '关闭后需在 Composer 逐条「立即发送」放行。',
  'settings.queue.note': '自动发送开启时，停止后未进入上下文的消息转为恢复草稿，不会静默带入下次运行。',
} satisfies Record<string, string>

export const queueModesEn: Record<string, string> = {
  'settings.queue.title': 'In-flight message queue',
  'settings.queue.state': 'Recoverable',
  'settings.queue.steering': 'Steering delivery',
  'settings.queue.aside': 'Aside delivery',
  'settings.queue.followUp': 'Follow-up delivery',
  'settings.queue.oneAtATime': 'One per turn',
  'settings.queue.steeringAll': 'All next turn',
  'settings.queue.asideAll': 'All next turn (no interrupt)',
  'settings.queue.followUpAll': 'All after finish',
  'settings.queue.save': 'Save queue modes',
  'settings.queue.autoDrain': 'Auto-send queue',
  'settings.queue.autoDrainOn': 'On',
  'settings.queue.autoDrainOff': 'Paused (release manually)',
  'settings.queue.autoDrainHint': 'When off, release items one by one via the Composer “Send now” button.',
  'settings.queue.note': 'With auto-send on, messages that never entered the model context become recovery drafts after a run stops — never silently carried into the next run.',
}

export const limitsZh = {
  'settings.limits.title': '运行预算',
  'settings.limits.state': '下次会话生效',
  'settings.limits.maxTurns': '每阶段最大轮次',
  'settings.limits.maxToolCalls': '每阶段最大工具调用数',
  'settings.limits.maxTotalTokens': 'Token 预算（billable）',
  'settings.limits.approvalTimeout': '审批等待上限（秒）',
  'settings.limits.saving': '保存中…',
  'settings.limits.save': '保存运行预算',
  'settings.limits.reset': '恢复安全默认值',
  'settings.limits.note': '阶段触限且有新增有效结果时最多自动续跑 3 次，任务累计时长上限为 15 分钟；无进展或真实工具错误时暂停。Token 预算按任务累计计费量在 75%/90% 提醒，不硬停；审批超时自动拒绝。下次会话生效。',
} satisfies Record<string, string>

export const limitsEn: Record<string, string> = {
  'settings.limits.title': 'Run budget',
  'settings.limits.state': 'Applies next session',
  'settings.limits.maxTurns': 'Max turns per stage',
  'settings.limits.maxToolCalls': 'Max tool calls per stage',
  'settings.limits.maxTotalTokens': 'Token budget (billable)',
  'settings.limits.approvalTimeout': 'Approval wait limit (seconds)',
  'settings.limits.saving': 'Saving…',
  'settings.limits.save': 'Save run budget',
  'settings.limits.reset': 'Restore safe defaults',
  'settings.limits.note': 'Stage limits allow up to 3 automatic continuations with new successful results, within a 15-minute task deadline. No progress or tool errors pause the task. Token reminders use cumulative task usage at 75% / 90% without hard-stopping. Approval timeouts are auto-denied. Applies next session.',
}

export const syntaxRepairZh = {
  'settings.syntaxRepair.title': '编辑语法修复模型',
  'settings.syntaxRepair.state': '按需调用',
  'settings.syntaxRepair.profile': '模型配置',
  'settings.syntaxRepair.current': '当前会话模型（自动跟随）',
  'settings.syntaxRepair.note': '仅在编辑前可解析、编辑后不可解析时调用；配置失效会自动回退当前会话模型。',
} satisfies Record<string, string>

export const syntaxRepairEn: Record<string, string> = {
  'settings.syntaxRepair.title': 'Edit syntax repair model',
  'settings.syntaxRepair.state': 'On demand',
  'settings.syntaxRepair.profile': 'Model configuration',
  'settings.syntaxRepair.current': 'Current session model (follows automatically)',
  'settings.syntaxRepair.note': 'Used only when an edit breaks previously valid syntax; missing configurations fall back to the current session model.',
}
