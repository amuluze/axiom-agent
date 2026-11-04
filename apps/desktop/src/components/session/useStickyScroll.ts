import { useCallback, useEffect, useRef, type RefObject } from 'react'

/**
 * 流式输出场景下的"贴底跟随"控制。
 *
 * 两条与旧实现不同的判定口径：
 * - **跟随与否看滚动意图，不看锚点可见性**。旧实现用 IntersectionObserver 监视
 *   末尾锚点：内容长高那一帧锚点必然短暂移出视口，IO 回调把"是否贴底"直接写成
 *   false，此后无论内容怎么增长都不再跟随——表现为会话窗口停在旧输出、需要手动下滑。
 *   现在改为：只有用户**向上**滚动（scrollTop 变小）才判定为回看历史并停止跟随；
 *   距底部回到阈值内即自动恢复跟随。
 * - **何时贴底由内容高度驱动**。流式文本在下一帧才提交 DOM、图片与折叠块异步撑高、
 *   content-visibility 渲染后真实高度替换占位高度——这些都靠 ResizeObserver 覆盖，
 *   不再依赖某一帧恰好读到最新的 scrollHeight（读到旧高度就会贴底失败一格）。
 */

export interface ScrollMetrics {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

/** 距底部的距离（px）；0 表示已贴底。 */
export const distanceToBottom = (metrics: ScrollMetrics): number =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight

/** 距底部在阈值内即视为仍处于"贴底"状态。 */
export const shouldStickToOutput = (metrics: ScrollMetrics, threshold = 96): boolean =>
  distanceToBottom(metrics) <= threshold

export interface StickyIntent {
  /** 当前距底部的距离（px）。 */
  distanceToBottom: number
  /** 上一次滚动事件时的 scrollTop。 */
  lastScrollTop: number
  /** 当前 scrollTop。 */
  scrollTop: number
  /** 贴底阈值（px）。 */
  threshold: number
}

/**
 * 一次滚动之后的贴底状态：
 * - 已到底（距离在阈值内）→ 继续跟随；
 * - 向上滚动 → 停止跟随（用户正在回看历史）；
 * - 其余（内容长高把视口顶离底部、向下滚动但尚未到底）→ 维持原状态。
 */
export const nextStickyState = (current: boolean, intent: StickyIntent): boolean => {
  if (intent.distanceToBottom <= intent.threshold) return true
  if (intent.scrollTop < intent.lastScrollTop) return false
  return current
}

export interface StickyScrollOptions {
  /** 滚动容器。 */
  containerRef: RefObject<HTMLElement | null>
  /** 被跟随的内容元素：它的高度变化即代表有新输出。 */
  contentRef: RefObject<HTMLElement | null>
  /** 触发"尝试贴底"的依赖（如 messages、streamingDraft）。 */
  scrollTrigger: unknown
  /** 会话切换时重置贴底标记。 */
  resetKey: unknown
  /** 距底部多少像素内仍算贴底。 */
  threshold?: number
}

export const useStickyScroll = ({
  containerRef,
  contentRef,
  scrollTrigger,
  resetKey,
  threshold = 96,
}: StickyScrollOptions): void => {
  const stickingRef = useRef(true)
  const lastScrollTopRef = useRef(0)

  const followToBottom = useCallback((): void => {
    if (!stickingRef.current) return
    const container = containerRef.current
    if (!container) return
    window.requestAnimationFrame(() => {
      // rAF 之前用户可能已经向上滚动离开底部，此时不再拉回。
      if (!stickingRef.current) return
      container.scrollTop = container.scrollHeight
    })
  }, [containerRef])

  // 滚动意图：向上滚动才停止跟随，回到底部自动恢复。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    lastScrollTopRef.current = container.scrollTop
    const onScroll = (): void => {
      const metrics: ScrollMetrics = {
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      }
      stickingRef.current = nextStickyState(stickingRef.current, {
        distanceToBottom: distanceToBottom(metrics),
        lastScrollTop: lastScrollTopRef.current,
        scrollTop: metrics.scrollTop,
        threshold,
      })
      lastScrollTopRef.current = metrics.scrollTop
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [containerRef, threshold])

  // 内容高度变化 → 贴底：覆盖流式文本的延迟提交、图片/折叠块异步撑高、
  // content-visibility 渲染后真实高度替换占位高度等所有"事后长高"。
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      followToBottom()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, followToBottom])

  // 消息 / 流式草稿变化 → 贴底。
  useEffect(() => {
    followToBottom()
  }, [followToBottom, scrollTrigger])

  // 会话切换：恢复贴底并跳到该会话的最新输出。
  useEffect(() => {
    stickingRef.current = true
    lastScrollTopRef.current = 0
    followToBottom()
  }, [followToBottom, resetKey])
}
