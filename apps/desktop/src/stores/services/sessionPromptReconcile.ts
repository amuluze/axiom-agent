import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'

/**
 * 激活边界的提示词对账：镜像（AGENTS.md / 文档索引 / 技能扫描）已按被激活
 * 会话的工作区刷新，但 harness 的 live systemPrompt 可能仍是旧值——cached
 * 激活复用原 harness、snapshot 激活恢复持久化提示词，两条路径都不直接改写
 * live 提示词。若不在此对账，漂移要等到下一次 run 的首个 turn_end 才经
 * prepare_next_turn 回流自愈：**首轮模型调用仍用旧 `<available_docs>`**
 * （多会话并行时后台会话在自己 run 里写入的 Spec/Plan 就落在这个窗口里）。
 *
 * 深比较候选提示词，有漂移且会话空闲时经 runtime_dependencies_update 原子
 * 替换——与 run 结束刷新（applyProjectDocsToSession）同一机制与副作用
 * （checkpoint 失效由深比较门保证只在真实漂移时发生）。会话忙碌（后台运行
 * 中被切回）时不适用：prepare_next_turn 回流会在下一个 turn_end 用同一份
 * 新鲜 basePrompt 镜像自愈，无需此处介入。
 *
 * manifest 原样作为 previous/current 传递：对账只换提示词，不改写依赖指纹
 * （尤其不把 skills 冻结快照悄悄换成磁盘现状，那会削弱 load_skill 的
 * fail-closed 语义）。
 *
 * @returns 是否执行了替换。失败（持久化屏障拒绝）由调用方决定降级策略；
 * 镜像此时已是新鲜值，回流兜底仍然成立。
 */
export const reconcileSessionPromptOnActivation = async (
  harness: AgentHarness,
  manifest: RuntimeDependencyManifest,
  candidateSystemPrompt: string,
): Promise<boolean> => {
  if (harness.isDisposed || harness.isRunning) return false
  if (candidateSystemPrompt === harness.systemPrompt) return false
  const activeToolNames = Array.from(harness.activeToolNames)
  await harness.updateRuntimeDependencies({
    previous: { systemPrompt: harness.systemPrompt, activeToolNames, runtimeManifest: manifest },
    current: { systemPrompt: candidateSystemPrompt, activeToolNames, runtimeManifest: manifest },
  })
  return true
}
