import { describe, expect, it } from 'vitest'
import { AUTHORING_FEATURE_MAX_LENGTH, buildTestAuthoringInstruction } from './authoringInstruction'

describe('buildTestAuthoringInstruction', () => {
  it('renders a deterministic instruction that pins the skill, the file and the boundaries', () => {
    const instruction = buildTestAuthoringInstruction({
      feature: '优惠券叠加规则',
      specPath: 'tests/coupon.testspec.json',
    })

    expect(instruction).toBe([
      '请为下面的功能编写可重放的自动化测试用例。',
      '',
      '- 功能：优惠券叠加规则',
      '- 目标用例文件：tests/coupon.testspec.json',
      '- 相关既有用例：无',
      '',
      '请先加载内置技能 test-design（load_skill({ name: "test-design" })；若 load_skill 尚未激活，'
      + '先用 discover_agent_tools({ query: "load_skill" }) 激活），再按它的流程执行：',
      '1. 先定测试点（kind = new_feature / regression），再为每个测试点写用例，用例的 verifies 指向测试点；',
      '2. 用真实接口与页面操作构造数据，写 typed 断言，清理走产品原生接口；',
      '3. 只写 tests/ 目录下的用例文件，不要改产品源码；写文件时我会逐次批准。',
      '',
      '完成后在会话里回报：测试点清单、每个测试点对应的用例 id，以及无法客观判定、需要我确认的点。',
    ].join('\n'))
    // 同一输入必须逐字节相同：指令会被写进会话记录，漂移等于审计口径漂移。
    expect(buildTestAuthoringInstruction({
      feature: '优惠券叠加规则',
      specPath: 'tests/coupon.testspec.json',
    })).toBe(instruction)
  })

  it('carries the related file and folds a multi-line feature into one line', () => {
    const instruction = buildTestAuthoringInstruction({
      feature: '  优惠券叠加规则\n（含过期券与最低消费门槛）  ',
      specPath: 'tests/coupon.testspec.json',
      relatedSpecPath: 'tests/checkout.testspec.json',
    })
    expect(instruction).toContain('- 功能：优惠券叠加规则 （含过期券与最低消费门槛）')
    expect(instruction).toContain('- 目标用例文件：tests/coupon.testspec.json')
    expect(instruction).toContain('- 相关既有用例：tests/checkout.testspec.json')
    // 折叠换行：指令的可读性靠结构，不靠用户输入里的换行。
    expect(instruction.split('\n').some((line) => line.includes('（含过期券与最低消费门槛）\n'))).toBe(false)
  })

  it('caps an over-long feature description', () => {
    const instruction = buildTestAuthoringInstruction({
      feature: 'x'.repeat(AUTHORING_FEATURE_MAX_LENGTH + 50),
      specPath: 'tests/long.testspec.json',
    })
    expect(instruction).toContain(`- 功能：${'x'.repeat(AUTHORING_FEATURE_MAX_LENGTH)}`)
    expect(instruction).not.toContain('x'.repeat(AUTHORING_FEATURE_MAX_LENGTH + 1))
  })

  it('refuses an empty feature and a target outside tests/', () => {
    expect(() => buildTestAuthoringInstruction({ feature: '   ', specPath: 'tests/a.testspec.json' }))
      .toThrow('写用例指令需要功能描述')
    for (const specPath of ['src/a.testspec.json', 'tests/a.ax', 'tests/', '/repo/tests/a.testspec.json']) {
      expect(() => buildTestAuthoringInstruction({ feature: '功能', specPath }))
        .toThrow('必须是 tests/ 下的 .testspec.json')
    }
  })
})
