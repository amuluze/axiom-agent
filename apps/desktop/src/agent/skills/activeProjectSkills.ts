import type { ProjectSkillInventorySnapshot } from './types'
import { EMPTY_PROJECT_SKILL_INVENTORY } from './types'

/**
 * 当前会话 project Skill 快照的模块级宿主（模式同
 * agent/environment/agentEnvironmentHost.ts 的 bind/get 接缝）：
 * agentStore 在每次工作区激活/会话准备时经 {@link bindActiveProjectSkillSnapshot}
 * 刷新，`load_skill` 工具经 {@link getActiveProjectSkillSnapshot} 读取"当前会话
 * 冻结版本"，不 import stores。默认空快照（无工作区 / 尚未扫描时 fail-closed）。
 */

let active: ProjectSkillInventorySnapshot = EMPTY_PROJECT_SKILL_INVENTORY

export const bindActiveProjectSkillSnapshot = (
  snapshot: ProjectSkillInventorySnapshot,
): void => {
  active = {
    schemaVersion: 1,
    skills: snapshot.skills.map((skill) => ({ ...skill })),
  }
}

export const getActiveProjectSkillSnapshot = (): ProjectSkillInventorySnapshot => active
