import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, Folder, LockKeyhole, Trash2 } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import type { StoredAgentSession } from '@/persistence/types'
import { useT } from '@/i18n'
import { displaySessionTitle } from '@/i18n/sessionTitle'

/** 将时间戳格式化为可读的相对时间。 */
const formatArchivedAt = (ts: number, t: (key: string, params?: Record<string, string | number>) => string): string => {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('settings.archived.justNow')
  if (mins < 60) return t('settings.archived.minutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('settings.archived.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('settings.archived.daysAgo', { count: days })
  return new Date(ts).toLocaleDateString('zh-CN')
}

interface ArchivedGroup {
  name: string
  path?: string
  sessions: StoredAgentSession[]
}

/** 按工作区 name/path 分组，组内按归档时间倒序，组间由最近归档时间倒序。 */
const groupArchivedSessions = (sessions: StoredAgentSession[], t: (key: string) => string): ArchivedGroup[] => {
  const map = new Map<string, ArchivedGroup>()
  for (const session of sessions) {
    const name = session.workspace?.name ?? t('settings.archived.workspaceUnnamed')
    const path = session.workspace?.path
    const key = path ?? name
    const group = map.get(key)
    if (group) {
      group.sessions.push(session)
    } else {
      map.set(key, { name, path, sessions: [session] })
    }
  }
  return Array.from(map.values())
    .map((group) => ({
      ...group,
      sessions: group.sessions.sort((a, b) => ((b.archivedAt ?? 0) - (a.archivedAt ?? 0))),
    }))
    .sort((a, b) => {
      const aMax = a.sessions[0]?.archivedAt ?? 0
      const bMax = b.sessions[0]?.archivedAt ?? 0
      return bMax - aMax
    })
}

export const ArchivedSection = () => {
  const { t } = useT()
  const sessions = useAgentStore((state) => state.sessions)
  const restoreSession = useAgentStore((state) => state.restoreSession)
  const deleteSession = useAgentStore((state) => state.deleteSession)
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // 删除确认状态 4s 后自动复位，替代 onBlur 重置：避免焦点竞争导致两次点击无法完成删除。
  useEffect(() => {
    if (!confirmDeleteId) return
    const timer = setTimeout(() => setConfirmDeleteId(null), 4000)
    return () => clearTimeout(timer)
  }, [confirmDeleteId])

  const groups = useMemo(() => {
    const archived = sessions.filter((s) => Boolean(s.archivedAt))
    return groupArchivedSessions(archived, t)
  }, [sessions, t])

  const totalArchived = useMemo(
    () => groups.reduce((sum, group) => sum + group.sessions.length, 0),
    [groups],
  )

  const handleDelete = useCallback(async (sessionId: string) => {
    if (confirmDeleteId !== sessionId) {
      setConfirmDeleteId(sessionId)
      return
    }
    setConfirmDeleteId(null)
    await deleteSession(sessionId)
  }, [confirmDeleteId, deleteSession])

  const handleRestore = useCallback(async (sessionId: string) => {
    await restoreSession(sessionId)
  }, [restoreSession])

  return (
    <section className="settings-section" id="settings-archived" aria-labelledby="settings-archived-title">
      <div className="section-title">
        <span id="settings-archived-title">{t('settings.archived.title')}</span>
        <span className="section-state">{t('settings.archived.count', { count: totalArchived })}</span>
      </div>

      {totalArchived === 0 ? (
        <div className="archived-empty" role="status" aria-label={t('settings.archived.empty.title')}>
          <ArchiveRestore size={32} className="archived-empty__icon" />
          <p className="archived-empty__title">{t('settings.archived.empty.title')}</p>
          <p className="archived-empty__description">
            {t('settings.archived.empty.desc')}
          </p>
        </div>
      ) : (
        <div className="archived-list" role="list" aria-label={t('settings.archived.listAria')}>
          {groups.map((group) => (
            <div key={group.path ?? group.name} className="archived-group" role="group" aria-label={t('settings.archived.groupAria', { name: group.name })}>
              <div className="archived-group__header">
                <Folder size={14} className="archived-group__icon" />
                <div className="archived-group__info">
                  <span className="archived-group__name">{group.name}</span>
                  {group.path && group.path !== group.name && (
                    <span className="archived-group__path" title={group.path}>{group.path}</span>
                  )}
                </div>
                <span className="archived-group__count">{t('settings.archived.count', { count: group.sessions.length })}</span>
              </div>

              <div className="archived-group__list">
                {group.sessions.map((session) => {
                  const isConfirmingDelete = confirmDeleteId === session.id
                  const isActive = session.id === activeSessionId
                  return (
                    <div
                      key={session.id}
                      className={`archived-item ${isActive ? 'archived-item--active' : ''}`}
                      role="listitem"
                    >
                      <div className="archived-item__main">
                        <span className="archived-item__title" title={displaySessionTitle(t, session.title)}>
                          {displaySessionTitle(t, session.title)}
                        </span>
                        <span className="archived-item__meta">
                          {session.archivedAt ? formatArchivedAt(session.archivedAt, t) : t('settings.archived.timeUnknown')}
                          {session.messageCount > 0 && ` · ${t('settings.archived.messages', { count: session.messageCount })}`}
                          {isActive && ` · ${t('settings.archived.current')}`}
                        </span>
                      </div>

                      <div className="archived-item__actions">
                        <button
                          type="button"
                          className="archived-item__button"
                          aria-label={t('settings.archived.restoreAria')}
                          title={t('settings.archived.restoreAria')}
                          onClick={() => { void handleRestore(session.id) }}
                        >
                          <ArchiveRestore size={14} />
                          <span className="archived-item__button-label">{t('settings.archived.restore')}</span>
                        </button>
                        <button
                          type="button"
                          className={`archived-item__button ${isConfirmingDelete ? 'archived-item__button--danger' : ''}`}
                          aria-label={isConfirmingDelete ? t('settings.archived.deleteConfirmAria') : t('settings.archived.deleteAria')}
                          title={isConfirmingDelete ? t('settings.archived.deleteConfirmAria') : t('settings.archived.deleteAria')}
                          onClick={() => { void handleDelete(session.id) }}
                        >
                          <Trash2 size={14} />
                          <span className="archived-item__button-label">{isConfirmingDelete ? t('settings.archived.confirm') : t('settings.archived.delete')}</span>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.archived.note')}</span>
      </p>
    </section>
  )
}
