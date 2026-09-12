// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowActions } from './WindowActions'

const mocks = vi.hoisted(() => ({
  // 组件侧按 Promise 消费（void openExternalUrl(...).catch(...)），mock 需返回 resolved promise。
  openExternalUrl: vi.fn(async () => {}),
  toggleTerminalPanel: vi.fn(),
  toggleRuntimeRail: vi.fn(),
}))

vi.mock('@/platform/webAccess', () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T =>
      selector({
        ...original.useUiStore.getState(),
        toggleTerminalPanel: mocks.toggleTerminalPanel,
        toggleRuntimeRail: mocks.toggleRuntimeRail,
      } as UiState),
  }
})

afterEach(() => {
  mocks.openExternalUrl.mockReset()
  mocks.toggleTerminalPanel.mockClear()
  mocks.toggleRuntimeRail.mockClear()
})

const openHelpMenu = async (): Promise<void> => {
  await userEvent.setup().click(screen.getByRole('button', { name: '帮助' }))
}

describe('WindowActions 帮助菜单 (RTL)', () => {
  it('点击帮助按钮展开菜单，包含文档/需求/问题三项', async () => {
    render(<WindowActions />)
    expect(screen.queryByRole('menu', { name: '帮助菜单' })).not.toBeInTheDocument()
    await openHelpMenu()
    expect(screen.getByRole('button', { name: '帮助' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: '文档' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '需求' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '问题' })).toBeInTheDocument()
  })

  it('需求与问题菜单项置灰不可点，文档项可点', async () => {
    render(<WindowActions />)
    await openHelpMenu()
    expect(screen.getByRole('menuitem', { name: '文档' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: '需求' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '问题' })).toBeDisabled()
  })

  it('点击文档经系统浏览器打开官网文档页并收起菜单', async () => {
    const user = userEvent.setup()
    render(<WindowActions />)
    await openHelpMenu()
    await user.click(screen.getByRole('menuitem', { name: '文档' }))
    expect(mocks.openExternalUrl).toHaveBeenCalledTimes(1)
    expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://axiom.amuluze.com/#/docs')
    expect(screen.queryByRole('menu', { name: '帮助菜单' })).not.toBeInTheDocument()
  })

  it('再次点击帮助按钮收起菜单', async () => {
    const user = userEvent.setup()
    render(<WindowActions />)
    await openHelpMenu()
    await user.click(screen.getByRole('button', { name: '帮助' }))
    expect(screen.queryByRole('menu', { name: '帮助菜单' })).not.toBeInTheDocument()
  })

  it('按 Escape 收起菜单', async () => {
    const user = userEvent.setup()
    render(<WindowActions />)
    await openHelpMenu()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: '帮助菜单' })).not.toBeInTheDocument()
  })

  it('点击菜单外部收起菜单', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <WindowActions />
        <button type="button">菜单外落点</button>
      </div>,
    )
    await openHelpMenu()
    await user.click(screen.getByRole('button', { name: '菜单外落点' }))
    expect(screen.queryByRole('menu', { name: '帮助菜单' })).not.toBeInTheDocument()
  })
})
