import { useAgentStore } from '@/stores/agentStore'
import { useConnectStore } from '@/stores/connectStore'
import {
  connectReplyMessage,
  listenConnectEvents,
  type ConnectEvent,
  type ConnectPlatform,
} from '@/platform/connect'
import { isTauriRuntime } from '@/platform/environment'

/**
 * 连接服务：把聊天平台的入站消息路由到 agentStore（远程操控会话），
 * 并把运行结果与审批请求回流到聊天平台。
 *
 * 设计约束：
 * - agent 运行时只在激活会话上推进（send/steering 均作用于激活会话），
 *   因此远程消息处理前会先把绑定映射的会话切换为激活会话——桌面端
 *   用户能直接看到远程会话的运行过程，远程行为对本地完全可见。
 * - 每个绑定（平台 + 聊天 + 用户）映射一个 Axiom 会话；映射持久化在
 *   localStorage，会话被删除后自动重建。
 * - 审批经文本确认：聊天内回复 y/n 调用 approveToolCall / denyToolCall，
 *   与桌面审批卡片走同一个审批协调器，无旁路。
 */

const SESSION_MAP_STORAGE_KEY = 'axiom.connect.session-map.v1'
const MAX_INBOUND_TEXT_CHARS = 16_000
const MAX_REPLY_CHARS = 6_000

const HELP_TEXT = [
  'Axiom 远程操控已就绪。直接发送消息即作为任务指令；可用命令：',
  '/status — 查看 Axiom 状态',
  '/new — 开启新会话（清空上下文）',
  '/stop — 停止当前运行',
  '/help — 显示本帮助',
  '工具执行需要审批时会在这里询问，回复 y 允许 / n 拒绝。',
].join('\n')

interface InboundMessage {
  platform: ConnectPlatform
  chatId: string
  userId: string
  userName: string
  messageId: string
  text: string
}

const bindingKey = (platform: string, chatId: string, userId: string): string =>
  `${platform}:${chatId}:${userId}`

const loadSessionMap = (): Map<string, string> => {
  if (typeof window === 'undefined') return new Map()
  try {
    const raw = window.localStorage.getItem(SESSION_MAP_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return new Map()
    const map = new Map<string, string>()
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 过滤历史脏 key：事件字段名不匹配时期 bindingKey 曾把 undefined 拼进
      // key（"weixin:undefined:undefined"），其映射指向的会话路由必然失效。
      if (key.includes(':undefined')) continue
      if (typeof value === 'string' && value.length > 0) map.set(key, value)
    }
    return map
  } catch {
    return new Map()
  }
}

const persistSessionMap = (map: Map<string, string>): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    SESSION_MAP_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(map)),
  )
}

/**
 * 每个绑定串行处理：同一个人连发多条消息不会并发驱动同一个会话。
 * bindingKey 只作为 Map 键使用；回发需要的 (platform, chatId, userId)
 * 三元组另存路由表，避免对可能含 ':' 的平台 ID 做字符串切分。
 */
const queues = new Map<string, Promise<void>>()
const sessionMap = loadSessionMap()
const bindingRoutes = new Map<string, { platform: ConnectPlatform; chatId: string; userId: string }>()
const remoteRuns = new Map<string, { sessionId: string }>()
const notifiedApprovalToolCallIds = new Set<string>()

const enqueue = (key: string, task: () => Promise<void>): void => {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(key, next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  }))
}

const reply = async (message: InboundMessage, text: string): Promise<void> => {
  const clipped = text.length > MAX_REPLY_CHARS
    ? `${text.slice(0, MAX_REPLY_CHARS)}\n…（内容过长已截断，完整内容请在 Axiom 中查看）`
    : text
  try {
    await connectReplyMessage(message.platform, message.chatId, message.userId, clipped)
  } catch (error) {
    // 回发失败（回复通道失效/连接断开/平台 API 拒绝）不打断本地会话运行，
    // 但聊天侧已无法自述，必须把错误投影到桌面侧供排查——否则用户只会看到
    // 「任务执行了但结果没回来」且毫无线索。
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[connect] 结果回发失败（${message.platform} ${message.chatId}）：${detail}`)
    useConnectStore.getState().setReplyError({
      platform: message.platform,
      message: detail,
      at: Date.now(),
    })
  }
}

const isSessionRunning = (sessionId: string): boolean => {
  const state = useAgentStore.getState()
  if (state.activeSessionId === sessionId) return state.running
  return state.sessions.some((stored) => stored.id === sessionId && stored.status === 'running')
}

const statusText = (): string => {
  const state = useAgentStore.getState()
  const lines = [`Provider：${state.providerReady ? '就绪' : '未配置'}`]
  const runningSession = state.sessions.find((stored) => stored.status === 'running')
  lines.push(runningSession
    ? `当前运行：${runningSession.title || '未命名会话'}`
    : '当前没有运行中的会话')
  return lines.join('\n')
}

const parseApprovalVerdict = (text: string): 'approved' | 'denied' | null => {
  const normalized = text.trim().toLowerCase()
  if (normalized.length === 0 || normalized.length > 12) return null
  if (['y', 'yes', 'ok', '好', '允许', '同意', '批准'].includes(normalized)) return 'approved'
  if (['n', 'no', '不', '拒绝', '否认', 'deny'].includes(normalized)) return 'denied'
  return null
}

/** 远程会话是否就是 pendingApproval 的目标：是则 y/n 视为审批应答。 */
const pendingApprovalForBinding = (message: InboundMessage) => {
  const state = useAgentStore.getState()
  const pending = state.pendingApproval
  if (!pending) return null
  const mapped = sessionMap.get(bindingKey(message.platform, message.chatId, message.userId))
  return mapped === pending.sessionId ? pending : null
}

/**
 * 审批应答立即生效（不进串行队列）：队列头可能正是挂起等待审批的 run，
 * y/n 若排在其后将永远得不到处理——用户回复后任务死锁、无任何反馈。
 */
const applyApprovalVerdict = async (
  message: InboundMessage,
  pending: NonNullable<ReturnType<typeof pendingApprovalForBinding>>,
  verdict: 'approved' | 'denied',
): Promise<void> => {
  try {
    if (verdict === 'approved') {
      await useAgentStore.getState().approveToolCall(pending.toolCallId)
      await reply(message, '已允许该操作，任务继续')
    } else {
      await useAgentStore.getState().denyToolCall(pending.toolCallId)
      await reply(message, '已拒绝该操作')
    }
  } catch {
    await reply(message, '审批应答失败（可能已被处理或超时）')
  }
}

const ensureRemoteSession = async (message: InboundMessage): Promise<string | null> => {
  const key = bindingKey(message.platform, message.chatId, message.userId)
  const store = useAgentStore.getState()
  const mapped = sessionMap.get(key)
  if (mapped && store.sessions.some((stored) => stored.id === mapped && !stored.archivedAt)) {
    if (store.activeSessionId !== mapped) {
      const selected = await useAgentStore.getState().selectSession(mapped)
      if (!selected) return null
    }
    return mapped
  }
  const workspacePath = useConnectStore.getState().config.workspacePath
  if (!workspacePath) return null
  const created = await useAgentStore.getState().createNewSession(workspacePath)
  if (!created) return null
  const sessionId = useAgentStore.getState().activeSessionId
  if (!sessionId) return null
  sessionMap.set(key, sessionId)
  persistSessionMap(sessionMap)
  return sessionId
}

const handleRemoteCommand = async (
  message: InboundMessage,
  command: string,
): Promise<boolean> => {
  const key = bindingKey(message.platform, message.chatId, message.userId)
  if (command === '/help' || command === '/commands') {
    await reply(message, HELP_TEXT)
    return true
  }
  if (command === '/status') {
    await reply(message, statusText())
    return true
  }
  if (command === '/new') {
    const workspacePath = useConnectStore.getState().config.workspacePath
    if (!workspacePath) {
      await reply(message, '请先在 Axiom 连接面板中选择远程会话使用的工作目录')
      return true
    }
    const mapped = sessionMap.get(key)
    if (mapped && isSessionRunning(mapped)) {
      await reply(message, '当前会话仍在运行，请先发送 /stop')
      return true
    }
    const created = await useAgentStore.getState().createNewSession(workspacePath)
    if (!created) {
      await reply(message, '新会话创建失败，请稍后再试')
      return true
    }
    const sessionId = useAgentStore.getState().activeSessionId
    if (sessionId) {
      sessionMap.set(key, sessionId)
      persistSessionMap(sessionMap)
    }
    await reply(message, '已开启新的远程会话')
    return true
  }
  if (command === '/stop') {
    const mapped = sessionMap.get(key)
    const state = useAgentStore.getState()
    if (!mapped || !isSessionRunning(mapped)) {
      await reply(message, '当前没有运行中的远程会话')
      return true
    }
    if (state.activeSessionId === mapped) {
      state.stop()
      await reply(message, '已请求停止当前任务')
    } else {
      await reply(message, '远程会话在后台运行，请在 Axiom 桌面端停止')
    }
    return true
  }
  if (command.startsWith('/')) {
    await reply(message, `未知命令 ${command.split(/\s+/)[0]}，发送 /help 查看可用命令`)
    return true
  }
  return false
}

const handleInboundMessage = async (message: InboundMessage): Promise<void> => {
  const text = message.text.trim()
  if (text.length === 0) return
  if (text.length > MAX_INBOUND_TEXT_CHARS) {
    await reply(message, '消息过长，请在 Axiom 桌面端处理这个任务')
    return
  }

  const state = useAgentStore.getState()
  if (!state.providerReady || state.providerSetupRequired) {
    await reply(message, 'Axiom 尚未完成模型配置，暂时无法处理消息')
    return
  }

  // 挂起中的审批：优先按审批应答解析，避免把 y/n 误发给模型。
  // （应答本身已在 handleConnectEvent 入队前短路执行；走到这里的是
  // 非应答消息，只重复提示当前挂起的审批。）
  const pending = pendingApprovalForBinding(message)
  if (pending) {
    const verdict = parseApprovalVerdict(text)
    if (verdict) {
      await applyApprovalVerdict(message, pending, verdict)
      return
    }
    await reply(message, `当前有操作等待审批：${pending.toolLabel}\n回复 y 允许 / n 拒绝`)
    return
  }

  if (await handleRemoteCommand(message, text.split(/\s+/)[0])) return

  const key = bindingKey(message.platform, message.chatId, message.userId)
  // 其他会话在运行时不抢占：远程操控不能打断本地用户的工作。
  const otherRunning = useAgentStore.getState().sessions.some((stored) => (
    stored.status === 'running' && stored.id !== sessionMap.get(key)
  ))
  if (otherRunning) {
    await reply(message, 'Axiom 正在处理其他会话，请稍后再试')
    return
  }

  let sessionId: string | null = null
  try {
    sessionId = await ensureRemoteSession(message)
  } catch {
    sessionId = null
  }
  if (!sessionId) {
    const workspacePath = useConnectStore.getState().config.workspacePath
    await reply(message, workspacePath
      ? '远程会话不可用，请在 Axiom 桌面端检查工作目录授权'
      : '请先在 Axiom 连接面板中选择远程会话使用的工作目录')
    return
  }

  const beforeSend = useAgentStore.getState()
  if (beforeSend.activeSessionId === sessionId && beforeSend.running) {
    const acceptance = await beforeSend.queueSteering(text)
    await reply(message, acceptance.accepted
      ? '已并入当前运行的任务'
      : '当前任务无法插入新消息，请发送 /stop 后重试')
    return
  }
  if (isSessionRunning(sessionId)) {
    // 后台运行中的会话与前台同语义：排队 steering，在下一个 turn 边界注入。
    const queued = await useAgentStore.getState().sendToSession(sessionId, text)
    await reply(message, queued
      ? '远程会话正在后台运行，消息已排队，将在其当前步骤结束后处理'
      : '远程会话正在收尾，请稍后重试或发送 /stop')
    return
  }

  remoteRuns.set(key, { sessionId })
  try {
    await useAgentStore.getState().send(text)
  } finally {
    remoteRuns.delete(key)
  }

  // send() 在运行结算后返回；这里取最终 assistant 输出回流。
  // 期间若用户切走了会话，拿不到消息投影，回一条指引即可。
  const settled = useAgentStore.getState()
  if (settled.activeSessionId === sessionId) {
    if (settled.error) {
      await reply(message, `运行出错：${settled.error}`)
      return
    }
    const lastAssistant = [...settled.messages]
      .reverse()
      .find((item) => item.role === 'assistant' && item.content.trim())
    await reply(message, lastAssistant?.content ?? '（本次运行没有文本输出）')
  } else {
    await reply(message, '任务已结束（会话已不在前台，详情请在 Axiom 中查看）')
  }
}

const handleConnectEvent = (event: ConnectEvent): void => {
  if (event.kind === 'status') {
    const current = useConnectStore.getState().config.platforms
      .find((platform) => platform.platform === event.platform)
    useConnectStore.getState().applyStatus({
      platform: event.platform,
      status: event.status,
      message: event.message,
      configured: current?.configured ?? event.status !== 'unconfigured',
      credentialHint: current?.credentialHint ?? null,
    })
    return
  }
  if (event.kind === 'paired') {
    void useConnectStore.getState().applyPaired()
    return
  }
  if (event.kind === 'message') {
    // 路由三元组缺失时直接丢弃：把 undefined 拼进 key 会污染会话映射，
    // 且后续回发 invoke 会因必填字段被 JSON 丢弃而必然失败。
    if (!event.chatId || !event.userId) {
      console.error(
        `[connect] 入站消息缺少路由字段（chatId/userId），已丢弃：${JSON.stringify(event)}`,
      )
      return
    }
    const message: InboundMessage = {
      platform: event.platform,
      chatId: event.chatId,
      userId: event.userId,
      userName: event.userName,
      messageId: event.messageId,
      text: event.text,
    }
    const key = bindingKey(message.platform, message.chatId, message.userId)
    bindingRoutes.set(key, {
      platform: message.platform,
      chatId: message.chatId,
      userId: message.userId,
    })
    // 审批应答绕过串行队列立即执行：队列头可能正是挂起等审批的 run，
    // 排队会导致应答永远无法处理（任务死锁、聊天侧无任何反馈）。
    const pending = pendingApprovalForBinding(message)
    if (pending) {
      const verdict = parseApprovalVerdict(message.text.trim())
      if (verdict) {
        void applyApprovalVerdict(message, pending, verdict)
        return
      }
    }
    enqueue(key, async () => {
      await handleInboundMessage(message)
    })
  }
}

/** 审批通知：远程会话的工具审批请求推到聊天里等待 y/n。 */
const notifyApproval = (): void => {
  const state = useAgentStore.getState()
  const pending = state.pendingApproval
  if (!pending) return
  if (notifiedApprovalToolCallIds.has(pending.toolCallId)) return
  // run 记录在 send 前置位、结束即删；等待审批期间 run 仍在进行，通常都能命中。
  // 找不到活跃 run 时按会话映射兜底（如审批在 run 记录建立前出现）。
  let route = null
  for (const [key, run] of remoteRuns) {
    if (run.sessionId === pending.sessionId) {
      route = bindingRoutes.get(key) ?? null
      break
    }
  }
  if (!route) {
    for (const [key, sessionId] of sessionMap) {
      if (sessionId === pending.sessionId) {
        route = bindingRoutes.get(key) ?? null
        break
      }
    }
  }
  if (!route) return
  notifiedApprovalToolCallIds.add(pending.toolCallId)
  void connectReplyMessage(
    route.platform,
    route.chatId,
    route.userId,
    `⚠️ Axiom 需要审批：${pending.toolLabel}\n回复 y 允许 / n 拒绝`,
  ).catch(() => undefined)
}

let serviceStarted = false

/** 幂等启动：main.tsx 渲染后调用一次，浏览器 dev 模式下为空操作。 */
export const initConnectService = (): void => {
  if (serviceStarted || !isTauriRuntime()) return
  serviceStarted = true
  void listenConnectEvents((event) => handleConnectEvent(event)).catch(() => undefined)
  useAgentStore.subscribe(() => notifyApproval())
  // 启动时拉一次配置，让面板/服务拿到工作目录与绑定投影。
  void useConnectStore.getState().refresh().catch(() => undefined)
}

/** 测试专用：重置模块级状态。 */
export const resetConnectServiceForTests = (): void => {
  queues.clear()
  bindingRoutes.clear()
  remoteRuns.clear()
  notifiedApprovalToolCallIds.clear()
  serviceStarted = false
}

export const connectServiceInternals = {
  bindingKey,
  parseApprovalVerdict,
  loadSessionMap,
  persistSessionMap,
  handleInboundMessage,
  applyApprovalVerdict,
  statusText,
}
