import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantContentBlock, AssistantMessage, JsonValue, ToolResultMessage } from '@/agent/core/types'
import type { ActiveToolInfo } from '@/stores/runtimeCaches'
import { ToolCallCard } from './ToolCallCard'

const mocks = vi.hoisted(() => ({
  activeTools: {} as Record<string, ActiveToolInfo>,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      activeTools: mocks.activeTools,
    } as StoreState),
  }
})

afterEach(() => {
  mocks.activeTools = {}
})

const baseAssistant = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'm',
  createdAt: 0,
  role: 'assistant',
  content: '',
  contentBlocks: [],
  toolCalls: [],
  stopReason: 'tool_use',
  ...overrides,
})

const baseResult = (overrides: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  id: 'r',
  createdAt: 0,
  role: 'tool',
  toolCallId: 'tc',
  toolName: 'write',
  content: '',
  isError: false,
  ...overrides,
})

const toolCallBlock = (arguments_: JsonValue): Extract<AssistantContentBlock, { type: 'tool_call' }> => ({
  type: 'tool_call',
  id: 'tc',
  name: 'write',
  arguments: arguments_,
  rawArguments: '{}',
})

const lucideClass = (name: string): RegExp => new RegExp(`lucide lucide-${name}`)

describe('ToolCallCard icons', () => {
  it.each([
    ['read', 'file-text'],
    ['find', 'file-text'],
    ['grep', 'file-text'],
    ['edit', 'square-pen'],
    ['write', 'square-pen'],
    ['apply_changes', 'square-pen'],
    ['ls', 'list-checks'],
    ['restore_trash', 'folder'],
    ['bash', 'sparkles'],
    ['discover_agent_tools', 'plug'],
  ] as const)('maps %s to the %s icon', (toolName, iconName) => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName }))
    expect(html).toMatch(lucideClass(iconName))
  })

  it('falls back to the search icon for unknown tool names', () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'mystery' }))
    expect(html).toMatch(lucideClass('search'))
  })
})

describe('ToolCallCard title resolution', () => {
  it('resolves arguments from the matching toolCallId in a multi-tool batch', () => {
    const call = baseAssistant({
      contentBlocks: [
        { ...toolCallBlock({ path: 'first.txt' }), id: 'tc-first' },
        { ...toolCallBlock({ path: 'second.txt' }), id: 'tc-second' },
      ],
      toolCalls: [
        { id: 'tc-first', name: 'read', arguments: { path: 'first.txt' }, rawArguments: '{}' },
        { id: 'tc-second', name: 'read', arguments: { path: 'second.txt' }, rawArguments: '{}' },
      ],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCallId: 'tc-second',
      toolName: 'read',
      call,
    }))

    expect(html).toContain('Read second.txt')
    expect(html).not.toContain('Read first.txt')
  })

  it('uses "Read <path>" for read', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ path: 'docs/plan.md' })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', call }))
    expect(html).toContain('Read docs/plan.md')
  })

  it('uses "Restore <path>" for restore_trash', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ path: 'tmp/old.txt' })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'restore_trash', call }))
    expect(html).toContain('Restore tmp/old.txt')
  })

  it('uses "<Tool> <pattern>" for find/grep', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ pattern: '**/*.ts' })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'find', call }))
    expect(html).toContain('Find **/*.ts')
  })

  it('uses "Run <command preview>" for bash', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ command: 'npm test' })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'bash', call }))
    expect(html).toContain('Run npm test')
  })

  it('shows "Run bash" when bash command is missing', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({})],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'bash', call }))
    expect(html).toContain('Run bash')
  })

  it('uses "Apply N workspace change(s)" for apply_changes', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ operations: [{ type: 'create-file' }] })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'apply_changes', call }))
    expect(html).toContain('Apply 1 workspace change')
  })

  it('pluralises the apply_changes summary when there are multiple operations', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ operations: [{}, {}, {}] })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'apply_changes', call }))
    expect(html).toContain('Apply 3 workspace changes')
  })

  it('falls back to the capitalised tool name when no args or result is available', () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'write' }))
    expect(html).toContain('Write')
  })

  it('ignores tool_call arguments that are not an object', () => {
    const call = baseAssistant({
      contentBlocks: [{ type: 'tool_call', id: 'tc', name: 'read', arguments: 'path:wrong', rawArguments: 'path:wrong' }],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', call }))
    expect(html).toContain('Read')
  })
})

describe('ToolCallCard meta + status', () => {
  it('shows +N / -N diff meta when the result reports diffAdded and diffRemoved', () => {
    const result = baseResult({ details: { diffAdded: 128, diffRemoved: 44 } })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'edit', result }))
    expect(html).toContain('tool-card__meta-diff-add')
    expect(html).toContain('+128')
    expect(html).toContain('tool-card__meta-diff-remove')
    expect(html).toContain('−44')
  })

  it('falls back to formatted sizeBytes when no diff is reported', () => {
    const result = baseResult({ details: { sizeBytes: 2048 } })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', result }))
    expect(html).toContain('2.0 KB')
    expect(html).not.toContain('tool-card__meta-diff-add')
  })

  it('prefers diff stats over sizeBytes when both are present', () => {
    const result = baseResult({ details: { diffAdded: 10, sizeBytes: 2048 } })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'edit', result }))
    expect(html).toContain('+10')
    expect(html).not.toContain('2.0 KB')
  })

  it('formats sizeBytes across the 1 KB and 1 MB thresholds', () => {
    const small = baseResult({ details: { sizeBytes: 512 } })
    expect(renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', result: small })))
      .toContain('512 B')

    const medium = baseResult({ details: { sizeBytes: 1024 * 5 } })
    expect(renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', result: medium })))
      .toContain('5.0 KB')

    const large = baseResult({ details: { sizeBytes: 1024 * 1024 * 2 } })
    expect(renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', result: large })))
      .toContain('2.00 MB')
  })

  it('renders the Check icon for completed calls', () => {
    const result = baseResult({ isError: false })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'write', result }))
    expect(html).toContain('tool-card__done')
    expect(html).toContain('lucide-check')
    expect(html).not.toContain('tool-card__chevron')
  })

  it('renders the ChevronDown icon for errored calls', () => {
    const result = baseResult({ isError: true })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'write', result }))
    expect(html).toContain('tool-card__chevron')
    expect(html).toContain('lucide-chevron-down')
    expect(html).not.toContain('tool-card__done')
  })

  it('renders neither status icon when no result is paired', () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'write' }))
    expect(html).not.toContain('tool-card__done')
    expect(html).not.toContain('tool-card__chevron')
  })
})

describe('ToolCallCard diff view', () => {
  const diffDetails = {
    diffAdded: 1,
    diffRemoved: 1,
    diffPreview: '--- src/a.ts\n+++ src/a.ts\n- old line\n+ new line',
  }

  it('renders an expandable diff body when a completed write result carries a diff preview', () => {
    const result = baseResult({ toolName: 'edit', details: diffDetails })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'edit', result }))
    expect(html).toContain('<details')
    expect(html).toContain('tool-card--expandable')
    expect(html).toContain('tool-card__diff-body')
    expect(html).toContain('tool-card__diff-line--add')
    expect(html).toContain('+ new line')
    expect(html).toContain('tool-card__diff-line--remove')
    expect(html).toContain('- old line')
  })

  it('classifies file headers as meta lines and +/- lines as add/remove', () => {
    const result = baseResult({
      toolName: 'write',
      details: {
        diffAdded: 1,
        diffRemoved: 0,
        diffPreview: '--- /dev/null\n+++ src/new.ts\n+ hello',
      },
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'write', result }))
    expect(html).toContain('tool-card__diff-line--meta')
    expect(html).not.toContain('tool-card__diff-line--context')
  })

  it('shows +N / −N meta alongside the expandable diff', () => {
    const result = baseResult({ toolName: 'edit', details: diffDetails })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'edit', result }))
    expect(html).toContain('tool-card__meta-diff-add')
    expect(html).toContain('+1')
    expect(html).toContain('tool-card__meta-diff-remove')
  })

  it('does not render a diff body when details have no preview or it is blank', () => {
    const withoutPreview = baseResult({ toolName: 'edit', details: { diffAdded: 1 } })
    expect(renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'edit', result: withoutPreview })))
      .not.toContain('tool-card__diff-body')

    const blankPreview = baseResult({ toolName: 'edit', details: { diffPreview: '   ' } })
    expect(renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'edit', result: blankPreview })))
      .not.toContain('tool-card__diff-body')
  })

  it('does not render a diff body for errored results', () => {
    const result = baseResult({ toolName: 'edit', isError: true, details: diffDetails })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'edit', result }))
    expect(html).not.toContain('tool-card__diff-body')
    expect(html).not.toContain('<details')
  })

  it('keeps non-write tools non-expandable', () => {
    const result = baseResult({
      toolName: 'read',
      content: '文件内容',
      details: { diffPreview: '--- x\n+ y' },
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', result }))
    // read 结果不带 diffPreview；即便历史会话残留，也只对写工具语义生效——
    // 这里验证 read 正常路径不进入折叠结构。
    expect(html).not.toContain('<details')
  })
})

describe('ToolCallCard explore_subagent', () => {
  it('uses the compass icon for explore_subagent', () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent' }))
    expect(html).toMatch(lucideClass('compass'))
  })

  it('uses an Explore task preview as the title and truncates long tasks', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ task: 'x'.repeat(100) })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent', call }))
    expect(html).toContain(`Explore ${'x'.repeat(64)}…`)
  })

  it('falls back to a plain "Explore" title when no task is provided', () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent' }))
    expect(html).toContain('>Explore<')
  })

  it('includes scope paths in the title when provided', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ task: '分析架构', scope: ['src', 'docs'] })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent', call }))
    expect(html).toContain('Explore 分析架构 [src, docs]')
  })

  it('truncates scope display to 3 paths with ellipsis', () => {
    const call = baseAssistant({
      contentBlocks: [toolCallBlock({ task: '搜索', scope: ['a', 'b', 'c', 'd', 'e'] })],
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent', call }))
    expect(html).toContain('[a, b, c…]')
  })

  it('shows a running spinner and progress while the sub-agent is active', () => {
    mocks.activeTools = {
      tc: { toolName: 'explore_subagent', content: 'explore: 已完成 3 次只读调用', details: { toolCalls: 3 } },
    }
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCallId: 'tc',
      toolName: 'explore_subagent',
    }))
    expect(html).toContain('tool-card--running')
    expect(html).toContain('tool-card__spinner')
    expect(html).toMatch(lucideClass('loader-circle'))
    expect(html).toContain('explore: 已完成 3 次只读调用')
    expect(html).not.toContain('tool-card__done')
    expect(html).not.toContain('tool-card__chevron')
  })

  it('shows completed meta with turns/toolCalls/duration once the result arrives', () => {
    const result = baseResult({
      toolName: 'explore_subagent',
      details: { status: 'completed', endReason: 'completed', turns: 5, toolCalls: 8, modelRequests: 9, durationMs: 1234 },
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent', result }))
    expect(html).toContain('tool-card__meta-status--completed')
    expect(html).toContain('completed')
    expect(html).toContain('5 turns')
    expect(html).toContain('8 calls')
    expect(html).toContain('1.2s')
    expect(html).not.toContain('tool-card__spinner')
  })

  it('marks partial results with their endReason', () => {
    const result = baseResult({
      toolName: 'explore_subagent',
      details: { status: 'partial', endReason: 'turn_limit', turns: 4, toolCalls: 24, modelRequests: 4, durationMs: 2000 },
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent', result }))
    expect(html).toContain('tool-card__meta-status--partial')
    expect(html).toContain('partial')
    expect(html).toContain('(turn_limit)')
  })

  it('clears the running state once the result arrives even if the store still lists it', () => {
    mocks.activeTools = {
      tc: { toolName: 'explore_subagent', content: 'explore: 已完成 3 次只读调用' },
    }
    const result = baseResult({ toolCallId: 'tc', toolName: 'explore_subagent', content: 'ok' })
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCallId: 'tc',
      toolName: 'explore_subagent',
      result,
    }))
    expect(html).toContain('tool-card__done')
    expect(html).not.toContain('tool-card__spinner')
  })

  it('renders expandable summary (details/summary) when result has content', () => {
    const result = baseResult({
      toolName: 'explore_subagent',
      content: '## 结论\nsrc/a.ts 包含核心逻辑\n\n## 证据\n- src/a.ts:42',
      details: { status: 'completed', turns: 3, toolCalls: 5, modelRequests: 3, durationMs: 1000 },
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent', result }))
    expect(html).toContain('<details')
    expect(html).toContain('tool-card--expandable')
    expect(html).toContain('tool-card__summary-toggle')
    expect(html).toContain('tool-card__summary-body')
    // 摘要正文出现在 HTML 中（details 默认折叠但 DOM 包含内容）
    expect(html).toContain('src/a.ts 包含核心逻辑')
    expect(html).toContain('src/a.ts:42')
  })

  it('does not render expandable summary for non-explore tools with content', () => {
    const result = baseResult({
      toolName: 'read',
      content: '文件内容',
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'read', result }))
    expect(html).not.toContain('<details')
    expect(html).not.toContain('tool-card__summary-body')
  })

  it('does not render expandable summary for explore with empty content', () => {
    const result = baseResult({
      toolName: 'explore_subagent',
      content: '',
      details: { status: 'completed', turns: 1, toolCalls: 0, modelRequests: 1, durationMs: 500 },
    })
    const html = renderToStaticMarkup(createElement(ToolCallCard, { toolName: 'explore_subagent', result }))
    expect(html).not.toContain('<details')
    expect(html).not.toContain('tool-card--expandable')
  })
})
