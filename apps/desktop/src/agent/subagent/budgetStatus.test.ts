import { describe, expect, it } from 'vitest'
import { createParentRunLedger, DEFAULT_SUBAGENT_CHILD_BUDGET } from './contracts'
import { SubAgentBudgetLedger } from './SubAgentBudgetLedger'
import { buildBudgetStatusMessage, computeEffectiveMessageBytes } from './budgetStatus'

const makeLedger = (contextWindow = 100_000): SubAgentBudgetLedger => {
  const ledger = new SubAgentBudgetLedger(
    createParentRunLedger(),
    DEFAULT_SUBAGENT_CHILD_BUDGET,
    contextWindow,
  )
  // 与 delegate 路径一致：beginParentCall 设置 startedAt，时长预算才有意义。
  ledger.beginParentCall()
  return ledger
}

describe('computeEffectiveMessageBytes', () => {
  it('contextWindow 为 0 时退化为名义上限', () => {
    expect(computeEffectiveMessageBytes(512 * 1024, 0)).toBe(512 * 1024)
  })

  it('窗口折算（窗口 × 3 bytes/token）低于名义上限时取窗口值', () => {
    // 128K 窗口 ≈ 384 KiB，低于名义 512 KiB
    expect(computeEffectiveMessageBytes(512 * 1024, 128_000)).toBe(384_000)
  })

  it('窗口折算高于名义上限时名义值仍为边界', () => {
    expect(computeEffectiveMessageBytes(512 * 1024, 200_000)).toBe(512 * 1024)
  })
})

describe('buildBudgetStatusMessage', () => {
  it('未触发任何阈值时返回 null（零开销）', () => {
    const ledger = makeLedger()
    expect(buildBudgetStatusMessage(ledger, 512 * 1024)).toBeNull()
  })

  it('轮次达到 75% 时返回含精确数字的状态消息', () => {
    const ledger = makeLedger()
    ledger.childTurns = 12 // 12/16 = 75%
    ledger.childToolCalls = 10
    const message = buildBudgetStatusMessage(ledger, 512 * 1024)
    expect(message).toContain('[预算状态]')
    expect(message).toContain('已用 12/16 轮')
    expect(message).toContain('10/48 次工具调用')
    expect(message).toContain('512 KiB')
    expect(message).toContain('交由父 Agent 决定是否收窄范围继续')
  })

  it('消息字节达到有效上限 75% 时触发', () => {
    const ledger = makeLedger()
    ledger.childMessageBytes = 288_000 // 288/384 = 75%
    const message = buildBudgetStatusMessage(ledger, 384_000)
    expect(message).not.toBeNull()
    expect(message).toContain('281/375 KiB')
  })

  it('剩余时长不足 25% 时触发且剩余秒数不为负', () => {
    const ledger = makeLedger()
    ledger.childTurns = 1
    const started = Date.now()
    // 剩余 30s < 240s × 25%（startedAt 与 started 相差微秒级，舍入到 30s 稳定）
    const message = buildBudgetStatusMessage(ledger, 512 * 1024, started + (240_000 - 30_000))
    expect(message).not.toBeNull()
    expect(message).toContain('剩余约 30s')
  })

  it('累计输出 token 达到 75% 时触发，且状态行渲染该维度（可自愈的前提）', () => {
    const ledger = makeLedger()
    ledger.childOutputTokens = 73_728 // 73728/98304 = 75%
    const message = buildBudgetStatusMessage(ledger, 512 * 1024)
    expect(message).not.toBeNull()
    expect(message).toContain('累计输出 73728/98304 tokens')
  })

  it('工具调用达到 75% 时触发（一轮批量多调时先于轮次触顶）', () => {
    const ledger = makeLedger()
    ledger.childToolCalls = 36 // 36/48 = 75%
    const message = buildBudgetStatusMessage(ledger, 512 * 1024)
    expect(message).not.toBeNull()
    expect(message).toContain('36/48 次工具调用')
  })

  it('父 run 共享配额接近上限时触发：渲染请求/委派余量并强调务必收口', () => {
    const ledger = makeLedger()
    ledger.parentLedger.modelRequestCount = 90 // 90/120 = 75%
    ledger.parentLedger.callCount = 7 // 含当前委派，剩余 1 次
    const message = buildBudgetStatusMessage(ledger, 512 * 1024)
    expect(message).not.toBeNull()
    expect(message).toContain('父 run 共享配额')
    expect(message).toContain('90/120 次模型请求')
    expect(message).toContain('剩余 1 次委派')
    expect(message).toContain('父 run 共享配额也将尽')
  })

  it('仅子维度触发时也渲染父 run 配额行（信息性），但不强调父配额将尽', () => {
    const ledger = makeLedger()
    ledger.childTurns = 12
    const message = buildBudgetStatusMessage(ledger, 512 * 1024)
    expect(message).toContain('父 run 共享配额')
    expect(message).not.toContain('父 run 共享配额也将尽')
  })

  it('剩余时长为 0（deadline 已过）时显示 0s', () => {
    const ledger = makeLedger()
    const started = Date.now()
    ledger.childTurns = 16
    const message = buildBudgetStatusMessage(ledger, 512 * 1024, started + 240_001)
    expect(message).toContain('剩余约 0s')
  })
})
