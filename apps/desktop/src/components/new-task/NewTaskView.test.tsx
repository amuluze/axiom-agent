import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NewTaskView } from './NewTaskView'

vi.mock('../../stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      provider: { ...original.useAgentStore.getState().provider, providerId: 'demo' },
      providerReady: true,
      providerSetupRequired: false,
      running: false,
      authorizedWorkspace: null,
      authorizedFiles: [],
      authorizeFile: vi.fn(async () => true),
      authorizeDirectory: vi.fn(async () => true),
    } as StoreState),
  }
})

describe('NewTaskView', () => {
  it('renders the hero title and the composer', () => {
    const html = renderToStaticMarkup(createElement(NewTaskView))
    expect(html).toContain('在 Axiom 中开始新任务')
    expect(html).toContain('composer')
    expect(html).toContain('aria-label="新任务"')
    expect(html).toContain('new-task__drag-region')
    expect(html).toContain('data-tauri-drag-region')
  })
})
