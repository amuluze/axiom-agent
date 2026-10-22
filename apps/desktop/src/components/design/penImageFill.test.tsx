// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readDesignDocumentAsset } from '@/platform/designDocument'
import { invalidatePenAssetCache, usePenImageFill } from './penImageFill'

vi.mock('@/platform/designDocument', () => ({
  readDesignDocumentAsset: vi.fn(async () => ({
    contentBase64: 'aGk=',
    mediaType: 'image/png',
    sha256: 'sha-1',
  })),
}))

const paint = { kind: 'image' as const, url: 'assets/a.png', mode: 'fill' }

const Probe = ({ url, workspace }: { url: string; workspace?: string }) => {
  const fill = usePenImageFill('.pen/axiom.ax', { ...paint, url }, workspace)
  return <div data-testid="probe">{fill.rejected ? 'rejected' : (fill.dataUrl ?? 'loading')}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidatePenAssetCache()
})

describe('usePenImageFill', () => {
  it('相对路径经资产通道加载为 data URL', async () => {
    const view = render(<Probe url="assets/a.png" />)
    await waitFor(() => expect(view.getByTestId('probe').textContent).toBe('data:image/png;base64,aGk='))
    expect(vi.mocked(readDesignDocumentAsset)).toHaveBeenCalledWith('.pen/axiom.ax', 'assets/a.png', undefined)
  })

  it('同资产在缓存期内不重复拉取；换稿清缓存后重新拉取', async () => {
    const first = render(<Probe url="assets/a.png" />)
    await waitFor(() => expect(vi.mocked(readDesignDocumentAsset)).toHaveBeenCalledTimes(1))
    // 重挂载同一资产：命中缓存，不再调用。
    first.unmount()
    const second = render(<Probe url="assets/a.png" />)
    await waitFor(() => expect(second.getByTestId('probe').textContent).toContain('data:image/png'))
    expect(vi.mocked(readDesignDocumentAsset)).toHaveBeenCalledTimes(1)
    // 设计稿换代（sha256 变化）清缓存：重新挂载后重新拉取。
    second.unmount()
    invalidatePenAssetCache()
    const third = render(<Probe url="assets/a.png" />)
    await waitFor(() => expect(vi.mocked(readDesignDocumentAsset)).toHaveBeenCalledTimes(2))
    third.unmount()
  })

  it('两个工作区的同名稿与同名资产不共享缓存', async () => {
    vi.mocked(readDesignDocumentAsset)
      .mockResolvedValueOnce({ contentBase64: 'FIRST', mediaType: 'image/png', sha256: 'first' })
      .mockResolvedValueOnce({ contentBase64: 'SECOND', mediaType: 'image/png', sha256: 'second' })
    const view = render(<Probe url="assets/a.png" workspace="/project/a" />)
    await waitFor(() => expect(view.getByTestId('probe').textContent).toContain('FIRST'))
    view.rerender(<Probe url="assets/a.png" workspace="/project/b" />)
    await waitFor(() => expect(view.getByTestId('probe').textContent).toContain('SECOND'))
    expect(readDesignDocumentAsset).toHaveBeenCalledTimes(2)
    expect(readDesignDocumentAsset).toHaveBeenLastCalledWith('.pen/axiom.ax', 'assets/a.png', '/project/b')
  })

  it('远程 URL 直接拒绝，不调用资产通道', () => {
    const view = render(<Probe url="https://evil.example/x.png" />)
    expect(view.getByTestId('probe').textContent).toBe('rejected')
    expect(vi.mocked(readDesignDocumentAsset)).not.toHaveBeenCalled()
  })

  it('资产读取失败降级为无填充（不抛错）', async () => {
    vi.mocked(readDesignDocumentAsset).mockRejectedValueOnce(new Error('boom'))
    const view = render(<Probe url="assets/missing.png" />)
    await waitFor(() => expect(vi.mocked(readDesignDocumentAsset)).toHaveBeenCalled())
    await waitFor(() => expect(view.getByTestId('probe').textContent).toBe('loading'))
  })
})
