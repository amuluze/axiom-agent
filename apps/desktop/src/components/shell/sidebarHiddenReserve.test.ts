// @vitest-environment node
/**
 * 侧栏收起时的「浮层按钮让位」约定守卫。
 *
 * 侧栏收起/紧凑时，`App` 会渲染一个 `position: fixed; top: 6px; left: 流量灯安全区;
 * z-index: 30` 的「重新展开侧栏」按钮——它**不参与视图布局**，所以每个自带顶栏的视图
 * 都必须主动留出左侧空间，否则顶栏会被压住（设计页文件栏曾整块压住第一个 tab：
 * 既遮挡、又点不到）。
 *
 * 这条约定靠样式表自觉遵守，容易在下一次加视图时被漏掉——因此用用例把它钉住：
 * 已知的每个顶栏容器都必须带着那段 `calc(traffic-light + 28px + space-3)` 的预留。
 * 新增自带顶栏的视图时，请在这里补一行并在 `app.css` 加对应规则。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '../../styles/app.css'), 'utf8')

/** 需要在侧栏收起时让位的顶栏容器（新增视图时补这里）。 */
const TOP_BAR_CONTAINERS = [
  '.session__header',
  '.new-task__drag-region',
  '.design-view__toolbar',
]

describe('侧栏收起：浮层按钮让位约定', () => {
  it('每个顶栏容器都有 .app-main--sidebar-hidden 下的预留规则', () => {
    const missing: string[] = []
    for (const selector of TOP_BAR_CONTAINERS) {
      const rule = new RegExp(
        `\\.app-main--sidebar-hidden\\s+\\${selector.replace(/[.]/g, '.')}\\s*\\{[^}]*calc\\(\\s*var\\(--macos-traffic-light-safe-area\\)\\s*\\+\\s*28px\\s*\\+\\s*var\\(--space-3\\)\\s*\\)`,
        'u',
      )
      if (!rule.test(CSS)) missing.push(selector)
    }
    expect(missing).toEqual([])
  })

  it('重新展开按钮确实是 fixed 浮层（这条约定的前提）', () => {
    const rule = /\.app-shell__reopen\s*\{[^}]*\}/u.exec(CSS)?.[0] ?? ''
    expect(rule).toContain('position: fixed')
    expect(rule).toContain('z-index: 30')
  })
})
