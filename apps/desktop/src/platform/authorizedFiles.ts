import { invoke } from '@tauri-apps/api/core'
import { commands, type AuthorizedReadFile, type AuthorizedTextContent } from './bindings'
import { isTauriRuntime } from './environment'

export type { AuthorizedReadFile, AuthorizedTextContent } from './bindings'

const requireTauri = (): void => {
  if (!isTauriRuntime()) throw new Error('文件授权仅在 Axiom 桌面应用中可用')
}

export const selectAndAuthorizeReadFile = async (): Promise<AuthorizedReadFile | null> => {
  requireTauri()
  // 原生文件选择器在 Rust 侧打开并直接授权，WebView 不把任意绝对路径当作
  // 授权输入（对齐 pick_and_authorize_workspace 的手势门）；取消时返回 null。
  return invoke<AuthorizedReadFile | null>('pick_and_authorize_read_file')
}

export const selectAndAuthorizeReadDirectory = async (): Promise<AuthorizedReadFile | null> => {
  requireTauri()
  return invoke<AuthorizedReadFile | null>('pick_and_authorize_read_directory')
}

export const listAuthorizedReadFiles = async (): Promise<AuthorizedReadFile[]> => {
  requireTauri()
  return commands.listAuthorizedReadFiles()
}

export const revokeAuthorizedReadFile = async (path: string): Promise<boolean> => {
  requireTauri()
  return commands.revokeAuthorizedReadFile(path)
}

export const readAuthorizedText = async (path: string): Promise<AuthorizedTextContent> => {
  requireTauri()
  return commands.readAuthorizedText(path)
}
