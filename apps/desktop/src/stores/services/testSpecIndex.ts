import { createId } from '@/agent/core/id'
import { isLegacyMissingDirectory } from './testScanErrors'
import { parseTestSpec, type TestSpecIssue } from '@/agent/testing/spec/parseTestSpec'
import { TEST_SPEC_SUFFIX, isTestSpecPath } from '@/agent/testing/spec/specAudit'
import { findWorkspaceFiles, readWorkspaceText } from '@/platform/workspace'

export interface TestSpecIndexEntry {
  path: string
  valid: boolean
  id: string | null
  name: string | null
  caseCount: number
  stepCount: number
  uiStepCount: number
  apiStepCount: number
  issues: readonly TestSpecIssue[]
  /** 有效文件：测试点（覆盖分母，T3-4）。 */
  testPointIds: readonly string[]
  /** 有效文件：`cases[].id`（声明顺序）。 */
  caseIds: readonly string[]
  /** 有效文件：每个用例声明的测试点，与 `caseIds` 同序（用例→测试点的追溯）。 */
  caseVerifies: readonly (readonly string[])[]
}

/** 无效文件没有用例/测试点面：三处失败分支共用同一形状。 */
const invalidEntry = (path: string, issues: readonly TestSpecIssue[]): TestSpecIndexEntry => ({
  path,
  valid: false,
  id: null,
  name: null,
  caseCount: 0,
  stepCount: 0,
  uiStepCount: 0,
  apiStepCount: 0,
  issues,
  testPointIds: [],
  caseIds: [],
  caseVerifies: [],
})

// 目录缺失不是错误：宿主 `find_workspace_files` 对工作区内不存在的相对路径返回结构化空结果
// （`find_impl_with_policy` 的短路分支），且命令错误已改为 `{code,message}` 信封。
// 唯一的文案判定收敛在 `testScanErrors.isLegacyMissingDirectory`（仅兼容未升级宿主）。

export const scanTestSpecs = async (
  workspacePath: string,
  signal: AbortSignal,
): Promise<TestSpecIndexEntry[]> => {
  let paths: string[]
  try {
    const result = await findWorkspaceFiles({
      requestId: createId('test-index'),
      pattern: `*${TEST_SPEC_SUFFIX}`,
      path: 'tests',
      limit: 200,
      signal,
      workspacePath,
    })
    if (result.truncated) {
      throw new Error('测试用例清单超过 200 个，扫描结果不完整')
    }
    paths = result.matches
      .filter((entry) => entry.kind === 'file' && isTestSpecPath(entry.path))
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (isLegacyMissingDirectory(error)) return []
    throw error
  }

  return Promise.all(paths.map(async (path): Promise<TestSpecIndexEntry> => {
    try {
      const read = await readWorkspaceText(path, 0, 1_000, workspacePath)
      if (read.truncated) {
        return invalidEntry(path, [{ path: '$', message: '文件超过测试索引读取上限' }])
      }
      const parsed = parseTestSpec(read.content)
      if (!parsed.ok) {
        return invalidEntry(path, parsed.issues)
      }
      // hook 步骤同样会真实执行，必须与 case 步骤一并计数：否则纯 UI 的 beforeAll
      // 会被算成 0 个 UI 步骤，运行期才发现缺浏览器目标（fail-closed 但报错太晚）。
      const steps = [
        ...parsed.spec.cases.flatMap((testCase) => testCase.steps),
        ...Object.values(parsed.spec.hooks ?? {}).flatMap((hookSteps) => hookSteps ?? []),
      ]
      const apiStepCount = steps.filter((step) => step.action === 'api.request').length
      return {
        path,
        valid: true,
        id: parsed.spec.id,
        name: parsed.spec.name,
        caseCount: parsed.spec.cases.length,
        stepCount: steps.length,
        uiStepCount: steps.length - apiStepCount,
        apiStepCount,
        issues: [],
        testPointIds: (parsed.spec.testPoints ?? []).map((point) => point.id),
        caseIds: parsed.spec.cases.map((testCase) => testCase.id),
        caseVerifies: parsed.spec.cases.map((testCase) => testCase.verifies ?? []),
      }
    } catch {
      return invalidEntry(path, [{ path: '$', message: '读取文件失败' }])
    }
  }))
}
