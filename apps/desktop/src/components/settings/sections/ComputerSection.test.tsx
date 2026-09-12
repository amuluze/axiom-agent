// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerSection } from './ComputerSection'
import {
  computerStatus,
  requestComputerAccess,
  stopComputerControl,
  unallowComputerApp,
} from '@/platform/computerSession'

const STORAGE_KEY = 'axiom.computer.config.v1'

vi.mock('@/platform/computerSession', () => ({
  computerStatus: vi.fn(async () => ({
    type: 'status',
    accessibility: false,
    screenRecording: false,
    grants: [],
    allowlist: [],
  })),
  requestComputerAccess: vi.fn(async () => ({ type: 'done' })),
  stopComputerControl: vi.fn(async () => ({ type: 'done' })),
  unallowComputerApp: vi.fn(async () => ({ type: 'done' })),
}))

const mockStatus = vi.mocked(computerStatus)
const mockRequestAccess = vi.mocked(requestComputerAccess)
const mockStop = vi.mocked(stopComputerControl)
const mockUnallow = vi.mocked(unallowComputerApp)

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
  // clearAllMocks 不清除 mockResolvedValue：每用例前显式恢复默认状态。
  mockStatus.mockResolvedValue({
    type: 'status',
    accessibility: false,
    screenRecording: false,
    grants: [],
    allowlist: [],
  })
})

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
  vi.clearAllMocks()
})

describe('ComputerSection', () => {
  it('默认关闭，开关切换进入 draft（未保存前不落盘）', async () => {
    render(<ComputerSection />)
    const toggle = await screen.findByRole('checkbox', { name: '启用电脑控制能力' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"enabled":true}')
    })
  })

  it('展示权限状态并提供去授权入口', async () => {
    render(<ComputerSection />)
    expect(await screen.findByText('辅助功能（必需：读取界面 / 注入输入）')).toBeTruthy()
    expect(screen.getByText('屏幕录制（截图需要）')).toBeTruthy()
    expect(screen.getAllByText('未授权').length).toBeGreaterThanOrEqual(2)

    // 两项权限都未授权时有两个入口；第一个是辅助功能。
    const buttons = screen.getAllByRole('button', { name: '去授权' })
    expect(buttons.length).toBe(2)
    fireEvent.click(buttons[0] as HTMLButtonElement)
    await waitFor(() => {
      expect(mockRequestAccess).toHaveBeenCalledWith('accessibility')
    })
  })

  it('已授权时不显示去授权按钮', async () => {
    mockStatus.mockResolvedValue({
      type: 'status',
      accessibility: true,
      screenRecording: true,
      grants: [],
      allowlist: [],
    })
    render(<ComputerSection />)
    expect(await screen.findAllByText('已授权')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '去授权' })).toBeNull()
  })

  it('展示 allowlist 并可移除；展示会话授权与停止控制', async () => {
    mockStatus.mockResolvedValue({
      type: 'status',
      accessibility: true,
      screenRecording: true,
      grants: [{ sessionId: 's1', pid: 42, appName: '备忘录' }],
      allowlist: [{ bundleId: 'com.apple.Finder', name: '访达' }],
    })
    render(<ComputerSection />)
    expect(await screen.findByText('始终允许控制的应用')).toBeTruthy()
    expect(screen.getByText('访达')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '移除 访达 的始终允许' }))
    await waitFor(() => {
      expect(mockUnallow).toHaveBeenCalledWith('com.apple.Finder')
    })

    expect(screen.getByText(/备忘录（pid 42）/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止控制（撤销会话授权）' }))
    await waitFor(() => {
      expect(mockStop).toHaveBeenCalledTimes(1)
    })
  })

  it('无会话授权时停止控制禁用', async () => {
    render(<ComputerSection />)
    await screen.findByText('辅助功能（必需：读取界面 / 注入输入）')
    expect(screen.getByRole('button', { name: '停止控制（撤销会话授权）' })).toBeDisabled()
  })
})
