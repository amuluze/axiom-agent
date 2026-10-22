import { describe, expect, it } from 'vitest'
import {
  TEST_SPEC_STEP_KEYS,
  TEST_SPEC_TOP_LEVEL_KEYS,
} from '@/agent/testing/spec/parseTestSpec'
import { TEST_SPEC_VERSION } from '@/agent/testing/spec/types'
import { BUILTIN_SKILL_BODIES } from './builtinSkillBodies'

/**
 * 内置 test-design Skill 内联的协议字段集 ↔ 解析器接受面的契约。
 *
 * 背景：新项目工作区里没有 `docs/ui-api-automation-usage.md`，Skill 因此内联了一份
 * 最小字段集（BUILTIN_SKILL_BODIES_VERSION v33）。这让协议出现**两个数据源**——
 * 而模型可见内容里只有这份内联没有任何指纹门禁。本测试把它钉在解析器常量上：
 *
 * - 协议新增/删除顶层键或步骤动作时，Skill 必须同步，否则红；
 * - 协议版本升级时，Skill 里写的 `version:N` 必须同步。
 *
 * 它只断言「Skill 的声明 ⊆ 解析器常量」，不复制字段语义——语义真值仍是解析器与
 * 用户文档，本文件只防静默滞后。
 */
const testDesignBody = (): string => {
  const skill = BUILTIN_SKILL_BODIES.find((entry) => entry.name === 'test-design')
  if (!skill) throw new Error('内置 test-design Skill 缺失')
  return skill['zh-CN'].body
}

describe('test-design Skill 内联协议与解析器接受面一致', () => {
  it('声明的协议版本与 TEST_SPEC_VERSION 同步', () => {
    expect(testDesignBody()).toContain(`version:${TEST_SPEC_VERSION}`)
  })

  it('列出的步骤动作集合与 TEST_SPEC_STEP_KEYS 完全一致', () => {
    const declared = new Set(testDesignBody().match(/\b(?:ui\.[a-z]+|api\.request)\b/gu) ?? [])
    expect([...declared].sort()).toEqual([...Object.keys(TEST_SPEC_STEP_KEYS)].sort())
  })

  it('覆盖全部顶层键（协议新增键时 Skill 必须同步）', () => {
    const body = testDesignBody()
    const declared = TEST_SPEC_TOP_LEVEL_KEYS.filter((key) =>
      new RegExp(`(^|[^A-Za-z])${key}([^A-Za-z]|$)`, 'u').test(body))
    expect([...declared].sort()).toEqual([...TEST_SPEC_TOP_LEVEL_KEYS].sort())
  })
})
