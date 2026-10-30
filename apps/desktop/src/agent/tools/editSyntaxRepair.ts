import { isAbortError } from '@/agent/core/abort'
import type { AgentToolPreparationContext, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment, WorkspaceReadResult } from '@/agent/environment/AgentEnvironment'
import { sha256Text } from './workspaceToolUtils'

const MAX_REPAIR_FILE_BYTES = 64 * 1024
const MAX_REPAIR_REPLACEMENT_BYTES = 1024 * 1024
const MAX_REPAIR_ATTEMPTS = 2
const SUPPORTED_CODE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'])

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export interface SyntaxRepairEdit {
  [key: string]: JsonValue
  oldText: string
  newText: string
}

export interface SyntaxAssessment {
  supported: boolean
  valid: boolean
  language?: string
  diagnostic?: string
}

const extensionOf = (path: string): string => {
  const fileName = path.split('/').at(-1) ?? ''
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot + 1).toLocaleLowerCase('en-US') : ''
}

const assessDelimitedCode = (content: string, language: string): SyntaxAssessment => {
  const stack: Array<{ value: string; index: number }> = []
  let state: 'normal' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' | 'regex' = 'normal'
  let escaped = false
  let regexClass = false
  let canStartRegex = true
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]
    if (state === 'line-comment') {
      if (char === '\n') state = 'normal'
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'normal'
        index += 1
      }
      continue
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      const closing = state === 'single' ? "'" : state === 'double' ? '"' : '`'
      if (char === closing) {
        state = 'normal'
        canStartRegex = false
      }
      continue
    }
    if (state === 'regex') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '[') regexClass = true
      else if (char === ']') regexClass = false
      else if (char === '/' && !regexClass) {
        state = 'normal'
        while (/[a-z]/iu.test(content[index + 1] ?? '')) index += 1
        canStartRegex = false
      } else if (char === '\n') {
        return { supported: true, valid: false, language, diagnostic: `第 ${index + 1} 字符附近的正则字面量未闭合` }
      }
      continue
    }

    if (char === '/' && next === '/') {
      state = 'line-comment'
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      state = 'block-comment'
      index += 1
      continue
    }
    if (char === '/' && canStartRegex) {
      state = 'regex'
      regexClass = false
      continue
    }
    if (char === "'") {
      state = 'single'
      escaped = false
      continue
    }
    if (char === '"') {
      state = 'double'
      escaped = false
      continue
    }
    if (char === '`') {
      state = 'template'
      escaped = false
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push({ value: char, index })
      canStartRegex = true
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      const opening = stack.pop()
      if (!opening || opening.value !== pairs[char]) {
        return { supported: true, valid: false, language, diagnostic: `第 ${index + 1} 字符附近存在不匹配的 ${char}` }
      }
      canStartRegex = false
      continue
    }
    if (/\s/u.test(char)) continue
    canStartRegex = /[-=(:,;!?&|+*%^~<>]/u.test(char)
  }

  if (state === 'block-comment') return { supported: true, valid: false, language, diagnostic: '块注释未闭合' }
  if (state === 'single') return { supported: true, valid: false, language, diagnostic: '单引号字符串未闭合' }
  if (state === 'double') return { supported: true, valid: false, language, diagnostic: '双引号字符串未闭合' }
  if (state === 'template') return { supported: true, valid: false, language, diagnostic: '模板字符串未闭合' }
  if (state === 'regex') return { supported: true, valid: false, language, diagnostic: '正则字面量未闭合' }
  const opening = stack.at(-1)
  if (opening) {
    return { supported: true, valid: false, language, diagnostic: `第 ${opening.index + 1} 字符附近的 ${opening.value} 未闭合` }
  }
  return { supported: true, valid: true, language }
}

export const assessSyntax = (path: string, content: string): SyntaxAssessment => {
  const extension = extensionOf(path)
  if (extension === 'json') {
    try {
      JSON.parse(content)
      return { supported: true, valid: true, language: 'JSON' }
    } catch (error) {
      return {
        supported: true,
        valid: false,
        language: 'JSON',
        diagnostic: error instanceof Error ? error.message : 'JSON 无法解析',
      }
    }
  }
  if (SUPPORTED_CODE_EXTENSIONS.has(extension)) {
    return assessDelimitedCode(content, extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs'
      ? 'JavaScript'
      : 'TypeScript')
  }
  return { supported: false, valid: true }
}

export const applyExactEdits = (content: string, edits: SyntaxRepairEdit[]): string | undefined => {
  const ranges: Array<{ start: number; end: number; newText: string }> = []
  for (const edit of edits) {
    const start = content.indexOf(edit.oldText)
    if (start < 0 || content.indexOf(edit.oldText, start + edit.oldText.length) >= 0) return undefined
    ranges.push({ start, end: start + edit.oldText.length, newText: edit.newText })
  }
  ranges.sort((left, right) => left.start - right.start)
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) return undefined
  let updated = content
  for (const range of ranges.reverse()) {
    updated = `${updated.slice(0, range.start)}${range.newText}${updated.slice(range.end)}`
  }
  return updated
}

export interface PrepareSyntaxRepairOptions {
  path: string
  edits: SyntaxRepairEdit[]
  environment: AgentEnvironment
  context: AgentToolPreparationContext
  expectedSha256?: string
}

export interface PreparedSyntaxRepair {
  edits: SyntaxRepairEdit[]
  details?: JsonValue
}

export const prepareSyntaxRepair = async ({
  path,
  edits,
  environment,
  context,
  expectedSha256,
}: PrepareSyntaxRepairOptions): Promise<PreparedSyntaxRepair> => {
  if (!context.repairSyntax || !assessSyntax(path, '').supported) return { edits }
  let read: WorkspaceReadResult
  try {
    read = await environment.workspace.readText(path, 1, 1_000)
  } catch {
    return { edits }
  }
  if (
    context.signal.aborted
    || read.truncated
    || byteLength(read.content) > MAX_REPAIR_FILE_BYTES
    || (expectedSha256 !== undefined && read.sha256 !== expectedSha256)
    || await sha256Text(read.content) !== read.sha256
  ) return { edits }

  const beforeAssessment = assessSyntax(path, read.content)
  const proposed = applyExactEdits(read.content, edits)
  if (!beforeAssessment.valid || proposed === undefined) return { edits }
  const proposedAssessment = assessSyntax(path, proposed)
  if (proposedAssessment.valid || !proposedAssessment.diagnostic || !proposedAssessment.language) return { edits }

  let previousAttempt: string[] | undefined
  let diagnostic = proposedAssessment.diagnostic
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      const replacements = await context.repairSyntax({
        path,
        language: proposedAssessment.language,
        diagnostic,
        before: read.content,
        after: proposed,
        replacements: edits,
        ...(previousAttempt ? { previousAttempt } : {}),
      })
      previousAttempt = replacements
      if (
        replacements.length !== edits.length
        || replacements.some((replacement) => byteLength(replacement) > MAX_REPAIR_REPLACEMENT_BYTES)
      ) {
        diagnostic = '模型返回的 replacements 数量或大小不符合约束'
        continue
      }
      const repairedEdits = edits.map((edit, index) => ({ ...edit, newText: replacements[index] }))
      const repaired = applyExactEdits(read.content, repairedEdits)
      if (repaired === undefined) {
        diagnostic = '修复结果无法应用到原文件'
        continue
      }
      if (repaired === read.content || repairedEdits.every((edit) => edit.newText === edit.oldText)) {
        diagnostic = '修复结果只是撤销原修改，必须保留原修改意图'
        continue
      }
      const repairedAssessment = assessSyntax(path, repaired)
      if (!repairedAssessment.valid) {
        diagnostic = repairedAssessment.diagnostic ?? '修复结果仍未通过语法完整性检查'
        continue
      }
      return {
        edits: repairedEdits,
        details: {
          syntaxAutoRepair: {
            applied: true,
            language: proposedAssessment.language,
            diagnostic: proposedAssessment.diagnostic,
            attempts: attempt,
          },
        },
      }
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) throw error
    }
  }
  return { edits }
}
