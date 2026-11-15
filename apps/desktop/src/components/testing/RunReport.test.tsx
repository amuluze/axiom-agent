// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import { RunReport } from './RunReport'

const planWith = (headers?: Record<string, { secretId: string }>): CompiledTestPlan => ({
  specId: 'api',
  name: 'API 用例',
  specVersion: 9,
  specHash: 'hash',
  target: {},
  environmentNames: [],
  cases: [{
    id: 'session',
    name: '会话',
    steps: [{
      id: 'me',
      action: 'api.request',
      method: 'GET',
      url: '/me',
      ...(headers ? { headers } : {}),
    }],
  }],
})

const reportWith = (statusCode: number): TestRunDetailRecord => ({
  summary: {
    id: 'run-1',
    specPath: 'tests/api.testspec.json',
    specHash: 'hash',
    environmentId: 'env-1',
    batchId: null,
    envFactsJson: null,
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
  },
  planContentHash: 'plan-hash',
  cases: [{
    id: 'case-run',
    caseId: 'session',
    caseName: '会话',
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
    failureKind: 'assertion',
    failureOrigin: 'assertion',
    steps: [{
      id: 'step-run',
      stepId: 'me',
      action: 'api.request',
      status: 'failed',
      startedAt: 1,
      finishedAt: 2,
      detailsJson: JSON.stringify({ message: 'API 断言失败：status', statusCode }),
      evidenceContentHash: null,
      evidenceArtifact: null,
    }],
  }],
})

const renderReport = (report: TestRunDetailRecord, plan: CompiledTestPlan | null) => {
  const onUpdateSecret = vi.fn()
  render(
    <RunReport
      report={report}
      plan={plan}
      onUpdateSecret={onUpdateSecret}
      repairRounds={null}
      handoffSessionId={null}
      handoffSessions={[]}
      handoffSending={false}
      canRerun={false}
      expandedStepKey={null}
      onHandoffSessionChange={vi.fn()}
      onHandoff={vi.fn()}
      onRerun={vi.fn()}
      onBack={vi.fn()}
      onExport={vi.fn()}
      onExportJUnit={vi.fn()}
      onToggleStep={vi.fn()}
    />,
  )
  return { onUpdateSecret }
}

describe('RunReport Secret expiry hint', () => {
  it('offers an update entry for a 401 step that references a Secret', () => {
    const { onUpdateSecret } = renderReport(
      reportWith(401),
      planWith({ Cookie: { secretId: 'apitest.beacon-session' } }),
    )

    fireEvent.click(screen.getByRole('button', { name: /Secret apitest\.beacon-session 可能已过期/ }))
    expect(onUpdateSecret).toHaveBeenCalledWith('apitest.beacon-session')
  })

  it('does not hint when the status is not 401', () => {
    renderReport(reportWith(500), planWith({ Cookie: { secretId: 'apitest.beacon-session' } }))
    expect(screen.queryByRole('button', { name: /可能已过期/ })).not.toBeInTheDocument()
  })

  it('does not hint when the step does not reference a Secret', () => {
    renderReport(reportWith(401), planWith())
    expect(screen.queryByRole('button', { name: /可能已过期/ })).not.toBeInTheDocument()
  })
})
