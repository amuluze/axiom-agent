/**
 * 文档页（DocsView）编辑态的文档读写通道。
 *
 * 读取走 `read_workspace_document`（整文件、≤1 MiB、返回宿主原始 SHA），避免
 * 分页读取在超长行时用占位提示替代正文。保存走 `save_workspace_document`：
 * 内容 base64 传输、CAS（expectedSha256 必须与盘上一致）、路径白名单在 Rust
 * 侧权威执行（SDD 受管目录与 AGENTS.md/DESIGN.md 之外 fail-closed）。
 *
 * 保存不消费 Agent 审批租约，但 macOS 必须消费原生用户手势配额，其他平台必须
 * 通过宿主确认；其余安全边界在 Rust 的授权根、白名单、CAS 与写锁。
 *
 * 保存是整文件覆盖，`.plans/` 与 `.specs/tasks/` 又被 gitignore——因此 Rust 侧
 * 在覆盖前把旧内容留档（`document_history.rs`），本模块暴露历史列举与回滚。
 */
import { invoke } from '@tauri-apps/api/core'
import { encodeUtf8ToBase64 } from '@/platform/base64'

export interface SavedWorkspaceDocument {
  workspacePath: string
  sha256: string
  sizeBytes: number
  /** 覆盖前的旧内容版本号；用于「撤销本次保存」。 */
  previousSha256: string | null
}

export interface WorkspaceDocumentVersion {
  sha256: string
  sizeBytes: number
  modifiedMs: number
}

export interface WorkspaceDocument {
  workspacePath: string
  path: string
  content: string
  sha256: string
  sizeBytes: number
}

/**
 * 读取一份文档的完整原文（≤1 MiB），供编辑态使用。
 *
 * 与分页 read 不同：这里返回宿主原始 UTF-8 文本与全文 SHA，不会在单行超过
 * 128 KiB 输出上限时用占位提示替代真实行；CAS 直接使用该 SHA。
 */
export const readWorkspaceDocument = (
  path: string,
  workspacePath?: string,
): Promise<WorkspaceDocument> =>
  invoke<WorkspaceDocument>('read_workspace_document', {
    path,
    ...(workspacePath ? { workspacePath } : {}),
  })

export const saveWorkspaceDocument = (
  path: string,
  content: string,
  expectedSha256: string,
  workspacePath?: string,
): Promise<SavedWorkspaceDocument> =>
  invoke<SavedWorkspaceDocument>('save_workspace_document', {
    path,
    contentBase64: encodeUtf8ToBase64(content),
    expectedSha256,
    ...(workspacePath ? { workspacePath } : {}),
  })

/**
 * 列出该文档的历史版本（新→旧）。历史是保存时自动留档的旧内容，
 * 因此只包含「曾经存在的版本」——当前内容单独由 read 命令提供。
 */
export const listWorkspaceDocumentVersions = (
  path: string,
  workspacePath?: string,
): Promise<WorkspaceDocumentVersion[]> =>
  invoke<WorkspaceDocumentVersion[]>('list_workspace_document_versions', {
    path,
    ...(workspacePath ? { workspacePath } : {}),
  })

/**
 * 把文档回滚到某个历史版本（需原生手势 / 宿主确认，由 Rust 侧强制）。
 * CAS 语义与保存一致：盘上内容已变则拒绝，避免盖掉别人的新写入。
 */
export const restoreWorkspaceDocumentVersion = (
  path: string,
  sha256: string,
  expectedSha256: string,
  workspacePath?: string,
): Promise<SavedWorkspaceDocument> =>
  invoke<SavedWorkspaceDocument>('restore_workspace_document_version', {
    path,
    sha256,
    expectedSha256,
    ...(workspacePath ? { workspacePath } : {}),
  })
