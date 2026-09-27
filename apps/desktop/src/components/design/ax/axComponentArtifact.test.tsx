// @vitest-environment jsdom
/**
 * 升级产物的**渲染对账**：直接读仓库里真实的 `.pen/axiom.ax`（由 `design_import`
 * 从 `.pen/axiom.pen` 编译而来），走画布同一条渲染链，断言：
 *
 * 1. 产物**合法**（零校验错误）——升级后的稿不能是坏稿；
 * 2. `component` 节点渲染的是**真组件**（真实 DOM 类名），不是占位框；
 * 3. 真组件渲染出的内容与稿里那一块**同形**：工具卡的标题/字节数取自稿里的文案
 *    （证明 `axComponentMap` 反推的 call/result 有效），且**不落错误边界**——
 *    组件渲染失败会出 `ax-component-error`，这条断言就是把「升级坏了」挡在门外。
 *
 * 为什么必须有这条：升级面（59 处）是「稿 → 真组件」的语义跳跃，单测覆盖映射函数
 * 只能证明数据形状对，证明不了真实组件能吃下这份 props。这里用真实产物 + 真实组件
 * 把两端接起来验。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAxDocument } from '@/agent/design/axParser'
import type { AxDocument, AxNode } from '@/agent/design/axSchema'
import { mountAxPageElement } from './renderPageHost'

const artifactPath = resolve(import.meta.dirname, '../../../../../../.pen/axiom.ax')
const SOURCE = readFileSync(artifactPath, 'utf8')

/** 节点深度优先查找（页树里找第一个指定组件名的节点所在页）。 */
const pageWithComponent = (document: AxDocument, name: string): { id: string; node: AxNode } | null => {
  for (const page of document.pages) {
    const stack = [...page.tree]
    while (stack.length > 0) {
      const node = stack.shift() as AxNode
      if (node.kind === 'component' && node.name === name) return { id: page.id, node }
      stack.push(...(node.children ?? []))
    }
  }
  return null
}

describe('升级后的 .pen/axiom.ax', () => {
  const parsed = parseAxDocument(SOURCE)
  const document_ = parsed.document as AxDocument
  const componentNodes: AxNode[] = []
  document_.pages.forEach((page) => {
    const stack = [...page.tree]
    while (stack.length > 0) {
      const node = stack.shift() as AxNode
      if (node.kind === 'component') componentNodes.push(node)
      stack.push(...(node.children ?? []))
    }
  })

  it('产物合法，且组件实例全部落在本稿词汇表里', () => {
    expect(parsed.error).toBeNull()
    expect(parsed.diagnostics.filter((item) => item.level === 'error')).toEqual([])
    // 升级面必须非空——否则这条用例会「因为全都没升级」而假绿。
    expect(componentNodes.length).toBeGreaterThan(0)
    for (const node of componentNodes) {
      expect(Object.hasOwn(document_.components, node.name as string)).toBe(true)
    }
  })

  it('工具卡渲染真组件，标题与字节数取自稿里的文案', async () => {
    const hit = pageWithComponent(document_, 'ToolCallCard')
    expect(hit).not.toBeNull()
    const { mounted } = await mountAxPageElement(document_, hit!.id, 'light')
    expect(mounted).not.toBeNull()
    const scope = mounted!.element
    expect(scope.querySelector('[data-ax-component="ToolCallCard"]')).not.toBeNull()
    // 错误边界兜底：组件吃不下 props 时这里会出红框——出现即升级坏了。
    expect(scope.querySelector('.ax-component-error')).toBeNull()
    // 稿里那张卡是 `Read docs/implementation-plan.md` + `2.1 KB`：真组件按 args.path
    // 与 details.sizeBytes 渲染成同一行（标题同形是「反推的 props 有效」的直接证据）。
    expect(scope.textContent).toContain('Read docs/implementation-plan.md')
    expect(scope.textContent).toContain('2.1 KB')
    mounted!.dispose()
  })

  it('审批卡与消息操作行渲染真组件且不落错误边界', async () => {
    for (const name of ['ApprovalCard', 'MessageActions']) {
      const hit = pageWithComponent(document_, name)
      expect(hit, `${name} 在产物里没有实例`).not.toBeNull()
      const { mounted } = await mountAxPageElement(document_, hit!.id, 'light')
      expect(mounted, `${name} 所在页未能挂载`).not.toBeNull()
      const scope = mounted!.element
      expect(scope.querySelector(`[data-ax-component="${name}"]`), `${name} 未渲染成真组件`).not.toBeNull()
      expect(scope.querySelector('.ax-component-error'), `${name} 渲染落进了错误边界`).toBeNull()
      mounted!.dispose()
    }
  })
})
