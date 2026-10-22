import { useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { trapDialogFocus, useDialogFocus } from './dialogFocus'
import {
  getDialogRequest,
  settleDialog,
  subscribeDialog,
  type DialogRequest,
} from './dialogService'

/**
 * 应用级确认/输入对话框宿主。挂载在 App 根部；`dialogService` 只保存一个待决
 * 请求，宿主按请求渲染并负责焦点陷阱、Escape 取消与 Enter 提交。
 */
export const DialogHost = () => {
  const { t } = useT()
  const [pending, setPending] = useState<DialogRequest | null>(() => getDialogRequest())
  const [value, setValue] = useState('')
  const rootRef = useDialogFocus<HTMLDivElement>(pending !== null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => subscribeDialog(() => setPending(getDialogRequest())), [])

  useEffect(() => {
    if (pending?.kind !== 'prompt') return
    setValue(pending.options.defaultValue ?? '')
    // 输入框在 useDialogFocus 的 rAF 之后挂载；这里再补一次聚焦，确保光标在末尾。
    const frame = requestAnimationFrame(() => inputRef.current?.select())
    return () => cancelAnimationFrame(frame)
  }, [pending])

  if (!pending) return null
  const options = pending.options
  const title = options.title ?? t('app.dialog.confirmTitle')
  const titleId = `app-dialog-title-${pending.id}`
  const descriptionId = `app-dialog-description-${pending.id}`
  const cancel = (): void => {
    settleDialog(pending.kind === 'prompt' ? null : false)
  }
  const confirm = (): void => {
    settleDialog(pending.kind === 'prompt' ? value : true)
  }
  return (
    <div className="app-dialog__overlay" role="presentation">
      <div
        aria-describedby={options.message ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="app-dialog"
        onKeyDown={(event) => {
          trapDialogFocus(event, rootRef.current)
          if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
          } else if (
            event.key === 'Enter'
            && pending.kind === 'prompt'
            && event.target === inputRef.current
          ) {
            event.preventDefault()
            confirm()
          }
        }}
        ref={rootRef}
        role="dialog"
      >
        <h2 className="app-dialog__title" id={titleId}>{title}</h2>
        {options.message && (
          <p className="app-dialog__message" id={descriptionId}>{options.message}</p>
        )}
        {pending.kind === 'prompt' && (
          <input
            aria-label={title}
            className="app-dialog__input"
            data-dialog-initial-focus
            onChange={(event) => setValue(event.target.value)}
            ref={inputRef}
            value={value}
          />
        )}
        <div className="app-dialog__actions">
          <button className="app-dialog__button" onClick={cancel} type="button">
            {options.cancelLabel ?? t('app.dialog.cancel')}
          </button>
          <button
            className={`app-dialog__button ${'danger' in options && options.danger ? 'app-dialog__button--danger' : 'app-dialog__button--primary'}`}
            onClick={confirm}
            type="button"
          >
            {options.confirmLabel ?? t('app.dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
