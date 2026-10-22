import { invoke } from '@tauri-apps/api/core'

/**
 * 外部链接的平台封装：命令名以字面量出现在 `invoke` 调用中，
 * 供 `tauri-capability-audit` 做 handler ↔ capability ↔ 前端三向漂移审计。
 * 协议校验（仅 http/https、无凭据）由 Rust 侧权威执行。
 * （web_search/web_fetch/authorize_web_read 等只读 Agent 通道已随会话能力
 * 预设清理移除，本文件只保留设置页与面板仍在使用的外链通道。）
 */

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
