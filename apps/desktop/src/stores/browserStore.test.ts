import { beforeEach, describe, expect, it } from 'vitest'
import { resetBrowserStoreForTests, useBrowserStore } from './browserStore'

beforeEach(() => {
  resetBrowserStoreForTests()
})

describe('browserStore', () => {
  it('frames render payload as a data URL with a tab anchor', () => {
    useBrowserStore.getState().applyFrame({
      tabId: 't-1',
      imageBase64: 'QUJD',
      mimeType: 'image/jpeg',
      width: 320,
      height: 200,
    })
    const frame = useBrowserStore.getState().liveFrame
    expect(frame).toMatchObject({
      tabId: 't-1',
      src: 'data:image/jpeg;base64,QUJD',
      width: 320,
      height: 200,
    })
  })

  it('keeps only the last 200 console entries per tab and clears per tab', () => {
    const store = useBrowserStore.getState()
    for (let index = 0; index < 230; index += 1) {
      store.appendConsoleEvent({
        tabId: 't-1',
        entry: { level: 'log', text: `line ${index}`, source: 'console', timestamp: index },
      })
    }
    store.appendConsoleEvent({
      tabId: 't-2',
      entry: { level: 'error', text: 'other tab', source: 'console', timestamp: 999 },
    })
    const entries = useBrowserStore.getState().consoleEntries['t-1'] ?? []
    expect(entries).toHaveLength(200)
    expect(entries[0]?.text).toBe('line 30')
    expect(entries.at(-1)?.text).toBe('line 229')
    expect(useBrowserStore.getState().consoleEntries['t-2']).toHaveLength(1)

    useBrowserStore.getState().clearConsole('t-1')
    expect(useBrowserStore.getState().consoleEntries['t-1']).toHaveLength(0)
    expect(useBrowserStore.getState().consoleEntries['t-2']).toHaveLength(1)
  })

  it('patches tab url and dialog flags in place on events', () => {
    useBrowserStore.getState().applyTabs([
      { tabId: 't-1', url: 'http://a', title: 'A', active: true, hasDialog: false },
      { tabId: 't-2', url: 'http://b', title: 'B', active: false, hasDialog: false },
    ])
    useBrowserStore.getState().applyNavigatedEvent({ tabId: 't-1', url: 'http://a/next' })
    useBrowserStore.getState().applyDialogEvent({ tabId: 't-2', dialog: { kind: 'alert', message: 'x' } })
    const tabs = useBrowserStore.getState().tabs
    expect(tabs[0]?.url).toBe('http://a/next')
    expect(tabs[1]?.hasDialog).toBe(true)
    // 对话框关闭事件回落。
    useBrowserStore.getState().applyDialogEvent({ tabId: 't-2' })
    expect(useBrowserStore.getState().tabs[1]?.hasDialog).toBe(false)
  })

  it('resets tabs and frames on a stopped status event but keeps preferences', () => {
    useBrowserStore.getState().applyTabs([
      { tabId: 't-1', url: 'http://a', title: 'A', active: true, hasDialog: false },
    ])
    useBrowserStore.getState().setLiveView(true)
    useBrowserStore.getState().setConsoleOpen(true)
    useBrowserStore.getState().applyStatusEvent({ running: false })
    const state = useBrowserStore.getState()
    expect(state.status).toMatchObject({ running: false })
    expect(state.tabs).toHaveLength(0)
    expect(state.liveFrame).toBeNull()
    // 用户偏好保留：进程退出不应重置直播开关。
    expect(state.liveView).toBe(true)
    expect(state.consoleOpen).toBe(true)
  })

  it('stores the page text snapshot per tab and clears it on resetTransient', () => {
    const store = useBrowserStore.getState()
    store.setPageSnapshot({
      tabId: 't-1',
      url: 'https://example.com',
      title: 'Example Domain',
      text: 'This domain is for use in illustrative examples.',
      truncated: false,
      at: 1,
    })
    store.setPanelError('在面板打开链接失败')
    store.setPageTextOpen(true)
    expect(useBrowserStore.getState().pageSnapshot?.text).toContain('illustrative examples')
    expect(useBrowserStore.getState().pageSnapshot?.tabId).toBe('t-1')

    // 浏览器停止/重启清瞬态：快照消失，但抽屉开合偏好保留。
    useBrowserStore.getState().resetTransient()
    const next = useBrowserStore.getState()
    expect(next.pageSnapshot).toBeNull()
    expect(next.pageTextOpen).toBe(true)
  })
})
