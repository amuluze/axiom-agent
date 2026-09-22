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
 */
export const BUILTIN_SKILL_BODIES_VERSION = 8

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
- <available_docs> 中 role="domain" 的既有 Domain Spec 与 .specs/domain/spec-authoring.md（Spec 书写规范）。
- 相关 .docs/ 实现现状与代码（区分「长期约束」与「当前实现事实」）。

# 执行步骤

1. 先读 .specs/domain/spec-authoring.md 与既有 Domain Spec，确认目标功能的领域边界是否已有文档覆盖；撞名或重叠时修订既有文档或改用更具体的主题词，不改写他人文件。
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
- Existing Domain Specs with role="domain" in <available_docs>, plus .specs/domain/spec-authoring.md (the spec authoring conventions).
- Relevant .docs/ implementation notes and code (separate "long-term constraints" from "current implementation facts").

# Execution steps

1. Read .specs/domain/spec-authoring.md and the existing Domain Specs first; check whether the feature's domain boundary is already covered. On name collisions or overlap, revise the existing document or pick a more specific topic; never rewrite files owned by other documents.
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
