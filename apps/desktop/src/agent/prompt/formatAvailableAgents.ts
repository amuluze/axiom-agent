import type { ProjectAgentsInventory } from './projectAgents'
import { MAX_NESTED_AGENTS_DEPTH, MAX_NESTED_AGENTS_ENTRIES } from './projectAgents'

/**
 * 把嵌套 `AGENTS.md` 索引格式化为 `<available_agents>` 子块，作为
 * `# 项目上下文` 段的子块注入（紧随根 `AGENTS.md` 正文之后——索引是根文件
 * 「子目录索引」一节的机器可读形态，两者相邻读才不割裂）。
 *
 * 约束与 `<available_docs>` 同口径：
 * - path 必须 XML escape；**只注入路径，不注入正文**；
 * - 注入字节有硬预算，超限者跳过并计数；
 * - 每一种缩窄（预算、条目上限、深度上限、.gitignore 跳过）都必须显式 note——索引不是全集，
 *   静默缩窄会让模型断言「该目录没有局部约定」而照常写代码；
 * - 空清单返回 `{ section: null }`，不输出空壳 XML。
 */

/**
 * 索引字节上限。条目只有相对路径（无标题、无正文），单位信息量远低于
 * `<available_docs>` 条目，因此给它独立的、更紧的预算而不是再开一个 32 KiB 桶：
 * 路径索引天然短，紧预算的省略提示也更早暴露「目录规模超出预期」。
 */
export const AGENTS_METADATA_BUDGET_BYTES = 8 * 1024

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

export interface FormattedAvailableAgents {
  /** 无可注入条目时返回 null（调用方不生成子块）。 */
  section: string | null
  /** 因字节预算被省略的条目数。 */
  omittedCount: number
}

export const formatAvailableAgents = (
  inventory: ProjectAgentsInventory,
): FormattedAvailableAgents => {
  if (inventory.entries.length === 0) {
    return { section: null, omittedCount: 0 }
  }

  const lines: string[] = [
    '子目录项目约定：下列目录下各有一份 AGENTS.md，描述该目录的局部约定（风格、边界、测试方式、禁止事项）。',
    '开始修改某个目录前，先用 read 工具按下列相对路径读取它——根 AGENTS.md 是全局契约，这些文件是它的局部展开，两者都需遵守。',
    '索引只含路径不含正文；扫描遵循 .gitignore 并跳过 .git/node_modules/target/dist/.next/.cache，被忽略目录中的 AGENTS.md 不会列出。',
    `扫描深度上限为 ${MAX_NESTED_AGENTS_DEPTH} 层（工作区根的直接子项为第 1 层）；更深的 AGENTS.md 不会列出。`,
    '',
    '<available_agents>',
  ]
  const encoder = new TextEncoder()
  let accBytes = encoder.encode(lines.join('\n')).byteLength
  let omittedCount = 0
  let inserted = 0
  for (const path of inventory.entries) {
    const line = `  <agents-file path="${escapeXml(path)}"/>`
    const lineBytes = encoder.encode(line).byteLength
    if (lineBytes > AGENTS_METADATA_BUDGET_BYTES || accBytes + 1 + lineBytes > AGENTS_METADATA_BUDGET_BYTES) {
      omittedCount += 1
      continue
    }
    lines.push(line)
    accBytes += 1 + lineBytes
    inserted += 1
  }
  // 全部因预算被省略时不输出空壳；至少保留「存在 N 个目录约定但预算不足」的事实。
  if (inserted === 0) {
    const minimal = [
      ...lines,
      `  <note>另有 ${omittedCount} 个目录的 AGENTS.md 因索引预算省略</note>`,
      '</available_agents>',
    ].join('\n')
    if (encoder.encode(minimal).byteLength <= AGENTS_METADATA_BUDGET_BYTES) {
      return { section: minimal, omittedCount }
    }
    return { section: null, omittedCount }
  }
  if (omittedCount > 0) {
    lines.push(`  <note>另有 ${omittedCount} 个目录的 AGENTS.md 因索引预算省略</note>`)
  }
  // 扫描达到条目上限时条目只是下界——必须显式告知，否则模型会把索引当全集。
  if (inventory.truncated) {
    lines.push(`  <note>扫描达到条目上限（${MAX_NESTED_AGENTS_ENTRIES}），可能还有未列入索引的 AGENTS.md，可用 find 按模式补查</note>`)
  }
  lines.push('</available_agents>')
  return { section: lines.join('\n'), omittedCount }
}
