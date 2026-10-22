/**
 * 文档页（DocsView）编辑态的文档读写通道。
 *
 * 读取走 `read_workspace_document`（整文件、≤1 MiB、返回宿主原始 SHA），避免
 * 分页读取在超长行时用占位提示替代正文。保存走 `save_workspace_document`：
 * 内容 base64 传输、CAS（expectedSha256 必须与盘上一致）、路径白名单在 Rust
 * 侧权威执行（SDD 受管目录与 AGENTS.md/DESIGN.md 之外 fail-closed）。
 *
 * 保存由文档页按钮触发是 **UI 约定，不是原生手势强制**；该命令不消费 Agent
 * 审批租约，安全边界在 Rust 的授权根、白名单、CAS 与写锁。
 */
import { invoke } from '@tauri-apps/api/core'
import { encodeUtf8ToBase64 } from '@/platform/base64'

export interface SavedWorkspaceDocument {
  workspacePath: string
  sha256: string
  sizeBytes: number
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
