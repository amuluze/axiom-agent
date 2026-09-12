import { memo, useState, type MouseEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2, PanelRight } from 'lucide-react'
import type { AgentMessage, ImageContentBlock } from '@/agent/core/types'
import { assistantContentBlocks } from '@/agent/core/messages'
import { openExternalUrl } from '@/platform/webAccess'
import { openUrlInBuiltinBrowser } from '@/stores/services/browserPanelService'
import { splitStreamingMarkdown } from './streamingMarkdown'
import { useT, type TFunction } from '@/i18n'

export type MessageContentBlock =
  | { kind: 'text'; content: string }
  | { kind: 'code'; content: string; language?: string }

export const parseMessageContent = (content: string): MessageContentBlock[] => {
  const blocks: MessageContentBlock[] = []
  const fence = /```([^\n`]*)\r?\n([\s\S]*?)```/gu
  let cursor = 0
  for (const match of content.matchAll(fence)) {
    const index = match.index ?? 0
    if (index > cursor) blocks.push({ kind: 'text', content: content.slice(cursor, index) })
    blocks.push({
      kind: 'code',
      language: match[1]?.trim() || undefined,
      content: (match[2] ?? '').replace(/\r?\n$/u, ''),
    })
    cursor = index + match[0].length
  }
  if (cursor < content.length) blocks.push({ kind: 'text', content: content.slice(cursor) })
  return blocks.length > 0 ? blocks : [{ kind: 'text', content }]
}

const MarkdownCodeBlock = ({ code, language }: { code: string; language?: string }) => {
  const { t } = useT()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copyCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const languageLabel = language ?? t('app.message.code')
  const copyLabel = copyState === 'copied' ? t('app.message.copied') : copyState === 'failed' ? t('app.message.copyFailed') : t('app.message.copy')
  return (
    <div className="message-code-block">
      <div className="message-code-header">
        <span>{languageLabel}</span>
        <button
          aria-label={language ? t('app.message.copyAria', { lang: language }) : t('app.message.copyAriaPlain')}
          onClick={() => void copyCode()}
          type="button"
        >
          {copyLabel}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}

const openLink = (event: MouseEvent<HTMLAnchorElement>, href: string | undefined): void => {
  if (!href) {
    event.preventDefault()
    return
  }
  // 只放行 http/https：拦截 javascript:、file: 等协议（react-markdown 默认
  // 会过滤 javascript:，这里双保险），并由系统默认浏览器打开（Tauri 下经
  // Rust open_external_url，浏览器 dev 模式回退 window.open）。
  if (!/^https?:\/\//u.test(href)) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  void openExternalUrl(href)
}

/**
 * 链接旁「在面板打开」的附加入口：展开右栏内嵌浏览器并新建 tab 打开链接，
 * 不改变点击默认行为（仍走系统浏览器）。面板打开/导航失败的错误由
 * openUrlInBuiltinBrowser 注入浏览器面板展示。
 */
const openInPanel = (href: string): void => {
  void openUrlInBuiltinBrowser(href)
}

const isHttpUrl = (href: string | undefined): href is string =>
  typeof href === 'string' && /^https?:\/\//u.test(href)

/** 链接旁「在面板打开」按钮：自身取语言，避免 markdownComponents 顶层无 hooks。 */
const LinkPanelButton = ({ href }: { href: string }) => {
  const { t } = useT()
  return (
    <button
      type="button"
      className="message-link-panel"
      aria-label={t('app.message.openPanelAria', { href })}
      title={t('app.message.openPanelTitle')}
      onClick={() => openInPanel(href)}
    >
      <PanelRight size={11} />
    </button>
  )
}

const markdownComponents: Components = {
  a({ node: _node, ref: _ref, ...props }) {
    const href = props.href
    const openable = isHttpUrl(href)
    // 外层 span 提供 hover 附属动作的定位锚（Markdown 内 a 本身是 inline，
    // 包 inline span 不改变排版）。
    return (
      <span className={openable ? 'message-link-wrap' : undefined}>
        <a
          {...props}
          rel="noreferrer noopener"
          target="_blank"
          onClick={(event) => openLink(event, href)}
        />
        {openable && href !== undefined && (
          <LinkPanelButton href={href} />
        )}
      </span>
    )
  },
  code({ children, className, node: _node, ref: _ref, ...props }) {
    const raw = String(children)
    const language = /language-([^\s]+)/u.exec(className ?? '')?.[1]
    const isBlock = Boolean(language || raw.endsWith('\n'))
    if (isBlock) {
      return <MarkdownCodeBlock code={raw.replace(/\n$/u, '')} language={language} />
    }
    return <code {...props} className="message-inline-code">{children}</code>
  },
  pre({ children }) {
    return <>{children}</>
  },
  table({ children, node: _node, ref: _ref, ...props }) {
    return (
      <div className="message-table-wrap">
        <table {...props}>{children}</table>
      </div>
    )
  },
}

export const MessageContent = memo(({ content }: { content: string }) => (
  <div className="message-content message-markdown">
    <Markdown
      components={markdownComponents}
      remarkPlugins={[remarkGfm]}
      skipHtml
    >
      {content}
    </Markdown>
  </div>
))
MessageContent.displayName = 'MessageContent'

const supportedPreviewMedia = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const truncateToolArguments = (value: string, t: TFunction): string =>
  value.length > 2_000 ? t('app.message.truncatedArgs', { value: value.slice(0, 2_000) }) : value

const ImagePreview = ({ block }: { block: ImageContentBlock }) => {
  const { t } = useT()
  if (block.source.type === 'url') {
    return (
      <div className="message-image-reference">
        <span>{t('app.message.remoteImage')}</span>
        <code>{block.source.url}</code>
      </div>
    )
  }
  if (!supportedPreviewMedia.has(block.source.mediaType)) {
    return <div className="message-image-reference">{t('app.message.image', { mediaType: block.source.mediaType })}</div>
  }
  return (
    <img
      alt={t('app.message.imageAlt')}
      className="message-image"
      loading="lazy"
      src={`data:${block.source.mediaType};base64,${block.source.data}`}
    />
  )
}

/**
 * 流式 text 块的增量渲染：把正在增长的文本按闭合 code fence 拆成稳定前缀与尾部，
 * 稳定前缀用 `memo` 的 `MessageContent` 整体渲染（内容不变不 re-parse），尾部用
 * 纯文本 `<pre>` 轻量渲染（保留换行，不解析 markdown，避免未闭合表格/列表/代码块闪烁）。
 */
const StreamingTextBlock = memo(({ text }: { text: string }) => {
  const { stable, tail } = splitStreamingMarkdown(text)
  return (
    <>
      {stable ? <MessageContent content={stable} /> : null}
      {tail ? <pre className="message-streaming-tail">{tail}</pre> : null}
    </>
  )
})
StreamingTextBlock.displayName = 'StreamingTextBlock'

export const RichMessageContent = ({
  message,
  renderToolCalls = true,
  streaming = false,
}: {
  message: AgentMessage
  renderToolCalls?: boolean
  streaming?: boolean
}) => {
  const { t } = useT()
  if (message.role === 'assistant') {
    const blocks = assistantContentBlocks(message)
    if (blocks.length === 0) return <MessageContent content={t('app.message.thinking')} />
    return (
      <>
        {blocks.map((block, index) => {
          if (block.type === 'text') {
            return streaming
              ? <StreamingTextBlock text={block.text} key={`text-${index}`} />
              : <MessageContent content={block.text} key={`text-${index}`} />
          }
          if (block.type === 'thinking') {
            // 思考是否仍在累积：流式中且该块之后还没有 text/tool_call 块。
            // 一旦模型转入正文或工具调用，思考块不再是最后一块，指示自动消失。
            const thinkingActive = streaming && index === blocks.length - 1
            return (
              <details className="message-thinking" key={`thinking-${index}`}>
                <summary>
                  {t('app.message.thinkingTitle')}
                  {thinkingActive && (
                    <Loader2 aria-hidden className="message-thinking__spinner" size={12} />
                  )}
                </summary>
                {block.redacted
                  ? <p>{t('app.message.thinkingHidden')}</p>
                  : <MessageContent content={block.thinking} />}
              </details>
            )
          }
          if (!renderToolCalls) return null
          return (
            <div className="tool-call-list" key={`tool-${block.id}`}>
              <div className="tool-call">
                <span>{t('app.message.toolCalls')}</span>
                <code>{block.name}</code>
                <code>{truncateToolArguments(block.rawArguments || '{}', t)}</code>
              </div>
            </div>
          )
        })}
      </>
    )
  }
  const images = message.role === 'user' || message.role === 'tool'
    ? message.contentBlocks?.filter((block): block is ImageContentBlock => block.type === 'image') ?? []
    : []

  return (
    <>
      {message.content && <MessageContent content={message.content} />}
      {images.length > 0 && (
        <div className="message-image-list">
          {images.map((block, index) => <ImagePreview block={block} key={`${index}-${block.source.type}`} />)}
        </div>
      )}
    </>
  )
}
