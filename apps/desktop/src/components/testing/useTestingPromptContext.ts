import { useEffect } from 'react'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import { setTestingPromptContext } from '@/stores/agentStore'
import { buildTestingContextSection } from '@/agent/testing/prompt/testingContextSection'

/**
 * 测试页上下文发布（F1 effect 切片）。
 *
 * 只发布稳定事实（用例清单 / 校验状态 / 环境列表），不发布 UI 瞬时选择——
 * 否则系统提示词会随点击变化，打穿提示词缓存并失去可比性。
 * `activeSessionId` 在依赖里：切换会话会重置镜像，需要为新活动会话重新发布。
 */

export const useTestingPromptContext = ({
  activeSessionId,
  specs,
  environments,
}: {
  activeSessionId: string | null
  specs: readonly TestSpecIndexEntry[]
  environments: readonly TestEnvironmentRecord[]
}): void => {
  // 离开测试页即撤掉上下文段（卸载清理）。发布本身在下面的数据效应里，
  // 避免每次重扫都先清后发、白重建一次提示词。
  useEffect(() => () => {
    void setTestingPromptContext(null)
  }, [])

  useEffect(() => {
    void setTestingPromptContext(buildTestingContextSection({
      files: specs.map((spec) => ({
        path: spec.path,
        valid: spec.valid,
        caseCount: spec.caseCount,
        firstIssue: spec.issues[0] === undefined
          ? null
          : { path: spec.issues[0].path, message: spec.issues[0].message },
      })),
      environments: environments.map((environment) => ({
        name: environment.name,
        kind: environment.kind,
        hasRecipe: environment.recipeJson !== null,
      })),
    }))
  }, [activeSessionId, environments, specs])
}
