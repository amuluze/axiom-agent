import { describe, expect, it } from 'vitest'
import { PlanningStreamGuard } from './planningGuard'

describe('PlanningStreamGuard', () => {
  it('interrupts a repeated planning loop after the byte floor', () => {
    const guard = new PlanningStreamGuard()
    let interrupted = false
    for (let index = 0; index < 80; index += 1) {
      interrupted = guard.observe('我需要先检查相关文件，然后再决定下一步。'.repeat(4))
      if (interrupted) break
    }
    expect(interrupted).toBe(true)
  })

  it('does not interrupt a long final answer without planning markers', () => {
    const guard = new PlanningStreamGuard()
    expect(guard.observe('这是已经完成的实现结果与验证结论。'.repeat(2_000))).toBe(false)
  })

  it('does not interrupt short planning before a tool call could arrive', () => {
    const guard = new PlanningStreamGuard()
    expect(guard.observe('I need to inspect the runtime first. '.repeat(20))).toBe(false)
  })
})
