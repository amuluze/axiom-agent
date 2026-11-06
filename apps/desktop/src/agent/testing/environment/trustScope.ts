/**
 * 受信环境（`approvalMode = trusted`）的放行作用域。
 *
 * 「受信」只意味着一件事：这个环境的测试步骤**不再逐次弹审批卡**。它**不**意味���
 * 可以打任意地址——作用域是环境自己声明的 origin 集合（Web Base / API Base /
 * secretOrigins），越界的步骤照旧逐次审批。
 *
 * 权威判定在 Rust 侧（`api_test::within_trusted_scope`，读 SQLite 里的环境记录）。
 * 本模块是同一判定的 WebView 投影：它的唯一作用是让界面不弹一张 Rust 根本不打算
 * 弹的卡。两边口径不一致时，以 Rust 为准——Rust 放行而界面弹卡只是多一次点击，
 * 反过来则会卡住一次本该放行的步骤。
 */

/** 规范化为 `scheme://host:port`（端口按协议补默认值），与 Rust `same_api_origin` 同口径。 */
export const normalizeTestOrigin = (raw: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  const port = parsed.port !== ''
    ? parsed.port
    : parsed.protocol === 'https:' ? '443' : '80'
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`
}

export interface TrustedScopeInput {
  webBaseUrl?: string | null
  apiBaseUrl?: string | null
  secretOrigins?: readonly string[]
}

/** 环境声明的 origin 集合（去重，忽略解析失败的条目）。 */
export const trustedScopeOrigins = (input: TrustedScopeInput): string[] => {
  const origins = new Set<string>()
  for (const raw of [
    input.apiBaseUrl ?? '',
    input.webBaseUrl ?? '',
    ...(input.secretOrigins ?? []),
  ]) {
    if (raw.trim() === '') continue
    const origin = normalizeTestOrigin(raw)
    if (origin !== null) origins.add(origin)
  }
  return [...origins]
}

/** 目标地址是否落在作用域内。 */
export const withinTrustedScope = (input: TrustedScopeInput, target: string): boolean => {
  const origin = normalizeTestOrigin(target)
  if (origin === null) return false
  return trustedScopeOrigins(input).includes(origin)
}
