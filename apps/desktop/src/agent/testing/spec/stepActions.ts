import type { ApiDriverStep, StepGuard, TestStepSpec } from './types'

/**
 * 测试动作分类的单一事实源：Runner、索引、统计与目标选择共用。
 *
 * 不能把「不是 api.request 就是 UI」写成隐式约定——api.poll / api.delay 同样是 API
 * 步骤，漏判会让纯 API 运行被要求选择浏览器标签页，并污染断言数、探针与筛选类型。
 */
export const isApiDriverStep = (step: TestStepSpec): step is ApiDriverStep & StepGuard =>
  step.action === 'api.request' || step.action === 'api.poll'

export const isApiTestStep = (step: TestStepSpec): boolean =>
  isApiDriverStep(step) || step.action === 'api.delay'
