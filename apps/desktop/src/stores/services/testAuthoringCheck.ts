/**
 * 会话产物的机械校验：**不许只信模型自述**。
 *
 * 模型说"用例已写好"时，宿主能机械核对的是两件事：
 * 1. 它在**本会话**里真的调用过写入类工具去碰 `tests/**\/*.testspec.json`（`extractWrittenSpecFiles`）；
 * 2. 那些路径**现在**确实存在，且能被同一个解析器解析通过（`scanTestSpecs`，与测试页同一份判定）。
 *
 * 三类失败各自成项，**不合并**：`missing`（声称写了但磁盘上没有——被删、改名，或那次写入本身
 * 失败了）、`invalid`（写了但解析不过，附 JSON path 级原因）、`failed`（写入工具报了错）。
 *
 * **不能机械校验的部分（如实说明）**：模型写在正文里、却没触发任何写入的"我写好了"是自然语言
 * 断言，这里判不了，也不假装判得了——本检查只回答"磁盘上有没有、合不合法"。
 */
import { extractWrittenSpecFiles } from '@/agent/testing/spec/trajectory'
import type { TestSpecIssue } from '@/agent/testing/spec/parseTestSpec'
import { scanTestSpecs } from './testSpecIndex'
import { loadSessionMessages } from './testSolidify'

export interface TestAuthoringCheck {
  /** 本会话声称产出的用例文件（按首次出现顺序，去重）。 */
  declared: readonly string[]
  /** 声称产出但磁盘上不存在的。 */
  missing: readonly string[]
  /** 存在但校验不通过的（附问题清单）。 */
  invalid: readonly { path: string; issues: readonly TestSpecIssue[] }[]
  /** 通过校验的（附用例数、测试点数与没有 verifies 的用例）。 */
  valid: readonly {
    path: string
    caseCount: number
    testPointCount: number
    unverifiedCaseIds: readonly string[]
  }[]
  /** 写入工具报过错的文件（可能同时出现在 missing 里）。 */
  failed: readonly string[]
  /** 磁盘上存在、但本会话没写过的用例文件（多为既有资产；信息项，不是错误）。 */
  untouched: readonly string[]
}

export interface CheckSessionTestArtifactsInput {
  sessionId: string
  workspacePath: string
  signal?: AbortSignal
}

export const checkSessionTestArtifacts = async (
  input: CheckSessionTestArtifactsInput,
): Promise<TestAuthoringCheck> => {
  const signal = input.signal ?? new AbortController().signal
  const [messages, scanned] = await Promise.all([
    loadSessionMessages(input.sessionId),
    scanTestSpecs(input.workspacePath, signal),
  ])
  const written = extractWrittenSpecFiles(messages)
  const declared = written.map((file) => file.path)
  const byPath = new Map(scanned.map((entry) => [entry.path, entry]))

  const missing: string[] = []
  const invalid: { path: string; issues: readonly TestSpecIssue[] }[] = []
  const valid: TestAuthoringCheck['valid'][number][] = []
  for (const path of declared) {
    const entry = byPath.get(path)
    if (entry === undefined) {
      missing.push(path)
      continue
    }
    if (!entry.valid) {
      invalid.push({ path, issues: entry.issues })
      continue
    }
    const caseIds = entry.caseIds ?? []
    const caseVerifies = entry.caseVerifies ?? []
    valid.push({
      path,
      caseCount: entry.caseCount,
      testPointCount: (entry.testPointIds ?? []).length,
      // 没有 verifies 的用例仍可执行，但不进入测试点覆盖；机械核对必须把它点出来。
      unverifiedCaseIds: caseIds.filter((_, index) => (caseVerifies[index] ?? []).length === 0),
    })
  }

  return {
    declared,
    missing,
    invalid,
    valid,
    failed: written.filter((file) => file.isError === true).map((file) => file.path),
    untouched: scanned.filter((entry) => !declared.includes(entry.path)).map((entry) => entry.path),
  }
}
