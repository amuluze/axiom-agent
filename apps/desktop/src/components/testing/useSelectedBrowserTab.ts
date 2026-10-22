import { useEffect, useState } from 'react'
import type { BrowserTabInfo } from '@/platform/browserSession'

/**
 * 选中浏览器标签页（F1 展示派生）：当前选择失效时收敛到 active 标签或首个标签。
 */
export const useSelectedBrowserTab = (tabs: readonly BrowserTabInfo[]) => {
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null)
  useEffect(() => {
    setSelectedTabId((current) => {
      if (current && tabs.some((tab) => tab.tabId === current)) return current
      return tabs.find((tab) => tab.active)?.tabId ?? tabs[0]?.tabId ?? null
    })
  }, [tabs])
  return { selectedTabId, setSelectedTabId }
}
