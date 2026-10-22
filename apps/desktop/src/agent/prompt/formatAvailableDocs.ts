import type { ProjectDocInventory } from './projectDocs'
import { MAX_DOC_ROOT_ENTRIES } from './projectDocs'

/**
 * 把项目文档索引格式化为 `<available_docs>` 子块，作为 `# 项目上下文` 段的
 * 子块注入（对齐 `<available_skills>` 的格式与预算策略）。
 *
 * 约束：
 * - role、path、title 必须 XML escape；
 * - 只注入索引（role + 相对路径 + 标题），不注入正文；
 * - 注入提示词的索引总字节有 32 KiB 硬预算：按索引顺序（根级 DESIGN.md →
 *   受管目录）装入，剩余者跳过并计数；
 * - 空清单返回 `{ section: null }`；全部条目因预算省略时仍输出最小提示（至少让模型
 *   知道文档存在），只有连最小提示都超预算才返回 null。
 */

/** 注入提示词的文档索引总字节硬上限（与 AVAILABLE_SKILLS_METADATA_BUDGET_BYTES 对齐）。 */
export const DOCS_METADATA_BUDGET_BYTES = 32 * 1024

const escapeXml = (value: string): string =>
  value.replace(/[<>&"']/gu, (char) => {
    switch (char) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '"': return '&quot;'
      default: return '&apos;'
    }
  })

export interface FormattedAvailableDocs {
  /** 无可注入文档时返回 null（调用方不生成子块）。 */
  section: string | null
  /** 因 32 KiB 预算被省略的文档数。 */
  omittedCount: number
}

const diagnosticMessage = (diagnostic: ProjectDocInventory['diagnostics'][number]): string => {
  switch (diagnostic.code) {
    case 'root_list_failed':
      return '受管目录列举失败，其中的文档未列入索引；请勿据此认为该目录没有文档，稍后用 ls 复查'
    case 'root_list_truncated':
      return '受管目录清单被系统截断，可能还有未列入索引的文档；用 ls 复查目录实况'
    case 'root_entry_limit':
      return `另有 ${diagnostic.affectedCount} 个文档因单目录条目上限（${MAX_DOC_ROOT_ENTRIES}）未列入索引；用 ls 复查目录实况`
    case 'nested_directories_omitted':
      return `发现 ${diagnostic.affectedCount} 个子目录；索引只收录直接子项，其中的文档未列入；需要时用 ls 继续检查`
    case 'nested_scan_truncated':
      return `另有 ${diagnostic.affectedCount} 个嵌套文档或目录因递归扫描上限未列入；用 ls 继续检查`
    case 'file_read_failed':
      return `${diagnostic.affectedCount} 个文档读取失败，未列入索引；用 read/ls 复查对应文件`
  }
}

/** note 行的降级优先级：预算耗尽时从低到高裁剪（诊断必须留到最后）。 */
const NOTE_PRIORITY_OMITTED = 1
const NOTE_PRIORITY_WORKBENCH = 2
const NOTE_PRIORITY_ARCHIVED = 3
const NOTE_PRIORITY_DIAGNOSTIC = 4

interface DocNoteLine {
  priority: number
  text: string
}

export const formatAvailableDocs = (
  inventory: ProjectDocInventory,
): FormattedAvailableDocs => {
  // 「确认为空」不出子块（项目没用这套结构）；「列举失败导致一条都没列出来」
  // 必须仍出子块——只带一条失败 note。全空的失败若也返回 null，模型看到的就是
  // 「这个项目没有 SDD 文档」，正是最危险的误判。归档计数同理：全部文档都已归档
  // 时活跃索引为空，但「另有 N 个已归档」这条 note 仍是模型需要的事实。
  const mustReportDiagnostics = inventory.diagnostics.length > 0
  const mustReportArchived = inventory.archivedCount > 0
  if (inventory.entries.length === 0 && !mustReportDiagnostics && !mustReportArchived) {
    return { section: null, omittedCount: 0 }
  }

  const heading = [
    '项目文档：项目按 SDD 结构组织的说明文档索引。role 语义：design=项目设计意图（品牌/视觉/交互基调）、domain=长期领域约束、task=任务规格、plan=实施计划、doc=实现现状。需要理解对应方面时，用 read 工具按相对路径读取文档；这些是项目维护者编写的说明，可能与当前代码有出入，重要结论前先用只读工具核实。',
    '',
    '<available_docs>',
  ]
  const encoder = new TextEncoder()
  const fits = (text: string): boolean =>
    encoder.encode(text).byteLength <= DOCS_METADATA_BUDGET_BYTES
  const entryLines = inventory.entries.map((entry) =>
    `  <doc role="${escapeXml(entry.role)}" path="${escapeXml(entry.relativePath)}">` +
      `${escapeXml(entry.title)}</doc>`,
  )
  const noteLines = (omittedCount: number): DocNoteLine[] => {
    const lines: DocNoteLine[] = []
    if (omittedCount > 0) {
      lines.push({
        priority: NOTE_PRIORITY_OMITTED,
        text: `  <note>另有 ${omittedCount} 个文档因索引预算省略</note>`,
      })
    }
    // 归档文档（status: done）不进索引是有意的生命周期收口，但同样必须显式计数——
    // 模型需要知道已完成任务的 Spec/Plan 存在且可追溯，只是不在活跃索引里。
    if (inventory.archivedCount > 0) {
      lines.push({
        priority: NOTE_PRIORITY_ARCHIVED,
        text: `  <note>另有 ${inventory.archivedCount} 个文档已标记 status: done 归档（已完成任务），未列入索引；需要追溯已完成任务时可用 grep "status: done" 查找</note>`,
      })
    }
    const activeTasks = inventory.entries.filter((entry) => entry.role === 'task').length
    const activePlans = inventory.entries.filter((entry) => entry.role === 'plan').length
    if (activeTasks > 0 || activePlans > 0) {
      lines.push({
        priority: NOTE_PRIORITY_WORKBENCH,
        text: `  <note>当前有 ${activeTasks} 个活动 Task Spec 和 ${activePlans} 个活动 Plan；它们是 Git 忽略的本地工作台。执行前核对与当前任务的关联性，完成后在 finish 阶段标记 status: done，避免陈旧规格继续影响后续任务</note>`,
      })
    }
    for (const diagnostic of inventory.diagnostics) {
      const reason = diagnostic.reason ? ` reason="${escapeXml(diagnostic.reason)}"` : ''
      lines.push({
        priority: NOTE_PRIORITY_DIAGNOSTIC,
        text:
          `  <diagnostic code="${escapeXml(diagnostic.code)}" root="${escapeXml(diagnostic.root)}"` +
          ` role="${escapeXml(diagnostic.role)}" count="${diagnostic.affectedCount}"${reason}>` +
          `${escapeXml(diagnosticMessage(diagnostic))}</diagnostic>`,
      })
    }
    return lines
  }
  const renderSection = (inserted: number, notes: DocNoteLine[]): string =>
    [
      ...heading,
      ...entryLines.slice(0, inserted),
      ...notes.map((note) => note.text),
      '</available_docs>',
    ].join('\n')

  // 第一阶梯：优先保住条目，从多到少递减（notes 保持完整）。
  let section: string | null = null
  let omittedCount = entryLines.length
  for (let inserted = entryLines.length; inserted >= 0; inserted -= 1) {
    omittedCount = entryLines.length - inserted
    const candidate = renderSection(inserted, noteLines(omittedCount))
    if (fits(candidate)) {
      section = candidate
      break
    }
  }

  // 第二阶梯：条目已全部让位仍超预算（诊断/归档本身太大），按优先级裁剪**非诊断**
  // note（工作台提示 → 预算省略 → 归档计数）；诊断要么完整保留，要么在第三阶梯
  // 压成一条显式计数的汇总——逐条裁掉诊断会让模型看不到其中一部分，属于静默缩窄。
  // 此前这里会直接返回超预算的 section：只要存在诊断，32 KiB 硬预算就被绕过。
  if (section === null) {
    const notes = noteLines(entryLines.length)
    const diagnosticNotes = notes.filter((note) => note.priority === NOTE_PRIORITY_DIAGNOSTIC)
    const otherNotes = notes.filter((note) => note.priority !== NOTE_PRIORITY_DIAGNOSTIC)
    const rankedOthers = [...otherNotes].sort((left, right) => right.priority - left.priority)
    for (let keep = rankedOthers.length; keep >= 0; keep -= 1) {
      const kept = new Set(rankedOthers.slice(0, keep))
      const candidate = renderSection(
        0,
        notes.filter((note) => diagnosticNotes.includes(note) || kept.has(note)),
      )
      if (fits(candidate)) {
        section = candidate
        break
      }
    }
  }

  // 第三阶梯：连一条 note 都装不进（heading 本身逼近预算）时退化为单条汇总，
  // 保留「还有未列入的内容」这一事实；连汇总都装不进才放弃子块。
  if (section === null) {
    const parts: string[] = []
    if (omittedCount > 0) parts.push(`${omittedCount} 个文档因索引预算省略`)
    if (inventory.archivedCount > 0) parts.push(`${inventory.archivedCount} 个文档已归档（status: done）`)
    if (mustReportDiagnostics) {
      parts.push(`${inventory.diagnostics.length} 项扫描诊断（列举失败/截断/读取失败）未展开，请用 ls 复查`)
    }
    const summary = renderSection(0, [{ priority: 9, text: `  <note>${parts.join('；')}</note>` }])
    section = fits(summary) ? summary : null
  }

  return { section, omittedCount }
}
