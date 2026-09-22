import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SUBAGENT_PROMPT_TEMPLATES,
  getBuiltinSubAgentPromptPreview,
  getBuiltinSubAgentPromptTemplate,
} from './promptCatalog'

describe('promptCatalog（设置页查看/编辑入口）', () => {
  it('四类子智能体 × 双语言均有非空模板，段头语言正确', () => {
    for (const kind of ['explore', 'inspect', 'examine', 'review'] as const) {
      expect(getBuiltinSubAgentPromptTemplate(kind, 'zh-CN')).toContain('# 角色')
      expect(getBuiltinSubAgentPromptTemplate(kind, 'en')).toContain('# Role')
      expect(getBuiltinSubAgentPromptTemplate(kind, 'en').length).toBeGreaterThan(0)
    }
  })

  it('en 模板为英文骨架（不含中文段头），审查类含 {{TOOLS}}/{{FORBIDDEN}} 占位符', () => {
    expect(getBuiltinSubAgentPromptTemplate('explore', 'en')).toContain('# Role')
    expect(getBuiltinSubAgentPromptTemplate('inspect', 'en')).toContain('{{TOOLS}}')
    expect(getBuiltinSubAgentPromptTemplate('examine', 'en')).toContain('{{FORBIDDEN}}')
    expect(getBuiltinSubAgentPromptTemplate('review', 'en')).not.toContain('# 角色')
    // explore 的工具段为模板内联文本，无 {{TOOLS}} 占位符
    expect(getBuiltinSubAgentPromptTemplate('explore', 'zh-CN')).not.toContain('{{TOOLS}}')
  })

  it('preview 渲染掉全部占位符；传入覆写模板时按覆写渲染', () => {
    const preview = getBuiltinSubAgentPromptPreview('explore', 'zh-CN')
    expect(preview).not.toContain('{{')
    expect(preview).toContain('# 角色')
    const overridden = getBuiltinSubAgentPromptPreview('inspect', 'zh-CN', '自定义 {{SCOPE}}')
    expect(overridden).toContain('自定义')
    expect(overridden).not.toContain('{{')
  })

  it('模板目录与 builder 同源（引用相等），杜绝第二份静态拷贝漂移', () => {
    // explore 的模板直接来自 buildExplorePrompt 的导出常量
    expect(BUILTIN_SUBAGENT_PROMPT_TEMPLATES.explore['zh-CN']).toContain('# 工作流')
  })
})
