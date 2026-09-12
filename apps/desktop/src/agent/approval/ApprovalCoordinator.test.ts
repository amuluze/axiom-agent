import type { BeforeToolCallContext } from '@/agent/core/types'
import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalCoordinator,
  buildAccessModeBeforeToolCall,
  evaluateAccessModeToolCall,
  type AccessModeDecision,
  type AccessModeEvaluator,
} from './ApprovalCoordinator'

const createContext = (
  signal: AbortSignal,
  overrides: Partial<BeforeToolCallContext> = {},
): BeforeToolCallContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'call-1',
  toolName: 'create_workspace_file',
  toolLabel: '创建工作区文件',
  requiresApproval: true,
  input: { path: 'notes.txt', content: 'secret' },
  presentation: {
    title: '创建 notes.txt？',
    description: '将创建新文件',
    path: 'notes.txt',
    preview: '+ secret',
  },
  assistantMessage: {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: 'call-1',
      name: 'create_workspace_file',
      arguments: { path: 'notes.txt', content: 'secret' },
      rawArguments: '{"path":"notes.txt","content":"secret"}',
    }],
    stopReason: 'tool_use',
    createdAt: 1,
  },
  toolCall: {
    id: 'call-1',
    name: 'create_workspace_file',
    arguments: { path: 'notes.txt', content: 'secret' },
    rawArguments: '{"path":"notes.txt","content":"secret"}',
  },
  context: {
    sessionId: 'session-1',
    systemPrompt: 'system',
    model: { provider: 'test', model: 'model' },
    messages: [],
    tools: [],
  },
  signal,
  ...overrides,
})

describe('ApprovalCoordinator', () => {
  it('exposes only presentation data and resolves an allow-once decision', async () => {
    const coordinator = new ApprovalCoordinator()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    const result = coordinator.request(createContext(new AbortController().signal))

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      toolCallId: 'call-1',
      presentation: expect.objectContaining({ preview: '+ secret' }),
    }))
    expect(listener.mock.calls.at(-1)?.[0]).not.toHaveProperty('input')
    await expect(coordinator.respond('call-1', 'approved')).resolves.toBe(true)
    await expect(result).resolves.toEqual({ decision: 'approved' })
    expect(listener).toHaveBeenLastCalledWith(null)
  })

  it('clears and denies a pending request when the run is aborted', async () => {
    const coordinator = new ApprovalCoordinator()
    const controller = new AbortController()
    const result = coordinator.request(createContext(controller.signal))

    controller.abort()

    await expect(result).resolves.toEqual({ decision: 'denied', reason: 'Agent 运行已取消' })
    await expect(coordinator.respond('call-1', 'approved')).resolves.toBe(false)
  })

  it('settles approval only after a native one-time lease is issued', async () => {
    const issueLease = vi.fn(async () => 'native-lease')
    const coordinator = new ApprovalCoordinator(issueLease)
    const context = createContext(new AbortController().signal)
    const result = coordinator.request(context)

    await expect(coordinator.respond('call-1', 'approved')).resolves.toBe(true)

    expect(issueLease).toHaveBeenCalledWith(context)
    await expect(result).resolves.toEqual({ decision: 'approved', approvalLease: 'native-lease' })
  })

  it('returns false when responding to an unknown toolCallId', async () => {
    const coordinator = new ApprovalCoordinator()
    await expect(coordinator.respond('absent', 'approved')).resolves.toBe(false)
  })

  it('denies with the supplied reason when cancel() runs', async () => {
    const coordinator = new ApprovalCoordinator()
    const promise = coordinator.request(createContext(new AbortController().signal, {
      toolCallId: 'call-cancel',
    }))
    coordinator.cancel('user navigated away')
    await expect(promise).resolves.toMatchObject({
      decision: 'denied',
      reason: 'user navigated away',
    })
  })

  it('queues concurrent approval requests without denying the earlier run', async () => {
    const coordinator = new ApprovalCoordinator()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    const first = coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-old',
      toolCallId: 'call-old',
    }))
    const second = coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-new',
      toolCallId: 'call-new',
    }))

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-old',
      toolCallId: 'call-old',
    }))
    await coordinator.respond('call-old', 'approved')
    await expect(first).resolves.toEqual({ decision: 'approved' })
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-new',
      toolCallId: 'call-new',
    }))
    await coordinator.respond('call-new', 'approved')
    await expect(second).resolves.toEqual({ decision: 'approved' })
    expect(listener).toHaveBeenLastCalledWith(null)
  })

  it('exposes per-session pending views without cross-session leakage', async () => {
    const coordinator = new ApprovalCoordinator()
    const sessionA = coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-a',
      toolCallId: 'call-a',
    }))
    const sessionB = coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-b',
      toolCallId: 'call-b',
    }))

    // 各会话只看到自己的队首审批，不串台；无审批会话返回 null。
    expect(coordinator.getPendingForSession('session-a')).toMatchObject({
      sessionId: 'session-a',
      toolCallId: 'call-a',
    })
    expect(coordinator.getPendingForSession('session-b')).toMatchObject({
      sessionId: 'session-b',
      toolCallId: 'call-b',
    })
    expect(coordinator.getPendingForSession('session-absent')).toBeNull()

    await coordinator.respond('call-a', 'approved')
    await expect(sessionA).resolves.toEqual({ decision: 'approved' })
    expect(coordinator.getPendingForSession('session-a')).toBeNull()
    expect(coordinator.getPendingForSession('session-b')).toMatchObject({ toolCallId: 'call-b' })

    await coordinator.respond('call-b', 'approved')
    await expect(sessionB).resolves.toEqual({ decision: 'approved' })
    expect(coordinator.getPendingForSession('session-b')).toBeNull()
  })

  it('notifies listeners for non-head enqueues so the active session card appears', async () => {
    // 多会话并行审批场景：后台会话先占住队首，激活会话随后入队。通知时机必须
    // 覆盖非队首入队——store 的按会话分组 sync 依赖每次入队都被唤起，否则激活
    // 会话的审批卡片不出现，run 静默阻塞到超时自动拒绝。
    const coordinator = new ApprovalCoordinator()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-background',
      toolCallId: 'call-bg',
    }))
    listener.mockClear()

    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-active',
      toolCallId: 'call-active',
    }))

    expect(listener).toHaveBeenCalled()
    expect(coordinator.getPendingForSession('session-active')).toMatchObject({
      sessionId: 'session-active',
      toolCallId: 'call-active',
    })
  })

  it('notifies listeners when a non-head request settles to clear stale cards', async () => {
    const coordinator = new ApprovalCoordinator()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-background',
      toolCallId: 'call-bg',
    }))
    const active = coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-active',
      toolCallId: 'call-active',
    }))
    listener.mockClear()

    await coordinator.respond('call-active', 'approved')
    await expect(active).resolves.toEqual({ decision: 'approved' })

    // 非队首结算也要通知：否则已展示的审批卡片残留已结算的 stale 视图。
    expect(listener).toHaveBeenCalled()
    expect(coordinator.getPendingForSession('session-active')).toBeNull()
    expect(coordinator.getPendingForSession('session-background')).toMatchObject({
      toolCallId: 'call-bg',
    })
  })

  it('lists unique session ids with pending approvals in enqueue order', async () => {
    const coordinator = new ApprovalCoordinator()
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-b',
      toolCallId: 'call-b1',
    }))
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-a',
      toolCallId: 'call-a1',
    }))
    // 同会话第二个待决审批只计一次。
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-b',
      toolCallId: 'call-b2',
    }))

    expect(coordinator.pendingApprovalSessionIds()).toEqual(['session-b', 'session-a'])

    await coordinator.respond('call-b1', 'denied')
    // b1 结算后队列为 [a1, b2]，列表跟随当前队列顺序。
    expect(coordinator.pendingApprovalSessionIds()).toEqual(['session-a', 'session-b'])
    await coordinator.respond('call-b2', 'denied')
    expect(coordinator.pendingApprovalSessionIds()).toEqual(['session-a'])
    await coordinator.respond('call-a1', 'denied')
    expect(coordinator.pendingApprovalSessionIds()).toEqual([])
  })

  it('falls back to denied when the lease issuer throws', async () => {
    const coordinator = new ApprovalCoordinator(vi.fn(async () => {
      throw new Error('keychain-down')
    }))
    const promise = coordinator.request(createContext(new AbortController().signal))
    await coordinator.respond('call-1', 'approved')
    const result = await promise
    expect(result).toMatchObject({ decision: 'denied' })
    expect(result.reason).toContain('keychain-down')
  })

  it('short-circuits tools that do not require approval', async () => {
    const coordinator = new ApprovalCoordinator()
    const result = await coordinator.request(createContext(new AbortController().signal, {
      requiresApproval: false,
    }))
    expect(result).toEqual({ decision: 'approved' })
  })
})

describe('buildAccessModeBeforeToolCall', () => {
  const buildEvaluator = (
    decision: 'approved' | 'pending',
    lease?: string,
  ): AccessModeEvaluator => vi.fn(async (): Promise<AccessModeDecision> => {
    if (decision === 'pending') return { decision: 'pending' }
    if (lease === undefined) return { decision: 'approved' }
    return { decision: 'approved', approvalLease: lease, auditNote: `note:${decision}` }
  })

  it('approves non-approval tools before consulting the evaluator', async () => {
    const coordinator = new ApprovalCoordinator()
    const evaluator = buildEvaluator('approved')
    const hook = buildAccessModeBeforeToolCall(coordinator, evaluator)
    const result = await hook(createContext(new AbortController().signal, {
      requiresApproval: false,
    }))
    expect(result).toEqual({ decision: 'approved' })
    expect(evaluator).not.toHaveBeenCalled()
  })

  it('returns the evaluator decision and lease when approved', async () => {
    const coordinator = new ApprovalCoordinator()
    const hook = buildAccessModeBeforeToolCall(coordinator, buildEvaluator('approved', 'lease-x'))
    const result = await hook(createContext(new AbortController().signal))
    expect(result).toEqual({ decision: 'approved', approvalLease: 'lease-x' })
  })

  it('forwards the pending decision to the coordinator and resolves on respond', async () => {
    const coordinator = new ApprovalCoordinator()
    const hook = buildAccessModeBeforeToolCall(coordinator, buildEvaluator('pending'))
    const promise = hook(createContext(new AbortController().signal, {
      toolCallId: 'call-pending',
    }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await coordinator.respond('call-pending', 'approved')
    await expect(promise).resolves.toEqual({ decision: 'approved' })
  })

  it('omits the audit note callback when the evaluator returns without one', async () => {
    const coordinator = new ApprovalCoordinator()
    const auditNotes: string[] = []
    const hook = buildAccessModeBeforeToolCall(
      coordinator,
      buildEvaluator('approved', undefined),
      (note) => auditNotes.push(note),
    )
    const result = await hook(createContext(new AbortController().signal))
    expect(result).toEqual({ decision: 'approved' })
    expect(auditNotes).toEqual([])
  })
})

describe('buildAccessModeBeforeToolCall access-mode matrix', () => {
  const runWithMode = async (
    mode: 'standard' | 'no-approval',
    category: 'workspace-write' | 'workspace-command' | undefined,
  ): Promise<{ result: { decision: 'approved' | 'denied'; approvalLease?: string }; auditNotes: string[] }> => {
    const interactiveLeaseIssuer = vi.fn(async () => 'lease-interactive')
    const automaticLeaseIssuer = vi.fn(async () => 'lease-automatic')
    const coordinator = new ApprovalCoordinator(interactiveLeaseIssuer)
    const auditNotes: string[] = []
    const evaluator: AccessModeEvaluator = (context) => evaluateAccessModeToolCall(
      context,
      mode,
      automaticLeaseIssuer,
    )
    const toolCallId = `tc-${mode}-${category ?? 'none'}`
    const toolName = category === 'workspace-command' ? 'bash' : 'write'
    const hook = buildAccessModeBeforeToolCall(coordinator, evaluator, (note) => auditNotes.push(note))
    const promise = hook(createContext(new AbortController().signal, {
      toolCallId,
      toolName,
      presentation: {
        title: '审批',
        description: '审批演示',
        ...(category ? { category } : {}),
      },
    }))
    if (mode === 'standard') {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await coordinator.respond(toolCallId, 'approved')
    }
    const result = await promise
    if (mode === 'standard') {
      expect(interactiveLeaseIssuer).toHaveBeenCalledOnce()
      expect(automaticLeaseIssuer).not.toHaveBeenCalled()
    } else {
      expect(interactiveLeaseIssuer).not.toHaveBeenCalled()
      expect(automaticLeaseIssuer).toHaveBeenCalledOnce()
    }
    return { result, auditNotes }
  }

  it('standard + workspace-write: pending then approved via coordinator', async () => {
    const { result, auditNotes } = await runWithMode('standard', 'workspace-write')
    expect(result.decision).toBe('approved')
    expect(auditNotes).toEqual([])
  })

  it('standard + workspace-command: pending then approved via coordinator', async () => {
    const { result, auditNotes } = await runWithMode('standard', 'workspace-command')
    expect(result.decision).toBe('approved')
    expect(auditNotes).toEqual([])
  })

  it('standard + undefined category: pending then approved via coordinator', async () => {
    const { result, auditNotes } = await runWithMode('standard', undefined)
    expect(result.decision).toBe('approved')
    expect(auditNotes).toEqual([])
  })

  it('no-approval + workspace-write: auto-approves with audit note', async () => {
    const { result, auditNotes } = await runWithMode('no-approval', 'workspace-write')
    expect(result).toMatchObject({ decision: 'approved', approvalLease: 'lease-automatic' })
    expect(auditNotes).toEqual(['免审批放行 write'])
  })

  it('no-approval + workspace-command: auto-approves with audit note', async () => {
    const { result, auditNotes } = await runWithMode('no-approval', 'workspace-command')
    expect(result).toMatchObject({ decision: 'approved', approvalLease: 'lease-automatic' })
    expect(auditNotes).toEqual(['免审批放行 bash'])
  })

  it('evaluator owns the lease-fail fallback and returns pending without an audit note', async () => {
    const coordinator = new ApprovalCoordinator(vi.fn(async () => 'lease-interactive'))
    const auditNotes: string[] = []
    const evaluator: AccessModeEvaluator = (context) => evaluateAccessModeToolCall(
      context,
      'no-approval',
      vi.fn(async () => { throw new Error('automatic lease unavailable') }),
    )
    const hook = buildAccessModeBeforeToolCall(coordinator, evaluator, (note) => auditNotes.push(note))
    const promise = hook(createContext(new AbortController().signal, {
      toolCallId: 'tc-fallback',
      toolName: 'write',
      presentation: { title: '审批', description: '审批演示', category: 'workspace-write' },
    }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await coordinator.respond('tc-fallback', 'approved')
    const result = await promise
    expect(result).toEqual({ decision: 'approved', approvalLease: 'lease-interactive' })
    expect(auditNotes).toEqual([])
  })

  it('auto-denies a pending request when the approval timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new ApprovalCoordinator(undefined, 1_000)
      const listener = vi.fn()
      coordinator.subscribe(listener)
      const result = coordinator.request(createContext(new AbortController().signal))

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(result).resolves.toEqual({
        decision: 'denied',
        reason: '审批等待超时，已自动拒绝',
      })
      expect(listener).toHaveBeenLastCalledWith(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the auto-deny timer when a request settles first', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new ApprovalCoordinator(undefined, 1_000)
      const result = coordinator.request(createContext(new AbortController().signal))

      await coordinator.respond('call-1', 'denied')
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(result).resolves.toEqual({ decision: 'denied', reason: '用户拒绝了本次工具调用' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('pendingViews lists every queued approval in enqueue order', async () => {
    // 后台审批收件箱数据源：必须按入队顺序给出全部待决视图（含同会话多条），
    // store 过滤激活会话后即为后台审批列表。
    const coordinator = new ApprovalCoordinator()
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-a',
      toolCallId: 'call-a1',
    }))
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-b',
      toolCallId: 'call-b1',
    }))
    coordinator.request(createContext(new AbortController().signal, {
      sessionId: 'session-a',
      toolCallId: 'call-a2',
    }))

    expect(coordinator.pendingViews().map((view) => view.toolCallId))
      .toEqual(['call-a1', 'call-b1', 'call-a2'])

    await coordinator.respond('call-b1', 'denied')
    expect(coordinator.pendingViews().map((view) => view.toolCallId))
      .toEqual(['call-a1', 'call-a2'])

    await coordinator.respond('call-a1', 'approved')
    await coordinator.respond('call-a2', 'approved')
    expect(coordinator.pendingViews()).toEqual([])
  })
})
