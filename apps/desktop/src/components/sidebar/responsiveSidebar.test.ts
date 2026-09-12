import { describe, expect, it } from 'vitest'
import {
  deriveSidebarState,
  shouldAutoCollapse,
  SIDEBAR_BREAKPOINT_PX,
} from './responsiveSidebar'

describe('responsiveSidebar.deriveSidebarState', () => {
  it('auto-collapses below the breakpoint when the user has not overridden', () => {
    const state = deriveSidebarState(true, false, false)
    expect(state).toEqual({ compact: true, userOverride: false, collapsed: true })
  })

  it('stays expanded above the breakpoint when the user has not overridden', () => {
    const state = deriveSidebarState(false, false, false)
    expect(state).toEqual({ compact: false, userOverride: false, collapsed: false })
  })

  it('respects the explicit collapsed flag once the user toggles it', () => {
    const expandedByUser = deriveSidebarState(true, true, false)
    expect(expandedByUser.collapsed).toBe(false)
    const collapsedByUser = deriveSidebarState(false, true, true)
    expect(collapsedByUser.collapsed).toBe(true)
  })
})

describe('responsiveSidebar.shouldAutoCollapse', () => {
  it('returns true when compact and not overridden', () => {
    expect(shouldAutoCollapse({ compact: true }, false)).toBe(true)
  })

  it('returns false once the user has overridden the auto behaviour', () => {
    expect(shouldAutoCollapse({ compact: true }, true)).toBe(false)
  })

  it('returns false above the breakpoint', () => {
    expect(shouldAutoCollapse({ compact: false }, false)).toBe(false)
  })
})

describe('responsiveSidebar.SIDEBAR_BREAKPOINT_PX', () => {
  it('matches the documented desktop minimum (sidebar + composer)', () => {
    expect(SIDEBAR_BREAKPOINT_PX).toBeGreaterThan(760)
    expect(SIDEBAR_BREAKPOINT_PX).toBeLessThanOrEqual(1280)
  })
})
