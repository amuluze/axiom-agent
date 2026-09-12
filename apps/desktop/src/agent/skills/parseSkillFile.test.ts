import { describe, expect, it } from 'vitest'
import { METADATA_MAX_BYTES, parseSkillFile, SkillParseError } from './parseSkillFile'

describe('parseSkillFile', () => {
  it('解析目录形态 frontmatter 并提取正文', () => {
    const result = parseSkillFile(`---
name: pdf-tools
description: 提取、检查、合并和拆分 PDF 文件时使用。
disable-model-invocation: false
---
# PDF 工具

正文第二行。`)
    expect(result).toEqual({
      name: 'pdf-tools',
      description: '提取、检查、合并和拆分 PDF 文件时使用。',
      disableModelInvocation: false,
      body: '# PDF 工具\n\n正文第二行。',
    })
  })

  it('disable-model-invocation 缺省为 false，正文为空合法', () => {
    const result = parseSkillFile('---\nname: alpha\ndescription: x\n---\n')
    expect(result.disableModelInvocation).toBe(false)
    expect(result.body).toBe('')
  })

  it('disable-model-invocation: true 被识别', () => {
    const result = parseSkillFile('---\nname: secret\ndescription: x\ndisable-model-invocation: true\n---\n')
    expect(result.disableModelInvocation).toBe(true)
  })

  it('缺失首行 --- 抛 missing_frontmatter', () => {
    expect(() => parseSkillFile('name: foo\n---\n')).toThrowError(expect.objectContaining({ reason: 'missing_frontmatter' }))
  })

  it('缺少结束 --- 抛 missing_frontmatter', () => {
    expect(() => parseSkillFile('---\nname: foo\n')).toThrowError(expect.objectContaining({ reason: 'missing_frontmatter' }))
  })

  it('接受 `...` 之类变体分隔符时视作普通行，缺失结束符抛 missing_frontmatter', () => {
    expect(() => parseSkillFile('---\nname: foo\n...\n')).toThrowError(expect.objectContaining({ reason: 'missing_frontmatter' }))
  })

  it('metadata 区超过 8 KiB 抛 metadata_too_large', () => {
    const longDescription = 'x'.repeat(METADATA_MAX_BYTES)
    expect(() => parseSkillFile(`---\ndescription: ${longDescription}\n---\n`)).toThrowError(
      expect.objectContaining({ reason: 'metadata_too_large' }),
    )
  })

  it('未知字段抛 unknown_field 且不忽略', () => {
    expect(() => parseSkillFile('---\nname: foo\ntriggers: x\n---\n')).toThrowError(
      expect.objectContaining({ reason: 'unknown_field' }),
    )
  })

  it('重复 key 抛 duplicate_key', () => {
    expect(() => parseSkillFile('---\nname: foo\nname: bar\n---\n')).toThrowError(
      expect.objectContaining({ reason: 'duplicate_key' }),
    )
  })

  it('非法 boolean 抛 invalid_scalar', () => {
    for (const bad of ['yes', '1', 'TRUE', '']) {
      expect(() => parseSkillFile(`---\nname: foo\ndisable-model-invocation: ${bad}\n---\n`)).toThrowError(
        expect.objectContaining({ reason: 'invalid_scalar' }),
      )
    }
  })

  it('name 缺失/格式非法/超长抛 invalid_scalar', () => {
    expect(() => parseSkillFile('---\ndescription: x\n---\n')).toThrowError(expect.objectContaining({ reason: 'invalid_scalar' }))
    expect(() => parseSkillFile('---\nname: Foo Bar\n---\n')).toThrowError(expect.objectContaining({ reason: 'invalid_scalar' }))
    expect(() => parseSkillFile('---\nname: _underscore\n---\n')).toThrowError(expect.objectContaining({ reason: 'invalid_scalar' }))
    expect(() => parseSkillFile(`---\nname: ${'a'.repeat(65)}\n---\n`)).toThrowError(expect.objectContaining({ reason: 'invalid_scalar' }))
  })

  it('description 缺失或超长抛 invalid_scalar', () => {
    expect(() => parseSkillFile('---\nname: foo\n---\n')).toThrowError(expect.objectContaining({ reason: 'invalid_scalar' }))
    expect(() => parseSkillFile(`---\nname: foo\ndescription: ${'x'.repeat(1025)}\n---\n`)).toThrowError(
      expect.objectContaining({ reason: 'invalid_scalar' }),
    )
  })

  it('禁用语法（缩进/列表/引号键/注释/YAML 特殊符号）抛 forbidden_syntax', () => {
    const forbidden: Array<[string, string]> = [
      ['缩进值', '---\nname: foo\n  description: x\n---\n'],
      ['列表项', '---\nname: foo\n- bar\n---\n'],
      ['引号包裹键', '---\n"name": foo\n---\n'],
      ['注释', '---\n# 注释\nname: foo\n---\n'],
      ['merge key', '---\n<<: *base\nname: foo\n---\n'],
      ['anchor', '---\n&anchor\nname: foo\n---\n'],
      ['tag', '---\n!tag\nname: foo\n---\n'],
      ['空行', '---\n\nname: foo\n---\n'],
    ]
    for (const [label, content] of forbidden) {
      expect(() => parseSkillFile(content), label).toThrowError(expect.objectContaining({ reason: 'forbidden_syntax' }))
    }
  })

  it('值中的 YAML alias 符号不被解析，作为非法标量拒绝（invalid_scalar）', () => {
    // `name: *foo` 仍匹配 `key: value` 标量行，`*` 不进入任何 alias 展开路径，
    // 而是作为非法 name 值被字段校验拒绝——证明结构上不可能被解析。
    expect(() => parseSkillFile('---\nname: *foo\n---\n')).toThrowError(
      expect.objectContaining({ reason: 'invalid_scalar' }),
    )
  })

  it('key 大小写敏感：大写 NAME 不匹配键字符集，按语法错误拒绝（forbidden_syntax）', () => {
    expect(() => parseSkillFile('---\nNAME: foo\n---\n')).toThrowError(expect.objectContaining({ reason: 'forbidden_syntax' }))
  })

  it('错误携带稳定 code', () => {
    try {
      parseSkillFile('name: foo\n')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SkillParseError)
      expect((error as SkillParseError).code).toBe('SKILL_FRONTMATTER_INVALID')
      expect((error as SkillParseError).name).toBe('SkillParseError')
    }
  })
})
