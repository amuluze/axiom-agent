import { useEffect, useState } from 'react'
import type { AgentMessage } from '@/agent/core/types'
import type { SolidifyDraft } from '@/agent/testing/spec/solidify'
import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import {
  buildSolidifyPayload,
  countDraftSteps,
  loadSessionMessages,
  prepareSolidifyDraft,
  solidifySpecId,
  type SolidifyPrepareResult,
} from '@/stores/services/testSolidify'
import { useT } from '@/i18n'

/**
 * 固化动作（F5 handler 切片）：源/目标会话、草稿生成/重生成、发送与禁用原因。
 *
 * 面板展示由 SolidifyPanel 承担；本 hook 只持有动作状态与副作用。
 */

export interface SolidifyActions {
  open: boolean
  draft: SolidifyDraft | null
  status: SolidifyPrepareResult['status'] | null
  sourceSessionId: string | null
  targetSessionId: string | null
  disabledReason: string | null
  generating: boolean
  sending: boolean
  canSolidify: boolean
  canSend: boolean
  stepCount: number
  toggle: () => void
  setSource: (sessionId: string | null) => void
  setTarget: (sessionId: string | null) => void
  generate: () => void
  send: () => void
}

export const useSolidifyActions = ({
  activeSessionId,
  sessions,
  messages,
  workspaceReady,
  providerGate,
  selectSession,
  sendToSession,
  onOpenSession,
  setError,
}: {
  activeSessionId: string | null
  sessions: readonly { id: string; title: string }[]
  messages: AgentMessage[]
  workspaceReady: boolean
  providerGate: boolean
  selectSession: (sessionId: string) => Promise<boolean>
  sendToSession: (sessionId: string, content: string) => Promise<boolean>
  onOpenSession: () => void
  setError: (message: string | null) => void
}): SolidifyActions => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [sourceSessionId, setSourceSessionId] = useState<string | null>(null)
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SolidifyDraft | null>(null)
  const [status, setStatus] = useState<SolidifyPrepareResult['status'] | null>(null)
  const [generating, setGenerating] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const pick = (current: string | null): string | null => {
      if (current && sessions.some((session) => session.id === current)) return current
      if (activeSessionId && sessions.some((session) => session.id === activeSessionId)) return activeSessionId
      return sessions[0]?.id ?? null
    }
    setSourceSessionId(pick)
    setTargetSessionId(pick)
  }, [activeSessionId, sessions])

  const disabledReason = !RUNTIME_POLICY.testAutomation.agentGeneration
    ? t('testing.solidify.disabledPolicy')
    : !workspaceReady
      ? t('testing.solidify.disabledNoWorkspace')
      : sessions.length === 0
        ? t('testing.solidify.disabledNoSession')
        : !providerGate
          ? t('testing.solidify.disabledProvider')
          : null
  const canSolidify = disabledReason === null && !generating && Boolean(sourceSessionId)
  const canSend = Boolean(draft && targetSessionId) && providerGate && !sending
  const stepCount = draft ? countDraftSteps(draft) : 0

  const generate = (): void => {
    if (!canSolidify || !sourceSessionId) return
    setGenerating(true)
    setError(null)
    setStatus(null)
    void (async () => {
      try {
        const source = sourceSessionId === activeSessionId
          ? messages
          : await loadSessionMessages(sourceSessionId)
        const sourceSession = sessions.find((session) => session.id === sourceSessionId)
        const title = sourceSession?.title?.trim() || t('testing.solidify.defaultName')
        const result = await prepareSolidifyDraft(source, {
          id: solidifySpecId(title, sourceSessionId),
          name: title,
          target: {},
        })
        if (result.status === 'ok') {
          setDraft(result.draft)
          setStatus('ok')
        } else {
          setDraft(null)
          setStatus(result.status)
        }
      } catch {
        setDraft(null)
        setStatus(null)
        setError(t('testing.solidify.error'))
      } finally {
        setGenerating(false)
      }
    })()
  }

  const toggle = (): void => {
    if (disabledReason) return
    const next = !open
    setOpen(next)
    if (next && !draft && !generating) generate()
  }

  const send = (): void => {
    if (!draft || !targetSessionId || sending) return
    setSending(true)
    setError(null)
    void (async () => {
      try {
        if (targetSessionId !== activeSessionId && !await selectSession(targetSessionId)) {
          setError(t('testing.solidify.sendError'))
          return
        }
        if (!await sendToSession(targetSessionId, buildSolidifyPayload(draft))) {
          setError(t('testing.solidify.sendError'))
          return
        }
        onOpenSession()
      } finally {
        setSending(false)
      }
    })()
  }

  return {
    open,
    draft,
    status,
    sourceSessionId,
    targetSessionId,
    disabledReason,
    generating,
    sending,
    canSolidify,
    canSend,
    stepCount,
    toggle,
    setSource: (sessionId) => {
      setSourceSessionId(sessionId)
      setDraft(null)
      setStatus(null)
    },
    setTarget: setTargetSessionId,
    generate,
    send,
  }
}
