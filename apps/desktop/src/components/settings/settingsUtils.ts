import type { ProviderProfileDraft } from '@/agent/transport/provider'
import type { ProviderSaveResult } from '@/stores/agentStateTypes'

export const shouldCloseProviderSetup = (
  setupRequired: boolean,
  result: ProviderSaveResult,
): boolean => setupRequired && result.saved && result.ready

export interface SubmitProviderSettingsOptions {
  draft: ProviderProfileDraft
  apiKey: string
  setupRequired: boolean
  save: (draft: ProviderProfileDraft, apiKey: string) => Promise<ProviderSaveResult>
  clearApiKey: () => void
  close: () => void
}

export const submitProviderSettings = async ({
  draft,
  apiKey,
  setupRequired,
  save,
  clearApiKey,
  close,
}: SubmitProviderSettingsOptions): Promise<ProviderSaveResult> => {
  const result = await save(draft, apiKey)
  if (!result.saved) return result
  clearApiKey()
  if (shouldCloseProviderSetup(setupRequired, result)) close()
  return result
}
