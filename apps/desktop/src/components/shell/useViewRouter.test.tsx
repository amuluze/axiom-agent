// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useViewRouter } from './useViewRouter'

const mocks = vi.hoisted(() => ({
  providerSetupRequired: false,
  messagesCount: 0,
  view: 'new-task',
  settingsSection: 'general',
  pendingApproval: null,
  summaryRequest: null,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      initialize: async () => {},
      providerSetupRequired: mocks.providerSetupRequired,
      messages: Array.from({ length: mocks.messagesCount }, (_, index) => ({
        id: `m-${index}`,
        createdAt: index,
        role: 'user',
        content: 'x',
      })),
      pendingApproval: mocks.pendingApproval,
      summaryRequest: mocks.summaryRequest,
      running: false,
      sessionBusy: false,
      providerReady: true,
      createNewSession: async () => null,
      addWorkspace: async () => null,
      authorizedWorkspace: null,
      continueConversation: async () => {},
    } as unknown as StoreState),
  }
})

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      view: mocks.view,
      settingsSection: mocks.settingsSection,
      setView: (view: typeof mocks.view) => { mocks.view = view },
      setSettingsSection: (section: typeof mocks.settingsSection) => { mocks.settingsSection = section },
    } as UiState),
  }
})

const Harness = () => {
  useViewRouter()
  return null
}

describe('useViewRouter', () => {
  it('provider 就绪时打开设置保持用户选择的非 models 分区，不强制跳转', () => {
    mocks.providerSetupRequired = false
    mocks.view = 'settings'
    mocks.settingsSection = 'usage'
    render(<Harness />)
    expect(mocks.settingsSection).toBe('usage')
  })

  it('provider 就绪时从 ⌘, 打开的 general 分区不被覆盖', () => {
    mocks.providerSetupRequired = false
    mocks.view = 'settings'
    mocks.settingsSection = 'general'
    render(<Harness />)
    expect(mocks.settingsSection).toBe('general')
  })

  it('providerSetupRequired 为 true 时仍强制模型分区', () => {
    mocks.providerSetupRequired = true
    mocks.view = 'settings'
    mocks.settingsSection = 'general'
    render(<Harness />)
    expect(mocks.settingsSection).toBe('models')
  })

  it('providerSetupRequired 为 true 时自动进入设置视图', () => {
    mocks.providerSetupRequired = true
    mocks.view = 'new-task'
    mocks.settingsSection = 'general'
    render(<Harness />)
    expect(mocks.view).toBe('settings')
    expect(mocks.settingsSection).toBe('models')
  })
})
