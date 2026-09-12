/**
 * 更新清单 notes 是外部渠道携带的文本（官网 latest.json，摘自 CHANGELOG），
 * 渲染前做防御性归一化，只处理展示投影、不回写清单数据：
 * 1. 旧版清单曾被发布脚本折叠成单行——无换行时按标题/列表标记重建结构；
 * 2. 丢弃空分节——Keep a Changelog 惯例全分节出镜，空的「### Security」是孤儿标题；
 * 3. 自「安装说明」附录起整体截断——手动 DMG 安装指引对应用内自更新不适用
 *   （签名替换安装，无 Gatekeeper/quarantine 步骤），展示出来纯属误导。
 *
 * 行级启发式，非 Markdown 解析：代码 span 内的 `# `/`- ` 标记理论上会被误切，
 * 但 changelog 语料中未出现。
 */

const ATX_HEADING = /^#{1,6}\s/u
const INSTALL_APPENDIX_HEADING = /^#{1,6}\s*安装说明/u
const THEMATIC_BREAK = /^(-{3,}|\*{3,}|_{3,})$/u

const isBlank = (line: string): boolean => line.trim().length === 0
const isThematicBreak = (line: string): boolean => THEMATIC_BREAK.test(line.trim())
const isHeading = (line: string): boolean => ATX_HEADING.test(line)
// 越界取空串：判空/判标题语义下与「行不存在」等价，避免非空断言。
const lineAt = (lines: string[], index: number): string => lines[index] ?? ''

// 折叠只把换行变成空格：标题/分隔线/列表标记前补回换行即可恢复分节结构。
// 步骤顺序：先切标题与分隔线，再切列表标记（`---` 与 `- ` 共享前缀字符）。
const repairCollapsedNotes = (text: string): string =>
  text
    .replace(/\s+(#{1,6}\s)/gu, '\n$1')
    .replace(/\s+(-{3,}\s)/gu, '\n$1')
    .replace(/\s+(-\s)/gu, '\n$1')
    .replace(/\s+(\d+[.)]\s)/gu, '\n$1')

const truncateInstallAppendix = (lines: string[]): string[] => {
  const cut = lines.findIndex((line) => INSTALL_APPENDIX_HEADING.test(line))
  if (cut < 0) return lines
  let start = cut
  while (start > 0 && (isBlank(lineAt(lines, start - 1)) || isThematicBreak(lineAt(lines, start - 1)))) {
    start -= 1
  }
  return lines.slice(0, start)
}

const dropEmptySections = (lines: string[]): string[] => {
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lineAt(lines, index)
    if (!isHeading(line)) {
      kept.push(line)
      continue
    }
    // 采集到下一个标题前：正文只有空白/分隔线即为空分节。「---」紧跟文本行是
    // setext 下划线语义，但那种形态在文本行处已判定非空，不会走到丢弃分支。
    let end = index + 1
    let hasContent = false
    while (end < lines.length && !isHeading(lineAt(lines, end))) {
      if (!isBlank(lineAt(lines, end)) && !isThematicBreak(lineAt(lines, end))) {
        hasContent = true
        break
      }
      end += 1
    }
    if (hasContent) {
      kept.push(line)
      continue
    }
    index = end - 1
  }
  return kept
}

export const normalizeUpdateNotes = (raw: string): string => {
  const unified = raw.replace(/\r\n/g, '\n')
  const source = unified.includes('\n') ? unified : repairCollapsedNotes(unified)
  const cleaned = dropEmptySections(truncateInstallAppendix(source.split('\n')))
  return cleaned.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}
