import {
  BUILTIN_PROVIDER_RUNTIME,
  createProviderProbeRequest,
  normalizeProviderConfig,
  providerRequiresApiKey,
  resolveProviderModel,
  secretIdForProvider,
  secretIdForProviderConfig,
  type ProviderProfile,
  type ProviderProfileDraft,
} from '@/agent/transport/provider'
import { normalizeContextPolicySettings } from '@/agent/context/types'
import {
  normalizeReasoningSettings,
  toModelReasoning,
} from '@/agent/runtime/reasoningSettings'
import { localizedProviderLabel } from '@/i18n/providerLabels'
import { storeT } from '@/i18n/storeTranslate'
import { activeReasoningSettings, persistLocalSettings } from './settingsPersistence'
import {
  CONTEXT_POLICY_STORAGE_KEY,
  persistProviderState,
  REASONING_STORAGE_KEY,
} from './services/providerStorage'
import { probeModelHttp } from '@/platform/modelHttp'
import { isTauriRuntime } from '@/platform/environment'
import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import type { SessionSnapshot } from '@/persistence/types'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from './sessionActions'
import type { ProviderSaveResult } from './agentStateTypes'
import {
  validateProviderNumericDraft,
  type ProviderNumericField,
} from '@/agent/transport/providerDraftValidation'

/** 数值字段 → 设置界面同款标签键：报错文案复用 UI 措辞，避免两处漂移。 */
const PROVIDER_NUMERIC_FIELD_LABEL_KEYS: Record<ProviderNumericField, string> = {
  timeoutMs: 'settings.provider.timeout',
  maxOutputTokens: 'settings.provider.maxOutputTokens',
  contextWindow: 'settings.provider.contextWindow',
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const saveProvider = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  draft: ProviderProfileDraft,
  apiKey?: string,
): Promise<ProviderSaveResult> => {
  if (get().running) {
    set({ settingsError: storeT('status.provider.saveBlockedRunning') })
    return { saved: false }
  }
  if (!isTauriRuntime() && draft.providerId !== 'demo') {
    set({ settingsError: storeT('status.provider.needsDesktop') })
    return { saved: false }
  }
  if (draft.providerId === 'demo' && !RUNTIME_POLICY.allowDemoProvider) {
    set({ settingsError: storeT('status.provider.demoDisabled') })
    return { saved: false }
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) {
    set({ settingsError: storeT('status.provider.saveStructuralBusy') })
    return { saved: false }
  }
  set({ providerSaving: true, providerMessage: null, settingsError: null })
  let stagedSecretId: string | undefined
  let stagedProviderProfile: ProviderProfile | undefined
  let supersededSecretId: string | undefined
  let durableCommitted = false
  try {
    // Rust 侧 bounded_integer 对越界值静默 clamp、对 null 回落默认值；UI 的 min/max 只是
    // HTML 属性（不在 form 内不触发原生校验）。不在此显式拒绝，用户会看到「配置已保存」
    // 而实际生效的是被裁剪后的值——即「最大输出 token 改了却不报错」。
    const numericViolation = validateProviderNumericDraft(draft)
    if (numericViolation) {
      throw new Error(storeT('status.provider.numericOutOfRange', {
        field: storeT(PROVIDER_NUMERIC_FIELD_LABEL_KEYS[numericViolation.field]),
        min: String(numericViolation.min),
        max: String(numericViolation.max),
      }))
    }
    const previousConfig = get().provider
    let config = await normalizeProviderConfig(draft)
    if (!get().providerProfiles.some((profile) => profile.profileId === config.profileId)
      && get().providerProfiles.length >= 32) {
      throw new Error(storeT('status.provider.profileLimit'))
    }
    if (config.providerId !== 'demo'
      && previousConfig.providerId === config.providerId
      && !config.secretId
      && previousConfig.secretId) {
      config = await normalizeProviderConfig({ ...config, secretId: previousConfig.secretId })
    }
    const activeSessionId = get().activeSessionId
    if (!activeSessionId) throw new Error(storeT('status.session.noActive'))
    await deps.getRepository().loadSession(activeSessionId)
    let configuredKey = false
    if (config.providerId !== 'demo') {
      if (apiKey?.trim()) {
        stagedSecretId = `${secretIdForProvider(config.providerId)}.${crypto.randomUUID()}`
        supersededSecretId = previousConfig.providerId === 'demo'
          ? undefined
          : await secretIdForProviderConfig(previousConfig)
        config = await normalizeProviderConfig({ ...config, secretId: stagedSecretId })
        stagedProviderProfile = config
        await BUILTIN_PROVIDER_RUNTIME.credentials.save(config, apiKey)
      }
      configuredKey = (await BUILTIN_PROVIDER_RUNTIME.credentials.status(config)).configured
    }
    const nextContextPolicySettings = normalizeContextPolicySettings(
      get().contextPolicySettings,
      config.contextWindow,
      config.maxOutputTokens,
    )
    const nextReasoningSettings = normalizeReasoningSettings(
      activeReasoningSettings,
      config.apiFormat,
      config.maxOutputTokens,
    )
    const nextModel = resolveProviderModel(config)
    await deps.getRepository().updateSessionModel(activeSessionId, {
      ...deps.sessionDefaults(config),
      reasoning: toModelReasoning(nextReasoningSettings, nextModel) ?? null,
    })
    durableCommitted = true
    let reboundSnapshot: SessionSnapshot
    try {
      reboundSnapshot = await deps.getRepository().loadSession(activeSessionId)
    } catch (error) {
      set({
        settingsError: storeT('status.provider.saveProjectionFailed', { detail: errorMessage(error) }),
      })
      return { saved: true, ready: false }
    }
    const projection = await deps.activateCommittedSessionSnapshot({
      repository: deps.getRepository(),
      snapshot: reboundSnapshot,
      config,
      configuredKey,
      persistProvider: true,
      fallbackSessions: deps.projectedSessions(reboundSnapshot),
      state: {
        providerMessage: storeT('status.provider.saved', {
          label: localizedProviderLabel(storeT, config.providerId),
        }),
      },
    })
    if (projection.status === 'projection_failed') {
      set({
        settingsError: storeT('status.provider.saveProjectionFailed', { detail: projection.error }),
      })
      return { saved: true, ready: false }
    }
    let supersededSecretStillReferenced = false
    if (supersededSecretId) {
      for (const profile of get().providerProfiles) {
        if (profile.profileId !== config.profileId
          && profile.providerId !== 'demo'
          && (await secretIdForProviderConfig(profile)) === supersededSecretId) {
          supersededSecretStillReferenced = true
          break
        }
      }
      if (!supersededSecretStillReferenced) {
        for (const stored of get().sessions) {
          if (stored.id !== activeSessionId
            && stored.providerConfig?.providerId !== 'demo'
            && stored.providerConfig !== null
            && (await secretIdForProviderConfig(stored.providerConfig)) === supersededSecretId) {
            supersededSecretStillReferenced = true
            break
          }
        }
      }
    }
    if (supersededSecretId
      && supersededSecretId !== stagedSecretId
      && !supersededSecretStillReferenced) {
      try {
        await BUILTIN_PROVIDER_RUNTIME.credentials.delete(previousConfig)
      } catch (error) {
        set({ settingsError: storeT('status.provider.oldKeyCleanupFailed', { detail: errorMessage(error) }) })
      }
    }
    const policyPersistError = persistLocalSettings(CONTEXT_POLICY_STORAGE_KEY, nextContextPolicySettings)
    const reasoningPersistError = persistLocalSettings(REASONING_STORAGE_KEY, nextReasoningSettings)
    if (policyPersistError || reasoningPersistError) {
      set({ settingsError: storeT('status.provider.localProjectionFailed', { detail: policyPersistError ?? reasoningPersistError ?? '' }) })
    }
    return {
      saved: true,
      ready: !providerRequiresApiKey(config.providerId) || configuredKey,
    }
  } catch (error) {
    let cleanupWarning = ''
    if (stagedProviderProfile && !durableCommitted) {
      try {
        await BUILTIN_PROVIDER_RUNTIME.credentials.delete(stagedProviderProfile)
      } catch (cleanupError) {
        // 清理暂存凭据失败必须可见：否则未提交的 API Key 会残留密钥库
        // 且用户只看到主错误，无从得知凭据需要手动清理。
        cleanupWarning = storeT('status.provider.stagedKeyCleanupSuffix', { detail: errorMessage(cleanupError) })
      }
    }
    set({ settingsError: `${errorMessage(error)}${cleanupWarning}` })
    return { saved: false }
  } finally {
    set({ providerSaving: false })
    deps.endStructural(structuralLease)
  }
}

export const switchProviderProfile = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  profileId: string,
): Promise<boolean> => {
  const state = get()
  if (state.provider.profileId === profileId) return true
  if (state.running) {
    set({ settingsError: storeT('status.provider.switchBlockedRunning') })
    return false
  }
  const config = state.providerProfiles.find((profile) => profile.profileId === profileId)
  if (!config) {
    set({ settingsError: storeT('status.provider.profileMissing') })
    return false
  }
  if (!isTauriRuntime() && config.providerId !== 'demo') {
    set({ settingsError: storeT('status.provider.needsDesktop') })
    return false
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) {
    set({ settingsError: storeT('status.provider.switchStructuralBusy') })
    return false
  }
  set({ providerSaving: true, providerMessage: null, settingsError: null })
  try {
    const activeSessionId = get().activeSessionId
    if (!activeSessionId) throw new Error(storeT('status.session.noActive'))
    const configuredKey = config.providerId === 'demo'
      ? false
      : (await BUILTIN_PROVIDER_RUNTIME.credentials.status(config)).configured
    const nextReasoningSettings = normalizeReasoningSettings(
      activeReasoningSettings,
      config.apiFormat,
      config.maxOutputTokens,
    )
    const nextModel = resolveProviderModel(config)
    await deps.getRepository().updateSessionModel(activeSessionId, {
      ...deps.sessionDefaults(config),
      reasoning: toModelReasoning(nextReasoningSettings, nextModel) ?? null,
    })
    const reboundSnapshot = await deps.getRepository().loadSession(activeSessionId)
    const projection = await deps.activateCommittedSessionSnapshot({
      repository: deps.getRepository(),
      snapshot: reboundSnapshot,
      config,
      configuredKey,
      persistProvider: true,
      fallbackSessions: deps.projectedSessions(reboundSnapshot),
      state: {
        providerMessage: storeT('status.provider.switched', {
          label: localizedProviderLabel(storeT, config.providerId),
          model: config.modelId,
        }),
      },
    })
    if (projection.status === 'projection_failed') {
      set({ settingsError: storeT('status.provider.switchProjectionFailed', { detail: projection.error }) })
      return false
    }
    const reasoningPersistError = persistLocalSettings(REASONING_STORAGE_KEY, nextReasoningSettings)
    if (reasoningPersistError) {
      set({ settingsError: reasoningPersistError })
      return false
    }
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    set({ providerSaving: false })
    deps.endStructural(structuralLease)
  }
}

export const deleteProviderProfile = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  profileId: string,
): Promise<boolean> => {
  const state = get()
  const target = state.providerProfiles.find((profile) => profile.profileId === profileId)
  if (!target) return false
  if (state.providerProfiles.length <= 1) {
    set({ settingsError: storeT('status.provider.lastProfile') })
    return false
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) {
    set({ settingsError: storeT('status.provider.deleteStructuralBusy') })
    return false
  }
  set({ providerSaving: true, providerMessage: null, settingsError: null })
  try {
    const nextProfiles = state.providerProfiles.filter((profile) => profile.profileId !== profileId)
    let active = get().provider
    if (active.profileId === profileId) {
      active = nextProfiles[0]!
      const activeSessionId = get().activeSessionId
      if (!activeSessionId) throw new Error(storeT('status.session.noActive'))
      const configuredKey = active.providerId === 'demo'
        ? false
        : (await BUILTIN_PROVIDER_RUNTIME.credentials.status(active)).configured
      const nextReasoningSettings = normalizeReasoningSettings(
        activeReasoningSettings,
        active.apiFormat,
        active.maxOutputTokens,
      )
      const nextModel = resolveProviderModel(active)
      await deps.getRepository().updateSessionModel(activeSessionId, {
        ...deps.sessionDefaults(active),
        reasoning: toModelReasoning(nextReasoningSettings, nextModel) ?? null,
      })
      const reboundSnapshot = await deps.getRepository().loadSession(activeSessionId)
      const projection = await deps.activateCommittedSessionSnapshot({
        repository: deps.getRepository(),
        snapshot: reboundSnapshot,
        config: active,
        configuredKey,
        fallbackSessions: deps.projectedSessions(reboundSnapshot),
        state: {},
      })
      if (projection.status === 'projection_failed') {
        set({ settingsError: storeT('status.provider.deleteProjectionFailed', { detail: projection.error }) })
        return false
      }
    }
    persistProviderState(nextProfiles, active)
    set({
      providerProfiles: nextProfiles,
      providerMessage: storeT('status.provider.deleted', {
        label: localizedProviderLabel(storeT, target.providerId),
        model: target.modelId,
      }),
    })
    if (target.providerId !== 'demo') {
      const targetSecretId = await secretIdForProviderConfig(target)
      let stillReferenced = false
      for (const profile of nextProfiles) {
        if (profile.providerId !== 'demo'
          && (await secretIdForProviderConfig(profile)) === targetSecretId) {
          stillReferenced = true
          break
        }
      }
      if (!stillReferenced) {
        for (const stored of get().sessions) {
          if (stored.providerConfig?.providerId !== 'demo'
            && stored.providerConfig !== null
            && (await secretIdForProviderConfig(stored.providerConfig)) === targetSecretId) {
            stillReferenced = true
            break
          }
        }
      }
      if (!stillReferenced) {
        await BUILTIN_PROVIDER_RUNTIME.credentials.delete(target).catch((error) => {
          set({ settingsError: storeT('status.provider.secretCleanupFailed', { detail: errorMessage(error) }) })
        })
      }
    }
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    set({ providerSaving: false })
    deps.endStructural(structuralLease)
  }
}

export const testProvider = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<boolean> => {
  const { provider, providerHasKey, running, runtimeLifecycle } = get()
  if (runtimeLifecycle !== 'ready') return false
  if (running) {
    set({ settingsError: storeT('status.provider.testBlockedRunning') })
    return false
  }
  if (provider.providerId === 'demo') {
    set({ providerMessage: storeT('status.provider.demoReady'), settingsError: null })
    return true
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ providerTesting: true, providerMessage: null, settingsError: null })
  try {
    // 端点校验已下沉到 Rust 侧 provider_profiles::resolve_profile（probe 时强校验），
    // 不再需要前端预先登记 origin。
    const result = await probeModelHttp(createProviderProbeRequest(provider, providerHasKey))
    if (!result.ok) throw new Error(result.message)
    // Rust 探针的成功 message 是中文常量（「连接成功」），改由 TS 按界面语言组装。
    set({ providerMessage: storeT('status.provider.testOk', { status: result.status ?? 'unknown' }) })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    set({ providerTesting: false })
    deps.endStructural(structuralLease)
  }
}

export const deleteProviderKey = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<boolean> => {
  const { provider, running } = get()
  if (running || provider.providerId === 'demo') return false
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ providerSaving: true, providerMessage: null, settingsError: null })
  let deleted = false
  try {
    const activeSessionId = get().activeSessionId
    if (!activeSessionId) throw new Error(storeT('status.session.noActive'))
    const reboundSnapshot = await deps.getRepository().loadSession(activeSessionId)
    await BUILTIN_PROVIDER_RUNTIME.credentials.delete(provider)
    deleted = true
    set({ providerHasKey: false })
    const projection = await deps.activateCommittedSessionSnapshot({
      repository: deps.getRepository(),
      snapshot: reboundSnapshot,
      config: provider,
      configuredKey: false,
      fallbackSessions: deps.projectedSessions(reboundSnapshot),
      state: {
        providerSetupRequired: providerRequiresApiKey(provider.providerId),
        providerMessage: storeT('status.provider.keyDeleted'),
      },
    })
    if (projection.status === 'projection_failed') {
      set({
        providerHasKey: false,
        settingsError: storeT('status.provider.keyDeleteProjectionFailed', { detail: projection.error }),
      })
    }
    return true
  } catch (error) {
    set({
      ...(deleted ? { providerHasKey: false } : {}),
      settingsError: deleted
        ? storeT('status.provider.keyDeleteProjectionFailed', { detail: errorMessage(error) })
        : errorMessage(error),
    })
    return deleted
  } finally {
    set({ providerSaving: false })
    deps.endStructural(structuralLease)
  }
}
