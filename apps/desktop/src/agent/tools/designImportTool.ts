/**
 * `design_import`：把 `.pen` 设计稿编译成自有格式 `.ax`（docs/ax-format.md §6 P1 的产品入口）。
 *
 * 为什么是工具而不是 UI 按钮：方案的作者通道是「LLM + 既有写工具链」（§1.3 决策 3），
 * 而 `.pen → .ax` 是**一次性迁移**——转换需要读整份文件（1.4MB 级）再产出完整 `.ax`，
 * 模型不可能把这份内容搬进上下文再手写；由工具在宿主侧做转换、经审批落盘，模型只需
 * 说「把 .pen/axiom.pen 迁到 .pen/axiom.ax」。
 *
 * 信任模型与 `write` 一致：`requiresApproval`（审批卡片 category 取 `workspace-write`，
 * 卡片文案与写工具同款）+ `createTextFile`（**已存在的目标一律拒绝**，不会覆盖用户稿件）
 * + Rust 侧 `design_document_write_limit` 的 8MiB 上限（`.ax` 在 P0 已纳入该白名单）。
 *
 * 产物语义：primitive 1:1 迁移；稿里 `ref` 到 reusable 组件的实例按 `axComponentMap`
 * 升级为 `.ax` 的 `component` 节点（真组件渲染；未登记的组件留在 primitive 层并带原因
 * 记账）。返回的 `warnings` 逐条列出未迁移字段、`components` 列出升级/未升级的实例计数
 * ——**不静默**，模型据此决定是否再迭代。
 */
import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { parsePenDocument } from '@/agent/design/penParser'
import { AX_FORMAT_VERSION, type AxDocument } from '@/agent/design/axSchema'
import { serializeAxDocument } from '@/agent/design/axParser'
import { importPenDocument, type ImportPenResult } from '@/agent/design/importPen'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath } from './workspaceToolUtils'

/** 与 Rust 侧 design_document_write_limit 同口径（8MiB）。 */
const MAX_DESIGN_DOCUMENT_BYTES = 8 * 1024 * 1024

const byteLength = (text: string): number => new TextEncoder().encode(text).length

const isPenPath = (path: string): boolean => /\.pen$/i.test(path)
const isAxPath = (path: string): boolean => /\.ax$/i.test(path)

interface DesignImportInput {
  source: string
  target: string
}

const asImportInput = (input: JsonValue): DesignImportInput => {
  if (!isJsonObject(input) || typeof input.source !== 'string' || typeof input.target !== 'string') {
    throw new Error('Invalid design_import arguments.')
  }
  return { source: input.source, target: input.target }
}

/** `.ax` 的展示名（页面名/文件名派生）：取自源文件名，去掉 `.pen` 后缀。 */
const nameOf = (source: string): string => {
  const base = source.split('/').pop() ?? source
  return base.replace(/\.pen$/i, '')
}

export interface CompiledAxDocument {
  document: AxDocument
  /** 序列化后的 `.ax` 字节（即审批绑定与落盘共用的内容）。 */
  content: string
  warnings: ImportPenResult['warnings']
  /** 组件实例升级对账（升级/未升级各带计数与原因）。 */
  components: ImportPenResult['components']
}

/** 编译结果：失败时带着可读原因（审批期抛出拒绝，执行期原样回报给模型）。 */
export type CompileOutcome =
  | { ok: true; compiled: CompiledAxDocument }
  | { ok: false; message: string }

/**
 * 审批期编译产物，按环境实例缓存（每个会话一个环境，条目随环境回收）。
 * 审批卡批准的是「编译出的那串字节」，故 approvalLeaseInput 与 execute 必须复用同一次
 * 编译：若 execute 重新编译，源稿在审批期间被改动就会造成「批准 A、写 B」（租约按字节
 * 计价，重编译必然与已签发的 digest 失配）。
 */
const approvedCompilations = new WeakMap<
  AgentEnvironment,
  { key: string; compiled: CompiledAxDocument }
>()

const compilationKey = (source: string, target: string): string => `${source}\u0000${target}`

/** 读源稿 → 解析 → 导入 → 序列化。失败不抛出，由调用方决定报错口径。 */
const compilePenToAx = async (
  environment: AgentEnvironment,
  source: string,
  target: string,
): Promise<CompileOutcome> => {
  const document = await environment.design.readDocument(source)
  const binary = typeof atob === 'function'
    ? atob(document.contentBase64)
    : Buffer.from(document.contentBase64, 'base64').toString('binary')
  const text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))

  const parsed = parsePenDocument(text, source)
  if (!parsed.document) {
    return {
      ok: false,
      message: `design_import: cannot compile ${source}: ${parsed.error ?? 'parse failed'}`,
    }
  }
  const { document: axDocument, warnings, components } = importPenDocument(parsed.document, nameOf(source))
  const content = serializeAxDocument(axDocument)
  if (byteLength(content) > MAX_DESIGN_DOCUMENT_BYTES) {
    return {
      ok: false,
      message: `design_import: compiled ${target} exceeds the 8 MiB design document limit; nothing was written.`,
    }
  }
  return { ok: true, compiled: { document: axDocument, content, warnings, components } }
}

export const createDesignImportTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'design_import',
  label: 'design_import',
  promptSnippet: '把 .pen 设计稿编译为自有格式 .ax（画布评审 + 设计→代码都以 .ax 为准）。',
  promptGuidelines: [
    'source 为工作区内 .pen 路径，target 为**尚不存在**的 .ax 路径（已存在会被拒绝，不会覆盖）。',
    '这是一次性迁移：产物是完整 .ax（原语 1:1 + 能对上的组件实例升级为 component 节点）。',
    '返回的组件实例计数与未迁移字段清单说明「哪些块已是实现词汇、哪些还没」——需要补齐时再迭代。',
    '迁移后以 .ax 为准继续迭代（design_query 读 .ax 会给出解析后的规格与组件清单）。',
  ],
  // v2：租约按 create_workspace_file 口径绑定编译产物（approvalLeaseInput）——v1 的租约
  // 绑定模型输入 {source,target}，与写通道消费侧失配，导致该工具从未能落盘。
  // v3：产物契约扩展——ref 实例按 axComponentMap 升级为 `component` 节点，返回体新增
  // 升级/未升级组件实例的计数（details.upgradedComponents / deferredComponents）。
  runtimeVersion: '3',
  // 新建文件且拒绝已存在目标：重放无害（与 write 同口径）。
  recoveryPolicy: 'idempotent',
  executionMode: 'sequential',
  requiresApproval: true,
  idempotencyKey: (input) => {
    const { source, target } = asImportInput(input)
    return `design_import:${source}:${target}`
  },
  description:
    'Compile a .pen design document into the native .ax format as a NEW file (existing targets are refused). '
    + `The result is a complete .ax document (up to 8 MiB, ax@${AX_FORMAT_VERSION}); primitives map 1:1, ref instances of mapped reusable components upgrade to real \`component\` nodes, and unmigrated fields plus per-component instance counts are reported back. `
    + 'Each invocation requires an approval lease and is recorded in the audit log.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Workspace-relative .pen path to compile.',
      },
      target: {
        type: 'string',
        description: 'Workspace-relative .ax path to create (must not exist).',
      },
    },
    required: ['source', 'target'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['source', 'target'])) {
      return { ok: false, error: 'Arguments must be an object with only source and target.' }
    }
    if (typeof input.source !== 'string' || !isPenPath(input.source) || !isSafeRelativePath(input.source, false)) {
      return { ok: false, error: 'source must be a workspace-relative path ending in .pen.' }
    }
    if (typeof input.target !== 'string' || !isAxPath(input.target) || !isSafeRelativePath(input.target, false)) {
      return { ok: false, error: 'target must be a workspace-relative path ending in .ax.' }
    }
    if (input.source === input.target) {
      return { ok: false, error: 'source and target must differ.' }
    }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const { source, target } = asImportInput(input)
    return {
      category: 'workspace-write',
      title: `Compile ${source} to ${target}?`,
      description: 'Axiom will create a new .ax design document from the .pen source; existing targets are refused.',
      path: target,
      preview: `${source} → ${target}`,
    }
  },
  auditArguments: (input) => {
    const { source, target } = asImportInput(input)
    return { source, target }
  },
  /**
   * 租约绑定输入：落盘走 create_workspace_file，Rust 按该原生命令的 canonical_input
   * 计价 digest，而本工具落盘的是编译产物——必须给出 `{ path: target, content }`，
   * 否则租约永远无法被写通道消费（实测报 "approval lease does not match"）。
   * 编译失败即抛出：审批前 fail-closed 拒绝，不带着绑定不上的租约进入执行。
   */
  approvalLeaseInput: async (input) => {
    const { source, target } = asImportInput(input)
    const outcome = await compilePenToAx(environment, source, target)
    if (!outcome.ok) throw new Error(outcome.message)
    approvedCompilations.set(environment, {
      key: compilationKey(source, target),
      compiled: outcome.compiled,
    })
    return { path: target, content: outcome.compiled.content }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const { source, target } = asImportInput(input)
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!context.approvalLease) throw new Error('Missing workspace approval lease.')

    const key = compilationKey(source, target)
    // 复用审批期编译的字节（批准什么就写什么）；无缓存只在恢复重放等直接执行的路径出现。
    // 一次性消费：条目只服务紧随其后的这一次执行，陈旧条目不会被后续执行复用。
    const cached = approvedCompilations.get(environment)
    approvedCompilations.delete(environment)
    const outcome = cached?.key === key
      ? { ok: true as const, compiled: cached.compiled }
      : await compilePenToAx(environment, source, target)
    if (!outcome.ok) {
      return {
        content: outcome.message,
        details: { source, target, compiled: false },
      }
    }
    const { document: axDocument, content: serialized, warnings, components } = outcome.compiled
    const written = await environment.workspace.createTextFile(target, serialized, context.approvalLease)
    const nodeCount = axDocument.pages.reduce((total, page) => total + page.tree.length, 0)
    const unmigrated = new Set<string>()
    for (const warning of warnings) {
      const match = /未迁移字段 `([^`]+)`/.exec(warning.message)
      if (match?.[1]) unmigrated.add(match[1]!)
    }
    // 组件实例升级对账：升上去的（真组件渲染）与留在 primitive 的各带计数与原因——
    // 模型据此知道哪些块已经是实现词汇、哪些还需要补词表才能升级。
    const upgraded = components.filter((item) => item.component !== undefined)
    const deferred = components.filter((item) => item.component === undefined)
    const upgradedTotal = upgraded.reduce((total, item) => total + item.count, 0)
    const deferredTotal = deferred.reduce((total, item) => total + item.count, 0)
    const replacedTexts = upgraded.reduce((total, item) => total + (item.replacedTexts ?? 0), 0)
    return {
      content: [
        `design_import: 已编译 ${source} → ${target}（ax@${AX_FORMAT_VERSION}）。`,
        `页数 ${axDocument.pages.length} · 顶层节点 ${nodeCount} · 字节 ${written.sizeBytes}`,
        upgradedTotal > 0
          ? `组件实例升级 ${upgradedTotal} 处：${upgraded.map((item) => `${item.component}×${item.count}`).join('、')}`
          : '组件实例升级：无',
        replacedTexts > 0
          ? `升级后的实例内容由实现侧提供：${replacedTexts} 条稿内文案未进稿（真组件按 props/fixture 渲染）`
          : '升级未丢失稿内文案（props 已完整表达实例内容）',
        deferredTotal > 0
          ? `未升级组件实例 ${deferredTotal} 处（保持 primitive 展开）：${deferred.map((item) => `${item.name}×${item.count}`).join('、')}`
          : '未升级组件实例：无',
        unmigrated.size > 0
          ? `未迁移字段（如需补齐请再迭代）：${[...unmigrated].sort().join('、')}`
          : '未迁移字段：无',
        '画布需重新扫描（设计视图工具栏「刷新」）后该文件才会出现在文件栏。',
      ].join('\n'),
      details: {
        source,
        target,
        compiled: true,
        sha256: written.sha256,
        pages: axDocument.pages.length,
        unmigratedFields: [...unmigrated].sort() as unknown as JsonValue,
        upgradedComponents: upgraded.map((item) => `${item.component}×${item.count}`) as unknown as JsonValue,
        deferredComponents: deferred.map((item) => `${item.name}×${item.count}`) as unknown as JsonValue,
        replacedInstanceTexts: replacedTexts as unknown as JsonValue,
      },
    }
  },
})
