import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAxDocument, serializeAxDocument } from './axParser'

// `.pen/axiom.ax` 是 design:verify:axiom / token audit / 设计画布的正式验收稿。
// 它必须同时满足「能被解析」与「与幂等序列化器逐字节一致」：后者同时锁死
// 2 空格缩进、末尾换行、键序与 slot/children 递归顺序，避免单行大稿或手改键序
// 让 git diff / LLM 补丁再次退化。
const canonicalPath = new URL('../../../../../.pen/axiom.ax', import.meta.url)

// 公开分发仓不导出 .pen/（设计稿是私有资产）；该用例只在本仓有验收稿时执行。
const canonicalExists = existsSync(canonicalPath)

describe.skipIf(!canonicalExists)('canonical .pen/axiom.ax', () => {
  it('round-trips through the serializer byte-for-byte', () => {
    const raw = readFileSync(canonicalPath, 'utf8')
    const parsed = parseAxDocument(raw)
    expect(parsed.error).toBeNull()
    expect(parsed.document).not.toBeNull()
    expect(serializeAxDocument(parsed.document!)).toBe(raw)
  })
})
