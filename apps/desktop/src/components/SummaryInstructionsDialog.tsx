import {
  MAX_SUMMARY_INSTRUCTION_BYTES,
  type SummaryInstructionOptions,
} from '@/agent/context/summaryInstructions'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { trapDialogFocus, useDialogFocus } from './dialogFocus'
import { useT } from '@/i18n'

export type SummaryInstructionMode = 'compaction' | 'branch'

interface SummaryInstructionsDialogProps {
  mode: SummaryInstructionMode | null
  onCancel: () => void
  onSubmit: (options: SummaryInstructionOptions) => void
}

export const SummaryInstructionsDialog = ({
  mode,
  onCancel,
  onSubmit,
}: SummaryInstructionsDialogProps) => {
  const { t } = useT()
  const [customInstructions, setCustomInstructions] = useState('')
  const [replaceInstructions, setReplaceInstructions] = useState(false)
  const dialogRef = useDialogFocus<HTMLFormElement>(mode !== null)
  const instructionBytes = useMemo(
    () => new TextEncoder().encode(customInstructions.trim()).byteLength,
    [customInstructions],
  )

  useEffect(() => {
    if (!mode) return
    setCustomInstructions('')
    setReplaceInstructions(false)
  }, [mode, onCancel])

  if (!mode) return null
  const label = {
    compaction: {
      eyebrow: 'CONTEXT COMPACTION',
      title: t('app.summaryDialog.compact.title'),
      description: t('app.summaryDialog.compact.desc'),
      action: t('app.summaryDialog.compact.action'),
    },
    branch: {
      eyebrow: 'BRANCH SUMMARY',
      title: t('app.summaryDialog.branch.title'),
      description: t('app.summaryDialog.branch.desc'),
      action: t('app.summaryDialog.branch.action'),
    },
  }[mode]
  const tooLarge = instructionBytes > MAX_SUMMARY_INSTRUCTION_BYTES

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (tooLarge) return
    const normalized = customInstructions.trim()
    onSubmit({
      ...(normalized ? { customInstructions: normalized } : {}),
      ...(mode === 'branch' && normalized && replaceInstructions
        ? { replaceInstructions: true }
        : {}),
    })
  }

  return (
    <div className="approval-backdrop" role="presentation">
      <form
        aria-describedby="summary-instructions-description"
        aria-labelledby="summary-instructions-title"
        aria-modal="true"
        className="approval-dialog summary-instructions-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          trapDialogFocus(event, dialogRef.current)
        }}
        onSubmit={submit}
        ref={dialogRef}
        role="dialog"
      >
        <header className="approval-header">
          <div>
            <div className="eyebrow">{label.eyebrow}</div>
            <h2 id="summary-instructions-title">{label.title}</h2>
          </div>
          <span className="approval-tool-name">{t('app.summaryDialog.modelOnly')}</span>
        </header>
        <p className="approval-description" id="summary-instructions-description">
          {label.description}
        </p>
        <label className="summary-instructions-field">
          <span>{t('app.summaryDialog.customTitle')}</span>
          <textarea
            data-dialog-initial-focus
            onChange={(event) => setCustomInstructions(event.target.value)}
            placeholder={t('app.summaryDialog.placeholder')}
            rows={7}
            value={customInstructions}
          />
        </label>
        <div className={`summary-instructions-meta ${tooLarge ? 'is-error' : ''}`}>
          <span>{instructionBytes.toLocaleString()} / {MAX_SUMMARY_INSTRUCTION_BYTES.toLocaleString()} bytes</span>
          <span>{tooLarge ? t('app.summaryDialog.tooLarge') : t('app.summaryDialog.useDefault')}</span>
        </div>
        {mode === 'branch' && (
          <label className="summary-instructions-replace">
            <input
              checked={replaceInstructions}
              disabled={!customInstructions.trim()}
              onChange={(event) => setReplaceInstructions(event.target.checked)}
              type="checkbox"
            />
            <span>
              {t('app.summaryDialog.branchInstruction')}
              <small>{t('app.summaryDialog.branchNote')}</small>
            </span>
          </label>
        )}
        <footer className="approval-actions">
          <button className="approval-deny-button" onClick={onCancel} type="button">{t('app.summaryDialog.cancel')}</button>
          <button className="approval-allow-button" disabled={tooLarge} type="submit">{label.action}</button>
        </footer>
      </form>
    </div>
  )
}
