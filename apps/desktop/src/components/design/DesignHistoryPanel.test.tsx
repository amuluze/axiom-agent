// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DesignHistoryPanel from './DesignHistoryPanel'
import { listDesignDocumentVersions, restoreDesignDocumentVersion } from '@/platform/designDocument'

vi.mock('@/platform/designDocument', () => ({
  listDesignDocumentVersions: vi.fn(),
  restoreDesignDocumentVersion: vi.fn(),
}))

describe('DesignHistoryPanel', () => {
  beforeEach(() => {
    vi.mocked(listDesignDocumentVersions).mockReset().mockResolvedValue([{
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      modifiedMs: 1_700_000_000_000,
      pageCount: 2,
    }])
    vi.mocked(restoreDesignDocumentVersion).mockReset().mockResolvedValue({
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
    })
  })

  it('读取含 Git 的历史并以两段式确认恢复当前文件', async () => {
    const onRestored = vi.fn(async () => undefined)
    const onClose = vi.fn()
    render(
      <DesignHistoryPanel
        path=".pen/a.ax"
        workspacePath="/workspace"
        expectedSha256={'b'.repeat(64)}
        onRestored={onRestored}
        onClose={onClose}
      />,
    )
    expect(await screen.findByText(/2 页/)).toBeTruthy()
    expect(listDesignDocumentVersions).toHaveBeenNthCalledWith(1, '.pen/a.ax', '/workspace', false)
    await vi.waitFor(() => expect(listDesignDocumentVersions).toHaveBeenNthCalledWith(2, '.pen/a.ax', '/workspace', true))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    expect(restoreDesignDocumentVersion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '再点一次确认恢复' }))
    await vi.waitFor(() => expect(restoreDesignDocumentVersion).toHaveBeenCalledWith(
      '.pen/a.ax',
      'a'.repeat(64),
      'b'.repeat(64),
      '/workspace',
    ))
    await vi.waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Git 导入失败时仍保留本地恢复版本', async () => {
    vi.mocked(listDesignDocumentVersions)
      .mockResolvedValueOnce([{
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        modifiedMs: 1_700_000_000_000,
        pageCount: 2,
      }])
      .mockRejectedValueOnce(new Error('不是 Git 仓库'))
    render(
      <DesignHistoryPanel
        path=".pen/a.ax"
        expectedSha256={'b'.repeat(64)}
        onRestored={async () => undefined}
        onClose={() => undefined}
      />,
    )
    expect(await screen.findByText(/2 页/)).toBeTruthy()
    expect(await screen.findByText(/不是 Git 仓库/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复' })).toBeTruthy()
  })
})
