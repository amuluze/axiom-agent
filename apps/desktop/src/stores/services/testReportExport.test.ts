// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import { downloadTestRunJUnit, serializeTestRunReport, toJUnitXml } from './testReportExport'

const report: TestRunDetailRecord = {
  summary: {
    id: 'run-1',
    specPath: 'tests/checkout.testspec.json',
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
    caseId: 'checkout',
    caseName: '结算',
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
    failureKind: 'assertion',
    failureOrigin: null,
    steps: [{
      id: 'step-run',
      stepId: 'assert-total',
      action: 'ui.assert',
      status: 'failed',
      startedAt: 1,
      finishedAt: 2,
      detailsJson: '{"message":"金额不一致"}',
      evidenceContentHash: 'evidence-hash',
      evidenceArtifact: null,
    }],
  }],
}

describe('serializeTestRunReport', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('exports a versioned report without dropping step details', () => {
    const serialized = serializeTestRunReport(report, new Date('2026-10-12T00:00:00.000Z'))

    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 2,
      exportedAt: '2026-10-12T00:00:00.000Z',
      run: {
        summary: { id: 'run-1', environmentId: 'env-1' },
        cases: [{ steps: [{ evidenceContentHash: 'evidence-hash' }] }],
      },
    })
  })

  it('downloads the report with a stable file name and releases the object URL', () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn(() => 'blob:report')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    downloadTestRunJUnit(report)

    expect(document.querySelector('a[download="axiom-test-run-run-1.xml"]')).toBeNull()

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(document.querySelector('a[download="axiom-test-run-run-1.json"]')).toBeNull()
    vi.runAllTimers()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report')
  })
})

describe('toJUnitXml', () => {
  const withSecrets: TestRunDetailRecord = {
    ...report,
    cases: [{
      ...report.cases[0]!,
      failureOrigin: 'environment',
      steps: [{
        ...report.cases[0]!.steps[0]!,
        detailsJson: JSON.stringify({
          message: '请求超时',
          headers: { authorization: 'Bearer sk-live-secret' },
          body: '{"token":"sk-live-secret"}',
        }),
      }],
    }],
  }

  it('emits a CI-consumable document with the objective failure type', () => {
    const xml = toJUnitXml(withSecrets)

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<testsuites name="axiom" tests="1" failures="1" errors="0" skipped="0"')
    expect(xml).toContain('name="结算 / assert-total"')
    expect(xml).toContain('classname="tests/checkout.testspec.json"')
    // 归因进 type 属性：CI 可以按 environment/approval/driver/assertion 分流。
    // 元素由**状态**决定（failed → failure），`type` 由宿主归因决定（environment）。
    expect(xml).toContain('<failure message="请求超时" type="environment"/>')
    expect(xml).toContain('证据 SHA-256: evidence-hash')
  })

  it('never leaks header values or bodies into CI logs', () => {
    const xml = toJUnitXml(withSecrets)

    // detailsJson 只取 message：header/body 留在 Artifact 里，要有权限的界面才拿得到。
    expect(xml).not.toContain('sk-live-secret')
    expect(xml).not.toContain('authorization')
    expect(xml).not.toContain('&quot;token&quot;')
  })

  it('escapes markup and drops characters XML 1.0 forbids', () => {
    const xml = toJUnitXml({
      ...report,
      cases: [{
        ...report.cases[0]!,
        caseName: 'A & B <script>',
        steps: [{ ...report.cases[0]!.steps[0]!, detailsJson: JSON.stringify({ message: 'bad\u0000control <tag>' }) }],
      }],
    })

    expect(xml).toContain('name="A &amp; B &lt;script&gt; / assert-total"')
    expect(xml).toContain('message="badcontrol &lt;tag&gt;"')
  })
})
