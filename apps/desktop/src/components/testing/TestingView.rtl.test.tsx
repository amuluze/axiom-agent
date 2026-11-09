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
  loadSpecDetail: vi.fn(),
  readArtifactText: vi.fn(),
  useUiStoreHook: vi.fn(),
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
          cases: [{ id: 'api-case', name: 'API', type: 'api', stepCount: 1, assertCount: 0, testPointTitles: [], assertSummary: null }],
          assertCount: 0, uiCaseCount: 0, apiCaseCount: 1, mixedCaseCount: 0,
        }
      }
      return {
        name: '结算流程', version: 1,
        cases: [{ id: 'case-one', name: '结算', type: 'ui', stepCount: 1, assertCount: 1, testPointTitles: [], assertSummary: 'URL 包含 /checkout' }],
        assertCount: 1, uiCaseCount: 1, apiCaseCount: 0, mixedCaseCount: 0,
      }
    })
  })

  it('selects the active tab, runs the selected spec and opens the persisted report', async () => {
    render(<TestingView />)

    const run = await screen.findByRole('button', { name: '重放' })
    await waitFor(() => expect(run).not.toBeDisabled())
    expect(screen.queryByRole('button', { name: '运行全部' })).not.toBeInTheDocument()
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

  it('switches the displayed spec from the environment-bar selector without waiting for a replay', async () => {
    mocks.scanTestSpecs.mockResolvedValue([
      {
        path: 'tests/checkout.testspec.json',
        valid: true,
        id: 'checkout',
        name: '结算流程',
        caseCount: 1,
        stepCount: 1,
        uiStepCount: 1,
        apiStepCount: 0,
        issues: [],
      },
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
    render(<TestingView />)

    // 用例文件不再以标签页铺在顶栏。
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()

    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)
    expect(await screen.findByRole('heading', { name: '运行报告' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: '用例文件' }), {
      target: { value: 'tests/api.testspec.json' },
    })

    // 切换文件即刻换成该文件的用例总览；旧报告不能留在下方直到下一次回放结束。
    expect(await screen.findByRole('heading', { level: 1, name: 'API 用例' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '运行报告' })).not.toBeInTheDocument()
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

  it('switches the displayed spec and sends a structured failure summary to the selected session', async () => {
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

    const specSelect = await screen.findByRole('combobox', { name: '用例文件' })
    fireEvent.change(specSelect, { target: { value: 'tests/api.testspec.json' } })
    // 切换到 API 用例：标题行 h1 显示 spec name，UI 用例不再渲染。
    expect(await screen.findByRole('heading', { level: 1, name: 'API 用例' })).toBeInTheDocument()
    expect(screen.queryByText('结算流程')).not.toBeInTheDocument()

    fireEvent.change(specSelect, { target: { value: 'tests/checkout.testspec.json' } })
    expect(await screen.findByRole('heading', { level: 1, name: '结算流程' })).toBeInTheDocument()
    // 页面不再有「运行范围」下拉框：重放只跑环境条选中的那份。
    expect(screen.queryByRole('combobox', { name: '运行范围' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '运行全部' })).toBeEnabled()
    fireEvent.click((await screen.findAllByRole('button', { name: '重放' }))[0])
    await waitFor(() => expect(mocks.runTestSuite.mock.calls[0]?.[0]).toMatchObject({
      specs: [{ path: 'tests/checkout.testspec.json' }],
    }))
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
    // 纯 API 用例不需要目标标签页，也不展示无关的浏览器控件。
    expect(mocks.runTestSuite.mock.calls.at(-1)?.[0]).not.toHaveProperty('tab')
    expect(screen.queryByRole('combobox', { name: '目标标签页' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开浏览器' })).not.toBeInTheDocument()
  })

  it('keeps the browser target for a mixed batch when the selected file is API-only', async () => {
    useBrowserStore.setState({ tabs: [] })
    mocks.scanTestSpecs.mockResolvedValue([
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
      {
        path: 'tests/ui.testspec.json',
        valid: true,
        id: 'ui',
        name: 'UI 用例',
        caseCount: 1,
        stepCount: 1,
        uiStepCount: 1,
        apiStepCount: 0,
        issues: [],
      },
    ])
    render(<TestingView />)

    // 选中文件是纯 API，但批次含 UI 文件：目标标签页必须按整个批次显示。
    expect(await screen.findByRole('heading', { level: 1, name: 'API 用例' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '目标标签页' })).toBeInTheDocument()
    // 单文件重放不依赖标签页；整批覆盖含 UI 步骤，没有标签页就不能启动。
    expect(screen.getByRole('button', { name: '重放' })).toBeEnabled()
    const runAll = screen.getByRole('button', { name: '运行全部' })
    expect(runAll).toBeDisabled()
    expect(runAll).toHaveAttribute('title', '先选择浏览器目标标签页')
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

    const run = await screen.findByRole('button', { name: '运行全部' })
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
    expect(await screen.findByText(/本批次 3 个用例文件：通过 2 · 失败 1 · 其他 0/)).toBeInTheDocument()
    // 未通过的文件在摘要里逐条点名（被拒绝的那个仍被列出，说明后续没有被短路丢弃）。
    const summary = screen.getByTestId('testing-suite-summary')
    expect(within(summary).getByText('tests/b.testspec.json')).toBeInTheDocument()
    expect(within(summary).getByText('已拒绝')).toBeInTheDocument()
    // 覆盖三数按测试点算，分母只取本批次实际尝试的文件；被拒绝的那个测试点算「已执行未通过」。
    expect(await screen.findByTestId('testing-coverage')).toHaveTextContent(
      /测试点 2\/3 通过/,
    )
    expect(screen.getByTestId('testing-coverage')).toHaveTextContent(/失败 1/)
    expect(screen.getByTestId('testing-coverage-verdict')).toHaveTextContent('未全绿')
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
    expect(published).toContain('test-authoring')

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

  it('runs only valid specs and passes the source session', async () => {
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

    const run = (await screen.findAllByRole('button', { name: '重放' }))[0]!
    await waitFor(() => expect(run).not.toBeDisabled())
    fireEvent.click(run)

    await waitFor(() => expect(mocks.runTestSuite).toHaveBeenCalledTimes(1))
    expect(mocks.runTestSuite.mock.calls[0]?.[0]).toMatchObject({
      specs: [{ path: 'tests/a.testspec.json' }],
      sourceSessionId: 'session-1',
    })
  })

  it('counts invalid files in coverage columns', async () => {
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
      /测试点 1\/1 通过/,
    ))
    expect(screen.getByTestId('testing-coverage')).toHaveTextContent(/需要修复 1/)
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
      /测试点 1\/1 通过/,
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

    const run = (await screen.findAllByRole('button', { name: '运行全部' }))[0]!
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
      /测试点 1\/1 通过/,
    ))
    expect(screen.getByTestId('testing-coverage-verdict')).toHaveTextContent('未全绿')
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

    await waitFor(() => expect(screen.getByText(/本批次 2 个用例文件：通过 1 · 失败 1 · 其他 0/)).toBeInTheDocument())
    expect(await screen.findByTestId('testing-coverage')).toHaveTextContent(
      /测试点 1\/2 通过/,
    )
  })

})
