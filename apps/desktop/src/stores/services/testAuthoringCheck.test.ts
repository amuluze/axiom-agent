import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@/agent/core/types'

const mocks = vi.hoisted(() => ({
  scanTestSpecs: vi.fn(),
  loadSessionMessages: vi.fn(),
}))
vi.mock('./testSpecIndex', () => ({ scanTestSpecs: mocks.scanTestSpecs }))
vi.mock('./testSolidify', () => ({ loadSessionMessages: mocks.loadSessionMessages }))

import { checkSessionTestArtifacts } from './testAuthoringCheck'

const writeCall = (id: string, path: string): AgentMessage => ({
  id: `assistant-${id}`,
  createdAt: 0,
  role: 'assistant',
  content: '',
  stopReason: 'tool_use',
  toolCalls: [{ id, name: 'write', arguments: { path, content: '{}' }, rawArguments: '{}' }],
})

const writeResult = (toolCallId: string, isError = false): AgentMessage => ({
  id: `result-${toolCallId}`,
  createdAt: 0,
  role: 'tool',
  toolName: 'write',
  content: '',
  isError,
  toolCallId,
})

const entry = (path: string, overrides: Record<string, unknown> = {}) => ({
  path,
  valid: true,
  id: 'checkout',
  name: '结算流程',
  caseCount: 2,
  stepCount: 2,
  uiStepCount: 0,
  apiStepCount: 2,
  issues: [],
  ...overrides,
})

const check = () => checkSessionTestArtifacts({ sessionId: 'session-1', workspacePath: '/repo' })

describe('checkSessionTestArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.scanTestSpecs.mockResolvedValue([])
    mocks.loadSessionMessages.mockResolvedValue([])
  })

  it('reports written-and-valid files with their case counts', async () => {
    mocks.loadSessionMessages.mockResolvedValue([writeCall('w1', 'tests/checkout.testspec.json'), writeResult('w1')])
    mocks.scanTestSpecs.mockResolvedValue([
      entry('tests/checkout.testspec.json'),
      entry('tests/preexisting.testspec.json', { caseCount: 1 }),
    ])

    const result = await check()
    expect(result.declared).toEqual(['tests/checkout.testspec.json'])
    expect(result.valid).toEqual([{
      path: 'tests/checkout.testspec.json',
      caseCount: 2,
      testPointCount: 0,
      unverifiedCaseIds: [],
    }])
    expect(result.missing).toEqual([])
    expect(result.invalid).toEqual([])
    // 既有资产不算本会话产物，但要让用户看到"没被本次会话碰过"。
    expect(result.untouched).toEqual(['tests/preexisting.testspec.json'])
  })

  it('flags files without test points and cases without verifies', async () => {
    mocks.loadSessionMessages.mockResolvedValue([writeCall('w1', 'tests/checkout.testspec.json'), writeResult('w1')])
    mocks.scanTestSpecs.mockResolvedValue([
      entry('tests/checkout.testspec.json', {
        caseIds: ['c1', 'c2'],
        caseVerifies: [['tp-1'], []],
        testPointIds: ['tp-1'],
      }),
      entry('tests/legacy.testspec.json'),
    ])
    mocks.loadSessionMessages.mockResolvedValue([
      writeCall('w1', 'tests/checkout.testspec.json'),
      writeResult('w1'),
      writeCall('w2', 'tests/legacy.testspec.json'),
      writeResult('w2'),
    ])

    const result = await check()
    expect(result.valid).toEqual([
      {
        path: 'tests/checkout.testspec.json',
        caseCount: 2,
        testPointCount: 1,
        unverifiedCaseIds: ['c2'],
      },
      {
        path: 'tests/legacy.testspec.json',
        caseCount: 2,
        testPointCount: 0,
        unverifiedCaseIds: [],
      },
    ])
  })

  it('flags a file the session claims to have written but that is not on disk', async () => {
    mocks.loadSessionMessages.mockResolvedValue([writeCall('w1', 'tests/ghost.testspec.json'), writeResult('w1')])
    mocks.scanTestSpecs.mockResolvedValue([])

    const result = await check()
    expect(result.missing).toEqual(['tests/ghost.testspec.json'])
    expect(result.failed).toEqual([])
  })

  it('separates a failed write from a file that vanished', async () => {
    mocks.loadSessionMessages.mockResolvedValue([
      writeCall('w1', 'tests/rejected.testspec.json'),
      writeResult('w1', true),
    ])
    mocks.scanTestSpecs.mockResolvedValue([])

    const result = await check()
    // 两种事实都成立：写入工具报错，且磁盘上没有这个文件。
    expect(result.failed).toEqual(['tests/rejected.testspec.json'])
    expect(result.missing).toEqual(['tests/rejected.testspec.json'])
  })

  it('reports written-but-unparseable files with the parser issues', async () => {
    mocks.loadSessionMessages.mockResolvedValue([writeCall('w1', 'tests/broken.testspec.json'), writeResult('w1')])
    mocks.scanTestSpecs.mockResolvedValue([
      entry('tests/broken.testspec.json', {
        valid: false,
        caseCount: 0,
        issues: [{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' }],
      }),
    ])

    const result = await check()
    expect(result.invalid).toEqual([{
      path: 'tests/broken.testspec.json',
      issues: [{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' }],
    }])
    expect(result.valid).toEqual([])
  })

  it('reports no production at all when the session never wrote a case file', async () => {
    mocks.loadSessionMessages.mockResolvedValue([])
    mocks.scanTestSpecs.mockResolvedValue([entry('tests/preexisting.testspec.json')])

    const result = await check()
    // 机械核对只能回答"有没有落盘"：没有任何写入声明时全部归为既有资产。
    expect(result.declared).toEqual([])
    expect(result.valid).toEqual([])
    expect(result.untouched).toEqual(['tests/preexisting.testspec.json'])
  })
})
