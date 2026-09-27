/**
 * 画布主题解析：UI 主题为 system 档时用 matchMedia 解出实际明暗模式。
 * DesignCanvas 与 DesignCompareView 共用（避免两份 matchMedia 订阅逻辑漂移）。
 */
import { useEffect, useState } from 'react'
import { useUiStore } from '@/stores/uiStore'
import type { PenThemeMode } from '@/agent/design/penParser'

/** 环境无 matchMedia（jsdom / 极端 WebView）时退化为亮色，而不是渲染期抛错。 */
const prefersDarkColorScheme = (): boolean =>
  typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-color-scheme: dark)').matches

export const useCanvasThemeMode = (): PenThemeMode => {
  const theme = useUiStore((state) => state.theme)
  const [systemDark, setSystemDark] = useState(prefersDarkColorScheme)
  useEffect(() => {
    if (theme !== 'system') return undefined
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}
