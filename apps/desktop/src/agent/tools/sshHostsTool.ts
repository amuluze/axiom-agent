import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import type { SshAgentHost } from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject } from './workspaceToolUtils'

/**
 * SSH 主机清单工具（只读、免审批）：列出 ~/.ssh/config 别名与 Axiom 主机注册表
 * 条目，供模型在 exec 前发现可连接目标。主机门禁与清单来源由 Rust 权威解析
 * （ssh_agent.rs）；本层只做 schema 预检与结果渲染。凭据信息（密码引用、私钥
 * 路径）不进入清单。
 */

const renderHosts = (hosts: SshAgentHost[]): string => {
  if (hosts.length === 0) {
    return '没有可连接的 SSH 主机：~/.ssh/config 无 Host 条目且 Axiom 主机注册表为空。请先在配置或「SSH」视图（侧栏导航）添加。'
  }
  return hosts
    .map((host, index) => {
      const endpoint = host.hostname || '(由 ssh 配置解析)'
      const user = host.username ? `${host.username}@` : ''
      const port = host.port ? `:${host.port}` : ''
      const label = host.name ? `「${host.name}」` : ''
      const source = host.source === 'registry' ? '注册表' : 'config'
      return `${index + 1}. ${host.host}${label}（${source}）：${user}${endpoint}${port}`
    })
    .join('\n')
}

export const createSshHostsTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ssh_hosts',
  label: 'ssh hosts',
  promptSnippet:
    '列出可连接的 SSH 主机（~/.ssh/config 别名与 Axiom 主机注册表），返回 exec 可用的 host 标识。',
  promptGuidelines: [
    'exec 前先调用本工具获取可用的 host 标识；ssh 工具的 host 参数只接受清单里的条目（config 别名或注册表 hostId）。',
    '清单只含连接信息（别名/地址/用户/端口），不含凭据；密钥与密码由宿主进程使用，不会进入你的上下文。',
  ],
  runtimeVersion: '2',
  recoveryPolicy: 'never',
  requiresApproval: false,
  executionMode: 'parallel',
  description:
    'List SSH hosts available for remote execution: aliases from ~/.ssh/config and entries from the Axiom host registry. Read-only, no approval. Use the returned host identifier as the ssh tool host argument.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input)) {
      return { ok: false, error: 'Arguments must be an object.' }
    }
    if (!hasOnlyKeys(input, [])) {
      return { ok: false, error: 'ssh_hosts takes no arguments.' }
    }
    return { ok: true, value: input }
  },
  execute: async (_input: JsonValue, context) => {
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const response = await environment.ssh.command({ action: 'listHosts' })
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (response.type !== 'hosts') {
      throw new Error('SSH 主机清单响应类型不符合预期')
    }
    return {
      content: renderHosts(response.hosts),
      details: { hosts: response.hosts as unknown as JsonValue },
    }
  },
})
