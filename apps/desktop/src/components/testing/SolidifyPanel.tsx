import { FileCode, Send } from 'lucide-react'
import type { SolidifyDraft } from '@/agent/testing/spec/solidify'
import type { SolidifyPrepareResult } from '@/stores/services/testSolidify'
import { useT } from '@/i18n'

/**
 * 固化面板（F5 切片）：源/目标会话选择、草稿生成/重生成、用例/步骤预览、
 * issues 审查与发送。生成/发送副作用仍由 TestingView 的 handlers 承担。
 */

export interface SolidifyPanelProps {
  open: boolean
  draft: SolidifyDraft | null
  status: SolidifyPrepareResult['status'] | null
  sourceSessionId: string | null
  targetSessionId: string | null
  sessions: readonly { id: string; title: string }[]
  disabledReason: string | null
  generating: boolean
  sending: boolean
  canSolidify: boolean
  canSend: boolean
  stepCount: number
  onToggle: () => void
  onSourceChange: (sessionId: string | null) => void
  onTargetChange: (sessionId: string | null) => void
  onGenerate: () => void
  onSend: () => void
}

export const SolidifyPanel = ({
  open,
  draft,
  status,
  sourceSessionId,
  targetSessionId,
  sessions,
  disabledReason,
  generating,
  sending,
  canSolidify,
  canSend,
  stepCount,
  onToggle,
  onSourceChange,
  onTargetChange,
  onGenerate,
  onSend,
}: SolidifyPanelProps) => {
  const { t } = useT()
  return (
    <section className="testing-view__solidify" aria-labelledby="testing-solidify-title">
      {open ? (
        <>
          <div className="testing-view__panel-title">
            <div>
              <h2 id="testing-solidify-title">{t('testing.solidify.title')}</h2>
              <code>{t('testing.solidify.subtitle')}</code>
            </div>
            {draft && (
              <span className="testing-view__badge">
                {t('testing.solidify.reviewCount', { count: draft.issues.length })}
              </span>
            )}
          </div>
          <div className="testing-view__solidify-controls">
            <label>
              <span>{t('testing.solidify.source')}</span>
              <select
                value={sourceSessionId ?? ''}
                onChange={(event) => onSourceChange(event.target.value || null)}
              >
                <option value="">{t('testing.solidify.noSession')}</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>{session.title}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('testing.solidify.target')}</span>
              <select
                value={targetSessionId ?? ''}
                onChange={(event) => onTargetChange(event.target.value || null)}
              >
                <option value="">{t('testing.solidify.noSession')}</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>{session.title}</option>
                ))}
              </select>
            </label>
            <button type="button" className="testing-view__chip" disabled={!canSolidify} onClick={onGenerate}>
              <FileCode size={13} aria-hidden />
              {generating
                ? t('testing.solidify.generating')
                : draft ? t('testing.solidify.regenerate') : t('testing.solidify.generate')}
            </button>
            {draft && (
              <button type="button" className="testing-view__chip testing-view__chip--primary" disabled={!canSend} onClick={onSend}>
                <Send size={13} aria-hidden />
                {sending ? t('testing.solidify.sending') : t('testing.solidify.send')}
              </button>
            )}
          </div>
          {status === 'empty-trajectory' && (
            <p className="testing-view__solidify-note">{t('testing.solidify.emptyTrajectory')}</p>
          )}
          {status === 'no-explorer-steps' && (
            <p className="testing-view__solidify-note">{t('testing.solidify.noExplorerSteps')}</p>
          )}
          {draft && (
            <div className="testing-view__solidify-draft">
              <div className="testing-view__solidify-target">
                <code>{`tests/${draft.spec.id}.testspec.json`}</code>
                <span>{t('testing.solidify.summary', {
                  cases: draft.spec.cases.length,
                  steps: stepCount,
                  review: draft.issues.length,
                })}</span>
              </div>
              <ul className="testing-view__rows">
                {draft.spec.cases.flatMap((testCase) => [
                  <li key={`case-${testCase.id}`} className="testing-view__row">
                    <span className="testing-view__row-main">
                      <strong>{testCase.name}</strong>
                      <span>{testCase.id}</span>
                    </span>
                    <span className="testing-view__row-duration">
                      {t('testing.solidify.caseSteps', { count: testCase.steps.length })}
                    </span>
                  </li>,
                  ...testCase.steps.map((step) => (
                    <li key={`step-${testCase.id}-${step.id}`} className="testing-view__row testing-view__row--sub">
                      <span className="testing-view__row-main">
                        <strong>{step.action}</strong>
                        <span>{step.id}</span>
                      </span>
                    </li>
                  )),
                ])}
              </ul>
              {draft.issues.length > 0 && (
                <div className="testing-view__solidify-review">
                  <strong>{t('testing.solidify.reviewTitle', { count: draft.issues.length })}</strong>
                  <ul className="testing-view__rows">
                    {draft.issues.map((issue, index) => (
                      <li key={`${issue.code}-${issue.stepIndex}-${index}`} className="testing-view__row">
                        <span className="testing-view__badge">{t('testing.solidify.reviewBadge')}</span>
                        <span className="testing-view__row-main">
                          <strong>{issue.toolName} · {issue.code}</strong>
                          <span>{issue.stepIndex >= 0 ? `#${issue.stepIndex} · ` : 'spec · '}{issue.message}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="testing-view__solidify-collapsed">
          <button
            type="button"
            className="testing-view__chip"
            disabled={Boolean(disabledReason)}
            onClick={onToggle}
          >
            <FileCode size={13} aria-hidden />
            {t('testing.solidify.generate')}
          </button>
          <span className="testing-view__solidify-note">{t('testing.solidify.subtitle')}</span>
        </div>
      )}
      {disabledReason && <p className="testing-view__solidify-note">{disabledReason}</p>}
    </section>
  )
}
