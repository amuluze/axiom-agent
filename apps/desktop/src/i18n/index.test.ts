import { describe, expect, it } from 'vitest'
import { isChineseSystemLanguage, resolveLanguage } from './locale'
import { messageCatalogs } from './locales'
import { translate } from './index'

describe('isChineseSystemLanguage', () => {
  it('匹配 zh 前缀及带区域/脚本的中文语言标签', () => {
    expect(isChineseSystemLanguage('zh-CN')).toBe(true)
    expect(isChineseSystemLanguage('zh-Hans')).toBe(true)
    expect(isChineseSystemLanguage('zh-TW')).toBe(true)
    expect(isChineseSystemLanguage('zh')).toBe(true)
  })

  it('不匹配英文及大小写/下划线变体之外的标签', () => {
    expect(isChineseSystemLanguage('en-US')).toBe(false)
    expect(isChineseSystemLanguage('ja-JP')).toBe(false)
    expect(isChineseSystemLanguage(undefined)).toBe(false)
  })

  it('容忍下划线写法（部分平台返回 zh_CN）', () => {
    expect(isChineseSystemLanguage('zh_CN')).toBe(true)
    expect(isChineseSystemLanguage('ZH-cn')).toBe(true)
  })
})

describe('resolveLanguage', () => {
  it('显式 zh-CN / en 不经系统语言直接生效', () => {
    expect(resolveLanguage('zh-CN', 'en-US')).toBe('zh-CN')
    expect(resolveLanguage('en', 'zh-CN')).toBe('en')
  })

  it('system 按系统语言收敛；中文系统 → zh-CN', () => {
    expect(resolveLanguage('system', 'zh-CN')).toBe('zh-CN')
    expect(resolveLanguage('system', 'zh-Hans')).toBe('zh-CN')
  })

  it('system + 非中文系统 → en', () => {
    expect(resolveLanguage('system', 'en-US')).toBe('en')
    expect(resolveLanguage('system', 'ja')).toBe('en')
  })

  it('system + 系统语言缺失（SSR node）保守回退 zh-CN，避免默认漂英文', () => {
    expect(resolveLanguage('system', undefined)).toBe('zh-CN')
  })
})

describe('语言包完整性', () => {
  it('zh-CN 与 en key 集合完全一致（缺 key 即产品缺译文）', () => {
    const zhKeys = Object.keys(messageCatalogs['zh-CN']).sort()
    const enKeys = Object.keys(messageCatalogs.en).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBeGreaterThan(0)
  })

  it('en 没有残留中文占位与未翻译值', () => {
    for (const [key, value] of Object.entries(messageCatalogs.en)) {
      expect(value.length, `en.${key} 为空`).toBeGreaterThan(0)
      expect(value, `en.${key} 疑似残留中文`).not.toMatch(/[\u4e00-\u9fff]/u)
    }
  })
})

describe('translate', () => {
  it('按语言取文案，缺 key 回退中文再回退 key', () => {
    expect(translate('zh-CN', 'settings.nav.title')).toBe('设置')
    expect(translate('en', 'settings.nav.title')).toBe('Settings')
    // 缺 key 回退链：中文包命中 → key 本身。
    expect(translate('en', 'i18n.missing.key')).toBe('i18n.missing.key')
  })

  it('支持 {name} 插值', () => {
    expect(translate('zh-CN', 'settings.nav.updateAvailable', { version: '0.3.6' }))
      .toBe('有可用更新 v0.3.6')
    expect(translate('en', 'settings.nav.updateAvailable', { version: '0.3.6' }))
      .toBe('Update v0.3.6 available')
  })
})
