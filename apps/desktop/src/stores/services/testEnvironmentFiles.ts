/**
 * 工作区环境档扫描：把 `tests/environments/*.env.ax` 读成「可导入的运行环境草稿」。
 *
 * 与 `testSpecIndex` 同构：只做 I/O 与投影，判定完全交给
 * `agent/testing/environment/environmentFile` 的解析器（不再实现第二套校验）。
 * 目录不存在返回空数组（工作区没有环境档是正常状态）。
 */
import { createId } from '@/agent/core/id'
import {
  environmentRecordDraftFromFile,
  parseEnvironmentFile,
  type EnvironmentFileIssue,
  type EnvironmentMode,
  type EnvironmentRecordDraft,
} from '@/agent/testing/environment/environmentFile'
import { findWorkspaceFiles, readWorkspaceText } from '@/platform/workspace'

export interface EnvironmentFileEntry {
  path: string
  valid: boolean
  fileId: string | null
  name: string | null
  mode: EnvironmentMode | null
  issues: readonly EnvironmentFileIssue[]
  /** 有效档的导入草稿；无效档为 null（导入路径只认 valid 的条目）。 */
  draft: EnvironmentRecordDraft | null
}

import { isLegacyMissingDirectory } from './testScanErrors'

const invalid = (path: string, issues: readonly EnvironmentFileIssue[]): EnvironmentFileEntry => ({
  path,
  valid: false,
  fileId: null,
  name: null,
  mode: null,
  issues,
  draft: null,
})

/**
 * 扫描并解析。同一 `id` 被两个档声明时**两个都判无效**：导入会把它们写进同一条环境记录，
 * 静默覆盖比报错更难查。
 */
export const scanEnvironmentFiles = async (
  workspacePath: string,
  signal: AbortSignal,
): Promise<EnvironmentFileEntry[]> => {
  let paths: string[]
  try {
    const result = await findWorkspaceFiles({
      requestId: createId('env-index'),
      pattern: '*.env.ax',
      path: 'tests/environments',
      limit: 100,
      signal,
      workspacePath,
    })
    if (result.truncated) {
      throw new Error('测试环境档清单超过 100 个，扫描结果不完整')
    }
    paths = result.matches
      .filter((entry) => entry.kind === 'file' && entry.path.endsWith('.env.ax'))
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (isLegacyMissingDirectory(error)) return []
    throw error
  }

  const entries = await Promise.all(paths.map(async (path): Promise<EnvironmentFileEntry> => {
    try {
      const read = await readWorkspaceText(path, 0, 1_000, workspacePath)
      if (read.truncated) {
        return invalid(path, [{ path: '$', message: '文件超过环境档读取上限' }])
      }
      const parsed = parseEnvironmentFile(read.content)
      if (!parsed.ok) return invalid(path, parsed.issues)
      return {
        path,
        valid: true,
        fileId: parsed.file.id,
        name: parsed.file.name,
        mode: parsed.file.mode,
        issues: [],
        draft: environmentRecordDraftFromFile(parsed.file),
      }
    } catch {
      return invalid(path, [{ path: '$', message: '读取文件失败' }])
    }
  }))

  return entries.map((entry) => {
    if (entry.fileId === null) return entry
    const duplicate = entries.filter((candidate) => candidate.fileId === entry.fileId)
    if (duplicate.length <= 1) return entry
    return invalid(entry.path, [
      { path: '$.id', message: `环境档 ID「${entry.fileId}」与其它档重复（${duplicate.map((item) => item.path).join('、')}）` },
    ])
  })
}
