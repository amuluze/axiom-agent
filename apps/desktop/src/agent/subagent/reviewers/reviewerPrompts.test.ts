import { describe, expect, it } from 'vitest'
import { buildInspectSystemPrompt } from './buildInspectPrompt'
import { buildExamineSystemPrompt } from './buildExaminePrompt'
import { buildReviewSystemPrompt } from './buildReviewPrompt'
import { parseReviewerVerdict } from './reviewerCommon'

const budget = { maxTurns: 8, maxToolCalls: 20, maxMessageBytes: 256 * 1024, maxInlineToolResultBytes: 64 * 1024 }

describe('审查 SubAgent system prompt', () => {
  it.each([
    ['inspect', buildInspectSystemPrompt, 'Task Spec'],
    ['examine', buildExamineSystemPrompt, '检查实施方案'],
    ['review', buildReviewSystemPrompt, '代码改动'],
  ] as const)('%s 声明角色、审查对象、只读边界与输出格式', (_name, builder, keyword) => {
    const prompt = builder({ scope: ['.specs'], workspaceRoot: '/repo', budget })
    expect(prompt).toContain('# 角色')
    expect(prompt).toContain(keyword)
    expect(prompt).toContain('read')
    expect(prompt).toContain('不修改任何状态')
    expect(prompt).toContain('# 输出')
    expect(prompt).toContain('通过 / 不通过')
    expect(prompt).toContain('# 禁止')
    expect(prompt).toContain('不执行命令')
    expect(prompt).toContain('/repo')
    expect(prompt).toContain('.specs')
  })

  it('scope 为空时回退到全工作区只读说明', () => {
    const prompt = buildInspectSystemPrompt({ budget })
    expect(prompt).toContain('整个已授权工作区')
  })

  it('预算渲染轮次上限与字节直觉，不宣示不可达的工具调用数', () => {
    const prompt = buildReviewSystemPrompt({ budget })
    expect(prompt).toContain('8 轮模型请求（每轮可包含多个工具调用）')
    expect(prompt).not.toContain('20 次工具调用')
    // 轮次最紧缺 + 全量重发 + 字节换算（256 KiB / 64 KiB = 4 次）
    expect(prompt).toContain('一次模型请求消耗一轮')
    expect(prompt).toContain('完整对话历史')
    expect(prompt).toContain('4 次满额大文件读取就会用尽消息字节预算')
  })

  it('三个审查 prompt 输出段约束问题清单体积', () => {
    for (const builder of [buildInspectSystemPrompt, buildExamineSystemPrompt, buildReviewSystemPrompt]) {
      const prompt = builder({ budget })
      expect(prompt).toContain('问题清单控制在 4 KiB（约 1300 汉字）以内')
      expect(prompt).toContain('path:line')
    }
  })

  it('review prompt 提示 diff 已计入消息预算并随请求重发', () => {
    const prompt = buildReviewSystemPrompt({ budget })
    expect(prompt).toContain('改动 diff（由父 Agent 提供）')
    expect(prompt).toContain('已计入消息字节预算并随每次请求全量重发')
    // inspect/examine 无 diff 通道，不渲染该提示
    expect(buildInspectSystemPrompt({ budget })).not.toContain('改动 diff（由父 Agent 提供）')
  })

  it('contextWindow 渲染独立于 budget：传入时两个分支都出现窗口行', () => {
    // 对齐 explore：ledger 的 token 估算拦截照常生效，prompt 让子 Agent 感知窗口收口。
    expect(buildInspectSystemPrompt({ budget, contextWindow: 128_000 }))
      .toContain('你的上下文窗口为 128000 tokens')
    expect(buildExamineSystemPrompt({ contextWindow: 128_000 }))
      .toContain('你的上下文窗口为 128000 tokens')
    // 未传或非正数不渲染
    expect(buildReviewSystemPrompt({ budget })).not.toContain('上下文窗口为')
    expect(buildReviewSystemPrompt({ budget, contextWindow: 0 })).not.toContain('上下文窗口为')
  })
})

describe('parseReviewerVerdict', () => {
  it('解析固定格式的通过/不通过，含变体冒号与前后缀', () => {
    expect(parseReviewerVerdict('结论：通过\n- 依据：测试齐全')).toBe('pass')
    expect(parseReviewerVerdict('- 结论:不通过\n- 问题清单：…')).toBe('fail')
    expect(parseReviewerVerdict('前置说明。\n结论：通过（附带非阻塞建议）')).toBe('pass')
  })

  it('不通过不得被截断解析为通过；格式漂移返回 unknown', () => {
    expect(parseReviewerVerdict('结论：不通过')).toBe('fail')
    expect(parseReviewerVerdict('审查发现若干问题但未按格式收口')).toBe('unknown')
    expect(parseReviewerVerdict('')).toBe('unknown')
    expect(parseReviewerVerdict('结论：待定')).toBe('unknown')
  })

  it('多次「结论：」以末次为准——行文中途的假设性结论不覆盖最终判定', () => {
    // 审查行文常出现「若不修复 X 则结论：不通过」类假设，最终判定在末尾
    expect(parseReviewerVerdict('若不补充测试则结论：不通过。\n综上，结论：通过')).toBe('pass')
    expect(parseReviewerVerdict('初看结论：通过；但复核发现回归，最终结论：不通过')).toBe('fail')
  })
})
