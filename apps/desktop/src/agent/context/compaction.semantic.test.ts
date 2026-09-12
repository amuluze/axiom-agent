/// <reference types="node" />
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_HEADINGS,
  CHECKPOINT_RULES,
  resolveSummaryMaxOutputTokens,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SYSTEM_PROMPT,
} from './compaction'

describe('compaction prompt version semantics', () => {
  it('binds summary prompt text to SUMMARY_PROMPT_VERSION', () => {
    const source = [
      SUMMARY_PROMPT_VERSION,
      SUMMARY_SYSTEM_PROMPT,
      CHECKPOINT_HEADINGS,
      CHECKPOINT_RULES,
    ].join('\n')
    const digest = createHash('sha256').update(source, 'utf8').digest('hex')
    // 硬绑定：摘要提示词正文（SUMMARY_SYSTEM_PROMPT / CHECKPOINT_HEADINGS /
    // CHECKPOINT_RULES）或 SUMMARY_PROMPT_VERSION 任一变化都会改变此摘要。
    // 修改时须同步 bump SUMMARY_PROMPT_VERSION 并更新此摘要，否则旧 checkpoint
    // 会被误判为 current 而复用，造成两代提示词语义混用（见 checkpointIntegrity）。
    // v4：CHECKPOINT_RULES 增补 Skill 装载记录保留规则（压缩后可幂等重载）。
    expect(digest).toBe('4a699c264eebd2f10886fc3193c946d7c9f06ad633622d2ef2f184136422e803')
  })

  it('v4 起保留规则要求 Skill 装载记录进「## 关键上下文」（压缩后重载钩子）', () => {
    expect(CHECKPOINT_RULES).toContain('load_skill')
    expect(CHECKPOINT_RULES).toContain('## 关键上下文')
    expect(CHECKPOINT_RULES).toContain('重新加载')
  })
})

describe('resolveSummaryMaxOutputTokens', () => {
  it('clamps to the 4096 lower bound for short inputs', () => {
    expect(resolveSummaryMaxOutputTokens(0)).toBe(4_096)
    expect(resolveSummaryMaxOutputTokens(100 * 1024)).toBe(4_096)
  })

  it('scales with input size beyond the lower bound', () => {
    // 256 KiB ≈ 87K token / 12 ≈ 7.3K，落于下界与上界之间
    expect(resolveSummaryMaxOutputTokens(256 * 1024)).toBe(7_282)
  })

  it('clamps to the 16384 upper bound for very large inputs', () => {
    expect(resolveSummaryMaxOutputTokens(1024 * 1024)).toBe(16_384)
  })
})
