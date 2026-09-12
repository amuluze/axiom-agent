import type { ProjectDocInventory } from './projectDocs'
import { MAX_DOC_ROOT_ENTRIES } from './projectDocs'

/**
 * 把项目文档索引格式化为 `<available_docs>` 子块，作为 `# 项目上下文` 段的
 * 子块注入（对齐 `<available_skills>` 的格式与预算策略）。
 *
 * 约束：
 * - role、path、title 必须 XML escape；
 * - 只注入索引（role + 相对路径 + 标题），不注入正文；
 * - 注入提示词的索引总字节有 32 KiB 硬预算：按 DOC_ROOTS 顺序装入，
 *   剩余者跳过并计数；
 * - 空清单或全部因预算省略时返回 `{ section: null }`。
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

export const formatAvailableDocs = (
  inventory: ProjectDocInventory,
): FormattedAvailableDocs => {
  if (inventory.entries.length === 0) {
    return { section: null, omittedCount: 0 }
  }

  const lines: string[] = [
    '项目文档：项目按 SDD 结构组织的说明文档索引。role 语义：domain=长期领域约束、task=任务规格、plan=实施计划、doc=实现现状。需要理解对应方面时，用 read 工具按相对路径读取文档；这些是项目维护者编写的说明，可能与当前代码有出入，重要结论前先用只读工具核实。',
    '',
    '<available_docs>',
  ]
  const encoder = new TextEncoder()
  let accBytes = encoder.encode(lines.join('\n')).byteLength
  let omittedCount = 0
  let inserted = 0
  for (const entry of inventory.entries) {
    const line =
      `  <doc role="${escapeXml(entry.role)}" path="${escapeXml(entry.relativePath)}">` +
      `${escapeXml(entry.title)}</doc>`
    const lineBytes = encoder.encode(line).byteLength
    if (lineBytes > DOCS_METADATA_BUDGET_BYTES || accBytes + 1 + lineBytes > DOCS_METADATA_BUDGET_BYTES) {
      omittedCount += 1
      continue
    }
    lines.push(line)
    accBytes += 1 + lineBytes
    inserted += 1
  }
  // 全部因预算被省略时不输出空壳 <available_docs></available_docs>。
  if (inserted === 0) {
    return { section: null, omittedCount }
  }
  if (omittedCount > 0) {
    lines.push(`  <note>另有 ${omittedCount} 个文档因索引预算省略</note>`)
  }
  // 单目录条目上限截断必须显式告知模型：索引不是全集，必要时用 ls/find 补查目录实况。
  if (inventory.truncatedEntryCount > 0) {
    lines.push(`  <note>另有 ${inventory.truncatedEntryCount} 个文档因单目录条目上限（${MAX_DOC_ROOT_ENTRIES}）未列入索引，可用 ls 查看目录实况</note>`)
  }
  // 宿主目录清单本身被截断（默认 200 条上限）时，条目计数只是下界——同样必须
  // 显式告知，避免模型把索引当作全集。
  if (inventory.truncatedRootCount > 0) {
    lines.push(`  <note>另有 ${inventory.truncatedRootCount} 个受管目录的清单被系统截断，可能还有未列入索引的文档，可用 ls 查看目录实况</note>`)
  }
  // 归档文档（status: done）不进索引是有意的生命周期收口，但同样必须显式计数——
  // 模型需要知道已完成任务的 Spec/Plan 存在且可追溯，只是不在活跃索引里。
  if (inventory.archivedCount > 0) {
    lines.push(`  <note>另有 ${inventory.archivedCount} 个文档已标记 status: done 归档（已完成任务），未列入索引；需要追溯已完成任务时可用 grep "status: done" 查找</note>`)
  }
  lines.push('</available_docs>')
  return { section: lines.join('\n'), omittedCount }
}
