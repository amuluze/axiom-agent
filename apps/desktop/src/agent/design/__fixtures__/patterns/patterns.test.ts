// @vitest-environment node
/**
 * 内置 pattern 库守护测试：9 个 pattern .ax 文件必须通过现有 .ax 1.4 校验
 * （零 error 诊断）。pattern 文件与 design skill body「# 内置模式库」节同步：
 * skill 列名 ↔ 目录文件名集合互相对应，新增/删除 pattern 时镜像校验会先红。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFileSync as readSkill } from 'node:fs'
import { parseAxDocument } from '../../axParser'

const PATTERNS_DIR = resolve(import.meta.dirname)
const SKILL_FILE = resolve(import.meta.dirname, '../../../skills/builtinSkillBodies.ts')
// 路径自检（vitest 的 import.meta.dirname 与 node 略有差异：早期版本会
// 解析为 process.cwd 根目录；下方打印首跑可见）。如版本偏移，把 resolve
// 换成 fileURLToPath(new URL('../../../skills/builtinSkillBodies.ts', import.meta.url))。
if (!SKILL_FILE.endsWith('builtinSkillBodies.ts')) {
  throw new Error(`SKILL_FILE 解析异常：${SKILL_FILE}（vitest 与 node 的 import.meta.dirname 行为差异）`)
}

/** 9 个内置 pattern 名字（按目录文件名）。 */
const patternNames = readdirSync(PATTERNS_DIR)
  .filter((name) => name.endsWith('.ax'))
  .map((name) => name.replace(/\.ax$/, ''))
  .sort()

describe('内置 pattern 库', () => {
  for (const name of patternNames) {
    it(`${name}.ax 解析零 error（校验 fail-closed）`, () => {
      const source = readFileSync(resolve(PATTERNS_DIR, `${name}.ax`), 'utf8')
      const result = parseAxDocument(source)
      const errors = result.diagnostics.filter((item) => item.level === 'error')
      expect(errors, errors.map((e) => `${e.path}: ${e.message}`).join('\n')).toEqual([])
      expect(result.document).not.toBeNull()
    })
  }

  it('每个 pattern 至少 1 个 symbol def 且 body 非空', () => {
    for (const name of patternNames) {
      const source = readFileSync(resolve(PATTERNS_DIR, `${name}.ax`), 'utf8')
      const result = parseAxDocument(source)
      expect(result.document, `${name} 应能解析为 document`).not.toBeNull()
      const symbols = result.document!.symbols ?? {}
      expect(Object.keys(symbols).length, `${name} 应至少 1 个 symbol`).toBeGreaterThanOrEqual(1)
      for (const def of Object.values(symbols)) {
        expect(def.body.length, `${name}.symbols.*.body 应非空`).toBeGreaterThan(0)
      }
    }
  })
})

describe('pattern 文件名 ↔ skill body「# 内置模式库」节', () => {
  // 找 zh 段：标题必须在「# 内置模式库」与下一个 `# ` 标题之间。
  const findSection = (lines: string[], heading: string): { zh: string; en: string } => {
    const zhIdx = lines.findIndex((line) => line.trim() === `# ${heading}`)
    if (zhIdx < 0) return { zh: '', en: '' }
    let end = zhIdx + 1
    while (end < lines.length) {
      if (lines[end].trim().startsWith('# ') && end !== zhIdx) break
      end += 1
    }
    return { zh: lines.slice(zhIdx, end).join('\n'), en: '' }
  }
  // 中英两段都从 line 列表里抓（`# 内置模式库` 是中文段，en 段无同名标题 → 跳过）
  it('zh `# 内置模式库` 节与目录文件名一致', () => {
    const lines = readSkill(SKILL_FILE, 'utf8').split('\n')
    const section = findSection(lines, '内置模式库')
    expect(section.zh, 'skill body 必须含「# 内置模式库」节').not.toBe('')
    // 节的「- **<Name>：」与「目录文件名（去 .ax）」一致
    const mentioned = section.zh
      .split('\n')
      .map((line) => line.match(/^-\s+\*\*([A-Za-z][A-Za-z0-9]*)\*\*/)?.[1])
      .filter((name) => name !== undefined)
    expect(mentioned.sort()).toEqual(patternNames)
  })
})
