// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findBuiltinSkillBody } from '@/agent/skills/builtinSkillBodies'
import {
  EMPTY_BUILTIN_PROMPT_OVERRIDES,
  getBuiltinPromptOverrides,
  saveBuiltinPromptOverrides,
} from '@/config/builtinPromptOverrides'
import { BuiltinPromptEditorDialog } from './BuiltinPromptEditorDialog'

const builtinPlanZhBody = (): string => findBuiltinSkillBody('plan')!['zh-CN'].body

const OVERRIDES_KEY = 'axiom.prompts.builtin-overrides.v1'

describe('BuiltinPromptEditorDialog', () => {
  afterEach(() => {
    window.localStorage.clear()
    saveBuiltinPromptOverrides(EMPTY_BUILTIN_PROMPT_OVERRIDES)
  })

  it('target 为 null 时不渲染', () => {
    const html = renderToStaticMarkup(createElement(BuiltinPromptEditorDialog, {
      target: null,
      onClose: () => undefined,
      onSaved: () => undefined,
    }))
    expect(html).toBe('')
  })

  it('技能目标默认渲染中文变体：描述字段 + 正文 + 无模板占位符提示', () => {
    const html = renderToStaticMarkup(createElement(BuiltinPromptEditorDialog, {
      target: { kind: 'skill', name: 'domain' },
      onClose: () => undefined,
      onSaved: () => undefined,
    }))
    expect(html).toContain('内置技能提示词：domain')
    expect(html).toContain('正文（load_skill 返回内容）')
    expect(html).toContain('描述（注入 &lt;available_skills&gt; 技能清单）')
    expect(html).toContain('# 目的')
    expect(html).not.toContain('System Prompt 模板')
  })

  it('子智能体目标渲染模板编辑与占位符说明，含「已自定义」badge（有覆写时）', () => {
    saveBuiltinPromptOverrides({
      version: 1,
      skills: {},
      subagents: { inspect: { 'zh-CN': { prompt: '自定义模板 {{SCOPE}}' } } },
    })
    const html = renderToStaticMarkup(createElement(BuiltinPromptEditorDialog, {
      target: { kind: 'subagent', subKind: 'inspect' },
      onClose: () => undefined,
      onSaved: () => undefined,
    }))
    expect(html).toContain('内置子智能体提示词：inspect')
    expect(html).toContain('System Prompt 模板')
    expect(html).toContain('自定义模板')
    expect(html).toContain('已自定义')
  })

  it('语言 tab 切换重填草稿；保存写入 per-language 覆写并回调；恢复默认清空覆写', () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const first = render(createElement(BuiltinPromptEditorDialog, {
      target: { kind: 'skill', name: 'domain' },
      onClose,
      onSaved,
    }))

    const body = () => document.querySelector('textarea') as HTMLTextAreaElement
    expect(body().value).toContain('# 目的')

    // 切英文 tab → 草稿重填为英文变体
    fireEvent.click(screen.getByRole('tab', { name: 'English' }))
    expect(body().value).toContain('# Purpose')

    // 编辑英文正文并保存 → 覆写按语言写入
    fireEvent.change(body(), { target: { value: '# Purpose\n自定义英文正文' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(window.localStorage.getItem(OVERRIDES_KEY)!)
    expect(stored.skills.domain.en.body).toBe('# Purpose\n自定义英文正文')
    expect(stored.skills.domain['zh-CN']).toBeUndefined()
    first.unmount()

    // 重新打开（默认中文 tab）：切到英文 tab 显示覆写，恢复默认后覆写清除、草稿回落内置值
    render(createElement(BuiltinPromptEditorDialog, {
      target: { kind: 'skill', name: 'domain' },
      onClose: () => undefined,
      onSaved: () => undefined,
    }))
    fireEvent.click(screen.getByRole('tab', { name: 'English' }))
    expect(body().value).toBe('# Purpose\n自定义英文正文')
    const restore = screen.getByRole('button', { name: '恢复默认' })
    expect((restore as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(restore)
    expect(getBuiltinPromptOverrides().skills.domain).toBeUndefined()
    expect(body().value).toContain('# Purpose')
  })

  it('保存时字段改回默认值等价移除覆写（diff 保存语义）', () => {
    saveBuiltinPromptOverrides({
      version: 1,
      skills: { plan: { 'zh-CN': { body: '覆写正文' } } },
      subagents: {},
    })
    render(createElement(BuiltinPromptEditorDialog, {
      target: { kind: 'skill', name: 'plan' },
      onClose: () => undefined,
      onSaved: () => undefined,
    }))
    const body = () => document.querySelector('textarea') as HTMLTextAreaElement
    expect(body().value).toBe('覆写正文')
    // 输入内置默认正文后保存 → 覆写条目整体移除
    fireEvent.change(body(), { target: { value: builtinPlanZhBody() } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(getBuiltinPromptOverrides().skills.plan).toBeUndefined()
  })
})
