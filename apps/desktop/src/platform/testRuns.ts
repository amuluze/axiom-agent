import { invoke } from '@tauri-apps/api/core'
import { commands } from './bindings'
import type { ArtifactReference } from '@/agent/core/types'

/**
 * 测试运行持久化的平台封装（R1-2）。状态转移由 Rust 状态表校验；工作区路径由 Rust 从授权根取得。
 */
export type TestRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'passed'
  | 'failed'
  | 'error'
  | 'rejected'
  | 'skipped'
  | 'canceled'
  | 'interrupted'

export interface NewTestStepRecord {
  id: string
  stepId: string
  action: string
}

export interface NewTestCaseRecord {
  id: string
  caseId: string
  caseName: string
  steps: NewTestStepRecord[]
}

export interface NewTestRunRecord {
  id: string
  specPath: string
  specHash: string
  planContentHash?: string
  sourceSessionId?: string
  environmentId?: string
  /** 套件运行分组键（T3-1）：一次套件运行里的每个 spec 各一条 run，共享同一个 batchId。 */
  batchId?: string
  /** 本次运行的环境与探针事实快照（T1-4）；没有环境时省略。 */
  envFactsJson?: string
  startedAt: number
  cases: NewTestCaseRecord[]
}

export interface TestRunSummaryRecord {
  id: string
  specPath: string
  specHash: string
  environmentId: string | null
  /** 套件运行分组键；单文件运行也是一次只含一个 spec 的批次。 */
  batchId: string | null
  /** 运行当时的环境与探针事实快照（环境后来改名/删除都不影响历史报告）。 */
  envFactsJson: string | null
  status: TestRunStatus
  startedAt: number
  finishedAt: number | null
}

export interface TestStepDetailRecord {
  id: string
  stepId: string
  action: string
  status: TestRunStatus
  startedAt: number | null
  finishedAt: number | null
  detailsJson: string | null
  evidenceContentHash: string | null
  evidenceArtifact: ArtifactReference | null
}

export interface TestCaseDetailRecord {
  id: string
  caseId: string
  caseName: string
  status: TestRunStatus
  startedAt: number | null
  finishedAt: number | null
  failureKind: string | null
  /** 宿主客观归因（environment/approval/driver/assertion）；未失败时为 null。 */
  failureOrigin: string | null
  steps: TestStepDetailRecord[]
}

export interface TestRunDetailRecord {
  summary: TestRunSummaryRecord
  planContentHash: string | null
  cases: TestCaseDetailRecord[]
}

export const createTestRunRecord = (run: NewTestRunRecord): Promise<void> =>
  invoke<void>('create_test_run_record', { run })

export const transitionTestRunRecord = (
  runId: string,
  status: TestRunStatus,
  finishedAt?: number,
  summaryJson?: string,
): Promise<void> =>
  invoke<void>('transition_test_run_record', { runId, status, finishedAt: finishedAt ?? null, summaryJson: summaryJson ?? null })

export const transitionTestCaseRecord = (
  caseRunId: string,
  status: TestRunStatus,
  now: number,
  failureKind?: string,
  failureOrigin?: string,
): Promise<void> =>
  invoke<void>('transition_test_case_record', {
    caseRunId,
    status,
    now,
    failureKind: failureKind ?? null,
    failureOrigin: failureOrigin ?? null,
  })

export const transitionTestStepRecord = (
  stepRunId: string,
  status: TestRunStatus,
  now: number,
  detailsJson?: string,
  evidenceContentHash?: string,
): Promise<void> =>
  invoke<void>('transition_test_step_record', {
    stepRunId,
    status,
    now,
    detailsJson: detailsJson ?? null,
    evidenceContentHash: evidenceContentHash ?? null,
  })

export const listTestRunRecords = async (limit?: number): Promise<TestRunSummaryRecord[]> =>
  commands.listTestRunRecords(limit ?? null)

export interface TestBatchSummaryRecord {
  batchId: string
  /** 该批次的全部 run（按 startedAt DESC）；超过宿主硬上限时 `truncated` 为真。 */
  runs: TestRunSummaryRecord[]
  truncated: boolean
}

/** 最近一个批次：直接按 batch_id 回读，不依赖「最近 N 条运行」列表的发现窗口。 */
export const getLatestTestBatchRecord = async (): Promise<TestBatchSummaryRecord | null> =>
  commands.latestTestBatchRecord()

export const getTestRunRecord = async (runId: string): Promise<TestRunDetailRecord | null> => {
  const detail = await commands.getTestRunRecord(runId)
  if (!detail) return null
  return {
    ...detail,
    cases: detail.cases.map((testCase) => ({
      ...testCase,
      steps: testCase.steps.map((step) => ({
        ...step,
        evidenceArtifact: step.evidenceArtifact
          ? { ...step.evidenceArtifact, kind: step.evidenceArtifact.kind as ArtifactReference['kind'] }
          : null,
      })),
    })),
  }
}
