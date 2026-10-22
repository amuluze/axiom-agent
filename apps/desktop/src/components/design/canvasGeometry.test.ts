// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadPageLayout, MAX_SAVED_PAGE_LAYOUTS, savePageLayout } from './canvasGeometry'

describe('canvasGeometry 页面摆放存储', () => {
  beforeEach(() => window.localStorage.clear())

  it('限制历史稿数量并保留最近写入的稿', () => {
    for (let index = 0; index < MAX_SAVED_PAGE_LAYOUTS + 5; index += 1) {
      savePageLayout(`doc-${index}`, { page: { x: index, y: index } })
    }
    expect(loadPageLayout('doc-0')).toEqual({})
    expect(loadPageLayout(`doc-${MAX_SAVED_PAGE_LAYOUTS + 4}`)).toEqual({ page: { x: 54, y: 54 } })
    const stored = JSON.parse(window.localStorage.getItem('axiom.design.page-layout.v2') ?? '{}') as object
    expect(Object.keys(stored)).toHaveLength(MAX_SAVED_PAGE_LAYOUTS)
  })
})
