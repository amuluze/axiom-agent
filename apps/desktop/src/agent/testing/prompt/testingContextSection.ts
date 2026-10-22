/**
 * 测试页会话的上下文段（纯函数）：把工作区的用例与环境**摘要**写进会话提示词。
 *
 * 为什么需要它：模型在测试页会话里被要求"写用例"时，看不见工作区里已有什么、
 * 哪些文件需要修复、有哪些运行环境——只能靠用户复述，或自己盲猜文件名与字段。
 *
 * 三条纪律：
 * - **只放稳定事实**：用例文件清单 / 校验状态 / 环境清单。**不放 UI 瞬时选择**
 *   （当前选中的文件、当前环境 id）——那会让系统提示词随用户点击而变，既打穿
 *   provider 的提示词缓存，也让「同一会话的提示词」失去可比性。瞬时意图由用户那一轮
 *   的消息表达（T2-4 的入口就发这样的消息）。
 * - **不复制协议**：字段清单与取值一律指向 `docs/ui-api-automation-usage.md`，
 *   这里只说"先加载哪个技能、以哪份文档为准"。
 * - **预算内截断要显式**：超预算时截断列表并注明省略数量，不静默变短。
 */
import { byteLength } from '@/agent/core/bytes'

export interface TestingContextFileEntry {
  path: string
  valid: boolean
  /** 校验通过时的用例数；无效文件为 0。 */
  caseCount: number
  /** 无效文件的首个问题（JSON path + 原因）；有效文件为 null。 */
  firstIssue: { path: string; message: string } | null
}

export interface TestingContextEnvironmentEntry {
  name: string
  kind: 'local' | 'remote'
  hasRecipe: boolean
}

export interface TestingContextSectionInput {
  files: readonly TestingContextFileEntry[]
  environments: readonly TestingContextEnvironmentEntry[]
}

/** 段字节上限：这是每轮都注入的上下文，超预算必须截断而不是无限增长。 */
export const TESTING_CONTEXT_MAX_BYTES = 8 * 1024

const kindLabel = (kind: 'local' | 'remote'): string =>
  kind === 'local' ? '本地（Axiom 起停）' : '远程（只读校验）'

const issueSuffix = (file: TestingContextFileEntry): string =>
  file.firstIssue === null ? '' : `：${file.firstIssue.path} ${file.firstIssue.message}`

/**
 * 渲染测试上下文段。既没有用例文件也没有环境时返回 `null`（不注入空段——工作区里
 * 没有测试资产时，这个段只会是噪音）。
 */
export const buildTestingContextSection = (input: TestingContextSectionInput): string | null => {
  if (input.files.length === 0 && input.environments.length === 0) return null
  const valid = input.files.filter((file) => file.valid)
  const invalid = input.files.filter((file) => !file.valid)
  const groups: Array<{ title: string; items: string[] }> = [
    ...(valid.length > 0
      ? [{ title: '校验通过：', items: valid.map((file) => `- ${file.path}（${file.caseCount} 条用例）`) }]
      : []),
    ...(invalid.length > 0
      ? [{
          title: '需要修复（先用问题清单改到通过，再运行）：',
          items: invalid.map((file) => `- ${file.path}${issueSuffix(file)}`),
        }]
      : []),
    ...(input.environments.length > 0
      ? [{
          title: '运行环境：',
          items: input.environments.map((environment) => (
            `- ${environment.name}（${kindLabel(environment.kind)}${environment.hasRecipe ? '，有起停配方' : ''}）`
          )),
        }]
      : []),
  ]
  // 收尾两行是纪律说明，任何情况下都要完整保留；它们与省略提示行先占预算，
  // 列表只在余量内截断——先加后判会让「省略提示」把总长顶出上限。
  const OMISSION_LINE_RESERVE_BYTES = 64
  const tail = [
    '写用例前先加载内置技能 test-design（load_skill({ name: "test-design" })）：先定测试点再用例，用真实接口构造数据。',
    '用例字段与取值以 docs/ui-api-automation-usage.md 为准，不要凭记忆写字段；运行环境档在 tests/environments/*.env.ax。',
  ]
  const lines: string[] = [
    '# 测试会话上下文',
    `本会话在测试页：工作区 tests/ 下共 ${input.files.length} 个用例文件（校验通过 ${valid.length}，需要修复 ${invalid.length}）。`,
  ]
  let bytes = byteLength(lines.join('\n'))
  const budget = TESTING_CONTEXT_MAX_BYTES - byteLength(tail.join('\n')) - OMISSION_LINE_RESERVE_BYTES
  const omitted: string[] = []
  for (const group of groups) {
    lines.push(group.title)
    bytes = byteLength(lines.join('\n'))
    for (const item of group.items) {
      const itemBytes = byteLength(item) + 1
      if (bytes + itemBytes > budget) {
        omitted.push(item)
        continue
      }
      lines.push(item)
      bytes += itemBytes
    }
  }
  if (omitted.length > 0) lines.push(`（另有 ${omitted.length} 项因上下文预算省略）`)
  return [...lines, ...tail].join('\n')
}
