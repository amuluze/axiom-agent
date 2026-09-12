/**
 * 中断错误识别与错误文本归一化。供流式处理、工具执行、审批协调共用。
 */

/** 判定错误是否为 AbortError（兼容 DOMException 与普通 Error 两种形态）。 */
export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'

/** 将任意错误归一化为可展示的字符串文本。 */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
