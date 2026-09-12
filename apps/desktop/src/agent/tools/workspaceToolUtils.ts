import type { JsonValue } from '@/agent/core/types'

export const isJsonObject = (input: JsonValue): input is { [key: string]: JsonValue } =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

export const hasOnlyKeys = (input: { [key: string]: JsonValue }, keys: string[]): boolean => {
  const allowed = new Set(keys)
  return Object.keys(input).every((key) => allowed.has(key))
}

export const isSafeRelativePath = (value: string, allowCurrent = false): boolean => {
  const normalized = value.trim()
  if (!normalized) return allowCurrent
  if (normalized.startsWith('/') || /^[a-z]:[\\/]/iu.test(normalized)) return false
  return normalized.split(/[\\/]/u).every((part) => part !== '..')
}

export const optionalInteger = (
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): value is number | undefined => value === undefined
  || (typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum)

/**
 * Stricter variant of `isSafeRelativePath` for write/edit/apply_changes tools:
 * additionally rejects paths containing `\` and any segment equal to `.git`
 * or `.axiom` (so workspace mutations cannot reach version-control or
 * Axiom-internal control directories). Use this predicate everywhere a tool
 * intends to mutate the workspace.
 */
export const isMutablePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || !isSafeRelativePath(value) || value.includes('\\')) return false
  const parts = value.split('/').filter((part) => part && part !== '.')
  return parts.length > 0 && !parts.some((part) => part === '.git' || part === '.axiom')
}

/**
 * SHA-256 hex digest over the UTF-8 encoding of `value` (Web Crypto, async).
 * 幂等键用内容哈希而非长度签名，避免"同路径同字节数、内容不同"的碰撞。
 */
export const sha256Text = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
