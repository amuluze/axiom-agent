import { describe, expect, it } from 'vitest'
import { syncNativeWindowTheme } from './windowTheme'

// vitest node 环境无 window / __TAURI_INTERNALS__，天然覆盖非 Tauri 分支：
// 必须解析成功且无副作用，绝不能在浏览器开发模式抛错打断主题切换。
describe('syncNativeWindowTheme', () => {
  it('在非 Tauri 环境下静默跳过并正常解析', async () => {
    await expect(syncNativeWindowTheme('dark')).resolves.toBeUndefined()
    await expect(syncNativeWindowTheme('light')).resolves.toBeUndefined()
    await expect(syncNativeWindowTheme('system')).resolves.toBeUndefined()
  })
})
