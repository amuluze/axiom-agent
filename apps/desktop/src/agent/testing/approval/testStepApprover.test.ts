import { describe, expect, it } from 'vitest'
import { createTestStepApprover } from './testStepApprover'

const request = (stepId: string) => ({
  actor: { kind: 'testStep' as const, testRunId: 'run-1', stepId },
  card: { actionLabel: '点击 role=button 名称「应用」', origin: 'https://shop.test', target: 'role=button 名称「应用」' },
})

describe('createTestStepApprover', () => {
  it('holds the request until the user responds, then resolves with that decision', async () => {
    const approver = createTestStepApprover()
    const decision = approver.approve(request('apply'), new AbortController().signal)
    const [pending] = approver.list()
    expect(pending?.key).toBe('run-1:apply')
    expect(approver.respond(pending?.key ?? '', true)).toBe(true)
    await expect(decision).resolves.toBe(true)
    expect(approver.list()).toEqual([])
  })

  it('treats a stopped run as a denial and clears the pending entry', async () => {
    const approver = createTestStepApprover()
    const controller = new AbortController()
    const decision = approver.approve(request('apply'), controller.signal)
    controller.abort()
    await expect(decision).resolves.toBe(false)
    expect(approver.list()).toEqual([])
  })

  it('refuses a second pending request for the same step instead of overwriting the first', async () => {
    const approver = createTestStepApprover()
    const first = approver.approve(request('apply'), new AbortController().signal)
    await expect(approver.approve(request('apply'), new AbortController().signal)).resolves.toBe(false)
    approver.respond('run-1:apply', false)
    await expect(first).resolves.toBe(false)
  })

  it('ignores responses for keys that are not pending', () => {
    const approver = createTestStepApprover()
    expect(approver.respond('run-1:missing', true)).toBe(false)
  })

  it('notifies subscribers when requests appear and settle', async () => {
    const approver = createTestStepApprover()
    let notifications = 0
    const unsubscribe = approver.subscribe(() => {
      notifications += 1
    })
    const decision = approver.approve(request('apply'), new AbortController().signal)
    approver.respond('run-1:apply', true)
    await decision
    unsubscribe()
    expect(notifications).toBe(2)
  })
})
