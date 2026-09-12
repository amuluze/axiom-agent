import { describe, expect, it } from 'vitest'
import { normalizeUpdateNotes } from './updateNotes'

describe('normalizeUpdateNotes 安装说明附录', () => {
  it('自「安装说明」标题起整体截断，前置分隔线一并去除', () => {
    const notes = [
      '### Fixed',
      '',
      '- 修复若干问题。',
      '',
      '---',
      '',
      '## 安装说明（未签名构建）',
      '',
      '本版本为 adhoc 签名、未公证。需移除 quarantine 属性：',
      '',
      '1. 校验完整性：`shasum -a 256 -c SHA256SUMS.txt --ignore-missing`',
      '2. 挂载 DMG，将 Axiom.app 拖入 /Applications',
    ].join('\n')
    expect(normalizeUpdateNotes(notes)).toBe('### Fixed\n\n- 修复若干问题。')
  })

  it('仅剩附录时归一为空串，由调用方兜底', () => {
    expect(normalizeUpdateNotes('## 安装说明（未签名构建）\n\n1. 挂载 DMG')).toBe('')
  })
})

describe('normalizeUpdateNotes 空分节', () => {
  it('丢弃正文只有空白/分隔线的尾部空分节（Keep a Changelog 空 Security）', () => {
    const notes = ['### Fixed', '', '- 修复若干问题。', '', '### Security', '', '---', ''].join('\n')
    expect(normalizeUpdateNotes(notes)).toBe('### Fixed\n\n- 修复若干问题。')
  })

  it('丢弃夹在中间的空分节', () => {
    const notes = ['### Added', '', '- 新功能。', '', '### Security', '', '### Fixed', '', '- 修复。'].join('\n')
    expect(normalizeUpdateNotes(notes)).toBe('### Added\n\n- 新功能。\n\n### Fixed\n\n- 修复。')
  })

  it('正文行后跟 --- 是 setext 标题语义，不误删', () => {
    const notes = '发布说明\n---\n\n- 条目。'
    expect(normalizeUpdateNotes(notes)).toBe('发布说明\n---\n\n- 条目。')
  })

  it('正常多行 notes 原样保留（除空白归一）', () => {
    const notes = '### Added\n\n- **多工作区并行**：写锁分片。\n- 审批收件箱。'
    expect(normalizeUpdateNotes(notes)).toBe(notes)
  })
})

describe('normalizeUpdateNotes 旧版单行清单', () => {
  // 旧发布脚本以 /\s+/g → ' ' 折叠：原换行处均变为单空格。
  it('无换行时按标题/列表标记重建分节结构', () => {
    const notes = '### Added - **多工作区并行**：写锁分片。 - 审批收件箱。 ### Changed - 密钥迁入 SQLite。'
    expect(normalizeUpdateNotes(notes)).toBe(
      '### Added\n- **多工作区并行**：写锁分片。\n- 审批收件箱。\n### Changed\n- 密钥迁入 SQLite。',
    )
  })

  it('单行内的安装说明附录同样被截断', () => {
    const notes = '### Fixed - 修复若干问题。 --- ## 安装说明（未签名构建） 1. 挂载 DMG'
    expect(normalizeUpdateNotes(notes)).toBe('### Fixed\n- 修复若干问题。')
  })
})

describe('normalizeUpdateNotes 杂项', () => {
  it('CRLF 归一为 LF', () => {
    expect(normalizeUpdateNotes('### Added\r\n\r\n- 条目。')).toBe('### Added\n\n- 条目。')
  })

  it('空串归一为空串', () => {
    expect(normalizeUpdateNotes('')).toBe('')
  })
})
