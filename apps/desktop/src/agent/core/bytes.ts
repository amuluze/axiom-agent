/**
 * UTF-8 字节长度与按字节截断工具。供消息内容预算、工具结果内联上限等共用。
 */

export const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength

/**
 * 按 UTF-8 字节上限截断字符串，并在尾部追加可读截断提示（除非提示本身已超预算）。
 * 使用二分查找定位最大可保留字符数，避免在多字节字符中间切开。
 */
export const truncateToBytes = (
  value: string,
  maxBytes: number,
  suffix = '\n\n[内容已达到 Axiom 内联上限，后续内容被截断]',
): string => {
  if (byteLength(value) <= maxBytes) return value
  const suffixBytes = byteLength(suffix)
  if (suffixBytes > maxBytes) {
    let low = 0
    let high = suffix.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (byteLength(suffix.slice(0, middle)) <= maxBytes) low = middle
      else high = middle - 1
    }
    return suffix.slice(0, low)
  }
  const contentBudget = Math.max(0, maxBytes - suffixBytes)
  let low = 0
  let high = value.length

  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(value.slice(0, middle)) <= contentBudget) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  return `${value.slice(0, low)}${suffix}`
}
