// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningPicker } from './ReasoningPicker'

const mocks = vi.hoisted(() => ({
  provider: {
    profileId: 'builtin.deepseek',
    providerId: 'deepseek',
    apiFormat: 'openai-compatible',
    endpoint: 'https://api.deepseek.com/chat/completions',
    modelId: 'deepseek-flash',
    schemaVersion: 4,
    secretId: 'provider.deepseek.api-key',
  },
  reasoningSettings: { level: 'off', mode: 'effort', budgetTokens: 4096 },
  saveReasoningSettings: vi.fn(async () => true),
  providerSetupRequired: false,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  const mockedState = (): StoreState => ({
    ...original.useAgentStore.getState(),
    provider: mocks.provider as StoreState['provider'],
    reasoningSettings: mocks.reasoningSettings as StoreState['reasoningSettings'],
    saveReasoningSettings: mocks.saveReasoningSettings,
    providerSetupRequired: mocks.providerSetupRequired,
  } as StoreState)
  const mockedUseAgentStore = Object.assign(
    <T,>(selector: (state: StoreState) => T): T => selector(mockedState()),
    { getState: mockedState },
  )
  return {
    ...original,
    useAgentStore: mockedUseAgentStore,
  }
})

const renderPicker = () => render(<ReasoningPicker />)

/** 目录外自定义模型（能力未知 → 视为支持）：粘贴级默认基底。 */
const defaultProvider = () => ({
  profileId: 'builtin.deepseek',
  providerId: 'deepseek',
  apiFormat: 'openai-compatible',
  endpoint: 'https://api.deepseek.com/chat/completions',
  modelId: 'deepseek-flash',
  schemaVersion: 4,
  secretId: 'provider.deepseek.api-key',
})

describe('ReasoningPicker', () => {
  beforeEach(() => {
    mocks.saveReasoningSettings = vi.fn(async () => true)
    mocks.providerSetupRequired = false
    mocks.reasoningSettings = { level: 'off', mode: 'effort', budgetTokens: 4096 }
    mocks.provider = defaultProvider()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('hides entirely for the demo provider', () => {
    mocks.provider = { ...mocks.provider, providerId: 'demo', apiFormat: 'demo', endpoint: '' }
    const { container } = renderPicker()
    expect(container).toBeEmptyDOMElement()
  })

  it('hides when the active model does not declare reasoning support', () => {
    // 目录内声明不支持的模型（mistral 无推理）
    mocks.provider = {
      ...mocks.provider,
      providerId: 'ollama',
      apiFormat: 'openai-compatible',
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
      modelId: 'mistral',
    }
    const { container } = renderPicker()
    expect(container).toBeEmptyDOMElement()
  })

  it('opens the level menu and saves the selected effort level', async () => {
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: '推理强度' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitemradio', { name: '高' }))
    await waitFor(() => expect(mocks.saveReasoningSettings).toHaveBeenCalledTimes(1))
    expect(mocks.saveReasoningSettings).toHaveBeenCalledWith({
      level: 'high',
      mode: 'effort',
      budgetTokens: 4096,
    })
    // 保存成功后菜单收起
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('keeps the menu open and shows the failure reason when the save is rejected', async () => {
    mocks.saveReasoningSettings = vi.fn(async () => false)
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: '推理强度' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '高' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('shows reasoning modes only for anthropic-compatible providers with a non-off level', async () => {
    mocks.provider = {
      ...mocks.provider,
      providerId: 'generic-anthropic-compatible',
      apiFormat: 'anthropic-compatible',
      endpoint: 'https://api.anthropic.com/v1/messages',
      secretId: 'provider.generic-anthropic-compatible.api-key',
    }
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: '推理强度' }))

    // 强度关闭时无模式组
    expect(screen.queryByText('推理模式')).not.toBeInTheDocument()

    // 选「高」后保存并立即出现模式组（store 状态由 mock 响应）
    fireEvent.click(screen.getByRole('menuitemradio', { name: '高' }))
    await waitFor(() => expect(mocks.saveReasoningSettings).toHaveBeenCalled())
    mocks.reasoningSettings = { level: 'high', mode: 'effort', budgetTokens: 4096 }
    // 重新打开菜单（上一轮保存成功已收起）
    fireEvent.click(screen.getByRole('button', { name: '推理强度' }))
    expect(screen.getByText('推理模式')).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: '自适应' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: 'Token 预算' })).toBeInTheDocument()
  })
})
