import type { ResolvedLanguage } from '@/i18n/locale'
import type { BuiltinSkillOverrideEntry } from '@/config/builtinPromptOverrides'

/**
 * 内置 SDD 工作流 Skill 正文（单一数据源）。
 *
 * 这 6 个 Skill 是**有正文的可加载指令**，经 load_skill 双通道返回
 * （项目 .axiom/skills/ 同名覆盖优先，否则回退到本模块）。
 *
 * 正文按语言双变体维护：zh-CN 是基线语言（历史契约字段，SPV/SDD 段只派生 name
 * 不受影响），en 为等价翻译——语言由 promptLocalizationHost 按 UI 偏好解析，
 * 用户可在设置页按语言覆写 description/body（config/builtinPromptOverrides）。
 */

/**
 * 内置 Skill 正文契约版本：name/description/body 都是模型可见内容（description 进
 * 系统提示词 <available_skills>，正文经 load_skill 进入对话），但二者均在 SPV 指纹
 * 排除的动态注入之列——本常量补上这道契约缺口，由
 * builtinSkillBodiesVersionContract.test.ts 与 contracts/builtin-skill-bodies-version.json
 * 做指纹单射绑定：改正文必须 bump 本版本（npm run sync:builtin-skill-version 写回）。
 * v8：正文重构为 zh-CN/en 双语言变体（zh-CN 逐字节不变），指纹覆盖全部语言变体。
 * v17：design skill 补 design_query 的 mode=component（单组件详单：props 契约 +
 * statics + fixture 数据形状）与组件节点注册表核对（读取时报错）的工作流说明。
 * v18：design skill 补 shadow 字段用法（卡片/弹层投影用 shadow，不用矩形模拟）——
 * 随 .ax 格式 1.3（frame/text/icon/rect/ellipse/path 增加可选 shadow）。
 * v24：design skill 补 symbols（文档内局部组件）——随 .ax 格式 1.4（顶层 symbols +
 * {$param} 绑定）：节点分级从三级变四级（component / symbol / part / 原语）、
 * 重复结构先抽 symbol 再实例化的写作指导、symbol 硬规则（参数只在文案位/枚举位且全必填、
 * body 禁 component/overlay、body id 全稿唯一、重名禁止）。
 * v25：design skill 拆「从零生成」分支（Path A：page inventory → 逐页写 + 单页 render
 * 自查 → 全稿 scan）+ 新增「完整度清单」节（通用最低线 + 管理后台 / 落地页 / 仪表盘
 * 默认页面集与分区密度）。把模型从「最小骨架」锚点挪到「完整稿」锚点。
 * v26：design skill 加「# 内置模式库」节——__fixtures__/patterns/ 下提供 9 个最小可工作
 * pattern（KpiCard/TableRow/NavItem/FilterChip/FormField/PricingTier/FaqItem/FeatureCard/
 * EmptyState），完整度清单中的重复结构优先复制 pattern 改 props。配套：completenessRubric
 * 单一来源常量（与 skill 数字镜像）+ densityIssuesOf 结构 audit（`mode=scan` 内置产出
 * densitySparse / densityBare / densityUnconsolidated 三类 warn / info）+ eval-design
 * 评测基线脚本（grade.mjs 量化对比任务期望值）。
 * v27：design skill 接项目根 DESIGN.md 轻量入口——前置输入列 DESIGN.md（在
 * <available_docs> 索引中以 role=design 可见），Path A 初始化 token 基调以其为准。
 * 配套：projectDocs 扫描根级 DESIGN.md（新增 design role，排在索引首位）。
 * v28：design skill 清理「自动方案探索」旧口径——专用面板已随 2026-10-05 UI 收窄
 * 移除，探索类工作回归会话内自行创建独立 .ax 的通用路径（zh/en 同步改写）。
 * v29：design skill 补 slots 插槽写法——随 .ax 格式 1.5（decl.slots 具名插槽契约）：
 * mode=component 详单新增 slots 段、节点 slot 内容归属 default 插槽且需声明契约、
 * 未声明插槽写内容解析即拒（zh/en 同步）。
 * v31：新增 test-design skill（第 8 个内置正文 Skill）——为指定功能编写可重放的
 * tests/*.testspec.json：先测试点（kind=new_feature|regression）再用例（verifies 追溯）、
 * 真实接口构造数据、typed 断言、原生接口清理，并列出禁止项（mock 造环境、只看返回码、
 * 固化 ref/tabId/坐标/宿主路径/Secret 明文、直接动被测库、顺手改产品源码、sleep 求绿、
 * 把探索轨迹当回归资产）。字段清单不复制，指向 docs/ui-api-automation-usage.md。
 * 配套：SDD 段从本名单派生，故同时 bump SYSTEM_PROMPT_VERSION（49 → 50）。
 */
/** v33：
 * 冷启动补缺——① domain/design 的 Axiom 内部资料（spec-authoring.md / design-canvas.md /
 * pattern 库 / tokens.css）改为「若存在」的可选输入，不再假定用户项目里有这些路径；
 * ② design 明确无 .axiom/design/components.json 时清单属于 Axiom 宿主注册表，只能
 * symbol/part/原语；③ token 基调改为 DESIGN.md → 项目 tokens → Axiom 基线三档；
 * ④ test-design 内联协议最小字段集（原「不复制字段」在无 Axiom 源码的项目里等于没字段）。
 */
/** v34：design skill 的内置模式库补可离线使用的「结构骨架」（9 个 pattern 的 props + body 节点骨架），
 * 并明确 pattern 目录属于 Axiom 应用源码、在用户项目里不可读属正常——否则完整度清单的
 * 「重复结构优先用 pattern」在最需要它的地方（新项目）无路可走。
 */
export const BUILTIN_SKILL_BODIES_VERSION = 34

export type BuiltinPromptLanguage = ResolvedLanguage

export interface BuiltinSkillBodyVariant {
  description: string
  body: string
}

export interface BuiltinSkillBody {
  name: string
  'zh-CN': BuiltinSkillBodyVariant
  en: BuiltinSkillBodyVariant
}

export const BUILTIN_SKILL_BODIES: readonly BuiltinSkillBody[] = [
  {
    name: 'domain',
    'zh-CN': {
      description: '根据用户要求围绕项目特定功能，按 Spec 书写规范生成 Domain Spec 到 .specs/domain/。',
      body: `# 目的

把用户围绕特定功能的领域要求，按照 Spec 书写规范（.specs/domain/spec-authoring.md）收敛成一份可验证的 Domain Spec，写入工作区 .specs/domain/ 目录。Domain Spec 定义核心领域概念、规则与不变量，是后续 Task Spec 与实现的最高约束来源，生命周期最长、永不归档。

# 何时进入

用户明确要求生成或补充 Domain Spec；或需求引入新的业务概念、长期不变量或架构边界，需要先立领域约束再进入 brainstorm/diagnose。已有可用 Domain Spec 时不重复生成，优先修订补充既有文档。

# 前置输入

- 用户围绕特定功能的需求描述。
- <available_docs> 中 role="domain" 的既有 Domain Spec。
- .specs/domain/spec-authoring.md（Spec 书写规范）：**若存在则先读**；新项目通常没有这份规范（它属于项目自己的资产），此时直接按本 Skill 执行步骤 4 的维度组织产出，不要因为规范缺失而停步，也不要在正文里引用不存在的规范文件。
- 相关 .docs/ 实现现状与代码（区分「长期约束」与「当前实现事实」）。

# 执行步骤

1. 若 .specs/domain/spec-authoring.md 存在则先读；不存在时跳过（新项目冷启动的常态），直接按第 4 步的维度组织。随后读既有 Domain Spec，确认目标功能的领域边界是否已有文档覆盖；撞名或重叠时修订既有文档或改用更具体的主题词，不改写他人文件。
2. 用只读工具核实 .docs/ 与代码，区分「已确认的领域事实」「需用户拍板的领域规则」；能查证的不问用户。
3. 只问仓库回答不了的问题：领域概念边界、规则与不变量取舍、错误与失败语义、非功能性约束；每次一个问题，附推荐与权衡，不把实现工作混进提问轮。
4. 按 spec-authoring.md 组织 Domain Spec：核心概念、规则与不变量、状态模型、错误条件与失败语义、结果约束（安全/兼容/迁移等）。
5. 每条关键约束必须可客观判定满足/不满足；只描述「系统应该做什么、允许/不允许发生什么」，避免具体文件路径（受管目录引用除外）、技术选型、执行步骤等「怎么实现」内容——实现指导下沉到 Plan。
6. 文件名用小写短横线主题词（如 sandbox-policy），输出到 .specs/domain/<topic>.md；如已有同名文档，修订而非覆盖。

# 产出物

- .specs/domain/<topic>.md（Domain Spec）。

# 退出条件

Domain Spec 符合 spec-authoring.md 的约束空间定义、每条关键约束可验证、与既有文档无冲突。之后由主 Agent 决定是否经 brainstorm/diagnose 引用它生成 Task Spec，或直接进入实现。`,
    },
    en: {
      description: 'Turn the user request around a specific feature into a verifiable Domain Spec under .specs/domain/, following the spec authoring conventions.',
      body: `# Purpose

Converge the user's domain requirements for a specific feature into one verifiable Domain Spec, following the spec authoring conventions (.specs/domain/spec-authoring.md), and write it into the workspace .specs/domain/ directory. The Domain Spec defines core domain concepts, rules and invariants; it is the highest binding source for subsequent Task Specs and implementation, has the longest lifecycle and is never archived.

# When to enter

The user explicitly asks to generate or extend a Domain Spec; or the requirement introduces new business concepts, long-lived invariants or architectural boundaries that need domain constraints settled before brainstorm/diagnose. If a usable Domain Spec already exists, do not regenerate it—revise and extend the existing document first.

# Required inputs

- The user's requirement description for the specific feature.
- Existing Domain Specs with role="domain" in <available_docs>.
- .specs/domain/spec-authoring.md (authoring conventions): **read it when present**. New projects usually lack it (it is the project's own asset) — then organize the document by step 4's dimensions instead of stopping or citing a file that does not exist.
- Relevant .docs/ implementation notes and code (separate "long-term constraints" from "current implementation facts").

# Execution steps

1. Read .specs/domain/spec-authoring.md when it exists; skip it otherwise (the cold-start norm for new projects) and organize by step 4's dimensions. Then read the existing Domain Specs; check whether the feature's domain boundary is already covered. On name collisions or overlap, revise the existing document or pick a more specific topic; never rewrite files owned by other documents.
2. Verify .docs/ and code with read-only tools; separate "confirmed domain facts" from "domain rules the user must decide". Anything verifiable should not be asked of the user.
3. Only ask what the repository cannot answer: domain concept boundaries, rule and invariant trade-offs, error and failure semantics, non-functional constraints. One question at a time with a recommendation and trade-offs; never mix implementation work into a questioning round.
4. Organize the Domain Spec per spec-authoring.md: core concepts, rules and invariants, state model, error conditions and failure semantics, result constraints (security/compatibility/migration etc.).
5. Every key constraint must be objectively decidable (met / not met); describe only "what the system must do and what may or may not happen". Avoid implementation content such as concrete file paths (except managed-directory references), technology choices and execution steps—implementation guidance belongs in the Plan.
6. Use lowercase kebab-case topic words for the file name (e.g. sandbox-policy) and write to .specs/domain/<topic>.md; if a document with the same name exists, revise it instead of overwriting.

# Outputs

- .specs/domain/<topic>.md (Domain Spec).

# Exit criteria

The Domain Spec fits the constraint space defined by spec-authoring.md, every key constraint is verifiable, and it conflicts with no existing document. Afterwards the main Agent decides whether to reference it via brainstorm/diagnose to produce a Task Spec, or to proceed straight to implementation.`,
    },
  },
  {
    name: 'brainstorm',
    'zh-CN': {
      description: '与用户对话澄清需求，产出 Task Spec 并同步检查/更新 Domain Spec。',
      body: `# 目的

把用户的一个模糊需求，通过与用户的问答收敛成一份可验证的 Task Spec，写入工作区 .specs/tasks/ 目录；若需求触及长期业务边界，先修订 .specs/domain/ 的 Domain Spec，而不是先写代码。

# 何时进入

新功能、复杂重构或边界不清晰的需求，需要先明确「系统必须满足什么」再谈实现。用户描述需求后、任何实现之前。

# 前置输入

- 用户的需求描述。
- 已检测到的项目文档索引（系统提示词的 <available_docs>）：先读 .specs/domain/ 下相关 Domain Spec 与 .docs/ 的实现现状，确认哪些是长期约束、哪些是当前事实。
- 现有代码与测试（能用只读工具查证的事实，不要问用户）。

# 执行步骤

1. 先做证据收集：读相关 Domain Spec、.docs/ 与代码，区分「已确认的事实」「仍需用户拍板的产品意图」「范围/风险决策」「大概率不在范围内」。
2. 若事实已能从仓库查证，就不要向用户提问；只问产品意图、偏好、范围边界、风险容忍度这类仓库回答不了的问题。
3. 每次只问一个最高价值的问题，附上你的推荐与权衡，然后停下等回答；不把实现工作混进提问轮。
4. 逐步把结论落进 .specs/tasks/ 的 Task Spec：目标、范围、验收标准（每条必须可客观判定满足/不满足）、边界与失败语义、排除项。task-id 用小写短横线主题词（如 fix-login-timeout）；同一任务的 Plan（.plans/<task-id>.md）与后续引用复用同一 id，与既有 Spec 撞名时改用更具体的 id、不改写他人文件。
5. 若需求触及长期不变量或业务边界，同步修订 .specs/domain/ 的 Domain Spec，并让 Task Spec 引用它，而不是在 Task Spec 里重复发明领域规则。
6. 收敛到无未决产品决策后，产出最终 Task Spec 并停止。

# 产出物

- .specs/tasks/<task-id>.md（Task Spec）。
- 视情况修订 .specs/domain/*.md（Domain Spec）。

# 退出条件

Task Spec 已完整且每条验收可验证、Domain Spec 已同步。之后由主 Agent 决定调用 inspect_subagent 审查；审查不通过则回到本 Skill 继续完善。`,
    },
    en: {
      description: 'Clarify requirements with the user, produce a Task Spec, and check/update the Domain Spec in sync.',
      body: `# Purpose

Converge one vague user requirement into a verifiable Task Spec through Q&A with the user, written into the workspace .specs/tasks/ directory; if the requirement touches long-lived business boundaries, revise the Domain Spec under .specs/domain/ first instead of writing code.

# When to enter

New features, complex refactors, or requirements with unclear boundaries where "what the system must satisfy" needs to be settled before implementation. After the user describes the requirement, before any implementation.

# Required inputs

- The user's requirement description.
- The detected project docs index (<available_docs> in the system prompt): read the relevant Domain Specs under .specs/domain/ and the implementation notes in .docs/ first; confirm which parts are long-term constraints and which are current facts.
- Existing code and tests (facts verifiable with read-only tools must not be asked of the user).

# Execution steps

1. Gather evidence first: read the relevant Domain Specs, .docs/ and code; separate "confirmed facts", "product intent still requiring the user's decision", "scope/risk decisions", and "most likely out of scope".
2. If a fact can be verified from the repository, do not ask the user; only ask about product intent, preferences, scope boundaries and risk tolerance—the questions a repository cannot answer.
3. Ask exactly one highest-value question at a time with your recommendation and trade-offs, then stop and wait for the answer; never mix implementation work into a questioning round.
4. Gradually land conclusions into the Task Spec under .specs/tasks/: goal, scope, acceptance criteria (each objectively decidable as met / not met), boundary and failure semantics, exclusions. Use lowercase kebab-case topic words for the task-id (e.g. fix-login-timeout); the Plan (.plans/<task-id>.md) and later references of the same task reuse the same id; on name collisions with existing Specs use a more specific id and never rewrite files owned by others.
5. If the requirement touches long-lived invariants or business boundaries, revise the Domain Spec under .specs/domain/ in sync and have the Task Spec reference it, instead of re-inventing domain rules inside the Task Spec.
6. Once no pending product decisions remain, produce the final Task Spec and stop.

# Outputs

- .specs/tasks/<task-id>.md (Task Spec).
- Revised .specs/domain/*.md (Domain Spec) when applicable.

# Exit criteria

The Task Spec is complete with every acceptance criterion verifiable, and the Domain Spec is in sync. Afterwards the main Agent decides to call inspect_subagent for review; if the review fails, return to this Skill and keep refining.`,
    },
  },
  {
    name: 'diagnose',
    'zh-CN': {
      description: '复现问题、定位根因并生成修复 Task Spec（含 Domain Spec 同步）。',
      body: `# 目的

把一个 bug 或异常行为，收敛成「可复现 + 根因明确 + 可验证修复」的 Task Spec，写入 .specs/tasks/；若问题暴露的是长期约束缺失，同步修订 .specs/domain/ 的 Domain Spec。

# 何时进入

复杂问题修复：现象明确但根因不明、可能牵涉跨层时序或既有不变量。简单的一行级修复不走本 Skill。

# 前置输入

- 问题现象（报错、日志、复现步骤）。
- <available_docs> 索引：先读 .specs/domain/ 的 Domain Spec（不变量、状态迁移、错误语义）与 .docs/ 的运行时/交接文档。
- 现有测试（定位「由哪个测试锁死」）。

# 执行步骤

1. 复现：用只读工具（read/grep/find）确认现象可稳定复现，记录复现条件；若会话已授予命令执行能力，必要时运行相关测试辅助复现。
2. 根因分析：沿调用链定位根因，说明「为什么错」而不只是「哪里错」；对照 Domain Spec 判断是否违反了既有不变量。
3. 若根因暴露 Domain Spec 的结构性缺口（而非实现 bug），先在 .specs/domain/ 补约束，再让修复 Task Spec 引用它。
4. 生成修复 Task Spec：目标（修复什么）、范围（只动必要的代码）、验收（用哪个测试/观测锁死修复）、回归风险。task-id 约定同 brainstorm（小写短横线主题词，撞名改用更具体的 id）。

# 产出物

- .specs/tasks/<task-id>.md（修复 Task Spec）。
- 视情况修订 .specs/domain/*.md。

# 退出条件

根因明确、修复 Task Spec 完整且可验证。之后由主 Agent 决定调用 inspect_subagent 审查；不通过则回到本 Skill 继续完善。`,
    },
    en: {
      description: 'Reproduce the problem, locate the root cause, and produce a fix Task Spec (with Domain Spec sync).',
      body: `# Purpose

Converge a bug or misbehavior into a Task Spec that is "reproducible + root-caused + verifiably fixable", written into .specs/tasks/; if the problem exposes a missing long-term constraint, revise the Domain Spec under .specs/domain/ in sync.

# When to enter

Complex fixes: symptoms clear but root cause unknown, possibly involving cross-layer timing or existing invariants. Trivial one-line fixes do not use this Skill.

# Required inputs

- The problem symptoms (errors, logs, reproduction steps).
- The <available_docs> index: read the Domain Specs under .specs/domain/ (invariants, state transitions, error semantics) and the runtime/handover docs in .docs/ first.
- Existing tests (to locate "which test locks this down").

# Execution steps

1. Reproduce: use read-only tools (read/grep/find) to confirm the symptom reproduces stably and record the reproduction conditions; if the session has command execution granted, run the relevant tests to help reproduce when necessary.
2. Root-cause analysis: trace the call chain to the root cause; explain "why it is wrong", not just "where it is wrong"; check against the Domain Spec whether an existing invariant was violated.
3. If the root cause exposes a structural gap in the Domain Spec (rather than an implementation bug), add the constraint under .specs/domain/ first, then have the fix Task Spec reference it.
4. Produce the fix Task Spec: goal (what is fixed), scope (only the necessary code), acceptance (which test/observation locks the fix down), regression risk. Follow the brainstorm task-id convention (lowercase kebab-case topic words; on collisions use a more specific id).

# Outputs

- .specs/tasks/<task-id>.md (fix Task Spec).
- Revised .specs/domain/*.md when applicable.

# Exit criteria

The root cause is clear and the fix Task Spec is complete and verifiable. Afterwards the main Agent decides to call inspect_subagent for review; if it fails, return to this Skill and keep refining.`,
    },
  },
  {
    name: 'plan',
    'zh-CN': {
      description: '依据 Task Spec 制定可落地的实施方案 Plan。',
      body: `# 目的

把一份已定稿的 Task Spec，拆解成可落地的实施方案 Plan，写入 .plans/。Plan 只描述「准备怎么实现」，不反向覆盖 Domain Spec、不重写 Task Spec 的验收定义。

# 何时进入

Task Spec 已通过审查（inspect_subagent 通过）之后、编码之前。

# 前置输入

- 已定稿的 Task Spec（.specs/tasks/<task-id>.md）。
- 相关 Domain Spec 与 .docs/ 的实现现状（确认可复用组件与约束）。

# 执行步骤

1. 逐条映射 Task Spec 的验收标准到具体实施步骤与验证动作（每个验收都能回答「由哪个改动 + 哪个测试/命令锁死」）。
2. 拆解实施步骤，说明顺序与依赖；标注关键风险与回滚/幂等语义。
3. 明确技术选型与边界，优先复用项目现有约定与已验证组件，不引入无必要的抽象。
4. 若实施路径发现 Task Spec 或 Domain Spec 有歧义/冲突，停下并回报，不擅自改写 Spec。

# 产出物

- .plans/<task-id>.md（实施方案）。

# 退出条件

Plan 覆盖全部验收、步骤可落地、风险已识别。之后由主 Agent 决定调用 examine_subagent 检查；不通过则回到本 Skill 继续优化。`,
    },
    en: {
      description: 'Turn a finalized Task Spec into an actionable implementation Plan.',
      body: `# Purpose

Break a finalized Task Spec into an actionable implementation Plan, written into .plans/. The Plan only describes "how implementation is going to happen"; it must not override the Domain Spec nor rewrite the Task Spec's acceptance definitions.

# When to enter

After the Task Spec has passed review (inspect_subagent passed), before coding.

# Required inputs

- The finalized Task Spec (.specs/tasks/<task-id>.md).
- Relevant Domain Specs and the implementation notes in .docs/ (to confirm reusable components and constraints).

# Execution steps

1. Map each acceptance criterion of the Task Spec to concrete implementation steps and verification actions (every acceptance must answer "which change + which test/command locks it down").
2. Decompose the implementation steps with ordering and dependencies; flag key risks and rollback/idempotency semantics.
3. Make technology choices and boundaries explicit; prefer reusing the project's existing conventions and proven components; introduce no unnecessary abstraction.
4. If the implementation path reveals ambiguity or conflicts in the Task Spec or Domain Spec, stop and report back; never rewrite Specs on your own authority.

# Outputs

- .plans/<task-id>.md (implementation Plan).

# Exit criteria

The Plan covers all acceptance criteria, its steps are actionable, and risks are identified. Afterwards the main Agent decides to call examine_subagent for inspection; if it fails, return to this Skill and keep refining.`,
    },
  },
  {
    name: 'implement',
    'zh-CN': {
      description: '按 Plan 推进编码，测试驱动，产出可验证的代码与测试。',
      body: `# 目的

按已定稿的 Plan 实现代码，遵循测试驱动：先写失败测试、再写最小实现、最后重构，产出代码 + 测试 + 验证证据。

# 何时进入

Plan 已通过检查（examine_subagent 通过）之后。

# 前置输入

- 已定稿的 Plan（.plans/<task-id>.md）。
- 对应 Task Spec 与 Domain Spec（实现受其约束）。

# 执行步骤

1. 先理解改动文件的现有约定（风格、导入、依赖），改动与周围代码一致。
2. 按 Plan 顺序逐个子步骤推进；每个子步骤：先写失败测试（RED）→ 跑测试确认失败 → 写最小实现（GREEN）→ 重构（保持测试通过）。测试不适用的改动（配置、样式、纯文档）以类型检查、构建或逐项自查作为该子步骤的验证动作。
3. 若实现中发现 Plan 有误、不可行或与实际代码结构冲突，停下回到 plan 修订，修订后重新通过 examine_subagent 检查再继续实现，不静默偏离 Plan；仅步骤顺序、命名这类无关紧要的微调可直接推进，并在验证证据中注明。
4. 遵循项目自身的硬约束与编码约定（如不可变边界、错误处理、输入验证）；不硬编码、不留调试残留；写操作按宿主的审批约定执行，不要试图绕过。
5. 每完成一个子步骤跑相关测试；声明完成前重读改动，检查遗留调试代码、未用导入与风格不一致。
6. 记录验证证据（类型检查、测试、必要时的命令结果），供 finish 阶段引用。

# 产出物

- 实现代码 + 测试（同目录 *.test.*）。
- 验证证据（测试/typecheck 结果）。

# 退出条件

Plan 覆盖的验收都有对应测试通过、typecheck 通过。之后由主 Agent 决定调用 review_subagent 审查；不通过则回到本 Skill 继续修改。`,
    },
    en: {
      description: 'Implement code plan-driven and test-first, producing verifiable code and tests.',
      body: `# Purpose

Implement code following the finalized Plan, test-first: write the failing test first, then the minimal implementation, then refactor—producing code + tests + verification evidence.

# When to enter

After the Plan has passed inspection (examine_subagent passed).

# Required inputs

- The finalized Plan (.plans/<task-id>.md).
- The corresponding Task Spec and Domain Spec (implementation is bound by them).

# Execution steps

1. Understand the existing conventions of the files being changed first (style, imports, dependencies); keep changes consistent with the surrounding code.
2. Proceed sub-step by sub-step in Plan order; for each sub-step: write the failing test (RED) → run tests to confirm failure → write the minimal implementation (GREEN) → refactor (tests stay green). For changes where tests do not apply (config, styling, pure docs), use type checking, build, or item-by-item self-review as that sub-step's verification action.
3. If implementation reveals the Plan to be wrong, infeasible, or conflicting with the actual code structure, stop and return to plan for revision, re-pass examine_subagent after revising, and only then continue implementing—never silently deviate from the Plan; only trivial adjustments (step ordering, naming) may proceed directly, noted in the verification evidence.
4. Follow the project's own hard constraints and coding conventions (e.g. immutability boundaries, error handling, input validation); no hardcoding, no leftover debug code; perform write operations under the host's approval conventions and never attempt to bypass them.
5. Run the relevant tests after each sub-step; before declaring completion re-read the changes checking for leftover debug code, unused imports, and style inconsistencies.
6. Record verification evidence (typecheck, tests, command results when necessary) for the finish phase to reference.

# Outputs

- Implementation code + tests (*.test.* in the same directory).
- Verification evidence (test/typecheck results).

# Exit criteria

Every acceptance criterion covered by the Plan has a corresponding passing test, and typecheck passes. Afterwards the main Agent decides to call review_subagent for review; if it fails, return to this Skill and keep fixing.`,
    },
  },
  {
    name: 'finish',
    'zh-CN': {
      description: '收尾：刷新文档对齐、任务分支提交推送、汇总验证证据与遗留项。',
      body: `# 目的

在实现与审查通过后收尾：让说明系统（.docs/、AGENTS.md/CLAUDE.md 与相关索引）与当前实现重新对齐，在任务分支上提交推送，汇总验证证据与遗留待办。

# 何时进入

代码改动已通过审查（review_subagent 通过）之后。

# 前置输入

- 本次 Task Spec、Plan、代码改动与验证证据；简单路径（implement 直连本 Skill、无 Task Spec/Plan）时以用户请求与审查/自查结论为基准，不为收口补写追溯性 Spec。
- <available_docs> 索引：判断哪些实现侧文档（.docs/）需要刷新以反映当前实现事实。

# 执行步骤

1. 刷新实现侧文档（.docs/）中因本次改动而过时的部分——它们记录「系统当前怎么运行」，不是长期设计意图（长期约束留在 Domain Spec）。
2. 若本次改动改变了项目约定入口（AGENTS.md/CLAUDE.md 描述的命令、架构边界、交接清单），同步更新。
3. 归档本次任务的 Task Spec 与 Plan：在 .specs/tasks/ 与 .plans/ 对应文档的 frontmatter 标记 status: done（已有 frontmatter 则更新其 status 字段，没有则在文件开头补一段）。归档文档会从 <available_docs> 活跃索引移出但保留追溯；Domain Spec 与 .docs/ 是长期/活文档，永不归档。简单路径（无 Task Spec/Plan）跳过本步。
4. 汇总验证证据：typecheck、测试、必要命令结果，形成收口结论——全链路任务写明「依据哪份 Task Spec、受哪些 Domain Spec 约束、通过哪些验证」，简单任务写明「依据哪份用户请求、通过哪些验证」。
5. 提交与推送：遵循系统提示词「# Git 分支规则」——先确认当前分支，严禁直接在 main 或 master 上提交推送；在任务分支上提交（分支前缀以该节为准、缺省 feat-，后缀用 task-id 或简短主题词；提交信息遵循项目自身的提交约定）并推送到远端同名分支，需要出站网络的命令按安全边界声明 network: true。除非用户明确要求不提交或另有分支安排。
6. 列出遗留项（未覆盖的边缘、后续建议），不擅自扩大范围。全部写操作与命令都按宿主的审批约定执行，不要试图绕过。

# 产出物

- 刷新后的 .docs/ 与 AGENTS.md/CLAUDE.md（如有必要）。
- 已归档（status: done）的 Task Spec 与 Plan（如有）。
- 任务分支上的提交（已推送，除非用户另有安排）。
- 收口总结（验证证据 + 遗留项）。

# 退出条件

说明系统与实现对齐、验证证据齐全、改动已按 Git 分支规则在任务分支提交推送、遗留项已显式列出。`,
    },
    en: {
      description: 'Wrap up: refresh docs alignment, commit and push the task branch, summarize verification evidence and leftovers.',
      body: `# Purpose

Wrap up after implementation and review pass: re-align the explanation system (.docs/, AGENTS.md/CLAUDE.md and related indexes) with the current implementation, commit and push on the task branch, and summarize verification evidence and leftover todos.

# When to enter

After the code changes have passed review (review_subagent passed).

# Required inputs

- This task's Task Spec, Plan, code changes and verification evidence; on the simple path (implement straight into this Skill, no Task Spec/Plan) use the user request and review/self-check conclusions as the baseline—do not write retroactive Specs just to close out.
- The <available_docs> index: judge which implementation-side docs (.docs/) need refreshing to reflect current implementation facts.

# Execution steps

1. Refresh the parts of implementation-side docs (.docs/) made stale by this change—they record "how the system currently runs", not long-term design intent (long-term constraints stay in the Domain Spec).
2. If this change altered the project's convention entry points (commands, architecture boundaries, handover lists described in AGENTS.md/CLAUDE.md), update them in sync.
3. Archive this task's Task Spec and Plan: mark status: done in the frontmatter of the matching documents under .specs/tasks/ and .plans/ (update the status field if frontmatter exists, otherwise prepend a frontmatter block). Archived docs leave the <available_docs> active index but remain traceable; Domain Specs and .docs/ are long-term/living documents and are never archived. Skip this step on the simple path (no Task Spec/Plan).
4. Summarize verification evidence: typecheck, tests, necessary command results, forming the closing conclusion—for full-chain tasks state "which Task Spec, constrained by which Domain Specs, verified by which checks"; for simple tasks state "which user request, verified by which checks".
5. Commit and push: follow the system prompt's "# Git branch rules"—confirm the current branch first; committing/pushing directly on main or master is strictly forbidden; commit on the task branch (branch prefix per that section, default feat-, suffix the task-id or a short topic; commit messages follow the project's own conventions) and push to the remote branch of the same name; commands needing outbound network declare network: true per the security boundary. Unless the user explicitly asked not to commit or arranged branches differently.
6. List leftover items (uncovered edges, follow-up suggestions) without expanding scope. All write operations and commands run under the host's approval conventions; never attempt to bypass them.

# Outputs

- Refreshed .docs/ and AGENTS.md/CLAUDE.md (when necessary).
- Archived (status: done) Task Spec and Plan (when present).
- Commits on the task branch (pushed, unless the user arranged otherwise).
- Closing summary (verification evidence + leftovers).

# Exit criteria

The explanation system is aligned with the implementation, verification evidence is complete, changes are committed and pushed on the task branch per the Git branch rules, and leftover items are explicitly listed.`,
    },
  },
  {
    name: 'design',
    'zh-CN': {
      description: '按设计即代码原则产出/修改工作区内的设计稿（.ax 唯一原生格式，.pen 仅为迁移输入）：从零生成按 Path A 走完整度清单收口，编辑模式按 Path B 定位子树、用 token 引用迭代样式，写后自查 JSON，让设计画布实时渲染投影。',
      body: `# 目的

把用户对界面/交互设计的意图收敛为对工作区内 .ax 设计稿的定点修改。设计画布是 .ax 文件的实时渲染投影（设计即代码）：模型改的是文件本身，画布自动跟随刷新，不是模型在画布上作画。

# 何时进入

用户要求新增/修改设计稿页面或组件、按画布效果迭代样式或布局；或设计画布显示解析诊断（ref 缺失、未知节点）需要修复设计稿。

# 前置输入

- 目标 .ax 设计稿路径（通常在 .pen/ 目录，可经 DesignView 文件栏确认）。
- 用户对设计的意图描述；有设计画布时可要求用户描述看到的实际渲染。
- 以下 Axiom 内部资料**只作背景参考，读不到属正常**（新项目工作区通常没有）：docs/design-canvas.md（渲染子集与语义说明）、apps/desktop/src/agent/design/__fixtures__/patterns/（pattern 库）、apps/desktop/src/styles/tokens.css（Axiom 自身 token）。读不到就按本 Skill 的规则继续，不要停步，也不要在稿件或生成代码里引用这些路径。
- 工作区没有 .axiom/design/components.json 时，design_query 返回的组件清单来自 **Axiom 宿主注册表**（sourcePath 指向 Axiom 自身源码，不是本项目实现）：不得把其中的组件写进本项目稿件与 codegen；此时节点只用 symbol / part / 原语，重复结构抽 symbol 表达。
- 项目根 DESIGN.md（若存在；在 <available_docs> 索引中以 role=design 出现）：品牌/视觉/交互基调与设计意图——从零生成前先读它，页面清单与 token 基调以其为准。

# 唯一设计稿格式与迁移

- **.ax**（Axiom 自有格式，**新稿一律用它**）：节点是四级闭集——优先 component（真组件实例：name 必须命中组件清单、props 过契约校验），其次 symbol（**本稿局部组件**（1.4）：顶层 symbols 声明 props 契约与 body 原语子树，页内用普通 component 节点实例化——body 的文案位（text/label/supporting）与枚举位（icon.name，1.6）写 {$param: 参数名} 引用参数，实例用 props 传值——参数**全必填**：文案位参数契约写 string，枚举位参数契约写 { enum: [值域] }；body 只写 part/原语（禁 component 与 overlay，无嵌套 symbol）；body 节点 id 需全稿唯一且不含保留分隔符 ~s:；symbol 名不得与组件清单或注册表重名。画布按实例展开渲染、codegen 发射为真实局部组件——复用边界直达实现），再次 part（语义部件：只写语义与变体，尺寸与内边距由实现侧决定；部件走词表——statusTag / divider / bubble / banner / actionButton / mentionBadge，字段越界与非法变体都会报错），最后才是 frame / text / icon / rect / ellipse / path / image 原语。**重复结构（表格行、导航项、卡片、定价档）先抽 symbol 再逐实例传参——同型结构逐份重写原语会在完善度与一致性上双输**。硬规则：组件必须来自清单；文案用字符串或 {$mock}（展示）/ {$bind}（数据源），组件的 json 型 props（工具调用的 call/result、消息对象等）用**结构化** {$mock}——直接把对象/数组写进绑定，不要包成 JSON 字符串；页用 group / state 表达同一 UI 的多状态；除 overlay 外**禁止绝对定位**（位置用 flex 与锚点语义）；弹窗/抽屉背后的整页遮罩用 overlay 的 scrim: {fill}（如半透明色，遮罩铺满父级、由实现渲染成 backdrop，不要用半透明矩形手搭，同一页可叠多个带 scrim 的 overlay）；卡片/弹层的投影用 shadow: {color, offsetX, offsetY, blur}（color 是 token 或字面色，偏移与 blur 是 px 数值，blur 不为负），不要用叠加半透明矩形模拟；lineHeight 必须写 {unit:'multiplier'|'px', value}；尺寸只接受数值(px) / token / fill_container / fit_content；token 用 $名称 引用顶层已声明项；未知字段一律报错（校验 fail-closed，错稿不会进画布）。组件节点的 name 与 props 会额外与组件注册表核对（组件不在注册表、props 键/必填/值型与契约不符都会在读取时报错并列出可用项）——写稿当场暴露，不必等画布渲染红框。
- **.pen**（pen.dev 格式，**存量与互操作**）：仅作为一次性迁移输入，不进入画布与 design_query。要在这份稿上长期迭代时，先用 design_import 把它迁移成 .ax（一次性、需审批；目标已存在会被拒绝），此后以 .ax 为准。

# 完整度清单

**这是「从零生成」路径的客观收口目标。** 单页文件、增量编辑或用户明确简化要求时可豁免；完整稿（Path A）必须对齐。mode=scan 仍只测合法性（不缺尺寸/不空白/无诊断），下列密度与覆盖目标由模型自检，mode=audit（后续）会逐步覆盖。

## 通用最低线（任何完整稿都适用）

- **列表/表格**：不少于 8 行真实感数据（人名/地址/订单号/指标值），不要 lorem/xxx/占位文案。
- **导航项**：侧栏或顶栏导航 不少于 8 项；新增图标导航同样按 8 项起算。
- **真实感文案**：标题/按钮/状态/字段名必须像真实产品——禁用「测试 1」「示例文本」「按钮」这类无信息字面值；用「订单管理」「保存草稿」「待发货」之类有产品语义的文案。
- **三态覆盖**：关键交互页（列表/详情/表单）用 group + state 表达**空 / 加载 / 错误**三态；空态给出具体引导文案与 CTA，不写「暂无数据」一笔带过。
- **设计稿 token 复用**：颜色/间距/圆角一律走 $token 引用，不内联硬编码值——便于暗色主题与跨稿一致。

## 管理后台默认页面集（不少于 7 页）

仪表盘（KPI 概览 + 主图表 + 最近活动）→ 列表页（含筛选栏、列定义、分页、行操作）→ 详情页（基本信息 + 时间线 + 关联资源）→ 表单页（创建/编辑，含字段校验提示位）→ 权限/角色管理 → 审计/操作日志 → 设置（账户、通知、集成）。每页至少覆盖其关键分区（列表页：筛选栏 + 列定义 + 分页 + 行操作；详情页：基本信息 + 时间线 + 关联资源），不要交一张空表页。

## 产品落地页默认分区（单页长稿，按序全覆盖）

Hero（标题 + 副标题 + 主 CTA + 次 CTA + 视觉锚点）→ 核心特性（不少于 3 段，每段图标 + 标题 + 描述）→ 社会证明（客户 logo + 数字指标 + 简短引用）→ 定价（不少于 3 档，每档名称 + 价位 + 特性清单 + CTA）→ FAQ（不少于 5 条问答）→ 主 CTA 复现 → 页脚（导航 + 法务 + 订阅位）。**Hero 与首屏价值主张是审稿第一眼**，密度再低也不能空。

## 数据仪表盘默认组成

KPI 行（不少于 3 张卡，每卡 label + value + delta/对比）→ 主图表区（折线/柱状/分布）→ 最近活动/列表（不少于 8 行，含状态 chip）→ 筛选/日期范围条。每个 KPI 必须给真实感数值与同比/环比变化（用 mock 数字但语义合理）。

# 内置模式库

该目录位于 Axiom 应用源码内，在用户项目工作区里通常不可读——**不可读属正常**：按下方「结构骨架」自建 symbol，不要因缺失而退回逐份手写原语。完整度清单中**重复结构的具体形态**优先用对应 pattern（目录可读时直接复制文件，否则按骨架自建；两种路径都必须抽 symbol，不得重复原语）：

- **KpiCard**：数据仪表盘的 KPI 行 / 落地页 Hero 下的指标。props: label / value / delta
- **TableRow**：列表页 / 订单管理 / 审计日志的标准行。props: col1 / col2 / col3 / col4
- **NavItem**：侧栏 / 顶栏导航项（「≥ 8 nav items」由此 pattern 实例凑齐）。props: label（图标为固定占位）
- **FilterChip**：列表页的筛选栏 / 顶栏标签切换。props: label
- **FormField**：表单页 / 落地页 CTA 区。props: label / placeholder
- **PricingTier**：落地页定价区（「≥ 3 pricing tiers」由此凑齐）。props: name / price / feature1 / feature2 / feature3
- **FaqItem**：落地页 FAQ 区（「≥ 5 FAQ items」由此凑齐）。props: question / answer
- **FeatureCard**：落地页核心特性区（「≥ 3 feature segments」由此凑齐）。props: title / description（图标为固定占位）
- **EmptyState**：列表 / 仪表盘的空态页（关键页 group+state 三态覆盖）。props: headline / supporting（图标为固定占位）

## 结构骨架（目录不可读时照此自建 symbol）

每行是 body 的节点骨架；参数只放文案位（text/label/supporting/question/answer/title/description/col1-col4/feature1-feature3），布局与颜色用 token，实例通过 props 传值。

- KpiCard：frame[column] → text(label, 小字) / text(value, 大号) / text(delta, 强调色)
- TableRow：frame[row] → text(col1..col4, 各自 fill_container) + part divider
- NavItem：frame[row] → icon(固定占位) + text(label)
- FilterChip：frame[row, 圆角全圆] → text(label)
- FormField：frame[column] → text(label) + frame[row, 输入框边框] → text(placeholder, 弱化)
- PricingTier：frame[column] → text(name) / frame[row] → text(price) + text(单位) / 3 个 text(feature1..3) / part actionButton（无目的时候用 text(CTA)）
- FaqItem：frame[column] → text(question, 加粗) + text(answer, 弱化)
- FeatureCard：frame[column] → icon(固定占位) + text(title) + text(description)
- EmptyState：frame[column, 居中] → icon(固定占位) + text(headline) + text(supporting)

**v1 限制**：pattern 的 body 参数化支持文案位（text/label/supporting）与枚举位（icon.name，1.6 起：契约写 { enum: [...] }，值域是闭集）；其余位置（颜色 fill、布局尺寸等）仍是 pattern 内置常量，要改就复制后改字面值，不要把 {$param} 写到 fill 等非参数位。

# 执行步骤

**先按目标稿状态选路径**：
- **Path A（从零生成）**：目标 .ax 不存在、pages 为空数组、或 design_query 解析失败——按下方 A 步骤产出**完整稿**，并对照 the Completeness rubric 收口。
- **Path B（编辑模式）**：目标稿已有有效页面，进行定点修改/迭代——按下方 B 步骤。

## Path A：从零生成

1. **初始化 token 与版式基调**：基调按三档取值——① 项目根 DESIGN.md（若存在）的品牌/视觉意图；② 项目已有的 token 来源（styles/tokens.css、theme 文件等，存在则复用）；③ 都没有时才用 Axiom 基线兜底。自加 token 需在稿顶层 tokens 登记并写明暗两档。
2. **产出页面清单**：每页给出 name、用途、对应的 the Completeness rubric 条目（管理后台 / 落地页 / 仪表盘三类之一，或自定）、关键分区列表。先把清单交给用户确认或直接继续。
3. **逐页写 + 单页自查**：每写完一页（component / symbol / part / 原语 四级节点；重复结构先抽 symbol 再逐实例传参），立即 design_query mode=render 视觉自查——通过再下一页。**完整稿 300-800KB 单次写入必撞模型单轮预算，本路径明确豁免「合并为一次 apply_changes」的编辑路径限制**：一页一页写是预期行为，不是碎片化。
4. **整稿收口**：全部页面写完后 design_query mode=scan 全稿扫描（结构 + 离屏渲染 + 空白检测），按 fail/warn 修复重扫至全绿。
5. **对照 the Completeness rubric 自检**：通用最低线达标、所选产品类型页面集/分区集无缺失、关键交互页含三态；缺页/缺分区/密度不足显式补齐后再交付。

## Path B：编辑模式

1. 定位目标节点：不整读设计稿（单文件可达 8MiB）。优先用 design_query：
   - 不传 page/nodeId → **摘要**（页清单：分组/状态/节点数/用到组件；组件清单：每个组件名对应真实源码路径与 props 契约；token 清单；稿内有 symbol 时另附 symbols 段：契约/body 规模/实例数）；
   - 传 page（页名或 1 起始序号）→ **该页已解析规格**（token 给出明暗两档字面值、树是作者视角的 .ax 节点、附该页组件清单）；
   - mode=component 传组件名 → **单组件详单**（props 契约 + statics + fixture 数据形状 + slots 插槽契约）：写 component 节点前先查一次，json 型 props 的结构化 {$mock} 照 fixture 数据形状写，不要读源码反推；要写节点 slot 内容前先确认详单 slots 段——节点 slot 内容归属 default 插槽，且须在 components.<名>.slots 声明 { default: { prop: children } } 形态契约，未声明插槽写内容会在解析时被拒；
   - 传 nodeId → 精确定位子树。
   也可用 grep/find 按 name、id 或子树关键词定位；确需通读时用分段 read，不要一次性吞入全文。
2. 以子树为单位编辑：只改目标节点的 JSON 片段，不动无关子树。颜色/间距/圆角一律用 $名称 引用既有 tokens（如 $color-accent、$space-gap），不内联硬编码色值；新 token 需先在设计稿顶层 tokens 登记。布局语义：flex 主轴/交叉轴、fill_container 表示拉伸、padding 顺序为 [上,右,下,左]。
3. 每轮迭代把全部修改合并为一次 apply_changes 批量补丁提交（冲突检测基于文件 sha256），不做碎片化多次写——每次写都会触发画布重渲染与全文件 diff。
4. 写后自查：调用 design_query 重查改动子树确认 JSON 结构合法（括号/逗号配对、children 数组完整），component 必须命中注册表并满足 props 契约；未知字段与节点按诊断修复，不静默忽略。多页改动或整稿完成后，用 design_query 的 mode=scan 做逐页渲染扫描（结构检查 + 离屏渲染 + 空白检测）：按返回的 fail/warn 页 issues 逐项修复，重扫直到全部页面 ok。
项目若有 .axiom/design/components.json，以该项目目录为唯一组件契约；它由 TypeScript 源码与 catalog.config.json 的 fixtures 生成，深层 fixture 类型错误必须先修复。外部组件在独立浏览器运行：先在目录配置声明本机 preview.url，经既有审批启动 design:preview 服务，再用 render/scan/compare 核对稿件 SHA、目录 SHA、页面、主题和尺寸；运行错误不能当作预览成功。Vue SFC 使用目标项目已有编译器分析 script setup 类型、默认值与事件，code 输出 Vue SFC；生成后跑 vue-tsc。store-bound 预览必须登记类型化 previewAdapter，fixture 作为独立状态快照注入；default 插槽只有声明契约时才生成和运行，业务实现仍须接线真实 store。实现验收需要严格门禁时，配置 .axiom/design/verification.json 的逐页本机路由与全部节点 selector；组件节点声明 source 和 occurrence。使用仓库 design:verify 校验真实导入、props、$bind、层级、明确的布局样式与同一 Chromium 基线；缺失覆盖、未知表达式、路由失败或视觉差异超阈值必须修复。仅在确认设计变更后显式 --update-baseline；浏览器/系统/字体/主题/尺寸变化也需重建基线，跨引擎 compare 不能替代此门禁。方案探索类请求（多方向变体）由会话自行创建独立 .ax（如 .pen/explore-<批次>-<序号>.ax），保持页面 id/group/state/尺寸，绝不覆盖原稿。原生导航、窗口动作与三个对话框可使用真实组件 fixture；导入旧稿时无法确定业务状态必须保留 primitive 并报告原因。
选中上下文 ax-selection@1 含 fileSha256、pageId、group/state 和原始绑定；先重查当前文件，按稳定 id 修改。

5. 需要实现代码时用 mode=code 生成骨架，fixture 属性会合并进组件；按 unresolved 接线数据源、回调与真实 store，再对生成代码执行类型检查。
6. 一轮迭代的验证以设计画布刷新后的渲染结果为准（画布监听文件变更实时刷新，10 秒慢轮询兜底）；画布报出解析诊断时按诊断信息修复。

# 产出物

- 更新后的 .ax 设计稿。
- 必要时同步 .docs/ 实现现状说明（如新增了影响实现的组件）。

# 退出条件

画布渲染结果与用户意图一致、无新增解析诊断；全部修改已合入一次批量补丁并写后自查通过；整稿级改动已通过 mode=scan 扫描（无 fail 页）。**Path A 从零生成的额外要求**：与 the Completeness rubric 对账——通用最低线达标、所属产品类型页面集/分区集无缺失、关键交互页含空/加载/错误三态。`,
    },
    en: {
      description: 'Author or edit workspace design documents (.ax is the only native format; .pen is migration input only) following design-as-code: from-zero generation follows Path A with the completeness rubric as the exit bar; edit mode follows Path B (locate subtrees, iterate styles via token references, self-check JSON after writes); the design canvas renders the live projection.',
      body: `# Purpose

Converge the user's UI/interaction design intent into targeted modifications of .ax design documents inside the workspace. The design canvas is a live render projection of the .ax file (design as code): the model edits the file itself and the canvas refreshes automatically — the model does not draw on the canvas.

# When to enter

The user asks to add or modify design pages/components, iterate styles or layout based on canvas appearance; or the design canvas shows parse diagnostics (missing refs, unknown nodes) that need fixing in the document.

# Required inputs

- The target .ax document path (usually under .pen/, confirmable via the DesignView file bar).
- The user's design intent; when the canvas is open, ask the user to describe what is actually rendered.
- The following Axiom-internal references are **background only — absence is normal** (new project workspaces usually lack them): docs/design-canvas.md, apps/desktop/src/agent/design/__fixtures__/patterns/ (pattern library), apps/desktop/src/styles/tokens.css. When unreadable, continue under this skill's rules; never cite those paths in the document or generated code.
- When the workspace has no .axiom/design/components.json, the component inventory returned by design_query comes from the **Axiom host registry** (sourcePath points at Axiom's own sources, not this project): do not use those components in this project's documents or codegen; use symbol / part / primitives only, and extract a symbol for repeated structures.
- Root DESIGN.md when present (shown in the <available_docs> index with role=design): brand/visual/interaction baseline and design intent — read it before from-zero generation; the page inventory and token baseline follow it.

# Sole design format and migration

- **.ax** (Axiom's native format — use it for all new work): nodes are a closed four-tier set — prefer component (real component instance: name must be in the component inventory, props must satisfy its contract), then symbol (**document-local component** (1.4): the top-level symbols map declares a props contract plus a primitive body subtree, instantiated in pages by ordinary component nodes — body text positions (text/label/supporting) and enum positions (icon.name, 1.6) reference params as {$param: name}, instances pass values via props, every param is **required**: text positions take string, enum positions take { enum: [domain] }; bodies carry parts/primitives only (no component, no overlay, no nesting); body node ids must be unique document-wide and free of the reserved separator ~s:; symbol names must not collide with the inventory or registry. The canvas renders instances by expansion and codegen emits real local components — the reuse boundary reaches the implementation), then part (semantic part: semantics and variant only, metrics live in the implementation; parts come from a vocabulary — statusTag / divider / bubble / banner / actionButton / mentionBadge — and unknown kinds, invalid variants or out-of-contract fields are errors), and only then the frame / text / icon / rect / ellipse / path / image primitives. **Repeated structures (table rows, nav items, cards, pricing tiers): author a symbol once and pass params per instance — rewriting identical primitive blocks by hand loses on both completeness and consistency.** Hard rules: components must come from the inventory; text is a literal or {$mock} (display) / {$bind} (data source), and a component's json-typed props (tool-call call/result, message objects, …) take a **structured** {$mock} — write the object/array into the binding, never as a JSON string; pages express multi-state UI via group / state; absolute positioning is forbidden outside overlay (use flex plus anchor semantics); the full-page scrim behind a modal or drawer is expressed as overlay scrim: {fill} (e.g. a translucent color — the scrim fills the parent and the implementation renders it as a backdrop; never hand-build it from a translucent rectangle, and multiple scrim overlays may stack on one page); card/modal elevation uses shadow: {color, offsetX, offsetY, blur} (color is a token or literal, offsets and blur are px numbers, blur is never negative) — never fake it with stacked translucent rectangles; lineHeight must be {unit:'multiplier'|'px', value}; sizes accept a number (px), a token, fill_container, or fit_content; tokens are referenced as $name and must be declared at the top level; unknown fields are errors (validation is fail-closed — an invalid document never reaches the canvas). Component nodes are additionally cross-checked against the component registry (unknown component, props keys, required props, literal value types): mismatches fail at read time with the available options listed — exposure happens while authoring, not at canvas render.
- **.pen** (pen.dev format, legacy and interop): one-time migration input, excluded from the canvas and design_query. To keep iterating on such a document, first migrate it with design_import (one-off, approval-gated; existing targets are refused), then work on the .ax. New design intent goes into .ax.

# Completeness rubric

**This is the objective exit bar for the from-zero path.** Single-page files, incremental edits, or explicit user requests for simpler output may opt out; complete drafts (Path A) must align with it. mode=scan still only checks legality (no missing sizes, no blank pages, no diagnostics); the density and coverage targets below are self-checked by the model — mode=audit (forthcoming) will cover them progressively.

## Universal floor (any complete draft)

- **Lists / tables**: at least 8 rows of realistic data (names, addresses, order IDs, metric values). No lorem / xxx / placeholder copy.
- **Nav items**: sidebar or top-bar nav at least 8 items. Icon-only nav follows the same 8-item floor.
- **Realistic copy**: titles, buttons, status labels, and field names must read like a real product — never bare values like "Test 1", "Sample text", or "Button"; use product-semantic copy such as "Orders", "Save draft", "Awaiting shipment".
- **Three-state coverage**: key interactive pages (lists, details, forms) express **empty / loading / error** via group + state. Empty states include a concrete guidance line and CTA — never just "no data yet".
- **Token reuse**: colors, spacing, radii all go through $token references; no inline hardcoded values — supports dark theme and cross-doc consistency.

## Admin console default page set (at least 7 pages)

Dashboard (KPI overview + main chart + recent activity) → list page (filter bar, column definitions, pagination, row actions) → detail page (basic info + timeline + related resources) → form page (create/edit, with field validation hint slots) → permissions / role management → audit / activity log → settings (account, notifications, integrations). Each page must cover its key sections (list page: filter bar + columns + pagination + row actions; detail page: basic info + timeline + related resources) — never deliver an empty table page.

## Marketing landing page default sections (single long page, all sections in order)

Hero (title + subtitle + primary CTA + secondary CTA + visual anchor) → core features (at least 3 segments, each with icon + title + description) → social proof (customer logos + numeric metrics + brief quote) → pricing (at least 3 tiers, each with name + price + feature list + CTA) → FAQ (at least 5 Q&A pairs) → primary CTA repeat → footer (nav + legal + newsletter). **Hero and first-screen value proposition are the first thing reviewers see** — density may slip elsewhere but not here.

## Data dashboard default composition

KPI row (at least 3 cards, each with label + value + delta/comparison) → main chart area (line / bar / distribution) → recent activity list (at least 8 rows, with status chips) → filter / date-range bar. Each KPI needs realistic-looking numbers with period-over-period deltas (mock numbers, but semantically plausible).

# Built-in pattern library

That directory lives inside the Axiom application sources and is usually unreadable from a user project workspace — **absence is normal**: build the symbol from the skeleton below instead of hand-authoring primitive subtrees. When the **completeness rubric** calls for repeated structure, reach for the matching pattern (copy the file when readable, otherwise build from the skeleton — both paths must extract a symbol, never duplicate primitives):

- **KpiCard**: data-dashboard KPI row / hero-side metrics. props: label / value / delta
- **TableRow**: standard row for list pages / order management / audit log. props: col1 / col2 / col3 / col4
- **NavItem**: sidebar or top-bar nav entry (the "≥ 8 nav items" floor is hit by 8 instances of this). props: label (icon is a fixed placeholder)
- **FilterChip**: list-page filter bar / top-bar tab switcher. props: label
- **FormField**: form pages / landing-page CTA area. props: label / placeholder
- **PricingTier**: landing-page pricing section (the "≥ 3 pricing tiers" floor). props: name / price / feature1 / feature2 / feature3
- **FaqItem**: landing-page FAQ section (the "≥ 5 FAQ items" floor). props: question / answer
- **FeatureCard**: landing-page core-features section (the "≥ 3 feature segments" floor). props: title / description (icon is a fixed placeholder)
- **EmptyState**: empty state for list / dashboard pages (key-page group+state three-state coverage). props: headline / supporting (icon is a fixed placeholder)

## Structure skeletons (build the symbol from these when the files are unreadable)

Each line is the body skeleton; params go on text positions only (text/label/supporting/question/answer/title/description/col1-col4/feature1-feature3), layout and colors use tokens, instances pass values via props.

- KpiCard: frame[column] → text(label, small) / text(value, large) / text(delta, accent)
- TableRow: frame[row] → text(col1..col4, each fill_container) + part divider
- NavItem: frame[row] → icon(fixed placeholder) + text(label)
- FilterChip: frame[row, fully rounded] → text(label)
- FormField: frame[column] → text(label) + frame[row, input border] → text(placeholder, muted)
- PricingTier: frame[column] → text(name) / frame[row] → text(price) + text(unit) / 3 × text(feature1..3) / part actionButton (or text(CTA) when no matching part)
- FaqItem: frame[column] → text(question, bold) + text(answer, muted)
- FeatureCard: frame[column] → icon(fixed placeholder) + text(title) + text(description)
- EmptyState: frame[column, centered] → icon(fixed placeholder) + text(headline) + text(supporting)

**v1 limit**: pattern body parameterization supports text positions (text/label/supporting) and enum positions (icon.name, 1.6: declared as { enum: [...] }, a closed domain); everything else (fill colors, layout metrics) stays baked into the pattern — copy the file and edit the literal rather than wiring {$param} into fill / etc.

# Execution steps

**Pick a path by the state of the target document**:
- **Path A (from-zero generation)**: target .ax is missing, has an empty pages array, or fails design_query parse — follow the A steps below to produce a **complete draft** aligned with the the Completeness rubric.
- **Path B (edit mode)**: target has valid pages and you're making targeted edits — follow the B steps.

## Path A: from-zero generation

1. **Initialize tokens and visual baseline**: pick the baseline in three tiers — ① the root DESIGN.md brand/visual intent when present; ② existing project token sources (styles/tokens.css, theme files) when present; ③ the Axiom baseline only as the last resort. Newly added tokens must be declared in the doc's top-level tokens with light + dark values.
2. **Draft a page inventory**: for each page provide name, purpose, the matching the Completeness rubric entry (admin console / landing / dashboard, or your own), and key sections. Either confirm the inventory with the user first or proceed directly.
3. **Write per page + single-page self-check**: each page uses the four-tier node set (component / symbol / part / primitive; extract a symbol for repeated structures and pass params per instance); after each page, run design_query mode=render for a visual self-check — only move on once it passes. **A complete draft is 300-800 KB; a single write would blow the model's per-turn output budget, so this path explicitly opts out of the "merge into one apply_changes" rule from the edit path**: writing one page at a time is the expected behavior, not fragmentation.
4. **Document-level close**: once all pages are written, run design_query mode=scan across the whole doc (structure + offscreen render + blank detection); fix fail/warn issues and re-scan until green.
5. **Self-check against the Completeness rubric**: universal floor met, the chosen product-type page/section set has no missing entries, and key interactive pages cover the three states. Missing pages / sections / density gaps must be filled explicitly before delivery.

## Path B: edit mode

1. Locate the target node: do not read the whole document (a single file can reach 8 MiB). Prefer design_query:
   - without page/nodeId → **summary** (pages with group/state/node counts/components used, plus the component inventory: each component name mapped to its real source path and props contract, plus the token list; documents with symbols also carry a symbols section: contract, body size, instance counts);
   - with page (name or 1-based index) → **the fully resolved page spec** (tokens as light/dark literals, the tree as authored .ax nodes, plus the components used by that page);
   - mode=component with a component name → **the single-component contract detail** (props contract + statics + fixture data shapes + the slots contract): query it before writing a component node, and author json-typed structured {$mock} values following the fixture data shapes instead of reverse-engineering source code; before authoring node slot content confirm the slots section — node slot content belongs to the default slot and requires a { default: { prop: children } } contract declared under components.<name>.slots, and undeclared slot content is rejected at parse time;
   - with nodeId → the exact subtree.
   You may also use grep/find on name, id or subtree keywords; when a full read is unavoidable, read in segments — never swallow the whole file at once.
2. Edit per subtree: change only the target node's JSON fragment and leave unrelated subtrees untouched. Colors/spacing/radii must reference existing tokens via $name (e.g. $color-accent, $space-gap) instead of inlined hardcoded values; register new tokens in the document's top-level tokens first. Layout semantics: flex main/cross axes, fill_container means stretch, padding order is [top,right,bottom,left].
3. Merge all changes of one iteration into a single apply_changes batch patch (conflict detection is based on the file sha256); avoid fragmented multi-writes — every write triggers a canvas re-render and a full-file diff.
4. Self-check after writing: re-query the modified subtree via design_query to confirm the JSON is structurally valid (balanced braces/commas, complete children arrays); every component must match the registry and its props contract; fix unknown fields and node kinds using the diagnostics instead of silently ignoring them. After multi-page edits or before finishing the whole document, run design_query with mode=scan for a per-page render scan (structure checks + offscreen rendering + blank detection): fix each fail/warn page per its issues and rescan until every page is ok.
When .axiom/design/components.json exists, it is the project's sole component contract. Generate it from TypeScript sources and catalog.config.json fixtures; fix deep fixture type errors before proceeding. External components run in the isolated browser: declare a loopback preview.url in the catalog configuration, start design:preview through the existing approval flow, then use render/scan/compare to verify document and catalog SHA, page, theme and viewport. Runtime errors must not count as successful previews. Vue SFC contracts use the target project’s existing compiler to analyze script setup types, defaults and events; code emits a Vue SFC and must pass vue-tsc. Register a typed previewAdapter for store-bound previews; inject fixtures as isolated state snapshots. Only declared default slots are generated and rendered; wire real stores in business implementations. For strict implementation acceptance, configure per-page loopback routes and selectors for every node in .axiom/design/verification.json; component nodes require source and occurrence. Run the repository design:verify gate for real imports, props, $bind, hierarchy, declared layout styles and same-Chromium baselines. Fix missing coverage, unknown expressions, route errors and visual differences above the threshold. Use --update-baseline explicitly only after reviewing the design change; browser, OS, fonts, theme or viewport changes require new baselines. Cross-engine compare does not replace this gate. Variant-exploration requests create separate .ax files through the session itself (for example .pen/explore-<batch>-<n>.ax), preserving page id/group/state/viewport and never overwriting the source. Native navigation, window actions and the three dialogs support real component fixtures; ambiguous legacy business states must remain primitives with a reported reason.
The ax-selection@1 context carries fileSha256, pageId, group/state and authored bindings; re-query the current document and edit by stable id.

5. For implementation, generate the scaffold via mode=code. Fixture props are merged into components; connect data sources, callbacks and real stores listed in unresolved, then typecheck the generated code.
6. Validate each iteration against the canvas refresh result (the canvas re-renders automatically on sha256 change via file-change events with a 10-second polling fallback); when the canvas reports parse diagnostics, fix the document according to them.

# Outputs

- The updated .ax design document.
- .docs/ implementation notes when needed (e.g. a new component that affects implementation).

# Exit criteria

The canvas render matches the user's intent with no new parse diagnostics; all modifications were merged into a single batch patch and passed the post-write self-check; document-wide changes passed the mode=scan scan (no failed pages). **Additional requirement for Path A from-zero generation**: reconcile against the the Completeness rubric — universal floor met, the chosen product-type page/section set has no missing entries, key interactive pages cover empty/loading/error.`,
    },
  },  {
    name: 'test-design',
    'zh-CN': {
      description: '为工作区内指定功能编写可重放的自动化测试用例（tests/*.testspec.json 的测试点与用例）：先定测试点再写用例，用真实环境与真实接口构造数据，写 typed 断言与清理步骤。',
      body: `# 目的

把用户对某个功能的验收要求，收敛成工作区里**可重放的自动化测试用例**：先定测试点（testPoints），再写用例（cases），让回归由确定性 Runner 执行、不依赖模型。

# 何时进入

用户在测试页会话里要求为某功能 / 接口 / 流程编写或补全用例；或产品变更后既有用例的期待需要更新。只是想跑一遍看看，不需要本技能——直接在测试页点运行即可。

# 前置输入

- 目标功能的描述与**可客观判定的验收标准**（用户给的，或从需求文档与代码里读出的）。
- docs/ui-api-automation-usage.md：用例协议、字段与拒绝面（**Axiom 项目内的完整文档**：在 Axiom 仓库工作时先读它；新项目里通常不存在，此时以下节「协议最小字段集」为准，并把解析器的「需要修复」原因当作最终口径）。
- tests/environments/*.env.ax（若存在）：本地 / 远程档、就绪探针、允许引用的 Secret 名（明文只存在宿主 Secret 里）。
- 既有 tests/ 用例与命名习惯：补充优先，不要另起一套命名。

# 协议最小字段集（离线可用）

完整字段与拒绝面见 docs/ui-api-automation-usage.md（位于 Axiom 项目内）；新项目读不到它时以本节字段集 + 解析器报错（JSON path + 原因）为准，不要凭印象写字段。

- 顶层：kind:"axiom.test"、version:3、id、name、target{}、testPoints[]（必填、至少一个）、cases[]、可选 hooks{beforeAll,beforeEach,afterEach,afterAll}（每条都是普通步骤）。
- target：webBaseUrl / apiBaseUrl（\${env.WEB_BASE_URL} / \${env.API_BASE_URL}，也接受 / 开头站内相对路径）、viewport{width,height}。
- testPoints[]：id / kind（new_feature | regression）/ title / acceptance。
- cases[]：id / name / verifies[]（指本文件 testPoints 的 id）/ steps[]。
- UI 动作：ui.navigate(url) / ui.click(locator) / ui.input(locator,value) / ui.select(locator,value) / ui.press(key) / ui.wait(expect,可选 locator/timeoutMs/extract) / ui.assert(expect,可选 locator/extract) / ui.screenshot(可选 name)。
- locator：{testId} 优先，其次 {role,name,exact?}。
- UiExpectation：exists / visible / enabled / textEquals / textContains / valueEquals / urlEquals / urlContains / count。
- API 步骤 api.request：method / url / query / headers（值可为 {secretId:"apitest.xxx"}；authorization / cookie / x-api-key 等敏感头必须用引用）/ body + bodyMode(json|text|form，仅 POST/PUT/PATCH/DELETE) / redirect(manual|same-origin) / expect[] / extract。
- ApiExpectation：status / headerEquals / headerContains / bodyContains / jsonPointerExists / jsonPointerEquals / maxElapsedMs。
- 占位符：\${env.NAME}（仅 WEB_BASE_URL / API_BASE_URL）、\${vars.name}（前序 extract 产生）、\${run.id} / \${run.slug}（唯一测试数据标记）。
- 禁止字段：tabId、AX ref、截图像素、宿主绝对路径、Secret 明文、JS/shell 表达式、运行期 Artifact 路径——解析器 fail-closed 拒绝。

# 执行步骤

1. **先测试点**：把验收标准拆成逐个可判定的测试点，标 kind——new_feature（本次新增能力）或 regression（受影响的既有功能）。空泛的测试点（「功能正常」）不算点，改写成能被一条断言证明的说法。
2. **再写用例**：每个测试点至少一条用例，用例的 verifies 指向本文件 testPoints 里的 id；测试点无人认领或 verifies 悬空都会被判「需要修复」。
3. **认环境**：用例只写逻辑地址（如 \${env.API_BASE_URL}）与 Secret 引用名；真实地址在环境档或运行环境里。
4. **构造数据用真实接口**：前置构造写进用例步骤或 hooks，禁止用 mock / 桩数据顶替环境。
5. **控制面改动必须在数据面验证**：写清访问哪个地址、构造什么请求或页面操作、期望看到什么结果。
6. **清理**：清理步骤走产品的原生接口删掉自己造的数据，不要直接动被测数据库。
7. **收尾**：在测试页「重新扫描」确认校验通过；被判「需要修复」时按问题清单逐条改到通过，不要绕过。

# 每用例必备

| 项 | 要求 |
|---|---|
| 稳定定位 | testId 优先，其次 role + name；不要固化 ref、tabId、截图像素坐标 |
| 前置构造 | 显式步骤（或用 hooks）：造什么数据、调哪个接口、带哪些参数 |
| typed 断言 | 用协议里的断言原语（状态码、JSON Pointer、文本、元素状态、URL、数量），不写「看返回码」 |
| 清理 | 走产品原生接口；清理步骤与主步骤同样逐步审批，被拒绝也要如实记账 |
| 追溯 | 用例的 verifies 指向本文件 testPoints 的 id；改用例时同步改测试点 |

# 禁止

- 用 mock / 桩数据代替真实环境构造。
- 只看返回码，或把「没报错」当成功——断言必须能说明「什么值满足什么条件」。
- 固化 ref / tabId / 截图像素 / 宿主绝对路径 / Secret 明文。
- 直接操作被测数据库（改数据、清表、读表断言）。
- 顺手改产品源码：本会话的交付物是用例文件；要改源码请另开开发会话，或让用户选方向。
- 用 sleep 或无限重试求绿：等待要用协议里的等待与断言语义表达。
- 把探索期的工具调用轨迹当用例：ui_* / api_request 是一次性探索，不是回归资产。

# 产出物

- tests/<功能>.testspec.json：testPoints 与每个测试点对应的用例。
- 会话里回报：测试点清单、每个测试点对应的用例 id，以及**无法客观判定或需要用户确认的点**（如实说明，不要猜一个断言糊过去）。

# 退出条件

- 每个测试点都至少被一条用例认领，且用例的 verifies 指向存在的测试点。
- 在测试页「重新扫描」后目标文件校验通过，没有「需要修复」项。
- 会话里给出了测试点清单、对应用例 id 与无法客观判定的点。
- 没有为求快而 mock 环境、跳过断言、固化瞬时定位，或顺手改产品源码。
`,
    },
    en: {
      description: 'Write replayable automated test cases (test points and cases in tests/*.testspec.json) for a feature in the workspace: test points first, then cases, with real-environment setup, typed assertions and cleanup steps.',
      body: `# Purpose

Turn the user's acceptance requirements for a feature into **replayable automated test cases** in the workspace: define test points (testPoints) first, then write cases, so regression runs are executed by the deterministic runner and never depend on the model.

# When to enter

When the user asks, in the testing page session, to write or extend cases for a feature, API or flow; or when product changes require updating existing expectations. To merely run the suite once, this skill is unnecessary — click run on the testing page.

# Required inputs

- The feature description and **objectively checkable acceptance criteria** (given by the user, or read from requirement docs and code).
- docs/ui-api-automation-usage.md: the full case protocol, fields and rejection surface (**inside the Axiom repo**; read it when working there). New projects usually lack it — use the "Minimal protocol field set" section below, and treat the parser's needs-repair reasons as the final authority.
- tests/environments/*.env.ax (if present): local / remote mode, readiness probe, allowed Secret names (plaintext lives only in host secrets).
- Existing tests/ cases and naming habits: extend rather than invent a second convention.

# Minimal protocol field set (works offline)

The full protocol lives in docs/ui-api-automation-usage.md (inside the Axiom repo). When a new project lacks it, rely on the field set below plus the parser's needs-repair reasons (JSON path + cause) — never invent field names.

- Top level: kind:"axiom.test", version:3, id, name, target{}, testPoints[] (required, at least one), cases[], optional hooks{beforeAll,beforeEach,afterEach,afterAll} (each entry is an ordinary step).
- target: webBaseUrl / apiBaseUrl (\${env.WEB_BASE_URL} / \${env.API_BASE_URL}, also site-relative paths starting with /), viewport{width,height}.
- testPoints[]: id / kind (new_feature | regression) / title / acceptance.
- cases[]: id / name / verifies[] (ids from this file's testPoints) / steps[].
- UI actions: ui.navigate(url) / ui.click(locator) / ui.input(locator,value) / ui.select(locator,value) / ui.press(key) / ui.wait(expect, optional locator/timeoutMs/extract) / ui.assert(expect, optional locator/extract) / ui.screenshot(optional name).
- locator: {testId} first, then {role,name,exact?}.
- UiExpectation: exists / visible / enabled / textEquals / textContains / valueEquals / urlEquals / urlContains / count.
- API step api.request: method / url / query / headers (values may be {secretId:"apitest.xxx"}; sensitive headers such as authorization / cookie / x-api-key must use a reference) / body + bodyMode (json|text|form, POST/PUT/PATCH/DELETE only) / redirect (manual|same-origin) / expect[] / extract.
- ApiExpectation: status / headerEquals / headerContains / bodyContains / jsonPointerExists / jsonPointerEquals / maxElapsedMs.
- Placeholders: \${env.NAME} (WEB_BASE_URL / API_BASE_URL only), \${vars.name} (from an earlier extract), \${run.id} / \${run.slug} (unique test-data markers).
- Forbidden fields: tabId, AX ref, screenshot pixels, host absolute paths, plaintext secrets, JS/shell expressions, runtime Artifact paths — the parser rejects them fail-closed.

# Execution steps

1. **Test points first**: split the acceptance criteria into individually checkable points, each tagged kind — new_feature or regression (existing behaviour affected by the change). Vague points (the feature works) are not points; rewrite them into claims a single assertion can prove.
2. **Then cases**: at least one case per test point, with the case verifies list pointing at this file testPoints ids; unclaimed test points and dangling references are both reported as needs repair.
3. **Know the environment**: cases carry logical addresses (e.g. \${env.API_BASE_URL}) and Secret reference names only; real addresses live in the environment file or run environment.
4. **Build data through real endpoints**: setup belongs in case steps or hooks; never substitute mock/stub data for the environment.
5. **Verify control-plane changes on the data plane**: state which address is hit, what request or page action is performed, and what result is expected.
6. **Cleanup**: remove the data you created through the product own API, never by touching the database under test.
7. **Finish**: rescan on the testing page and confirm validation passes; when a case is reported as needs repair, fix it item by item instead of working around it.

# Every case needs

| Item | Requirement |
|---|---|
| Stable locators | testId first, then role + name; never persist ref, tabId or screenshot pixel coordinates |
| Setup | Explicit steps (or hooks): what data, which endpoint, which parameters |
| Typed assertions | Use the protocol assertion primitives (status code, JSON Pointer, text, element state, URL, count) instead of only checking the status code |
| Cleanup | Through the product own API; cleanup steps are approved like any other step, and refusals are recorded as such |
| Traceability | The case verifies list points at this file testPoints ids; update the test point when you change the case |

# Forbidden

- Replacing the real environment with mock/stub data.
- Treating a status code or no error as success — an assertion must state which value satisfies which condition.
- Persisting ref / tabId / screenshot pixels / host absolute paths / plaintext secrets.
- Touching the database under test (writing, truncating, or asserting by reading it directly).
- Editing product source along the way: this session deliverable is the case file; open a development session, or let the user pick the direction, when source changes are needed.
- Chasing green with sleeps or unbounded retries: express waiting with the protocol wait and assertion semantics.
- Turning exploration tool calls into cases: ui_* / api_request are one-off exploration, not regression assets.

# Outputs

- tests/<feature>.testspec.json: testPoints plus the cases for each point.
- In the session: the test point list, the case id for each point, and **any point that cannot be objectively judged or needs user confirmation** (say so; do not paper over it with a guessed assertion).

# Exit criteria

- Every test point is claimed by at least one case, and each case verifies list points at declared test points.
- Rescanning on the testing page reports the target file as valid, with no needs-repair items.
- The session reports the test point list, the case ids, and any point that cannot be objectively judged.
- No shortcuts were taken: no mocked environment, no skipped assertions, no persisted transient locators, no product source edits.
`,
    },
  },
]

export const BUILTIN_SKILL_BODY_NAMES: readonly string[] = BUILTIN_SKILL_BODIES.map((skill) => skill.name)

/** 按 name 查找内置正文 Skill；未命中返回 null。 */
export const findBuiltinSkillBody = (name: string): BuiltinSkillBody | null =>
  BUILTIN_SKILL_BODIES.find((skill) => skill.name === name) ?? null

/**
 * 解析某语言下的生效变体：覆写字段（设置页保存，per-language）优先，未覆写字段
 * 回落该语言内置默认。override 缺省时返回内置变体本身（无拷贝）。
 */
export const resolveBuiltinSkillVariant = (
  skill: BuiltinSkillBody,
  language: BuiltinPromptLanguage,
  override?: BuiltinSkillOverrideEntry,
): BuiltinSkillBodyVariant => {
  const base = skill[language]
  if (!override) return base
  return {
    description: override.description ?? base.description,
    body: override.body ?? base.body,
  }
}
