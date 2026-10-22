import type { AgentToolResult } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { axComponentsUsed, truncateToByteBudget } from '@/agent/design/designQueryProjection'
import type { AxModeContext } from '@/agent/design/designQueryContext'
import { extractComponentUsage } from '@/agent/design/implementationUsage'
import type { WorkspaceEntry } from '@/platform/workspace'

/**
 * `.ax` reconcile 模式（E2 切片）：设计稿组件清单 × 实现源码实际使用的双向 diff。
 * 只读工作区文件；词法提取为 advisory，不产生 fail/warn 判定。
 */

/** mode=reconcile 的实现文件收集上限：递归深度、文件数、单目录 list 上限。
 * 文件数上限按「真实单仓前端源码（含测试）可达数百文件」定档——太小会让
 * 整目录对账必然触顶、missingInImplementation 对未扫文件失真（本仓实测
 * apps/desktop/src 含测试 578 个 .ts/.tsx）。触顶时报告 fileCapReached=true，
 * 模型按提示词收窄 roots 分批重跑。 */
const RECONCILE_MAX_DEPTH = 6
const RECONCILE_MAX_FILES = 800
const RECONCILE_LIST_LIMIT = 1000
/** 目录递归时跳过的非实现目录（构建产物/依赖/测试快照）。 */
const RECONCILE_SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'coverage', 'artifacts'])

/**
 * mode=reconcile 的实现文件收集：根路径为 .ts/.tsx 文件时直接收录，否则按目录
 * 递归（BFS）收集 .ts/.tsx。跳过的目录与触及的文件上限都在结果里显式给出——
 * 对账报告的结论只对「实际扫过的文件集」负责，不静默缩窄。
 */
export const collectReconcileFiles = async (
  environment: AgentEnvironment,
  roots: readonly string[],
): Promise<{ files: string[]; directoriesSkipped: string[]; fileCapReached: boolean }> => {
  const files: string[] = []
  const directoriesSkipped: string[] = []
  const seen = new Set<string>()
  let fileCapReached = false
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (fileCapReached || depth > RECONCILE_MAX_DEPTH) return
    let entries: WorkspaceEntry[]
    try {
      entries = (await environment.workspace.list(directory, RECONCILE_LIST_LIMIT)).entries
    } catch {
      directoriesSkipped.push(directory)
      return
    }
    for (const entry of entries) {
      if (fileCapReached) return
      if (entry.kind === 'directory') {
        if (RECONCILE_SKIP_DIRS.has(entry.name)) {
          directoriesSkipped.push(entry.path)
          continue
        }
        await visit(entry.path, depth + 1)
      } else if (/\.(ts|tsx|js|jsx|vue)$/.test(entry.name) && !seen.has(entry.path)) {
        if (files.length >= RECONCILE_MAX_FILES) {
          fileCapReached = true
          return
        }
        seen.add(entry.path)
        files.push(entry.path)
      }
    }
  }
  for (const root of roots) {
    if (/\.(ts|tsx|js|jsx|vue)$/.test(root)) {
      if (!seen.has(root)) {
        seen.add(root)
        files.push(root)
      }
      continue
    }
    await visit(root, 0)
  }
  return { files, directoriesSkipped, fileCapReached }
}

/** ── .ax reconcile：设计 ↔ 实现结构对账（docs/ax-format.md §4.6.4）────────── */
// 稿侧组件清单 × 实现源码的实际使用，双向 diff：missingInImplementation
// ＝稿有实无（漏实现）；extraInImplementation＝实有稿无（设计外使用，供
// 反向更新设计稿参考）。词法提取（advisory），与 tokenParity 同口径不产生 fail。
export const executeAxReconcileMode = async (
  context: AxModeContext,
  environment: AgentEnvironment,
  roots: readonly string[],
): Promise<AgentToolResult> => {
  const { axDoc, inventory, maxBytes } = context
  const collected = await collectReconcileFiles(environment, roots)
  const registryNames = inventory.map((entry) => entry.name)
  // 文档内 symbol 名与注册表同名视为同一类「组件引用」——codegen 把 symbol 发射为
  // 同文件局部组件，impl 侧用 PascalCase import / JSX 开标签时名字会与 symbol 名字
  // 完全一致。只把注册表名传进 extractComponentUsage 会让含 symbol 的稿被误报
  // 「每个 symbol 都漏实现」——这里把两类名字合并。
  const symbolNames = Object.keys(axDoc.symbols ?? {})
  const acceptableNames = [...registryNames, ...symbolNames]
  // 实现侧：逐文件提取（读失败/截断标注后照常计入其余文件），按组件合并。
  const implUsage = new Map<string, { files: string[]; imports: number; jsxUses: number }>()
  const readFailures: string[] = []
  const truncatedFiles: string[] = []
  for (const file of collected.files) {
    let content: string
    try {
      const read = await environment.workspace.readText(file)
      content = read.content
      if (read.truncated) truncatedFiles.push(file)
    } catch (error) {
      readFailures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const [name, usage] of extractComponentUsage(content, acceptableNames)) {
      const existing = implUsage.get(name)
      if (existing) {
        existing.files.push(file)
        existing.imports += usage.imports
        existing.jsxUses += usage.jsxUses
      } else {
        implUsage.set(name, { files: [file], imports: usage.imports, jsxUses: usage.jsxUses })
      }
    }
  }
  // 稿侧：组件 → 用到它的页（含 slot 内的使用）。symbol 实例也是 component 节点
  // （校验器统一走「name 命中 symbols 或 components」），故 `axComponentsUsed` 同时
  // 含两类——`axSymbolsUsed` 单独把它们摘出做「symbol 验证」段。
  const designUsage = new Map<string, string[]>()
  for (const page of axDoc.pages) {
    for (const name of axComponentsUsed(page.tree, [])) {
      const list = designUsage.get(name)
      if (list) list.push(page.name ?? page.id)
      else designUsage.set(name, [page.name ?? page.id])
    }
  }
  // 在用口径：JSX 使用 > 0（import 了未使用是死导入，不构成「实现在用」）。
  const implUsed: string[] = [...implUsage.entries()]
    .filter(([, usage]) => usage.jsxUses > 0)
    .map(([name]) => name)
  const implUsedSet = new Set(implUsed)
  // missingInImplementation：稿有 / impl 未用，**且不是 symbol**——symbol 默认不要求
  // impl 必有同名 import（codegen 把它发射为局部组件，符号表可能在同文件内），
  // 避免双向误报。symbol 单独走 payload.symbols 段，由 present 字段披露真实状态。
  const missingInImplementation = [...designUsage.entries()]
    .filter(([name]) => !implUsedSet.has(name) && !symbolNames.includes(name))
    .map(([component, pages]) => ({ component, pages }))
  const extraInImplementation = implUsed
    .filter((name) => !designUsage.has(name))
    .sort()
    .flatMap((component) => {
      const usage = implUsage.get(component)
      // implUsed 由 implUsage 派生（jsxUses>0 的键），必然命中；收窄只为类型系统。
      if (!usage) return []
      return [{ component, jsxUses: usage.jsxUses, files: usage.files.slice(0, 8) }]
    })
  const matched = [...designUsage.entries()]
    .filter(([name]) => implUsedSet.has(name) && !symbolNames.includes(name))
    .flatMap(([component, pages]) => {
      const usage = implUsage.get(component)
      if (!usage) return []
      return [{
        component,
        pages: pages.length,
        files: usage.files.length,
        jsxUses: usage.jsxUses,
        imports: usage.imports,
      }]
    })
    .sort((left, right) => left.component.localeCompare(right.component))
  // symbol 验证段：present = impl 侧是否已识别（jsxUses > 0），与 summary 的
  // symbols 段同形——告诉模型「KpiCard 在 impl 三个文件里已实现」而不是默认「漏实现」。
  const symbolsReport = symbolNames.map((name) => {
    const usage = implUsage.get(name)
    return {
      name,
      present: usage !== undefined && usage.jsxUses > 0,
      files: usage ? usage.files.slice(0, 8) : [],
    }
  })
  const payload = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'reconcile' as const,
    strictGate: { command: 'npm run design:verify -- --project <workspace>', config: '.axiom/design/verification.json', baselineUpdate: '--update-baseline', note: '独立 CLI 校验真实导入、props/$bind、路由、节点覆盖、明确布局与同浏览器基线；本报告未执行该门禁。' },
    note: 'advisory：missingInImplementation 为稿有实无（漏实现）；extraInImplementation 为实有稿无（设计外使用，可据此反向补设计稿）。在用口径 = 实现里出现该组件的 JSX 开标签。',
    implementation: {
      roots,
      filesScanned: collected.files.length,
      ...(truncatedFiles.length > 0 ? { truncatedFiles } : {}),
      ...(readFailures.length > 0 ? { readFailures: readFailures.slice(0, 10) } : {}),
      ...(collected.directoriesSkipped.length > 0 ? { directoriesSkipped: collected.directoriesSkipped.slice(0, 10) } : {}),
      fileCapReached: collected.fileCapReached,
    },
    design: {
      pages: axDoc.pages.map((page, index) => ({
        index: index + 1,
        name: page.name ?? page.id,
        components: axComponentsUsed(page.tree, []),
      })),
      componentsUsed: [...designUsage.keys()].sort(),
    },
    missingInImplementation,
    extraInImplementation,
    matched,
    ...(symbolsReport.length > 0 ? { symbols: symbolsReport } : {}),
  }
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
  return {
    content,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'reconcile',
      filesScanned: collected.files.length,
      missing: missingInImplementation.length,
      extra: extraInImplementation.length,
      matched: matched.length,
      truncated,
    },
  }
}
