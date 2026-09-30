import { describe, expect, it } from 'vitest'
import {
  UNSUPPORTED_IMAGE_NOTE,
  hasImagePayload,
  stripUnsupportedImages,
} from './stripUnsupportedImages'
import type { ModelRequest } from './types'

const asMessages = (value: unknown) => value as ModelRequest['messages']

/** 降级断言的统一入口：成功时返回副本，失败时直接让用例炸在 ok:false 上。 */
const stripped = (messages: ModelRequest['messages']) => {
  const result = stripUnsupportedImages(messages)
  if (!result.ok) throw new Error(`期望降级成功，实际失败：${result.error}`)
  return result
}

const withBase64Image = asMessages([
  { role: 'user', content: '看这张图', contentBlocks: [
    { type: 'text', text: '看这张图' },
    { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
  ] },
])

describe('stripUnsupportedImages（仅文本模型的发送副本降级）', () => {
  it('无图片消息：原样返回同一引用（纯文本请求零拷贝）', () => {
    const messages = asMessages([
      { role: 'user', content: '纯文本' },
      { role: 'assistant', content: '好' },
    ])
    const result = stripped(messages)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toBe(messages[0])
    expect(result.messages[1]).toBe(messages[1])
    expect(result.replacedCount).toBe(0)
    expect(hasImagePayload(result.messages)).toBe(false)
  })

  it('base64 图片 → 固定子串替换，且不残留任何图片负载', () => {
    const result = stripped(withBase64Image)
    expect(result.messages).not.toBe(withBase64Image)
    expect(result.replacedCount).toBe(1)
    expect(hasImagePayload(result.messages)).toBe(false)
    expect(JSON.stringify(result.messages)).not.toContain('iVBORw0KGgo=')
    expect(result.messages[0].contentBlocks).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'text', text: UNSUPPORTED_IMAGE_NOTE },
    ])
    // 正文已有内容时不覆盖（不丢失模型的既有上下文）。
    expect(result.messages[0].content).toBe('看这张图')
  })

  it('不修改入参（原数组与嵌套块保持不变）', () => {
    const before = JSON.stringify(withBase64Image)
    stripped(withBase64Image)
    expect(JSON.stringify(withBase64Image)).toBe(before)
    expect(hasImagePayload(withBase64Image)).toBe(true)
  })

  it('tool 消息的远程 url 图片 + 空正文 → 正文兜底为同一子串', () => {
    const messages = asMessages([
      { role: 'tool', content: '', contentBlocks: [
        { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
      ] },
    ])
    const result = stripped(messages)
    expect(hasImagePayload(result.messages)).toBe(false)
    expect(JSON.stringify(result.messages)).not.toContain('example.invalid')
    expect(result.messages[0].content).toBe(UNSUPPORTED_IMAGE_NOTE)
  })

  it('只替换含图的消息，其余消息零改动', () => {
    const messages = asMessages([
      { role: 'user', content: '先看代码', contentBlocks: [{ type: 'text', text: '先看代码' }] },
      ...withBase64Image,
      { role: 'assistant', content: '好的' },
    ])
    const result = stripped(messages)
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]).toBe(messages[0])
    expect(result.messages[2]).toBe(messages[2])
    expect(result.messages[1].contentBlocks?.[1]).toEqual({ type: 'text', text: UNSUPPORTED_IMAGE_NOTE })
  })

  it('幂等：对已降级副本再跑一次无差异', () => {
    const once = stripped(withBase64Image).messages
    const twice = stripped(once)
    expect(twice.messages).toEqual(once)
    expect(twice.replacedCount).toBe(0)
  })
})

// 验收 6：逐处就地替换，块数/块序/角色与无关块内容不变。
describe('替换粒度：逐处就地替换', () => {
  it('工具结果 + base64 + url + 文字 + 内嵌 data URL 混合消息：逐项逐字断言', () => {
    const original = asMessages([
      { role: 'tool', toolCallId: 'call-1', toolName: 'read', isError: false, content: '读取完成', contentBlocks: [
        { type: 'text', text: '读取完成' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
        { type: 'text', text: '附图如下' },
        { type: 'image', source: { type: 'url', url: 'https://example.invalid/b.png' } },
      ] },
    ])
    const result = stripUnsupportedImages(original)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.replacedCount).toBe(2)
    const [message] = result.messages
    // 角色、消息数、块数、块序均不变。
    expect(message.role).toBe('tool')
    expect(result.messages).toHaveLength(1)
    expect(message.contentBlocks).toHaveLength(4)
    // 无关块逐字节不变（同一引用即证未重建）。
    expect(message.contentBlocks?.[0]).toBe(original[0].contentBlocks?.[0])
    expect(message.contentBlocks?.[2]).toBe(original[0].contentBlocks?.[2])
    // 两处图片负载各换为一条占位说明。
    expect(message.contentBlocks?.[1]).toEqual({ type: 'text', text: UNSUPPORTED_IMAGE_NOTE })
    expect(message.contentBlocks?.[3]).toEqual({ type: 'text', text: UNSUPPORTED_IMAGE_NOTE })
    expect(message.content).toBe('读取完成')
  })

  it('text 块内嵌 data:image 串整段替换，同块其余文字保留', () => {
    const result = stripped(asMessages([
      { role: 'user', content: '这是 data:image/png;base64,AAAA 的截图', contentBlocks: [
        { type: 'text', text: '这是 data:image/png;base64,AAAA 的截图' },
      ] },
    ]))
    expect(result.replacedCount).toBe(1)
    const [message] = result.messages
    expect(message.contentBlocks?.[0].type === 'text'
      ? message.contentBlocks[0].text
      : '').toBe(`这是 ${UNSUPPORTED_IMAGE_NOTE} 的截图`)
    // 正文投影同步替换，否则扁平 content 会把负载原样发出去。
    expect(message.content).toBe(`这是 ${UNSUPPORTED_IMAGE_NOTE} 的截图`)
    expect(hasImagePayload(result.messages)).toBe(false)
  })

  it('一张图片 + 两条内嵌串：replacedCount 与占位条数一致', () => {
    const result = stripped(asMessages([
      { role: 'user', content: 'a', contentBlocks: [
        { type: 'text', text: 'data:image/jpeg;base64,BBBB' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'CCCC' } },
        { type: 'text', text: 'data:image/webp;base64,DDDD' },
      ] },
    ]))
    expect(result.replacedCount).toBe(3)
    const notes = JSON.stringify(result.messages).split(UNSUPPORTED_IMAGE_NOTE).length - 1
    expect(notes).toBeGreaterThanOrEqual(3)
  })

  // 回归：检测与替换曾共用同一个全局正则，test() 推进 lastIndex 后检测结果依赖调用
  // 顺序（同一段文本偶发漏检）。
  it('重复检测同一段内嵌串文本结果稳定（与调用顺序无关）', () => {
    const text = 'a data:image/png;base64,ZZZZ b'
    expect(hasImagePayload(asMessages([{ role: 'user', content: text, contentBlocks: [{ type: 'text', text }] }])))
      .toBe(true)
    for (let round = 0; round < 3; round += 1) {
      expect(hasImagePayload(asMessages([
        { role: 'user', content: text, contentBlocks: [{ type: 'text', text }] },
      ]))).toBe(true)
    }
    // 替换后再检测：连续替换均能命中（不被 lastIndex 残留影响）。
    // replacedCount 只计 contentBlocks 里的负载位置（每条消息 1 处），
    // content 投影的同源替换不重复计数。
    const first = stripped(asMessages([
      { role: 'user', content: text, contentBlocks: [{ type: 'text', text }] },
      { role: 'user', content: text, contentBlocks: [{ type: 'text', text }] },
    ]))
    expect(first.replacedCount).toBe(2)
    expect(first.messages.every((m) => m.role !== 'user' || m.content === `a ${UNSUPPORTED_IMAGE_NOTE} b`))
      .toBe(true)
    expect(hasImagePayload(first.messages)).toBe(false)
  })
})

// 验收 18：残留即失败。
describe('无法替换的异常图片负载', () => {
  it('source 类型未知的 image 块 → ok:false（不得静默放行）', () => {
    const result = stripUnsupportedImages(asMessages([
      { role: 'user', content: 'x', contentBlocks: [
        { type: 'image', source: { type: 'data-url', payload: 'data:image/png;base64,AAAA' } },
      ] },
    ]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('图片负载形态无法替换')
    expect(result.error).toContain('data-url')
  })

  it('source 缺失的 image 块同样失败（异常形态不得被当作已知形态放行）', () => {
    const result = stripUnsupportedImages(asMessages([
      { role: 'user', content: 'x', contentBlocks: [{ type: 'image' }] },
    ]))
    expect(result.ok).toBe(false)
  })

  it('失败时不产出半成品副本（调用方拿不到未替换的消息数组）', () => {
    const result = stripUnsupportedImages(asMessages([
      { role: 'user', content: 'ok', contentBlocks: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'x', contentBlocks: [
        { type: 'image', source: { type: 'weird' } },
      ] },
    ]))
    expect(result.ok).toBe(false)
    expect('messages' in result).toBe(false)
  })
})
