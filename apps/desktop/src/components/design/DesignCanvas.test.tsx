// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import DesignCanvas, { computePageSnap, PAGE_SNAP_THRESHOLD_SCREEN_PX } from './DesignCanvas'
import { parsePenDocument } from '@/agent/design/penParser'
import type { PenDocument } from '@/agent/design/penParser'
import { setDesignScanPageRenderProvider } from '@/agent/design/designRenderHost'
import { useUiStore } from '@/stores/uiStore'
import { exportDesignPng, writeDesignDocument } from '@/platform/designDocument'

vi.mock('@/platform/designDocument', () => ({
  readDesignDocumentAsset: vi.fn(async () => ({
    contentBase64: 'aGk=',
    mediaType: 'image/png',
    sha256: 'x',
  })),
  exportDesignPng: vi.fn(async () => '/tmp/首页.png'),
  writeDesignDocument: vi.fn(async () => ({ sha256: 'written-sha', sizeBytes: 32 })),
}))

vi.mock('./ax/renderPageHost', () => ({
  renderPenPageToPngBase64: vi.fn(async () => 'UE5HQkFTRTY0'),
}))

interface RawFixture {
  version?: string
  children: Record<string, unknown>[]
}

const buildDoc = (raw: RawFixture, fileName = '.pen/axiom.pen'): { doc: PenDocument; rawJson: string } => {
  const rawJson = JSON.stringify(raw)
  const { document } = parsePenDocument(rawJson, fileName)
  if (!document) throw new Error('fixture parse failed')
  return { doc: document, rawJson }
}

const TWO_PAGES: RawFixture = {
  version: '2.18',
  children: [
    { type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120 },
    { type: 'frame', id: 'page-2', name: '设置', x: 320, y: 0, width: 200, height: 120 },
  ],
}

const decodeWrite = (call: number) => {
  const calls = vi.mocked(writeDesignDocument).mock.calls
  if (call >= calls.length) throw new Error(`write call ${call} not made`)
  const [path, base64, expected] = calls[call]
  return { path, expected, json: JSON.parse(atob(base64)) as RawFixture }
}

/** 画布选择语义在 pointerup（无位移）而非 click：统一从这里派发。 */
const tapNode = (element: Element): void => {
  fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
  fireEvent.pointerUp(element, { pointerId: 1, clientX: 10, clientY: 10 })
}

describe('DesignCanvas 无限画布', () => {
  const requestComposerInsertion = vi.fn()

  beforeAll(() => {
    // jsdom 无 matchMedia：画布主题跟随用 matchMedia 读 system 档。
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    })
  })

  beforeEach(() => {
    requestComposerInsertion.mockClear()
    vi.mocked(writeDesignDocument).mockClear()
    vi.mocked(writeDesignDocument).mockResolvedValue({ sha256: 'written-sha', sizeBytes: 32 })
    useUiStore.setState({ requestComposerInsertion })
  })

  it('全部页铺在同一画布上（无页 tab），页卡片与标签在屏幕空间层', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    expect(document.querySelectorAll('[data-page-wrapper]')).toHaveLength(2)
    expect(screen.queryByRole('tab', { name: '设置' })).toBeNull()
    expect(document.querySelector('[data-pen-id="page-2"]')).not.toBeNull()
    // 页卡片（1px 屏幕空间边框）与标签逐页对齐。
    expect(document.querySelectorAll('.design-canvas__page-chrome')).toHaveLength(2)
    const labels = document.querySelectorAll('.design-canvas__page-label')
    expect(labels).toHaveLength(2)
    expect(labels[0]?.textContent).toContain('首页')
    expect(labels[0]?.textContent).toContain('200×120')
    // 标签不在变换面内：1/scale 反算由屏幕空间层承担，文字不随缩放变小。
    const surface = screen.getByTestId('design-canvas-surface')
    expect(surface.contains(labels[0] as Node)).toBe(false)
    expect(screen.getByTestId('design-canvas-page-layer').contains(labels[0] as Node)).toBe(true)
  })

  it('点标签选中整页并高亮该页卡片', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    const labels = document.querySelectorAll('.design-canvas__page-label')
    fireEvent.click(labels[1] as HTMLElement)
    expect(document.querySelector('[data-page-wrapper="page-2"]')?.getAttribute('data-page-selected')).toBe('true')
    expect(labels[1]?.classList.contains('is-selected')).toBe(true)
    // 选中的是页本身（检查器显示页名）——标签与检查器可能同名，故按类名定位。
    expect(document.querySelector('.design-canvas__inspector-name')?.textContent).toBe('设置')
  })

  it('缩放低于阈值时页卡片接管指针：点选归到整页而非页内小节点', () => {
    const { doc, rawJson } = buildDoc({
      children: [{
        type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120,
        children: [{ type: 'text', id: 'inner-1', content: '流内文本' }],
      }],
    })
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} />)
    // 1 → 0.8 → 0.6 → 0.4 → 0.2：进入低倍率区。
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByLabelText('缩小'))
    expect(screen.getByText('20%')).toBeTruthy()
    const chrome = document.querySelector('.design-canvas__page-chrome.is-pickable') as HTMLElement
    expect(chrome).not.toBeNull()
    expect(chrome.getAttribute('data-pen-id')).toBe('page-1')
    tapNode(chrome)
    // 选中的是整页（检查器显示页名 首页），而非它内部的 inner-1。
    expect(document.querySelector('.design-canvas__inspector-name')?.textContent).toBe('首页')
    expect(document.querySelector('.design-canvas__inspector-type')?.textContent).toBe('frame')
    expect(screen.queryByLabelText('文本')).toBeNull()
  })

  it('页标签上的指针事件不启动画布平移（指针捕获会吞掉标签自身的 click/dblclick）', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    const surface = screen.getByTestId('design-canvas-surface')
    expect(surface.style.transform).toContain('translate(0px, 0px)')
    const label = document.querySelector('.design-canvas__page-label') as HTMLElement
    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 120, clientY: 60 })
    fireEvent.pointerUp(label, { pointerId: 1, clientX: 120, clientY: 60 })
    // 画布未被平移：标签上的按下不进入 pan 交互。
    expect(surface.style.transform).toContain('translate(0px, 0px)')
  })

  it('拖动页标签移动该页（任何缩放级别都可靠的抓手）', async () => {
    const { doc, rawJson } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} />)
    const label = document.querySelector('.design-canvas__page-label') as HTMLElement
    expect(label.getAttribute('data-page-id')).toBe('page-1')
    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 80, clientY: 40 })
    fireEvent.pointerUp(label, { pointerId: 1, clientX: 80, clientY: 40 })
    await waitFor(() => expect(writeDesignDocument).toHaveBeenCalledTimes(1))
    expect(decodeWrite(0).json.children[0]).toMatchObject({ id: 'page-1', x: 80, y: 40 })
  })

  it('.ax 评审面拖页：不写文件，位置进 localStorage 叠加层并驱动画布重排', () => {
    window.localStorage.removeItem('axiom.design.page-layout.v1')
    const { doc } = buildDoc(
      { version: '1.1', children: [
        { type: 'frame', id: 'page-1', name: '会话', width: 200, height: 120, children: [
          { type: 'text', id: 'inner-1', content: '内容' },
        ] },
        { type: 'frame', id: 'page-2', name: '设置', width: 200, height: 120 },
      ] },
      '.pen/design.ax',
    )
    render(<DesignCanvas doc={doc} />)
    const wrapper = document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement
    // 无坐标页的自动排布位（内容从 0 开始排，首行 y = AUTO_LAYOUT_GAP）。
    const baseLeft = wrapper.style.left
    const inner = document.querySelector('[data-pen-id="inner-1"]') as HTMLElement
    fireEvent.pointerDown(inner, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(inner, { pointerId: 1, clientX: 60, clientY: 30 })
    fireEvent.pointerUp(inner, { pointerId: 1, clientX: 60, clientY: 30 })
    // 评审面不写文件；叠加层驱动 wrapper 重排到新位置。
    expect(writeDesignDocument).not.toHaveBeenCalled()
    expect(wrapper.style.left).toBe(`${Number.parseFloat(baseLeft) + 60}px`)
    expect(wrapper.style.top).toBe(`${120 + 30}px`)
    const stored = JSON.parse(window.localStorage.getItem('axiom.design.page-layout.v1') ?? '{}') as {
      '.pen/design.ax'?: Record<string, { x: number; y: number }>
    }
    expect(stored['.pen/design.ax']?.['page-1']).toEqual({ x: 60, y: 150 })
    window.localStorage.removeItem('axiom.design.page-layout.v1')
  })

  it('双击页标签聚焦该页：内容远大于视口时按可读下限放大（而非缩成色块）', () => {
    const { doc } = buildDoc({
      children: [{ type: 'frame', id: 'big', name: '巨页', x: 0, y: 0, width: 4000, height: 3000 }],
    })
    render(<DesignCanvas doc={doc} />)
    const viewport = screen.getByTestId('design-canvas-surface').parentElement as HTMLElement
    viewport.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 1000, height: 700, top: 0, left: 0, right: 1000, bottom: 700,
      toJSON: () => ({}),
    }) as DOMRect
    fireEvent.doubleClick(document.querySelector('.design-canvas__page-label') as HTMLElement)
    expect(screen.getByText('25%')).toBeTruthy()
  })

  it('点选节点高亮并可引用到会话；点击空白取消选中', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    tapNode(document.querySelector('[data-pen-id="page-1"]') as HTMLElement)
    expect(document.querySelector('[data-pen-id="page-1"]')?.classList.contains('is-selected')).toBe(true)
    fireEvent.click(screen.getByText('引用到会话'))
    expect(requestComposerInsertion).toHaveBeenCalledWith(
      '@[首页](.pen/axiom.pen)（design_query nodeId: page-1）',
    )
    tapNode(screen.getByTestId('design-canvas-surface'))
    expect(document.querySelector('[data-pen-id="page-1"]')?.classList.contains('is-selected')).toBe(false)
    expect(screen.queryByText('引用到会话')).toBeNull()
  })

  it('拖动顶层页改 x/y 并经 write_design_document 写回', async () => {
    const { doc, rawJson } = buildDoc(TWO_PAGES)
    const onWritten = vi.fn()
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={onWritten} />)
    const page = document.querySelector('[data-pen-id="page-1"]') as HTMLElement
    fireEvent.pointerDown(page, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(page, { pointerId: 1, clientX: 160, clientY: 130 })
    fireEvent.pointerUp(page, { pointerId: 1, clientX: 160, clientY: 130 })
    await waitFor(() => expect(writeDesignDocument).toHaveBeenCalledTimes(1))
    const write = decodeWrite(0)
    expect(write.path).toBe('.pen/axiom.pen')
    expect(write.json.children[0]).toMatchObject({ id: 'page-1', x: 60, y: 30 })
    await waitFor(() => expect(onWritten).toHaveBeenCalledWith('written-sha'))
  })

  it('按住页内流子节点拖动 = 移动整页（写回页根 x/y）；点按（无位移）仍选中子节点', async () => {
    const { doc, rawJson } = buildDoc({
      children: [{
        type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120,
        children: [{ type: 'text', id: 'inner-1', content: '流内文本' }],
      }],
    })
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} />)
    const inner = document.querySelector('[data-pen-id="inner-1"]') as HTMLElement
    // 拖动：位置超出点击阈值 → 移动所属页（写回页根坐标，而非平移画布）。
    fireEvent.pointerDown(inner, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(inner, { pointerId: 1, clientX: 50, clientY: 20 })
    fireEvent.pointerUp(inner, { pointerId: 1, clientX: 50, clientY: 20 })
    await waitFor(() => expect(writeDesignDocument).toHaveBeenCalledTimes(1))
    expect(decodeWrite(0).json.children[0]).toMatchObject({ id: 'page-1', x: 50, y: 20 })
    const surface = screen.getByTestId('design-canvas-surface')
    expect(surface.style.transform).toContain('translate(0px, 0px)')
    // 点按（无位移）：仍选中按中的子节点，而不是页。
    const innerAfter = document.querySelector('[data-pen-id="inner-1"]') as HTMLElement
    tapNode(innerAfter)
    await waitFor(() => expect(screen.getByLabelText('文本')).toBeTruthy())
  })

  it('中键拖拽：无论落点一律平移画布（页面铺满视口时的平移出口）', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    const surface = screen.getByTestId('design-canvas-surface')
    const page = document.querySelector('[data-pen-id="page-1"]') as HTMLElement
    fireEvent.pointerDown(page, { button: 1, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(page, { pointerId: 1, clientX: 70, clientY: 40 })
    fireEvent.pointerUp(page, { pointerId: 1, clientX: 70, clientY: 40 })
    expect(surface.style.transform).toContain('translate(60px, 30px)')
  })

  it('删除选中页并写回；撤销恢复内容并再次写回', async () => {
    const { doc, rawJson } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} />)
    tapNode(document.querySelector('[data-pen-id="page-2"]') as HTMLElement)
    fireEvent.click(screen.getByText('删除'))
    await waitFor(() => expect(writeDesignDocument).toHaveBeenCalledTimes(1))
    expect(decodeWrite(0).json.children).toHaveLength(1)
    expect(decodeWrite(0).json.children[0]).toMatchObject({ id: 'page-1' })
    const undo = screen.getByLabelText('撤销')
    fireEvent.click(undo)
    await waitFor(() => expect(writeDesignDocument).toHaveBeenCalledTimes(2))
    expect(decodeWrite(1).json.children).toHaveLength(2)
  })

  it('检查器可编辑文本内容（blur 提交并写回）', async () => {
    const { doc, rawJson } = buildDoc({
      children: [{
        type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120,
        children: [{ type: 'text', id: 'text-1', content: 'hello', x: 10, y: 10, layoutPosition: 'absolute' }],
      }],
    })
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} />)
    tapNode(document.querySelector('[data-pen-id="text-1"]') as HTMLElement)
    const content = screen.getByLabelText('文本') as HTMLTextAreaElement
    expect(content.value).toBe('hello')
    fireEvent.change(content, { target: { value: 'world' } })
    fireEvent.blur(content)
    await waitFor(() => expect(writeDesignDocument).toHaveBeenCalledTimes(1))
    const page = decodeWrite(0).json.children[0] as { children: { id: string; content: string }[] }
    expect(page.children[0]).toMatchObject({ id: 'text-1', content: 'world' })
  })

  it('ref 实例内部节点只读：删除按钮禁用且不产生写回', () => {
    const { doc, rawJson } = buildDoc({
      children: [
        {
          type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120,
          children: [{ type: 'ref', id: 'inst-1', ref: 'comp-1' }],
        },
        { type: 'frame', id: 'comp-1', reusable: true, children: [{ type: 'text', id: 'comp-inner', content: 'body' }] },
      ],
    })
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} />)
    tapNode(document.querySelector('[data-pen-id="comp-inner"]') as HTMLElement)
    expect(screen.getByText('组件实例内部只读：请编辑组件定义')).toBeTruthy()
    expect((screen.getByText('删除') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByLabelText('文本')).toBeNull()
  })

  it('写盘失败（CAS 冲突）时显式报错、回滚本地并触发 reload', async () => {
    vi.mocked(writeDesignDocument).mockRejectedValueOnce(new Error('changed on disk'))
    const onReload = vi.fn()
    const { doc, rawJson } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} onReload={onReload} />)
    tapNode(document.querySelector('[data-pen-id="page-2"]') as HTMLElement)
    fireEvent.click(screen.getByText('删除'))
    expect(await screen.findByText(/保存失败：changed on disk/)).toBeTruthy()
    await waitFor(() => expect(onReload).toHaveBeenCalled())
    // 回滚后本地内容恢复：撤销写回不发生（失败组已出栈），重做按钮保持禁用。
    expect(screen.getByLabelText('重做')).toHaveProperty('disabled', true)
  })

  it('外部内容换代（sha256 变化）后整体采纳，撤销栈清空', () => {
    const first = buildDoc(TWO_PAGES)
    const second = buildDoc({
      children: [
        ...TWO_PAGES.children,
        { type: 'frame', id: 'page-3', name: '关于', x: 640, y: 0, width: 200, height: 120 },
      ],
    })
    const { rerender } = render(
      <DesignCanvas doc={first.doc} rawJson={first.rawJson} sha256="sha-1" onWritten={() => undefined} />,
    )
    expect(document.querySelectorAll('[data-page-wrapper]')).toHaveLength(2)
    rerender(
      <DesignCanvas doc={second.doc} rawJson={second.rawJson} sha256="sha-2" onWritten={() => undefined} />,
    )
    expect(document.querySelectorAll('[data-page-wrapper]')).toHaveLength(3)
    // 新内容即新基线：撤销被清空（不可撤销到外部已覆盖的历史）。
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', true)
  })

  it('缩放按钮与重置视图在上下限内取值', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('放大'))
    expect(screen.getByText('120%')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('缩小'))
    fireEvent.click(screen.getByLabelText('缩小'))
    expect(screen.getByText('80%')).toBeTruthy()
    fireEvent.click(screen.getByText('重置视图'))
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('滚轮平移画布，ctrl 滚轮缩放', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    const surface = screen.getByTestId('design-canvas-surface')
    const viewport = surface.parentElement as HTMLElement
    fireEvent.wheel(viewport, { deltaX: 40, deltaY: 20 })
    expect(surface.style.transform).toContain('translate(-40px, -20px)')
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -100 })
    expect(surface.style.transform).toContain('scale(3)')
    expect(screen.getByText('300%')).toBeTruthy()
  })

  it('解析诊断去重分组后可在状态栏展开', () => {
    const { doc } = buildDoc({ children: [{ type: 'browser', id: 'b1' }, { type: 'script', id: 's1' }] })
    render(<DesignCanvas doc={doc} />)
    const toggle = screen.getByText(/诊断：/)
    expect(toggle.textContent).toContain('0 错误')
    fireEvent.click(toggle)
    expect(document.querySelectorAll('.design-canvas__diagnostic').length).toBeGreaterThan(0)
  })

  it('导出选中页：先选中才可用，光栅化后交 Rust 保存并回显路径', async () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    const exportButton = screen.getByText('导出 PNG')
    expect((exportButton as HTMLButtonElement).disabled).toBe(true)
    tapNode(document.querySelector('[data-pen-id="page-1"]') as HTMLElement)
    expect((exportButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(exportButton)
    await waitFor(() =>
      expect(vi.mocked(exportDesignPng)).toHaveBeenCalledWith('首页.png', 'UE5HQkFTRTY0'),
    )
    expect(await screen.findByText('已导出 /tmp/首页.png')).toBeTruthy()
  })

  it('选中页内元素时导出其所属顶层页', async () => {
    const { doc } = buildDoc({
      children: [{
        type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120,
        children: [{ type: 'text', id: 'text-1', content: 'hi', x: 5, y: 5, layoutPosition: 'absolute' }],
      }],
    })
    render(<DesignCanvas doc={doc} />)
    tapNode(document.querySelector('[data-pen-id="text-1"]') as HTMLElement)
    fireEvent.click(screen.getByText('导出 PNG'))
    await waitFor(() => expect(vi.mocked(exportDesignPng)).toHaveBeenCalledWith('首页.png', 'UE5HQkFTRTY0'))
  })

  it('页码按文档序稳定编号，不随视口可见集合变化', () => {
    const { doc } = buildDoc({
      children: [
        { type: 'frame', id: 'a', name: 'A', x: 0, y: 0, width: 200, height: 120 },
        { type: 'frame', id: 'b', name: 'B', x: 400, y: 0, width: 200, height: 120 },
        { type: 'frame', id: 'c', name: 'C', x: 800, y: 0, width: 200, height: 120 },
      ],
    })
    render(<DesignCanvas doc={doc} />)
    const numberOf = (name: string) => {
      const label = [...document.querySelectorAll('.design-canvas__page-label')].find((item) =>
        item.textContent?.includes(name),
      )
      return label?.querySelector('.design-canvas__page-label-index')?.textContent
    }
    expect(numberOf('A')).toBe('1')
    expect(numberOf('B')).toBe('2')
    expect(numberOf('C')).toBe('3')
    // 缩放改变可见集合后页号不变（编号取文档序而非可见下标）。
    fireEvent.click(screen.getByLabelText('放大'))
    expect(numberOf('B')).toBe('2')
  })

  it('无高度的组织性 frame（Section / 组件展示区）不铺页底、不画卡片框、不臆造尺寸', () => {
    const { doc } = buildDoc({
      children: [
        { type: 'frame', id: 'page-1', name: '会话', x: 0, y: 160, width: 200, height: 120 },
        { type: 'frame', id: 'section-1', name: 'Section — 会话', x: 0, y: 0, width: 900 },
      ],
    })
    render(<DesignCanvas doc={doc} />)
    const page = document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement
    const section = document.querySelector('[data-page-wrapper="section-1"]') as HTMLElement
    // 页铺底（与画布底分开）；组织性 frame 不铺——它压在同组页面上，铺底会盖住页首内容。
    expect(page.style.background).not.toBe('')
    expect(section.style.background).toBe('')
    expect(document.querySelectorAll('.design-canvas__page-chrome')).toHaveLength(1)
    const labels = [...document.querySelectorAll('.design-canvas__page-label')]
    const sectionLabel = labels.find((item) => item.textContent?.includes('Section — 会话'))
    expect(sectionLabel?.textContent).not.toContain('900×240')
    // 组织性 frame 仍是可指认的页（文档序第 2 项），只是不冒充带尺寸的画布页。
    expect(sectionLabel?.querySelector('.design-canvas__page-label-index')?.textContent).toBe('2')
  })

  it('选中节点可转为实现提示词（结构化结构树注入 Composer）', () => {
    const { doc } = buildDoc(TWO_PAGES)
    render(<DesignCanvas doc={doc} />)
    tapNode(document.querySelector('[data-pen-id="page-1"]') as HTMLElement)
    fireEvent.click(screen.getByText('转为实现提示词'))
    const inserted = requestComposerInsertion.mock.calls.at(-1)?.[0] as string
    expect(inserted).toContain('从 .pen 设计稿提取的界面结构')
    expect(inserted).toContain('.pen/axiom.pen')
    expect(inserted).toContain('- frame "首页"')
  })
})

describe('DesignCanvas 扫描验证面板', () => {
  beforeAll(() => {
    // 本 describe 自己也要 matchMedia（画布主题跟随），describe 级 hook 不跨组共享。
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    })
  })

  afterAll(() => {
    setDesignScanPageRenderProvider(null)
  })

  afterEach(() => {
    setDesignScanPageRenderProvider(null)
  })

  const SCAN_PAGES: RawFixture = {
    version: '2.18',
    children: [
      {
        type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120,
        children: [{ type: 'text', id: 't-1', content: '内容', fontSize: 12 }],
      },
      { type: 'frame', id: 'page-2', name: '空页', x: 320, y: 0, width: 200, height: 120 },
    ],
  }

  it('打开面板即扫描：逐页报告 + 汇总，画布逐页点亮状态描边，点击问题页聚焦', async () => {
    setDesignScanPageRenderProvider(async (request) => ({
      ok: true as const,
      width: 200,
      height: 120,
      scale: 1,
      pageName: String(request.pageIdOrIndex),
      samples: 4000,
      distinctColors: 64,
      topColorFraction: 0.5,
    }))
    const { doc } = buildDoc(SCAN_PAGES)
    render(<DesignCanvas doc={doc} />)
    fireEvent.click(screen.getByText('扫描验证'))
    const panel = await waitFor(() => {
      const element = document.querySelector('[data-testid="design-scan-panel"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    // 空页（只有页根）→ warn；首页有内容 → ok。
    await waitFor(() => expect(panel.querySelector('.design-scan__page.is-warn')).not.toBeNull())
    expect(panel.querySelectorAll('.design-scan__page')).toHaveLength(2)
    expect(panel.textContent).toContain('1 警告')
    // fail 优先排序：空页行在首页行之前。
    const rows = [...panel.querySelectorAll('.design-scan__page')]
    expect(rows[0]!.className).toContain('is-warn')
    // 画布逐页点亮：warn 页有黄色描边，ok 页不描边；扫描结束后光束消失。
    expect(document.querySelector('.design-canvas__scan-marker.is-warn')).not.toBeNull()
    expect(document.querySelector('.design-canvas__scan-marker.is-fail')).toBeNull()
    expect(document.querySelector('.design-canvas__scan-beam')).toBeNull()
    // 点击问题页 → 画布选中并聚焦该页。
    fireEvent.click(rows[0]!)
    expect(document.querySelector('[data-page-wrapper="page-2"]')?.getAttribute('data-page-selected')).toBe('true')
    // 关闭面板：报告与画布描边一并收起。
    fireEvent.click(screen.getByText('关闭'))
    expect(document.querySelector('[data-testid="design-scan-panel"]')).toBeNull()
    expect(document.querySelector('.design-canvas__scan-marker')).toBeNull()
  })

  it('渲染失败页标红并给出可读原因（画布红色描边）', async () => {
    setDesignScanPageRenderProvider(async () => ({ ok: false as const, reason: '光栅化失败：无法创建画布上下文' }))
    const { doc } = buildDoc(SCAN_PAGES)
    render(<DesignCanvas doc={doc} />)
    fireEvent.click(screen.getByText('扫描验证'))
    const panel = (await waitFor(() => {
      const element = document.querySelector('[data-testid="design-scan-panel"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    }))
    await waitFor(() => expect(panel.querySelector('.design-scan__page.is-fail')).not.toBeNull())
    expect(panel.textContent).toContain('2 失败')
    expect(panel.textContent).toContain('光栅化失败')
    expect(document.querySelectorAll('.design-canvas__scan-marker.is-fail')).toHaveLength(2)
  })

  it('扫描进行中：在途页显示动态扫描光束（扫完即消失）', async () => {
    // 门控 provider：第一页渲染挂起，让「在途」状态稳定可断言。
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setDesignScanPageRenderProvider(async () => {
      await gate
      return {
        ok: true as const,
        width: 200,
        height: 120,
        scale: 1,
        pageName: 'gated',
        samples: 4000,
        distinctColors: 64,
        topColorFraction: 0.5,
      }
    })
    const { doc } = buildDoc(SCAN_PAGES)
    render(<DesignCanvas doc={doc} />)
    fireEvent.click(screen.getByText('扫描验证'))
    // 第一页在途：光束落在页 1 上；报告未出。
    await waitFor(() => expect(document.querySelector('.design-canvas__scan-beam')).not.toBeNull())
    expect(document.querySelector('.design-canvas__scan-beam')?.getAttribute('style')).toContain('left: 0px')
    release?.()
    await waitFor(() => expect(document.querySelector('.design-canvas__scan-beam')).toBeNull())
  })
})

describe('DesignCanvas .ax 页级删除', () => {
  const AX_TWO_PAGES = {
    version: '1.2',
    children: [
      { type: 'frame', id: 'page-1', name: '会话', width: 200, height: 120 },
      { type: 'frame', id: 'page-2', name: '设置', width: 200, height: 120 },
    ],
  }

  const renderAx = (
    onDeletePage?: (pageId: string) => Promise<{ ok: boolean; message: string | null }>,
    raw: RawFixture = AX_TWO_PAGES,
  ) => {
    const { doc } = buildDoc(raw, '.pen/design.ax')
    return render(<DesignCanvas doc={doc} onDeletePage={onDeletePage} />)
  }

  const selectPage = (id: string): void => {
    const label = document.querySelector(`[data-canvas-ui="page-label"][data-page-id="${id}"]`) as HTMLElement
    fireEvent.click(label)
  }

  it('选中页根后删除可点：两段式确认，第二次点击才调用删除通道', async () => {
    const onDeletePage = vi.fn(async () => ({ ok: true, message: null }))
    renderAx(onDeletePage)
    selectPage('page-2')
    const button = screen.getByRole('button', { name: '删除' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    // 第一次点击只武装确认态（`.ax` 无撤销栈，误点即真删）。
    fireEvent.click(button)
    expect(onDeletePage).not.toHaveBeenCalled()
    const armed = screen.getByRole('button', { name: '再点一次确认删除该页' }) as HTMLButtonElement
    expect(armed.disabled).toBe(false)
    fireEvent.click(armed)
    expect(onDeletePage).toHaveBeenCalledWith('page-2')
  })

  it('选中的是页内节点时删除禁用，提示评审面只读', () => {
    const onDeletePage = vi.fn(async () => ({ ok: true, message: null }))
    renderAx(
      onDeletePage,
      { version: '1.2', children: [
        { type: 'frame', id: 'page-1', name: '会话', width: 200, height: 120, children: [
          { type: 'text', id: 'inner-1', content: '内容' },
        ] },
        { type: 'frame', id: 'page-2', name: '设置', width: 200, height: 120 },
      ] },
    )
    const inner = document.querySelector('[data-pen-id="inner-1"]') as HTMLElement
    tapNode(inner)
    const button = screen.getByRole('button', { name: '删除' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('评审面只读')
    fireEvent.click(button)
    expect(onDeletePage).not.toHaveBeenCalled()
  })

  it('仅剩一页时删除禁用并说明原因（.ax 校验拒绝空 pages）', () => {
    renderAx(
      vi.fn(async () => ({ ok: true, message: null })),
      { version: '1.2', children: [{ type: 'frame', id: 'page-1', name: '会话', width: 200, height: 120 }] },
    )
    selectPage('page-1')
    const button = screen.getByRole('button', { name: '删除' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('至少要保留一页')
  })

  it('删除通道失败时 notice 显式报错，不静默', async () => {
    const onDeletePage = vi.fn(async () => ({ ok: false, message: 'boom' }))
    renderAx(onDeletePage)
    selectPage('page-1')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(await screen.findByRole('button', { name: '再点一次确认删除该页' }))
    expect(await screen.findByText('删除失败：boom')).toBeTruthy()
  })

  it('未提供删除通道时按钮禁用（对比列等只读场景不传 onDeletePage）', () => {
    renderAx()
    selectPage('page-1')
    const button = screen.getByRole('button', { name: '删除' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})

describe('computePageSnap（页面拖动吸附）', () => {
  const placement = (id: string, x: number, y: number, width = 200, height = 120) =>
    ({ page: { id }, x, y, width, height, hasHeight: true }) as Parameters<typeof computePageSnap>[0][number]
  const placements = [placement('a', 0, 0), placement('b', 210, 0)]

  it('拖动页右缘距其它页左缘 ≤ 阈值时吸附到贴合对齐，参考线段覆盖两页', () => {
    // raw dx=4 → 右缘 204，距 b 左缘 210 差 6（恰在阈值）→ 右缘吸附贴合到 210。
    const snap = computePageSnap(placements, 'a', 0, 0, 4, 0, PAGE_SNAP_THRESHOLD_SCREEN_PX)
    expect(snap.dx).toBe(10)
    expect(snap.guideX).toEqual({ value: 210, start: 0, end: 120 })
    // 两页顶边本就同在 y=0：水平参考线合法并存（覆盖吸附后的联合 x 范围）。
    expect(snap.guideY).toEqual({ value: 0, start: 10, end: 410 })
  })

  it('中心轴吸附：拖动页中线对齐其它页中线', () => {
    // b 更窄（100 宽）让中线命中唯一：a 中线 100+346=446 距 b 中线 450 差 4，
    // a 左缘 346/右缘 546 距 b 各轴均超阈值 → 中线吸附唯一命中。
    const two = [placement('a', 0, 0), placement('b', 400, 0, 100, 120)]
    const snap = computePageSnap(two, 'a', 0, 0, 346, 0, PAGE_SNAP_THRESHOLD_SCREEN_PX)
    expect(snap.dx).toBe(350)
    expect(snap.guideX?.value).toBe(450)
  })

  it('超阈值不吸附（自由落点）', () => {
    // dx=20 → a 右缘 220 距 b 左缘 210 差 10（>6），其余轴更远 → 不吸附。
    const snap = computePageSnap(placements, 'a', 0, 0, 20, 0, PAGE_SNAP_THRESHOLD_SCREEN_PX)
    expect(snap.dx).toBe(20)
    expect(snap.guideX).toBeNull()
  })

  it('拖动页自身不参与吸附候选（单页画布永远自由落点）', () => {
    const single = [placement('a', 0, 0)]
    const snap = computePageSnap(single, 'a', 0, 0, 33, 44, PAGE_SNAP_THRESHOLD_SCREEN_PX)
    expect(snap.dx).toBe(33)
    expect(snap.dy).toBe(44)
    expect(snap.guideX).toBeNull()
  })

  it('y 轴吸附：下缘距其它页上缘差 6（恰在阈值）→ 贴合对齐', () => {
    const two = [placement('a', 0, 0), placement('b', 0, 130)]
    // dy=4 → a 下缘 124 距 b 上缘 130 差 6（唯一命中；a 上缘 4 距 b 上缘 130 差 126）。
    const snap = computePageSnap(two, 'a', 0, 0, 0, 4, PAGE_SNAP_THRESHOLD_SCREEN_PX)
    expect(snap.dy).toBe(10)
    expect(snap.guideY).toEqual({ value: 130, start: 0, end: 200 })
  })

  it('y 轴吸附：下缘贴合其它页上缘（唯一近轴）', () => {
    const two = [placement('a', 0, 0), placement('b', 0, 128)]
    // dy=4 → a 下缘 124 距 b 上缘 128 差 4（唯一命中）→ a 下缘贴合 128。
    const snap = computePageSnap(two, 'a', 0, 0, 0, 4, PAGE_SNAP_THRESHOLD_SCREEN_PX)
    expect(snap.dy).toBe(8)
    expect(snap.guideY).toEqual({ value: 128, start: 0, end: 200 })
  })
})

describe('画布拖动吸附集成', () => {
  it('.ax 评审面拖页接近其它页边缘时吸附到精确对齐，参考线拖动中出现、松手消失', () => {
    window.localStorage.removeItem('axiom.design.page-layout.v1')
    const { doc } = buildDoc(
      { version: '1.1', children: [
        { type: 'frame', id: 'page-1', name: '会话', width: 200, height: 120, children: [
          { type: 'text', id: 'inner-1', content: '内容' },
        ] },
        { type: 'frame', id: 'page-2', name: '设置', x: 210, y: 0, width: 200, height: 120 },
      ] },
      '.pen/design.ax',
    )
    render(<DesignCanvas doc={doc} />)
    const wrapper = document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement
    const page2 = document.querySelector('[data-page-wrapper="page-2"]') as HTMLElement
    // 无坐标页自动排在 page-2 正下方（x=210，y = 120+GAP）：上拖让上缘逼近
    // page-2 下缘（120）阈值内 → 吸附精确贴合。
    const baseTop = Number.parseFloat(wrapper.style.top)
    const target = Number.parseFloat(page2.style.top) + Number.parseFloat(page2.style.height)
    // 向上拖 clientY 为负：raw 位移 = -(baseTop - target - 4)，落点距目标差 4（≤6）。
    const dragDy = -(baseTop - target - 4)
    const inner = document.querySelector('[data-pen-id="inner-1"]') as HTMLElement
    fireEvent.pointerDown(inner, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(inner, { pointerId: 1, clientX: 0, clientY: dragDy })
    expect(document.querySelector('.design-canvas__snap-guide')).not.toBeNull()
    fireEvent.pointerUp(inner, { pointerId: 1, clientX: 0, clientY: dragDy })
    // 提交坐标是吸附后的（上缘精确贴合 120），不是自由落点的 baseTop-rawDy+... 。
    expect(writeDesignDocument).not.toHaveBeenCalled()
    expect(wrapper.style.top).toBe(`${target}px`)
    expect(document.querySelector('.design-canvas__snap-guide')).toBeNull()
    const stored = JSON.parse(window.localStorage.getItem('axiom.design.page-layout.v1') ?? '{}') as {
      '.pen/design.ax'?: Record<string, { x: number; y: number }>
    }
    expect(stored['.pen/design.ax']?.['page-1']?.y).toBe(target)
    window.localStorage.removeItem('axiom.design.page-layout.v1')
  })

  it('.pen 编辑态拖页同样吸附（页根 x/y 写回吸附后坐标）', async () => {
    const { doc, rawJson } = buildDoc({
      children: [
        { type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120, children: [] },
        { type: 'frame', id: 'page-2', name: '设置', x: 210, y: 0, width: 200, height: 120 },
      ],
    })
    render(<DesignCanvas doc={doc} rawJson={rawJson} sha256="sha-1" onWritten={() => undefined} />)
    const page = document.querySelector('[data-pen-id="page-1"]') as HTMLElement
    fireEvent.pointerDown(page, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(page, { pointerId: 1, clientX: 114, clientY: 100 })
    fireEvent.pointerUp(page, { pointerId: 1, clientX: 114, clientY: 100 })
    await waitFor(() => expect(writeDesignDocument).toHaveBeenCalledTimes(1))
    // 右缘 214 吸附到 210 → x = 10。
    expect(decodeWrite(0).json.children[0]).toMatchObject({ id: 'page-1', x: 10, y: 0 })
  })
})
