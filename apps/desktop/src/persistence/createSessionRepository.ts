import { isTauriRuntime } from '@/platform/environment'
import { MemorySessionRepository } from './MemorySessionRepository'
import { SqliteSessionRepository } from './SqliteSessionRepository'
import type { SessionRepository } from './types'

export const createSessionRepository = async (): Promise<SessionRepository> => {
  if (!isTauriRuntime()) return new MemorySessionRepository()
  return SqliteSessionRepository.open()
}
