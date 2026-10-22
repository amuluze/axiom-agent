import { useState } from 'react'
import type { TestAuthoringCheck } from '@/stores/services/testAuthoringCheck'
import { checkSessionTestArtifacts } from '@/stores/services/testAuthoringCheck'
import { buildTestAuthoringInstruction } from '@/agent/testing/spec/authoringInstruction'
import { solidifySpecId } from '@/stores/services/testSolidify'
import { useT } from '@/i18n'

/**
 * Authoring 动作（F2 handler 切片）：
 * - 为本功能写用例：把功能描述渲染成结构化用户消息；
 * - 会话产物核对：机械核对本会话写入的用例文件。
 */

export interface AuthoringActions {
  feature: string
  setFeature: (value: string) => void
  sending: boolean
  sent: boolean
  canRequest: boolean
  request: () => void
  checking: boolean
  canCheck: boolean
  check: TestAuthoringCheck | null
  checkArtifacts: () => void
}

export const useAuthoringActions = ({
  workspacePath,
  workspaceReady,
  activeSessionId,
  selectedSpecPath,
  sendToSession,
  setError,
}: {
  workspacePath: string | undefined
  workspaceReady: boolean
  activeSessionId: string | null
  selectedSpecPath: string | null
  sendToSession: (sessionId: string, content: string) => Promise<boolean>
  setError: (message: string | null) => void
}): AuthoringActions => {
  const { t } = useT()
  const [feature, setFeature] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<TestAuthoringCheck | null>(null)
  const canRequest = Boolean(workspaceReady && activeSessionId)
  const canCheck = canRequest

  const request = (): void => {
    const value = feature.trim()
    if (!workspaceReady || !activeSessionId || value === '' || sending) return
    setSending(true)
    setError(null)
    setSent(false)
    void (async () => {
      try {
        const instruction = buildTestAuthoringInstruction({
          feature: value,
          // 文件名规则与固化一致（同一套文件名安全规则），纯中文描述回落到会话尾段 slug。
          specPath: `tests/${solidifySpecId(value, activeSessionId)}.testspec.json`,
          relatedSpecPath: selectedSpecPath,
        })
        if (!await sendToSession(activeSessionId, instruction)) {
          setError(t('testing.authoring.requestError'))
          return
        }
        setSent(true)
        setFeature('')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('testing.authoring.requestError'))
      } finally {
        setSending(false)
      }
    })()
  }

  const checkArtifacts = (): void => {
    if (!workspacePath || !activeSessionId) return
    setChecking(true)
    void (async () => {
      try {
        setCheck(await checkSessionTestArtifacts({
          sessionId: activeSessionId,
          workspacePath,
        }))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('testing.authoring.error'))
      } finally {
        setChecking(false)
      }
    })()
  }

  return {
    feature,
    setFeature,
    sending,
    sent,
    canRequest,
    request,
    checking,
    canCheck,
    check,
    checkArtifacts,
  }
}
