/**
 * 测试用例清单的离线审计与漂移检查（纯函数：零副作用、无 I/O、无宿主依赖）。
 *
 * 两个消费者共用这一份实现：
 * - 仓库门禁 `scripts/test-spec-audit.mjs`（也可接进用户自己项目的 CI）；
 * - 后续的覆盖统计（T3-4）。
 *
 * 为什么必须共用：有效性判定只能有一个来源。任何「第二套解析」都会让
 * 「CLI 说通过、Axiom 说需要修复」成为可能，而这恰恰是用户最难自查的一类故障。
 *
 * **分母纪律**：`designed` 只包含解析通过的文件；「需要修复」的文件单独列出，
 * 其用例数**绝不**按 0 计入分母——否则一个坏文件会让覆盖率虚高，删掉用例也能「变绿」。
 */
import { parseTestSpec, type TestSpecIssue } from './parseTestSpec'
import { byteLength } from '../../core/bytes'

/**
 * 用例文件的规范后缀。与设计稿 `.ax` 完全分开：设计稿是 `ax:` 头的视觉文档，
 * 用例文件是 `kind: "axiom.test"` 的 JSON 指令流，两者不应共用后缀。
 *
 * 选 `.testspec.json` 而不是更短的 `.test.json`：后者与其它测试工具的 fixture
 * 数据文件同族命名，会被发现面的后缀预筛误收并集体判「需要修复」。
 */
export const TEST_SPEC_SUFFIX = '.testspec.json'

/** 候选后缀之外的文件一律不进入用例清单，也不产生诊断（旧后缀已彻底停用，见 R1）。 */
export const isTestSpecPath = (path: string): boolean => path.endsWith(TEST_SPEC_SUFFIX)

/** 单个用例文件的审计结果。无效文件只有 `issues`，没有 id/用例清单。 */
export interface AuditedSpecFile {
  /** 相对审计根的 POSIX 路径，用于报告与基线键。 */
  path: string
  valid: boolean
  specId: string | null
  name: string | null
  version: number | null
  /** 有效文件：`cases[].id`（声明顺序）。 */
  caseIds: readonly string[]
  /**
   * 有效文件：每个用例声明的测试点（`cases[].verifies`），与 {@link caseIds} 同序；
   * 未声明追溯的用例为空数组。覆盖统计（T3-4）靠它把运行结果挂回测试点，
   * 因此**必须与解析器同源**——这里是该映射的唯一实现。
   */
  caseVerifies: readonly (readonly string[])[]
  /** 有效文件：`testPoints[].id`（声明顺序）。 */
  testPointIds: readonly string[]
  /** 无效文件：解析器给出的 JSON path 级原因。 */
  issues: readonly TestSpecIssue[]
}

export interface SpecInventory {
  /** 扫描到的全部文件（含无效），按 path 升序。 */
  files: readonly AuditedSpecFile[]
  /** 解析通过的文件——覆盖分母的唯一来源。 */
  designed: readonly AuditedSpecFile[]
  /** 判为「需要修复」的文件。 */
  invalid: readonly AuditedSpecFile[]
  /** designed 里的用例总数。 */
  caseCount: number
  /** designed 里的测试点总数。 */
  testPointCount: number
}

/** 审计输入的单个文件：`path` 是相对审计根的 POSIX 路径，`content` 是文件正文。 */
export interface SpecSource {
  path: string
  content: string
}

/**
 * 文件行数上限，与宿主读取面一致（`testSpecIndex` / `testRunPreparation` 都以
 * `readWorkspaceText(path, 0, 1000)` 读用例文件，超限即判「需要修复」）。
 * 离线审计必须用同一个上限，否则会出现「审计说通过、Axiom 说需要修复」。
 */
export const SPEC_AUDIT_MAX_LINES = 1_000

/**
 * 宿主单次 `read_workspace_text` 的输出字节上限（128 KiB）。行数之外还有这一道
 * 截断：一个 1000 行以内、但单行/整体超过 128 KiB 的合法 spec 会被宿主读成
 * 截断内容。离线审计必须同时复制字节上限，否则仍会与 Axiom 判定分叉。
 */
export const SPEC_AUDIT_MAX_BYTES = 128 * 1024

export interface AuditTestSpecOptions {
  /** 缺省 {@link SPEC_AUDIT_MAX_LINES}；仅为测试与特殊项目预留。 */
  maxLines?: number
}

const byPath = (left: AuditedSpecFile, right: AuditedSpecFile): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0

/**
 * 审计一批用例文件。输入视为不可信数据：解析失败的文件进 `invalid` 并携带
 * 解析器的原始问题清单（含 JSON path），不进 `designed`。
 */
export const auditTestSpecSources = (
  sources: readonly SpecSource[],
  options: AuditTestSpecOptions = {},
): SpecInventory => {
  const maxLines = options.maxLines ?? SPEC_AUDIT_MAX_LINES
  const files = sources

    .map((source): AuditedSpecFile => {
      if (source.content.split('\n').length > maxLines) {
        return {
          path: source.path,
          valid: false,
          specId: null,
          name: null,
          version: null,
          caseIds: [],
          caseVerifies: [],
          testPointIds: [],
          issues: [{ path: '$', message: `文件超过用例读取上限（${maxLines} 行）` }],
        }
      }
      if (byteLength(source.content) > SPEC_AUDIT_MAX_BYTES) {
        return {
          path: source.path,
          valid: false,
          specId: null,
          name: null,
          version: null,
          caseIds: [],
          caseVerifies: [],
          testPointIds: [],
          issues: [{ path: '$', message: `文件超过用例读取上限（${SPEC_AUDIT_MAX_BYTES} 字节）` }],
        }
      }
      const parsed = parseTestSpec(source.content)
      if (!parsed.ok) {
        return {
          path: source.path,
          valid: false,
          specId: null,
          name: null,
          version: null,
          caseIds: [],
          caseVerifies: [],
          testPointIds: [],
          issues: parsed.issues,
        }
      }
      return {
        path: source.path,
        valid: true,
        specId: parsed.spec.id,
        name: parsed.spec.name,
        version: parsed.spec.version,
        caseIds: parsed.spec.cases.map((testCase) => testCase.id),
        caseVerifies: parsed.spec.cases.map((testCase) => testCase.verifies ?? []),
        testPointIds: (parsed.spec.testPoints ?? []).map((point) => point.id),
        issues: [],
      }
    })
    .sort(byPath)

  const designed = files.filter((file) => file.valid)
  return {
    files,
    designed,
    invalid: files.filter((file) => !file.valid),
    caseCount: designed.reduce((total, file) => total + file.caseIds.length, 0),
    testPointCount: designed.reduce((total, file) => total + file.testPointIds.length, 0),
  }
}

/** 基线快照的单个文件条目：只存 id 清单，因此改名与删除都能被看见（计数相同不算漂移豁免）。 */
export interface SpecBaselineEntry {
  caseIds: readonly string[]
  testPointIds: readonly string[]
  /**
   * v2 基线起：与 `caseIds` 同序的用例→测试点追溯快照。少了它，把 `verifies`
   * 从某个用例上悄悄删掉不会改变任何 id，覆盖却会退化成「未运行」。
   * v1 基线没有这个字段，继续按旧维度比对（否则升级审计器会要求所有历史基线重生成）。
   */
  caseVerifies?: readonly (readonly string[])[]
}

export interface SpecBaseline {
  schemaVersion: 1 | 2
  files: Readonly<Record<string, SpecBaselineEntry>>
}

export const SPEC_BASELINE_SCHEMA_VERSION = 2

/** 由当前清单生成基线快照（需要显式写回，绝不自动更新）。 */
export const toSpecBaseline = (inventory: SpecInventory): SpecBaseline => ({
  schemaVersion: SPEC_BASELINE_SCHEMA_VERSION,
  files: Object.fromEntries(
    inventory.files
      .map((file): [string, SpecBaselineEntry] => [
        file.path,
        {
          caseIds: [...file.caseIds],
          testPointIds: [...file.testPointIds],
          caseVerifies: file.caseVerifies.map((ids) => [...ids]),
        },
      ])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ),
})

const difference = (current: readonly string[], previous: readonly string[]): string[] =>
  current.filter((id) => !previous.includes(id))

/**
 * 比较当前清单与基线，输出人类可读的漂移问题（稳定顺序、空数组即一致）。
 *
 * 覆盖五类静默漂移：文件被删除、文件被新增、文件内的用例/测试点被删除或新增、
 * 用例→测试点追溯被删除或新增、文件从有效变成「需要修复」（后者最危险——用例会从
 * 覆盖分母里消失，只数总数看不出来）。
 */
export const diffSpecInventory = (inventory: SpecInventory, baseline: SpecBaseline): string[] => {
  const problems: string[] = []
  const current = new Map(inventory.files.map((file) => [file.path, file]))
  const baselinePaths = Object.keys(baseline.files).sort()

  for (const path of baselinePaths) {
    if (!current.has(path)) {
      problems.push(`文件被删除：${path}（基线 ${baseline.files[path]?.caseIds.length ?? 0} 条用例）`)
    }
  }
  for (const file of inventory.files) {
    const entry = baseline.files[file.path]
    if (entry === undefined) {
      problems.push(`新增文件：${file.path}（${file.caseIds.length} 条用例，需显式更新基线）`)
      continue
    }
    if (!file.valid) {
      problems.push(`文件现在需要修复：${file.path}（用例从覆盖分母移除，基线 ${entry.caseIds.length} 条）`)
      continue
    }
    for (const id of difference(entry.caseIds, file.caseIds)) {
      problems.push(`用例被删除：${file.path} / ${id}`)
    }
    for (const id of difference(file.caseIds, entry.caseIds)) {
      problems.push(`用例新增：${file.path} / ${id}`)
    }
    for (const id of difference(entry.testPointIds, file.testPointIds)) {
      problems.push(`测试点被删除：${file.path} / ${id}`)
    }
    for (const id of difference(file.testPointIds, entry.testPointIds)) {
      problems.push(`测试点新增：${file.path} / ${id}`)
    }
    const previousVerifies = entry.caseVerifies
    if (previousVerifies === undefined) continue
    if (previousVerifies.length !== entry.caseIds.length) {
      problems.push(`基线格式错误：${file.path} 的用例追溯数量与用例数量不一致`)
      continue
    }
    const currentIndexes = new Map(file.caseIds.map((id, index) => [id, index]))
    for (const [index, caseId] of entry.caseIds.entries()) {
      const currentIndex = currentIndexes.get(caseId)
      // 用例本身增删已单独报告；只比较两侧都存在的用例的追溯变化。
      if (currentIndex === undefined) continue
      const previous = previousVerifies[index] ?? []
      const next = file.caseVerifies[currentIndex] ?? []
      for (const point of difference(next, previous)) {
        problems.push(`用例追溯新增：${file.path} / ${caseId} -> ${point}`)
      }
      for (const point of difference(previous, next)) {
        problems.push(`用例追溯被删除：${file.path} / ${caseId} -> ${point}`)
      }
    }
  }
  return problems
}

/** 追溯完整性问题：只提示、不参与退出码（v2 的 testPoints 仍按协议保持可选）。 */
export interface SpecAuditWarning {
  path: string
  message: string
}

/**
 * 覆盖统计依赖 `testPoints` + `cases[].verifies` 两段声明。协议为向后兼容没有把
 * 它们设成必填，因此缺失时不会让文件「需要修复」，但会让覆盖静默停在「未运行」。
 * 离线审计把这类形态显式列出来，避免 CI 通过而覆盖没有任何意义。
 */
export const collectSpecTraceabilityWarnings = (inventory: SpecInventory): SpecAuditWarning[] => {
  const warnings: SpecAuditWarning[] = []
  for (const file of inventory.designed) {
    if (file.version === 2 && file.testPointIds.length === 0) {
      warnings.push({ path: file.path, message: 'v2 用例文件未声明 testPoints，覆盖统计没有分母' })
      continue
    }
    // v1 协议没有测试点概念，不按 v2 的追溯契约要求它。
    if (file.testPointIds.length === 0) continue
    for (const [index, caseId] of file.caseIds.entries()) {
      if ((file.caseVerifies[index] ?? []).length === 0) {
        warnings.push({ path: file.path, message: `用例未声明 verifies：${caseId}` })
      }
    }
  }
  return warnings
}
