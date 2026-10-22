/**
 * 应用级确认/输入对话框。
 *
 * 取代散落的 `window.confirm` / `window.prompt`：原生 WebView 对话框不可主题化、
 * 不参与焦点管理。服务层只保存一个待决请求，由 App 根部挂载的 `<DialogHost />`
 * 渲染；调用方只拿到 Promise。
 */
export interface ConfirmDialogOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export interface PromptDialogOptions {
  title: string
  message?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
}

export type DialogRequest =
  | {
    id: number
    kind: 'confirm'
    options: ConfirmDialogOptions
    resolve: (value: boolean) => void
  }
  | {
    id: number
    kind: 'prompt'
    options: PromptDialogOptions
    resolve: (value: string | null) => void
  }

let pending: DialogRequest | null = null
let nextId = 1
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

const enqueue = (request: DialogRequest): void => {
  // 只允许一个对话框：后到的请求立即以取消结束，避免调用方 Promise 悬挂。
  if (pending) {
    if (pending.kind === 'confirm') pending.resolve(false)
    else pending.resolve(null)
  }
  pending = request
  emit()
}

export const confirmDialog = (options: ConfirmDialogOptions): Promise<boolean> =>
  new Promise((resolve) => {
    enqueue({ id: nextId++, kind: 'confirm', options, resolve })
  })

export const promptDialog = (options: PromptDialogOptions): Promise<string | null> =>
  new Promise((resolve) => {
    enqueue({ id: nextId++, kind: 'prompt', options, resolve })
  })

export const getDialogRequest = (): DialogRequest | null => pending

export const subscribeDialog = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const settleDialog = (value: boolean | string | null): void => {
  const current = pending
  if (!current) return
  pending = null
  emit()
  if (current.kind === 'confirm') current.resolve(value === true)
  else current.resolve(typeof value === 'string' ? value : null)
}
