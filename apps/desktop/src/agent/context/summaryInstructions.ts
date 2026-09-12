import { utf8ByteLength } from './budget'

export const MAX_SUMMARY_INSTRUCTION_BYTES = 16 * 1024

export interface SummaryInstructionOptions {
  customInstructions?: string
  replaceInstructions?: boolean
}

export const resolveSummaryInstructions = (
  defaultInstructions: string,
  options: SummaryInstructionOptions | undefined,
  allowReplace: boolean,
): string => {
  const customInstructions = options?.customInstructions?.trim()
  if (!customInstructions) return defaultInstructions
  if (utf8ByteLength(customInstructions) > MAX_SUMMARY_INSTRUCTION_BYTES) {
    throw new Error('自定义摘要指令超过 16 KiB 安全上限')
  }
  if (allowReplace && options?.replaceInstructions) return customInstructions
  return `${defaultInstructions}\n\n额外关注事项：\n${customInstructions}`
}
