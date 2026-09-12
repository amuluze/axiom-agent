import { useEffect } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { SIDEBAR_BREAKPOINT_PX } from './responsiveSidebar'

const matchCompact = (query: MediaQueryList | undefined): boolean => Boolean(query?.matches)

const buildQuery = (window: Window | undefined): MediaQueryList | undefined => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
  return window.matchMedia(`(max-width: ${SIDEBAR_BREAKPOINT_PX - 1}px)`)
}

/**
 * Auto-collapse the sidebar below the desktop breakpoint unless the user has
 * manually toggled it. The hook keeps uiStore as the single source of truth and
 * only writes when the derived state actually changes.
 */
export const useResponsiveSidebar = (): void => {
  useEffect(() => {
    const query = buildQuery(typeof window === 'undefined' ? undefined : window)
    if (!query) return
    const apply = () => {
      const compact = matchCompact(query)
      const state = useUiStore.getState()
      if (state.sidebarCompact !== compact) state.setSidebarCompact(compact)
    }
    apply()
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', apply)
      return () => query.removeEventListener('change', apply)
    }
    query.addListener(apply)
    return () => query.removeListener(apply)
  }, [])
}
