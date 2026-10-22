/**
 * 发送清单（C5）：统计**实际发送**的模型请求体构成——系统提示、历史消息、
 * 附件/图片、工具 schema 与会话摘要各占多少条数与字节，供发送前审阅与审计。
 *
 * 输入是最终请求体（各 Provider 协议的 JSON 字符串），因此清单与真正上线的
 * 报文一致；重试复用同一请求体，清单不变（重试次数由宿主侧计数）。
 */
export interface SendManifest {
  requestId: string
  sessionId?: string
  providerId: string
  apiFormat?: string
  /** 请求体总字节数（UTF-8）。 */
  bytes: number
  /** 系统提示字节数（Anthropic `system` / OpenAI system|developer 首条 / Responses `instructions`）。 */
  systemBytes: number
  toolCount: number
  toolBytes: number
  messageCount: number
  messageBytes: number
  toolResultCount: number
  toolResultBytes: number
  /** 按角色统计的历史消息条数（system 单独计入 systemBytes 后仍会出现在这里）。 */
  roleCounts: Record<string, number>
  imageCount: number
  imageBytes: number
  retryCount: number
  credentialScan: 'pending' | 'passed' | 'blocked'
  /** 请求是否包含上下文压缩摘要（`<context-summary>` 标记）。 */
  summaryIncluded: boolean
}

export interface SendManifestInput {
  requestId: string
  sessionId?: string
  providerId: string
  apiFormat?: string
  body: string
}

const utf8Bytes = (value: string): number =>
  typeof TextEncoder === 'undefined' ? value.length : new TextEncoder().encode(value).length

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const stringBytes = (value: unknown): number => typeof value === 'string' ? utf8Bytes(value) : 0

const blockBytes = (value: unknown): number => {
  if (typeof value === 'string') return utf8Bytes(value)
  if (Array.isArray(value)) return value.reduce((total, item) => total + blockBytes(item), 0)
  const record = asRecord(value)
  if (!record) return 0
  // 图片块：base64 的 data 就是实际上线字节；url 按字符串长度近似。
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') {
    return stringBytes(record.data)
      + stringBytes(record.url)
      + blockBytes(record.image_url)
      + blockBytes(record.source)
  }
  const known = blockBytes(record.text)
    + blockBytes(record.content)
    + stringBytes(record.url)
    + stringBytes(record.data)
    + stringBytes(record.name)
    + stringBytes(record.description)
  if (known > 0) return known
  // 未知结构（如工具 schema）：按序列化长度近似，纯规模统计不参与安全判定。
  try {
    return utf8Bytes(JSON.stringify(record))
  } catch {
    return 0
  }
}

/** 图片块计数与字节（Anthropic `image`、OpenAI `image_url`、Responses `input_image`）。 */
const inspectImages = (value: unknown, acc: { count: number; bytes: number }): void => {
  if (Array.isArray(value)) {
    for (const item of value) inspectImages(item, acc)
    return
  }
  const record = asRecord(value)
  if (!record) return
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') {
    acc.count += 1
    acc.bytes += blockBytes(record)
    return
  }
  for (const nested of Object.values(record)) inspectImages(nested, acc)
}

const inspectToolResults = (value: unknown, acc: { count: number; bytes: number }): void => {
  if (Array.isArray(value)) {
    for (const item of value) inspectToolResults(item, acc)
    return
  }
  const record = asRecord(value)
  if (!record) return
  if (record.type === 'tool_result' || record.type === 'function_call_output') {
    acc.count += 1
    acc.bytes += blockBytes(record.content) + blockBytes(record.output)
    return
  }
  if (record.role === 'tool') {
    acc.count += 1
    acc.bytes += blockBytes(record.content)
    return
  }
  for (const nested of Object.values(record)) inspectToolResults(nested, acc)
}

const messageText = (message: Record<string, unknown>): string => {
  if (typeof message.content === 'string') return message.content
  if (typeof message.summary === 'string') return message.summary
  return ''
}

export const buildSendManifest = (input: SendManifestInput): SendManifest => {
  const manifest: SendManifest = {
    requestId: input.requestId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    providerId: input.providerId,
    ...(input.apiFormat ? { apiFormat: input.apiFormat } : {}),
    bytes: utf8Bytes(input.body),
    systemBytes: 0,
    toolCount: 0,
    toolBytes: 0,
    messageCount: 0,
    messageBytes: 0,
    toolResultCount: 0,
    toolResultBytes: 0,
    roleCounts: {},
    imageCount: 0,
    imageBytes: 0,
    retryCount: 0,
    credentialScan: 'pending',
    summaryIncluded: false,
  }
  let body: Record<string, unknown>
  try {
    const parsed = asRecord(JSON.parse(input.body))
    if (!parsed) return manifest
    body = parsed
  } catch {
    return manifest
  }
  manifest.systemBytes = stringBytes(body.system) + stringBytes(body.instructions)
  const tools = Array.isArray(body.tools) ? body.tools : []
  manifest.toolCount = tools.length
  manifest.toolBytes = blockBytes(tools)
  const messages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input) ? body.input : []
  for (const raw of messages) {
    const message = asRecord(raw)
    if (!message) continue
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    manifest.messageCount += 1
    manifest.roleCounts[role] = (manifest.roleCounts[role] ?? 0) + 1
    manifest.messageBytes += blockBytes(message.content) + blockBytes(message.summary)
    if (role === 'system' || role === 'developer') {
      manifest.systemBytes += blockBytes(message.content)
    }
    if (messageText(message).includes('<context-summary>')) manifest.summaryIncluded = true
  }
  const images = { count: 0, bytes: 0 }
  inspectImages(messages, images)
  manifest.imageCount = images.count
  manifest.imageBytes = images.bytes
  const toolResults = { count: 0, bytes: 0 }
  inspectToolResults(messages, toolResults)
  manifest.toolResultCount = toolResults.count
  manifest.toolResultBytes = toolResults.bytes
  return manifest
}
