/// <reference types="node" />
// 内置 Skill 正文契约守卫：把 BUILTIN_SKILL_BODIES_VERSION 与内置 Skill 的
// name/description/body 规范序列化 sha256 指纹单射绑定。镜像
// systemPromptVersionContract.test.ts 的模式——内置 Skill 的 description 进系统
// 提示词 <available_skills>、正文经 load_skill 进入对话，都是模型可见内容，但两者
// 均在 SYSTEM_PROMPT_VERSION 指纹排除的动态注入之列，此前改正文不触发任何 bump。
//
// 强制语义：改正文/描述 → 指纹变 → 必须 bump BUILTIN_SKILL_BODIES_VERSION；写回
// （UPDATE_BUILTIN_SKILL_CONTRACT=1，npm run sync:builtin-skill-version）拒绝
// 「正文变但版本未 bump」。CRLF→LF 归一化与其余两套指纹口径同源。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILL_BODIES, BUILTIN_SKILL_BODIES_VERSION } from './builtinSkillBodies'

const CONTRACT_PATH = new URL('../../../contracts/builtin-skill-bodies-version.json', import.meta.url)
const UPDATE_MODE = Boolean(process.env.UPDATE_BUILTIN_SKILL_CONTRACT)

interface BuiltinSkillBodiesVersionContract {
  schemaVersion: number
  version: number
  bodiesDigest: string
}

// 规范序列化：数组顺序即声明顺序（冻结的数据源），字段定序保证跨版本确定性。
// v8 起正文按语言双变体（zh-CN/en）——全部语言变体都是模型可见内容，一并入指纹。
const computeCanonicalDigest = (): string => {
  const canonical = JSON.stringify(
    BUILTIN_SKILL_BODIES.map(({ name, 'zh-CN': zh, en }) => ({
      name,
      'zh-CN': {
        description: zh.description,
        body: zh.body.replace(/\r\n/gu, '\n'),
      },
      en: {
        description: en.description,
        body: en.body.replace(/\r\n/gu, '\n'),
      },
    })),
  )
  return createHash('sha256').update(canonical).digest('hex')
}

const readContract = (): BuiltinSkillBodiesVersionContract | null => {
  try {
    return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as BuiltinSkillBodiesVersionContract
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const writeContract = (version: number, bodiesDigest: string): void => {
  const contract: BuiltinSkillBodiesVersionContract = { schemaVersion: 1, version, bodiesDigest }
  writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`)
}

describe('builtin skill bodies version contract', () => {
  const digest = computeCanonicalDigest()

  // 写回模式：重算指纹并落盘，但强制「正文指纹变化必须伴随版本号变化」。
  if (UPDATE_MODE) {
    it('updates the builtin skill bodies version contract', () => {
      const existing = readContract()
      if (
        existing !== null &&
        existing.bodiesDigest !== digest &&
        existing.version === BUILTIN_SKILL_BODIES_VERSION
      ) {
        throw new Error(
          `内置 Skill 正文指纹变化（${existing.bodiesDigest.slice(0, 12)} → ${digest.slice(0, 12)}），` +
            `但 BUILTIN_SKILL_BODIES_VERSION 仍为 ${BUILTIN_SKILL_BODIES_VERSION}。` +
            `请先在 builtinSkillBodies.ts 提升 BUILTIN_SKILL_BODIES_VERSION，再重新运行 sync。`,
        )
      }
      writeContract(BUILTIN_SKILL_BODIES_VERSION, digest)
      const refreshed = readContract()
      expect(refreshed?.bodiesDigest).toBe(digest)
      expect(refreshed?.version).toBe(BUILTIN_SKILL_BODIES_VERSION)
    })
    return
  }

  it('binds BUILTIN_SKILL_BODIES_VERSION to the canonical bodies digest', () => {
    const contract = readContract()
    if (contract === null) {
      throw new Error(
        'contracts/builtin-skill-bodies-version.json 缺失，请运行 npm run sync:builtin-skill-version 初始化',
      )
    }
    expect(contract.schemaVersion).toBe(1)
    expect(BUILTIN_SKILL_BODIES_VERSION).toBe(contract.version)
    expect(digest).toBe(contract.bodiesDigest)
  })
})
