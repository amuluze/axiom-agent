import { describe, expect, it } from 'vitest'
import { displaySessionTitle } from './sessionTitle'
import { storeT } from './storeTranslate'
import { translate } from './index'

const tZh = (key: string, params?: Record<string, string | number>) => translate('zh-CN', key, params)
const tEn = (key: string, params?: Record<string, string | number>) => translate('en', key, params)

describe('displaySessionTitle', () => {
  it('把「新会话」哨兵与空标题映射为本地化兜底', () => {
    expect(displaySessionTitle(tEn, '新会话')).toBe('New session')
    expect(displaySessionTitle(tEn, '')).toBe('New session')
    expect(displaySessionTitle(tEn, '   ')).toBe('New session')
    expect(displaySessionTitle(tEn, null)).toBe('New session')
  })

  it('普通标题原样返回，中文界面哨兵保持原文', () => {
    expect(displaySessionTitle(tEn, 'Fix the login bug')).toBe('Fix the login bug')
    expect(displaySessionTitle(tZh, '新会话')).toBe('新会话')
  })

  it('storeT 按当前语言产出 store 消息（测试环境解析为中文）', () => {
    expect(storeT('status.session.noActive')).toBe('当前没有可用会话')
    expect(storeT('status.provider.switched', { label: 'X', model: 'm' })).toBe('已切换到 X · m')
  })
})
