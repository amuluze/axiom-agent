import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/agentStore', () => ({
  useAgentStore: (selector: (state: {
    authorizedWorkspace: null
    sessions: []
    activeSessionId: null
    selectSession: () => Promise<boolean>
    sendToSession: () => Promise<boolean>
  }) => unknown) => selector({
    authorizedWorkspace: null,
    sessions: [],
    activeSessionId: null,
    selectSession: async () => false,
    sendToSession: async () => false,
  }),
}))

import { TestingView } from './TestingView'

describe('TestingView', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the workspace-free empty state without starting a run', () => {
    const html = renderToStaticMarkup(<TestingView />)
    expect(html).toContain('测试用例')
    expect(html).toContain('尚未选择工作区')
    expect(html).toContain('添加工作区')
  })
})
