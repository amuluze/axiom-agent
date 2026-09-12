import type { BeforeToolCallContext } from '@/agent/core/types'
import { invoke } from '@tauri-apps/api/core'
import { describe, expect, it, vi } from 'vitest'
import {
  nativeWorkspaceApprovalToolName,
  requestWorkspaceApprovalLease,
  setWorkspaceApprovalMode,
} from './workspaceApproval'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./environment', () => ({ isTauriRuntime: () => true }))

const mockedInvoke = vi.mocked(invoke)

const createContext = (): BeforeToolCallContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  assistantMessage: {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: 'call-1',
      name: 'write',
      arguments: { path: 'notes.txt', content: 'hello' },
      rawArguments: '{"path":"notes.txt","content":"hello"}',
    }],
    stopReason: 'tool_use',
    createdAt: 1,
  },
  toolCall: {
    id: 'call-1',
    name: 'write',
    arguments: { path: 'notes.txt', content: 'hello' },
    rawArguments: '{"path":"notes.txt","content":"hello"}',
  },
  toolCallId: 'call-1',
  toolName: 'write',
  toolLabel: '创建工作区文件',
  requiresApproval: true,
  input: { path: 'notes.txt', content: 'hello' },
  context: {
    sessionId: 'session-1',
    systemPrompt: 'system',
    model: { provider: 'test', model: 'model' },
    messages: [],
    tools: [],
  },
  presentation: {
    title: '创建 notes.txt？',
    description: '将创建新文件',
  },
  signal: new AbortController().signal,
})

describe('workspace approval IPC', () => {
  it('maps public tool names to the native approval protocol', () => {
    expect([
      'write',
      'edit',
      'apply_changes',
      'restore_trash',
      'bash',
    ].map(nativeWorkspaceApprovalToolName)).toEqual([
      'create_workspace_file',
      'edit_workspace_file',
      'apply_workspace_changes',
      'restore_workspace_trash',
      'run_workspace_command',
    ])
  })

  it('issues a lease from the complete immutable approval scope', async () => {
    mockedInvoke.mockResolvedValueOnce('lease-1')
    const context = createContext()

    await expect(requestWorkspaceApprovalLease(context, 'interactive')).resolves.toBe('lease-1')
    expect(mockedInvoke).toHaveBeenCalledWith('request_workspace_approval_lease', {
      request: {
        sessionId: 'session-1',
        runId: 'run-1',
        toolCallId: 'call-1',
        toolName: 'create_workspace_file',
        input: { path: 'notes.txt', content: 'hello' },
        confirmationMode: 'interactive',
      },
    })
  })

  it('passes the bash free-form command payload to the lease request (matches Rust canonical_input)', async () => {
    mockedInvoke.mockResolvedValueOnce('lease-bash')
    const context = createContext()
    const bashContext: BeforeToolCallContext = {
      ...context,
      toolName: 'bash',
      input: { command: 'npm test -- --coverage', cwd: 'apps/desktop', timeout: 60 },
    }

    await expect(requestWorkspaceApprovalLease(bashContext, 'interactive')).resolves.toBe('lease-bash')
    expect(mockedInvoke).toHaveBeenCalledWith('request_workspace_approval_lease', {
      request: {
        sessionId: 'session-1',
        runId: 'run-1',
        toolCallId: 'call-1',
        toolName: 'run_workspace_command',
        // 必须与 Rust workspace_approval.rs canonical_input 期望一致：
        // 只含 command/cwd/timeout，不含 executable/args。
        input: { command: 'npm test -- --coverage', cwd: 'apps/desktop', timeout: 60 },
        confirmationMode: 'interactive',
      },
    })
  })

  it('marks non-interactive access-mode leases as automatic', async () => {
    mockedInvoke.mockResolvedValueOnce('lease-automatic')

    await expect(requestWorkspaceApprovalLease(
      createContext(),
      'automatic',
      '/repo',
    )).resolves.toBe('lease-automatic')

    expect(mockedInvoke).toHaveBeenLastCalledWith('request_workspace_approval_lease', {
      request: expect.objectContaining({
        confirmationMode: 'automatic',
        workspacePath: '/repo',
      }),
    })
  })

  it('passes unknown tool names through unchanged (fallback)', () => {
    expect(nativeWorkspaceApprovalToolName('custom_tool')).toBe('custom_tool')
    expect(nativeWorkspaceApprovalToolName('discover_agent_tools')).toBe('discover_agent_tools')
  })

  it('setWorkspaceApprovalMode forwards the mode to the Rust authoritative state', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await setWorkspaceApprovalMode('automatic')
    expect(mockedInvoke).toHaveBeenCalledWith('set_workspace_approval_mode', { mode: 'automatic' })
  })
})
