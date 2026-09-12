export const SIDEBAR_BREAKPOINT_PX = 1080

export interface ResponsiveSidebarState {
  /** True when the viewport is narrower than the breakpoint. */
  compact: boolean
  /** True when the user has manually toggled; auto mode stops overriding. */
  userOverride: boolean
  /** Effective collapsed flag derived from compact + userOverride. */
  collapsed: boolean
}

export const deriveSidebarState = (
  compact: boolean,
  userOverride: boolean,
  explicitCollapsed: boolean,
): ResponsiveSidebarState => {
  if (userOverride) {
    return { compact, userOverride, collapsed: explicitCollapsed }
  }
  return { compact, userOverride, collapsed: compact }
}

export interface SidebarAutoCollapseEvent {
  compact: boolean
}

export const shouldAutoCollapse = (event: SidebarAutoCollapseEvent, userOverride: boolean): boolean => {
  if (userOverride) return false
  return event.compact
}
