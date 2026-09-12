import { AgentEnvironmentError, type AgentEnvironment } from './AgentEnvironment'

/**
 * Agent 侧宿主能力接缝（模式同 agent/transport/providerHost.ts 的 bindProviderHost）：
 * agent 层通过本接缝消费宿主能力，不直接 import platform。实现由组装根（agentStore）
 * 在 Tauri 运行时经 {@link bindAgentEnvironment} 注入；未绑定时 fail-closed 抛错。
 */

let bound: AgentEnvironment | undefined

export const bindAgentEnvironment = (environment: AgentEnvironment): void => {
  bound = environment
}

export const getAgentEnvironment = (): AgentEnvironment => bound ?? failClosedEnvironment

const unavailable = (method: string): AgentEnvironmentError =>
  new AgentEnvironmentError(
    'unavailable',
    `AgentEnvironment 未绑定：${method} 不可用（桌面运行时未就绪）`,
  )

const failClosedEnvironment: AgentEnvironment = {
  runtime: {
    getInfo: () => Promise.reject(unavailable('runtime.getInfo')),
  },
  authorizedFiles: {
    list: () => Promise.reject(unavailable('authorizedFiles.list')),
    readText: () => Promise.reject(unavailable('authorizedFiles.readText')),
  },
  workspace: {
    list: () => Promise.reject(unavailable('workspace.list')),
    readText: () => Promise.reject(unavailable('workspace.readText')),
    searchText: () => Promise.reject(unavailable('workspace.searchText')),
    createTextFile: () => Promise.reject(unavailable('workspace.createTextFile')),
    editTextFile: () => Promise.reject(unavailable('workspace.editTextFile')),
    applyChanges: () => Promise.reject(unavailable('workspace.applyChanges')),
    restoreTrash: () => Promise.reject(unavailable('workspace.restoreTrash')),
    runCommand: () => Promise.reject(unavailable('workspace.runCommand')),
    find: () => Promise.reject(unavailable('workspace.find')),
  },
  artifacts: {
    writeToolResult: () => Promise.reject(unavailable('artifacts.writeToolResult')),
  },
  web: {
    search: () => Promise.reject(unavailable('web.search')),
    fetch: () => Promise.reject(unavailable('web.fetch')),
  },
  browser: {
    command: () => Promise.reject(unavailable('browser.command')),
  },
  computer: {
    command: () => Promise.reject(unavailable('computer.command')),
  },
  ssh: {
    command: () => Promise.reject(unavailable('ssh.command')),
  },
}

/**
 * 惰性转发代理：tools 在模块加载时捕获本引用，实际方法调用始终转发到 bind 后的实现
 * （Tauri 运行时由 agentStore 装配）；未绑定时 fail-closed。这样模块级工具单例
 * 不需要等到 bind 之后才创建。
 */
export const desktopAgentEnvironment = new Proxy(
  failClosedEnvironment,
  {
    get(_target, property) {
      const active = getAgentEnvironment()
      const value = (active as unknown as Record<PropertyKey, unknown>)[property]
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(active)
        : value
    },
  },
) as AgentEnvironment
