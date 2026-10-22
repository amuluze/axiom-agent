import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type { UnlistenFn } from '@tauri-apps/api/event'

/** `.ax` 设计稿及 `.pen` 迁移输入的文档内容（read_design_document 的返回结构）。 */
export interface DesignDocumentContent {
  historyWarning?: string
  workspacePath?: string
  contentBase64: string
  sha256: string
  sizeBytes: number
  modifiedMs: number | null
  /** knownSha256 命中时为 true：内容未变，contentBase64 为空串不重复传输。 */
  unchanged: boolean
}

/** `.ax` 同目录图片资产（read_design_document_asset 的返回结构）。 */
export interface DesignAssetContent {
  contentBase64: string
  mediaType: string
  sha256: string
}

/**
 * 读取绑定授权工作区内的 `.ax` 设计稿或 `.pen` 迁移输入（设计画布只读数据源，docs/design-canvas.md §7）。
 * path 为授权工作区相对路径，Rust 侧校验扩展名 / 8MiB 上限 / 授权根 containment。
 * knownSha256 传入当前已持有内容的 sha256 时，内容未变则 Rust 不回传 base64
 * （轮询短路：省去 1.4MB 级文件的 base64 IPC 传输，只剩一次磁盘读 + hash）。
 */
export const readDesignDocument = (path: string, knownSha256?: string, workspacePath?: string): Promise<DesignDocumentContent> =>
  invoke<DesignDocumentContent>('read_design_document', { path, knownSha256, workspacePath })

/** 读取 `.ax` 同目录的相对图片资产（画布图片填充渲染）。远程 URL 由前端拒绝。 */
export const readDesignDocumentAsset = (path: string, assetPath: string, workspacePath?: string): Promise<DesignAssetContent> =>
  invoke<DesignAssetContent>('read_design_document_asset', { path, assetPath, workspacePath })

/** 设计稿变更事件（watch_design_document emit，payload 带原始相对 path）。 */
export const DESIGN_DOCUMENT_CHANGED_EVENT = 'design-document-changed'

export interface DesignDocumentChangedPayload {
  workspacePath: string
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
export const watchDesignDocument = (path: string, workspacePath?: string): Promise<boolean> =>
  invoke<boolean>('watch_design_document', { path, workspacePath })

/**
 * 导出设计稿 PNG：写盘目标由 Rust 侧弹出系统原生保存对话框选定（不经
 * WebView 传路径）；用户取消返回 null，否则返回落盘绝对路径。
 */
export const exportDesignPng = (
  suggestedFileName: string,
  contentBase64: string,
): Promise<string | null> =>
  invoke<string | null>('export_design_png', { suggestedFileName, contentBase64 })

/** 设计稿语义写操作的返回结构。 */
export interface WrittenDesignDocument {
  sha256: string
  sizeBytes: number
  historyWarning?: string
}

/** 历史版本条目（list_design_document_versions 的返回结构）。 */
export interface DesignDocumentVersion {
  sha256: string
  sizeBytes: number
  modifiedMs: number
  pageCount: number | null
}

/** 读取设计稿自动归档与可选 Git 导入后的版本清单。 */
export const listDesignDocumentVersions = (path: string, workspacePath?: string, includeGit?: boolean): Promise<DesignDocumentVersion[]> =>
  invoke<DesignDocumentVersion[]>('list_design_document_versions', { path, workspacePath, ...(includeGit ? { includeGit: true } : {}) })

export const readDesignDocumentVersion = (path: string, sha256: string, workspacePath?: string): Promise<DesignDocumentContent> =>
  invoke<DesignDocumentContent>('read_design_document_version', { path, sha256, workspacePath })

export const restoreDesignDocumentVersion = (
  path: string,
  sha256: string,
  expectedSha256: string,
  workspacePath?: string,
): Promise<WrittenDesignDocument> =>
  invoke<WrittenDesignDocument>('restore_design_document_version', { path, sha256, expectedSha256, workspacePath })

/**
 * 整页删除（评审面唯一写手势）。`null` 表示用户在宿主**原生确认框**里取消——
 * 不是失败，调用方按「未写入」处理；只有真正落盘才返回新 sha。
 */
export const deleteDesignDocumentPage = (
  path: string,
  pageId: string,
  contentBase64: string,
  expectedSha256: string,
  workspacePath?: string,
): Promise<WrittenDesignDocument | null> =>
  invoke<WrittenDesignDocument | null>('delete_design_document_page', { path, pageId, contentBase64, expectedSha256, workspacePath })

/** 取消文件监听：文件已删时也视为成功。 */
export const unwatchDesignDocument = (path: string, workspacePath?: string): Promise<void> =>
  invoke<void>('unwatch_design_document', { path, workspacePath })
