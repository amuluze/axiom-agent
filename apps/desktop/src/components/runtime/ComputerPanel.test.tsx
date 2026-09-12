// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerPanel } from './ComputerPanel'

const mocks = vi.hoisted(() => ({
  settingsEnabled: true,
  computerStatus: vi.fn(),
  requestComputerAccess: vi.fn(),
  stopComputerControl: vi.fn(),
  unallowComputerApp: vi.fn(),
  setSettingsSection: vi.fn(),
  setView: vi.fn(),
}))

vi.mock('@/platform/computerSession', () => ({
  computerStatus: mocks.computerStatus,
  requestComputerAccess: mocks.requestComputerAccess,
  stopComputerControl: mocks.stopComputerControl,
  unallowComputerApp: mocks.unallowComputerApp,
}))

vi.mock('@/config/computerSettings', () => ({
  getComputerSettings: () => ({ enabled: mocks.settingsEnabled }),
}))

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      setSettingsSection: mocks.setSettingsSection,
      setView: mocks.setView,
    } as UiState),
  }
})

beforeEach(() => {
  mocks.settingsEnabled = true
  mocks.computerStatus.mockReset()
  mocks.requestComputerAccess.mockReset()
  mocks.stopComputerControl.mockReset()
  mocks.unallowComputerApp.mockReset()
  mocks.setSettingsSection.mockReset()
  mocks.setView.mockReset()
  mocks.computerStatus.mockResolvedValue({
    type: 'status',
    accessibility: true,
    screenRecording: false,
    grants: [],
    allowlist: [],
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ComputerPanel', () => {
  it('renders permissions with grant entry only when denied', async () => {
    render(<ComputerPanel />)
    expect(await screen.findByText('辅助功能')).toBeTruthy()
    expect(screen.getByText('已授权')).toBeTruthy()
    expect(screen.getByText('屏幕录制')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '去授权' }).length).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '去授权' }))
    await waitFor(() => {
      expect(mocks.requestComputerAccess).toHaveBeenCalledWith('screenRecording')
    })
  })

  it('shows empty-state guidance when no grants or allowlist entries exist', async () => {
    render(<ComputerPanel />)
    expect(await screen.findByText('当前没有会话控制授权。Agent 首次控制某个应用时会弹出原生确认。')).toBeTruthy()
    expect(screen.getByText('名单为空。确认框里选「始终允许」或去设置页添加。')).toBeTruthy()
  })

  it('lists grants with the kill switch and forwards stop', async () => {
    mocks.computerStatus.mockResolvedValue({
      type: 'status',
      accessibility: true,
      screenRecording: true,
      grants: [
        { sessionId: 's1', pid: 42, appName: '备忘录' },
        { sessionId: 's2', pid: 43, appName: '访达' },
      ],
      allowlist: [],
    })
    render(<ComputerPanel />)
    expect(await screen.findByText('备忘录')).toBeTruthy()
    expect(screen.getByText('pid 42')).toBeTruthy()
    expect(screen.getByText(/控制中 · 备忘录、访达/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '停止控制（撤销全部会话授权）' }))
    await waitFor(() => {
      expect(mocks.stopComputerControl).toHaveBeenCalledTimes(1)
    })
  })

  it('manages the allowlist with removal', async () => {
    mocks.computerStatus.mockResolvedValue({
      type: 'status',
      accessibility: true,
      screenRecording: true,
      grants: [],
      allowlist: [{ bundleId: 'com.apple.Finder', name: '访达' }],
    })
    render(<ComputerPanel />)
    expect(await screen.findByText('访达')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除 访达 的始终允许' }))
    await waitFor(() => {
      expect(mocks.unallowComputerApp).toHaveBeenCalledWith('com.apple.Finder')
    })
  })

  it('routes to settings when the capability is disabled', async () => {
    mocks.settingsEnabled = false
    render(<ComputerPanel />)
    expect(await screen.findByText('电脑控制未启用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    expect(mocks.setSettingsSection).toHaveBeenCalledWith('computer')
    expect(mocks.setView).toHaveBeenCalledWith('settings')
  })

  it('surfaces status errors inline without breaking the panel', async () => {
    mocks.computerStatus.mockRejectedValue('computer channel unavailable')
    render(<ComputerPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('computer channel unavailable')
  })
})
