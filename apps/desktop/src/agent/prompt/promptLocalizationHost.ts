import type { ResolvedLanguage } from '@/i18n/locale'
import {
  EMPTY_BUILTIN_PROMPT_OVERRIDES,
  type BuiltinPromptOverridesState,
} from '@/config/builtinPromptOverrides'

/**
 * 提示词本地化宿主接缝（模式同 skills/activeProjectSkills.ts 的模块级宿主）：
 * agent 层不 import stores / i18n 运行时——agentStore 装配时经
 * {@link installPromptLocalizationHost} 注入「UI 语言解析 + 用户覆写」两个只读
 * 供给，load_skill 内置回退 / <available_skills> 清单 / SubAgentRuntime 在执行期
 * 读取。默认 zh-CN + 空覆写：SSR 与单测环境确定性（与系统提示词中文基线一致），
 * 未安装宿主时不会读到任何用户覆写。
 */
export interface PromptLocalizationHost {
  /** 当前生效语言（uiStore 偏好 + 系统语言解析后的收敛结果）。 */
  resolveLanguage: () => ResolvedLanguage
  /** 用户在设置页保存的内置提示词覆写（config 叶子模块 live binding）。 */
  getOverrides: () => BuiltinPromptOverridesState
}

let host: PromptLocalizationHost = {
  resolveLanguage: () => 'zh-CN',
  getOverrides: () => EMPTY_BUILTIN_PROMPT_OVERRIDES,
}

export const installPromptLocalizationHost = (next: PromptLocalizationHost): void => {
  host = next
}

export const resolvePromptLanguage = (): ResolvedLanguage => host.resolveLanguage()

export const getBuiltinPromptOverrides = (): BuiltinPromptOverridesState => host.getOverrides()
