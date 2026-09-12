import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

const installDomStorage = (initial: Record<string, string> = {}, windowProps: Record<string, unknown> = {}) => {
  const values = new Map(Object.entries(initial))
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  // 根元素内联 CSS 变量（字号/等宽字体经 style.setProperty 生效）。
  const setProperty = vi.fn()
  const documentElement = {
    dataset: {} as Record<string, string>,
    lang: '',
    style: { setProperty },
    removeAttribute: vi.fn((name: string) => {
      if (name === 'data-theme') delete documentElement.dataset.theme
    }),
  }
  vi.stubGlobal('window', { localStorage, ...windowProps })
  vi.stubGlobal('document', { documentElement })
  return { values, documentElement, setProperty }
}

describe('uiStore preferences', () => {
  it('restores and persists the selected interface theme', async () => {
    const dom = installDomStorage({ 'axiom.ui.theme.v1': 'light' })
    const { useUiStore } = await import('./uiStore')

    expect(useUiStore.getState().theme).toBe('light')
    expect(dom.documentElement.dataset.theme).toBe('light')

    useUiStore.getState().setTheme('dark')
    expect(dom.values.get('axiom.ui.theme.v1')).toBe('dark')
    expect(dom.documentElement.dataset.theme).toBe('dark')

    useUiStore.getState().setTheme('system')
    expect(dom.documentElement.dataset.theme).toBeUndefined()
  })

  it('syncs the native window appearance with the in-app theme', async () => {
    const setTheme = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({ setTheme }),
    }))
    installDomStorage({ 'axiom.ui.theme.v1': 'dark' }, { __TAURI_INTERNALS__: {} })
    const { useUiStore } = await import('./uiStore')

    expect(useUiStore.getState().theme).toBe('dark')
    expect(setTheme).toHaveBeenCalledWith('dark')

    useUiStore.getState().setTheme('light')
    expect(setTheme).toHaveBeenLastCalledWith('light')

    // system 档清除原生覆盖，交还系统外观决定。
    useUiStore.getState().setTheme('system')
    expect(setTheme).toHaveBeenLastCalledWith(null)
  })

  it('persists the Chinese interface language preference', async () => {
    const dom = installDomStorage()
    const { useUiStore } = await import('./uiStore')

    useUiStore.getState().setLanguage('zh-CN')
    expect(dom.values.get('axiom.ui.language.v1')).toBe('zh-CN')
    expect(dom.documentElement.lang).toBe('zh-CN')
  })

  it('persists the English interface language preference and sets html lang', async () => {
    const dom = installDomStorage({ 'axiom.ui.language.v1': 'en' })
    const { useUiStore } = await import('./uiStore')

    // 存储了 en → 模块初始化即恢复为 en。
    expect(useUiStore.getState().language).toBe('en')
    expect(dom.documentElement.lang).toBe('en')

    useUiStore.getState().setLanguage('zh-CN')
    expect(dom.values.get('axiom.ui.language.v1')).toBe('zh-CN')
    expect(dom.documentElement.lang).toBe('zh-CN')

    useUiStore.getState().setLanguage('en')
    expect(dom.values.get('axiom.ui.language.v1')).toBe('en')
    expect(dom.documentElement.lang).toBe('en')
  })

  it('falls back to system for unknown stored language values', async () => {
    installDomStorage({ 'axiom.ui.language.v1': 'garbage' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().language).toBe('system')
  })
})

describe('uiStore access mode and git branch prefix', () => {
  it('restores, persists and overwrites the approval access mode', async () => {
    const dom = installDomStorage({ 'axiom.access.mode.v1': 'no-approval' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().accessMode).toBe('no-approval')

    useUiStore.getState().setAccessMode('standard')
    expect(dom.values.get('axiom.access.mode.v1')).toBe('standard')
    expect(useUiStore.getState().accessMode).toBe('standard')
  })

  it('migrates the retired high-risk mode to standard (fail-closed)', async () => {
    installDomStorage({ 'axiom.access.mode.v1': 'high-risk' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().accessMode).toBe('standard')
  })

  it('falls back to standard mode for unknown stored values', async () => {
    installDomStorage({ 'axiom.access.mode.v1': 'garbage' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().accessMode).toBe('standard')
  })

  it('restores the git branch prefix from localStorage', async () => {
    installDomStorage({ 'axiom.git.branch.prefix.v1': 'hotfix-' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().gitBranchPrefix).toBe('hotfix-')

    useUiStore.getState().setGitBranchPrefix('feature/')
    expect(useUiStore.getState().gitBranchPrefix).toBe('feature/')
  })
})

describe('uiStore recent workspaces', () => {
  it('restores the recent workspace order from localStorage', async () => {
    installDomStorage({ 'axiom.workspace.recent.v1': '["/a","/b"]' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().recentWorkspacePaths).toEqual(['/a', '/b'])
  })

  it('records a workspace to the front and persists it', async () => {
    const dom = installDomStorage()
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().recordRecentWorkspace('/c')
    expect(useUiStore.getState().recentWorkspacePaths).toEqual(['/c'])
    expect(JSON.parse(dom.values.get('axiom.workspace.recent.v1')!)).toEqual(['/c'])
  })

  it('moves an already-recorded workspace to the front', async () => {
    installDomStorage({ 'axiom.workspace.recent.v1': '["/a","/b"]' })
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().recordRecentWorkspace('/b')
    expect(useUiStore.getState().recentWorkspacePaths).toEqual(['/b', '/a'])
  })

  it('caps the recent list at MAX_RECENT_WORKSPACES', async () => {
    installDomStorage()
    const { useUiStore } = await import('./uiStore')
    for (let i = 0; i < 25; i += 1) useUiStore.getState().recordRecentWorkspace(`/ws/${i}`)
    expect(useUiStore.getState().recentWorkspacePaths).toHaveLength(20)
    expect(useUiStore.getState().recentWorkspacePaths[0]).toBe('/ws/24')
  })

  it('ignores invalid stored values and falls back to an empty list', async () => {
    installDomStorage({ 'axiom.workspace.recent.v1': 'not-json' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().recentWorkspacePaths).toEqual([])
  })

  it('filters non-string entries from the stored list', async () => {
    installDomStorage({ 'axiom.workspace.recent.v1': '["/a",42,null,"/b"]' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().recentWorkspacePaths).toEqual(['/a', '/b'])
  })
})

describe('uiStore terminal panel height', () => {
  it('restores the persisted panel height and clamps oversized values to the viewport', async () => {
    const dom = installDomStorage({ 'axiom.terminal.panelHeight.v1': '320' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().terminalPanelHeight).toBe(320)

    // stub window 无 innerHeight → 兜底视口 1024，上限 1024 - 180 = 844。
    useUiStore.getState().setTerminalPanelHeight(9999)
    expect(useUiStore.getState().terminalPanelHeight).toBe(844)
    expect(dom.values.get('axiom.terminal.panelHeight.v1')).toBe('844')
  })

  it('clamps the panel height to the minimum and ignores invalid input', async () => {
    const dom = installDomStorage({ 'axiom.terminal.panelHeight.v1': '10' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().terminalPanelHeight).toBe(120)

    // 无效输入被整体忽略：state 不变，localStorage 不被污染（仍是加载前的原值）。
    useUiStore.getState().setTerminalPanelHeight(Number.NaN)
    expect(useUiStore.getState().terminalPanelHeight).toBe(120)
    expect(dom.values.get('axiom.terminal.panelHeight.v1')).toBe('10')
  })

  it('falls back to the default height for non-numeric stored values', async () => {
    installDomStorage({ 'axiom.terminal.panelHeight.v1': 'not-a-number' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().terminalPanelHeight).toBe(240)
  })
})

describe('uiStore SFTP panel height', () => {
  it('restores the persisted panel height and clamps oversized values to the viewport', async () => {
    const dom = installDomStorage({ 'axiom.sftp.panelHeight.v1': '360' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().sftpPanelHeight).toBe(360)

    // stub window 无 innerHeight → 兜底视口 1024，上限 1024 - 180 = 844。
    useUiStore.getState().setSftpPanelHeight(9999)
    expect(useUiStore.getState().sftpPanelHeight).toBe(844)
    expect(dom.values.get('axiom.sftp.panelHeight.v1')).toBe('844')
  })

  it('honors the caller-supplied pane-measured max and clamps the minimum', async () => {
    const dom = installDomStorage({ 'axiom.sftp.panelHeight.v1': '10' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().sftpPanelHeight).toBe(160)

    // 拖拽传入终端栏实测上限：栏矮时视口再大面板也不能撑满整个视口。
    useUiStore.getState().setSftpPanelHeight(500, 420)
    expect(useUiStore.getState().sftpPanelHeight).toBe(420)
    expect(dom.values.get('axiom.sftp.panelHeight.v1')).toBe('420')

    // 无效输入被整体忽略：state 不变，localStorage 不被污染（仍是加载前的原值）。
    useUiStore.getState().setSftpPanelHeight(Number.NaN, 420)
    expect(useUiStore.getState().sftpPanelHeight).toBe(420)
    expect(dom.values.get('axiom.sftp.panelHeight.v1')).toBe('420')
  })

  it('falls back to the default height for non-numeric stored values', async () => {
    installDomStorage({ 'axiom.sftp.panelHeight.v1': 'not-a-number' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().sftpPanelHeight).toBe(320)
  })
})

describe('uiStore runtime rail width', () => {
  it('restores the persisted rail width and clamps it into the allowed range', async () => {
    const dom = installDomStorage({ 'axiom.runtime.railWidth.v1': '400' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().runtimeRailWidth).toBe(400)

    // 超上限被钳制并持久化。
    useUiStore.getState().setRuntimeRailWidth(9999)
    expect(useUiStore.getState().runtimeRailWidth).toBe(520)
    expect(dom.values.get('axiom.runtime.railWidth.v1')).toBe('520')

    useUiStore.getState().setRuntimeRailWidth(1)
    expect(useUiStore.getState().runtimeRailWidth).toBe(280)
    expect(dom.values.get('axiom.runtime.railWidth.v1')).toBe('280')
  })

  it('falls back to the default width for non-numeric stored values and ignores invalid input', async () => {
    const dom = installDomStorage({ 'axiom.runtime.railWidth.v1': 'not-a-number' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().runtimeRailWidth).toBe(288)

    // 无效输入被整体忽略：state 不变，localStorage 不被污染（仍是加载前的原值）。
    useUiStore.getState().setRuntimeRailWidth(Number.NaN)
    expect(useUiStore.getState().runtimeRailWidth).toBe(288)
    expect(dom.values.get('axiom.runtime.railWidth.v1')).toBe('not-a-number')
  })

  it('clamps the rail width to the viewport so the session body keeps room', async () => {
    installDomStorage({ 'axiom.runtime.railWidth.v1': '9999' }, { innerWidth: 900 })
    const { useUiStore } = await import('./uiStore')
    // 窄视口：上限 = 900 - 420（会话主体保留）= 480，而非绝对上限 520。
    expect(useUiStore.getState().runtimeRailWidth).toBe(480)
    useUiStore.getState().setRuntimeRailWidth(9999)
    expect(useUiStore.getState().runtimeRailWidth).toBe(480)
  })
})

describe('uiStore navigation and layout actions', () => {
  it('toggles the sidebar between collapsed and compact overlay modes', async () => {
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().setView('settings')
    useUiStore.getState().setSettingsSection('archived')
    expect(useUiStore.getState().view).toBe('settings')
    expect(useUiStore.getState().settingsSection).toBe('archived')

    useUiStore.getState().toggleSidebar()
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    expect(useUiStore.getState().sidebarUserOverride).toBe(true)

    // 用户手动覆盖后，程序化 setSidebarCollapsed 被忽略。
    useUiStore.getState().setSidebarCollapsed(false)
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)

    useUiStore.getState().setSidebarCompact(true)
    useUiStore.getState().toggleSidebar()
    expect(useUiStore.getState().sidebarOverlayOpen).toBe(true)
    useUiStore.getState().closeSidebarOverlay()
    expect(useUiStore.getState().sidebarOverlayOpen).toBe(false)
  })

  it('toggles runtime rail and terminal panel independently', async () => {
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().toggleRuntimeRail()
    expect(useUiStore.getState().runtimeRailOpen).toBe(true)
    // 展开即回卡片选择页。
    expect(useUiStore.getState().runtimeRailPane).toBe('picker')
    useUiStore.getState().setRuntimeRailOpen(false)
    expect(useUiStore.getState().runtimeRailOpen).toBe(false)

    useUiStore.getState().toggleTerminalPanel()
    expect(useUiStore.getState().terminalPanelOpen).toBe(true)
    useUiStore.getState().setTerminalPanelOpen(false)
    expect(useUiStore.getState().terminalPanelOpen).toBe(false)
  })

  it('keeps runtime rail pane selection session-scoped without persistence', async () => {
    const { useUiStore } = await import('./uiStore')
    // 默认回到卡片选择页；不持久化。
    expect(useUiStore.getState().runtimeRailPane).toBe('picker')
    useUiStore.getState().setRuntimeRailPane('browser')
    expect(useUiStore.getState().runtimeRailPane).toBe('browser')
    // pane 切换与 runtimeRailOpen 解耦：按钮开/关面板不重置 pane。
    useUiStore.getState().setRuntimeRailOpen(true)
    expect(useUiStore.getState().runtimeRailOpen).toBe(true)
    // 展开即回卡片选择页（pane 重置为 picker）。
    expect(useUiStore.getState().runtimeRailPane).toBe('picker')
    // 收起后再展开：仍回卡片选择页。
    useUiStore.getState().toggleRuntimeRail()
    expect(useUiStore.getState().runtimeRailOpen).toBe(false)
    useUiStore.getState().toggleRuntimeRail()
    expect(useUiStore.getState().runtimeRailOpen).toBe(true)
    expect(useUiStore.getState().runtimeRailPane).toBe('picker')
  })

  it('stores compaction and branch summary requests', async () => {
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().setSummaryRequest({ mode: 'branch', messageId: 'm1' })
    expect(useUiStore.getState().summaryRequest).toEqual({ mode: 'branch', messageId: 'm1' })
    useUiStore.getState().setSummaryRequest(null)
    expect(useUiStore.getState().summaryRequest).toBeNull()
  })
})

describe('uiStore 界面字号偏好', () => {
  it('restores the persisted UI font size and applies it as the root CSS variable', async () => {
    const dom = installDomStorage({ 'axiom.ui.fontSizePx.v1': '14' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().fontSizePx).toBe(14)
    // 模块加载即按持久化偏好应用（字号经 --ui-font-size 缩放全部 rem 文本）。
    expect(dom.setProperty).toHaveBeenCalledWith('--ui-font-size', '14px')
  })

  it('falls back to the default for invalid stored values', async () => {
    installDomStorage({ 'axiom.ui.fontSizePx.v1': 'not-a-number' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().fontSizePx).toBe(13)
  })

  it('clamps out-of-range stored values into 12..16', async () => {
    installDomStorage({ 'axiom.ui.fontSizePx.v1': '19' })
    const { useUiStore: over } = await import('./uiStore')
    expect(over.getState().fontSizePx).toBe(16)
  })

  it('persists, applies and clamps values set at runtime', async () => {
    const dom = installDomStorage()
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().setFontSizePx(15)
    expect(dom.values.get('axiom.ui.fontSizePx.v1')).toBe('15')
    expect(dom.setProperty).toHaveBeenLastCalledWith('--ui-font-size', '15px')

    useUiStore.getState().setFontSizePx(99)
    expect(useUiStore.getState().fontSizePx).toBe(16)
    expect(dom.values.get('axiom.ui.fontSizePx.v1')).toBe('16')
  })

  it('ignores non-finite input without touching state or storage', async () => {
    const dom = installDomStorage()
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().setFontSizePx(Number.NaN)
    expect(useUiStore.getState().fontSizePx).toBe(13)
    expect(dom.values.has('axiom.ui.fontSizePx.v1')).toBe(false)
  })
})

describe('uiStore 等宽字体偏好', () => {
  it('restores the persisted mono font family and overrides --font-mono', async () => {
    const dom = installDomStorage({ 'axiom.ui.monoFontFamily.v1': 'menlo' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().monoFontFamily).toBe('menlo')
    const stack = dom.setProperty.mock.calls.find(([name]) => name === '--font-mono')?.[1] as string
    expect(stack).toContain("'Menlo'")
  })

  it('falls back to JetBrains Mono for unknown stored values', async () => {
    const dom = installDomStorage({ 'axiom.ui.monoFontFamily.v1': 'comic-sans' })
    const { useUiStore } = await import('./uiStore')
    expect(useUiStore.getState().monoFontFamily).toBe('jetbrains')
    const stack = dom.setProperty.mock.calls.find(([name]) => name === '--font-mono')?.[1] as string
    expect(stack).toContain("'JetBrains Mono'")
  })

  it('persists and applies a runtime change', async () => {
    const dom = installDomStorage()
    const { useUiStore } = await import('./uiStore')
    useUiStore.getState().setMonoFontFamily('monaco')
    expect(useUiStore.getState().monoFontFamily).toBe('monaco')
    expect(dom.values.get('axiom.ui.monoFontFamily.v1')).toBe('monaco')
    // boot 已按默认 jetbrains 应用过，取最后一次 --font-mono 调用。
    const calls = dom.setProperty.mock.calls.filter(([name]) => name === '--font-mono')
    expect(calls.at(-1)?.[1]).toContain("'Monaco'")
  })
})

describe('scaledTerminalFontSize', () => {
  it('keeps the terminal base size at the default UI font size', async () => {
    const { scaledTerminalFontSize } = await import('./uiStore')
    expect(scaledTerminalFontSize(13, 13)).toBe(13)
    expect(scaledTerminalFontSize(12, 13)).toBe(12)
  })

  it('scales terminal canvas px proportionally to the UI font size', async () => {
    const { scaledTerminalFontSize } = await import('./uiStore')
    expect(scaledTerminalFontSize(13, 16)).toBe(16)
    // SSH 终端基准 12px：16 档下 12*16/13 ≈ 14.77 → 15。
    expect(scaledTerminalFontSize(12, 16)).toBe(15)
    expect(scaledTerminalFontSize(12, 12)).toBe(11)
  })

  it('clamps pathological inputs into a readable range', async () => {
    const { scaledTerminalFontSize } = await import('./uiStore')
    expect(scaledTerminalFontSize(13, 100)).toBe(24)
    expect(scaledTerminalFontSize(13, 1)).toBe(9)
  })
})
