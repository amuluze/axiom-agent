import { useEffect, type RefObject } from 'react'

/**
 * 右锚弹层的水平钳制：窄宿主（设计助手侧栏 ~264px）里，弹层右缘锚定触发器，
 * 而触发器右缘可能距宿主右缘很远（预算按钮在模型选择器左侧）——固定宽度下
 * 弹层左半会溢出宿主被 `.sidebar` 的 overflow:hidden 裁掉。打开时实测弹层
 * 相对最近 `.composer` 宿主的左溢出量，写入弹层上的 `--composer-menu-shift`
 * （transform 消费）平移回宿主内；打开期间跟随 resize 与祖先滚动重算，
 * 关闭即清理，未溢出（主会话宽宿主）时不设变量、行为与既有定位完全一致。
 */
export const useHorizontalMenuClamp = (
  menuRef: RefObject<HTMLElement | null>,
  open: boolean,
): void => {
  useEffect(() => {
    const menu = menuRef.current
    if (!open || !menu) return
    const apply = () => {
      // 先复位再量：多轮重算不得叠加平移量。
      menu.style.removeProperty('--composer-menu-shift')
      const host = menu.closest('.composer')
      if (!host) return
      const overflow = host.getBoundingClientRect().left - menu.getBoundingClientRect().left
      if (overflow > 0) {
        menu.style.setProperty('--composer-menu-shift', `${Math.round(overflow)}px`)
      }
    }
    apply()
    window.addEventListener('resize', apply)
    document.addEventListener('scroll', apply, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', apply)
      document.removeEventListener('scroll', apply, { capture: true })
      menu.style.removeProperty('--composer-menu-shift')
    }
  }, [menuRef, open])
}
