import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { ActiveRunView } from './useRunActions'

/**
 * 测试页展示派生：选中环境、同步时间标签、用例 issue 计数、当前运行对应的 spec。
 * 全部是纯读取，无副作用。
 */
export const useTestingViewDerived = ({
  environments,
  selectedEnvironmentId,
  syncedAt,
  selectedSpec,
  activeRun,
  specs,
}: {
  environments: readonly TestEnvironmentRecord[]
  selectedEnvironmentId: string | null
  syncedAt: Date | null
  selectedSpec: TestSpecIndexEntry | undefined
  activeRun: ActiveRunView | null
  specs: readonly TestSpecIndexEntry[]
}) => {
  const selectedEnvironment = environments.find((environment) => environment.id === selectedEnvironmentId)
  const syncedLabel = syncedAt ? syncedAt.toLocaleTimeString() : null
  const specIssueCount = selectedSpec && !selectedSpec.valid ? selectedSpec.issues.length : 0
  const activeRunSpec = activeRun
    ? specs.find((spec) => spec.path === activeRun.path)
    : undefined
  return { selectedEnvironment, syncedLabel, specIssueCount, activeRunSpec }
}
