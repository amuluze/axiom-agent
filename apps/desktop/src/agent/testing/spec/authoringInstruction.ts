/**
 * 「为指定功能写用例」的指令渲染（纯函数、确定性，风格对齐 `buildSolidifyPayload`）：
 * 相同输入产出逐字节相同的字符串，便于测试断言与人工核对。
 *
 * 为什么是一条**用户消息**而不是提示词状态：「这一次要测哪个功能」是瞬时意图。写进系统
 * 提示词会让它在用户每次改选/改描述时抖动（打穿提示词缓存、也让同一会话的提示词失去可比性），
 * 所以稳定事实归 `testingContextSection`，瞬时意图归这一轮消息——本模块只负责把它渲染清楚。
 *
 * 与 `docs/ui-api-automation-usage.md` 的分工：字段清单与取值以文档为准，本指令只写**流程与边界**，
 * 并明确要求模型先加载 `test-design` 技能（纪律在技能正文里，不在指令里重复一遍）。
 */

/** 单行化后的功能描述上限：指令要短，超长描述先让用户自己收敛。 */
export const AUTHORING_FEATURE_MAX_LENGTH = 400

export interface TestAuthoringInstructionInput {
  /** 用户描述的功能（自由文本：折叠空白、限长；空描述由调用方拦下）。 */
  feature: string
  /** 建议的目标用例文件（工作区相对路径，必须落在 tests/ 下）。 */
  specPath: string
  /** 相关既有用例文件（可选）：让模型先读再改，而不是另起一套命名。 */
  relatedSpecPath?: string | null
}

const collapse = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const SPEC_PATH_PATTERN = /^tests\/(?:[^/\n]+\/)*[^/\n]+\.testspec\.json$/u

/**
 * 渲染指令。`specPath` 非法（不在 `tests/` 下、不是 `.testspec.json`）时抛错而不是静默兜底——
 * 目标文件路径是调用方算出来的，静默兜底只会让模型写到别处。
 */
export const buildTestAuthoringInstruction = (input: TestAuthoringInstructionInput): string => {
  const feature = collapse(input.feature).slice(0, AUTHORING_FEATURE_MAX_LENGTH)
  if (feature === '') throw new Error('写用例指令需要功能描述')
  const specPath = collapse(input.specPath)
  if (!SPEC_PATH_PATTERN.test(specPath)) {
    throw new Error(`写用例指令的目标文件必须是 tests/ 下的 .testspec.json：${specPath}`)
  }
  const related = input.relatedSpecPath === undefined || input.relatedSpecPath === null
    ? ''
    : collapse(input.relatedSpecPath)

  return [
    '请为下面的功能编写可重放的自动化测试用例。',
    '',
    `- 功能：${feature}`,
    `- 目标用例文件：${specPath}`,
    `- 相关既有用例：${related === '' ? '无' : related}`,
    '',
    '请先加载内置技能 test-design（load_skill({ name: "test-design" })；若 load_skill 尚未激活，'
    + '先用 discover_agent_tools({ query: "load_skill" }) 激活），再按它的流程执行：',
    '1. 先定测试点（kind = new_feature / regression），再为每个测试点写用例，用例的 verifies 指向测试点；',
    '2. 用真实接口与页面操作构造数据，写 typed 断言，清理走产品原生接口；',
    '3. 只写 tests/ 目录下的用例文件，不要改产品源码；写文件时我会逐次批准。',
    '',
    '完成后在会话里回报：测试点清单、每个测试点对应的用例 id，以及无法客观判定、需要我确认的点。',
  ].join('\n')
}
