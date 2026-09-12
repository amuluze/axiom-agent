import { createId } from '@/agent/core/id'
import type { ModelRef, ModelRequest, ModelTransport } from '@/agent/core/types'
import { normalizeSessionTitle } from './branch'

const TITLE_SYSTEM_PROMPT = [
  '你是会话标题生成器。',
  '只输出一个简洁标题，不要解释、引号、Markdown 或结尾标点。',
  '标题必须忠实概括用户目标，不得包含 API Key、文件正文或其他秘密。',
  '优先使用与用户相同的语言，最多 32 个字符。',
].join('\n')

const MAX_TITLE_INPUT_BYTES = 8 * 1024
const MAX_TITLE_OUTPUT_BYTES = 2 * 1024
const MAX_TITLE_CHARACTERS = 32

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  return new TextDecoder().decode(encoded.slice(0, maxBytes))
}

const truncateCharacters = (value: string, maxCharacters: number): string =>
  Array.from(value).slice(0, maxCharacters).join('')

export const promptSessionTitle = (content: string): string => {
  try {
    return normalizeSessionTitle(content)
  } catch {
    return '新会话'
  }
}

export const normalizeGeneratedSessionTitle = (value: string): string => {
  const firstLine = value
    .replace(/```(?:text)?/giu, '')
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .find(Boolean) ?? ''
  const normalized = firstLine
    .replace(/^#{1,6}\s*/u, '')
    .replace(/^(?:标题|title)\s*[:：]\s*/iu, '')
    .replace(/^[-*]\s+/u, '')
    .replace(/^["'“‘《]+|["'”’》]+$/gu, '')
    .replace(/[。！？!?；;：:,，]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return truncateCharacters(normalizeSessionTitle(normalized), MAX_TITLE_CHARACTERS)
}

export interface GenerateSessionTitleOptions {
  sessionId: string
  userContent: string
  assistantContent: string
  model: ModelRef
  transport: ModelTransport
  signal?: AbortSignal
}

export const generateSessionTitle = async ({
  sessionId,
  userContent,
  assistantContent,
  model,
  transport,
  signal = new AbortController().signal,
}: GenerateSessionTitleOptions): Promise<string> => {
  const content = [
    '<user-goal>',
    truncateUtf8(userContent.trim(), MAX_TITLE_INPUT_BYTES / 2),
    '</user-goal>',
    '<assistant-result>',
    truncateUtf8(assistantContent.trim(), MAX_TITLE_INPUT_BYTES / 2),
    '</assistant-result>',
  ].join('\n')
  const request: ModelRequest = {
    sessionId,
    runId: createId('title'),
    systemPrompt: TITLE_SYSTEM_PROMPT,
    model,
    messages: [{
      id: createId('message'),
      role: 'user',
      content,
      createdAt: Date.now(),
    }],
    tools: [],
    maxOutputTokens: 64,
  }

  let output = ''
  let done = false
  for await (const event of transport.stream(request, signal)) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (event.type === 'text_delta') {
      output += event.delta
      if (new TextEncoder().encode(output).byteLength > MAX_TITLE_OUTPUT_BYTES) {
        throw new Error('模型生成的会话标题超过安全上限')
      }
    } else if (event.type === 'tool_call_start') {
      throw new Error('会话标题生成禁止调用工具')
    } else if (event.type === 'error') {
      throw new Error(`会话标题生成失败：${event.message}`)
    } else if (event.type === 'done') {
      if (event.stopReason === 'tool_use') throw new Error('会话标题生成禁止调用工具')
      done = true
    }
  }
  if (!done) throw new Error('会话标题模型流未正常结束')
  return normalizeGeneratedSessionTitle(output)
}
