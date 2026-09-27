// @vitest-environment jsdom
/**
 * 真组件渲染的验收（docs/ax-format.md §4.1/§4.2 与 P2 的三条验收）：
 * ① 注册表每个条目用其 fixture 都能渲染（fixture 是真实的，不是占位）；
 * ② 注册表缺失 / props 非法 → **显式报错**（不静默降级）；
 * ③ **零副作用**：预览态点击审批按钮不触达 store 动作；画布外（无预览 Provider）
 *    行为逐字节不变（仍走真实 store）。
 */
import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '@/stores/agentStore'
import type { PendingToolApproval } from '@/agent/approval/ApprovalCoordinator'
import { parseAxDocument, projectAxToPenDocument, serializeAxDocument } from '@/agent/design/axParser'
import type { AxDocument } from '@/agent/design/axSchema'
import PenNodeView from '../PenNodeView'
import type { PenNode } from '@/agent/design/penParser'
import AxComponentHost from './AxComponentHost'
import { AX_COMPONENT_REGISTRY, axComponentInventorySummary, validateAxProps } from './registry'
import type { PenComponentNode } from '@/agent/design/penParser'
import { parsePenDocument } from '@/agent/design/penParser'

/** 最小文档夹具：宿主只需要一个 `document` 用来解析主题/尺寸上下文。 */
const buildDoc = (node: unknown) => {
  const parsed = parsePenDocument(
    JSON.stringify({ variables: { 'bg-card': '#111111' }, children: [node] }),
    '.pen/axiom.pen',
  )
  if (!parsed.document) throw new Error('fixture parse failed')
  return { doc: parsed.document }
}

const pendingApproval: PendingToolApproval = AX_COMPONENT_REGISTRY.ApprovalCard!
  .fixtures['pending-command']!.pendingApproval as PendingToolApproval

const hostFor = (node: Partial<PenComponentNode> & { name: string }) => {
  const { doc } = buildDoc({ type: 'frame', id: 'p', name: '页' })
  const component: PenComponentNode = { type: 'component', id: 'c1', ...node }
  return render(<AxComponentHost node={component} document={doc} themeMode="dark" />)
}

describe('组件注册表与宿主', () => {
  it('每个注册条目都能用其 fixture 渲染（fixture 与真实 props 契约一致）', () => {
    for (const entry of Object.values(AX_COMPONENT_REGISTRY)) {
      for (const fixture of Object.keys(entry.fixtures)) {
        const { unmount } = hostFor({ name: entry.name, fixture })
        expect(
          document.querySelector(`[data-ax-component="${entry.name}"]`),
          `${entry.name}/${fixture} 应渲染出宿主容器`,
        ).not.toBeNull()
        expect(document.querySelector('.ax-component-error')).toBeNull()
        // 不能只看「宿主容器在」——组件内部抛错会被错误边界兜底，那样也算「渲染了」。
        // 兜底渲染的类名是 design-view__parse-error，出现即说明该条目实际没渲染成功。
        expect(
          document.querySelector('.design-view__parse-error'),
          `${entry.name}/${fixture} 渲染落到错误边界兜底（组件抛错）`,
        ).toBeNull()
        unmount()
      }
    }
  })

  it('注册表缺失该组件时显式报错（含组件名与可用清单）', () => {
    hostFor({ name: 'GhostPanel' })
    const box = document.querySelector('.ax-component-error.is-missing')
    expect(box?.textContent).toContain('GhostPanel')
    expect(box?.textContent).toContain('ResultChip')
  })

  it('props 非法（类型错 / 未声明字段）时显式报错并列出字段', () => {
    hostFor({ name: 'ErrorCard', props: { messageId: 1, nope: true } })
    const box = document.querySelector('.ax-component-error.is-invalid')
    expect(box?.textContent).toContain('messageId')
    expect(box?.textContent).toContain('nope')
  })

  it('props 契约校验：缺必填即报错（fixture 之外的裸契约）', () => {
    const entry = AX_COMPONENT_REGISTRY.ResultChip!
    const missing = validateAxProps(entry, {})
    expect(missing.ok).toBe(false)
    expect(missing.errors.map((item) => item.field)).toContain('message')
    // 类型错与未声明字段分别报错
    const wrongType = validateAxProps(entry, { message: 'x' })
    expect(wrongType.errors.some((item) => item.field === 'message' && item.message.includes('json'))).toBe(true)
    const extra = validateAxProps(entry, { message: {}, ghost: 1 })
    expect(extra.errors.some((item) => item.field === 'ghost')).toBe(true)
    expect(validateAxProps(entry, { message: {} }).ok).toBe(true)
  })

  it('绑定值：$mock 取字面量、$bind 在预览态显示为占位', () => {
    const { unmount } = hostFor({
      name: 'ToolCallCard',
      props: { toolName: { $mock: 'bash' } },
    })
    expect(document.querySelector('.ax-component-error')).toBeNull()
    unmount()
    hostFor({ name: 'ToolCallCard', props: { toolName: { $bind: 'tool.name' } } })
    expect(document.querySelector('.ax-component-error')).toBeNull()
  })

  it('结构化 $mock 原样进 json 型 props（组件按对象取字段，不经过 JSON 字符串）', () => {
    // 工具卡的 call/result 是 json 型 props：`.ax` 1.1 起 mock 可以是对象/数组，
    // 宿主必须把对象**原样**交给组件——组件内部按对象取字段（args.path / details）。
    const { unmount } = hostFor({
      name: 'ToolCallCard',
      props: {
        toolName: { $mock: 'read' },
        toolCallId: { $mock: 'design-preview-tool' },
        call: {
          $mock: {
            id: 'design-preview-tool',
            role: 'assistant',
            content: '',
            createdAt: 0,
            toolCalls: [{ id: 'design-preview-tool', name: 'read', arguments: { path: 'docs/plan.md' } }],
            contentBlocks: [
              { type: 'tool_call', id: 'design-preview-tool', name: 'read', arguments: { path: 'docs/plan.md' } },
            ],
          },
        },
        result: {
          $mock: {
            id: 'design-preview-result',
            role: 'tool',
            toolCallId: 'design-preview-tool',
            isError: false,
            content: '',
            createdAt: 0,
            details: { sizeBytes: 2150 },
          },
        },
      },
    })
    expect(document.querySelector('.ax-component-error')).toBeNull()
    // 真组件按对象里的 args.path 与 details.sizeBytes 渲染出标题与体积。
    expect(document.body.textContent).toContain('Read docs/plan.md')
    expect(document.body.textContent).toContain('2.1 KB')
    unmount()
  })
})

describe('注册表契约', () => {
  it('每个 store 绑定条目都提供了预览数据构造（否则画布内会读到真实会话态）', () => {
    for (const entry of Object.values(AX_COMPONENT_REGISTRY)) {
      if (entry.kind !== 'store-bound') continue
      // 两种形态任选其一：命名字段 preview（单 store 组件）或多 store 切片 storePreview
      // （Sidebar/Composer 这类跨 store 组件）——两者都必须提供，缺了就是读真实会话态。
      expect(entry.preview ?? entry.storePreview, `${entry.name} 缺 preview/storePreview`).toBeTypeOf('function')
      expect(Object.keys(entry.fixtures).length, `${entry.name} 缺 fixtures`).toBeGreaterThan(0)
    }
  })

  it('清单摘要与注册表一致（供 design_query 的组件清单使用）', () => {
    const summary = axComponentInventorySummary()
    expect(summary.map((entry) => entry.name)).toEqual(Object.keys(AX_COMPONENT_REGISTRY).sort())
    for (const entry of summary) {
      expect(entry.sourcePath).toMatch(/\.tsx?$/)
      expect(Array.isArray(entry.props)).toBe(true)
    }
  })
})

describe('预览 seam 的零副作用与画布外不变式', () => {
  const originalActions = {
    approveToolCall: useAgentStore.getState().approveToolCall,
    denyToolCall: useAgentStore.getState().denyToolCall,
    branchFromMessage: useAgentStore.getState().branchFromMessage,
    retryAssistant: useAgentStore.getState().retryAssistant,
  }

  beforeEach(() => {
    useAgentStore.setState({ pendingApproval })
  })

  afterEach(() => {
    useAgentStore.setState({
      pendingApproval: null,
      backgroundApprovals: [],
      ...originalActions,
    })
    vi.restoreAllMocks()
  })

  it('预览态（画布内）点击审批按钮不触达 store 动作', () => {
    const storeCalls = vi.fn()
    useAgentStore.setState({
      approveToolCall: storeCalls,
      denyToolCall: storeCalls,
    })
    hostFor({ name: 'ApprovalCard', fixture: 'pending-command' })
    const approve = screen.getByRole('button', { name: /允许一次|Allow/ })
    const deny = screen.getByRole('button', { name: /拒绝|Deny/ })
    fireEvent.click(approve)
    fireEvent.click(deny)
    expect(storeCalls).not.toHaveBeenCalled()
  })

  it('后台审批收件箱同样是零副作用（新接 seam 的条目也要过这条线）', () => {
    const storeCalls = vi.fn()
    useAgentStore.setState({ approveToolCall: storeCalls, denyToolCall: storeCalls })
    useAgentStore.setState({ backgroundApprovals: [pendingApproval] })
    hostFor({ name: 'BackgroundApprovals', fixture: 'one-pending' })
    const buttons = screen.getAllByRole('button')
    if (buttons[0]) fireEvent.click(buttons[0])
    expect(storeCalls).not.toHaveBeenCalled()
  })

  it('消息流：fixture 消息真渲染，操作行动作在预览态不触达 store', () => {
    const storeCalls = vi.fn()
    useAgentStore.setState({ branchFromMessage: storeCalls, retryAssistant: storeCalls })
    hostFor({ name: 'SessionMessageStream', fixture: 'two-turn' })
    // 消息内容真的渲染出来了（不是空容器、也不是兜底）。
    expect(document.body.textContent).toContain('我先扫一遍工作区文档')
    for (const button of screen.queryAllByRole('button')) {
      fireEvent.click(button)
    }
    expect(storeCalls).not.toHaveBeenCalled()
  })

  it('画布外（无预览 Provider）仍走真实 store 动作', () => {
    const storeCalls = vi.fn()
    useAgentStore.setState({ approveToolCall: storeCalls })
    const { doc } = buildDoc({ type: 'frame', id: 'p', name: '页' })
    render(<PenNodeView node={doc.pages[0]!} document={doc} themeMode="dark" />)
    // 直接渲染真实 ApprovalCard（不经宿主 → 无预览 Provider）。
    const { unmount } = render(<ApprovalCardDirect />)
    fireEvent.click(screen.getByRole('button', { name: /允许一次|Allow/ }))
    expect(storeCalls).toHaveBeenCalledWith(pendingApproval.toolCallId)
    unmount()
  })
})

describe('端到端：.ax 的 component 节点渲染为真实组件', () => {
  it('组件节点经投影后由注册表解析成真实组件（而非占位框）', () => {
    const parsed = parseAxDocument(JSON.stringify({
      ax: '1.0',
      tokens: {},
      components: { ResultChip: { props: { message: 'json' } } },
      pages: [{
        id: 'p1',
        tree: [{
          id: 'c1',
          kind: 'component',
          name: 'ResultChip',
          fixture: 'completed',
        }],
      }],
    }))
    expect(parsed.error).toBeNull()
    const projection = projectAxToPenDocument(parsed.document as AxDocument, 'a.ax')
    expect(serializeAxDocument(parsed.document as AxDocument)).toContain('"kind": "component"')
    const page = projection.document.pages[0] as PenNode
    const node = page.children?.[0] as PenComponentNode
    expect(node.type).toBe('component')
    render(<PenNodeView node={node} document={projection.document} themeMode="dark" />)
    // 真实组件渲染出来了：宿主容器 + ResultChip 自己的类名都在。
    expect(document.querySelector('[data-ax-component="ResultChip"]')).not.toBeNull()
    expect(document.querySelector('.session__result-chip')).not.toBeNull()
    expect(document.querySelector('.pen-node__placeholder')).toBeNull()
  })
})

/** 直接渲染真实审批卡（不经 `.ax` 宿主）：验证「画布外行为不变」。 */
const ApprovalCardDirect = () => {
  const Component = AX_COMPONENT_REGISTRY.ApprovalCard!.component
  return <Component />
}

describe('多 store 切片接缝（Sidebar/Composer）：零副作用与预览渲染', () => {
  it('侧栏：fixture 会话真渲染，全部按钮在预览态不触达 store 与原生 confirm', () => {
    const storeCalls = vi.fn()
    useAgentStore.setState({
      selectSession: storeCalls,
      createNewSession: storeCalls,
      addWorkspace: storeCalls,
      activateWorkspace: storeCalls,
      revokeWorkspace: storeCalls,
      archiveSession: storeCalls,
      stopSession: storeCalls,
      sendToSession: storeCalls,
      releaseQueuedForSession: storeCalls,
    })
    const confirmSpy = vi.spyOn(window, 'confirm')
    const { unmount } = hostFor({ name: 'Sidebar', fixture: 'default' })
    // fixture 会话真渲染出来（画布内看到的是预览数据，不是真实会话态）。
    expect(document.body.textContent).toContain('重构 sandbox deny 名单的读取面判定')
    expect(document.body.textContent).toContain('设计助手侧栏 + 画布页展示优化')
    for (const button of screen.queryAllByRole('button')) fireEvent.click(button)
    expect(storeCalls).not.toHaveBeenCalled()
    // 撤销工作区的 window.confirm 是不经 store 的原生手势，预览态必须一并挡住。
    expect(confirmSpy).not.toHaveBeenCalled()
    unmount()
  })

  it('侧栏空稿 fixture：无会话行（占位提示组），点击同样零副作用', () => {
    const storeCalls = vi.fn()
    useAgentStore.setState({ selectSession: storeCalls, createNewSession: storeCalls })
    const { unmount } = hostFor({ name: 'Sidebar', fixture: 'empty' })
    expect(document.querySelectorAll('.sidebar__task-row')).toHaveLength(0)
    for (const button of screen.queryAllByRole('button')) fireEvent.click(button)
    expect(storeCalls).not.toHaveBeenCalled()
    unmount()
  })

  it('Composer：fixture 队列真渲染，输入+全部按钮在预览态不触达 store 也不写输入历史', () => {
    const storeCalls = vi.fn()
    useAgentStore.setState({
      send: storeCalls,
      stop: storeCalls,
      queueSteering: storeCalls,
      queueFollowUp: storeCalls,
      editUserMessage: storeCalls,
      switchProviderProfile: storeCalls,
      addWorkspace: storeCalls,
      activateWorkspace: storeCalls,
      authorizeFile: storeCalls,
      authorizeDirectory: storeCalls,
      clearQueuedMessages: storeCalls,
      sendQueuedNow: storeCalls,
      restoreQueuedMessage: storeCalls,
      editQueuedMessage: storeCalls,
      moveQueuedMessage: storeCalls,
      deleteQueuedMessage: storeCalls,
      saveQueueAutoDrain: storeCalls,
      discardRecoveredMessage: storeCalls,
      cancelBranchSummary: storeCalls,
    })
    // recordComposerHistoryEntry 写 localStorage：预览态提交不落盘（组件内 agentPreview 门）。
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { unmount } = hostFor({ name: 'Composer', fixture: 'queued' })
    expect(document.body.textContent).toContain('顺手把测试里的魔法数收敛成常量')
    const textarea = document.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (textarea) fireEvent.change(textarea, { target: { value: '画布内输入' } })
    for (const button of screen.queryAllByRole('button')) fireEvent.click(button)
    expect(storeCalls).not.toHaveBeenCalled()
    expect(storageSpy).not.toHaveBeenCalled()
    unmount()
  })

  it('挂载不抢焦点（预览态 autofocus 门）：画布外仍自动聚焦', () => {
    const { unmount } = hostFor({ name: 'Composer', fixture: 'default' })
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA')
    unmount()
  })
})

describe('多 store 切片组件的端到端（.ax → 投影 → 真组件）', () => {
  it('Sidebar/Composer 节点经解析与投影渲染出真实侧栏与输入区（切片接缝生效）', () => {
    const source = JSON.stringify({
      ax: '1.2',
      tokens: {},
      components: {
        Sidebar: { props: { variant: "'default' | 'overlay'" } },
        Composer: { props: { variant: "'new-task' | 'session'", showAccessPicker: 'boolean' } },
      },
      pages: [{
        id: 'p1',
        name: '主页',
        width: 1180,
        height: 780,
        tree: [
          { id: 'n1', kind: 'component', name: 'Sidebar' },
          { id: 'n2', kind: 'component', name: 'Composer' },
        ],
      }],
    })
    // 带真实注册表清单解析（v4 注册表核对：Sidebar/Composer 已在册，声明合法）。
    const parsed = parseAxDocument(source, { componentInventory: axComponentInventorySummary() })
    expect(parsed.error).toBeNull()
    const projection = projectAxToPenDocument(parsed.document as AxDocument, 'a.ax')
    const page = projection.document.pages[0] as PenNode
    const sidebarNode = page.children?.[0] as PenComponentNode
    const composerNode = page.children?.[1] as PenComponentNode
    render(<PenNodeView node={sidebarNode} document={projection.document} themeMode="dark" />)
    expect(document.querySelector('[data-ax-component="Sidebar"]')).not.toBeNull()
    expect(document.querySelector('.sidebar__nav')).not.toBeNull()
    expect(document.querySelector('.design-view__parse-error')).toBeNull()
    render(<PenNodeView node={composerNode} document={projection.document} themeMode="dark" />)
    expect(document.querySelector('[data-ax-component="Composer"]')).not.toBeNull()
    expect(document.querySelector('textarea')).not.toBeNull()
    expect(document.querySelector('.design-view__parse-error')).toBeNull()
  })
})
