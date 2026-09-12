import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// xterm 的样式表在 node 环境下无法真实加载；终端运行时只允许在 effect 中被调用
// （SSR 不执行 effect），这里用 mock 记录调用以断言渲染期不触碰终端。
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('./terminalRuntime', () => ({
  attachTerminal: vi.fn(),
  detachTerminal: vi.fn(),
  disposeTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  restartTerminal: vi.fn(),
  syncTerminalFont: vi.fn(),
}))

const { WorkspaceTerminalPanel } = await import('./WorkspaceTerminalPanel')

/**
 * 面板本身只负责「把激活工作区的容器挂入视口」；无激活工作区（默认态）时渲染空态
 * 且不启动任何终端（Task Spec 验收 7）。xterm 与 PTY 的深层行为由 terminalRuntime
 * 与 platform/terminal 的测试覆盖。
 */
describe('WorkspaceTerminalPanel', () => {
  it('renders header, resizer and the empty state without an active workspace', () => {
    const markup = renderToStaticMarkup(<WorkspaceTerminalPanel />)

    expect(markup).toContain('aria-label="终端面板"')
    expect(markup).toContain('role="separator"')
    expect(markup).toContain('aria-label="拖拽调整终端面板高度"')
    expect(markup).toContain('aria-label="关闭终端面板"')
    expect(markup).toContain('请先选择一个工作目录后再打开终端。')
    expect(markup).not.toContain('terminal-panel__viewport')
  })

  it('applies the persisted panel height', () => {
    const markup = renderToStaticMarkup(<WorkspaceTerminalPanel />)
    expect(markup).toContain('height:240px')
  })

  it('does not touch the terminal runtime during SSR render', async () => {
    const runtime = await import('./terminalRuntime')
    expect(() => {
      renderToStaticMarkup(<WorkspaceTerminalPanel />)
      renderToStaticMarkup(<WorkspaceTerminalPanel />)
    }).not.toThrow()
    expect(runtime.attachTerminal).not.toHaveBeenCalled()
    expect(runtime.syncTerminalFont).not.toHaveBeenCalled()
  })
})
