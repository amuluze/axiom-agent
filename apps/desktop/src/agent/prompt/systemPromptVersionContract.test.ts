/// <reference types="node" />
// 系统提示词版本契约守卫：把 SYSTEM_PROMPT_VERSION 与静态提示词正文的 sha256 指纹
// 单射绑定。镜像 runtimeSemanticVersions.test.ts 的 digest 审计模式，但指纹输入是
// 「组装后的静态正文」（assembleCanonicalSystemPromptBody）而非源文件——故对注释、
// 格式、内部重构免疫，只对真正对模型可见的正文变化敏感。
//
// 强制语义：改正文 → 指纹变 → 必须 bump SYSTEM_PROMPT_VERSION；写回（UPDATE 模式）
// 会拒绝「正文变但版本未 bump」。与 scripts/lib/semantic-digest.mjs 的 CRLF→LF
// 归一化保持一致，确保两套指纹口径同源。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT_VERSION, assembleCanonicalSystemPromptBody } from './systemPromptSections'

const CONTRACT_PATH = new URL('../../../contracts/system-prompt-version.json', import.meta.url)
const UPDATE_MODE = Boolean(process.env.UPDATE_SYSTEM_PROMPT_CONTRACT)

interface SystemPromptVersionContract {
  schemaVersion: number
  version: number
  bodyDigest: string
}

const computeCanonicalDigest = (): string => {
  const body = assembleCanonicalSystemPromptBody()
  // CRLF→LF 归一化对齐 scripts/lib/semantic-digest.mjs。
  return createHash('sha256').update(body.replace(/\r\n/gu, '\n')).digest('hex')
}

const readContract = (): SystemPromptVersionContract | null => {
  try {
    return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as SystemPromptVersionContract
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const writeContract = (version: number, bodyDigest: string): void => {
  const contract: SystemPromptVersionContract = { schemaVersion: 1, version, bodyDigest }
  writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`)
}

describe('system prompt version contract', () => {
  const digest = computeCanonicalDigest()

  // 写回模式（npm run sync:system-prompt-version）：重算指纹并落盘，但强制
  // 「正文指纹变化必须伴随版本号变化」，从机制上杜绝改正文不 bump。
  if (UPDATE_MODE) {
    it('updates the system prompt version contract', () => {
      const existing = readContract()
      if (
        existing !== null &&
        existing.bodyDigest !== digest &&
        existing.version === SYSTEM_PROMPT_VERSION
      ) {
        throw new Error(
          `系统提示词正文指纹变化（${existing.bodyDigest.slice(0, 12)} → ${digest.slice(0, 12)}），` +
            `但 SYSTEM_PROMPT_VERSION 仍为 ${SYSTEM_PROMPT_VERSION}。` +
            `请先在 systemPromptSections.ts 提升 SYSTEM_PROMPT_VERSION，再重新运行 sync。`,
        )
      }
      writeContract(SYSTEM_PROMPT_VERSION, digest)
      const refreshed = readContract()
      expect(refreshed?.bodyDigest).toBe(digest)
      expect(refreshed?.version).toBe(SYSTEM_PROMPT_VERSION)
    })
    return
  }

  it('binds SYSTEM_PROMPT_VERSION to the canonical prompt body digest', () => {
    const contract = readContract()
    if (contract === null) {
      throw new Error(
        'contracts/system-prompt-version.json 缺失，请运行 npm run sync:system-prompt-version 初始化',
      )
    }
    expect(contract.schemaVersion).toBe(1)
    expect(SYSTEM_PROMPT_VERSION).toBe(contract.version)
    expect(digest).toBe(contract.bodyDigest)
  })
})
