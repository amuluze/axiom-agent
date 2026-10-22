// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocsView } from './DocsView'

const mocks = vi.hoisted(() => ({
  authorizedWorkspace: null as { path: string; name: string } | null,
  activeSessionId: 'session-1' as string | null,
  running: false,
  projectDocsRevision: 0,
  projectDocsWorkspacePath: null as string | null,
  addWorkspace: vi.fn(async () => true),
  createNewSession: vi.fn(async () => true),
  refreshActiveProjectContext: vi.fn(async () => undefined),
  requestComposerInsertion: vi.fn(),
  listWorkspace: vi.fn(),
  readWorkspaceText: vi.fn(),
  readWorkspaceDocument: vi.fn(),
  findWorkspaceFiles: vi.fn(),
  saveWorkspaceDocument: vi.fn(),
}))

vi.mock('@/stores/agentStore', () => ({
  useAgentStore: Object.assign(
    (selector: (state: typeof mocks) => unknown) => selector(mocks),
    { getState: () => mocks },
  ),
}))

vi.mock('@/stores/uiStore', () => ({
  installViewChangeGuard: vi.fn(() => () => undefined),
  useUiStore: Object.assign(
    (selector: (state: typeof mocks) => unknown) => selector(mocks),
    { getState: () => mocks },
  ),
}))

vi.mock('@/platform/workspace', () => ({
  listWorkspace: mocks.listWorkspace,
  readWorkspaceText: mocks.readWorkspaceText,
  findWorkspaceFiles: mocks.findWorkspaceFiles,
}))

vi.mock('@/platform/workspaceDocument', () => ({
  readWorkspaceDocument: mocks.readWorkspaceDocument,
  saveWorkspaceDocument: mocks.saveWorkspaceDocument,
}))

vi.mock('@/platform/webAccess', () => ({
  openExternalUrl: vi.fn(),
}))

// 与 Rust 边界一致：宿主错误信封带 code，缺失目录为 not_found；裸 Error 会被映射为 unknown。
const notFound = (): Error => Object.assign(new Error('No such file or directory'), { code: 'not_found' })

const listResult = (entries: Array<{ path: string; name: string }>) => ({
  workspace: { path: '/ws', name: 'ws' },
  directory: '.specs/domain',
  entries: entries.map((entry) => ({ ...entry, kind: 'file', sizeBytes: 0 })),
  truncated: false,
})

const readResult = (path: string, content: string, nextOffset?: number, sha256 = 'h') => ({
  workspace: { path: '/ws', name: 'ws' },
  path,
  content,
  sha256,
  startLine: 0,
  endLine: content.split('\n').length,
  totalLines: content.split('\n').length,
  truncated: false,
  nextOffset,
})

beforeEach(() => {
  mocks.authorizedWorkspace = { path: '/ws', name: 'ws' }
  mocks.addWorkspace.mockClear()
  mocks.createNewSession.mockClear()
  mocks.refreshActiveProjectContext.mockClear()
  mocks.running = false
  mocks.projectDocsRevision = 0
  mocks.projectDocsWorkspacePath = null
  mocks.requestComposerInsertion.mockClear()
  mocks.listWorkspace.mockReset()
  mocks.readWorkspaceText.mockReset()
  // 编辑态走整文件读通道；默认从 readWorkspaceText 的当前 mock 派生，保持既有用例
  // 只配置分页读也能正常工作。
  mocks.readWorkspaceDocument.mockReset().mockImplementation(async (path: string) => {
    const read = await mocks.readWorkspaceText(path, 0)
    return {
      workspacePath: '/ws',
      path,
      content: read.content,
      sha256: read.sha256,
      sizeBytes: read.content.length,
    }
  })
  mocks.findWorkspaceFiles.mockReset().mockResolvedValue({ matches: [], truncated: false })
  mocks.saveWorkspaceDocument.mockReset()
})

afterEach(() => {
  mocks.authorizedWorkspace = null
})

describe('DocsView', () => {
  it('无授权工作区时引导添加工作区（与侧栏「添加工作区」同一动作）', () => {
    mocks.authorizedWorkspace = null
    render(<DocsView />)
    expect(screen.getByText('尚未打开工作区')).toBeTruthy()
    const button = screen.getByRole('button', { name: '添加工作区' })
    button.click()
    expect(mocks.addWorkspace).toHaveBeenCalledTimes(1)
  })

  it('受管目录都不存在时显示「还没有可浏览的文档」空态（含示例指令）', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    render(<DocsView />)
    await waitFor(() => expect(screen.getByText('还没有可浏览的文档')).toBeTruthy())
    expect(screen.getByText('可以这样说：')).toBeTruthy()
    expect(screen.getByText('把 .docs/ 下的实现现状整理成一份文档')).toBeTruthy()
  })

  it('扫描到活跃与归档条目：归档走独立徽标且默认与活跃同列', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/tasks') {
        return {
          workspace: { path: '/ws', name: 'ws' },
          directory: path,
          entries: [
            { path: '.specs/tasks/active.md', name: 'active.md', kind: 'file', sizeBytes: 0 },
            { path: '.specs/tasks/done.md', name: 'done.md', kind: 'file', sizeBytes: 0 },
          ],
          truncated: false,
        }
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === '.specs/tasks/active.md') return {
        workspace: { path: '/ws', name: 'ws' }, path, content: '# Active', sha256: 'a', startLine: 0, endLine: 1, totalLines: 1, truncated: false,
      }
      if (path === '.specs/tasks/done.md') return {
        workspace: { path: '/ws', name: 'ws' }, path, content: '---\nstatus: done\n---\n# Done', sha256: 'b', startLine: 0, endLine: 3, totalLines: 3, truncated: false,
      }
      throw notFound()
    })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByText('Active')).toBeTruthy())
    // 归档条目按设计仍展示于「任务规格」组内，但带「已归档」徽标
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getAllByText('已归档').length).toBeGreaterThan(0)
  })

  it('目录列举失败（非 not_found）以失败 note 提示，避免模型把整组缺失读成「没有文档」', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        throw Object.assign(new Error('permission denied'), { code: 'not_authorized' })
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    render(<DocsView />)
    await waitFor(() => expect(screen.getByText('目录列举失败，请用 ls 复查')).toBeTruthy())
    // 诊断必须可定位：嵌套目录失败时 root 才是用户/开发能复查的那个路径，
    // 只给通用文案时它只与分组路径标注撞名、无法指向失败的那一层。
    expect(screen.getByTitle('.specs/domain').textContent).toBe('.specs/domain')
  })

  it('超长行占位提示：宿主生成的英文提示被标注为系统提示，不冒充文档内容', async () => {
    // 单行超 128 KiB 时宿主返回占位提示而不是真实行；阅读态直接渲染会让用户
    // 以为文档里真写了这段英文。提示条是唯一能把「这是系统提示」说清楚的地方。
    const placeholder = '[Line 12 is 200000 bytes, exceeds the 128 KiB read output limit. '
      + 'Use a narrower offset/limit or bash with a safe text slicer to inspect this line.]'
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.docs') return listResult([{ path: '.docs/a.md', name: 'a.md' }])
      throw notFound()
    })
    mocks.readWorkspaceText.mockResolvedValue(readResult('.docs/a.md', `# 标题\n\n${placeholder}\n`))
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('超出单行读取上限')
  })

  it('分页读取：nextOffset 非 null 时渲染「加载更多」按钮', async () => {
    mocks.listWorkspace.mockResolvedValue(listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }]))
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === '.specs/domain/spec.md') {
        return {
          workspace: { path: '/ws', name: 'ws' },
          path,
          content: '# Spec\n\nfirst page\n',
          sha256: 'h',
          startLine: 0,
          endLine: 2,
          totalLines: 100,
          truncated: true,
          nextOffset: 2,
        }
      }
      throw new Error('not implemented in this test')
    })
    render(<DocsView />)
    // 等首屏渲染完成
    await waitFor(() => expect(screen.getByRole('button', { name: '加载更多' })).toBeTruthy())
    // 翻页（仅断言按钮存在并能点击不抛错，行为正确性由 docsIndex 与 loadDoc 单元锁）
    await act(async () => {
      screen.getByRole('button', { name: '加载更多' }).click()
    })
  })

  it('标签栏：打开第二份文档出现新标签，点击标签可切回', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([
          { path: '.specs/domain/a.md', name: 'a.md' },
          { path: '.specs/domain/b.md', name: 'b.md' },
        ])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === '.specs/domain/a.md') return readResult(path, '# A\n')
      if (path === '.specs/domain/b.md') return readResult(path, '# B\n')
      throw notFound()
    })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByText('A')).toBeTruthy())
    // 树里点开第二份文档：出现标签且内容切换
    await act(async () => {
      screen.getByTitle('.specs/domain/b.md').click()
    })
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['.specs/domain/a.md', '.specs/domain/b.md'])
    expect(screen.getByTitle('.specs/domain/b.md').classList.contains('is-active')).toBe(true)
    // 点第一个标签切回
    await act(async () => {
      tabs[0].click()
    })
    expect(screen.getByTitle('.specs/domain/a.md').classList.contains('is-active')).toBe(true)
  })

  it('受管目录子目录中的文档出现在树中并可打开', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.docs') {
        return {
          workspace: { path: '/ws', name: 'ws' },
          directory: path,
          entries: [
            { path: '.docs/a.md', name: 'a.md', kind: 'file', sizeBytes: 0 },
            { path: '.docs/archive', name: 'archive', kind: 'directory', sizeBytes: 0 },
          ],
          truncated: false,
        }
      }
      if (path === '.docs/archive') {
        return {
          workspace: { path: '/ws', name: 'ws' },
          directory: path,
          entries: [{ path: '.docs/archive/old.md', name: 'old.md', kind: 'file', sizeBytes: 0 }],
          truncated: false,
        }
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === '.docs/a.md') return readResult(path, '# A\n')
      if (path === '.docs/archive/old.md') return readResult(path, '# Old\n')
      throw notFound()
    })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'A' })).toBeTruthy())

    await act(async () => {
      screen.getByTitle('.docs/archive/old.md').click()
    })

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Old' })).toBeTruthy())
    expect(screen.getByTitle('.docs/archive/old.md').classList.contains('is-active')).toBe(true)
  })

  it('Markdown 相对链接在文档视图内打开已索引文档', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([
          { path: '.specs/domain/a.md', name: 'a.md' },
          { path: '.specs/domain/b.md', name: 'b.md' },
        ])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === '.specs/domain/a.md') return readResult(path, '# A\n\n[B](b.md)\n')
      if (path === '.specs/domain/b.md') return readResult(path, '# B\n')
      throw notFound()
    })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'A' })).toBeTruthy())

    await act(async () => {
      screen.getByRole('link', { name: 'B' }).click()
    })

    await waitFor(() => expect(screen.getByRole('heading', { name: 'B' })).toBeTruthy())
    expect(screen.getByTitle('.specs/domain/b.md').classList.contains('is-active')).toBe(true)
  })

  it('编辑态：编辑读全文，保存走 CAS 通道，放弃回到阅读态', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path !== '.specs/domain/spec.md') throw notFound()
      return readResult(path, '# Spec\n\nbody\n')
    })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy())
    // 进入编辑：顶部动作切换为 保存/放弃，出现源码编辑器
    await act(async () => {
      screen.getByRole('button', { name: '编辑' }).click()
    })
    const editor = await screen.findByLabelText('Markdown 源码编辑器') as HTMLTextAreaElement
    expect(editor.value).toBe('# Spec\n\nbody\n')
    expect(screen.getByText('编辑中 · Markdown 源码')).toBeTruthy()
    // 未修改时保存禁用、无「未保存的更改」标记
    expect(screen.queryByText('未保存的更改')).toBeNull()
    expect(screen.getByRole('button', { name: '保存 ⌘S' }).hasAttribute('disabled')).toBe(true)
    // 修改后启用保存；保存调用 CAS 通道并回写干净基线（React 受控输入需经
    // 原生 value setter 触发，直接赋值会被 React 的取值追踪忽略）。
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(editor, '# Spec v2\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(screen.getByText('未保存的更改')).toBeTruthy()
    mocks.saveWorkspaceDocument.mockResolvedValue({ workspacePath: '/ws', sha256: 'n', sizeBytes: 12 })
    await act(async () => {
      screen.getByRole('button', { name: '保存 ⌘S' }).click()
    })
    await waitFor(() => expect(mocks.saveWorkspaceDocument).toHaveBeenCalledTimes(1))
    const call = mocks.saveWorkspaceDocument.mock.calls[0] as unknown[]
    expect(call[0]).toBe('.specs/domain/spec.md')
    expect(call[1]).toBe('# Spec v2\n')
    expect(typeof call[2]).toBe('string')
    expect(mocks.refreshActiveProjectContext).toHaveBeenCalledTimes(1)
    // 保存成功后回到干净态：无未保存标记
    await waitFor(() => expect(screen.queryByText('未保存的更改')).toBeNull())
    // 放弃：回到阅读态
    await act(async () => {
      screen.getByRole('button', { name: '放弃' }).click()
    })
    await waitFor(() => expect(screen.queryByLabelText('Markdown 源码编辑器')).toBeNull())
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
  })

  it('保存期间继续输入不会被旧请求结果覆盖', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === '.specs/domain/spec.md') return readResult(path, '# Spec\n')
      throw notFound()
    })
    let resolveSave: ((value: { workspacePath: string; sha256: string; sizeBytes: number }) => void) | undefined
    mocks.saveWorkspaceDocument.mockImplementation(() => new Promise((resolve) => {
      resolveSave = resolve
    }))
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('button', { name: '编辑' }).click()
    })
    const editor = await screen.findByLabelText('Markdown 源码编辑器') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(editor, '# Submitted\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      screen.getByRole('button', { name: '保存 ⌘S' }).click()
    })
    await act(async () => {
      setValue?.call(editor, '# Typed while saving\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      resolveSave?.({ workspacePath: '/ws', sha256: 'saved', sizeBytes: 12 })
    })
    await waitFor(() => expect(editor.value).toBe('# Typed while saving\n'))
    expect(screen.getByText('未保存的更改')).toBeTruthy()
  })

  it('重新扫描失败或文档暂时缺失时保留未保存草稿', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === '.specs/domain/spec.md') return readResult(path, '# Spec\n')
      throw notFound()
    })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('button', { name: '编辑' }).click()
    })
    const editor = await screen.findByLabelText('Markdown 源码编辑器') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(editor, '# Unsaved\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mocks.listWorkspace.mockRejectedValue(notFound())
    const callsBeforeRescan = mocks.listWorkspace.mock.calls.length

    await act(async () => {
      screen.getAllByRole('button', { name: '重新扫描' })[0]?.click()
    })

    await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(callsBeforeRescan))
    await waitFor(() => expect(editor.value).toBe('# Unsaved\n'))
    expect(screen.getByText('未保存的更改')).toBeTruthy()
  })

  it('CRLF 文档保存使用宿主原始 SHA', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path !== '.specs/domain/spec.md') throw notFound()
      return {
        ...readResult(path, '# Spec\nbody\n'),
        sha256: 'raw-crlf-sha',
      }
    })
    mocks.saveWorkspaceDocument.mockResolvedValue({ workspacePath: '/ws', sha256: 'saved', sizeBytes: 16 })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('button', { name: '编辑' }).click()
    })
    const editor = await screen.findByLabelText('Markdown 源码编辑器') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(editor, '# Updated\nbody\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      screen.getByRole('button', { name: '保存 ⌘S' }).click()
    })
    await waitFor(() => expect(mocks.saveWorkspaceDocument).toHaveBeenCalled())
    expect(mocks.saveWorkspaceDocument).toHaveBeenCalledWith(
      '.specs/domain/spec.md',
      '# Updated\nbody\n',
      'raw-crlf-sha',
      '/ws',
    )
  })

  it('Agent 运行结束后自动重扫文档目录', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    mocks.running = true
    const view = render(<DocsView />)
    await waitFor(() => expect(screen.getByText('还没有可浏览的文档')).toBeTruthy())
    const callsBeforeFinish = mocks.listWorkspace.mock.calls.length
    mocks.running = false
    view.rerender(<DocsView />)
    await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(callsBeforeFinish))
  })

  it('后台会话文档索引变化（projectDocsRevision）触发重扫', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    const view = render(<DocsView />)
    await waitFor(() => expect(screen.getByText('还没有可浏览的文档')).toBeTruthy())
    const callsBefore = mocks.listWorkspace.mock.calls.length

    mocks.projectDocsRevision = 1
    view.rerender(<DocsView />)

    await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('忽略其它工作区的文档索引变化，当前工作区变化仍重扫', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    const view = render(<DocsView />)
    await waitFor(() => expect(screen.getByText('还没有可浏览的文档')).toBeTruthy())
    const callsBefore = mocks.listWorkspace.mock.calls.length

    mocks.projectDocsRevision = 1
    mocks.projectDocsWorkspacePath = '/other'
    view.rerender(<DocsView />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.listWorkspace.mock.calls.length).toBe(callsBefore)

    mocks.projectDocsRevision = 2
    mocks.projectDocsWorkspacePath = '/ws'
    view.rerender(<DocsView />)
    await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('窗口重新获得焦点时重扫（外部编辑）', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    render(<DocsView />)
    await waitFor(() => expect(screen.getByText('还没有可浏览的文档')).toBeTruthy())
    const callsBefore = mocks.listWorkspace.mock.calls.length

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('隐藏窗口时推迟自动扫描，恢复可见后执行', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    const view = render(<DocsView />)
    await waitFor(() => expect(screen.getByText('还没有可浏览的文档')).toBeTruthy())
    const callsBefore = mocks.listWorkspace.mock.calls.length
    const originalVisibility = document.visibilityState
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    try {
      mocks.projectDocsRevision = 1
      view.rerender(<DocsView />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(mocks.listWorkspace.mock.calls.length).toBe(callsBefore)

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(callsBefore))
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      })
    }
  })

  it('短窗口内多个自动触发只产生一轮扫描', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    const view = render(<DocsView />)
    await waitFor(() => expect(screen.getByText('还没有可浏览的文档')).toBeTruthy())
    const callsBefore = mocks.listWorkspace.mock.calls.length

    mocks.projectDocsRevision = 1
    view.rerender(<DocsView />)
    mocks.projectDocsRevision = 2
    view.rerender(<DocsView />)
    mocks.running = true
    view.rerender(<DocsView />)
    mocks.running = false
    view.rerender(<DocsView />)

    await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(callsBefore))
    // 一轮扫描固定列举四个受管目录；短窗口内的四个触发合并后只应产生这一轮。
    expect(mocks.listWorkspace.mock.calls.length - callsBefore).toBe(4)
  })

  it('编辑加载期间重扫不会把编辑按钮永久卡在加载态', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path !== '.specs/domain/spec.md') throw notFound()
      return readResult(path, '# Spec\n\nbody\n')
    })
    let releaseEditRead: ((value: unknown) => void) | undefined
    mocks.readWorkspaceDocument.mockImplementation(() => new Promise((resolve) => {
      releaseEditRead = resolve
    }))
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy())

    await act(async () => {
      screen.getByRole('button', { name: '编辑' }).click()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '正在加载…' })).toBeTruthy())

    await act(async () => {
      screen.getAllByRole('button', { name: '重新扫描' })[0]?.click()
    })
    await waitFor(() => expect(mocks.listWorkspace.mock.calls.length).toBeGreaterThan(4))
    // 等扫描把索引与选中态收口完，再放行编辑读——这正是旧实现永久卡死的时序。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await act(async () => {
      releaseEditRead?.({
        workspacePath: '/ws',
        path: '.specs/domain/spec.md',
        content: '# Spec\n\nbody\n',
        sha256: 'h',
        sizeBytes: 13,
      })
    })

    expect(await screen.findByLabelText('Markdown 源码编辑器')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '正在加载…' })).toBeNull()
  })

  it('run 结束重扫发现 revision 变化时重读当前正文', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    let disk = '# Spec\n\nold body\n'
    let revision = 'rev-1'
    mocks.readWorkspaceText.mockImplementation(async (path: string, offset?: number) => {
      if (path !== '.specs/domain/spec.md') throw notFound()
      return readResult(path, offset === 0 ? disk : '# Spec\n', undefined, revision)
    })
    const view = render(<DocsView />)
    await waitFor(() => expect(screen.getByText('old body')).toBeTruthy())

    disk = '# Spec\n\nnew body\n'
    revision = 'rev-2'
    mocks.running = true
    view.rerender(<DocsView />)
    mocks.running = false
    view.rerender(<DocsView />)

    await waitFor(() => expect(screen.getByText('new body')).toBeTruthy())
  })

  it('选中的 AGENTS.md 在 run 结束重扫后也会重读正文（无 revision 条目）', async () => {
    mocks.listWorkspace.mockRejectedValue(notFound())
    let disk = '# AGENTS\n\nold convention\n'
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path === 'AGENTS.md') return readResult(path, disk)
      throw notFound()
    })
    mocks.findWorkspaceFiles.mockResolvedValue({
      matches: [{ path: 'AGENTS.md', name: 'AGENTS.md', kind: 'file', sizeBytes: 0 }],
      truncated: false,
    })
    const view = render(<DocsView />)
    await waitFor(() => expect(screen.getByText('old convention')).toBeTruthy())

    disk = '# AGENTS\n\nnew convention\n'
    mocks.running = true
    view.rerender(<DocsView />)
    mocks.running = false
    view.rerender(<DocsView />)

    await waitFor(() => expect(screen.getByText('new convention')).toBeTruthy())
  })

  it('整体扫描失败时保留错误态而不是伪装成空文档', async () => {
    mocks.listWorkspace.mockResolvedValue({} as never)
    mocks.readWorkspaceText.mockRejectedValue(notFound())
    render(<DocsView />)
    await waitFor(() =>
      expect(screen.getByText('文档扫描失败；请重试或用 ls 复查')).toBeTruthy())
    expect(screen.queryByText('还没有可浏览的文档')).toBeNull()
    expect(screen.getByRole('button', { name: '重新扫描' })).toBeTruthy()
  })

  it('重复点击当前文档会重读正文', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    let disk = '# Spec\n\nold body\n'
    mocks.readWorkspaceText.mockImplementation(async (path: string, offset?: number) => {
      if (path !== '.specs/domain/spec.md') throw notFound()
      return readResult(path, offset === 0 ? disk : '# Spec\n', undefined, 'rev-1')
    })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByText('old body')).toBeTruthy())

    disk = '# Spec\n\nnew body\n'
    await act(async () => {
      screen.getByTitle('.specs/domain/spec.md').click()
    })

    await waitFor(() => expect(screen.getByText('new body')).toBeTruthy())
  })

  it('编辑态下 ⌘S 在编辑器外触发也能保存', async () => {
    mocks.listWorkspace.mockImplementation(async (path: string) => {
      if (path === '.specs/domain') {
        return listResult([{ path: '.specs/domain/spec.md', name: 'spec.md' }])
      }
      throw notFound()
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => {
      if (path !== '.specs/domain/spec.md') throw notFound()
      return readResult(path, '# Spec\n\nbody\n')
    })
    mocks.saveWorkspaceDocument.mockResolvedValue({ workspacePath: '/ws', sha256: 'n', sizeBytes: 12 })
    render(<DocsView />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Spec' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('button', { name: '编辑' }).click()
    })
    const editor = await screen.findByLabelText('Markdown 源码编辑器') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(editor, '# Spec v2\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }))
    })

    await waitFor(() => expect(mocks.saveWorkspaceDocument).toHaveBeenCalledTimes(1))
  })
})
