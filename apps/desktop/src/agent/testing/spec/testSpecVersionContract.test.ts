/// <reference types="node" />
// 测试文件协议契约守卫（镜像 systemPromptVersionContract / builtinSkillBodiesVersionContract
// 的写回模式）：把 TEST_SPEC_VERSION 与解析器的**接受面声明**做 sha256 单射绑定。
//
// 为什么需要它：`tests/*.testspec.json` 是用户工作区里长期存在、解析 fail-closed 的协议——老构建
// 遇到不认识的版本、字段或动作只能判「需要修复」。因此**改接受面必须 bump 版本**，否则用户
// 拿到的是一个打不开的文件，却说不出「为什么」。绑定对象是解析器真正消费的声明：
//   - 接受的版本集合；
//   - 顶层字段白名单（`readRecord` 直接引用 TEST_SPEC_TOP_LEVEL_KEYS）；
//   - 步骤动作与每个动作允许的字段（TEST_SPEC_STEP_KEYS，运行期按动作分派校验）；
//   - 占位符形式（另外用探针验证解析器真的接受/拒绝这些形式）。
// 写回：UPDATE_TEST_SPEC_CONTRACT=1（npm run sync:test-spec-version）重算指纹并落盘，但拒绝
// 「接受面已变而版本号未 bump」。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  TEST_SPEC_PLACEHOLDER_FORMS,
  TEST_SPEC_STEP_KEYS,
  TEST_SPEC_TOP_LEVEL_KEYS,
  validateTestSpec,
} from './parseTestSpec'
import { SUPPORTED_TEST_SPEC_VERSIONS, TEST_SPEC_KIND, TEST_SPEC_VERSION } from './types'

const CONTRACT_PATH = new URL('../../../../contracts/test-spec-version.json', import.meta.url)
const UPDATE_MODE = Boolean(process.env.UPDATE_TEST_SPEC_CONTRACT)

interface TestSpecVersionContract {
  schemaVersion: number
  version: number
  surfaceDigest: string
}

// 规范序列化：数组顺序即声明顺序（声明本身是冻结的数据源），逐字段定序保证跨平台确定。
const computeCanonicalDigest = (): string => {
  const canonical = JSON.stringify({
    kind: TEST_SPEC_KIND,
    version: TEST_SPEC_VERSION,
    supportedVersions: [...SUPPORTED_TEST_SPEC_VERSIONS],
    topLevelKeys: [...TEST_SPEC_TOP_LEVEL_KEYS],
    stepActions: Object.keys(TEST_SPEC_STEP_KEYS).sort(),
    stepFields: Object.fromEntries(
      Object.entries(TEST_SPEC_STEP_KEYS).map(([action, fields]) => [action, [...fields]]),
    ),
    placeholders: [...TEST_SPEC_PLACEHOLDER_FORMS],
  })
  return createHash('sha256').update(canonical).digest('hex')
}

const readContract = (): TestSpecVersionContract | null => {
  try {
    return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as TestSpecVersionContract
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const writeContract = (version: number, surfaceDigest: string): void => {
  const contract: TestSpecVersionContract = { schemaVersion: 1, version, surfaceDigest }
  writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`)
}

const probeSpec = (url: string, version: number = TEST_SPEC_VERSION): unknown => ({
  kind: TEST_SPEC_KIND,
  version,
  id: 'probe',
  name: '探针',
  target: {},
  ...(version >= 2
    ? {
        testPoints: [{
          id: 'tp-probe',
          kind: 'new_feature',
          title: '探针',
          acceptance: '可客观判定',
        }],
      }
    : {}),
  cases: [{
    id: 'probe-case',
    name: '探针用例',
    ...(version >= 2 ? { verifies: ['tp-probe'] } : {}),
    steps: [{ id: 'probe-step', action: 'api.request', method: 'GET', url }],
  }],
})

const acceptsUrl = (url: string, version: number = TEST_SPEC_VERSION): boolean =>
  validateTestSpec(probeSpec(url, version)).ok

describe('test spec version contract', () => {
  const digest = computeCanonicalDigest()

  // 写回模式：重算指纹并落盘，但强制「接受面变化必须伴随版本号变化」。
  if (UPDATE_MODE) {
    it('updates the test spec version contract', () => {
      const existing = readContract()
      if (
        existing !== null &&
        existing.surfaceDigest !== digest &&
        existing.version === TEST_SPEC_VERSION
      ) {
        throw new Error(
          `测试文件接受面指纹变化（${existing.surfaceDigest.slice(0, 12)} → ${digest.slice(0, 12)}），` +
            `但 TEST_SPEC_VERSION 仍为 ${TEST_SPEC_VERSION}。` +
            '请先在 agent/testing/spec/types.ts 提升 TEST_SPEC_VERSION，再重新运行 sync。',
        )
      }
      writeContract(TEST_SPEC_VERSION, digest)
      const refreshed = readContract()
      expect(refreshed?.surfaceDigest).toBe(digest)
      expect(refreshed?.version).toBe(TEST_SPEC_VERSION)
    })
    return
  }

  it('binds TEST_SPEC_VERSION to the canonical acceptance surface digest', () => {
    const contract = readContract()
    if (contract === null) {
      throw new Error(
        'contracts/test-spec-version.json 缺失，请运行 npm run sync:test-spec-version 初始化',
      )
    }
    expect(contract.schemaVersion).toBe(1)
    expect(TEST_SPEC_VERSION).toBe(contract.version)
    expect(digest).toBe(contract.surfaceDigest)
  })

  // 声明面必须与解析器实际行为一致，否则契约绑定就只是一段注释。
  it('accepts exactly the declared placeholder forms', () => {
    expect(acceptsUrl(`https://api.test/\${env.WEB_BASE_URL}`)).toBe(true)
    expect(acceptsUrl(`https://api.test/\${vars.orderId}`)).toBe(true)
    expect(acceptsUrl(`https://api.test/\${run.id}`)).toBe(true)
    expect(acceptsUrl(`https://api.test/\${run.slug}`)).toBe(true)

    expect(acceptsUrl(`https://api.test/\${run.other}`)).toBe(false)
    expect(acceptsUrl(`https://api.test/\${env.lowercase}`)).toBe(false)
    expect(acceptsUrl(`https://api.test/\${vars.1bad}`)).toBe(false)
    expect(acceptsUrl(`https://api.test/\${unknown.thing}`)).toBe(false)
  })

  // 版本标注是给用户看的「为什么打不开」；接受面必须与声明一致。
  it('accepts every supported version and rejects everything else', () => {
    for (const version of SUPPORTED_TEST_SPEC_VERSIONS) {
      expect(acceptsUrl('https://api.test/ping', version)).toBe(true)
    }
    expect(acceptsUrl('https://api.test/ping', TEST_SPEC_VERSION + 1)).toBe(false)
    expect(acceptsUrl('https://api.test/ping', 0)).toBe(false)
  })

  it('requires test points from v3 while v2 remains readable without them', () => {
    const bare = (version: number): unknown => ({
      kind: TEST_SPEC_KIND,
      version,
      id: 'probe',
      name: '探针',
      target: {},
      cases: [{
        id: 'probe-case',
        name: '探针用例',
        steps: [{ id: 'probe-step', action: 'api.request', method: 'GET', url: 'https://api.test/ping' }],
      }],
    })
    expect(validateTestSpec(bare(2)).ok).toBe(true)
    const v3 = validateTestSpec(bare(3))
    expect(v3.ok).toBe(false)
    if (v3.ok) return
    expect(v3.issues).toEqual([{ path: '$.testPoints', message: 'v3 文件必须声明至少一个测试点' }])
  })

  it('rejects undeclared top-level keys and step actions', () => {
    const undeclaredKey = validateTestSpec({
      ...(probeSpec('https://api.test/ping') as Record<string, unknown>),
      owner: 'team',
    })
    expect(undeclaredKey.ok).toBe(false)
    if (undeclaredKey.ok) return
    expect(undeclaredKey.issues).toEqual([{ path: '$.owner', message: '未知字段「owner」' }])

    const undeclaredAction = validateTestSpec({
      ...(probeSpec('https://api.test/ping') as Record<string, unknown>),
      cases: [{ id: 'probe-case', name: '探针用例', steps: [{ id: 's', action: 'ui.drag', locator: {} }] }],
    })
    expect(undeclaredAction.ok).toBe(false)
    if (undeclaredAction.ok) return
    expect(undeclaredAction.issues).toEqual([{ path: '$.cases[0].steps[0].action', message: '未知动作「ui.drag」' }])
  })
})
