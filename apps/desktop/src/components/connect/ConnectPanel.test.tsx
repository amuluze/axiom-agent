import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectPanel } from './ConnectPanel'
import type { ConnectPlatform } from '@/platform/connect'

const mocks = vi.hoisted(() => ({
  replyError: null as { platform: ConnectPlatform; message: string; at: number } | null,
  actionError: null as string | null,
}))

vi.mock('@/stores/connectStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/connectStore')>()
  type State = ReturnType<typeof original.useConnectStore.getState>
  return {
    ...original,
    useConnectStore: <T,>(selector?: (state: State) => T): T => {
      const state = {
        ...original.useConnectStore.getState(),
        replyError: mocks.replyError,
        actionError: mocks.actionError,
      } as State
      // WechatLoginFlow 等子组件有无参调用（返回整个 state），需兼容。
      return selector ? selector(state) : (state as T)
    },
  }
})

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type State = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: State) => T): T => selector({
      ...original.useAgentStore.getState(),
      sessions: [],
      authorizedWorkspaces: [],
    } as State),
  }
})

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type State = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: State) => T): T => selector({
      ...original.useUiStore.getState(),
    } as State),
  }
})

afterEach(() => {
  mocks.replyError = null
  mocks.actionError = null
})

describe('ConnectPanel 动作失败提示', () => {
  it('无动作失败时不渲染提示条', () => {
    const html = renderToStaticMarkup(createElement(ConnectPanel))
    expect(html).not.toContain('connect-panel__action-error')
  })

  it('有动作失败时渲染提示条并说明原因（此前这些失败被静默吞掉）', () => {
    mocks.actionError = '无法写入连接配置'
    const html = renderToStaticMarkup(createElement(ConnectPanel))
    expect(html).toContain('connect-panel__action-error')
    expect(html).toContain('操作未生效：无法写入连接配置')
    expect(html).toContain('aria-label="关闭操作失败提示"')
  })
})

describe('ConnectPanel 回发失败提示', () => {
  it('无回发错误时不渲染提示条', () => {
    const html = renderToStaticMarkup(createElement(ConnectPanel))
    expect(html).not.toContain('connect-panel__reply-error')
  })

  it('有回发错误时渲染提示条，展示平台与错误信息，并提供关闭按钮', () => {
    mocks.replyError = { platform: 'feishu', message: '回复通道不可用', at: Date.now() }
    const html = renderToStaticMarkup(createElement(ConnectPanel))
    expect(html).toContain('connect-panel__reply-error')
    expect(html).toContain('结果回发失败（飞书）')
    expect(html).toContain('回复通道不可用')
    expect(html).toContain('aria-label="关闭回发失败提示"')
  })
})
