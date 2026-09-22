/** 上弹弹层与触发器的间距，对应菜单 CSS 的 bottom: calc(100% + 6px)。 */
export const UPWARD_MENU_GAP_PX = 6
/** @ 提及弹层的间距，对应 .composer__mention-popover 的 bottom: calc(100% + var(--space-2))。 */
export const MENTION_POPOVER_GAP_PX = 8
/** 弹层顶缘与窗口顶缘之间的安全余量。 */
export const UPWARD_MENU_MARGIN_PX = 8
/** 弹层整体首选上限：条目再多也不撑满整窗，超出部分由列表内部滚动消化。 */
export const UPWARD_MENU_PREFERRED_MAX_PX = 560

/**
 * 触发器上方可容纳的弹层最大高度。菜单向上弹出（bottom: calc(100% + gap)），
 * 弹层底缘固定在触发器顶缘上方 gap 处，可用高度由触发器顶缘的视口坐标唯一决定——
 * Composer 在会话页贴底、欢迎页垂直居中，静态 100vh 常量无法同时覆盖两种布局。
 * gap 默认对齐标准菜单（6px）；@ 提及弹层传 MENTION_POPOVER_GAP_PX。
 */
export const upwardMenuMaxHeight = (anchorTop: number, gapPx: number = UPWARD_MENU_GAP_PX): number =>
  Math.min(
    UPWARD_MENU_PREFERRED_MAX_PX,
    Math.max(0, Math.floor(anchorTop - gapPx - UPWARD_MENU_MARGIN_PX)),
  )
