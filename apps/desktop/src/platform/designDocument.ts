import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type { UnlistenFn } from '@tauri-apps/api/event'

/** `.pen` 设计稿文档内容（read_design_document 的返回结构）。 */
export interface DesignDocumentContent {
  contentBase64: string
  sha256: string
  sizeBytes: number
  modifiedMs: number | null
  /** knownSha256 命中时为 true：内容未变，contentBase64 为空串不重复传输。 */
  unchanged: boolean
}

/** `.pen` 同目录图片资产（read_design_document_asset 的返回结构）。 */
export interface DesignAssetContent {
  contentBase64: string
  mediaType: string
  sha256: string
}

/**
 * 读取授权工作区内的 `.pen` 设计稿（设计画布只读数据源，docs/design-canvas.md §7）。
 * path 为授权工作区相对路径，Rust 侧校验扩展名 / 8MiB 上限 / 授权根 containment。
 * knownSha256 传入当前已持有内容的 sha256 时，内容未变则 Rust 不回传 base64
 * （轮询短路：省去 1.4MB 级文件的 base64 IPC 传输，只剩一次磁盘读 + hash）。
 */
export const readDesignDocument = (path: string, knownSha256?: string): Promise<DesignDocumentContent> =>
  invoke<DesignDocumentContent>('read_design_document', { path, knownSha256 })

/** 读取 `.pen` 同目录的相对图片资产（画布图片填充渲染）。远程 URL 由前端拒绝。 */
export const readDesignDocumentAsset = (path: string, assetPath: string): Promise<DesignAssetContent> =>
  invoke<DesignAssetContent>('read_design_document_asset', { path, assetPath })

/** 设计稿变更事件（watch_design_document emit，payload 带原始相对 path）。 */
export const DESIGN_DOCUMENT_CHANGED_EVENT = 'design-document-changed'

export interface DesignDocumentChangedPayload {
  path: string
}

/**
 * 监听设计稿文件变更（Rust notify watcher）：事件驱动替代高频轮询，
 * 返回去订阅函数。路径校验在 Rust watch 时完成，emit 事件本身不携内容。
 */
export const onDesignDocumentChanged = async (
  handler: (payload: DesignDocumentChangedPayload) => void,
): Promise<UnlistenFn> =>
  listen<DesignDocumentChangedPayload>(DESIGN_DOCUMENT_CHANGED_EVENT, (event) => {
    handler(event.payload)
  })

/** 注册文件监听：已在监听时返回 false（幂等）。 */
export const watchDesignDocument = (path: string): Promise<boolean> =>
  invoke<boolean>('watch_design_document', { path })

/**
 * 导出设计稿 PNG：写盘目标由 Rust 侧弹出系统原生保存对话框选定（不经
 * WebView 传路径）；用户取消返回 null，否则返回落盘绝对路径。
 */
export const exportDesignPng = (
  suggestedFileName: string,
  contentBase64: string,
): Promise<string | null> =>
  invoke<string | null>('export_design_png', { suggestedFileName, contentBase64 })

/** `write_design_document` 的返回结构。 */
export interface WrittenDesignDocument {
  sha256: string
  sizeBytes: number
}

/**
 * 写回 `.pen` 设计稿（画布直接操控的编辑通道，docs/design-canvas.md §11）。
 * path 为授权工作区相对路径；expectedSha256 为当前持有内容的 sha256（CAS）——
 * 盘上内容已被 Agent / pen.dev 更新时写入被拒（fail-closed），前端提示刷新。
 * 成功返回新 sha256，调用方据此短路后续轮询。
 */
export const writeDesignDocument = (
  path: string,
  contentBase64: string,
  expectedSha256?: string,
): Promise<WrittenDesignDocument> =>
  invoke<WrittenDesignDocument>('write_design_document', { path, contentBase64, expectedSha256 })

/** 取消文件监听：文件已删时也视为成功。 */
export const unwatchDesignDocument = (path: string): Promise<void> =>
  invoke<void>('unwatch_design_document', { path })
