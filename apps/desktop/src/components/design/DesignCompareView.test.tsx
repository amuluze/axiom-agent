// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import DesignCompareView, { MAX_COMPARE_COLUMNS } from './DesignCompareView'
import { useUiStore } from '@/stores/uiStore'

const A_SOURCE = JSON.stringify({
  version: '2.18',
  variables: { 'bg-main': [{ value: '#f8f7f3', theme: { mode: 'light' } }, { value: '#161514', theme: { mode: 'dark' } }] },
  children: [
    { type: 'frame', id: 'a-1', name: '首页', children: [{ type: 'text', id: 'a-t', content: '变体 A' }] },
    { type: 'frame', id: 'a-2', name: '设置' },
  ],
})

const B_SOURCE = JSON.stringify({
  version: '2.18',
  children: [{ type: 'frame', id: 'b-1', name: '首页', children: [{ type: 'text', id: 'b-t', content: '变体 B' }] }],
})

const brokenSource = '{ broken json'

const contents = new Map<string, string>([
  ['.pen/a.pen', A_SOURCE],
  ['.pen/b.pen', B_SOURCE],
])

const mutable = vi.hoisted(() => ({ broken: false, readFail: false }))

vi.mock('@/platform/designDocument', () => ({
  readDesignDocument: vi.fn(async (path: string) => {
    if (mutable.readFail) throw new Error('未授权工作区')
    const source = mutable.broken ? brokenSource : (contents.get(path) ?? '')
    return {
      contentBase64: Buffer.from(source, 'utf-8').toString('base64'),
      sha256: path.repeat(48).slice(0, 64),
      sizeBytes: source.length,
      modifiedMs: 1,
      unchanged: false,
    }
  }),
  watchDesignDocument: vi.fn(async () => true),
  unwatchDesignDocument: vi.fn(async () => undefined),
  onDesignDocumentChanged: vi.fn(async () => () => undefined),
  readDesignDocumentAsset: vi.fn(async () => ({ contentBase64: '', mediaType: 'image/png', sha256: 'x' })),
}))

describe('DesignCompareView 变体对比', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    })
  })

  beforeEach(() => {
    mutable.broken = false
    mutable.readFail = false
    useUiStore.setState({ theme: 'light' })
  })

  it('每份稿一列并渲染各自内容，共享页序与缩放', async () => {
    render(<DesignCompareView paths={['.pen/a.pen', '.pen/b.pen']} />)
    expect(await screen.findByText('对比 2 份稿')).toBeTruthy()
    // 两列各自的标题与首个页内容都在（列独立加载）。
    expect(screen.getByText('.pen/a.pen')).toBeTruthy()
    expect(screen.getByText('.pen/b.pen')).toBeTruthy()
    expect(await screen.findByText('变体 A')).toBeTruthy()
    expect(await screen.findByText('变体 B')).toBeTruthy()
    // 页列表取首列文档：A 有两页，切换页序对两列同时生效。
    expect(screen.getByRole('tab', { name: '设置' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.queryByText('变体 A')).toBeNull()
    // 共享缩放：点一次放大，两列共用同一 scale。
    fireEvent.click(screen.getByLabelText('放大'))
    expect(screen.getByText('120%')).toBeTruthy()
  })

  it('点击列标题聚焦该列', async () => {
    render(<DesignCompareView paths={['.pen/a.pen', '.pen/b.pen']} />)
    fireEvent.click(await screen.findByText('.pen/b.pen'))
    expect(screen.getByText('聚焦：.pen/b.pen')).toBeTruthy()
  })

  it('解析失败的列独立降级，不影响其它列', async () => {
    mutable.broken = true
    render(<DesignCompareView paths={['.pen/a.pen', '.pen/b.pen']} />)
    expect(await screen.findAllByText(/JSON 解析失败/)).toHaveLength(2)
  })

  it('读取失败的列显示错误标记而非空白', async () => {
    mutable.readFail = true
    render(<DesignCompareView paths={['.pen/a.pen']} />)
    expect(await screen.findByText('加载失败')).toBeTruthy()
  })

  it('列数超过上限时按顺序截断', async () => {
    const paths = ['.pen/a.pen', '.pen/b.pen', '.pen/c.pen', '.pen/d.pen', '.pen/e.pen']
    render(<DesignCompareView paths={paths} />)
    expect(await screen.findByText(`对比 ${MAX_COMPARE_COLUMNS} 份稿`)).toBeTruthy()
  })
})
