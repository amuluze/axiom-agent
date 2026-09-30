import type { ModelRequest } from './types'

type ModelMessage = ModelRequest['messages'][number]

/**
 * 能力不匹配时的固定占位子串（Task Spec 验收 9 钉死）：措辞在 Tool 侧与请求侧
 * 必须逐字一致，模型据此能区分「我看不到图」与「图里没有内容」。
 */
export const UNSUPPORTED_IMAGE_NOTE = '[图片已省略：当前模型不支持图片输入]'

/**
 * text 块内嵌的 data URL 图片负载（Task Spec 术语第二类）。逐处整段替换：串本身
 * 动辄数十 KB base64，留在纯文本模型的请求里只是白白发量。
 */
const INLINE_IMAGE_PATTERN = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/g

// 检测用独立正则：全局正则的 test() 会推进 lastIndex，与 replace 共用同一实例
// 时检测结果依赖调用顺序（此处表现为同一段文本偶发漏检）。`y` 标记只做粘性匹配，
// 不推进 lastIndex。
const INLINE_IMAGE_PROBE = /data:image\/[A-Za-z0-9.+-]+;base64,/

const hasInlineImage = (text: string): boolean => INLINE_IMAGE_PROBE.test(text)

export type StripUnsupportedImagesResult =
  | { ok: true; messages: ModelMessage[]; replacedCount: number }
  | { ok: false; error: string }

/**
 * image 块 → 占位文本块。source 形态无法识别时返回 undefined 交由调用方显式失败：
 * 未知形态意味着无法确认「整块替掉」已覆盖全部图片负载（payload 可能藏在未建模
 * 字段里），静默替掉等于把读不懂的负载当作已处理（验收 18）。
 *
 * 形参刻意收 unknown 而非 ImageContentBlock['source']：防的正是类型层面合法、
 * 但我们尚未建模的第三种 source 变体——类型收窄到联合成员就看不见它了。
 */
const replaceableImageSourceType = (source: unknown): string | undefined => {
  const type = typeof source === 'object' && source !== null
    ? (source as { type?: unknown }).type
    : undefined
  return type === 'base64' || type === 'url' ? type : undefined
}

/**
 * 发送副本降级（Domain 不变量 4/5）：模型不接受图片时**不抛错中断整轮**，而是把
 * 图片负载逐处替换为固定子串。调用点必须作用在即将发出的副本上——持久化消息、
 * 审计记录与 Artifact 引用一概不动（占位不是新的模型可见事实，只是不再浪费
 * 读不懂的负载），也不得经 prepareModelRequest 的回写路径污染 context.messages。
 *
 * 逐处就地替换：角色、块数与块序不变，不含图片负载的块逐字节不变——不得以整条
 * 消息替换或整条丢弃的方式实现，否则模型无法区分「此处原本有图」与「此处无内容」。
 *
 * 无图片的消息原样返回（同引用），避免为纯文本请求凭空复制整段会话。
 */
export const stripUnsupportedImages = (
  messages: readonly ModelMessage[],
): StripUnsupportedImagesResult => {
  let replacedCount = 0
  const stripped: ModelMessage[] = []
  for (const message of messages) {
    // contentBlocks 只存在于 user/tool 消息上（与请求组装的图片闸同一口径）。
    if (message.role === 'assistant') {
      stripped.push(message)
      continue
    }
    const blocks = message.contentBlocks
    const inlineInContent = hasInlineImage(message.content)
    if (!blocks?.some((block) => block.type === 'image') && !inlineInContent) {
      stripped.push(message)
      continue
    }
    const nextBlocks: NonNullable<typeof blocks> = []
    for (const block of blocks ?? []) {
      if (block.type === 'image') {
        if (!replaceableImageSourceType(block.source)) {
          const raw = typeof block.source === 'object' && block.source !== null
            ? (block.source as { type?: unknown }).type
            : undefined
          return {
            ok: false,
            error: `图片负载形态无法替换（source=${typeof raw === 'string' ? raw : typeof raw}）`,
          }
        }
        replacedCount += 1
        nextBlocks.push({ type: 'text', text: UNSUPPORTED_IMAGE_NOTE })
        continue
      }
      // ModelMessage 是联合类型，按位置索引拿到的块类型是各成员的并集，写回时
      // 无法证明它仍属于具体成员（工具调用块/思考块只属于 assistant）——这里的
      // 变换是保序的 image→text 与内嵌串替换，成员身份不会被改变。
      if (block.type === 'text' && hasInlineImage(block.text)) {
        replacedCount += 1
        nextBlocks.push({
          ...block,
          text: block.text.replace(INLINE_IMAGE_PATTERN, UNSUPPORTED_IMAGE_NOTE),
        } as typeof block)
        continue
      }
      nextBlocks.push(block)
    }
    const content = inlineInContent
      ? message.content.replace(INLINE_IMAGE_PATTERN, UNSUPPORTED_IMAGE_NOTE)
      : message.content
    stripped.push({
      ...message,
      contentBlocks: nextBlocks,
      // 图片被整体替掉后正文可能为空；空 content 会被部分 provider 直接拒收，
      // 用同一子串兜底（文本侧已有内容时保留原文，不覆盖模型的既有上下文）。
      content: content.trim() ? content : UNSUPPORTED_IMAGE_NOTE,
    } as ModelMessage)
  }
  return { ok: true, messages: stripped, replacedCount }
}

/** 降级后的残留自检：任何图片负载（image 块 / 内嵌 data URL）都不得留在副本里。 */
export const hasImagePayload = (messages: readonly ModelMessage[]): boolean =>
  messages.some((message) => {
    if (message.role === 'assistant') return false
    if (hasInlineImage(message.content)) return true
    return (message.contentBlocks ?? []).some((block) => (
      block.type === 'image' || (block.type === 'text' && hasInlineImage(block.text))
    ))
  })
