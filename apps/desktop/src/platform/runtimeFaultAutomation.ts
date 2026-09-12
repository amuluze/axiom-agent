import { PROVIDER_PROFILE_SCHEMA_VERSION, type ProviderProfile } from '@/agent/transport/provider'
import { invoke } from '@tauri-apps/api/core'
import type { AuthorizedWorkspace } from './workspace'
import { e2eRegisterWorkspace } from './runtimeFaultInjection'
import {
  appendRuntimeFaultAutomationMessage,
  useAgentStore,
} from '@/stores/agentStore'

interface RuntimeFaultAutomationSpec {
  scenario:
    | 'queue_recovered'
    | 'queue_consuming'
    | 'tool_execution_started'
    | 'tool_execution_finished'
    | 'tool_result_committed'
    | 'workspace_audit_persisted'
    | 'workspace_change_step_applied'
    | 'workspace_trash_restore_step_applied'
    | 'mutation_batch_committed'
    | 'compaction_checkpoint_committed'
    | 'provider_response_received'
    | 'agent_end_before_settled'
    | 'intent_fsynced'
    | 'profile_committed'
  endpoint: string
  apiKey: string
  prompt: string
  draft?: string
  workspacePath?: string
}

declare global {
  interface Window {
    __AXIOM_E2E_RUNTIME_AUTOMATION__?: RuntimeFaultAutomationSpec
  }
}

/**
 * 等待 store 状态就绪。后台/遮挡窗口的 webview 会强力节流 setTimeout
 * （链式定时器可延迟到分钟级），轮询式等待会因此饿死——zustand 的
 * subscribe 在 setState 时同步触发，不受可见性节流影响。超时兜底
 * 仍用定时器（允许迟到，不会提前失败）。
 */
const waitForStoreState = (
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<void> => {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const unsubscribe = useAgentStore.subscribe(() => {
      if (!predicate()) return
      unsubscribe()
      clearInterval(slowTick)
      resolve()
    })
    const slowTick = setInterval(() => {
      if (predicate()) {
        unsubscribe()
        clearInterval(slowTick)
        resolve()
      }
    }, 1_000)
    setTimeout(() => {
      unsubscribe()
      clearInterval(slowTick)
      reject(new Error('E2E runtime fault automation timed out'))
    }, timeoutMs)
  })
}

const validateSpec = (value: RuntimeFaultAutomationSpec): RuntimeFaultAutomationSpec => {
  if (![
    'queue_recovered',
    'queue_consuming',
    'tool_execution_started',
    'tool_execution_finished',
    'tool_result_committed',
    'workspace_audit_persisted',
    'workspace_change_step_applied',
    'workspace_trash_restore_step_applied',
    'mutation_batch_committed',
    'compaction_checkpoint_committed',
    'provider_response_received',
    'agent_end_before_settled',
    'intent_fsynced',
    'profile_committed',
  ].includes(value?.scenario)
    || typeof value.endpoint !== 'string'
    || typeof value.apiKey !== 'string'
    || typeof value.prompt !== 'string'
    || (value.draft !== undefined && typeof value.draft !== 'string')
    || (value.workspacePath !== undefined && typeof value.workspacePath !== 'string')
    || ([
      'workspace_audit_persisted',
      'workspace_change_step_applied',
      'workspace_trash_restore_step_applied',
    ].includes(value.scenario)
      && !value.workspacePath)) {
    throw new Error('Invalid E2E runtime fault automation spec')
  }
  return value
}

// 自动化只活在前端且失败静默（console 不落宿主 stdout）：把走过的每一步
// （含状态快照）累积写进单个 DOM 节点，AX 树 dump 一次即可读到完整时间线。
const automationLog: string[] = []
const automationMark = (label: string): void => {
  automationLog.push(label)
  let logEl = document.getElementById('e2e-automation-mark-log')
  if (!logEl) {
    logEl = document.createElement('div')
    logEl.id = 'e2e-automation-mark-log'
    document.body?.appendChild(logEl)
  }
  logEl.textContent = `E2E-LOG: ${automationLog.join(' >> ')}`
}

export const runRuntimeFaultAutomation = async (): Promise<void> => {
  const raw = window.__AXIOM_E2E_RUNTIME_AUTOMATION__
  if (!raw) return
  const spec = validateSpec(raw)
  automationMark('init-start')
  await useAgentStore.getState().initialize()
  automationMark('init-done')
  const config: ProviderProfile = {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    profileId: 'e2e.runtime-fault',
    providerId: 'generic-anthropic-compatible',
    apiFormat: 'anthropic-compatible',
    endpoint: spec.endpoint,
    modelId: 'axiom-runtime-fault-e2e',
    timeoutMs: 30_000,
    maxOutputTokens: 256,
    contextWindow: 32_768,
    capabilities: { toolReferences: false, toolSearch: false },
  }
  automationMark('provider-saving')
  if (!(await useAgentStore.getState().saveProvider(config, spec.apiKey)).saved) {
    automationMark('provider-save-failed')
    throw new Error(useAgentStore.getState().settingsError ?? 'Unable to configure E2E Provider')
  }
  automationMark('provider-saved')
  // 跨场景共享：workspace 绑定块与 trash_restore 的 setup 租约/apply 都要用
  // canonical 路径（e2e_register_workspace 的返回值）。
  let boundWorkspace: AuthorizedWorkspace | null = null
  if (spec.workspacePath) {
    // send 的授权门禁要求活动会话绑定已授权工作区：登记（注册表 + 内存授权，
    // authorize_workspace 是恢复专用、只认注册表既有路径）→ 刷新授权投影 →
    // 建立绑定该工作区的活动会话（对齐 UI 的 addWorkspace 流程）。
    // 必须用返回的 canonical 路径匹配/绑定：/var → /private/var 符号链接。
    boundWorkspace = await e2eRegisterWorkspace(spec.workspacePath)
    useAgentStore.setState({
      authorizedWorkspaces: await invoke<AuthorizedWorkspace[]>('get_authorized_workspaces'),
    })
    if (!await useAgentStore.getState().createNewSession(boundWorkspace.path)) {
      automationMark('workspace-bind-failed')
      throw new Error('Unable to bind E2E workspace session')
    }
    // createNewSession 对投影失败仍返回 true（只写 settingsError）：捕获并上抛，
    // 否则 send 会在未绑定工作区的陈旧投影上被授权门禁静默拦截。
    const bindError = useAgentStore.getState().settingsError
    if (bindError) {
      automationMark(`bind-projection-failed: ${bindError}`)
      throw new Error(bindError)
    }
    const boundState = useAgentStore.getState()
    automationMark(`workspace-bound authWsList=[${boundState.authorizedWorkspaces.map((w) => w.path).join('|')}] `
      + `authWs=${boundState.authorizedWorkspace?.path ?? 'null'} `
      + `sessions=[${boundState.sessions.map((s) => `${s.id.slice(0, 6)}:${s.workspace?.path ?? 'null'}`).join('|')}] `
      + `active=${boundState.activeSessionId?.slice(0, 6) ?? 'null'}`)
    // 竞态诊断：授权状态被异步清空的瞬间抓调用栈（AX dump 可读）
    useAgentStore.subscribe((state, prev) => {
      const wiped = (prev.authorizedWorkspaces.length > 0 && state.authorizedWorkspaces.length === 0)
        || (prev.authorizedWorkspace && !state.authorizedWorkspace)
      if (wiped) {
        const stack = (new Error().stack ?? '').split('\n').slice(1, 8).join(' | ')
        automationMark(`WIPE authWs: ${stack}`)
      }
    })
  }
  // trash_restore 的 setup 租约/apply 依赖已绑定的 canonical 工作区路径；
  // TS 无法跨块收窄，这里显式断言（所有 send 场景都带 workspacePath）。
  if (!boundWorkspace) {
    automationMark('workspace-missing-for-setup')
    throw new Error('trash_restore setup requires the bound E2E workspace')
  }
  const setupWorkspacePath = boundWorkspace.path
  if (spec.scenario === 'workspace_trash_restore_step_applied') {
    // 内容静态 → SHA-256 预计算常量（不依赖 webview 的 crypto.subtle 可用性）
    const operations = [
      {
        type: 'trash',
        path: 'runtime-fault-restore-first.txt',
        expectedSha256: '881eca6632d16bfbe4cdef7b27b68e22dd3b303ae0328a6b19c51b596dd827d9',
      },
      {
        type: 'trash',
        path: 'runtime-fault-restore-second.txt',
        expectedSha256: 'e52b7743be02ccc6d3d806d471e04f72a8b892b8c98c4802e5cdf2e88df9cbd4',
      },
    ]
    // automatic 租约要求 Rust 侧权威模式为 automatic（fail-closed），E2E 先显式开启
    automationMark('setup-approval-mode')
    try {
      await invoke('set_workspace_approval_mode', { mode: 'automatic' })
    } catch (error) {
      automationMark(`setup-mode-failed: ${String(error).slice(0, 150)}`)
      throw error
    }
    automationMark('setup-lease')
    let approvalLease: string
    try {
      approvalLease = await invoke<string>('request_workspace_approval_lease', {
        request: {
          sessionId: 'e2e-setup-session',
          runId: 'e2e-setup-run',
          toolCallId: 'e2e-setup-tool-call',
          // toolName 必须是 Rust 命令名（apply_changes 工具 ↔ apply_workspace_changes
          // 命令，映射见 platform/workspaceApproval.ts）——consume 以命令名核销
          toolName: 'apply_workspace_changes',
          input: { operations },
          confirmationMode: 'automatic',
          // 租约按工作区绑定签发与校验（consume 用前端原始传参比对）：必须显式
          // 传 canonical 路径，缺省会以 None 参与比对而与 Some(canonical) 不一致
          workspacePath: setupWorkspacePath,
        },
      })
    } catch (error) {
      automationMark(`setup-lease-failed: ${String(error).slice(0, 150)}`)
      throw error
    }
    automationMark('setup-apply')
    try {
      await invoke('apply_workspace_changes', {
        approvalLease,
        // workspacePath 是命令顶层参数（不在 WorkspaceChangeRequest 内）：
        // 缺省时 consume 以 None 与租约记录的 Some(canonical) 比对必然失配
        workspacePath: setupWorkspacePath,
        request: {
          requestId: 'runtime-fault-restore-setup',
          operations,
        },
      })
    } catch (error) {
      automationMark(`setup-apply-failed: ${String(error).slice(0, 150)}`)
      throw error
    }
    automationMark('setup-apply-done')
  }

  if (spec.scenario === 'compaction_checkpoint_committed') {
    // Keep setup below the automatic token threshold so this scenario reaches
    // the explicit manual-compaction persistence boundary.
    // 载荷尺寸经实测校准：三轮累计的请求估算 token 必须低于自动压缩阈值，
    // 否则 token_threshold 自动压缩抢在手动 compactContext 之前触发，
    // 崩溃检查点变成 token_threshold 而非 manual（assertAfterCrash 断言失败）。
    const payload = 'compaction-runtime-fault-payload '.repeat(150)
    for (let round = 1; round <= 3; round += 1) {
      await useAgentStore.getState().send(`${spec.prompt} round ${round}\n${payload}`)
      const state = useAgentStore.getState()
      if (state.error || state.running) {
        throw new Error(state.error ?? `Compaction setup round ${round} did not settle`)
      }
    }
    await useAgentStore.getState().compactContext()
    throw new Error('compaction_checkpoint_committed fault checkpoint did not terminate the app')
  }

  automationMark('send-called')
  const run = useAgentStore.getState().send(spec.prompt)
  try {
    await waitForStoreState(() => useAgentStore.getState().running)
  } catch (error) {
    // send 静默早退时（授权门禁/未就绪），把判定所需的全量状态写进标记
    const state = useAgentStore.getState()
    automationMark(`send-early-exit error=${state.error ?? 'null'} `
      + `setupReq=${state.providerSetupRequired} ready=${state.providerReady} `
      + `authWs=${state.authorizedWorkspace?.path ?? 'null'} `
      + `authWsList=[${state.authorizedWorkspaces.map((w) => w.path).join('|')}] `
      + `sessions=[${state.sessions.map((s) => `${s.id.slice(0, 6)}:${s.workspace?.path ?? 'null'}`).join('|')}] `
      + `active=${state.activeSessionId?.slice(0, 6) ?? 'null'}`)
    throw error
  }
  automationMark('running')
  if ([
    'workspace_audit_persisted',
    'workspace_change_step_applied',
    'workspace_trash_restore_step_applied',
  ].includes(spec.scenario)) {
    automationMark('approval-waiting')
    await waitForStoreState(() => useAgentStore.getState().pendingApproval !== null)
    const toolCallId = useAgentStore.getState().pendingApproval?.toolCallId
    if (!toolCallId) throw new Error('Workspace audit scenario did not request approval')
    await useAgentStore.getState().approveToolCall(toolCallId)
    automationMark('approved')
  }
  if (spec.scenario === 'mutation_batch_committed') {
    await appendRuntimeFaultAutomationMessage('durable runtime mutation marker')
  }
  if (spec.scenario === 'queue_recovered' || spec.scenario === 'queue_consuming') {
    automationMark('queue-calling')
    if (!spec.draft || !await useAgentStore.getState().queueSteering(spec.draft)) {
      automationMark('queue-failed')
      throw new Error('Unable to queue E2E fault draft')
    }
    await waitForStoreState(() => useAgentStore.getState().pendingSteeringCount === 1)
    automationMark('queued')
    if (spec.scenario === 'queue_recovered') {
      automationMark('stop-calling')
      await useAgentStore.getState().stop()
      automationMark('stop-returned-without-checkpoint')
      throw new Error('queue_recovered fault checkpoint did not terminate the app')
    }
  }
  automationMark('awaiting-run')
  await run
  throw new Error(`${spec.scenario} fault checkpoint did not terminate the app`)
}
