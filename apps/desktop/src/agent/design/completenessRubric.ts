/**
 * 设计稿完整度 rubric 的机器可读单一来源（与 `axParts.ts` 形态一致）。
 *
 * 数字与 design skill body 的 `# 完整度清单` 节镜像（zh `builtinSkillBodies.ts:485-507`、
 * en `:570-592`）。`completenessRubric.test.ts` parse 两侧文案的数字字面量并断言相等，
 * 防漂移——任何一边改了数值，另一边必须同步。
 *
 * 用途：
 * - 密度审计 `densityIssuesOf`（`designScan.ts`）—— `textNodeFloor` / `densityBareMinNodes`
 *   / `densityUnconsolidatedMinPrimitives` 决定何时报 warn
 * - 评测基线 `scripts/eval-design/bin/grade.mjs`——`grade.adminPageFloor` 等阈值取自此处
 * - `executeAxSummaryMode` 输出形如 `{ text, frame, component, part, icon }` 的 per-page
 *   密度字段（与 `AX_COMPLETENESS` 不直接重叠，但与口径同源）
 */
export const AX_COMPLETENESS = {
  /** 列表/表格最低行数（来自「≥ 8 rows of realistic data」） */
  textNodeFloor: 8,
  /** 导航项最低实例数（来自「≥ 8 nav items」） */
  navInstanceFloor: 8,
  /** 管理后台页数（来自「≥ 7 pages admin console」） */
  adminPageFloor: 7,
  /** 定价档最低数（来自「≥ 3 pricing tiers」） */
  pricingTierFloor: 3,
  /** 特性段最低数（来自「≥ 3 feature segments」） */
  featureSegmentFloor: 3,
  /** FAQ 最低数（来自「≥ 5 FAQ items」） */
  faqItemFloor: 5,
  /** KPI 卡最低数（来自「≥ 3 KPI cards」） */
  kpiCardFloor: 3,
  /** 密度 audit：text 节点 < 该阈值且 frame 数 ≥ 5 → densitySparse warn */
  densitySparseTextThreshold: 8,
  /** 密度 audit：frame 数 ≥ 该阈值视为「列表/表格样态」 */
  densitySparseShapeThreshold: 5,
  /** 密度 audit：节点总数 < 该阈值且无三态 → densityBare info */
  densityBareMinNodes: 10,
  /** 密度 audit：节点总数 > 该阈值且 component 实例 < 2 → densityUnconsolidated info */
  densityUnconsolidatedMinPrimitives: 30,
} as const

export type AxCompleteness = typeof AX_COMPLETENESS
