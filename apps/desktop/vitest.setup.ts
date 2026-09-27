import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// 测试环境统一中文系统语言：i18n 的 system 偏好经 navigator.language 解析，
// node/jsdom 默认 en-US 会让存量中文断言全部失效。defineProperty 只覆盖
// language 单一属性（node/jsdom 均验证可行），不替换整个 navigator 对象。
Object.defineProperty(globalThis.navigator, 'language', {
  value: 'zh-CN',
  configurable: true,
})

// jsdom 未实现 PointerEvent（window.PointerEvent 为 undefined），fireEvent 的
// pointer 系列会回退成裸 Event：button/pointerId 等 init 全部丢失。补一个最小
// 构造器（继承 MouseEvent），让 pointer 交互组件在测试里拿到与浏览器一致的
// button/pointerId 语义。仅 DOM 环境生效（node 环境无 MouseEvent）。
if (typeof globalThis.MouseEvent !== 'undefined' && typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = typeof init.pointerId === 'number' ? init.pointerId : 0
      this.pointerType = typeof init.pointerType === 'string' ? init.pointerType : ''
    }
  }
  Object.defineProperty(globalThis, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  cleanup()
})
