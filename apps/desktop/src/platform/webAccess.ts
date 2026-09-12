import { invoke } from '@tauri-apps/api/core'

/**
 * web 只读访问的平台封装：命令名以字面量出现在 `invoke` 调用中，
 * 供 `tauri-capability-audit` 做 handler ↔ capability ↔ 前端三向漂移审计。
 * 安全边界（公网主机校验、体积/输出上限、HTML 转文本）全部由 Rust
 * `web_access.rs` 权威执行，本层只做类型化转发。
 */

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResponse {
  query: string
  results: WebSearchResultItem[]
}

export interface WebFetchResponse {
  /** 重定向跟随后的最终 URL。 */
  url: string
  status: number
  contentType: string
  content: string
  truncated: boolean
  fetchedBytes: number
}

export const webSearch = (query: string, limit?: number): Promise<WebSearchResponse> =>
  invoke<WebSearchResponse>('web_search', { query, limit })

export const webFetch = (url: string, maxBytes?: number): Promise<WebFetchResponse> =>
  invoke<WebFetchResponse>('web_fetch', { url, maxBytes })

/**
 * 用系统默认浏览器打开外部链接（会话输出中的 markdown 链接，如 PR 链接）。
 * 由 Rust `open_external_url` 校验协议（仅 http/https、无凭据）后经
 * `/usr/bin/open` 打开；浏览器 dev 模式无 Tauri 时回退 window.open。
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (!/^https?:\/\//u.test(url)) return
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    await invoke('open_external_url', { url })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
