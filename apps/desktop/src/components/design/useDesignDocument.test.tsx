// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TRANSIENT_ERROR_SETTLE_MS,
  useDesignDocument,
} from './useDesignDocument'
import { readDesignDocument, writeDesignDocument } from '@/platform/designDocument'

const mocks = vi.hoisted(() => ({
  changeHandler: null as ((payload: { path: string }) => void) | null,
}))

vi.mock('@/platform/designDocument', () => ({
  readDesignDocument: vi.fn(async () => ({
    contentBase64: '',
    sha256: 'initial',
    sizeBytes: 0,
    modifiedMs: 1,
    unchanged: false,
  })),
  writeDesignDocument: vi.fn(async () => ({ sha256: 'written-sha', sizeBytes: 32 })),
  watchDesignDocument: vi.fn(async () => true),
  unwatchDesignDocument: vi.fn(async () => undefined),
  onDesignDocumentChanged: vi.fn(async (handler: (payload: { path: string }) => void) => {
    mocks.changeHandler = handler
    return () => undefined
  }),
}))

const PATH = '.pen/licensor.ax'

/** 最小 `.ax` 稿：wrap 合法时通过校验，非法值触发「wrap 必须是 …」校验错误。 */
const axDoc = (wrap: string): string =>
  JSON.stringify({
    ax: '1.2',
    tokens: {},
    components: {},
    pages: [
      {
        id: 'p1',
        name: 'P',
        width: 100,
        height: 100,
        tree: [{ id: 't1', kind: 'text', text: 'hi', wrap }],
      },
    ],
  })

const contentOf = (raw: string, sha: string) => ({
  contentBase64: btoa(raw),
  sha256: sha,
  sizeBytes: raw.length,
  modifiedMs: 1,
  unchanged: false,
})

/** 推进防抖（120ms）触发变更重读并等 load 完成。 */
const emitChange = async (): Promise<void> => {
  await act(async () => {
    mocks.changeHandler?.({ path: PATH })
    await vi.advanceTimersByTimeAsync(120)
  })
}

describe('useDesignDocument 编辑期坏稿暂缓（last-good hold）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.changeHandler = null
    vi.mocked(readDesignDocument).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const renderAt = (authorActive: boolean) =>
    renderHook(({ active }) => useDesignDocument(PATH, { authorActive: active }), {
      initialProps: { active: authorActive },
    })

  const settle = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('编辑期合法中间态实时采纳（作者在写不阻塞合法内容上画布）', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-1'))
      .mockResolvedValueOnce(contentOf(axDoc('width-height'), 'sha-2'))
    const { result, rerender } = renderAt(true)
    await settle()
    expect(result.current.loaded?.sha256).toBe('sha-1')
    rerender({ active: true })
    await emitChange()
    expect(result.current.loaded?.sha256).toBe('sha-2')
    expect(result.current.holding).toBe(false)
  })

  it('编辑期坏稿暂缓：画布保持上一版合法内容，错误挂起不呈现', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-good'))
      .mockResolvedValue(contentOf(axDoc('auto'), 'sha-bad'))
    const { result } = renderAt(true)
    await settle()
    expect(result.current.loaded?.sha256).toBe('sha-good')
    await emitChange()
    // 画布仍是上一版；挂起态成立，错误文本可查看但不进 loaded.parseError。
    expect(result.current.loaded?.sha256).toBe('sha-good')
    expect(result.current.loaded?.document).not.toBeNull()
    expect(result.current.holding).toBe(true)
    expect(result.current.heldError).toContain('wrap')
    expect(result.current.loaded?.parseError).toBeNull()
    // 编辑期不武装静默窗：挂起远超静默窗时长也不落错误。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSIENT_ERROR_SETTLE_MS * 3)
    })
    expect(result.current.holding).toBe(true)
    expect(result.current.loaded?.sha256).toBe('sha-good')
  })

  it('作者收笔（运行翻转 false）时挂起的坏稿立即呈现', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-good'))
      .mockResolvedValue(contentOf(axDoc('auto'), 'sha-bad'))
    const { result, rerender } = renderAt(true)
    await settle()
    await emitChange()
    expect(result.current.holding).toBe(true)
    rerender({ active: false })
    await settle()
    expect(result.current.holding).toBe(false)
    expect(result.current.loaded?.sha256).toBe('sha-bad')
    expect(result.current.loaded?.parseError).toContain('wrap')
  })

  it('挂起后内容转好：采纳新稿并清掉挂起态（收笔不再落旧错误）', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-good'))
      .mockResolvedValueOnce(contentOf(axDoc('auto'), 'sha-bad'))
      .mockResolvedValue(contentOf(axDoc('width'), 'sha-fixed'))
    const { result, rerender } = renderAt(true)
    await settle()
    await emitChange()
    expect(result.current.holding).toBe(true)
    await emitChange()
    expect(result.current.holding).toBe(false)
    expect(result.current.loaded?.sha256).toBe('sha-fixed')
    rerender({ active: false })
    await settle()
    expect(result.current.loaded?.sha256).toBe('sha-fixed')
  })

  it('收笔呈现坏稿后作者又开写：画布退回上一版合法内容（不再停在错误面板）', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-good'))
      .mockResolvedValueOnce(contentOf(axDoc('auto'), 'sha-bad'))
      // 第二轮编辑又写坏：内容换代（sha 变化），同 sha 重复读取会被短路（正确行为）。
      .mockResolvedValue(contentOf(axDoc('auto'), 'sha-bad-2'))
    const { result, rerender } = renderAt(true)
    await settle()
    await emitChange()
    rerender({ active: false })
    await settle()
    expect(result.current.loaded?.parseError).toContain('wrap')
    rerender({ active: true })
    await emitChange()
    expect(result.current.holding).toBe(true)
    expect(result.current.loaded?.sha256).toBe('sha-good')
    expect(result.current.loaded?.parseError).toBeNull()
  })

  it('打开即坏稿且无作者在写：立即呈现（评审面不隐藏真实错误）', async () => {
    vi.mocked(readDesignDocument).mockResolvedValue(contentOf(axDoc('auto'), 'sha-bad'))
    const { result } = renderAt(false)
    await settle()
    expect(result.current.loaded?.document).toBeNull()
    expect(result.current.loaded?.parseError).toContain('wrap')
    expect(result.current.holding).toBe(false)
  })

  it('打开即坏稿但作者在写：挂起等收笔（骨架分多次写盘的中间态不闪错）', async () => {
    vi.mocked(readDesignDocument).mockResolvedValue(contentOf(axDoc('auto'), 'sha-bad'))
    const { result, rerender } = renderAt(true)
    await settle()
    expect(result.current.loaded).toBeNull()
    expect(result.current.holding).toBe(true)
    rerender({ active: false })
    await settle()
    expect(result.current.loaded?.parseError).toContain('wrap')
  })

  it('非编辑期坏稿走静默窗：窗内不闪错，窗停仍坏才呈现；窗内转好则不呈现', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-good'))
      .mockResolvedValueOnce(contentOf(axDoc('auto'), 'sha-bad'))
      .mockResolvedValue(contentOf(axDoc('width'), 'sha-fixed'))
    const { result } = renderAt(false)
    await settle()
    expect(result.current.loaded?.sha256).toBe('sha-good')
    await emitChange()
    expect(result.current.holding).toBe(true)
    expect(result.current.loaded?.sha256).toBe('sha-good')
    // 窗内转好：采纳并清挂起，静默窗到期也不落错误。
    await emitChange()
    expect(result.current.holding).toBe(false)
    expect(result.current.loaded?.sha256).toBe('sha-fixed')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSIENT_ERROR_SETTLE_MS + 120)
    })
    expect(result.current.loaded?.sha256).toBe('sha-fixed')
  })

  it('非编辑期坏稿静默窗到期仍坏：呈现错误', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-good'))
      .mockResolvedValue(contentOf(axDoc('auto'), 'sha-bad'))
    const { result } = renderAt(false)
    await settle()
    await emitChange()
    expect(result.current.holding).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSIENT_ERROR_SETTLE_MS)
    })
    expect(result.current.holding).toBe(false)
    expect(result.current.loaded?.sha256).toBe('sha-bad')
    expect(result.current.loaded?.parseError).toContain('wrap')
  })
})

describe('useDesignDocument 基础订阅（回归）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.changeHandler = null
    vi.mocked(readDesignDocument).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('无路径时不订阅，loaded 为空', async () => {
    const { result } = renderHook(() => useDesignDocument(null))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.loaded).toBeNull()
    expect(vi.mocked(readDesignDocument)).not.toHaveBeenCalled()
  })

  it('合法 .ax 稿解析并投影为画布视图模型', async () => {
    vi.mocked(readDesignDocument).mockResolvedValue(contentOf(axDoc('width'), 'sha-ok'))
    const { result } = renderHook(() => useDesignDocument(PATH))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.loaded?.document).not.toBeNull()
    expect(result.current.loaded?.document?.pages.length).toBe(1)
  })
})

describe('useDesignDocument deletePage（.ax 页级删除通道）', () => {
  const axTwoPageDoc = (): string =>
    JSON.stringify({
      ax: '1.2',
      tokens: {},
      components: {},
      pages: [
        { id: 'p1', name: 'A', width: 100, height: 100, tree: [] },
        { id: 'p2', name: 'B', width: 100, height: 100, tree: [] },
      ],
    })

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.changeHandler = null
    vi.mocked(readDesignDocument).mockReset()
    vi.mocked(writeDesignDocument).mockClear()
    vi.mocked(writeDesignDocument).mockResolvedValue({ sha256: 'written-sha', sizeBytes: 32 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const settle = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('删除成功：CAS 绑定当前 sha 写盘，本地采纳单页新投影', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axTwoPageDoc(), 'sha-base'))
      .mockResolvedValueOnce(contentOf(axTwoPageDoc(), 'sha-base'))
    const { result } = renderHook(() => useDesignDocument(PATH))
    await settle()
    expect(result.current.loaded?.sha256).toBe('sha-base')
    const outcome = await act(async () => result.current.deletePage('p2'))
    expect(outcome.ok).toBe(true)
    expect(vi.mocked(writeDesignDocument)).toHaveBeenCalledTimes(1)
    const [path, base64, expected] = vi.mocked(writeDesignDocument).mock.calls[0]
    expect(path).toBe(PATH)
    expect(expected).toBe('sha-base')
    const written = JSON.parse(atob(base64)) as { pages: Array<{ id: string }> }
    expect(written.pages.map((page) => page.id)).toEqual(['p1'])
    // 本地采纳：画布立即少一页且 sha 推进（下一次轮询被短路）。
    expect(result.current.loaded?.sha256).toBe('written-sha')
    expect(result.current.loaded?.document?.pages.length).toBe(1)
  })

  it('盘上已被外部修改（sha 不一致）时拒绝删除且不写盘', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axTwoPageDoc(), 'sha-base'))
      .mockResolvedValue(contentOf(axTwoPageDoc(), 'sha-external'))
    const { result } = renderHook(() => useDesignDocument(PATH))
    await settle()
    const outcome = await act(async () => result.current.deletePage('p2'))
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('外部修改')
    expect(vi.mocked(writeDesignDocument)).not.toHaveBeenCalled()
  })

  it('摘除后整稿校验不过（pages 摘空）则不落盘（fail-closed）', async () => {
    // 单页稿：UI 层有「至少一页」守卫，这里是通道自身的兜底——校验器拒绝空 pages。
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-one'))
      .mockResolvedValueOnce(contentOf(axDoc('width'), 'sha-one'))
    const { result } = renderHook(() => useDesignDocument(PATH))
    await settle()
    const outcome = await act(async () => result.current.deletePage('p1'))
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('非空')
    expect(vi.mocked(writeDesignDocument)).not.toHaveBeenCalled()
  })

  it('未知页 id 返回失败', async () => {
    vi.mocked(readDesignDocument)
      .mockResolvedValueOnce(contentOf(axTwoPageDoc(), 'sha-base'))
      .mockResolvedValueOnce(contentOf(axTwoPageDoc(), 'sha-base'))
    const { result } = renderHook(() => useDesignDocument(PATH))
    await settle()
    const outcome = await act(async () => result.current.deletePage('nope'))
    expect(outcome.ok).toBe(false)
    expect(vi.mocked(writeDesignDocument)).not.toHaveBeenCalled()
  })

  it('.pen 路径不走该通道（.pen 删除走画布编辑层）', async () => {
    const penRaw = JSON.stringify({
      version: '2.18',
      children: [{ type: 'frame', id: 'page-1', width: 100, height: 100 }],
    })
    vi.mocked(readDesignDocument).mockResolvedValue(contentOf(penRaw, 'sha-pen'))
    const { result } = renderHook(() => useDesignDocument('.pen/x.pen'))
    await settle()
    const outcome = await act(async () => result.current.deletePage('page-1'))
    expect(outcome.ok).toBe(false)
    expect(vi.mocked(writeDesignDocument)).not.toHaveBeenCalled()
  })
})
