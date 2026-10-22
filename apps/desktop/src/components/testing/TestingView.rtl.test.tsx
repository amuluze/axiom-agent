// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentReadiness } from '@/agent/testing/environment/readiness'
import type { GatedEnvironmentReadiness } from '@/stores/services/testEnvironmentReadiness'
import type { TestSuiteRunResult } from '@/stores/services/testSuiteRunner'

const ENGINE_READY: EnvironmentReadiness = { ready: true, verdict: 'ready', reason: '环境就绪', status: 200, elapsedMs: 3 }
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import { useBrowserStore } from '@/stores/browserStore'

const mocks = vi.hoisted(() => ({
  scanTestSpecs: vi.fn(),
  setTestingPromptContext: vi.fn(async (_text: string | null) => undefined),
  checkSessionTestArtifacts: vi.fn(),
  scanEnvironmentFiles: vi.fn(async () => []),
  // T1-3 运行前置门：默认「环境就绪」，门本身的行为由专门用例覆盖。
  ensureEnvironmentReady: vi.fn(async (): Promise<GatedEnvironmentReadiness> => ({
    readiness: ENGINE_READY,
    facts: {
      environmentId: 'env-1', name: '环境', kind: 'remote',
      probe: { method: 'GET', url: 'http://127.0.0.1/' },
      verdict: 'ready', status: 200, elapsedMs: 3, preparedBy: 'probe',
    },
  })),
  listTestRunRecords: vi.fn(),
  getLatestTestBatchRecord: vi.fn(),
  getTestRunRecord: vi.fn(),
  listTestEnvironmentRecords: vi.fn(),
  prepareUiTestRun: vi.fn(),
  startUiTestRun: vi.fn(),
  runTestSuite: vi.fn(),
  selectSession: vi.fn(async () => true),
  sendToSession: vi.fn(async (_sessionId: string, _payload: string) => true),
  setView: vi.fn(),
  openRuntimeRailPane: vi.fn(),
  requestComposerInsertion: vi.fn(),
  prepareSolidifyDraft: vi.fn(),
  buildSolidifyPayload: vi.fn(() => 'SOLIDIFY-PAYLOAD'),
  loadSessionMessages: vi.fn(async () => []),
  solidifySpecId: vi.fn(() => 'checkout'),
  countDraftSteps: vi.fn(() => 2),
  loadSpecDetail: vi.fn(),
  readArtifactText: vi.fn(),
  useUiStoreHook: vi.fn(),
  // H1-5 档位门可变体：默认按生产档放行固化，档位门用例里翻回 false。
  runtimePolicy: {
    testAutomation: { externalTargets: true, agentGeneration: true },
  },
}))

vi.mock('@/stores/agentStore', () => ({
  setTestingPromptContext: mocks.setTestingPromptContext,
  useAgentStore: (selector: (state: {
    authorizedWorkspace: { path: string; name: string }
    sessions: Array<{ id: string; title: string; workspace: { path: string; name: string }; archivedAt: null }>
    activeSessionId: string
    messages: unknown[]
    providerReady: boolean
    providerSetupRequired: boolean
    runtimeLifecycle: string
    selectSession: typeof mocks.selectSession
    sendToSession: typeof mocks.sendToSession
  }) => unknown) => selector({
    authorizedWorkspace: { path: '/repo', name: 'repo' },
    sessions: [{
      id: 'session-1',
      title: '开发会话',
      workspace: { path: '/repo', name: 'repo' },
      archivedAt: null,
    }],
    activeSessionId: 'session-1',
    messages: [],
    providerReady: true,
    providerSetupRequired: false,
    runtimeLifecycle: 'ready',
    selectSession: mocks.selectSession,
    sendToSession: mocks.sendToSession,
  }),
}))
vi.mock('@/stores/uiStore', () => {
  // 选器 hook + getState（组件经 `useUiStore.getState().requestComposerInsertion` 注入骨架）
  // 同一闭包——类型擦除到 any 以避免与 Mock<Procedure> 在 useUiStoreFn 上的重载冲突。
  const useUiStoreFn = Object.assign(
    (selector: (state: { theme: string; setView: typeof mocks.setView; openRuntimeRailPane: typeof mocks.openRuntimeRailPane }) => unknown) =>
      selector({ theme: 'system', setView: mocks.setView, openRuntimeRailPane: mocks.openRuntimeRailPane }),
    { getState: () => ({ requestComposerInsertion: mocks.requestComposerInsertion }) },
  )
  return { useUiStore: useUiStoreFn as unknown as typeof mocks.useUiStoreHook }
})
vi.mock('@/stores/services/testSpecIndex', () => ({ scanTestSpecs: mocks.scanTestSpecs }))
vi.mock('@/stores/services/testEnvironmentFiles', () => ({ scanEnvironmentFiles: mocks.scanEnvironmentFiles }))
vi.mock('@/stores/services/testEnvironmentReadiness', () => ({ ensureEnvironmentReady: mocks.ensureEnvironmentReady }))
vi.mock('@/stores/services/testAuthoringCheck', () => ({ checkSessionTestArtifacts: mocks.checkSessionTestArtifacts }))
vi.mock('@/stores/services/testSpecDetail', () => ({ loadSpecDetail: mocks.loadSpecDetail }))
vi.mock('@/platform/artifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/artifacts')>()
  return { ...actual, readArtifactText: mocks.readArtifactText }
})
vi.mock('@/platform/testRuns', () => ({
  listTestRunRecords: mocks.listTestRunRecords,
  getLatestTestBatchRecord: mocks.getLatestTestBatchRecord,
  getTestRunRecord: mocks.getTestRunRecord,
}))
vi.mock('@/platform/testEnvironments', () => ({
  listTestEnvironmentRecords: mocks.listTestEnvironmentRecords,
  saveTestEnvironmentRecord: vi.fn(),
  deleteTestEnvironmentRecord: vi.fn(),
}))
vi.mock('@/stores/services/testRunPreparation', () => ({
  prepareUiTestRun: mocks.prepareUiTestRun,
  browserTargetOrigin: (url: string) => new URL(url).origin,
}))
vi.mock('@/stores/services/testRuntimeService', () => ({ startUiTestRun: mocks.startUiTestRun }))
vi.mock('@/stores/services/testSuiteRunner', () => ({ runTestSuite: mocks.runTestSuite }))
vi.mock('@/config/runtimePolicy', () => ({ RUNTIME_POLICY: mocks.runtimePolicy }))
vi.mock('@/stores/services/testSolidify', () => ({
  prepareSolidifyDraft: mocks.prepareSolidifyDraft,
  buildSolidifyPayload: mocks.buildSolidifyPayload,
  loadSessionMessages: mocks.loadSessionMessages,
  solidifySpecId: mocks.solidifySpecId,
  countDraftSteps: mocks.countDraftSteps,
}))

import { TestingView } from './TestingView'

const plan: CompiledTestPlan = {
  specId: 'checkout',
  name: '结算流程',
  specVersion: 1,
  specHash: 'hash',
  target: { webBaseUrl: 'https://shop.test' },
  environmentNames: [],
  cases: [{
    id: 'case-one',
    name: '结算',
    steps: [{ id: 'assert-title', action: 'ui.assert', expect: { urlContains: '/checkout' } }],
  }],
}

const persistedReport: TestRunDetailRecord = {
  summary: {
    id: 'run-1',
    specPath: 'tests/checkout.testspec.json',
    specHash: 'hash',
    environmentId: null,
    batchId: null,
    envFactsJson: null,
    status: 'passed',
    startedAt: 1,
    finishedAt: 2,
  },
  planContentHash: 'plan-hash',
  cases: [{
    id: 'case-run',
    caseId: 'case-one',
    caseName: '结算',
    status: 'passed',
    startedAt: 1,
    finishedAt: 2,
    failureKind: null,
    failureOrigin: null,
    steps: [{
      id: 'step-run',
      stepId: 'assert-title',
      action: 'ui.assert',
      status: 'passed',
      startedAt: 1,
      finishedAt: 2,
      detailsJson: null,
      evidenceContentHash: 'a'.repeat(64),
      evidenceArtifact: {
        id: 'artifact-1',
        kind: 'image',
        mediaType: 'image/png',
        relativePath: `artifacts/sha256/aa/${'a'.repeat(64)}`,
        contentHash: 'a'.repeat(64),
        sizeBytes: 128,
        createdAt: 1,
      },
    }],
  }],
}

describe('TestingView run flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 档位门默认按生产档放行；需要验证 H1-5 门的用例自行翻回 false。
    mocks.runtimePolicy.testAutomation.agentGeneration = true
    useBrowserStore.setState({
      tabs: [{
        tabId: 'tab-1',
        title: 'Shop',
        url: 'https://shop.test/checkout',
        active: true,
        hasDialog: false,
      }],
    })
    mocks.scanTestSpecs.mockResolvedValue([{
      path: 'tests/checkout.testspec.json',
      valid: true,
      id: 'checkout',
      name: '结算流程',
      caseCount: 1,
      stepCount: 1,
      uiStepCount: 1,
      apiStepCount: 0,
      issues: [],
      testPointIds: ['tp-one'],
      caseIds: ['case-one'],
      caseVerifies: [['tp-one']],
    }])
    mocks.listTestRunRecords.mockResolvedValue([])
    mocks.getLatestTestBatchRecord.mockResolvedValue(null)
    mocks.listTestEnvironmentRecords.mockResolvedValue([])
    mocks.readArtifactText.mockReset().mockResolvedValue(JSON.stringify({
      specId: 'checkout',
      name: '结算流程',
      specVersion: 2,
      specHash: 'hash',
      target: {},
      environmentNames: [],
      testPoints: [{ id: 'tp-one', kind: 'new_feature', title: '测试点', acceptance: '可判定' }],
      cases: [{ id: 'case-one', name: '结算', verifies: ['tp-one'], steps: [] }],
    }))
    mocks.ensureEnvironmentReady.mockResolvedValue({
      readiness: ENGINE_READY,
      facts: {
        environmentId: 'env-1', name: '环境', kind: 'remote',
        probe: { method: 'GET', url: 'http://127.0.0.1/' },
        verdict: 'ready', status: 200, elapsedMs: 3, preparedBy: 'probe',
      },
    })
    mocks.prepareUiTestRun.mockResolvedValue(plan)
    // 套件运行：默认把给定 specs 逐个记为通过，runId 依次编号（组件据此打开最后一份报告）。
    mocks.runTestSuite.mockImplementation(async (input: { specs: Array<{ path: string }> }) => ({
      batchId: 'test-batch-1',
      blockedReason: null,
      entries: input.specs.map((spec, index) => ({ path: spec.path, runId: `run-${index + 1}`, status: 'passed' })),
    }))
    mocks.startUiTestRun.mockImplementation(async (input: {
      onStepStatusChange?: (change: { caseId: string; stepId: string; status: 'running' | 'passed' }) => void
    }) => {
      input.onStepStatusChange?.({ caseId: 'case-one', stepId: 'assert-title', status: 'running' })
      input.onStepStatusChange?.({ caseId: 'case-one', stepId: 'assert-title', status: 'passed' })
      return {
        specHash: 'hash',
        environmentId: null,
        batchId: null,
        envFactsJson: null,
        status: 'passed',
        cases: [{
          caseId: 'case-one',
          name: '结算',
          status: 'passed',
          steps: [{ stepId: 'assert-title', action: 'ui.assert', status: 'passed' }],
        }],
      }
    })
    mocks.getTestRunRecord.mockResolvedValue(persistedReport)
    mocks.loadSpecDetail.mockImplementation(async (path: string) => {
      if (path === 'tests/api.testspec.json') {
        return {
          name: 'API 用例', version: 1,
          cases: [{ id: 'api-case', name: 'API', type: 'api', stepCount: 1, assertCount: 0, assertSummary: null }],
          assertCount: 0, uiCaseCount: 0, apiCaseCount: 1, mixedCaseCount: 0,
        }
      }
      return {
        name: '结算流程', version: 1,
        cases: [{ id: 'case-one', name: '结算', type: 'ui', stepCount: 1, assertCount: 1, assertSummary: 'URL 包含 /checkout' }],
        assertCount: 1, uiCaseCount: 1, apiCaseCount: 0, mixedCaseCount: 0,
      }
    })
  })

  it('selects the active tab, runs the selected spec and opens the persisted report', async () => {
    render(<TestingView />)

    const run = await screen.findByRole('button', { name: '重放' })
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalled())
    expect(mocks.runTestSuite).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/repo',
      specs: [expect.objectContaining({ path: 'tests/checkout.testspec.json' })],
      tab: expect.objectContaining({ tabId: 'tab-1', url: 'https://shop.test/checkout' }),
    }))
    expect(await screen.findByRole('heading', { name: '运行报告' })).toBeInTheDocument()
    expect(screen.getAllByText('通过').length).toBeGreaterThan(0)
    expect(screen.getByText('图片 Artifact')).toBeInTheDocument()

    // 重放（同源：selectedSpecPath 已与报告 specPath 同步）
    fireEvent.click((await screen.findAllByRole('button', { name: '重放' }))[0])
    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalledTimes(2))
  })

  it('transitions overview → running progress → persisted report in one run', async () => {
    let resolveRun: ((result: TestSuiteRunResult) => void) | undefined
    mocks.runTestSuite.mockImplementation((input: {
      onRunStarted?: (progress: { index: number; total: number; path: string; runId: string }) => void
      onStepStatusChange?: (info: { runId: string; change: { caseId: string; stepId: string; status: 'running' } }) => void
    }) => {
      input.onRunStarted?.({
        index: 1,
        total: 1,
        path: 'tests/checkout.testspec.json',
        runId: 'run-1',
      })
      input.onStepStatusChange?.({
        runId: 'run-1',
        change: { caseId: 'case-one', stepId: 'assert-title', status: 'running' },
      })
      return new Promise<TestSuiteRunResult>((resolve) => { resolveRun = resolve })
    })
    render(<TestingView />)

    // 总览：选中 spec 后「重放」可用。
    const run = await screen.findByRole('button', { name: '重放' })
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    // 运行中：进度条与停止按钮来自 activeRun（不是旧选中 spec）。
    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalled())
    expect(await screen.findByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()

    // 结算：套件返回后打开持久化报告。
    resolveRun?.({
      batchId: 'test-batch-1',
      blockedReason: null,
      entries: [{ path: 'tests/checkout.testspec.json', runId: 'run-1', status: 'passed' }],
    })
    expect(await screen.findByRole('heading', { name: '运行报告' })).toBeInTheDocument()
    expect(screen.getAllByText('通过').length).toBeGreaterThan(0)
  })

  it('filters specs and sends a structured failure summary to the selected session', async () => {
    mocks.scanTestSpecs.mockResolvedValue([
      ...await mocks.scanTestSpecs(),
      {
        path: 'tests/api.testspec.json',
        valid: true,
        id: 'api',
        name: 'API 用例',
        caseCount: 1,
        stepCount: 1,
        uiStepCount: 0,
        apiStepCount: 1,
        issues: [],
      },
    ])
    mocks.getTestRunRecord.mockResolvedValue({
      ...persistedReport,
      summary: { ...persistedReport.summary, status: 'failed' },
      cases: persistedReport.cases.map((testCase) => ({
        ...testCase,
        status: 'failed',
        failureOrigin: 'environment',
        steps: testCase.steps.map((step) => ({
          ...step,
          status: 'failed',
          detailsJson: JSON.stringify({ message: '页面标题不匹配' }),
        })),
      })),
    })
    render(<TestingView />)

    const filter = await screen.findByRole('combobox', { name: '类型' })
    fireEvent.change(filter, { target: { value: 'api' } })
    // 切换到 API 用例：标题行 h1 显示 spec name，UI 用例被过滤后不再渲染
    expect(await screen.findByRole('heading', { level: 1, name: 'API 用例' })).toBeInTheDocument()
    expect(screen.queryByText('结算流程')).not.toBeInTheDocument()

    fireEvent.change(filter, { target: { value: 'ui' } })
    fireEvent.click((await screen.findAllByRole('button', { name: '重放' }))[0])
    expect(await screen.findByRole('button', { name: '发送并打开会话' })).toBeEnabled()
    // 宿主归因直接决定这张卡片的下一步提示：环境问题先修环境，而不是去改断言。
    expect(await screen.findByTestId('test-report-origin')).toHaveTextContent('环境（传输层或探针）')
    expect(screen.getByText(/先修环境/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发送并打开会话' }))

    await waitFor(() => expect(mocks.sendToSession).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('页面标题不匹配'),
    ))
    // 摘要带测试点覆盖（含追溯用例）：修复方看得到"哪个功能点没跑到"。
    expect(mocks.sendToSession.mock.calls[0]?.[1]).toContain('测试点覆盖：tp-one [未通过]（用例 case-one）')
    // 报告页提供 JUnit XML 出口（喂标准 CI）。
    expect(screen.getByRole('button', { name: '导出 JUnit XML' })).toBeInTheDocument()
  })

  it('escalates to human attention when the same failure persists for three rounds', async () => {
    const failedReport = {
      ...persistedReport,
      summary: { ...persistedReport.summary, status: 'failed' as const },
      cases: persistedReport.cases.map((testCase) => ({
        ...testCase,
        status: 'failed' as const,
        failureOrigin: 'assertion',
        steps: testCase.steps.map((step) => ({
          ...step,
          status: 'failed' as const,
          detailsJson: JSON.stringify({ message: '页面标题不匹配' }),
        })),
      })),
    }
    mocks.getTestRunRecord.mockResolvedValue(failedReport)
    mocks.listTestRunRecords.mockResolvedValue([
      { id: 'run-prev-2', specPath: 'tests/checkout.testspec.json', specHash: 'hash', environmentId: null, batchId: null, envFactsJson: null, status: 'failed', startedAt: 1, finishedAt: 2 },
      { id: 'run-prev-1', specPath: 'tests/checkout.testspec.json', specHash: 'hash', environmentId: null, batchId: null, envFactsJson: null, status: 'failed', startedAt: 0, finishedAt: 1 },
    ])
    render(<TestingView />)

    fireEvent.click((await screen.findAllByRole('button', { name: '重放' }))[0])

    // 同一失败连续第三轮：报告点名「需要人工介入」，并停止推荐重跑。
    expect(await screen.findByTestId('test-report-repair-round')).toHaveTextContent('同一失败第 3 轮未通过')
    expect(await screen.findByText(/需要人工介入/)).toBeInTheDocument()
    // 停止推荐重跑：常规提示（"改用例后重放"）在这一轮不再出现。
    expect(screen.queryByText(/改写用例后重放/)).not.toBeInTheDocument()
  })

  it('shows the pending approval while the run is still preparing', async () => {
    // 准备阶段（就绪探针/编译）时 activeRun 仍为 null：这一段的审批卡必须在**用例视图**里可见，
    // 否则探针的批准请求无处可点，整批静默挂起（原生旅程实测到的缺陷，这里是它的回归测试）。
    mocks.runTestSuite.mockImplementation(async (input: {
      approver: { approve: (request: unknown, signal: AbortSignal) => Promise<boolean> }
    }) => {
      void input.approver.approve({
        actor: { kind: 'testStep', testRunId: 'probe-run', stepId: 'env-probe:env-1' },
        card: { actionLabel: '探测环境就绪', target: 'http://127.0.0.1:1/', origin: 'http://127.0.0.1:1' },
      }, new AbortController().signal)
      return await new Promise(() => undefined)
    })
    render(<TestingView />)

    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    fireEvent.click(run)

    expect(await screen.findByText('探测环境就绪')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许执行' })).toBeInTheDocument()
  })

  it('runs an API-only spec without an open browser tab', async () => {
    useBrowserStore.setState({ tabs: [] })
    mocks.scanTestSpecs.mockResolvedValue([{
      path: 'tests/api.testspec.json',
      valid: true,
      id: 'api',
      name: 'API 用例',
      caseCount: 1,
      stepCount: 1,
      uiStepCount: 0,
      apiStepCount: 1,
      issues: [],
    }])
    mocks.prepareUiTestRun.mockResolvedValue({
      specId: 'api',
      name: 'API 用例',
      specVersion: 1,
      specHash: 'api-hash',
      target: { apiBaseUrl: 'https://api.example.test' },
      environmentNames: [],
      cases: [{
        id: 'api-case',
        name: 'API',
        steps: [{
          id: 'health',
          action: 'api.request',
          method: 'GET',
          url: 'https://api.example.test/health',
          expect: [{ status: 200 }],
        }],
      }],
    })
    render(<TestingView />)

    const run = await screen.findByRole('button', { name: '重放' })
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalled())
    // 纯 API 用例不需要目标标签页。
    expect(mocks.runTestSuite.mock.calls.at(-1)?.[0]).not.toHaveProperty('tab')
    expect(screen.queryByRole('button', { name: '打开浏览器' })).not.toBeInTheDocument()
  })

  it('solidifies the source session trajectory and sends the draft to the target session', async () => {
    mocks.prepareSolidifyDraft.mockResolvedValue({
      status: 'ok',
      stepCount: 2,
      draft: {
        spec: {
          kind: 'axiom.test',
          version: 1,
          id: 'checkout',
          name: '结算流程',
          target: {},
          cases: [{
            id: 'main',
            name: '探索固化',
            steps: [
              { id: 'step-1-ui-navigate', action: 'ui.navigate', url: 'https://shop.test/' },
              { id: 'step-2-ui-click', action: 'ui.click', locator: { role: 'unknown', name: '待补充定位器' } },
            ],
          }],
        },
        issues: [{
          stepIndex: 1,
          toolName: 'ui_click',
          code: 'locator-unavailable',
          message: '需要补充稳定定位器',
        }],
      },
    })
    render(<TestingView />)

    const generate = await screen.findByRole('button', { name: '固化到用例文件' })
    await waitFor(() => expect(generate).not.toBeDisabled())
    fireEvent.click(generate)

    await waitFor(() => expect(mocks.prepareSolidifyDraft).toHaveBeenCalled())
    // 源会话即激活会话时直接用 store 投影，不再回读仓库。
    expect(mocks.prepareSolidifyDraft).toHaveBeenCalledWith([], expect.objectContaining({ id: 'checkout' }))
    expect((await screen.findAllByText('tests/checkout.testspec.json')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('needsReview').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '发送到会话' }))
    await waitFor(() => expect(mocks.sendToSession).toHaveBeenCalledWith('session-1', 'SOLIDIFY-PAYLOAD'))
  })

  it('surfaces an explicit message when the source session has no explorable steps', async () => {
    mocks.prepareSolidifyDraft.mockResolvedValue({ status: 'no-explorer-steps', stepCount: 0 })
    render(<TestingView />)

    const generate = await screen.findByRole('button', { name: '固化到用例文件' })
    await waitFor(() => expect(generate).not.toBeDisabled())
    fireEvent.click(generate)

    expect(await screen.findByText('源会话没有可固化的探索步骤（未调用 ui_* / api_request 工具）。'))
      .toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送到会话' })).not.toBeInTheDocument()
  })

  it('disables the solidify panel with a tier explanation when agentGeneration is off', async () => {
    mocks.runtimePolicy.testAutomation.agentGeneration = false
    render(<TestingView />)

    const generate = await screen.findByRole('button', { name: '固化到用例文件' })
    expect(generate).toBeDisabled()
    expect(await screen.findByText('Agent 固化生成需在 Beta 发布档启用，当前构建未开放。'))
      .toBeInTheDocument()
    // 档位门在链首：即便工作区/会话/模型齐备，也不进入下游空态文案。
    expect(screen.queryByText('尚未选择工作区，无法固化。')).not.toBeInTheDocument()
    fireEvent.click(generate)
    expect(mocks.prepareSolidifyDraft).not.toHaveBeenCalled()
  })

  it('sends a structured authoring instruction for the described feature', async () => {
    render(<TestingView />)

    const input = await screen.findByLabelText(/要测的功能/)
    fireEvent.change(input, { target: { value: '优惠券叠加规则' } })
    fireEvent.click(screen.getByRole('button', { name: '发送给测试助手' }))

    await waitFor(() => expect(mocks.sendToSession).toHaveBeenCalledTimes(1))
    const [sessionId, instruction] = mocks.sendToSession.mock.calls[0] ?? []
    expect(sessionId).toBe('session-1')
    expect(instruction).toContain('- 功能：优惠券叠加规则')
    // 纪律与文件名都由这条消息承载：提示词里不放瞬时意图。
    expect(instruction).toContain('load_skill({ name: "test-design" })')
    expect(instruction).toContain('只写 tests/ 目录下的用例文件')
    expect(instruction).toMatch(/- 目标用例文件：tests\/[a-z0-9-]+\.testspec\.json/)
    expect(await screen.findByText(/已发送/)).toBeInTheDocument()
  })

  it('keeps the authoring send disabled until a feature is described', async () => {
    render(<TestingView />)
    expect(await screen.findByRole('button', { name: '发送给测试助手' })).toBeDisabled()
  })

  it('reports what the session actually produced instead of trusting its summary', async () => {
    mocks.checkSessionTestArtifacts.mockResolvedValue({
      declared: ['tests/checkout.testspec.json', 'tests/ghost.testspec.json'],
      missing: ['tests/ghost.testspec.json'],
      invalid: [{
        path: 'tests/broken.testspec.json',
        issues: [{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' }],
      }],
      valid: [{ path: 'tests/checkout.testspec.json', caseCount: 3 }],
      failed: [],
      untouched: ['tests/preexisting.testspec.json'],
    })
    render(<TestingView />)

    fireEvent.click(await screen.findByRole('button', { name: '检查会话产物' }))

    await waitFor(() => expect(mocks.checkSessionTestArtifacts).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspacePath: '/repo',
    }))
    expect(await screen.findByText(/本会话写入 2 个用例文件/)).toBeInTheDocument()
    // 「声称写了但没落盘」必须点名到文件，而不是给一句"看起来没问题"。
    expect(screen.getByText('tests/ghost.testspec.json')).toBeInTheDocument()
    expect(screen.getByText(/\$\.version 不支持的版本，当前支持 1 \/ 2/)).toBeInTheDocument()
    expect(screen.getByText(/另有 1 个既有用例文件未被本会话改动/)).toBeInTheDocument()
  })

  it('blocks the run when the selected environment is not ready and shows the probe reason', async () => {
    mocks.scanTestSpecs.mockResolvedValue([{
      path: 'tests/api.testspec.json',
      valid: true,
      id: 'api',
      name: 'API 用例',
      caseCount: 1,
      stepCount: 1,
      uiStepCount: 0,
      apiStepCount: 1,
      issues: [],
    }])
    mocks.listTestEnvironmentRecords.mockResolvedValue([{
      id: 'env-blocked',
      name: '内网环境',
      kind: 'remote',
      recipeJson: null,
      webBaseUrl: null,
      apiBaseUrl: 'http://10.0.0.5:8080',
      viewportWidth: null,
      viewportHeight: null,
      allowPrivateNetwork: false,
      headersJson: '{}',
      secretIdsJson: '[]',
      createdAt: 1,
      updatedAt: 2,
    }])
    mocks.runTestSuite.mockResolvedValue({
      batchId: 'test-batch-blocked',
      blockedReason: '宿主拒绝了这次探测请求：未授权访问回环或私网地址。这是地址与网络策略的问题，不代表环境不存在。',
      entries: [],
    })
    render(<TestingView />)

    const run = await screen.findByRole('button', { name: '重放' })
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    // 探针原因原样展示，不被收敛成「环境不可用」。
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('未授权访问回环或私网地址'))
    // 批次级前置失败：没有任何 run 落库，因此也不会打开报告。
    expect(mocks.runTestSuite).toHaveBeenCalledTimes(1)
    expect(mocks.getTestRunRecord).not.toHaveBeenCalled()
  })

  it('runs every valid spec under one batch and shows the batch summary', async () => {
    mocks.scanTestSpecs.mockResolvedValue(['a', 'b', 'c'].map((name) => ({
      path: `tests/${name}.testspec.json`,
      valid: true,
      id: name,
      name: `用例 ${name}`,
      caseCount: 1,
      stepCount: 1,
      uiStepCount: 0,
      apiStepCount: 1,
      issues: [],
      testPointIds: [`tp-${name}`],
      caseIds: [`case-${name}`],
      caseVerifies: [[`tp-${name}`]],
    })))
    mocks.runTestSuite.mockResolvedValue({
      batchId: 'test-batch-1',
      blockedReason: null,
      entries: [
        { path: 'tests/a.testspec.json', runId: 'run-1', status: 'passed', caseStatuses: [{ caseId: 'case-a', status: 'passed' }] },
        { path: 'tests/b.testspec.json', runId: 'run-2', status: 'rejected', caseStatuses: [{ caseId: 'case-b', status: 'rejected' }] },
        { path: 'tests/c.testspec.json', runId: 'run-3', status: 'passed', caseStatuses: [{ caseId: 'case-c', status: 'passed' }] },
      ],
    })
    render(<TestingView />)

    fireEvent.change(await screen.findByLabelText('运行范围'), { target: { value: 'all' } })
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'ui' } })
    // 有 3 个用例文件时「重放」在两处（顶栏 + 用例详情），取顶栏那个。
    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    // 一次套件运行：三个用例文件交给同一个批次，且**逐个**传给 runner（不短路由服务保证）。
    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalledTimes(1))
    expect(mocks.runTestSuite.mock.calls[0]?.[0]).toMatchObject({
      specs: [
        { path: 'tests/a.testspec.json' },
        { path: 'tests/b.testspec.json' },
        { path: 'tests/c.testspec.json' },
      ],
    })
    expect(await screen.findByText(/本批次 3 个用例文件：通过 2、失败 1、其他 0/)).toBeInTheDocument()
    // 未通过的文件在摘要里逐条点名（被拒绝的那个仍被列出，说明后续没有被短路丢弃）。
    const summary = screen.getByText(/本批次 3 个用例文件/).closest('div')!
    expect(within(summary).getByText('tests/b.testspec.json')).toBeInTheDocument()
    expect(within(summary).getByText('已拒绝')).toBeInTheDocument()
    // 覆盖三数按测试点算，分母只取本次运行范围；被拒绝的那个测试点算「已执行未通过」。
    expect(await screen.findByTestId('testing-coverage')).toHaveTextContent(
      '覆盖：设计 3 · 执行 3 · 通过 2 · 未运行 0（需要修复 0 · 不适用 0）',
    )
    expect(screen.getByTestId('testing-coverage-verdict')).toHaveTextContent('本轮范围内未全绿')
  })

  it('publishes the testing context for the active session and clears it on unmount', async () => {
    mocks.scanTestSpecs.mockResolvedValue([
      {
        path: 'tests/api.testspec.json',
        valid: true,
        id: 'api',
        name: 'API 用例',
        caseCount: 2,
        stepCount: 2,
        uiStepCount: 0,
        apiStepCount: 2,
        issues: [],
      },
      {
        path: 'tests/broken.testspec.json',
        valid: false,
        id: null,
        name: null,
        caseCount: 0,
        stepCount: 0,
        uiStepCount: 0,
        apiStepCount: 0,
        issues: [{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' }],
      },
    ])
    mocks.listTestEnvironmentRecords.mockResolvedValue([{
      id: 'env-1',
      name: '本地开发环境',
      kind: 'local',
      recipeJson: '{}',
      webBaseUrl: null,
      apiBaseUrl: 'http://127.0.0.1:9',
      viewportWidth: null,
      viewportHeight: null,
      allowPrivateNetwork: true,
      headersJson: '{}',
      secretIdsJson: '[]',
      createdAt: 1,
      updatedAt: 2,
    }])
    const { unmount } = render(<TestingView />)

    await waitFor(() => {
      const published = mocks.setTestingPromptContext.mock.calls.at(-1)?.[0]
      expect(published).toContain('# 测试会话上下文')
    })
    const published = mocks.setTestingPromptContext.mock.calls.at(-1)?.[0] as string
    expect(published).toContain('tests/api.testspec.json')
    expect(published).toContain('tests/broken.testspec.json：$.version 不支持的版本，当前支持 1 / 2 / 3')
    expect(published).toContain('- 本地开发环境（本地（Axiom 起停），有起停配方）')
    expect(published).toContain('test-design')

    unmount()
    await waitFor(() => expect(mocks.setTestingPromptContext.mock.calls.at(-1)?.[0]).toBeNull())
  })

  it('passes the readiness facts into the run so the report can name the environment', async () => {
    mocks.scanTestSpecs.mockResolvedValue([{
      path: 'tests/api.testspec.json',
      valid: true,
      id: 'api',
      name: 'API 用例',
      caseCount: 1,
      stepCount: 1,
      uiStepCount: 0,
      apiStepCount: 1,
      issues: [],
    }])
    mocks.listTestEnvironmentRecords.mockResolvedValue([{
      id: 'env-1',
      name: '本地开发环境',
      kind: 'local',
      recipeJson: null,
      webBaseUrl: null,
      apiBaseUrl: 'http://127.0.0.1:9',
      viewportWidth: null,
      viewportHeight: null,
      allowPrivateNetwork: true,
      headersJson: '{}',
      secretIdsJson: '[]',
      createdAt: 1,
      updatedAt: 2,
    }])
    mocks.prepareUiTestRun.mockResolvedValue(plan)
    render(<TestingView />)

    const run = await screen.findByRole('button', { name: '重放' })
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalled())
    // 环境与探针事实由套件运行服务统一采集（就绪门在它内部，整批只探一次）。
    expect(mocks.runTestSuite.mock.calls.at(-1)?.[0]).toMatchObject({
      environment: {
        id: 'env-1',
        name: '本地开发环境',
        kind: 'local',
      },
    })
  })

  it('runs only valid specs under the all scope and passes the source session', async () => {
    mocks.scanTestSpecs.mockResolvedValue([
      {
        path: 'tests/a.testspec.json',
        valid: true,
        id: 'a',
        name: 'A',
        caseCount: 1,
        stepCount: 1,
        uiStepCount: 0,
        apiStepCount: 1,
        issues: [],
        testPointIds: [],
        caseIds: ['case-a'],
        caseVerifies: [[]],
      },
      {
        path: 'tests/bad.testspec.json',
        valid: false,
        id: null,
        name: null,
        caseCount: 0,
        stepCount: 0,
        uiStepCount: 0,
        apiStepCount: 0,
        issues: [{ path: '$', message: '缺少 cases' }],
        testPointIds: [],
        caseIds: [],
        caseVerifies: [],
      },
    ])
    mocks.runTestSuite.mockResolvedValue({
      batchId: 'batch-a',
      blockedReason: null,
      entries: [{ path: 'tests/a.testspec.json', runId: 'run-a', status: 'passed', caseStatuses: [] }],
    })
    mocks.getTestRunRecord.mockResolvedValue(null)
    render(<TestingView />)

    fireEvent.change(await screen.findByLabelText('运行范围'), { target: { value: 'all' } })
    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalledTimes(1))
    expect(mocks.runTestSuite.mock.calls[0]?.[0]).toMatchObject({
      specs: [{ path: 'tests/a.testspec.json' }],
      sourceSessionId: 'session-1',
    })
  })

  it('counts invalid files outside the run scope in coverage columns', async () => {
    mocks.scanTestSpecs.mockResolvedValue([
      {
        path: 'tests/a.testspec.json',
        valid: true,
        id: 'a',
        name: 'A',
        caseCount: 1,
        stepCount: 1,
        uiStepCount: 0,
        apiStepCount: 1,
        issues: [],
        testPointIds: ['tp-a'],
        caseIds: ['case-a'],
        caseVerifies: [['tp-a']],
      },
      {
        path: 'tests/bad.testspec.json',
        valid: false,
        id: null,
        name: null,
        caseCount: 0,
        stepCount: 0,
        uiStepCount: 0,
        apiStepCount: 0,
        issues: [{ path: '$', message: '缺少 cases' }],
        testPointIds: [],
        caseIds: [],
        caseVerifies: [],
      },
    ])
    mocks.runTestSuite.mockResolvedValue({
      batchId: 'batch-a',
      blockedReason: null,
      entries: [{
        path: 'tests/a.testspec.json',
        runId: 'run-a',
        status: 'passed',
        caseStatuses: [{ caseId: 'case-a', status: 'passed' }],
        testPointIds: ['tp-a'],
        caseIds: ['case-a'],
        caseVerifies: [['tp-a']],
      }],
    })
    mocks.getTestRunRecord.mockResolvedValue(null)
    render(<TestingView />)

    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(screen.getByTestId('testing-coverage')).toHaveTextContent(
      '覆盖：设计 1 · 执行 1 · 通过 1 · 未运行 0（需要修复 1 · 不适用 0）',
    ))
  })

  it('uses frozen plan metadata for batch coverage instead of the current scan', async () => {
    mocks.scanTestSpecs.mockResolvedValue([{
      path: 'tests/a.testspec.json',
      valid: true,
      id: 'a',
      name: 'A',
      caseCount: 1,
      stepCount: 1,
      uiStepCount: 0,
      apiStepCount: 1,
      issues: [],
      testPointIds: [],
      caseIds: ['case-a'],
      caseVerifies: [[]],
    }])
    mocks.runTestSuite.mockResolvedValue({
      batchId: 'batch-a',
      blockedReason: null,
      entries: [{
        path: 'tests/a.testspec.json',
        runId: 'run-a',
        status: 'passed',
        caseStatuses: [{ caseId: 'case-a', status: 'passed' }],
        testPointIds: ['tp-frozen'],
        caseIds: ['case-a'],
        caseVerifies: [['tp-frozen']],
      }],
    })
    mocks.getTestRunRecord.mockResolvedValue(null)
    render(<TestingView />)

    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(screen.getByTestId('testing-coverage')).toHaveTextContent(
      '覆盖：设计 1 · 执行 1 · 通过 1 · 未运行 0',
    ))
  })

  it('shows a scan error instead of a false empty state', async () => {
    mocks.scanTestSpecs.mockRejectedValue(new Error('index unavailable'))
    render(<TestingView />)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      '扫描测试用例失败，请检查工作区授权后重试。',
    ))
  })

  it('offers a stop button while the environment probe/preparation is pending', async () => {
    let captured: AbortSignal | undefined
    mocks.runTestSuite.mockImplementation((input: { signal: AbortSignal }) => {
      captured = input.signal
      return new Promise(() => undefined)
    })
    render(<TestingView />)

    const run = await screen.findByRole('button', { name: '重放' })
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    const stop = await screen.findByRole('button', { name: '停止' })
    fireEvent.click(stop)
    expect(captured?.aborted).toBe(true)
  })

  it('uses the active run spec for the run progress, not the previously selected tab', async () => {
    mocks.scanTestSpecs.mockResolvedValue([
      {
        path: 'tests/a.testspec.json',
        valid: true,
        id: 'a',
        name: 'A',
        caseCount: 1,
        stepCount: 1,
        uiStepCount: 0,
        apiStepCount: 1,
        issues: [],
        testPointIds: [],
        caseIds: ['case-a'],
        caseVerifies: [[]],
      },
      {
        path: 'tests/b.testspec.json',
        valid: true,
        id: 'b',
        name: 'B',
        caseCount: 1,
        stepCount: 5,
        uiStepCount: 0,
        apiStepCount: 1,
        issues: [],
        testPointIds: [],
        caseIds: ['case-b'],
        caseVerifies: [[]],
      },
    ])
    mocks.runTestSuite.mockImplementation((input: {
      onRunStarted?: (progress: { index: number; total: number; path: string; runId: string }) => void
    }) => {
      input.onRunStarted?.({ index: 1, total: 2, path: 'tests/b.testspec.json', runId: 'run-b' })
      return new Promise(() => undefined)
    })
    mocks.getTestRunRecord.mockResolvedValue(null)
    render(<TestingView />)

    fireEvent.change(await screen.findByLabelText('运行范围'), { target: { value: 'all' } })
    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    const progress = await screen.findByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuemax', '5')
  })

  it('does not call a batch green when a hook/non-testpoint case failed', async () => {
    mocks.scanTestSpecs.mockResolvedValue([{
      path: 'tests/a.testspec.json',
      valid: true,
      id: 'a',
      name: 'A',
      caseCount: 1,
      stepCount: 1,
      uiStepCount: 0,
      apiStepCount: 1,
      issues: [],
      testPointIds: ['tp-a'],
      caseIds: ['case-a'],
      caseVerifies: [['tp-a']],
    }])
    mocks.runTestSuite.mockResolvedValue({
      batchId: 'batch-a',
      blockedReason: null,
      entries: [{
        path: 'tests/a.testspec.json',
        runId: 'run-a',
        status: 'failed',
        // 主用例通过、afterEach 失败：文件级失败，但测试点覆盖本身是 1/1。
        caseStatuses: [{ caseId: 'case-a', status: 'passed' }],
        testPointIds: ['tp-a'],
        caseIds: ['case-a'],
        caseVerifies: [['tp-a']],
      }],
    })
    mocks.getTestRunRecord.mockResolvedValue(null)
    render(<TestingView />)

    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(screen.getByTestId('testing-coverage')).toHaveTextContent(
      '覆盖：设计 1 · 执行 1 · 通过 1 · 未运行 0',
    ))
    expect(screen.getByTestId('testing-coverage-verdict')).toHaveTextContent('本轮范围内未全绿')
  })

  it('reloads the latest batch summary from batch_id after a page reload', async () => {
    const summaries = [
      {
        id: 'run-a',
        specPath: 'tests/a.testspec.json',
        specHash: 'hash-a',
        environmentId: null,
        batchId: 'batch-1',
        envFactsJson: null,
        status: 'passed',
        startedAt: 2,
        finishedAt: 3,
      },
      {
        id: 'run-b',
        specPath: 'tests/b.testspec.json',
        specHash: 'hash-b',
        environmentId: null,
        batchId: 'batch-1',
        envFactsJson: null,
        status: 'failed',
        startedAt: 1,
        finishedAt: 2,
      },
    ]
    // 运行列表可以完全不含这批运行：批次发现必须独立于「最近 50 条」窗口。
    mocks.listTestRunRecords.mockResolvedValue([])
    mocks.getLatestTestBatchRecord.mockResolvedValue({
      batchId: 'batch-1',
      runs: summaries,
      truncated: false,
    })
    const detailFor = (id: string, path: string, status: 'passed' | 'failed') => ({
      summary: {
        id,
        specPath: path,
        specHash: `hash-${id.slice(-1)}`,
        environmentId: null,
        batchId: 'batch-1',
        envFactsJson: null,
        status,
        startedAt: 1,
        finishedAt: 2,
      },
      planContentHash: `plan-${id}`,
      cases: [{
        id: `case-run-${id}`,
        caseId: 'case-one',
        caseName: '结算',
        status,
        startedAt: 1,
        finishedAt: 2,
        failureKind: status === 'failed' ? 'assertion' : null,
        failureOrigin: status === 'failed' ? 'assertion' : null,
        steps: [],
      }],
    })
    const planFor = (testPointId: string) => JSON.stringify({
      specId: testPointId,
      name: testPointId,
      specVersion: 2,
      specHash: 'hash',
      target: {},
      environmentNames: [],
      testPoints: [{ id: testPointId, kind: 'new_feature', title: testPointId, acceptance: '可判定' }],
      cases: [{ id: 'case-one', name: '结算', verifies: [testPointId], steps: [] }],
    })
    mocks.getTestRunRecord.mockImplementation(async (runId: string) => (
      runId === 'run-a'
        ? detailFor('run-a', 'tests/a.testspec.json', 'passed')
        : detailFor('run-b', 'tests/b.testspec.json', 'failed')
    ))
    mocks.readArtifactText.mockImplementation(async (hash: string) => (
      hash === 'plan-run-a' ? planFor('tp-a') : planFor('tp-b')
    ))
    render(<TestingView />)

    const open = await screen.findByRole('button', { name: '查看批次摘要' })
    expect(screen.getByText('最近批次：2 个用例文件')).toBeInTheDocument()
    fireEvent.click(open)

    await waitFor(() => expect(screen.getByText(/本批次 2 个用例文件：通过 1、失败 1、其他 0/)).toBeInTheDocument())
    expect(await screen.findByTestId('testing-coverage')).toHaveTextContent(
      '覆盖：设计 2 · 执行 2 · 通过 1 · 未运行 0（需要修复 0 · 不适用 0）',
    )
  })
})
