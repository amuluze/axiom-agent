// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DesignView from './DesignView'
import { useUiStore } from '@/stores/uiStore'
import { findWorkspaceFiles } from '@/platform/workspace'
import { readDesignDocument } from '@/platform/designDocument'

const mocks = vi.hoisted(() => ({
  createNewSession: vi.fn(async () => true),
  canvasThrow: false,
  canvasProps: {} as Record<string, unknown>,
  changeHandler: null as ((payload: { path: string }) => void) | null,
  // useAuthorActive 的选择源：默认无运行会话（编辑期坏稿暂缓不生效，错误照常呈现）。
  sessions: [] as Array<{ id: string; status: 'idle' | 'running' }>,
}))

vi.mock('@/stores/agentStore', () => ({
  useAgentStore: Object.assign(
    (selector: (state: typeof mocks) => unknown) => selector(mocks),
    { getState: () => mocks },
  ),
}))

vi.mock('@/platform/workspace', () => ({
  findWorkspaceFiles: vi.fn(async () => ({
    matches: [{ kind: 'file', path: '.pen/axiom.ax' }],
  })),
}))

vi.mock('@/platform/designDocument', () => ({
  readDesignDocument: vi.fn(async () => ({
    contentBase64: btoa(JSON.stringify({ ax: '1.3', tokens: {}, components: {}, pages: [{ id: 'p', width: 100, height: 100, tree: [] }] })),
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    sizeBytes: 32,
    modifiedMs: 1,
    unchanged: false,
  })),
  watchDesignDocument: vi.fn(async () => true),
  unwatchDesignDocument: vi.fn(async () => undefined),
  onDesignDocumentChanged: vi.fn(async (handler: (payload: { path: string }) => void) => {
    mocks.changeHandler = handler
    return () => undefined
  }),
}))

// 画布渲染崩溃注入：验证错误边界把坏数据降级为错误卡片，而不是卸载整棵树（黑屏）。
vi.mock('./DesignCanvas', () => ({
  default: function DesignCanvasMock(props: Record<string, unknown>) {
    mocks.canvasProps = props
    if (mocks.canvasThrow) throw new Error('画布崩溃注入')
    return <div data-testid="canvas-mock" />
  },
}))

describe('DesignView 独立页面', () => {
  beforeEach(() => {
    mocks.createNewSession.mockClear()
    window.localStorage.clear()
    useUiStore.setState({ composerInsertionRequest: null })
    vi.mocked(findWorkspaceFiles).mockClear()
  })

  it('仅发现 .ax，旧 .pen 与非设计稿文件不进入画布', async () => {
    vi.mocked(findWorkspaceFiles).mockResolvedValueOnce({
      matches: [
        { kind: 'file', path: '.pen/axiom.pen' },
        { kind: 'file', path: '.pen/axiom.ax' },
        { kind: 'file', path: '.pen/flows/checkout.ax' },
        { kind: 'file', path: '.pen/image.png' },
        { kind: 'directory', path: '.pen/assets' },
      ],
    } as never)
    render(<DesignView />)
    // 两种格式都成为文件 tab；非设计稿（png/目录）不出现。
    expect(await screen.findByRole('tab', { name: '.pen/axiom.ax' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '.pen/flows/checkout.ax' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '.pen/axiom.pen' })).toBeNull()
    expect(screen.queryByRole('tab', { name: '.pen/image.png' })).toBeNull()
    expect(findWorkspaceFiles).toHaveBeenCalledWith(expect.objectContaining({
      path: '.pen',
      pattern: '*.ax',
      limit: 1_000,
    }))
  })

  it('设计视图整页呈现：画布直接挂载，不再分屏内嵌会话面板', async () => {
    render(<DesignView />)
    expect(await screen.findByTestId('canvas-mock')).toBeTruthy()
    expect(screen.queryByText('开始设计会话')).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    // 文件 tab 仍在顶部工具栏（多稿切换）。
    expect(screen.getByRole('tab', { name: '.pen/axiom.ax' })).toBeTruthy()
    // 对比/方案探索仍不回归；版本历史仅提供恢复，不复活旧的多模式工作台。
    expect(screen.queryByText('对比模式')).toBeNull()
    expect(screen.queryByText('方案探索')).toBeNull()
    expect(screen.getByRole('button', { name: '版本历史' })).toBeTruthy()
  })

  it('画布拿到 sha256 与页级删除通道', async () => {
    render(<DesignView />)
    await screen.findByTestId('canvas-mock')
    expect(mocks.canvasProps.sha256).toBe('0000000000000000000000000000000000000000000000000000000000000000')
    expect(typeof mocks.canvasProps.onDeletePage).toBe('function')
  })
  it('重新扫描后替换已消失的选中路径，并清除已删除的最后一份稿', async () => {
    render(<DesignView />)
    await screen.findByTestId('canvas-mock')
    vi.mocked(findWorkspaceFiles).mockResolvedValueOnce({ matches: [{ kind: 'file', path: '.pen/renamed.ax' }] } as never)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    const renamed = await screen.findByRole('tab', { name: '.pen/renamed.ax' })
    expect(renamed).toHaveAttribute('aria-selected', 'true')
    await vi.waitFor(() => expect(readDesignDocument).toHaveBeenLastCalledWith('.pen/renamed.ax', undefined, undefined))
    vi.mocked(findWorkspaceFiles).mockResolvedValueOnce({ matches: [] } as never)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText('添加设计稿')
    expect(screen.queryByTestId('canvas-mock')).toBeNull()
  })
})

describe('DesignView 空态添加设计稿', () => {
  beforeEach(() => {
    mocks.createNewSession.mockClear()
    window.localStorage.clear()
    useUiStore.setState({ composerInsertionRequest: null })
    vi.mocked(findWorkspaceFiles).mockClear().mockResolvedValue({ matches: [] } as never)
  })

  it('空态文案指向 .ax 为自有格式，且骨架指令落在 .ax', async () => {
    render(<DesignView />)
    const description = await screen.findByText(/工作区 \.pen\/ 目录/)
    expect(description.textContent).toContain('.ax')
    expect(description.textContent).toContain('pen.dev')
  })

  it('无设计稿时展示骨架创建表单，提交后新建会话并预填骨架指令', async () => {
    render(<DesignView />)
    expect(await screen.findByText('添加设计稿')).toBeTruthy()
    const input = screen.getByLabelText(/设计稿文件名/) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'checkout' } })
    fireEvent.click(screen.getByText('添加设计稿'))
    await vi.waitFor(() => expect(mocks.createNewSession).toHaveBeenCalledTimes(1))
    const request = useUiStore.getState().composerInsertionRequest
    expect(request?.text).toContain('.pen/checkout.ax')
    expect(request?.text).toContain('design skill')
  })

  it('输入连带的扩展名会被剥掉（不拼出 .ax.ax / .pen.ax）', async () => {
    render(<DesignView />)
    const input = await screen.findByLabelText(/设计稿文件名/)
    fireEvent.change(input, { target: { value: 'checkout.ax' } })
    fireEvent.click(screen.getByText('添加设计稿'))
    await vi.waitFor(() => expect(mocks.createNewSession).toHaveBeenCalledTimes(1))
    const request = useUiStore.getState().composerInsertionRequest
    expect(request?.text).toContain('.pen/checkout.ax')
    expect(request?.text).not.toContain('.ax.ax')
  })

  it('createNewSession 失败时不注入骨架指令', async () => {
    mocks.createNewSession.mockResolvedValueOnce(false)
    render(<DesignView />)
    fireEvent.click(await screen.findByText('添加设计稿'))
    await vi.waitFor(() => expect(mocks.createNewSession).toHaveBeenCalledTimes(1))
    expect(useUiStore.getState().composerInsertionRequest).toBeNull()
  })
})

describe('DesignView 空设计稿提示', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiStore.setState({ composerInsertionRequest: null })
  })

  it.each(['.pen/blank.ax'])('%s 为空/空白时给出可执行的下一步，而不是解析器技术错误', async (path) => {
    vi.mocked(findWorkspaceFiles).mockClear().mockResolvedValue({
      matches: [{ kind: 'file', path }],
    } as never)
    vi.mocked(readDesignDocument).mockResolvedValue({
      contentBase64: btoa('\n   '),
      sha256: 'b'.repeat(64),
      sizeBytes: 4,
      modifiedMs: 1,
      unchanged: false,
    } as never)
    render(<DesignView />)
    const banner = await screen.findByText(/设计稿是空文件/)
    expect(banner.textContent).toContain('生成骨架')
    // 不能再是那条对数用户无动作可言的解析器错误。
    expect(screen.queryByText(/Unexpected EOF/)).toBeNull()
  })
})

describe('DesignView 画布渲染错误边界', () => {
  const validDoc = JSON.stringify({ ax: '1.3', tokens: {}, components: {}, pages: [{ id: 'page-1', width: 100, height: 100, tree: [] }] })

  beforeEach(() => {
    mocks.canvasThrow = false
    window.localStorage.clear()
    useUiStore.setState({ composerInsertionRequest: null })
    vi.mocked(findWorkspaceFiles).mockClear().mockResolvedValue({
      matches: [{ kind: 'file', path: '.pen/bad.ax' }],
    } as never)
    vi.mocked(readDesignDocument).mockResolvedValue({
      contentBase64: btoa(validDoc),
      sha256: 'bad-pen-sha',
      sizeBytes: validDoc.length,
      modifiedMs: 1,
      unchanged: false,
    })
  })

  it('画布渲染抛错时降级为错误卡片，可重试恢复', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.canvasThrow = true
    render(<DesignView />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('设计稿渲染失败，文件可能包含暂不支持的结构。')).toBeTruthy()
    // 修复后（不再抛错）重试即可恢复画布。
    mocks.canvasThrow = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByTestId('canvas-mock')).toBeTruthy()
    errorSpy.mockRestore()
  })

  it('文件内容变更（resetKey sha256 换代）后错误边界自动重试', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.canvasThrow = true
    render(<DesignView />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    // 模拟 Agent 保存了修复后的文件：sha256 变化 → boundary resetKey 换代 → 自动重挂。
    mocks.canvasThrow = false
    vi.mocked(readDesignDocument).mockResolvedValue({
      contentBase64: btoa(validDoc),
      sha256: 'fixed-sha',
      sizeBytes: validDoc.length,
      modifiedMs: 2,
      unchanged: false,
    })
    mocks.changeHandler?.({ path: '.pen/bad.ax' })
    expect(await screen.findByTestId('canvas-mock', {}, { timeout: 3000 })).toBeTruthy()
    errorSpy.mockRestore()
  })

  it('变更重读携带已知 sha256；unchanged 响应不触发重解析', async () => {
    render(<DesignView />)
    expect(await screen.findByTestId('canvas-mock')).toBeTruthy()
    // 首次加载后，变更事件触发的重读应携带已持有内容的 sha256 供 Rust 短路。
    vi.mocked(readDesignDocument).mockResolvedValue({
      contentBase64: '',
      sha256: 'bad-pen-sha',
      sizeBytes: validDoc.length,
      modifiedMs: 1,
      unchanged: true,
    })
    mocks.changeHandler?.({ path: '.pen/bad.ax' })
    await vi.waitFor(() =>
      expect(vi.mocked(readDesignDocument)).toHaveBeenCalledWith('.pen/bad.ax', 'bad-pen-sha', undefined),
    )
    // unchanged：内容未变，画布保持原样不重挂。
    expect(screen.getByTestId('canvas-mock')).toBeTruthy()
  })
})
