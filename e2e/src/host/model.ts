/**
 * 脚本化模型响应：假宿主不经网络，直接生成 SSE 字节交给 `axiom:model-stream`
 * 事件，因此用例可精确控制每一轮模型输出。帧格式与
 * `scripts/native-app-e2e.mjs` 的 mock provider 一致（Anthropic Messages 协议），
 * 逐字对齐 `AnthropicCompatibleTransport` 的解析路径。
 */
export interface ScriptedToolCall {
  id?: string
  name: string
  input: Record<string, unknown>
}

/** 一轮模型响应 = 一组 SSE 帧。 */
export type ScriptedTurn = string

const frame = (type: string, data: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

const start = (id: string): string =>
  frame('message_start', {
    type: 'message_start',
    message: { id, model: 'e2e-scripted', usage: { input_tokens: 24 } },
  })

const delta = (stopReason: string): string =>
  frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 12 },
  })

/** 纯文本回复（end_turn）。 */
export const textTurn = (text: string, id = 'msg_e2e_text'): ScriptedTurn =>
  [
    start(id),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    delta('end_turn'),
    frame('message_stop', { type: 'message_stop' }),
  ].join('')

/** 一次或多次工具调用（stop_reason=tool_use）。 */
export const toolTurn = (calls: readonly ScriptedToolCall[], id = 'msg_e2e_tool'): ScriptedTurn => {
  const frames: string[] = [start(id)]
  calls.forEach((call, index) => {
    frames.push(
      frame('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id ?? `toolu_e2e_${index}`,
          name: call.name,
          input: {},
        },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index }),
    )
  })
  frames.push(delta('tool_use'), frame('message_stop', { type: 'message_stop' }))
  return frames.join('')
}

/** 把一轮响应的字节按固定块切分，模拟真实网络分片。 */
export const chunkBytes = (turn: ScriptedTurn, size = 512): number[][] => {
  const bytes = Array.from(new TextEncoder().encode(turn))
  const chunks: number[][] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size))
  }
  return chunks.length > 0 ? chunks : [[]]
}
