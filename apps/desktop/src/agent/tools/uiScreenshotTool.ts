import type { AgentTool, AgentToolResult, ArtifactReference, ToolResultContentBlock } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { UNSUPPORTED_IMAGE_NOTE } from '../core/stripUnsupportedImages'
import { hasOnlyKeys, isJsonObject, optionalInteger } from './workspaceToolUtils'
import { TAB_ID_INPUT, resolveUiTabId } from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200

export const createUiScreenshotTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_screenshot',
  label: 'ui_screenshot',
  promptSnippet: '截取浏览器页面（或某个元素）的 PNG 截图并保存为 Artifact（只读）。',
  promptGuidelines: [
    '截图用于视觉自查（布局、空态、遮挡），不替代 ui_snapshot 的结构事实：判断元素存在/文本/启用状态仍用 ui_snapshot 与 ui_assert。',
    'ref 只在当前步骤内有效，写动作后立即作废：拿到 ref 后先截图，别跨步骤复用。',
    '图片按模型图片能力与消息预算门控：不支持图片输入的模型只收到文字说明与 Artifact 引用，这是模型能力所限，不是截图失败。',
    '截图里可能有用户的敏感数据：不要把图里的内容逐字转述给用户，也不要写进文件；需要长期留证时引用 Artifact 路径。',
  ],
  runtimeVersion: '1',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'ui_screenshot:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    const ref = typeof input.ref === 'number' ? String(input.ref) : ''
    return `ui_screenshot:${tabId}:${ref}`
  },
  description:
    'Capture a read-only PNG screenshot of one Browser Rail tab, optionally clipped to an element ref '
    + 'resolved in the current step. tabId is optional and defaults to the active tab. The host downsizes '
    + 'the image when it exceeds its 4 MiB cap and reports resized; the returning image is stored as an '
    + 'image Artifact whose reference is attached to this result. The image content block is emitted only '
    + 'when the active model accepts image input — otherwise the tool returns text plus the Artifact '
    + 'reference, which is a model-capability limit, not a capture failure. Screenshots are evidence, not '
    + 'assertions: pair them with ui_assert for pass/fail facts.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      ref: {
        type: 'integer',
        minimum: 1,
        description: 'Element ref from a locator resolution in this step; clips the shot to that element box.',
      },
    },
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'ref'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId and ref.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    if (!optionalInteger(input.ref, 1, Number.MAX_SAFE_INTEGER)) {
      return { ok: false, error: 'ref must be an integer >= 1 when provided.' }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input)) throw new Error('Invalid ui_screenshot arguments.')
    const ref = typeof input.ref === 'number' ? input.ref : undefined
    const tabId = await resolveUiTabId(
      environment,
      typeof input.tabId === 'string' ? input.tabId.trim() : undefined,
    )
    const response = await environment.browser.command({
      action: 'screenshot',
      tabId,
      ...(ref !== undefined ? { ref } : {}),
    })
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (response.type !== 'screenshot') {
      throw new Error(`浏览器返回了非截图结果：${response.type}`)
    }
    // 图片 Artifact 是长期证据引用：模型只拿回可能已下采样的那一张，原图只留在
    // Artifact（设计 §12「原图只作为 Artifact 保存，不直接回灌模型」）。写入失败不
    // 影响本次视觉自查，但如实报告，不假装已留存。
    let artifact: ArtifactReference | undefined
    let artifactError: string | undefined
    try {
      artifact = await environment.artifacts.writeImage({
        contentBase64: response.imageBase64,
        mediaType: response.mimeType,
      })
    } catch (error) {
      artifactError = `截图未能写入 Artifact：${error instanceof Error ? error.message : String(error)}`
    }
    const summary = [
      `浏览器截图 · tabId=${tabId}${ref !== undefined ? ` ref=${ref}` : ''}`,
      `尺寸：${response.width}×${response.height}${response.resized ? '（已由宿主下采样到上限内）' : ''}`,
      artifact
        ? `Artifact：${artifact.relativePath}（kind=${artifact.kind} ${artifact.sizeBytes} 字节）`
        : artifactError ?? 'Artifact 未保存',
    ].join('\n')
    if (context.modelAcceptsImage === false) {
      return {
        content: `${summary}\n\n${UNSUPPORTED_IMAGE_NOTE} 截图本身已成功（尺寸与 Artifact 见上），只是当前模型不接受图片输入。`,
        ...(artifact ? { artifact } : {}),
        details: {
          tabId,
          width: response.width,
          height: response.height,
          resized: response.resized,
          mimeType: response.mimeType,
          imageDelivered: false,
          ...(artifactError ? { artifactError } : {}),
        },
      }
    }
    const blocks: ToolResultContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: response.mimeType, data: response.imageBase64 },
      },
    ]
    return {
      content: summary,
      contentBlocks: blocks,
      ...(artifact ? { artifact } : {}),
      details: {
        tabId,
        width: response.width,
        height: response.height,
        resized: response.resized,
        mimeType: response.mimeType,
        imageDelivered: true,
        ...(artifactError ? { artifactError } : {}),
      },
    }
  },
})
