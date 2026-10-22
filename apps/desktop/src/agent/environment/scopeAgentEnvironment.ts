import type { AgentCapability } from '@/config/runtimePolicy'
import { AgentEnvironmentError, type AgentEnvironment } from './AgentEnvironment'

export const scopeAgentEnvironment = (
  environment: AgentEnvironment,
  capabilities: readonly AgentCapability[],
): AgentEnvironment => {
  const enabled = new Set(capabilities)
  const gate = <Args extends unknown[], Result>(
    required: AgentCapability | readonly AgentCapability[],
    operation: (...args: Args) => Promise<Result>,
  ) => async (...args: Args): Promise<Result> => {
    const choices = typeof required === 'string' ? [required] : required
    if (!choices.some((capability) => enabled.has(capability))) {
      throw new AgentEnvironmentError('not_authorized', `当前会话未授权能力：${choices.join(' / ')}`)
    }
    return operation(...args)
  }
  return {
    runtime: environment.runtime,
    artifacts: environment.artifacts,
    authorizedFiles: {
      list: gate(['workspace:read', 'filesystem:read'], environment.authorizedFiles.list),
      readText: gate(['workspace:read', 'filesystem:read'], environment.authorizedFiles.readText),
    },
    workspace: {
      list: gate('workspace:read', environment.workspace.list),
      readText: gate('workspace:read', environment.workspace.readText),
      searchText: gate('workspace:read', environment.workspace.searchText),
      find: gate('workspace:read', environment.workspace.find),
      createTextFile: gate('workspace:write', environment.workspace.createTextFile),
      editTextFile: gate('workspace:write', environment.workspace.editTextFile),
      applyChanges: gate('workspace:write', environment.workspace.applyChanges),
      restoreTrash: gate('workspace:write', environment.workspace.restoreTrash),
      runCommand: gate('workspace:execute', environment.workspace.runCommand),
    },
    design: { readDocument: gate('workspace:read', environment.design.readDocument) },
    // UI 只读探索：只门控浏览器通道。Artifact 写入与其它会话一致（不进工作区、
    // 只落 Axiom 自身存储），不额外设门；子代理由 scopedReadEnvironment 封死。
    // 读/写两条通道各按自己的能力门控（ui-test:read / ui-test:write）：只授予只读
    // 的会话即使拿到写工具名，宿主写通道也连不到。
    browser: {
      command: gate('ui-test:read', environment.browser.command),
      write: gate('ui-test:write', environment.browser.write),
    },
    // API 测试步骤通道：按 api-test:request 单独门控。未授予时连宿主都不可达
    // （Agent 层的逐次审批是另一道门，scopedReadEnvironment 对子代理是第三道）。
    api: { runStep: gate('api-test:request', environment.api.runStep) },
  }
}
