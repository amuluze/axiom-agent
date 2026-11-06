import { useEffect, useRef, type RefObject } from 'react'

/**
 * 流式输出场景下的"贴底跟随"控制：
 * - 用 IntersectionObserver 监视 anchor 元素在 scroll container 内的可见性，
 *   代替旧的 scrollIntoView({ block: 'end' }) + onScroll 阈值回查。
 * - 内容变化（streaming 新增 / 历史消息落定）时，若仍在贴底则把 scrollTop
 *   直接写到 scrollHeight（O(1)，不触发 scrollIntoView 内部的链式 layout）。
 * - IO 离开视口后停止自动跟随，用户手动回看历史时不会被拉回。
 */

export interface StickyScrollHandle {
  /** 当前是否仍处于"贴底"状态。 */
  isSticking: () => boolean
}

interface StickyScrollOptions {
  containerRef: RefObject<HTMLElement | null>
  anchorRef: RefObject<HTMLElement | null>
  /** 触发"尝试贴底"的依赖（如 messages、streamingDraft）。 */
  scrollTrigger: unknown
  /** 会话切换时重置贴底标记。 */
  resetKey: unknown
  /** IO 阈值；默认 0 表示 anchor 任意像素进入即视为贴底。 */
  threshold?: number
}

export const useStickyScroll = ({
  containerRef,
  anchorRef,
  scrollTrigger,
  resetKey,
  threshold = 0,
}: StickyScrollOptions): StickyScrollHandle => {
  const stickingRef = useRef(true)

  // 监视 anchor 在容器内的可见性；进入 → 贴底，离开 → 不贴。
  useEffect(() => {
    const container = containerRef.current
    const anchor = anchorRef.current
    if (!container || !anchor) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          stickingRef.current = entry.isIntersecting
        }
      },
      { root: container, threshold },
    )
    observer.observe(anchor)
    return () => observer.disconnect()
  }, [containerRef, anchorRef, threshold])

  // 会话切换：回到"贴底"默认状态。
  useEffect(() => {
    stickingRef.current = true
  }, [resetKey])

  // 内容变化：仅在贴底时把 scrollTop 写到 scrollHeight。
  useEffect(() => {
    if (!stickingRef.current) return
    const container = containerRef.current
    if (!container) return
    const frame = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [scrollTrigger, containerRef])

  return { isSticking: () => stickingRef.current }
}