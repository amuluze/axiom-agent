/**
 * `design_import` 工具测试（docs/ax-format.md §6 P1 的产品入口）：
 * ① 产物是**合法 `.ax`**（经校验器零错误）；② 写入必经审批租赁、目标已存在由宿主拒绝；
 * ③ 失败路径显式（解析失败不写盘）；④ 未迁移字段逐条回报（不静默）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import type { DesignDocumentContent } from '@/platform/designDocument'
import type { JsonValue } from '@/agent/core/types'
import { parseAxDocument } from '@/agent/design/axParser'
import { createDesignImportTool } from './designImportTool'

const PEN_SOURCE = JSON.stringify({
  version: '2.18',
  variables: { 'bg-main': { type: 'color', value: '#161514' }, 'text-md': { type: 'number', value: 13 } },
  children: [
    {
      type: 'frame',
      id: 'page-1',
      name: '会话',
      width: 1180,
      height: 780,
      layout: 'horizontal',
      fill: '$bg-main',
      children: [
        { type: 'text', id: 't-1', content: 'hello', fontSize: '$text-md', textGrowth: 'fixed-width', lineHeight: 1.5 },
        { type: 'rectangle', id: 'r-1', x: 10, y: 10, width: 40, height: 40, layoutPosition: 'absolute', opacity: 0.5 },
      ],
    },
  ],
})

const penContent: DesignDocumentContent = {
  contentBase64: Buffer.from(PEN_SOURCE, 'utf-8').toString('base64'),
  sha256: 'a'.repeat(64),
  sizeBytes: PEN_SOURCE.length,
  modifiedMs: null,
  unchanged: false,
}

const harness = (content: DesignDocumentContent | Error = penContent) => {
  const createTextFile = vi.fn(async (path: string, text: string) => ({
    path,
    sha256: 'f'.repeat(64),
    sizeBytes: new TextEncoder().encode(text).length,
  }))
  const readDocument = vi.fn(async (path: string) => {
    if (content instanceof Error) throw content
    if (path === '.pen/axiom.pen') return content
    throw new Error('not found')
  })
  const environment = {
    design: { readDocument },
    workspace: { createTextFile },
  } as unknown as AgentEnvironment
  return { tool: createDesignImportTool(environment), createTextFile, readDocument }
}

const run = (tool: ReturnType<typeof createDesignImportTool>, input: JsonValue, lease?: string) =>
  tool.execute(input, { signal: new AbortController().signal, ...(lease ? { approvalLease: lease } : {}) } as never)

describe('design_import', () => {
  it('把 .pen 编译为合法 .ax 并经审批租约落盘', async () => {
    const { tool, createTextFile } = harness()
    const result = await run(tool, { source: '.pen/axiom.pen', target: '.pen/axiom.ax' }, 'lease-1')
    expect(createTextFile).toHaveBeenCalledTimes(1)
    const [path, text, lease] = createTextFile.mock.calls[0] as unknown as [string, string, string]
    expect(path).toBe('.pen/axiom.ax')
    expect(lease).toBe('lease-1')
    const validated = parseAxDocument(text)
    expect(validated.error).toBeNull()
    expect(validated.diagnostics.filter((item) => item.level === 'error')).toEqual([])
    expect(validated.document?.pages).toHaveLength(1)
    expect(result.content).toContain('已编译')
    expect((result.details as { compiled: boolean }).compiled).toBe(true)
  })

  it('租约绑定编译产物：approvalLeaseInput 给出 { path, content }，execute 落盘同一串字节且不重复读稿', async () => {
    const { tool, createTextFile, readDocument } = harness()
    const input = { source: '.pen/axiom.pen', target: '.pen/axiom.ax' }

    const bound = await tool.approvalLeaseInput?.(input) as { path: string; content: string }
    expect(bound.path).toBe('.pen/axiom.ax')
    // Rust 侧按 create_workspace_file 的 canonical_input 计价 digest：
    // 绑定输入必须恰为 { path, content }，否则租约无法被写通道消费。
    expect(Object.keys(bound).sort()).toEqual(['content', 'path'])
    expect(readDocument).toHaveBeenCalledTimes(1)

    await run(tool, input, 'lease-1')
    const [path, text] = createTextFile.mock.calls[0] as unknown as [string, string, string]
    expect(path).toBe('.pen/axiom.ax')
    // 批准什么就写什么：落盘字节必须与租约绑定的字节完全一致。
    expect(text).toBe(bound.content)
    expect(readDocument).toHaveBeenCalledTimes(1)
  })

  it('源稿解析失败时 approvalLeaseInput 抛出（审批前 fail-closed，不弹审批卡也不落盘）', async () => {
    const broken = { ...penContent, contentBase64: Buffer.from('not json', 'utf-8').toString('base64') }
    const { tool, createTextFile } = harness(broken)
    await expect(tool.approvalLeaseInput?.({ source: '.pen/axiom.pen', target: '.pen/axiom.ax' }))
      .rejects.toThrow(/cannot compile/)
    expect(createTextFile).not.toHaveBeenCalled()
  })

  it('未迁移字段逐条回报（不静默）', async () => {
    const { tool } = harness()
    const result = await run(tool, { source: '.pen/axiom.pen', target: '.pen/axiom.ax' }, 'lease-1')
    // 该 fixture 带 opacity（.ax 暂不接受）→ 必须出现在清单里。
    expect(result.content).toContain('未迁移字段')
    expect(result.content).toContain('opacity')
  })

  it('无审批租约即拒绝（写路径不可绕过审批）', async () => {
    const { tool, createTextFile } = harness()
    await expect(run(tool, { source: '.pen/axiom.pen', target: '.pen/axiom.ax' }))
      .rejects.toThrow(/approval lease/)
    expect(createTextFile).not.toHaveBeenCalled()
  })

  it('源稿解析失败时不写盘，并显式说明原因', async () => {
    const broken = { ...penContent, contentBase64: Buffer.from('not json', 'utf-8').toString('base64') }
    const { tool, createTextFile } = harness(broken)
    const result = await run(tool, { source: '.pen/axiom.pen', target: '.pen/axiom.ax' }, 'lease-1')
    expect(result.content).toContain('cannot compile')
    expect(createTextFile).not.toHaveBeenCalled()
  })

  it('路径契约：必须 .pen 源 + .ax 目标 + 二者不同', () => {
    const { tool } = harness()
    const check = (input: JsonValue) => tool.validate?.(input)
    expect(check({ source: '.pen/a.pen', target: '.pen/a.ax' })?.ok).toBe(true)
    expect(check({ source: '.pen/a.ax', target: '.pen/b.ax' })?.ok).toBe(false)
    expect(check({ source: '.pen/a.pen', target: '.pen/b.pen' })?.ok).toBe(false)
    expect(check({ source: '.pen/a.pen', target: '.pen/a.pen' })?.ok).toBe(false)
    expect(check({ source: '../a.pen', target: '.pen/b.ax' })?.ok).toBe(false)
  })
})
