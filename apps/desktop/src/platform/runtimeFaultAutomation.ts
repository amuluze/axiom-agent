import { PROVIDER_PROFILE_SCHEMA_VERSION, type ProviderProfile } from '@/agent/transport/provider'
import { invoke } from '@tauri-apps/api/core'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import type {
  ApiStepSpec,
  TestStepSpec,
  TestTargetSpec,
  UiStepSpec,
} from '@/agent/testing/spec/types'
import { TEST_SPEC_VERSION } from '@/agent/testing/spec/types'
import { saveBrowserSettings } from '@/config/browserSettings'
import { browserCommand } from './browserSession'
import {
  listTestEnvironmentRecords,
  saveTestEnvironmentRecord,
  type TestEnvironmentRecord,
} from './testEnvironments'
import type { UiTestTarget } from './testAutomation'
import { readWorkspaceText, type AuthorizedWorkspace } from './workspace'
import { e2eAutomationLog, e2eRegisterWorkspace } from './runtimeFaultInjection'
import { startUiTestRun } from '@/stores/services/testRuntimeService'
import { ensureEnvironmentReady } from '@/stores/services/testEnvironmentReadiness'
import { runTestSuite } from '@/stores/services/testSuiteRunner'
import { scanTestSpecs } from '@/stores/services/testSpecIndex'
import {
  appendRuntimeFaultAutomationMessage,
  useAgentStore,
} from '@/stores/agentStore'

/** H1-4/H1-5 测试运行窗口：不依赖 AX，直接在 WebView 内驱动一次真实测试运行。
 *
 * 后两个窗口与前面四个的差别在**入口**：前四个各自 `startUiTestRun` 一次，
 * `test_suite_run_interrupted` 走整批入口（探针 → 逐文件 → 共享 batch_id），
 * `test_environment_probe_inflight` 干脆不进运行态（探针本身不等于一次运行）。
 *
 * 七个窗口都在**测试页面**上动作，而测试页面要求已授权工作区（自动化前奏会先授权），
 * 因此探针窗口同样需要工作区——这不是它的被测对象，而是它所在界面的前置条件。 */
const RUNTIME_FAULT_TEST_RUN_SCENARIOS = [
  'test_step_action_applied',
  'test_api_response_received',
  'test_evidence_written',
  'test_step_awaiting_approval',
  'test_suite_run_interrupted',
  'test_environment_probe_inflight',
  'test_spec_authoring_interrupted',
] as const

type RuntimeFaultTestRunScenario = (typeof RUNTIME_FAULT_TEST_RUN_SCENARIOS)[number]

const isTestRunScenario = (scenario: string): scenario is RuntimeFaultTestRunScenario =>
  (RUNTIME_FAULT_TEST_RUN_SCENARIOS as readonly string[]).includes(scenario)

interface RuntimeFaultAutomationSpec {
  scenario:
    | 'queue_recovered'
    | 'queue_consuming'
    | 'tool_execution_started'
    | 'tool_execution_finished'
    | 'tool_result_committed'
    | 'workspace_audit_persisted'
    | 'workspace_change_step_applied'
    | 'workspace_trash_restore_step_applied'
    | 'mutation_batch_committed'
    | 'compaction_checkpoint_committed'
    | 'provider_response_received'
    | 'agent_end_before_settled'
    | 'intent_fsynced'
    | 'profile_committed'
    | RuntimeFaultTestRunScenario
  endpoint: string
  apiKey: string
  prompt: string
  draft?: string
  workspacePath?: string
  /** 测试运行场景的目标地址：API 窗口是 fixture 的 HTTP 端点，UI 窗口是 fixture 页面。 */
  targetUrl?: string
}

declare global {
  interface Window {
    __AXIOM_E2E_RUNTIME_AUTOMATION__?: RuntimeFaultAutomationSpec
  }
}

/**
 * 等待 store 状态就绪。后台/遮挡窗口的 webview 会强力节流 setTimeout
 * （链式定时器可延迟到分钟级），轮询式等待会因此饿死——zustand 的
 * subscribe 在 setState 时同步触发，不受可见性节流影响。超时兜底
 * 仍用定时器（允许迟到，不会提前失败）。
 */
const waitForStoreState = (
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<void> => {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const unsubscribe = useAgentStore.subscribe(() => {
      if (!predicate()) return
      unsubscribe()
      clearInterval(slowTick)
      resolve()
    })
    const slowTick = setInterval(() => {
      if (predicate()) {
        unsubscribe()
        clearInterval(slowTick)
        resolve()
      }
    }, 1_000)
    setTimeout(() => {
      unsubscribe()
      clearInterval(slowTick)
      reject(new Error('E2E runtime fault automation timed out'))
    }, timeoutMs)
  })
}

const validateSpec = (value: RuntimeFaultAutomationSpec): RuntimeFaultAutomationSpec => {
  if (![
    'queue_recovered',
    'queue_consuming',
    'tool_execution_started',
    'tool_execution_finished',
    'tool_result_committed',
    'workspace_audit_persisted',
    'workspace_change_step_applied',
    'workspace_trash_restore_step_applied',
    'mutation_batch_committed',
    'compaction_checkpoint_committed',
    'provider_response_received',
    'agent_end_before_settled',
    'intent_fsynced',
    'profile_committed',
    ...RUNTIME_FAULT_TEST_RUN_SCENARIOS,
  ].includes(value?.scenario)
    || typeof value.endpoint !== 'string'
    || typeof value.apiKey !== 'string'
    || typeof value.prompt !== 'string'
    || (value.draft !== undefined && typeof value.draft !== 'string')
    || (value.workspacePath !== undefined && typeof value.workspacePath !== 'string')
    || (value.targetUrl !== undefined && typeof value.targetUrl !== 'string')
    || ([
      'workspace_audit_persisted',
      'workspace_change_step_applied',
      'workspace_trash_restore_step_applied',
      ...RUNTIME_FAULT_TEST_RUN_SCENARIOS,
    ].includes(value.scenario)
      && !value.workspacePath)
    // 测试运行窗口要跑真实测试运行：没有目标地址就无从到达窗口。
    || (isTestRunScenario(value.scenario) && !value.targetUrl)) {
    throw new Error('Invalid E2E runtime fault automation spec')
  }
  return value
}

/** 单步骤计划：测试运行场景共用的最小可运行计划（不写文件、不依赖环境变量插值）。 */
const faultTestPlan = (steps: TestStepSpec[], target: TestTargetSpec): CompiledTestPlan => ({
  specId: 'e2e-runtime-fault',
  name: 'E2E Runtime Fault Window',
  specVersion: TEST_SPEC_VERSION,
  specHash: 'e2e-runtime-fault',
  target,
  environmentNames: [],
  cases: [{ id: 'fault-case', name: '故障窗口用例', steps }],
})

/** 放行一切步骤：动作窗口的被测对象是「动作之后的崩溃」，审批不参与。 */
const approveEveryStep: TestStepApprover = {
  approve: () => Promise.resolve(true),
  respond: () => false,
  list: () => [],
  subscribe: () => () => undefined,
}

/** 永不放行：等待审批本身就是被测窗口（步骤停在 waiting_approval，随后被强杀）。 */
const approveNoStep: TestStepApprover = {
  approve: () => new Promise<boolean>(() => undefined),
  respond: () => false,
  list: () => [],
  subscribe: () => () => undefined,
}

/** 故障窗口共用的环境记录 id：fixture 只监听 loopback，因此必须显式允许私网。 */
const FAULT_ENVIRONMENT_ID = 'e2e-runtime-fault-env'

const saveFaultEnvironment = async (targetUrl: string): Promise<void> => {
  await saveTestEnvironmentRecord({
    id: FAULT_ENVIRONMENT_ID,
    name: 'E2E Runtime Fault Environment',
    webBaseUrl: targetUrl,
    apiBaseUrl: targetUrl,
    allowPrivateNetwork: true,
    headersJson: '{}',
    secretIdsJson: '[]',
    updatedAt: Date.now(),
  })
}

/** 回读刚写入的环境记录（`ensureEnvironmentReady` / `runTestSuite` 要整条记录，不只是 id）。 */
const loadFaultEnvironment = async (): Promise<TestEnvironmentRecord> => {
  const records = await listTestEnvironmentRecords()
  const environment = records.find((record) => record.id === FAULT_ENVIRONMENT_ID)
  if (!environment) throw new Error('E2E 故障窗口未能写回环境记录')
  return environment
}

/**
 * API 窗口：环境需显式允许私网（fixture 只监听 loopback），步骤经 `startUiTestRun`
 * 走真实的 run/step 落库与 Rust Driver——审批放行后请求发出，崩溃点在 Rust 侧。
 */
const runApiFaultStep = async (
  scenario: RuntimeFaultTestRunScenario,
  runId: string,
  targetUrl: string,
): Promise<void> => {
  const environmentId = FAULT_ENVIRONMENT_ID
  await saveFaultEnvironment(targetUrl)
  const step: ApiStepSpec = {
    id: 'fault-api-step',
    action: 'api.request',
    method: 'GET',
    url: targetUrl,
    expect: [{ status: 200 }],
  }
  await startUiTestRun({
    runId,
    specPath: 'tests/e2e-runtime-fault.testspec.json',
    plan: faultTestPlan([step], { apiBaseUrl: targetUrl }),
    approver: scenario === 'test_step_awaiting_approval' ? approveNoStep : approveEveryStep,
    signal: new AbortController().signal,
    environmentId,
  })
}

/**
 * 探针窗口：环境就绪探针走到「响应已收到、证据未落盘」时强杀。
 *
 * 探针**不创建任何 run**——崩溃后要断言的是"没有半截运行态"以及"没有持久化的就绪结论"：
 * 就绪缓存是 `testEnvironmentReadiness` 里的进程内 Map（只活当前会话，不跨重启），
 * 所以重启后既没有 `test_runs` 行、也不可能"起过一次就算就绪"。
 */
const runEnvironmentProbeFault = async (targetUrl: string): Promise<void> => {
  await saveFaultEnvironment(targetUrl)
  const environment = await loadFaultEnvironment()
  await ensureEnvironmentReady({
    environment,
    runId: 'e2e-runtime-fault-probe',
    approver: approveEveryStep,
    signal: new AbortController().signal,
  })
}

/**
 * 套件窗口：整批里**第 N 次**响应时强杀（`AXIOM_E2E_FAULT_HIT`，本窗口用 3）。
 *
 * 计数为什么必须大于 1：本窗口要断言的是"各 run 各自 interrupted、batch_id 不丢"，
 * 前提是崩溃时**第一个文件已终态、第二个文件在途**。三次响应正好对应
 * ①就绪探针 ②第一个文件（断言故意写成不可能成立，稳定终态为 failed）
 * ③第二个文件（在这里死）。
 */
const runSuiteFault = async (workspacePath: string, targetUrl: string): Promise<void> => {
  await saveFaultEnvironment(targetUrl)
  const environment = await loadFaultEnvironment()
  await runTestSuite({
    workspacePath,
    specs: [
      { path: 'tests/e2e-fault-a.testspec.json', uiStepCount: 0 },
      { path: 'tests/e2e-fault-b.testspec.json', uiStepCount: 0 },
    ],
    environment,
    approver: approveEveryStep,
    signal: new AbortController().signal,
  })
  automationMark('ui-fault:run-returned')
}

/**
 * 授权用例窗口：**真实模型回合**（stub 只提供脚本化响应）经 `write` 工具把用例文件写进工作区，
 * 写工具走逐次审批（自动确认挂起卡片）→ 从**磁盘读回**确认落盘（不看模型自述）→ 用**测试页同一条扫描链**
 * 判定该文件有效 → 再经套件入口真跑起来，并在步骤响应处强杀。
 *
 * 这条链路覆盖「会话 → 校验 → 运行」的实质，且不需要 AX（原生 AX 版本属 release:native-gate）。
 * 崩溃后的断言看两件事：模型写出的**用户可见产物**不丢，以及运行态按 run 结算。
 */
const runSpecAuthoringFault = async (workspacePath: string, targetUrl: string): Promise<void> => {
  const authoredPath = 'tests/e2e-authored.testspec.json'
  // 不 await send：写工具会挂在审批上，而审批要由这里点掉——await 会自锁
  // （既有 send 场景一律「先拿 promise → 等状态 → 审批 → 最后 await」）。
  const turn = useAgentStore.getState().send(`spec_authoring ${authoredPath}`)
  // 审批循环：模型可能先 discover 再写（多张卡片），不假设"下一张卡就是 write"；
  // 退出条件是**文件真的落盘**——模型说写好了不算，磁盘上有才算。
  const deadline = Date.now() + 60_000
  let content = ''
  let approvals = 0
  while (Date.now() < deadline) {
    const pending = useAgentStore.getState().pendingApproval
    if (pending !== null) {
      approvals += 1
      await useAgentStore.getState().approveToolCall(pending.toolCallId)
      automationMark(`authoring-approval#${approvals}`)
    }
    content = (await readWorkspaceText(authoredPath, 0, 1_000, workspacePath).catch(() => ({ content: '' }))).content
    if (content.length > 0) break
    if (!useAgentStore.getState().running && useAgentStore.getState().pendingApproval === null) {
      throw new Error(`模型写出的用例文件未落盘（审批 ${approvals} 次后回合已结束）`)
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250))
  }
  if (content.length === 0) throw new Error('模型写出的用例文件未落盘')
  await turn
  automationMark('authoring-file-written')

  // 校验：与测试页同一条扫描链（`scanTestSpecs`）判定 valid，而不是另写一套判定。
  const entries = await scanTestSpecs(workspacePath, new AbortController().signal)
  const authored = entries.find((entry) => entry.path === authoredPath)
  automationMark(`authoring-scan=${authored?.valid === true ? 'valid' : 'invalid'}`)

  // 运行：单文件也走套件入口；环境提供 `${env.API_BASE_URL}`，探针吃 hit1、本步骤响应吃 hit2。
  await saveFaultEnvironment(targetUrl)
  const environment = await loadFaultEnvironment()
  await runTestSuite({
    workspacePath,
    specs: [{
      path: authoredPath,
      uiStepCount: 0,
      ...(authored === undefined ? {} : {
        testPointIds: authored.testPointIds,
        caseIds: authored.caseIds,
        caseVerifies: authored.caseVerifies,
      }),
    }],
    environment,
    approver: approveEveryStep,
    signal: new AbortController().signal,
  })
}

/** 浏览器准备超时的专用错误：场景据此判定「本机无法拉起无头浏览器」而显式跳过，
 * 与「注入点失效」这类真失败区分开。 */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

/** 给浏览器动作加有界等待：超时抛 {@link BrowserUnavailableError}。
 *
 * 刻意不用 `Promise.withResolvers()`：lib 为 ES2022（WebKit 支持面），仓库既有延时工具
 * （`components/design/nativePageCapture.ts`）同口径避用它。 */
const withBrowserTimeout = async <T>(
  action: Promise<T>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> => {
  let timer: number | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(
      () => reject(new BrowserUnavailableError(`E2E 故障场景${label}超时（${timeoutMs}ms）`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([action, timeout])
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * UI 窗口：写步骤只能在用户真实选定的浏览器 tab 上执行（U1-2 授权），
 * 因此先启用浏览器能力并以无头实例打开 fixture 页面，再把该 tab 作为测试目标。
 *
 * 浏览器冷启动（隔离 profile + 无头 Chrome）可能阻塞：`newTab` 前置的 Rust `ensureRunning`
 * 若在本机拉不起浏览器，这里以有界等待收口并抛 {@link BrowserUnavailableError}，由调用方按
 * 环境问题跳过，而不是把整轮套件拖成超时。
 */
const runUiFaultStep = async (runId: string, targetUrl: string): Promise<void> => {
  saveBrowserSettings({
    enabled: true,
    executablePath: '',
    headless: true,
    ignoreCertificateErrors: false,
  })
  automationMark('ui-fault:settings-saved')
  automationMark('ui-fault:newTab-calling')
  let opened: Awaited<ReturnType<typeof browserCommand>>
  try {
    opened = await withBrowserTimeout(
      browserCommand({ action: 'newTab', url: targetUrl }),
      '打开浏览器 tab',
    )
  } catch (error) {
    // 静默挂起排查（finding `browser-session-cdp-robustness`）：把失败形态写进标记——
    // timeout=命令超时、rejected=宿主拒绝（含具体文案）。**若这条标记也不出现**，
    // 说明 JS 线程根本没跑（主线程被占），那是另一类缺陷。
    const message = error instanceof Error ? error.message : String(error)
    automationMark(`ui-fault:newTab-failed kind=${
      error instanceof BrowserUnavailableError ? 'timeout' : 'rejected'
    } message=${message}`)
    if (error instanceof BrowserUnavailableError) throw error
    // 本机 Chrome 的 `Page.navigate` 偶发 CDP 命令超时（已实测：Rust 侧 trace 停在
    // `new_tab:navigating`、命令以「导航失败：CDP 命令超时」被拒）：重试一次；仍失败按
    // "环境不可用"上抛，由调用方计为 **skipped**（可见），而不是把引擎抖动报成注入失败。
    automationMark('ui-fault:newTab-retrying')
    try {
      opened = await withBrowserTimeout(
        browserCommand({ action: 'newTab', url: targetUrl }),
        '重试打开浏览器 tab',
      )
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
      automationMark(`ui-fault:newTab-retry-failed message=${retryMessage}`)
      throw new BrowserUnavailableError(`无头浏览器导航失败：${retryMessage}`)
    }
  }
  // 中间标记是这段排查的**唯一**手段：本机 UI 窗口曾在这条链上静默挂住，而标记只写了
  // `test-run-start`，看不出是 tab 没开、origin 没对、还是运行没起。标记是 fire-and-forget，
  // 不改变任何时序语义，只让一次实跑就能把停滞后端缩到一段。
  automationMark(`ui-fault:tab-opened=${opened.type}`)
  if (opened.type !== 'tabOpened') throw new Error('E2E 故障场景未能打开浏览器 tab')
  const expectedOrigin = new URL(targetUrl).origin
  // `newTab` 返回时页面可能仍在导航：`issue_test_target_grant` 会比对 tab 的**当前** origin，
  // 过早签发会被 Rust 以「tab 当前 origin 与预期不一致」fail-closed 拒绝，而本函数在授权失败
  // 时不会有任何落库/检查点，表现为静默挂起。这里轮询 tab 的实际 URL 直到匹配目标 origin。
  await withBrowserTimeout(waitForTabOrigin(opened.tab.tabId, expectedOrigin), '等待 tab 导航')
  automationMark('ui-fault:origin-settled')
  const target: UiTestTarget = {
    runId,
    tabId: opened.tab.tabId,
    origin: expectedOrigin,
  }
  const step: UiStepSpec = { id: 'fault-click-step', action: 'ui.click', locator: { css: '#apply' } }
  automationMark('ui-fault:run-starting')
  await startUiTestRun({
    runId,
    specPath: 'tests/e2e-runtime-fault.testspec.json',
    plan: faultTestPlan([step], { webBaseUrl: target.origin }),
    target,
    approver: approveEveryStep,
    signal: new AbortController().signal,
  })
}

/** 轮询某个 tab 的实际 origin，直到与目标一致（导航完成）。超时抛出可诊断错误。 */
const waitForTabOrigin = async (tabId: string, expectedOrigin: string): Promise<void> => {
  const deadline = Date.now() + 20_000
  let last = 'unknown'
  while (Date.now() < deadline) {
    const status = await browserCommand({ action: 'tabs' })
    if (status.type === 'tabs') {
      const tab = status.tabs.find((candidate) => candidate.tabId === tabId)
      last = tab?.url ?? 'tab-missing'
      if (tab) {
        try {
          if (new URL(tab.url).origin === expectedOrigin) return
        } catch {
          // about:blank / malformed 期间继续等待
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`E2E 故障场景 tab 未到达目标 origin：期望 ${expectedOrigin}，实际 ${last}`)
}

// 自动化只活在前端且失败静默（console 不落宿主 stdout）：把走过的每一步
// （含状态快照）累积写进单个 DOM 节点，AX 树 dump 一次即可读到完整时间线。
const automationLog: string[] = []
const automationMark = (label: string): void => {
  automationLog.push(label)
  e2eAutomationLog(label)
  let logEl = document.getElementById('e2e-automation-mark-log')
  if (!logEl) {
    logEl = document.createElement('div')
    logEl.id = 'e2e-automation-mark-log'
    document.body?.appendChild(logEl)
  }
  logEl.textContent = `E2E-LOG: ${automationLog.join(' >> ')}`
}

export const runRuntimeFaultAutomation = async (): Promise<void> => {
  const raw = window.__AXIOM_E2E_RUNTIME_AUTOMATION__
  if (!raw) return
  const spec = validateSpec(raw)
  automationMark('init-start')
  await useAgentStore.getState().initialize()
  automationMark('init-done')
  const config: ProviderProfile = {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    profileId: 'e2e.runtime-fault',
    providerId: 'generic-anthropic-compatible',
    apiFormat: 'anthropic-compatible',
    endpoint: spec.endpoint,
    modelId: 'axiom-runtime-fault-e2e',
    timeoutMs: 30_000,
    maxOutputTokens: 256,
    contextWindow: 32_768,
    capabilities: { toolReferences: false, toolSearch: false },
  }
  automationMark('provider-saving')
  if (!(await useAgentStore.getState().saveProvider(config, spec.apiKey)).saved) {
    automationMark('provider-save-failed')
    throw new Error(useAgentStore.getState().settingsError ?? 'Unable to configure E2E Provider')
  }
  automationMark('provider-saved')
  // 跨场景共享：workspace 绑定块与 trash_restore 的 setup 租约/apply 都要用
  // canonical 路径（e2e_register_workspace 的返回值）。
  let boundWorkspace: AuthorizedWorkspace | null = null
  if (spec.workspacePath) {
    // send 的授权门禁要求活动会话绑定已授权工作区：登记（注册表 + 内存授权，
    // authorize_workspace 是恢复专用、只认注册表既有路径）→ 刷新授权投影 →
    // 建立绑定该工作区的活动会话（对齐 UI 的 addWorkspace 流程）。
    // 必须用返回的 canonical 路径匹配/绑定：/var → /private/var 符号链接。
    boundWorkspace = await e2eRegisterWorkspace(spec.workspacePath)
    useAgentStore.setState({
      authorizedWorkspaces: await invoke<AuthorizedWorkspace[]>('get_authorized_workspaces'),
    })
    if (!await useAgentStore.getState().createNewSession(boundWorkspace.path)) {
      automationMark('workspace-bind-failed')
      throw new Error('Unable to bind E2E workspace session')
    }
    // createNewSession 对投影失败仍返回 true（只写 settingsError）：捕获并上抛，
    // 否则 send 会在未绑定工作区的陈旧投影上被授权门禁静默拦截。
    const bindError = useAgentStore.getState().settingsError
    if (bindError) {
      automationMark(`bind-projection-failed: ${bindError}`)
      throw new Error(bindError)
    }
    const boundState = useAgentStore.getState()
    automationMark(`workspace-bound authWsList=[${boundState.authorizedWorkspaces.map((w) => w.path).join('|')}] `
      + `authWs=${boundState.authorizedWorkspace?.path ?? 'null'} `
      + `sessions=[${boundState.sessions.map((s) => `${s.id.slice(0, 6)}:${s.workspace?.path ?? 'null'}`).join('|')}] `
      + `active=${boundState.activeSessionId?.slice(0, 6) ?? 'null'}`)
    // 竞态诊断：授权状态被异步清空的瞬间抓调用栈（AX dump 可读）
    useAgentStore.subscribe((state, prev) => {
      const wiped = (prev.authorizedWorkspaces.length > 0 && state.authorizedWorkspaces.length === 0)
        || (prev.authorizedWorkspace && !state.authorizedWorkspace)
      if (wiped) {
        const stack = (new Error().stack ?? '').split('\n').slice(1, 8).join(' | ')
        automationMark(`WIPE authWs: ${stack}`)
      }
    })
  }
  // trash_restore 的 setup 租约/apply 依赖已绑定的 canonical 工作区路径；
  // TS 无法跨块收窄，这里显式断言（所有 send 场景都带 workspacePath）。
  if (!boundWorkspace) {
    automationMark('workspace-missing-for-setup')
    throw new Error('trash_restore setup requires the bound E2E workspace')
  }
  const setupWorkspacePath = boundWorkspace.path
  if (spec.scenario === 'workspace_trash_restore_step_applied') {
    // 内容静态 → SHA-256 预计算常量（不依赖 webview 的 crypto.subtle 可用性）
    const operations = [
      {
        type: 'trash',
        path: 'runtime-fault-restore-first.txt',
        expectedSha256: '881eca6632d16bfbe4cdef7b27b68e22dd3b303ae0328a6b19c51b596dd827d9',
      },
      {
        type: 'trash',
        path: 'runtime-fault-restore-second.txt',
        expectedSha256: 'e52b7743be02ccc6d3d806d471e04f72a8b892b8c98c4802e5cdf2e88df9cbd4',
      },
    ]
    automationMark('setup-approval-mode')
    try {
      await invoke('set_workspace_approval_mode', {
        sessionId: 'e2e-setup-session',
        mode: 'interactive',
      })
    } catch (error) {
      automationMark(`setup-mode-failed: ${String(error).slice(0, 150)}`)
      throw error
    }
    automationMark('setup-lease')
    let approvalLease: string
    try {
      approvalLease = await invoke<string>('request_workspace_approval_lease', {
        request: {
          sessionId: 'e2e-setup-session',
          runId: 'e2e-setup-run',
          toolCallId: 'e2e-setup-tool-call',
          // toolName 必须是 Rust 命令名（apply_changes 工具 ↔ apply_workspace_changes
          // 命令，映射见 platform/workspaceApproval.ts）——consume 以命令名核销
          toolName: 'apply_workspace_changes',
          input: { operations },
          confirmationMode: 'interactive',
          // 租约按工作区绑定签发与校验（consume 用前端原始传参比对）：必须显式
          // 传 canonical 路径，缺省会以 None 参与比对而与 Some(canonical) 不一致
          workspacePath: setupWorkspacePath,
        },
      })
    } catch (error) {
      automationMark(`setup-lease-failed: ${String(error).slice(0, 150)}`)
      throw error
    }
    automationMark('setup-apply')
    try {
      await invoke('apply_workspace_changes', {
        approvalLease,
        approvalScope: { sessionId: 'e2e-setup-session', runId: 'e2e-setup-run', toolCallId: 'e2e-setup-tool-call' },
        // workspacePath 是命令顶层参数（不在 WorkspaceChangeRequest 内）：
        // 缺省时 consume 以 None 与租约记录的 Some(canonical) 比对必然失配
        workspacePath: setupWorkspacePath,
        request: {
          requestId: 'runtime-fault-restore-setup',
          operations,
        },
      })
    } catch (error) {
      automationMark(`setup-apply-failed: ${String(error).slice(0, 150)}`)
      throw error
    }
    automationMark('setup-apply-done')
  }

  if (spec.scenario === 'compaction_checkpoint_committed') {
    // Keep setup below the automatic token threshold so this scenario reaches
    // the explicit manual-compaction persistence boundary.
    // 载荷尺寸经实测校准：三轮累计的请求估算 token 必须低于自动压缩阈值，
    // 否则 token_threshold 自动压缩抢在手动 compactContext 之前触发，
    // 崩溃检查点变成 token_threshold 而非 manual（assertAfterCrash 断言失败）。
    const payload = 'compaction-runtime-fault-payload '.repeat(150)
    for (let round = 1; round <= 3; round += 1) {
      await useAgentStore.getState().send(`${spec.prompt} round ${round}\n${payload}`)
      const state = useAgentStore.getState()
      if (state.error || state.running) {
        throw new Error(state.error ?? `Compaction setup round ${round} did not settle`)
      }
    }
    await useAgentStore.getState().compactContext()
    throw new Error('compaction_checkpoint_committed fault checkpoint did not terminate the app')
  }

  if (isTestRunScenario(spec.scenario)) {
    if (!spec.targetUrl) throw new Error('E2E runtime fault test run scenario requires a target URL')
    const runId = `e2e-runtime-fault-${spec.scenario}`
    automationMark(`test-run-start ${spec.scenario}`)
    try {
      if (spec.scenario === 'test_step_action_applied') {
        await runUiFaultStep(runId, spec.targetUrl)
      } else if (spec.scenario === 'test_spec_authoring_interrupted') {
        if (!spec.workspacePath) throw new Error('写用例窗口需要工作区路径')
        await runSpecAuthoringFault(boundWorkspace?.path ?? spec.workspacePath, spec.targetUrl)
      } else if (spec.scenario === 'test_environment_probe_inflight') {
        await runEnvironmentProbeFault(spec.targetUrl)
      } else if (spec.scenario === 'test_suite_run_interrupted') {
        if (!spec.workspacePath) throw new Error('套件故障窗口需要工作区路径')
        // 必须用登记返回的 **canonical** 路径：`/var` → `/private/var` 是符号链接，
        // 非 canonical 路径会被工作区授权检查 fail-closed 拒掉（用例文件读不出来，
        // 整批一个 run 都不会创建）。
        await runSuiteFault(boundWorkspace?.path ?? spec.workspacePath, spec.targetUrl)
      } else {
        await runApiFaultStep(spec.scenario, runId, spec.targetUrl)
      }
    } catch (error) {
      // 本机拉不起无头浏览器（冷启动阻塞/引擎缺失）时 UI 窗口场景无法到达注入点。这是
      // **环境**问题而非注入逻辑失效：写可识别跳过标记并正常返回，harness 据此计为 skipped。
      if (error instanceof BrowserUnavailableError) {
        automationMark(`SKIP-browser-unavailable ${error.message}`)
        return
      }
      throw error
    }
    throw new Error(`${spec.scenario} fault checkpoint did not terminate the app`)
  }

  automationMark('send-called')
  const run = useAgentStore.getState().send(spec.prompt)
  try {
    await waitForStoreState(() => useAgentStore.getState().running)
  } catch (error) {
    // send 静默早退时（授权门禁/未就绪），把判定所需的全量状态写进标记
    const state = useAgentStore.getState()
    automationMark(`send-early-exit error=${state.error ?? 'null'} `
      + `setupReq=${state.providerSetupRequired} ready=${state.providerReady} `
      + `authWs=${state.authorizedWorkspace?.path ?? 'null'} `
      + `authWsList=[${state.authorizedWorkspaces.map((w) => w.path).join('|')}] `
      + `sessions=[${state.sessions.map((s) => `${s.id.slice(0, 6)}:${s.workspace?.path ?? 'null'}`).join('|')}] `
      + `active=${state.activeSessionId?.slice(0, 6) ?? 'null'}`)
    throw error
  }
  automationMark('running')
  if ([
    'workspace_audit_persisted',
    'workspace_change_step_applied',
    'workspace_trash_restore_step_applied',
  ].includes(spec.scenario)) {
    automationMark('approval-waiting')
    await waitForStoreState(() => useAgentStore.getState().pendingApproval !== null)
    const toolCallId = useAgentStore.getState().pendingApproval?.toolCallId
    if (!toolCallId) throw new Error('Workspace audit scenario did not request approval')
    await useAgentStore.getState().approveToolCall(toolCallId)
    automationMark('approved')
  }
  if (spec.scenario === 'mutation_batch_committed') {
    await appendRuntimeFaultAutomationMessage('durable runtime mutation marker')
  }
  if (spec.scenario === 'queue_recovered' || spec.scenario === 'queue_consuming') {
    automationMark('queue-calling')
    if (!spec.draft || !await useAgentStore.getState().queueSteering(spec.draft)) {
      automationMark('queue-failed')
      throw new Error('Unable to queue E2E fault draft')
    }
    await waitForStoreState(() => useAgentStore.getState().pendingSteeringCount === 1)
    automationMark('queued')
    if (spec.scenario === 'queue_recovered') {
      automationMark('stop-calling')
      await useAgentStore.getState().stop()
      automationMark('stop-returned-without-checkpoint')
      throw new Error('queue_recovered fault checkpoint did not terminate the app')
    }
  }
  automationMark('awaiting-run')
  await run
  throw new Error(`${spec.scenario} fault checkpoint did not terminate the app`)
}
