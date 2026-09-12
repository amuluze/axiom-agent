import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from './ApprovalCard'

const mocks = vi.hoisted(() => ({
  pendingApproval: null as {
    toolCallId: string
    toolName: string
    presentation: {
      title: string
      description: string
      category?: 'workspace-write' | 'workspace-command'
      path?: string
      preview?: string
      changes?: Array<{ path: string; preview: string }>
      danger?: boolean
    }
  } | null,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      pendingApproval: mocks.pendingApproval,
    } as StoreState),
  }
})

afterEach(() => {
  mocks.pendingApproval = null
})

describe('ApprovalCard', () => {
  it('returns null when no approval is pending', () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html).toBe('')
  })

  it('renders the approval card with title, tool tag and scope note', () => {
    mocks.pendingApproval = {
      toolCallId: 'tc-1',
      toolName: 'bash',
      presentation: {
        title: 'Run npm?',
        description: 'Axiom will execute npm test.',
        category: 'workspace-command',
      },
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html).toContain('需要批准')
    expect(html).toContain('bash')
    expect(html).toContain('Axiom will execute npm test.')
    expect(html).toContain('本次批准仅对当前命令有效')
  })

  it('renders both 拒绝 and 允许一次 buttons', () => {
    mocks.pendingApproval = {
      toolCallId: 'tc-1',
      toolName: 'write',
      presentation: { title: 'Write?', description: 'Write one file.' },
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html).toContain('拒绝')
    expect(html).toContain('允许一次')
    expect(html).toContain('approval-card__button--primary')
    expect(html).toContain('role="alert"')
  })

  it('renders a file path in the dedicated target path block', () => {
    mocks.pendingApproval = {
      toolCallId: 'tc-1',
      toolName: 'read',
      presentation: { title: 'Read?', description: 'Read a file.', path: 'docs/plan.md' },
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html).toContain('approval-card__path')
    expect(html).toContain('目标路径')
    expect(html).toContain('docs/plan.md')
  })

  it('renders every change when multiple operations target the same path', () => {
    mocks.pendingApproval = {
      toolCallId: 'tc-1',
      toolName: 'apply_changes',
      presentation: {
        title: 'Apply?',
        description: 'Apply two changes.',
        changes: [
          { path: 'src/a.ts', preview: '+ first change' },
          { path: 'src/a.ts', preview: '- second change' },
        ],
      },
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html.match(/src\/a\.ts/gu)).toHaveLength(2)
    expect(html).toContain('+ first change')
    expect(html).toContain('- second change')
  })

  it('renders the exact command preview instead of only the working directory', () => {
    mocks.pendingApproval = {
      toolCallId: 'tc-1',
      toolName: 'bash',
      presentation: {
        title: 'Run tests?',
        description: 'Execute project code.',
        category: 'workspace-command',
        path: '.',
        preview: 'npm test -- --runInBand',
      },
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html).toContain('npm test -- --runInBand')
    expect(html).toContain('工作目录')
  })

  it('renders a danger confirmation with the allow button disabled', () => {
    mocks.pendingApproval = {
      toolCallId: 'tc-1',
      toolName: 'bash',
      presentation: {
        title: 'Run rm?',
        description: 'Execute project code.',
        category: 'workspace-command',
        preview: 'rm -rf node_modules',
        danger: true,
      },
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html).toContain('approval-card__danger')
    expect(html).toContain('仍允许执行一次')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled=""')
  })

  it('does not render a danger confirmation for safe commands', () => {
    mocks.pendingApproval = {
      toolCallId: 'tc-1',
      toolName: 'bash',
      presentation: {
        title: 'Run tests?',
        description: 'Execute project code.',
        category: 'workspace-command',
        preview: 'npm test',
      },
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard))
    expect(html).not.toContain('approval-card__danger')
    expect(html).not.toContain('disabled=""')
  })
})
