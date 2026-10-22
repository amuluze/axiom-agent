import type { JsonValue } from '@/agent/core/types'

const pathsBySession = new Map<string, Set<string>>()
const listeners = new Set<() => void>()
let revision = 0

const isRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizePath = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/')

const axPath = (value: JsonValue | undefined): string[] =>
  typeof value === 'string' && /\.ax$/iu.test(value) ? [normalizePath(value)] : []

export const designMutationPaths = (toolName: string, input: JsonValue): string[] => {
  if (!isRecord(input)) return []
  if (toolName === 'write' || toolName === 'edit') return axPath(input.path)
  if (toolName === 'design_import') return axPath(input.target)
  if (toolName !== 'apply_changes' || !Array.isArray(input.operations)) return []
  return [...new Set(input.operations.flatMap((operation) => {
    if (!isRecord(operation)) return []
    return operation.type === 'move'
      ? [...axPath(operation.from), ...axPath(operation.to)]
      : axPath(operation.path)
  }))]
}

const notify = (): void => {
  revision += 1
  for (const listener of listeners) listener()
}

export const recordDesignMutation = (sessionId: string, toolName: string, input: JsonValue): void => {
  const paths = designMutationPaths(toolName, input)
  if (paths.length === 0) return
  const current = pathsBySession.get(sessionId) ?? new Set<string>()
  let changed = false
  for (const path of paths) {
    if (current.has(path)) continue
    current.add(path)
    changed = true
  }
  if (!changed) return
  pathsBySession.set(sessionId, current)
  notify()
}

export const clearDesignMutations = (sessionId: string): void => {
  if (!pathsBySession.delete(sessionId)) return
  notify()
}

export const designMutationRevision = (): number => revision

export const subscribeDesignMutations = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const isDesignMutationActive = (
  sessionId: string,
  path: string,
  workspacePath?: string,
): boolean => {
  const active = pathsBySession.get(sessionId)
  if (!active) return false
  const relative = normalizePath(path)
  const absolute = workspacePath ? normalizePath(`${workspacePath}/${relative}`) : null
  return active.has(relative) || (absolute !== null && active.has(absolute))
}
