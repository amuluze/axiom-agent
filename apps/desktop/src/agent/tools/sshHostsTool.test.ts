import { describe, expect, it } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createSshHostsTool } from './sshHostsTool'

const baseContext = (): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
})

describe('sshHostsTool', () => {
  const tool = createSshHostsTool(createFakeAgentEnvironment())

  it('契约标记：只读免审批、可并行、崩溃不重放', () => {
    expect(tool.name).toBe('ssh_hosts')
    expect(tool.requiresApproval).toBe(false)
    expect(tool.executionMode).toBe('parallel')
    expect(tool.recoveryPolicy).toBe('never')
    expect(tool.runtimeVersion).toBe('2')
  })

  it('不接受任何参数', () => {
    expect(tool.validate({}).ok).toBe(true)
    expect(tool.validate({ host: 'prod' }).ok).toBe(false)
    expect(tool.validate('x').ok).toBe(false)
  })

  it('渲染 config 别名与注册表条目（含来源标注）', async () => {
    const environment = createFakeAgentEnvironment({
      sshAgentCommand: async () => ({
        type: 'hosts',
        hosts: [
          {
            host: '0123456789abcdef',
            source: 'registry',
            name: '生产机',
            hostname: '10.0.0.1',
            username: 'amu',
            port: 22,
          },
          { host: 'build', source: 'config', name: null, hostname: null, username: null, port: null },
        ],
      }),
    })
    const result = await createSshHostsTool(environment).execute({}, baseContext())
    expect(result.content).toContain('0123456789abcdef「生产机」（注册表）：amu@10.0.0.1:22')
    expect(result.content).toContain('build（config）：(由 ssh 配置解析)')
  })

  it('空清单给出可行动的引导文案', async () => {
    const result = await tool.execute({}, baseContext())
    expect(result.content).toContain('没有可连接的 SSH 主机')
  })
})
