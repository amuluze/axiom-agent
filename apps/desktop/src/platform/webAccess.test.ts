// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

describe('openExternalUrl', () => {
  it('非 http(s) 协议直接忽略（不打开任何窗口）', async () => {
    const { openExternalUrl } = await import('./webAccess')
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null)
    await openExternalUrl('file:///etc/passwd')
    await openExternalUrl('javascript:alert(1)')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('浏览器 dev 模式回退 window.open 并带 noopener', async () => {
    const { openExternalUrl } = await import('./webAccess')
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null)
    await openExternalUrl('https://example.com/docs')
    expect(spy).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
    spy.mockRestore()
  })
})
