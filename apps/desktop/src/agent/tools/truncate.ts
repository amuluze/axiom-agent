export const DEFAULT_MAX_LINES = 200
export const DEFAULT_MAX_BYTES = 128 * 1024
export const GREP_MAX_LINE_LENGTH = 500
export const GREP_MAX_MATCHES = 100
export const LS_DEFAULT_ENTRIES = 200
export const LS_MAX_ENTRIES = 1000
export const FIND_MAX_RESULTS = 1000

export const truncateLongLine = (line: string, maxChars: number = GREP_MAX_LINE_LENGTH): string => {
  if (line.length <= maxChars) return line
  return `${line.slice(0, maxChars)}… [line truncated at ${maxChars} chars]`
}
