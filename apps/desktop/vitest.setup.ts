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

afterEach(() => {
  cleanup()
})
