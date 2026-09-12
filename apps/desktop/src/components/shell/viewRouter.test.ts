import { describe, expect, it, vi } from 'vitest'
import {
  resolveAutoView,
  resolveShortcut,
  resolveViewRender,
  type ShortcutEventInput,
} from './viewRouter'

const mkEvent = (overrides: Partial<ShortcutEventInput> = {}): ShortcutEventInput => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  key: 'a',
  preventDefault: vi.fn(),
  ...overrides,
})

describe('viewRouter.resolveAutoView', () => {
  it('forces the settings view when provider setup is required, regardless of messages', () => {
    expect(resolveAutoView(true, false)).toBe('settings')
    expect(resolveAutoView(true, true)).toBe('settings')
  })

  it('shows the session view when the provider is ready and messages exist', () => {
    expect(resolveAutoView(false, true)).toBe('session')
  })

  it('shows the new-task view when the provider is ready and no messages exist', () => {
    expect(resolveAutoView(false, false)).toBe('new-task')
  })

  it('preserves an explicitly opened settings view when background messages change', () => {
    expect(resolveAutoView(false, true, 'settings')).toBe('settings')
    expect(resolveAutoView(false, false, 'settings')).toBe('settings')
  })

  it('preserves an explicitly opened ssh view when background messages change', () => {
    expect(resolveAutoView(false, true, 'ssh')).toBe('ssh')
    expect(resolveAutoView(false, false, 'ssh')).toBe('ssh')
  })

  it('still forces provider setup even when another view is active', () => {
    expect(resolveAutoView(true, true, 'session')).toBe('settings')
  })
})

describe('viewRouter.resolveShortcut', () => {
  it('returns null for a non-shortcut event', () => {
    expect(resolveShortcut(mkEvent({ key: 'a', metaKey: true }))).toBeNull()
  })

  it('returns null when neither metaKey nor ctrlKey is pressed', () => {
    expect(resolveShortcut(mkEvent({ key: ',' }))).toBeNull()
  })

  it('returns null when the altKey is present alongside the modifier', () => {
    expect(resolveShortcut(mkEvent({ key: ',', metaKey: true, altKey: true }))).toBeNull()
  })

  it('prevent-defaults and returns settings:general for ⌘,', () => {
    const event = mkEvent({ key: ',', metaKey: true })
    expect(resolveShortcut(event)).toEqual({ view: 'settings', section: 'general' })
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('prevent-defaults and returns new-task for ⌘⇧N', () => {
    const event = mkEvent({ key: 'n', metaKey: true, shiftKey: true })
    expect(resolveShortcut(event)).toEqual({ view: 'new-task' })
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('matches both uppercase and lowercase key values', () => {
    const event = mkEvent({ key: 'N', metaKey: true, shiftKey: true })
    expect(resolveShortcut(event)).toEqual({ view: 'new-task' })
  })

  it('accepts ctrlKey as a modifier equivalent to metaKey', () => {
    const event = mkEvent({ key: ',', ctrlKey: true })
    expect(resolveShortcut(event)).toEqual({ view: 'settings', section: 'general' })
  })
})

describe('viewRouter.resolveViewRender', () => {
  it('signals settingsScreen and !shell for the settings view', () => {
    expect(resolveViewRender('settings')).toEqual({
      settingsScreen: true,
      shell: false,
      session: false,
      ssh: false,
    })
  })

  it('signals shell but !settingsScreen for new-task', () => {
    expect(resolveViewRender('new-task')).toEqual({
      settingsScreen: false,
      shell: true,
      session: false,
      ssh: false,
    })
  })

  it('signals shell + session for the session view', () => {
    expect(resolveViewRender('session')).toEqual({
      settingsScreen: false,
      shell: true,
      session: true,
      ssh: false,
    })
  })

  it('signals the ssh full-window view for the ssh view', () => {
    expect(resolveViewRender('ssh')).toEqual({
      settingsScreen: false,
      shell: false,
      session: false,
      ssh: true,
    })
  })
})
