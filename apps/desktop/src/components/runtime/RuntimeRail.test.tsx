// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRail } from './RuntimeRail'
import type { RuntimeRailPane } from '@/stores/uiStore'

const mocks = vi.hoisted(() => ({
  runtimeRailPane: 'picker' as RuntimeRailPane,
  setRuntimeRailPane: vi.fn(),
  runtimeRailWidth: 288,
  setRuntimeRailWidth: vi.fn(),
}))

vi.mock('./BrowserPanel', () => ({
  BrowserPanel: () => <div data-testid="browser-panel-mock" />,
}))

vi.mock('./ComputerPanel', () => ({
  ComputerPanel: () => <div data-testid="computer-panel-mock" />,
}))

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  // 每次调用重建状态，保证测试内在 beforeEach 修改的 mocks 值能被读到。
  const buildState = (): UiState => ({
    ...original.useUiStore.getState(),
    runtimeRailPane: mocks.runtimeRailPane,
    setRuntimeRailPane: mocks.setRuntimeRailPane,
    runtimeRailWidth: mocks.runtimeRailWidth,
    setRuntimeRailWidth: mocks.setRuntimeRailWidth,
  } as UiState)
  const useUiStoreMock = <T,>(selector: (state: UiState) => T): T => selector(buildState())
  // 组件事件处理器经 getState 读当前宽度（键盘/双击调宽），mock 需暴露同款接口。
  ;(useUiStoreMock as unknown as { getState: () => UiState }).getState = buildState
  return {
    ...original,
    useUiStore: useUiStoreMock,
  }
})

afterEach(() => {
  mocks.runtimeRailPane = 'picker'
  mocks.setRuntimeRailPane.mockClear()
  mocks.runtimeRailWidth = 288
  mocks.setRuntimeRailWidth.mockClear()
})

describe('RuntimeRail picker 卡片页', () => {
  it('defaults to the picker page with both pane cards and no panel mounted', () => {
    render(<RuntimeRail />)
    expect(screen.getByText('打开标签页')).toBeTruthy()
    expect(screen.getByText('选择要在侧边面板中打开的标签。')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '浏览器' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '电脑控制' })).toBeTruthy()
    // SSH 已迁出运行时面板（独立全窗口 SshView，入口在侧栏导航）。
    expect(screen.queryByRole('tab', { name: /SSH/ })).toBeNull()
    expect(screen.queryByTestId('browser-panel-mock')).toBeNull()
    expect(screen.queryByLabelText('返回标签页选择')).toBeNull()
  })

  it('opens the browser panel when its card is clicked', () => {
    render(<RuntimeRail />)
    fireEvent.click(screen.getByRole('tab', { name: '浏览器' }))
    expect(mocks.setRuntimeRailPane).toHaveBeenCalledWith('browser')
  })

  it('opens the computer panel when its card is clicked', () => {
    render(<RuntimeRail />)
    fireEvent.click(screen.getByRole('tab', { name: '电脑控制' }))
    expect(mocks.setRuntimeRailPane).toHaveBeenCalledWith('computer')
  })

  it('does not render the legacy context budget or collapse control', () => {
    render(<RuntimeRail />)
    expect(screen.queryByText('上下文预算')).toBeNull()
    expect(screen.queryByRole('button', { name: '关闭运行时面板' })).toBeNull()
  })
})

describe('RuntimeRail panel 态', () => {
  it('mounts the pane panel with a title and a back-to-picker button', () => {
    mocks.runtimeRailPane = 'browser'
    render(<RuntimeRail />)
    expect(screen.getByText('浏览器')).toBeTruthy()
    expect(screen.getByTestId('browser-panel-mock')).toBeTruthy()
    expect(screen.getByLabelText('返回标签页选择')).toBeTruthy()
  })

  it('mounts the computer panel for the computer pane', () => {
    mocks.runtimeRailPane = 'computer'
    render(<RuntimeRail />)
    expect(screen.getByText('电脑控制')).toBeTruthy()
    expect(screen.getByTestId('computer-panel-mock')).toBeTruthy()
  })

  it('goes back to the picker page when the back button is clicked', () => {
    mocks.runtimeRailPane = 'computer'
    render(<RuntimeRail />)
    fireEvent.click(screen.getByLabelText('返回标签页选择'))
    expect(mocks.setRuntimeRailPane).toHaveBeenCalledWith('picker')
  })
})

describe('RuntimeRail resizer', () => {
  it('renders the width resizer with the current width variable applied', () => {
    const { container } = render(<RuntimeRail />)
    const resizer = screen.getByRole('separator', { name: '拖拽调整面板宽度' })
    expect(resizer).toHaveAttribute('aria-orientation', 'vertical')
    expect(resizer).toHaveAttribute('aria-valuenow', '288')
    const aside = container.querySelector('aside')
    // 宽度经 --rail-current-width 变量驱动（grid 轨道与 .rail 同源），不写内联 width。
    expect(aside?.getAttribute('style')).toContain('--rail-current-width: 288px')
    expect(aside?.getAttribute('style')).not.toMatch(/(^|[;\s])width:/)
  })

  it('adjusts width via keyboard and resets on double click', () => {
    render(<RuntimeRail />)
    const resizer = screen.getByRole('separator', { name: '拖拽调整面板宽度' })
    // rail 靠右：ArrowLeft 增大宽度，ArrowRight 减小。
    fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
    expect(mocks.setRuntimeRailWidth).toHaveBeenCalledWith(304)
    fireEvent.keyDown(resizer, { key: 'ArrowRight' })
    expect(mocks.setRuntimeRailWidth).toHaveBeenCalledWith(272)
    fireEvent.doubleClick(resizer)
    expect(mocks.setRuntimeRailWidth).toHaveBeenCalledWith(288)
  })
})

describe('RuntimeRail SSR', () => {
  it('renders the picker card markup in SSR and the pane bar when a pane is set', () => {
    // SSR 形态确认：卡片列表 HTML 结构存在，但客户端交互由 jsdom 用例覆盖。
    const html = renderToStaticMarkup(<RuntimeRail />)
    expect(html).toContain('打开标签页')
    expect(html).toContain('浏览器')
    expect(html).toContain('电脑控制')
    expect(html).not.toContain('SSH')
    expect(html).toContain('role="tablist"')
    mocks.runtimeRailPane = 'browser'
    const panelHtml = renderToStaticMarkup(<RuntimeRail />)
    expect(panelHtml).toContain('rail__pane-back')
    expect(panelHtml).toContain('rail__pane-title')
  })
})
