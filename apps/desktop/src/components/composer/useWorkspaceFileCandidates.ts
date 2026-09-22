import { useEffect, useState } from 'react'
import { createId } from '@/agent/core/id'
import { useAgentStore } from '@/stores/agentStore'
import { findWorkspaceFiles, type WorkspaceEntry } from '@/platform/workspace'
import type { MentionCandidate } from './mentionParser'
import { useT } from '@/i18n'

/** 工作区检索的候选上限：对齐 Rust MAX_FIND_LIMIT（1_000），弹层滚动展示全部。 */
export const WORKSPACE_FILE_CANDIDATE_LIMIT = 1_000

/** 击键防抖：Rust 侧全量遍历工作区（无匹配时走完整棵树），不宜每键一查。 */
export const WORKSPACE_SEARCH_DEBOUNCE_MS = 150

/** 查询清洗后参与 pattern 的最大字符数（glob 体积与可读性护栏）。 */
const MAX_QUERY_LENGTH = 40

const GLOB_METACHARACTERS = /[*?[\]{}!\\]/gu

/**
 * 把用户查询翻译成 `find_workspace_files` 的 glob：按「路径段名包含」匹配，
 * 每个字母展开成大小写字符类（Rust globset 默认大小写敏感，不改 agent find
 * 工具的既有语义）；glob 元字符一律剔除。空查询 → `*`（顶层目录/文件列表）。
 */
export const buildWorkspaceGlobPattern = (query: string): string => {
  const segments = query.replace(GLOB_METACHARACTERS, '').split('/')
  const sanitized = (segments.at(-1) ?? '').trim().slice(0, MAX_QUERY_LENGTH)
  if (!sanitized) return '*'
  const classes = [...sanitized].map((char) => {
    const lower = char.toLocaleLowerCase()
    const upper = char.toLocaleUpperCase()
    return lower === upper ? char : `[${lower}${upper}]`
  }).join('')
  return `**/*${classes}*`
}

const fileExtensionHint = (name: string): string => {
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex + 1).toLocaleLowerCase()
}

export const workspaceEntriesToCandidates = (
  entries: readonly WorkspaceEntry[],
  workspacePath: string,
  directoryHint: string,
): MentionCandidate[] => {
  const root = workspacePath.replace(/\/+$/u, '')
  return entries.map((entry) => ({
    id: `${root}/${entry.path}`,
    label: entry.path,
    hint: entry.kind === 'directory' ? directoryHint : fileExtensionHint(entry.name),
    group: 'workspace',
    relativePath: entry.path,
    ...(entry.kind === 'directory' ? { isDirectory: true } : {}),
  }))
}

/** 顶层列举的展示序：目录在前，同类型按路径本地化排序（walk 顺序不可预期）。 */
export const sortWorkspaceEntries = (entries: readonly WorkspaceEntry[]): WorkspaceEntry[] =>
  [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      if (left.kind === 'directory') return -1
      if (right.kind === 'directory') return 1
    }
    return left.path.localeCompare(right.path, 'zh-CN')
  })

/**
 * 合并手动引用与工作区检索结果：手动引用是显式用户意图，恒排在前；
 * 按 id（绝对路径）去重，总数封顶。
 */
export const mergeFileCandidates = (
  manual: readonly MentionCandidate[],
  workspace: readonly MentionCandidate[],
  limit: number = WORKSPACE_FILE_CANDIDATE_LIMIT,
): MentionCandidate[] => {
  const seen = new Set<string>()
  const merged: MentionCandidate[] = []
  for (const candidate of [...manual, ...workspace]) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    merged.push(candidate)
    if (merged.length >= limit) break
  }
  return merged
}

/**
 * `@` 文件模式的自动候选：按查询防抖检索当前授权工作区（含顶层目录列表），
 * 失败（浏览器 demo 模式 / 无 Tauri / 无工作区）静默回落为空——弹层仍展示
 * 手动引用与「选择文件…/选择目录…」动作。query 为 null 表示非 file 模式，不检索。
 */
export const useWorkspaceFileCandidates = (
  query: string | null,
  browseDir: string | null = null,
): MentionCandidate[] => {
  const { t } = useT()
  const [candidates, setCandidates] = useState<MentionCandidate[]>([])
  const workspacePath = useAgentStore((state) => state.authorizedWorkspace?.path ?? null)
  const directoryHint = t('app.mention.hint.directory')
  const searchKey = query === null || workspacePath === null ? null : query

  useEffect(() => {
    if (searchKey === null || workspacePath === null) {
      setCandidates([])
      return
    }
    let disposed = false
    const controller = new AbortController()
    // 空查询 = 「当前目录列举」：限制深度 1，否则 glob 的 `*` 跨分隔符
    // 会把深层文件混进候选。
    const maxDepth = searchKey.trim().length === 0 ? 1 : undefined
    const timer = window.setTimeout(() => {
      findWorkspaceFiles({
        requestId: createId('mention-search'),
        pattern: buildWorkspaceGlobPattern(searchKey),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(browseDir ? { path: browseDir } : {}),
        limit: WORKSPACE_FILE_CANDIDATE_LIMIT,
        signal: controller.signal,
        workspacePath,
      }).then((result) => {
        if (disposed) return
        setCandidates(workspaceEntriesToCandidates(
          sortWorkspaceEntries(result.matches),
          workspacePath,
          directoryHint,
        ))
      }).catch(() => {
        // 检索失败不弹错：提及弹层是输入辅助，回退到手动引用候选即可。
        if (disposed) return
        setCandidates([])
      })
    }, WORKSPACE_SEARCH_DEBOUNCE_MS)
    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [searchKey, workspacePath, directoryHint, browseDir])

  return candidates
}
