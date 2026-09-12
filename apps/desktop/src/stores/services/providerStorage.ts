import {
  decodeProviderProfile,
  resolveInitialProviderSelection,
  type InitialProviderSelection,
  type ProviderProfile,
} from '@/agent/transport/provider'
import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import { isTauriRuntime } from '@/platform/environment'

export const PROVIDER_STORAGE_KEY = 'axiom.provider.config.v1'
export const PROVIDER_PROFILES_STORAGE_KEY = 'axiom.provider.profiles.v1'
export const CONTEXT_POLICY_STORAGE_KEY = 'axiom.context.policy.v1'
export const QUEUE_MODE_STORAGE_KEY = 'axiom.queue.mode.v1'
export const REASONING_STORAGE_KEY = 'axiom.reasoning.v1'
export const AGENT_LIMITS_STORAGE_KEY = 'axiom.agent.limits.v1'

export const loadProviderSelection = (): Promise<InitialProviderSelection> => resolveInitialProviderSelection(
  isTauriRuntime() ? localStorage.getItem(PROVIDER_STORAGE_KEY) : null,
  RUNTIME_POLICY.allowDemoProvider,
)

export const persistProviderConfig = (config: ProviderProfile): void => {
  if (isTauriRuntime()) localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(config))
}

export const mergeProviderProfile = (
  profiles: readonly ProviderProfile[],
  profile: ProviderProfile,
): ProviderProfile[] => {
  const next = profiles.map((candidate) => candidate.profileId === profile.profileId
    ? structuredClone(profile)
    : structuredClone(candidate))
  if (!next.some((candidate) => candidate.profileId === profile.profileId)) {
    next.push(structuredClone(profile))
  }
  return next.slice(-32)
}

export const loadProviderProfiles = async (
  active: ProviderProfile,
  includeActiveFallback: boolean,
): Promise<ProviderProfile[]> => {
  const fallback = includeActiveFallback ? [structuredClone(active)] : []
  if (!isTauriRuntime()) return fallback
  const raw = localStorage.getItem(PROVIDER_PROFILES_STORAGE_KEY)
  if (!raw) return fallback
  try {
    const decoded = JSON.parse(raw) as {
      schemaVersion?: unknown
      profiles?: unknown
    }
    if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.profiles)) {
      return fallback
    }
    const seen = new Set<string>()
    const profiles = (await Promise.all(
      decoded.profiles
        .slice(0, 32)
        .map((value) => decodeProviderProfile(value)),
    )).filter((profile) => {
      if ((!RUNTIME_POLICY.allowDemoProvider && profile.providerId === 'demo')
        || seen.has(profile.profileId)) return false
      seen.add(profile.profileId)
      return true
    })
    return includeActiveFallback ? mergeProviderProfile(profiles, active) : profiles
  } catch {
    return fallback
  }
}

export const persistProviderState = (
  profiles: readonly ProviderProfile[],
  active: ProviderProfile,
): void => {
  if (!isTauriRuntime()) return
  persistProviderConfig(active)
  localStorage.setItem(PROVIDER_PROFILES_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    activeProfileId: active.profileId,
    profiles,
  }))
}
