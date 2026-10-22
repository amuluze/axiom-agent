export interface ServerSentEvent {
  event?: string
  data: string
}

const parseFrame = (frame: string): ServerSentEvent | null => {
  let event: string | undefined
  const data: string[] = []

  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
  }

  return data.length > 0 ? { event, data: data.join('\n') } : null
}

export async function* parseServerSentEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<ServerSentEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  // 跨 chunk 的 CRLF 不能按 chunk 独立归一化：若块边界正好落在 \r 与 \n 之间，
  // 先到的 \r 会被单独替换成 \n，下一块的 \n 又成为第二个 \n，凭空制造帧边界。
  // 把末尾孤立的 \r 留到下一块（或末尾 flush）再与可能的 \n 一起归一化。
  let carryCR = false

  for await (const chunk of chunks) {
    let text = decoder.decode(chunk, { stream: true })
    if (carryCR) {
      text = `\r${text}`
      carryCR = false
    }
    if (text.endsWith('\r')) {
      carryCR = true
      text = text.slice(0, -1)
    }
    // SSE 规格允许 \n / \r\n / \r 三种行结束符，且 data 行内不允许出现原始换行，
    // 因此把 \r\n 与 \r 统一归一化为 \n 是安全的。
    buffer += text.replace(/\r\n|\r/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseFrame(frame)
      if (parsed) yield parsed
      boundary = buffer.indexOf('\n\n')
    }
  }

  let tail = decoder.decode()
  if (carryCR) tail = `\r${tail}`
  buffer += tail.replace(/\r\n|\r/g, '\n')
  const finalFrame = parseFrame(buffer)
  if (finalFrame) yield finalFrame
}
