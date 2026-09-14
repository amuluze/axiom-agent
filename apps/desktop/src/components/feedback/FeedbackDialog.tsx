import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AtSign,
  Bug,
  CircleAlert,
  CircleCheck,
  Loader,
  MessageSquareText,
  Send,
  SquarePlus,
  X,
} from 'lucide-react'
import { useDialogFocus, trapDialogFocus } from '@/components/dialogFocus'
import { submitFeedback, type FeedbackKind, type FeedbackSubmission } from '@/platform/feedback'
import { useUiStore, type FeedbackRequest } from '@/stores/uiStore'
import { useT } from '@/i18n'

const MAX_DESCRIPTION_CHARS = 2000
const MAX_TITLE_CHARS = 200
const MAX_CONTACT_CHARS = 200

interface SubmittedReceipt {
  kind: FeedbackKind
  title: string
  contact: string
  reference: string | null
  deduped: boolean
}

type SubmitPhase =
  | { state: 'editing' }
  | { state: 'submitting' }
  | { state: 'failure'; message: string }
  | { state: 'success'; receipt: SubmittedReceipt }

const KIND_LABEL_KEY: Record<FeedbackKind, string> = {
  feature: 'app.feedback.kind.feature.label',
  bug: 'app.feedback.kind.bug.label',
}

const KIND_DESC_KEY: Record<FeedbackKind, string> = {
  feature: 'app.feedback.kind.feature.desc',
  bug: 'app.feedback.kind.bug.desc',
}

/**
 * 需求 / 问题反馈弹窗（.pen/axiom.pen「反馈弹窗」六态）：
 * 表单编辑（四项必填 + 逐项校验）→ 提交中（正文锁定、按钮 loader）→
 * 提交成功（回执 + 单号摘要，可「再提一条」）/ 提交失败（横幅原因 + 重试）。
 * 类型卡可再点一次取消选中，对应设计稿的「类型未选」校验态。
 * 端点与 HMAC 密钥都在 Rust `feedback.rs`，本组件只做表单与状态机。
 */
export const FeedbackDialog = ({ request }: { request: FeedbackRequest }) => {
  const { t } = useT()
  const closeFeedback = useUiStore((state) => state.closeFeedback)
  const [kind, setKind] = useState<FeedbackKind | null>(request.kind)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [contact, setContact] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [phase, setPhase] = useState<SubmitPhase>({ state: 'editing' })
  const dialogRef = useDialogFocus<HTMLFormElement>(true)
  const submitting = phase.state === 'submitting'
  const success = phase.state === 'success'

  // 弹窗随 request 重新打开时全部状态归零（复用同一组件实例，靠引用变化触发）。
  useEffect(() => {
    setKind(request.kind)
    setTitle('')
    setDescription('')
    setContact('')
    setShowErrors(false)
    setPhase({ state: 'editing' })
  }, [request])

  const titleError = title.trim() === ''
  const descriptionError = description.trim() === ''
  const contactError = contact.trim() === ''
  const errorCount = Number(kind === null) + Number(titleError) + Number(descriptionError) + Number(contactError)

  const startAnother = () => {
    setKind(request.kind)
    setTitle('')
    setDescription('')
    setContact('')
    setShowErrors(false)
    setPhase({ state: 'editing' })
  }

  const requestClose = () => {
    if (submitting) return
    closeFeedback()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (submitting || success) return
    setShowErrors(true)
    if (kind === null || titleError || descriptionError || contactError) return
    const submission: FeedbackSubmission = {
      kind,
      title: title.trim(),
      description: description.trim(),
      contact: contact.trim(),
    }
    setPhase({ state: 'submitting' })
    void submitFeedback(submission)
      .then((response) => {
        setPhase({
          state: 'success',
          receipt: {
            kind: submission.kind,
            title: submission.title,
            contact: submission.contact,
            reference: response.ref,
            deduped: response.deduped,
          },
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setPhase({ state: 'failure', message })
      })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    trapDialogFocus(event, dialogRef.current)
  }

  const kindCard = (value: FeedbackKind) => {
    const selected = kind === value
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={`feedback__option ${selected ? 'feedback__option--selected' : ''}`}
        onClick={() => setKind(selected ? null : value)}
      >
        {value === 'feature' ? <SquarePlus size={15} /> : <Bug size={15} />}
        <span className="feedback__option-text">
          <span className="feedback__option-label">{t(KIND_LABEL_KEY[value])}</span>
          <span className="feedback__option-desc">{t(KIND_DESC_KEY[value])}</span>
        </span>
        {selected && <CircleCheck size={15} className="feedback__option-check" />}
      </button>
    )
  }

  const hintText = success
    ? t('app.feedback.hint.success')
    : submitting
      ? t('app.feedback.hint.submitting')
      : phase.state === 'failure'
        ? t('app.feedback.hint.failed')
        : showErrors && errorCount > 0
          ? t('app.feedback.hint.invalid', { count: errorCount })
          : t('app.feedback.hint.allRequired')
  const hintClass = `feedback__hint ${
    (showErrors && errorCount > 0) || phase.state === 'failure' ? 'feedback__hint--error' : ''
  }`

  const primaryLabel = success
    ? t('app.feedback.done')
    : submitting
      ? t('app.feedback.submitting')
      : phase.state === 'failure'
        ? t('app.feedback.retry')
        : t('app.feedback.submit')

  return (
    <div className="feedback-backdrop" role="presentation">
      <form
        aria-labelledby="feedback-title"
        aria-modal="true"
        className={`feedback-dialog ${submitting ? 'feedback-dialog--locked' : ''} ${
          success ? 'feedback-dialog--success' : ''
        }`}
        onKeyDown={onKeyDown}
        onSubmit={submit}
        ref={dialogRef}
        role="dialog"
      >
        {!success && (
          <header className="feedback__header">
            <span className="feedback__header-badge">
              <MessageSquareText size={16} />
            </span>
            <div className="feedback__header-text">
              <h2 id="feedback-title">{t('app.feedback.title')}</h2>
              <p>{t('app.feedback.subtitle')}</p>
            </div>
            <button
              type="button"
              aria-label={t('app.feedback.close')}
              className="feedback__close"
              disabled={submitting}
              onClick={requestClose}
            >
              <X size={15} />
            </button>
          </header>
        )}
        {success && phase.state === 'success' ? (
          <div className="feedback__success">
            <span className="feedback__success-badge">
              <CircleCheck size={28} />
            </span>
            <h2 id="feedback-title" className="feedback__success-title">
              {t('app.feedback.success.title')}
            </h2>
            <p className="feedback__success-desc">
              {t('app.feedback.success.desc', { contact: phase.receipt.contact })}
            </p>
            <div className="feedback__receipt">
              <div className="feedback__receipt-head">
                <span className="feedback__receipt-tag">{t(KIND_LABEL_KEY[phase.receipt.kind])}</span>
                <span className="feedback__receipt-ticket">
                  {phase.receipt.reference
                    ? t('app.feedback.success.ticket', { ref: phase.receipt.reference })
                    : t('app.feedback.success.deduped')}
                </span>
              </div>
              <p className="feedback__receipt-title">{phase.receipt.title}</p>
            </div>
          </div>
        ) : (
          <div className="feedback__body">
            {phase.state === 'failure' && (
              <div className="feedback__banner" role="alert">
                <CircleAlert size={14} />
                <span>{t('app.feedback.error.banner', { message: phase.message })}</span>
              </div>
            )}
            <div className="feedback__field">
              <span className="feedback__label">
                {t('app.feedback.kind.label')}
                <span aria-hidden="true" className="feedback__required">
                  *
                </span>
              </span>
              <div className="feedback__options">
                {kindCard('feature')}
                {kindCard('bug')}
              </div>
              {showErrors && kind === null && (
                <p className="feedback__error">{t('app.feedback.kind.required')}</p>
              )}
            </div>
            <div className="feedback__field">
              <label className="feedback__label" htmlFor="feedback-title-input">
                {t('app.feedback.titleLabel')}
                <span aria-hidden="true" className="feedback__required">
                  *
                </span>
              </label>
              <input
                id="feedback-title-input"
                className={`feedback__input ${showErrors && titleError ? 'feedback__input--error' : ''}`}
                data-dialog-initial-focus
                maxLength={MAX_TITLE_CHARS}
                placeholder={t('app.feedback.title.placeholder')}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              {showErrors && titleError && (
                <p className="feedback__error">{t('app.feedback.title.required')}</p>
              )}
            </div>
            <div className="feedback__field">
              <div className="feedback__label feedback__label--row">
                <label htmlFor="feedback-desc-input">
                  {t('app.feedback.descLabel')}
                  <span aria-hidden="true" className="feedback__required">
                    *
                  </span>
                </label>
                <span className="feedback__counter">
                  {t('app.feedback.counter', { current: description.length, max: MAX_DESCRIPTION_CHARS })}
                </span>
              </div>
              <textarea
                id="feedback-desc-input"
                className={`feedback__textarea ${showErrors && descriptionError ? 'feedback__input--error' : ''}`}
                maxLength={MAX_DESCRIPTION_CHARS}
                placeholder={t('app.feedback.desc.placeholder')}
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              {showErrors && descriptionError && (
                <p className="feedback__error">{t('app.feedback.desc.required')}</p>
              )}
            </div>
            <div className="feedback__field">
              <label className="feedback__label" htmlFor="feedback-contact-input">
                {t('app.feedback.contact.label')}
                <span aria-hidden="true" className="feedback__required">
                  *
                </span>
              </label>
              <div
                className={`feedback__input feedback__input--with-icon ${
                  showErrors && contactError ? 'feedback__input--error' : ''
                }`}
              >
                <AtSign size={14} className="feedback__input-icon" />
                <input
                  id="feedback-contact-input"
                  maxLength={MAX_CONTACT_CHARS}
                  placeholder={t('app.feedback.contact.placeholder')}
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                />
              </div>
              {showErrors && contactError && (
                <p className="feedback__error">{t('app.feedback.contact.required')}</p>
              )}
              <p className="feedback__note">{t('app.feedback.contact.note')}</p>
            </div>
          </div>
        )}
        <footer className="feedback__footer">
          <span className={hintClass}>{hintText}</span>
          <div className="feedback__actions">
            <button
              type="button"
              className="feedback__secondary"
              disabled={submitting}
              onClick={success ? startAnother : requestClose}
            >
              {success ? t('app.feedback.again') : t('app.feedback.cancel')}
            </button>
            {success ? (
              // 成功态主按钮语义是「完成」而非再次提交：必须脱离表单 submit
              // 链路（submit 处理器在成功态直接 return），否则点击无反应。
              <button type="button" className="feedback__primary" onClick={requestClose}>
                {primaryLabel}
              </button>
            ) : (
              <button type="submit" className="feedback__primary" disabled={submitting}>
                {submitting ? (
                  <Loader size={14} className="feedback__loader" />
                ) : (
                  <Send size={14} />
                )}
                {primaryLabel}
              </button>
            )}
          </div>
        </footer>
      </form>
    </div>
  )
}
