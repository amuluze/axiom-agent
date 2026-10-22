import { describe, expect, it } from 'vitest'
import {
  auditTestSpecSources,
  collectSpecTraceabilityWarnings,
  diffSpecInventory,
  SPEC_AUDIT_MAX_BYTES,
  toSpecBaseline,
  type SpecSource,
} from './specAudit'

/** 生成一个合法用例文件的正文；`testPointIds` 非空时由首个用例认领全部测试点。 */
const specSource = (id: string, caseIds: readonly string[], testPointIds: readonly string[] = []): string =>
  JSON.stringify({
    kind: 'axiom.test',
    version: 2,
    id,
    name: id,
    target: {},
    ...(testPointIds.length > 0
      ? {
          testPoints: testPointIds.map((point) => ({
            id: point,
            kind: 'new_feature',
            title: point,
            acceptance: '可客观判定',
          })),
        }
      : {}),
    cases: caseIds.map((caseId, index) => ({
      id: caseId,
      name: caseId,
      ...(testPointIds.length > 0 && index === 0 ? { verifies: [...testPointIds] } : {}),
      steps: [{ id: `${caseId}-step`, action: 'api.request', method: 'GET', url: 'https://api.test/ping' }],
    })),
  })

/** 显式控制每个用例的 `verifies`，用于隔离「id 不变、追溯变了」的漂移。 */
const specWithCaseVerifies = (
  id: string,
  cases: readonly { id: string; verifies: readonly string[] }[],
  testPointIds: readonly string[],
): string =>
  JSON.stringify({
    kind: 'axiom.test',
    version: 2,
    id,
    name: id,
    target: {},
    testPoints: testPointIds.map((point) => ({
      id: point,
      kind: 'new_feature',
      title: point,
      acceptance: '可客观判定',
    })),
    cases: cases.map((testCase) => ({
      id: testCase.id,
      name: testCase.id,
      ...(testCase.verifies.length > 0 ? { verifies: [...testCase.verifies] } : {}),
      steps: [{
        id: `${testCase.id}-step`,
        action: 'api.request',
        method: 'GET',
        url: 'https://api.test/ping',
      }],
    })),
  })

const source = (path: string, content: string): SpecSource => ({ path, content })

describe('auditTestSpecSources', () => {
  it('keeps invalid files out of the coverage denominator', () => {
    const inventory = auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1', 'a-2'], ['tp-a'])),
      source('tests/b.testspec.json', '{ not json'),
      source('tests/c.testspec.json', JSON.stringify({ kind: 'axiom.test', id: 'c' })),
    ])

    expect(inventory.designed.map((file) => file.path)).toEqual(['tests/a.testspec.json'])
    expect(inventory.caseCount).toBe(2)
    expect(inventory.testPointCount).toBe(1)
    expect(inventory.invalid.map((file) => file.path)).toEqual(['tests/b.testspec.json', 'tests/c.testspec.json'])
    // 坏文件必须带解析器的原始问题清单，而不是被静默计成 0 条用例。
    expect(inventory.invalid[0]?.issues).toEqual([{ path: '$', message: 'JSON 解析失败' }])
    expect(inventory.invalid[1]?.issues.length).toBeGreaterThan(0)
  })

  it('sorts files by path and keeps declared case order', () => {
    const inventory = auditTestSpecSources([
      source('tests/z.testspec.json', specSource('z', ['z-1'])),
      source('tests/a.testspec.json', specSource('a', ['a-2', 'a-1'])),
    ])

    expect(inventory.files.map((file) => file.path)).toEqual(['tests/a.testspec.json', 'tests/z.testspec.json'])
    expect(inventory.designed[0]?.caseIds).toEqual(['a-2', 'a-1'])
    expect(inventory.designed[0]?.version).toBe(2)
  })

  it('applies the same 128 KiB host read cap as Axiom at runtime', () => {
    const huge = specSource('huge', ['huge-1'])
      .replace('https://api.test/ping', `https://api.test/${'x'.repeat(SPEC_AUDIT_MAX_BYTES)}`)
    const inventory = auditTestSpecSources([source('tests/huge.testspec.json', huge)])
    expect(inventory.designed).toHaveLength(0)
    expect(inventory.invalid[0]?.issues).toEqual([
      { path: '$', message: `文件超过用例读取上限（${SPEC_AUDIT_MAX_BYTES} 字节）` },
    ])
  })

  it('reports no drift when the inventory matches the baseline', () => {
    const inventory = auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1'], ['tp-a'])),
    ])
    expect(diffSpecInventory(inventory, toSpecBaseline(inventory))).toEqual([])
  })

  it('detects a removed case even when the file is otherwise identical', () => {
    const baseline = toSpecBaseline(auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1', 'a-2'])),
    ]))
    const current = auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1'])),
    ])
    expect(diffSpecInventory(current, baseline)).toEqual(['用例被删除：tests/a.testspec.json / a-2'])
  })

  it('detects renamed cases, removed files, added files and removed test points', () => {
    const baseline = toSpecBaseline(auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1', 'a-2'], ['tp-a', 'tp-b'])),
      source('tests/gone.testspec.json', specSource('gone', ['gone-1'])),
    ]))
    const current = auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1', 'a-renamed'], ['tp-a'])),
      source('tests/new.testspec.json', specSource('new', ['new-1'])),
    ])
    expect(diffSpecInventory(current, baseline)).toEqual([
      '文件被删除：tests/gone.testspec.json（基线 1 条用例）',
      '用例被删除：tests/a.testspec.json / a-2',
      '用例新增：tests/a.testspec.json / a-renamed',
      '测试点被删除：tests/a.testspec.json / tp-b',
      '用例追溯被删除：tests/a.testspec.json / a-1 -> tp-b',
      '新增文件：tests/new.testspec.json（1 条用例，需显式更新基线）',
    ])
  })

  it('detects dropped and added traceability while every id stays unchanged', () => {
    const baseline = toSpecBaseline(auditTestSpecSources([
      source('tests/a.testspec.json', specWithCaseVerifies(
        'a',
        [
          { id: 'a-1', verifies: ['tp-a', 'tp-b'] },
          { id: 'a-2', verifies: [] },
        ],
        ['tp-a', 'tp-b'],
      )),
    ]))
    // 把 tp-b 从 a-1 挪到 a-2：用例、测试点 id 全部不变，只有追溯关系变了。
    const drifted = auditTestSpecSources([
      source('tests/a.testspec.json', specWithCaseVerifies(
        'a',
        [
          { id: 'a-1', verifies: ['tp-a'] },
          { id: 'a-2', verifies: ['tp-b'] },
        ],
        ['tp-a', 'tp-b'],
      )),
    ])
    expect(diffSpecInventory(drifted, baseline)).toEqual([
      '用例追溯被删除：tests/a.testspec.json / a-1 -> tp-b',
      '用例追溯新增：tests/a.testspec.json / a-2 -> tp-b',
    ])

    const added = auditTestSpecSources([
      source('tests/a.testspec.json', specWithCaseVerifies(
        'a',
        [
          { id: 'a-1', verifies: ['tp-a', 'tp-b'] },
          { id: 'a-2', verifies: ['tp-b'] },
        ],
        ['tp-a', 'tp-b'],
      )),
    ])
    expect(diffSpecInventory(added, baseline)).toEqual([
      '用例追溯新增：tests/a.testspec.json / a-2 -> tp-b',
    ])
  })

  it('keeps v1 baselines comparable without traceability snapshots', () => {
    const current = auditTestSpecSources([
      source('tests/a.testspec.json', specWithCaseVerifies(
        'a',
        [{ id: 'a-1', verifies: ['tp-a', 'tp-b'] }],
        ['tp-a', 'tp-b'],
      )),
    ])
    const v1Baseline = {
      schemaVersion: 1 as const,
      files: {
        'tests/a.testspec.json': { caseIds: ['a-1'], testPointIds: ['tp-a', 'tp-b'] },
      },
    }
    expect(diffSpecInventory(current, v1Baseline)).toEqual([])
  })

  it('rejects a v2 baseline whose traceability snapshot is misaligned', () => {
    const current = auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1'], ['tp-a'])),
    ])
    const malformed = {
      schemaVersion: 2 as const,
      files: {
        'tests/a.testspec.json': { caseIds: ['a-1'], testPointIds: ['tp-a'], caseVerifies: [] },
      },
    }
    expect(diffSpecInventory(current, malformed)).toEqual([
      '基线格式错误：tests/a.testspec.json 的用例追溯数量与用例数量不一致',
    ])
  })

  it('reports traceability gaps as warnings without making the file invalid', () => {
    const inventory = auditTestSpecSources([
      source('tests/no-points.testspec.json', specSource('no-points', ['c1'])),
      source('tests/partial.testspec.json', specWithCaseVerifies(
        'partial',
        [
          { id: 'c1', verifies: ['tp-a', 'tp-b'] },
          { id: 'c2', verifies: [] },
        ],
        ['tp-a', 'tp-b'],
      )),
    ])

    expect(inventory.designed).toHaveLength(2)
    expect(collectSpecTraceabilityWarnings(inventory)).toEqual([
      { path: 'tests/no-points.testspec.json', message: 'v2 用例文件未声明 testPoints，覆盖统计没有分母' },
      { path: 'tests/partial.testspec.json', message: '用例未声明 verifies：c2' },
    ])
  })

  it('flags a file that turned into needs-repair instead of counting its cases as zero', () => {
    const baseline = toSpecBaseline(auditTestSpecSources([
      source('tests/a.testspec.json', specSource('a', ['a-1', 'a-2'])),
    ]))
    const current = auditTestSpecSources([source('tests/a.testspec.json', '{"kind":"axiom.test"}')])
    expect(diffSpecInventory(current, baseline)).toEqual([
      '文件现在需要修复：tests/a.testspec.json（用例从覆盖分母移除，基线 2 条）',
    ])
    expect(current.caseCount).toBe(0)
  })
})
