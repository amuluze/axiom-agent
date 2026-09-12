import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'
import type { UserMessage } from '@/agent/core/types'
import { decodeRuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'
import { EMPTY_PROJECT_SKILL_INVENTORY } from '@/agent/skills/types'
import type { SessionRepository } from '@/persistence/types'

const mocks = vi.hoisted(() => ({
  repository: undefined as SessionRepository | undefined,
}))

vi.mock('@/persistence/createSessionRepository', () => ({
  createSessionRepository: vi.fn(async () => {
    if (!mocks.repository) throw new Error('missing test repository')
    return mocks.repository
  }),
}))

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: () => false,
}))

vi.mock('@/platform/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/platform/workspace')>()
  return {
    ...original,
    activateAuthorizedWorkspace: vi.fn(async (path: string) => ({
      path,
      name: path.split('/').filter(Boolean).at(-1) ?? path,
      gitBranch: null,
    })),
  }
})

class FaultInjectingSessionRepository extends MemorySessionRepository {
  private listFailures = 0
  private rejectAllLists = false
  private eventFailureType: Parameters<MemorySessionRepository['recordEvent']>[1]['type'] | undefined
  private clearBarrier: Promise<void> | undefined
  private releaseClearBarrier: (() => void) | undefined
  private eventBarrier: Promise<void> | undefined
  private releaseEventBarrier: (() => void) | undefined
  private eventBarrierEntered: (() => void) | undefined
  private blockedEvent: {
    sessionId: string
    type: Parameters<MemorySessionRepository['recordEvent']>[1]['type']
  } | undefined

  failNextList(): void {
    this.listFailures += 1
  }

  failEveryList(): void {
    this.rejectAllLists = true
  }

  restoreLists(): void {
    this.rejectAllLists = false
  }

  failNextEvent(type: Parameters<MemorySessionRepository['recordEvent']>[1]['type']): void {
    this.eventFailureType = type
  }

  blockNextClear(): void {
    this.clearBarrier = new Promise((resolve) => {
      this.releaseClearBarrier = resolve
    })
  }

  releaseClear(): void {
    this.releaseClearBarrier?.()
    this.clearBarrier = undefined
    this.releaseClearBarrier = undefined
  }

  blockNextEvent(
    sessionId: string,
    type: Parameters<MemorySessionRepository['recordEvent']>[1]['type'],
  ): Promise<void> {
    this.blockedEvent = { sessionId, type }
    this.eventBarrier = new Promise((resolve) => {
      this.releaseEventBarrier = resolve
    })
    return new Promise((resolve) => {
      this.eventBarrierEntered = resolve
    })
  }

  releaseEvent(): void {
    this.releaseEventBarrier?.()
  }

  override async clearSession(sessionId: string): Promise<void> {
    if (this.clearBarrier) await this.clearBarrier
    return super.clearSession(sessionId)
  }

  override async listSessions() {
    if (this.rejectAllLists) throw new Error('injected session list failure')
    if (this.listFailures > 0) {
      this.listFailures -= 1
      throw new Error('injected session list failure')
    }
    return super.listSessions()
  }

  override async recordEvent(...args: Parameters<MemorySessionRepository['recordEvent']>) {
    const [sessionId, event] = args
    if (this.blockedEvent?.sessionId === sessionId && this.blockedEvent.type === event.type) {
      const barrier = this.eventBarrier
      this.eventBarrierEntered?.()
      if (barrier) await barrier
      this.blockedEvent = undefined
      this.eventBarrier = undefined
      this.releaseEventBarrier = undefined
      this.eventBarrierEntered = undefined
    }
    if (args[1].type === this.eventFailureType) {
      this.eventFailureType = undefined
      throw new Error('injected event persistence failure')
    }
    return super.recordEvent(...args)
  }
}

describe('agentStore session activation', () => {
  const repository = new FaultInjectingSessionRepository()
  const makeWorkspaceCurrent = (useAgentStore: typeof import('./agentStore')['useAgentStore']) => {
    const workspace = { path: '/repo/axiom', name: 'axiom', gitBranch: 'test' }
    useAgentStore.setState({
      authorizedWorkspace: workspace,
      authorizedWorkspaces: [workspace],
    })
  }
  const ensureBoundSession = async (
    useAgentStore: typeof import('./agentStore')['useAgentStore'],
  ): Promise<string> => {
    makeWorkspaceCurrent(useAgentStore)
    const active = useAgentStore.getState().sessions.find((stored) => (
      stored.id === useAgentStore.getState().activeSessionId
    ))
    if (!active?.workspace) {
      await expect(useAgentStore.getState().createNewSession('/repo/axiom')).resolves.toBe(true)
    }
    return useAgentStore.getState().activeSessionId!
  }

  beforeAll(() => {
    mocks.repository = repository
  })

  it('reloads and atomically activates a committed session after a transient list failure', { timeout: 15_000 }, async () => {
    const { useAgentStore } = await import('./agentStore')
    await useAgentStore.getState().initialize()
    const originalSessionId = useAgentStore.getState().activeSessionId
    expect(originalSessionId).toBeTruthy()
    await useAgentStore.getState().send('must not start without a workspace')
    expect(useAgentStore.getState().messages).toEqual([])
    expect(useAgentStore.getState().error).toContain('工作目录')
    makeWorkspaceCurrent(useAgentStore)

    repository.failNextList()
    await expect(useAgentStore.getState().createNewSession()).resolves.toBe(true)

    const createdState = useAgentStore.getState()
    expect(createdState.activeSessionId).not.toBe(originalSessionId)
    expect(createdState.messages).toEqual([])
    expect(createdState.sessions.some((candidate) => candidate.id === createdState.activeSessionId))
      .toBe(true)
    expect(createdState.settingsError).toBeNull()

    repository.failNextList()
    await expect(useAgentStore.getState().selectSession(originalSessionId!)).resolves.toBe(true)

    const selectedState = useAgentStore.getState()
    expect(selectedState.activeSessionId).toBe(originalSessionId)
    expect(selectedState.messages).toEqual([])
    expect(selectedState.sessions.some((candidate) => candidate.id === originalSessionId)).toBe(true)
    expect(selectedState.settingsError).toBeNull()
  })

  it('persists a canonical v3 manifest after activating a compatible v2 session', { timeout: 15_000 }, async () => {
    const { useAgentStore } = await import('./agentStore')
    const sourceSessionId = useAgentStore.getState().activeSessionId!
    const source = await repository.loadSession(sourceSessionId)
    const current = source.session.runtimeManifest
    if (!current) throw new Error('missing current Runtime manifest')
    const legacyManifest = decodeRuntimeDependencyManifest({
      schemaVersion: 2,
      provider: current.provider,
      tools: current.tools,
      hooks: current.hooks.map(({ id, version }) => ({ id, version })),
    })
    const legacy = await repository.createSession({
      systemPrompt: source.session.systemPrompt,
      modelProvider: source.session.modelProvider,
      modelId: source.session.modelId,
      reasoning: source.session.reasoning,
      activeToolNames: source.session.activeToolNames,
      providerConfig: source.session.providerConfig ?? undefined,
      runtimeManifest: legacyManifest,
    })

    await expect(useAgentStore.getState().selectSession(legacy.session.id)).resolves.toBe(true)

    const persisted = await repository.loadSession(legacy.session.id)
    expect(persisted.session.runtimeManifest).toMatchObject({ schemaVersion: 4 })
    expect(persisted.session.runtimeManifest?.migratedFromSchemaVersion).toBeUndefined()
    expect(persisted.session.runtimeManifest?.hooks.every((hook) => hook.fingerprint !== 'legacy-v2'))
      .toBe(true)
    await expect(useAgentStore.getState().deleteSession(sourceSessionId)).resolves.toBe(true)
  })

  it('persists the current Hook contract after an explicit version migration', async () => {
    const { useAgentStore } = await import('./agentStore')
    const sourceSessionId = useAgentStore.getState().activeSessionId!
    const source = await repository.loadSession(sourceSessionId)
    const current = source.session.runtimeManifest
    if (!current) throw new Error('missing current Runtime manifest')
    const previous = structuredClone(current)
    previous.hooks = previous.hooks.map((hook) => hook.id === 'axiom.desktop.runtime-hooks'
      ? { ...hook, version: '5', fingerprint: 'previous-v5' }
      : hook)
    const legacy = await repository.createSession({
      systemPrompt: source.session.systemPrompt,
      modelProvider: source.session.modelProvider,
      modelId: source.session.modelId,
      reasoning: source.session.reasoning,
      activeToolNames: source.session.activeToolNames,
      providerConfig: source.session.providerConfig ?? undefined,
      runtimeManifest: previous,
    })

    await expect(useAgentStore.getState().selectSession(legacy.session.id)).resolves.toBe(true)

    const persisted = await repository.loadSession(legacy.session.id)
    expect(persisted.session.runtimeManifest?.hooks).toContainEqual(expect.objectContaining({
      id: 'axiom.desktop.runtime-hooks',
      version: '9',
    }))
    await expect(useAgentStore.getState().deleteSession(sourceSessionId)).resolves.toBe(true)
  })

  it('restores a session with its persisted skill snapshot after on-disk skills changed', async () => {
    // 回归：删除 .axiom/skills 下 skill 后，恢复旧会话不应因磁盘扫描快照变化
    // 而触发 "Session 项目 Skill 依赖不兼容" 阻断（§8.1 会话冻结值）。
    const { useAgentStore } = await import('./agentStore')
    const { bindActiveProjectSkillSnapshot } = await import('@/agent/skills/activeProjectSkills')
    const sourceSessionId = useAgentStore.getState().activeSessionId!
    const source = await repository.loadSession(sourceSessionId)
    const current = source.session.runtimeManifest
    if (!current) throw new Error('missing current Runtime manifest')
    const frozenSkill = {
      name: 'legacy-skill',
      description: 'skill removed from disk',
      source: { kind: 'project' as const, root: '.axiom/skills' as const },
      relativePath: 'legacy-skill/SKILL.md',
      baseRelativePath: '.axiom/skills',
      contentSha256: 'a'.repeat(64),
      disableModelInvocation: false,
    }
    const storedManifest = decodeRuntimeDependencyManifest({
      schemaVersion: 4,
      provider: current.provider,
      tools: current.tools,
      hooks: current.hooks,
      skills: { schemaVersion: 1, skills: [frozenSkill] },
    })
    const stored = await repository.createSession({
      systemPrompt: source.session.systemPrompt,
      modelProvider: source.session.modelProvider,
      modelId: source.session.modelId,
      reasoning: source.session.reasoning,
      activeToolNames: source.session.activeToolNames,
      providerConfig: source.session.providerConfig ?? undefined,
      runtimeManifest: storedManifest,
    })
    // 模拟磁盘变化：用户删除了项目 skill，当前扫描快照为空。
    bindActiveProjectSkillSnapshot(EMPTY_PROJECT_SKILL_INVENTORY)

    await expect(useAgentStore.getState().selectSession(stored.session.id)).resolves.toBe(true)

    // 冻结值保持：persisted skills 仍是被删前的清单，未被磁盘空快照覆盖。
    const persisted = await repository.loadSession(stored.session.id)
    expect(persisted.session.runtimeManifest?.skills.skills).toHaveLength(1)
    expect(persisted.session.runtimeManifest?.skills.skills[0]?.name).toBe('legacy-skill')
    await expect(useAgentStore.getState().deleteSession(sourceSessionId)).resolves.toBe(true)
  })

  it('projects a committed session from the returned snapshot during a persistent list outage', async () => {
    const { useAgentStore } = await import('./agentStore')
    const originalSessionId = useAgentStore.getState().activeSessionId
    makeWorkspaceCurrent(useAgentStore)
    repository.failEveryList()
    try {
      await expect(useAgentStore.getState().createNewSession()).resolves.toBe(true)
    } finally {
      repository.restoreLists()
    }

    const state = useAgentStore.getState()
    expect(state.activeSessionId).not.toBe(originalSessionId)
    expect(state.sessions.some((candidate) => candidate.id === state.activeSessionId)).toBe(true)
    expect(state.settingsError).toBeNull()
    await expect(useAgentStore.getState().deleteSession(originalSessionId!)).resolves.toBe(true)
  })

  it('commits Provider changes through the shared activation recovery path', async () => {
    const { useAgentStore } = await import('./agentStore')
    const provider = structuredClone(useAgentStore.getState().provider)

    repository.failNextList()
    await expect(useAgentStore.getState().saveProvider(provider)).resolves.toEqual({
      saved: true,
      ready: true,
    })

    const state = useAgentStore.getState()
    expect(state.provider).toEqual(provider)
    expect(state.providerMessage).toContain('配置已保存')
    expect(state.providerSaving).toBe(false)
    expect(state.sessionBusy).toBe(false)
    expect(state.settingsError).toBeNull()
  })

  it('keeps the Store cleared during a persistent list outage after the database commit', async () => {
    const { useAgentStore } = await import('./agentStore')
    const activeSessionId = useAgentStore.getState().activeSessionId!
    const message: UserMessage = {
      id: 'clear-activation-message',
      role: 'user',
      content: 'clear me',
      createdAt: 10,
    }
    await repository.commitMutationBatch(activeSessionId, {
      id: 'mutation:clear-activation-message',
      sessionId: activeSessionId,
      events: [{ type: 'session_message_append', sessionId: activeSessionId, message }],
      createdAt: 10,
    })
    useAgentStore.setState({ messages: [message] })
    expect(useAgentStore.getState().messages).toEqual([message])

    repository.failEveryList()
    try {
      await useAgentStore.getState().clear()
    } finally {
      repository.restoreLists()
    }

    const state = useAgentStore.getState()
    expect(state.activeSessionId).toBe(activeSessionId)
    expect(state.messages).toEqual([])
    expect(state.sessions.some((candidate) => candidate.id === activeSessionId)).toBe(true)
    expect(state.error).toBeNull()
  })

  it('serializes Store structural operations with one synchronous lease', async () => {
    const { useAgentStore } = await import('./agentStore')
    const activeSessionId = useAgentStore.getState().activeSessionId
    const otherSessionId = useAgentStore.getState().sessions
      .find((candidate) => candidate.id !== activeSessionId)?.id
    expect(activeSessionId).toBeTruthy()
    expect(otherSessionId).toBeTruthy()

    repository.blockNextClear()
    const clearing = useAgentStore.getState().clear()
    expect(useAgentStore.getState().sessionBusy).toBe(true)
    await expect(useAgentStore.getState().createNewSession()).resolves.toBe(false)
    await expect(useAgentStore.getState().selectSession(otherSessionId!)).resolves.toBe(false)
    expect(useAgentStore.getState().activeSessionId).toBe(activeSessionId)

    repository.releaseClear()
    await clearing
    expect(useAgentStore.getState().sessionBusy).toBe(false)
    expect(useAgentStore.getState().activeSessionId).toBe(activeSessionId)
  })

  it('preserves the primary persistence error after rebinding the recovered Runtime', async () => {
    const { useAgentStore } = await import('./agentStore')
    await ensureBoundSession(useAgentStore)
    repository.failNextEvent('agent_end')

    await useAgentStore.getState().send('trigger persistence recovery')

    const state = useAgentStore.getState()
    expect(state.error).toContain('injected event persistence failure')
    expect(state.error).not.toContain('释放流程')
    expect(state.running).toBe(false)
  })

  it('keeps two session runtimes isolated while one finishes in the background', async () => {
    const { useAgentStore } = await import('./agentStore')
    const firstSessionId = await ensureBoundSession(useAgentStore)
    await expect(useAgentStore.getState().createNewSession()).resolves.toBe(true)
    const secondSessionId = useAgentStore.getState().activeSessionId!
    await expect(useAgentStore.getState().selectSession(firstSessionId)).resolves.toBe(true)

    const firstRunReachedEnd = repository.blockNextEvent(firstSessionId, 'agent_end')
    const firstRun = useAgentStore.getState().send('parallel session alpha')
    await firstRunReachedEnd
    expect(useAgentStore.getState().running).toBe(true)

    await expect(useAgentStore.getState().selectSession(secondSessionId)).resolves.toBe(true)
    expect(useAgentStore.getState()).toMatchObject({
      activeSessionId: secondSessionId,
      running: false,
    })
    await useAgentStore.getState().send('parallel session beta')
    const secondMessages = structuredClone(useAgentStore.getState().messages)
    expect(secondMessages.some((message) => message.content.includes('parallel session beta')))
      .toBe(true)
    expect(useAgentStore.getState().sessions.find((stored) => stored.id === firstSessionId)?.status)
      .toBe('running')

    repository.releaseEvent()
    await firstRun
    expect(useAgentStore.getState()).toMatchObject({
      activeSessionId: secondSessionId,
      running: false,
      messages: secondMessages,
    })

    await expect(useAgentStore.getState().selectSession(firstSessionId)).resolves.toBe(true)
    expect(useAgentStore.getState().messages.some((message) => (
      message.content.includes('parallel session alpha')
    ))).toBe(true)
    expect(useAgentStore.getState().running).toBe(false)
    await expect(useAgentStore.getState().deleteSession(secondSessionId)).resolves.toBe(true)
  })

  it('projects persisted in-flight messages when switching back to a running session', async () => {
    // 回归：运行中的 harness.messages（historyMessages）要到 runAgentLoop 返回才
    // 合并本轮消息；运行期间切走再切回时，缓存激活若直接投影它会丢掉整轮已发生
    // 消息（新会话则整个列表为空）。必须以 repository 快照（message_end 即时落库）
    // 为投影来源。
    const { useAgentStore } = await import('./agentStore')
    // 本文件共享同一 store/repo 单例且后续测试依赖精确的会话记账：先记录进入前的
    // 活动会话，测试结束后切回并清掉本测试创建的会话。
    const previousActiveSessionId = useAgentStore.getState().activeSessionId
    const workspaceA = { path: '/repo/switch-a', name: 'switch-a', gitBranch: 'main' }
    useAgentStore.setState({
      authorizedWorkspace: workspaceA,
      authorizedWorkspaces: [workspaceA],
    })
    await expect(useAgentStore.getState().createNewSession('/repo/switch-a')).resolves.toBe(true)
    const runningSessionId = useAgentStore.getState().activeSessionId!

    const runEndBarrier = repository.blockNextEvent(runningSessionId, 'agent_end')
    const running = useAgentStore.getState().send('switch away alpha')
    await runEndBarrier
    expect(useAgentStore.getState().running).toBe(true)

    // 切到第二个工作目录新建会话，再切回运行中的会话。
    const workspaceB = { path: '/repo/switch-b', name: 'switch-b', gitBranch: null }
    useAgentStore.setState({ authorizedWorkspaces: [workspaceA, workspaceB] })
    await expect(useAgentStore.getState().createNewSession('/repo/switch-b')).resolves.toBe(true)
    const backgroundSessionId = useAgentStore.getState().activeSessionId!
    expect(backgroundSessionId).not.toBe(runningSessionId)

    await expect(useAgentStore.getState().selectSession(runningSessionId)).resolves.toBe(true)
    const state = useAgentStore.getState()
    expect(state.activeSessionId).toBe(runningSessionId)
    expect(state.running).toBe(true)

    // repository 已持久化运行中消息（message_end 即时落库），投影必须包含它们。
    const persisted = await repository.loadSession(runningSessionId)
    expect(persisted.messages.length).toBeGreaterThan(0)
    const projectedContents = state.messages.map((message) => message.content)
    for (const persistedMessage of persisted.messages) {
      expect(projectedContents).toContain(persistedMessage.content)
    }

    repository.releaseEvent()
    await running
    expect(useAgentStore.getState().activeSessionId).toBe(runningSessionId)
    expect(useAgentStore.getState().running).toBe(false)
    await expect(useAgentStore.getState().deleteSession(backgroundSessionId)).resolves.toBe(true)
    await expect(useAgentStore.getState().selectSession(previousActiveSessionId!)).resolves.toBe(true)
    await expect(useAgentStore.getState().deleteSession(runningSessionId)).resolves.toBe(true)
  })

  it('activates a prepared successor after deleting the active session', async () => {
    const { useAgentStore } = await import('./agentStore')
    const deletedSessionId = useAgentStore.getState().activeSessionId
    const expectedSuccessorId = useAgentStore.getState().sessions
      .find((candidate) => candidate.id !== deletedSessionId)?.id
    expect(deletedSessionId).toBeTruthy()
    expect(expectedSuccessorId).toBeTruthy()

    repository.failNextList()
    await expect(useAgentStore.getState().deleteSession(deletedSessionId!)).resolves.toBe(true)

    const state = useAgentStore.getState()
    expect(state.activeSessionId).toBe(expectedSuccessorId)
    expect(state.sessions.some((candidate) => candidate.id === deletedSessionId)).toBe(false)
    expect(state.sessions.some((candidate) => candidate.id === expectedSuccessorId)).toBe(true)
    expect(state.sessionBusy).toBe(false)
    expect(state.settingsError).toBeNull()
    await expect(repository.loadSession(deletedSessionId!)).rejects.toThrow('不存在')
  })

  it('atomically replaces the final active session', async () => {
    const { useAgentStore } = await import('./agentStore')
    const deletedSessionId = useAgentStore.getState().activeSessionId
    expect(useAgentStore.getState().sessions).toHaveLength(1)

    await expect(useAgentStore.getState().deleteSession(deletedSessionId!)).resolves.toBe(true)

    const state = useAgentStore.getState()
    expect(state.activeSessionId).toBeTruthy()
    expect(state.activeSessionId).not.toBe(deletedSessionId)
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]?.id).toBe(state.activeSessionId)
    expect(state.messages).toEqual([])
    expect(state.sessionBusy).toBe(false)
  })

  it('continues a committed Retry branch during a persistent list outage', async () => {
    const { useAgentStore } = await import('./agentStore')
    const retrySourceSessionId = await ensureBoundSession(useAgentStore)
    const sourceWorkspace = useAgentStore.getState().sessions
      .find((stored) => stored.id === retrySourceSessionId)?.workspace
    expect(sourceWorkspace).toBeTruthy()
    await useAgentStore.getState().send('retry source')
    const sourceState = useAgentStore.getState()
    expect(sourceState.error).toBeNull()
    const assistant = sourceState.messages.find((message) => message.role === 'assistant')
    expect(assistant).toBeTruthy()

    repository.failEveryList()
    let retried = false
    try {
      retried = await useAgentStore.getState().retryAssistant(assistant!.id)
    } finally {
      repository.restoreLists()
    }

    const state = useAgentStore.getState()
    expect(retried).toBe(true)
    expect(state.activeSessionId).not.toBe(retrySourceSessionId)
    expect(state.sessions.find((candidate) => candidate.id === state.activeSessionId)?.branchKind)
      .toBe('retry')
    expect(state.sessions.find((candidate) => candidate.id === state.activeSessionId)?.workspace)
      .toEqual(sourceWorkspace)
    expect(state.messages[0]?.content).toBe('retry source')
    expect(state.messages.at(-1)?.role).toBe('assistant')
    expect(state.error).toBeNull()
    expect(state.sessionBusy).toBe(false)
  })

  it('persists queue modes, agent limits, reasoning, and clears queued messages', async () => {
    const { useAgentStore } = await import('./agentStore')
    await useAgentStore.getState().initialize()
    expect(useAgentStore.getState().runtimeLifecycle).toBe('ready')

    expect(useAgentStore.getState().saveQueueModes({ steering: 'all', followUp: 'all' })).toBe(true)
    expect(useAgentStore.getState().queueModeSettings).toMatchObject({
      steering: 'all',
      followUp: 'all',
    })

    expect(useAgentStore.getState().saveAgentLimits({ maxTurns: 8, maxToolCalls: 24 })).toBe(true)
    expect(useAgentStore.getState().agentLimitsSettings).toMatchObject({
      maxTurns: 8,
      maxToolCalls: 24,
    })

    // demo provider 不支持 reasoning，normalize 会按能力回落为 off。
    await expect(useAgentStore.getState().saveReasoningSettings({
      level: 'low',
      mode: 'enabled',
      budgetTokens: 2048,
    })).resolves.toBe(true)
    expect(useAgentStore.getState().providerMessage).toContain('Reasoning')

    await useAgentStore.getState().clearQueuedMessages()
    expect(useAgentStore.getState().queuedMessages).toEqual([])

    // 空会话下 compact 是幂等成功；随后 continueConversation 因无消息直接返回。
    await expect(useAgentStore.getState().compactContext()).resolves.toBe(true)
    await useAgentStore.getState().continueConversation()
    expect(useAgentStore.getState().running).toBe(false)
  })

})
