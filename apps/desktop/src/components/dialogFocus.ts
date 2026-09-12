import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'select:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export const dialogFocusTarget = (
  currentIndex: number,
  focusableCount: number,
  backwards: boolean,
): number | null => {
  if (focusableCount < 1) return null
  if (currentIndex < 0) return backwards ? focusableCount - 1 : 0
  if (backwards && currentIndex === 0) return focusableCount - 1
  if (!backwards && currentIndex === focusableCount - 1) return 0
  return null
}

const focusableElements = (root: HTMLElement): HTMLElement[] => Array.from(
  root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
).filter((element) => element.getClientRects().length > 0)

export const trapDialogFocus = (
  event: KeyboardEvent<HTMLElement>,
  root: HTMLElement | null,
): void => {
  if (event.key !== 'Tab' || !root) return
  const focusable = focusableElements(root)
  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
  const targetIndex = dialogFocusTarget(currentIndex, focusable.length, event.shiftKey)
  if (targetIndex === null) return
  event.preventDefault()
  focusable[targetIndex]?.focus()
}

export const useDialogFocus = <T extends HTMLElement>(open: boolean): RefObject<T | null> => {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = requestAnimationFrame(() => {
      const root = ref.current
      if (!root) return
      const initial = root.querySelector<HTMLElement>('[data-dialog-initial-focus]')
        ?? focusableElements(root)[0]
      initial?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  return ref
}
