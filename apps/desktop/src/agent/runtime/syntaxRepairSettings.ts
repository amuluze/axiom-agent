export interface SyntaxRepairSettings {
  profileId: string | null
}

export const DEFAULT_SYNTAX_REPAIR_SETTINGS: SyntaxRepairSettings = {
  profileId: null,
}

export const resolveSyntaxRepairSettings = (raw: string | null): SyntaxRepairSettings => {
  if (!raw) return { ...DEFAULT_SYNTAX_REPAIR_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as { profileId?: unknown }
    return {
      profileId: typeof parsed.profileId === 'string' && parsed.profileId.trim()
        ? parsed.profileId.trim()
        : null,
    }
  } catch {
    return { ...DEFAULT_SYNTAX_REPAIR_SETTINGS }
  }
}
