import { useEffect, type RefObject } from 'react'
import { upwardMenuMaxHeight } from './upwardMenuSpace'

/**
 * 上弹弹层的视口钳制：打开时实测触发器顶缘到窗口顶缘的距离，写入容器上的
 * --composer-menu-available 供弹层 max-height 消费；打开期间跟随 resize 与
 * 任意祖先滚动（捕获阶段）重算，关闭即清理，未测量时由 CSS 回退值兜底。
 */
export const useUpwardMenuClamp = (containerRef: RefObject<HTMLElement | null>, open: boolean): void => {
  useEffect(() => {
    const container = containerRef.current
    if (!open || !container) return
    const apply = () => {
      container.style.setProperty(
        '--composer-menu-available',
        `${upwardMenuMaxHeight(container.getBoundingClientRect().top)}px`,
      )
    }
    apply()
    window.addEventListener('resize', apply)
    document.addEventListener('scroll', apply, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', apply)
      document.removeEventListener('scroll', apply, { capture: true })
      container.style.removeProperty('--composer-menu-available')
    }
  }, [containerRef, open])
}
