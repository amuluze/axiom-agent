/**
 * 明文凭据检测（TestSpec / 环境档共享）。
 *
 * 只能识别显式前缀（Bearer/Basic 与常见厂商 token 前缀）——它是纵深防御的
 * fail-closed 快筛，不是完整的凭据分类器。真正的 Secret 必须走 `apitest.*` 引用，
 * Rust 侧在请求期注入。
 */
export const PLAINTEXT_CREDENTIAL_PATTERN =
  /(?:^|[\s"'=:])(?:Bearer|Basic)\s|(?:^|[\s"'=:])(?:sk-|sk_live_|ghp_|gho_|xoxb-|AKIA|AIza)/u

export const containsPlaintextCredential = (value: string): boolean =>
  PLAINTEXT_CREDENTIAL_PATTERN.test(value)
