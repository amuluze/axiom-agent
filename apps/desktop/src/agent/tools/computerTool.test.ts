import { describe, expect, it, vi } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import type {
  ComputerCommandRequest,
  ComputerCommandResponse,
} from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createComputerTool, COMPUTER_MAX_TEXT_CHARS } from './computerTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  modelAcceptsImage: true,
  ...overrides,
})

const respondsWith =
  (response: ComputerCommandResponse) =>
  async (request: ComputerCommandRequest): Promise<ComputerCommandResponse> => {
    void request
    return response
  }

describe('computerTool validate', () => {
  const tool = createComputerTool(createFakeAgentEnvironment())

  it('accepts each action with its required arguments', () => {
    expect(tool.validate({ action: 'status' }).ok).toBe(true)
    expect(tool.validate({ action: 'apps' }).ok).toBe(true)
    expect(tool.validate({ action: 'open_app', name: '日历' }).ok).toBe(true)
    expect(tool.validate({ action: 'open_app', bundleId: 'com.apple.Calendar' }).ok).toBe(true)
    expect(tool.validate({ action: 'windows', pid: 123 }).ok).toBe(true)
    expect(tool.validate({ action: 'state', pid: 123, screenshot: true }).ok).toBe(true)
    expect(tool.validate({ action: 'click', stateToken: '123:1', elementId: 7 }).ok).toBe(true)
    expect(tool.validate({ action: 'set_value', stateToken: '123:1', elementId: 7, text: 'hi' }).ok).toBe(true)
    expect(tool.validate({ action: 'click_at', x: 10, y: 20, button: 'right', clicks: 2 }).ok).toBe(true)
    expect(tool.validate({ action: 'scroll', x: 10, y: 20, deltaY: -300 }).ok).toBe(true)
    expect(tool.validate({ action: 'type_text', text: '你好' }).ok).toBe(true)
    expect(tool.validate({ action: 'key', key: 'Enter', modifiers: ['cmd'] }).ok).toBe(true)
    expect(tool.validate({ action: 'screenshot' }).ok).toBe(true)
    expect(tool.validate({ action: 'stop' }).ok).toBe(true)
  })

  it('rejects unknown actions and misplaced arguments', () => {
    expect(tool.validate({ action: 'app_state' }).ok).toBe(false)
    expect(tool.validate({ action: 'apps', pid: 1 }).ok).toBe(false)
    expect(tool.validate({ action: 'click', elementId: 7 }).ok).toBe(false)
    expect(tool.validate({ action: 'open_app' }).ok).toBe(false)
    expect(tool.validate({}).ok).toBe(false)
    expect(tool.validate('apps').ok).toBe(false)
  })

  it('enforces anchors, text bounds, modifiers and coordinate rules', () => {
    expect(tool.validate({ action: 'click', stateToken: '', elementId: 7 }).ok).toBe(false)
    expect(tool.validate({ action: 'click', stateToken: '123:1', elementId: 0 }).ok).toBe(false)
    expect(tool.validate({ action: 'set_value', stateToken: '123:1', elementId: 7, text: 123 }).ok).toBe(false)
    expect(
      tool.validate({ action: 'set_value', stateToken: '123:1', elementId: 7, text: 'a'.repeat(COMPUTER_MAX_TEXT_CHARS + 1) }).ok,
    ).toBe(false)
    expect(tool.validate({ action: 'key', key: 'Enter', modifiers: ['win'] }).ok).toBe(false)
    expect(tool.validate({ action: 'key', key: '' }).ok).toBe(false)
    expect(tool.validate({ action: 'click_at', x: 10, y: 'down' }).ok).toBe(false)
    expect(tool.validate({ action: 'click_at', x: Number.NaN, y: 20 }).ok).toBe(false)
    expect(tool.validate({ action: 'click_at', x: 10, y: 20, button: 'middle' }).ok).toBe(false)
    expect(tool.validate({ action: 'click_at', x: 10, y: 20, clicks: 5 }).ok).toBe(false)
    expect(tool.validate({ action: 'screenshot', pid: 0 }).ok).toBe(false)
  })
})

describe('computerTool execute', () => {
  it('injects the execution sessionId into control requests', async () => {
    const environment = createFakeAgentEnvironment({
      computerCommand: respondsWith({ type: 'done' }),
    })
    const tool = createComputerTool(environment)
    await tool.execute({ action: 'click', stateToken: '123:1', elementId: 7 }, baseContext())
    expect(environment.computer.command).toHaveBeenCalledWith({
      action: 'clickElement',
      sessionId: 'session-1',
      stateToken: '123:1',
      elementId: 7,
    })
    await tool.execute({ action: 'open_app', name: '日历' }, baseContext({ sessionId: 'session-2' }))
    expect(environment.computer.command).toHaveBeenCalledWith({
      action: 'openApp',
      sessionId: 'session-2',
      name: '日历',
    })
    await tool.execute({ action: 'key', key: 'enter', modifiers: ['cmd'] }, baseContext())
    expect(environment.computer.command).toHaveBeenCalledWith({
      action: 'pressKey',
      sessionId: 'session-1',
      key: 'enter',
      modifiers: ['cmd'],
    })
  })

  it('observation actions do not carry a sessionId', async () => {
    const environment = createFakeAgentEnvironment({
      computerCommand: respondsWith({ type: 'done' }),
    })
    const tool = createComputerTool(environment)
    await tool.execute({ action: 'apps' }, baseContext())
    expect(environment.computer.command).toHaveBeenCalledWith({ action: 'listApps' })
    await tool.execute({ action: 'state', pid: 42 }, baseContext())
    expect(environment.computer.command).toHaveBeenCalledWith({
      action: 'appState',
      pid: 42,
      includeScreenshot: false,
    })
  })

  it('formats app lists with frontmost markers and empty-state guidance', async () => {
    const empty = createComputerTool(
      createFakeAgentEnvironment({ computerCommand: respondsWith({ type: 'apps', apps: [] }) }),
    )
    const emptyResult = await empty.execute({ action: 'apps' }, baseContext())
    expect(emptyResult.content).toContain('没有可控制')

    const populated = createComputerTool(
      createFakeAgentEnvironment({
        computerCommand: respondsWith({
          type: 'apps',
          apps: [
            { pid: 1, name: 'Axiom', bundleId: 'com.axiom.desktop', frontmost: true },
            { pid: 2, name: '备忘录', frontmost: false },
          ],
        }),
      }),
    )
    const result = await populated.execute({ action: 'apps' }, baseContext())
    expect(result.content).toContain('Axiom（前台）')
    expect(result.content).toContain('com.axiom.desktop')
    expect(result.content).toContain('备忘录')
  })

  it('returns the state tree with the stateToken anchor guidance', async () => {
    const tool = createComputerTool(
      createFakeAgentEnvironment({
        computerCommand: respondsWith({
          type: 'state',
          stateToken: '321:0',
          app: { pid: 321, name: '备忘录', frontmost: true },
          tree: '- [eid=1] application "备忘录"\n  - [eid=7] button "提交"',
          truncated: false,
        }),
      }),
    )
    const result = await tool.execute({ action: 'state', pid: 321 }, baseContext())
    expect(result.content).toContain('stateToken：321:0')
    expect(result.content).toContain('[eid=7] button "提交"')
    expect(result.details).toMatchObject({ stateToken: '321:0', truncated: false })
  })

  it('emits an image content block for state screenshots and degrades for non-vision models', async () => {
    const stateResponse: ComputerCommandResponse = {
      type: 'state',
      stateToken: '321:0',
      app: { pid: 321, name: '备忘录', frontmost: true },
      tree: '- [eid=1] application "备忘录"',
      truncated: false,
      screenshot: {
        imageBase64: 'aGVsbG8=',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        resized: false,
      },
    }
    const vision = createComputerTool(
      createFakeAgentEnvironment({ computerCommand: respondsWith(stateResponse) }),
    )
    const visionResult = await vision.execute({ action: 'state', pid: 321, screenshot: true }, baseContext())
    expect(visionResult.contentBlocks).toEqual([
      { type: 'text', text: expect.stringContaining('stateToken：321:0') },
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
      },
    ])

    const nonVision = createComputerTool(
      createFakeAgentEnvironment({ computerCommand: respondsWith(stateResponse) }),
    )
    const degraded = await nonVision.execute(
      { action: 'state', pid: 321, screenshot: true },
      baseContext({ modelAcceptsImage: false }),
    )
    expect(degraded.contentBlocks).toBeUndefined()
    expect(degraded.content).toContain('不支持图片输入')
  })

  it('formats the status response with permissions, grants and allowlist', async () => {
    const tool = createComputerTool(
      createFakeAgentEnvironment({
        computerCommand: respondsWith({
          type: 'status',
          accessibility: true,
          screenRecording: false,
          grants: [
            { sessionId: 'session-1', pid: 42, appName: '备忘录' },
            { sessionId: 'session-1', pid: 43, appName: '备忘录' },
          ],
          allowlist: [{ bundleId: 'com.apple.Finder', name: '访达' }],
        }),
      }),
    )
    const result = await tool.execute({ action: 'status' }, baseContext())
    expect(result.content).toContain('辅助功能 已授权')
    expect(result.content).toContain('屏幕录制 未授权')
    expect(result.content).toContain('已授权控制：备忘录')
    expect(result.content).toContain('始终允许：访达')
  })

  it('re-throws environment errors verbatim so the runtime marks isError', async () => {
    const environment = createFakeAgentEnvironment({
      computerCommand: async () => {
        throw new Error('用户拒绝了在「备忘录」上的电脑控制')
      },
    })
    const tool = createComputerTool(environment)
    await expect(tool.execute({ action: 'click', stateToken: '1:0', elementId: 1 }, baseContext())).rejects.toThrow(
      '用户拒绝了',
    )
  })

  it('aborts before dispatching when the signal is already aborted', async () => {
    const environment = createFakeAgentEnvironment()
    const tool = createComputerTool(environment)
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ action: 'apps' }, baseContext({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(environment.computer.command).not.toHaveBeenCalled()
    expect(vi.mocked(environment.computer.command).mock.calls.length).toBe(0)
  })
})

describe('computerTool contract metadata', () => {
  it('declares never-recovery, serialized execution and no per-call approval', () => {
    const tool = createComputerTool(createFakeAgentEnvironment())
    expect(tool.name).toBe('computer')
    expect(tool.runtimeVersion).toBe('1')
    expect(tool.recoveryPolicy).toBe('never')
    expect(tool.requiresApproval).toBe(false)
    expect(tool.executionMode).toBe('sequential')
    expect(tool.idempotencyKey).toBeUndefined()
    expect(tool.promptSnippet).toBeTruthy()
    expect(tool.promptGuidelines?.length).toBeGreaterThan(0)
  })

  it('keeps discoverability keywords in the description surface', () => {
    const tool = createComputerTool(createFakeAgentEnvironment())
    const haystack = `${tool.name} ${tool.label} ${tool.description} ${tool.promptSnippet ?? ''}`.toLowerCase()
    for (const keyword of ['computer', 'accessibility', 'click', 'screenshot', 'mac']) {
      expect(haystack).toContain(keyword)
    }
  })
})
