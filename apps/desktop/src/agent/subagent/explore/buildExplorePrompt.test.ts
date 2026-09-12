import { describe, expect, it } from 'vitest'
import { buildExploreSystemPrompt } from './buildExplorePrompt'

describe('buildExploreSystemPrompt', () => {
  it('无 budget 时使用默认预算文案', () => {
    const prompt = buildExploreSystemPrompt({})
    expect(prompt).toContain('# 预算')
    expect(prompt).toContain('固定的轮次与工具调用预算')
  })

  it('传入 budget 时 prompt 含具体数值与字节口径', () => {
    const prompt = buildExploreSystemPrompt({
      budget: {
        maxTurns: 16,
        maxToolCalls: 48,
        maxMessageBytes: 512 * 1024,
        maxInlineToolResultBytes: 64 * 1024,
      },
    })
    expect(prompt).toContain('16 轮模型请求（每轮可包含多个工具调用）')
    expect(prompt).not.toContain('48 次工具调用')
    expect(prompt).toContain('512 KiB')
    expect(prompt).toContain('64 KiB')
    // 指导模型感知字节累积与收口策略
    expect(prompt).toContain('完整对话历史')
    expect(prompt).toContain('8 次满额大文件读取就会用尽消息字节预算')
    expect(prompt).toContain('一次发起多个只读调用')
    expect(prompt).toContain('grep/find 精准定位')
  })

  it('输出段约束总结体积，避免大段回流父上下文', () => {
    const prompt = buildExploreSystemPrompt({})
    expect(prompt).toContain('总结正文控制在 4 KiB（约 1300 汉字）以内')
    expect(prompt).toContain('path:line')
  })

  it('传入 contextWindow 时 prompt 告知模型窗口边界；不传时无该句', () => {
    const withWindow = buildExploreSystemPrompt({ contextWindow: 100_000 })
    expect(withWindow).toContain('你的上下文窗口为 100000 tokens')
    const withoutWindow = buildExploreSystemPrompt({})
    expect(withoutWindow).not.toContain('上下文窗口为')
  })

  it('scope 与 budget 同时存在时两段都渲染', () => {
    const prompt = buildExploreSystemPrompt({
      scope: ['src', 'lib'],
      budget: {
        maxTurns: 10,
        maxToolCalls: 30,
        maxMessageBytes: 256 * 1024,
        maxInlineToolResultBytes: 32 * 1024,
      },
    })
    // scope 段
    expect(prompt).toContain('- src')
    expect(prompt).toContain('- lib')
    expect(prompt).toContain('范围外的读取会失败')
    // budget 段
    expect(prompt).toContain('10 轮模型请求')
    expect(prompt).toContain('256 KiB')
    expect(prompt).toContain('32 KiB')
  })

  it('prompt 始终包含角色、工具、工作流、输出、禁止段', () => {
    const prompt = buildExploreSystemPrompt({})
    expect(prompt).toContain('# 角色')
    expect(prompt).toContain('# 允许的工具')
    expect(prompt).toContain('read')
    expect(prompt).toContain('# 工作流')
    expect(prompt).toContain('# 输出')
    expect(prompt).toContain('# 禁止')
  })

  it('传入 workspaceRoot 时范围段告知解析根；不传时不渲染', () => {
    const withRoot = buildExploreSystemPrompt({ workspaceRoot: '/Users/amu/Desktop/github/axiom' })
    expect(withRoot).toContain('授权工作区根目录：/Users/amu/Desktop/github/axiom')
    expect(withRoot).toContain('scope 相对路径在此目录内解析')
    const withoutRoot = buildExploreSystemPrompt({})
    expect(withoutRoot).not.toContain('授权工作区根目录')
  })

  it('scope 与 workspaceRoot 同时存在时根目录行与范围清单都渲染', () => {
    const prompt = buildExploreSystemPrompt({
      scope: ['src', 'lib'],
      workspaceRoot: '/Users/amu/Desktop/github/axiom',
    })
    expect(prompt).toContain('授权工作区根目录：/Users/amu/Desktop/github/axiom')
    expect(prompt).toContain('- src')
    expect(prompt).toContain('- lib')
    expect(prompt).toContain('范围外的读取会失败')
  })

  it('workspaceRoot 存在而 scope 为空时仍渲染根目录行', () => {
    const prompt = buildExploreSystemPrompt({ workspaceRoot: '/Users/amu/Desktop/github/axiom' })
    expect(prompt).toContain('授权工作区根目录')
    expect(prompt).toContain('允许访问整个已授权工作区')
  })
})
