// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  distanceToBottom,
  nextStickyState,
  shouldStickToOutput,
  useStickyScroll,
} from './useStickyScroll'

interface FakeLayout {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

/**
 * jsdom 没有布局引擎：scrollHeight / clientHeight 恒为 0，scrollTop 写入也不生效。
 * 这里给容器装一份可编程的假布局，行为对齐浏览器（写入按最大滚动位置夹取）。
 */
const applyFakeLayout = (element: HTMLElement, layout: FakeLayout): void => {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => layout.scrollHeight,
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => layout.clientHeight,
  })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => layout.scrollTop,
    set: (value: number) => {
      const max = Math.max(0, layout.scrollHeight - layout.clientHeight)
      layout.scrollTop = Math.min(Math.max(0, value), max)
      // 浏览器在滚动位置变化后会派发 scroll 事件，程序化贴底同样如此。
      element.dispatchEvent(new Event('scroll'))
    },
  })
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  private readonly callback: ResizeObserverCallback
  observed: Element[] = []

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.push(element)
  }

  unobserve(element: Element): void {
    this.observed = this.observed.filter((item) => item !== element)
  }

  disconnect(): void {
    this.observed = []
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

let frames: FrameRequestCallback[] = []

const flushFrames = (): void => {
  const pending = frames
  frames = []
  pending.forEach((callback) => {
    callback(0)
  })
}

const Harness = ({ trigger }: { trigger: number }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  useStickyScroll({
    containerRef,
    contentRef,
    scrollTrigger: trigger,
    resetKey: 'session-1',
  })
  return (
    <div data-testid="container" ref={containerRef}>
      <div data-testid="content" ref={contentRef} />
    </div>
  )
}

beforeEach(() => {
  frames = []
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('distanceToBottom', () => {
  it('measures the gap between the content end and the viewport end', () => {
    expect(distanceToBottom({ clientHeight: 300, scrollHeight: 1_000, scrollTop: 700 })).toBe(0)
    expect(distanceToBottom({ clientHeight: 300, scrollHeight: 1_000, scrollTop: 400 })).toBe(300)
  })
})

describe('shouldStickToOutput', () => {
  it('treats the reader as attached while near the bottom', () => {
    expect(shouldStickToOutput({ scrollHeight: 1_000, scrollTop: 620, clientHeight: 300 })).toBe(true)
    expect(shouldStickToOutput({ scrollHeight: 1_000, scrollTop: 400, clientHeight: 300 })).toBe(false)
  })
})

describe('nextStickyState', () => {
  it('keeps following while the reader stays within the bottom threshold', () => {
    expect(nextStickyState(false, {
      distanceToBottom: 10,
      lastScrollTop: 700,
      scrollTop: 690,
      threshold: 96,
    })).toBe(true)
  })

  it('detaches when the reader scrolls up', () => {
    expect(nextStickyState(true, {
      distanceToBottom: 300,
      lastScrollTop: 700,
      scrollTop: 400,
      threshold: 96,
    })).toBe(false)
  })

  it('keeps the current state when the content grows beyond the bottom', () => {
    expect(nextStickyState(true, {
      distanceToBottom: 300,
      lastScrollTop: 400,
      scrollTop: 400,
      threshold: 96,
    })).toBe(true)
    expect(nextStickyState(false, {
      distanceToBottom: 300,
      lastScrollTop: 400,
      scrollTop: 400,
      threshold: 96,
    })).toBe(false)
  })
})

describe('useStickyScroll', () => {
  it('keeps the output pinned to the bottom when the content grows', () => {
    const { getByTestId, rerender } = render(<Harness trigger={0} />)
    const container = getByTestId('container')
    const layout: FakeLayout = { scrollHeight: 1_000, clientHeight: 300, scrollTop: 0 }
    applyFakeLayout(container, layout)

    rerender(<Harness trigger={1} />)
    act(() => flushFrames())
    expect(layout.scrollTop).toBe(700)

    // 流式输出在下一帧才落到 DOM：内容变高由 ResizeObserver 兜住。
    layout.scrollHeight = 1_200
    act(() => FakeResizeObserver.instances[0].trigger())
    act(() => flushFrames())
    expect(layout.scrollTop).toBe(900)
    expect(distanceToBottom({
      clientHeight: layout.clientHeight,
      scrollHeight: layout.scrollHeight,
      scrollTop: layout.scrollTop,
    })).toBe(0)
  })

  it('stops following once the reader scrolls up and resumes at the bottom', () => {
    const { getByTestId, rerender } = render(<Harness trigger={0} />)
    const container = getByTestId('container')
    const layout: FakeLayout = { scrollHeight: 1_000, clientHeight: 300, scrollTop: 0 }
    applyFakeLayout(container, layout)

    rerender(<Harness trigger={1} />)
    act(() => flushFrames())
    expect(layout.scrollTop).toBe(700)

    // 用户向上滚动 → 停止跟随。
    act(() => {
      container.scrollTop = 400
    })
    layout.scrollHeight = 1_200
    act(() => FakeResizeObserver.instances[0].trigger())
    act(() => flushFrames())
    expect(layout.scrollTop).toBe(400)

    // 滚回底部 → 跟随恢复。
    act(() => {
      container.scrollTop = container.scrollHeight
    })
    act(() => FakeResizeObserver.instances[0].trigger())
    act(() => flushFrames())
    expect(layout.scrollTop).toBe(900)
  })
})
