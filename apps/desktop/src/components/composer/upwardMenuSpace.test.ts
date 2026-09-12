import { describe, expect, it } from 'vitest'
import { UPWARD_MENU_PREFERRED_MAX_PX, upwardMenuMaxHeight } from './upwardMenuSpace'

describe('upwardMenuMaxHeight', () => {
  it('从触发器顶缘扣除弹层间距与顶部安全余量', () => {
    expect(upwardMenuMaxHeight(500)).toBe(486)
  })

  it('视口充裕时钳制在首选上限，条目过多由列表内部滚动消化', () => {
    expect(upwardMenuMaxHeight(2000)).toBe(UPWARD_MENU_PREFERRED_MAX_PX)
  })

  it('触发器贴住或越过窗口顶缘时兜底为 0，不产生负高度', () => {
    expect(upwardMenuMaxHeight(0)).toBe(0)
    expect(upwardMenuMaxHeight(10)).toBe(0)
  })

  it('亚像素坐标向下取整', () => {
    expect(upwardMenuMaxHeight(500.9)).toBe(486)
  })
})
