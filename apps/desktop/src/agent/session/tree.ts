import type { StoredAgentSession } from '@/persistence/types'

export interface SessionTreeItem {
  session: StoredAgentSession
  depth: number
  orphaned: boolean
  hasChildren: boolean
}

const byUpdatedAt = (left: StoredAgentSession, right: StoredAgentSession): number =>
  right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)

export const flattenSessionTree = (sessions: StoredAgentSession[]): SessionTreeItem[] => {
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const validParentById = new Map<string, string | null>()
  const orphanedIds = new Set<string>()

  for (const session of sessions) {
    const parentId = session.parentSessionId
    if (!parentId) {
      validParentById.set(session.id, null)
      continue
    }
    if (!sessionById.has(parentId) || parentId === session.id) {
      validParentById.set(session.id, null)
      orphanedIds.add(session.id)
      continue
    }
    const seen = new Set([session.id])
    let cursor: string | null = parentId
    let cyclic = false
    while (cursor) {
      if (seen.has(cursor)) {
        cyclic = true
        break
      }
      seen.add(cursor)
      cursor = sessionById.get(cursor)?.parentSessionId ?? null
    }
    validParentById.set(session.id, cyclic ? null : parentId)
    if (cyclic) orphanedIds.add(session.id)
  }

  const children = new Map<string, StoredAgentSession[]>()
  const roots: StoredAgentSession[] = []
  for (const session of sessions) {
    const parentId = validParentById.get(session.id) ?? null
    if (!parentId) roots.push(session)
    else children.set(parentId, [...(children.get(parentId) ?? []), session])
  }
  roots.sort(byUpdatedAt)
  for (const childSessions of children.values()) childSessions.sort(byUpdatedAt)

  const output: SessionTreeItem[] = []
  const visited = new Set<string>()
  const visit = (session: StoredAgentSession, depth: number): void => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    const childSessions = children.get(session.id) ?? []
    output.push({
      session,
      depth,
      orphaned: orphanedIds.has(session.id),
      hasChildren: childSessions.length > 0,
    })
    for (const child of childSessions) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  for (const session of [...sessions].sort(byUpdatedAt)) visit(session, 0)
  return output
}
