import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { hasOnlyKeys, isJsonObject } from './workspaceToolUtils'

const RECOVERY_ID = /^[a-z0-9._-]{1,128}$/iu

const asRecoveryId = (input: JsonValue): string => {
  if (!isJsonObject(input) || typeof input.recoveryId !== 'string') {
    throw new Error('Invalid restore_trash arguments.')
  }
  return input.recoveryId
}

export const createRestoreTrashTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'restore_trash',
  label: 'restore_trash',
  promptSnippet: '从可恢复的回收批次中还原路径。',
  promptGuidelines: [
    '使用 apply_changes 返回的 recoveryId；若缺失或已过期，请请求用户重新授权工作区。',
  ],
  runtimeVersion: '3',
  recoveryPolicy: 'never',
  description:
    'Restore every path from a recoverable trash batch (returned by apply_changes) back to its original location. Refused when the original location is now occupied. Each invocation requires an approval lease.',
  inputSchema: {
    type: 'object',
    properties: {
      recoveryId: {
        type: 'string',
        description: 'Identifier returned by apply_changes when a trash entry was created.',
      },
    },
    required: ['recoveryId'],
    additionalProperties: false,
  },
  executionMode: 'sequential',
  requiresApproval: true,
  validate: (input) => {
    if (
      !isJsonObject(input)
      || !hasOnlyKeys(input, ['recoveryId'])
      || typeof input.recoveryId !== 'string'
      || !RECOVERY_ID.test(input.recoveryId)
    ) return { ok: false, error: 'recoveryId is malformed.' }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const recoveryId = asRecoveryId(input)
    return {
      category: 'workspace-write',
      title: `Restore trash batch ${recoveryId}?`,
      description: 'Axiom restores every path in the batch; conflicts abort the restoration.',
      path: recoveryId,
      preview: `restore recoverable workspace trash ${recoveryId}`,
    }
  },
  auditArguments: (input) => ({ recoveryId: asRecoveryId(input) }),
  execute: async (input, context) => {
    if (!context.approvalLease) throw new Error('Missing workspace approval lease.')
    if (!isJsonObject(input)) throw new Error('Invalid restore_trash arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const recoveryId = asRecoveryId(input)
    const result = await environment.workspace.restoreTrash(recoveryId, context.approvalLease)
    return {
      content: `Restored trash batch ${recoveryId} (${result.changes.length} paths).${context.signal.aborted ? '\nAbort signal arrived mid-restore; restoration is complete and not auto-replayed.' : ''}`,
      details: {
        workspace: result.workspace.path,
        recoveryId,
        changes: result.changes.map((change) => ({
          operation: change.operation,
          path: change.path,
          destination: change.destination ?? null,
          sha256: change.sha256 ?? null,
        })),
        completedAfterAbort: context.signal.aborted,
      },
    }
  },
})

export const restoreTrashTool = createRestoreTrashTool(desktopAgentEnvironment)
