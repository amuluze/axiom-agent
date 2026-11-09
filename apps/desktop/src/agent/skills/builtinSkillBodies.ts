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
 * v31：新增测试创作 skill（初名 test-design，v41 更名 test-authoring；第 8 个内置正文 Skill）——为指定功能编写可重放的
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
 * ④ test-authoring 内联协议最小字段集（原「不复制字段」在无 Axiom 源码的项目里等于没字段）。
 */
/** v34：design skill 的内置模式库补可离线使用的「结构骨架」（9 个 pattern 的 props + body 节点骨架），
 * 并明确 pattern 目录属于 Axiom 应用源码、在用户项目里不可读属正常——否则完整度清单的
 * 「重复结构优先用 pattern」在最需要它的地方（新项目）无路可走。
 */
/** v41：内置测试创作 Skill 由 test-design 更名为 test-authoring（名称与文档「测试创作」对齐；协议与正文语义不变）。 */
/** v43：证据规则一致性修复——diagnose 有界复现且不提前改代码/提交，implement 测试豁免与 INCONCLUSIVE 出口一致，test-authoring 禁止为制造失败改产品源码且 verify 引用环境档，domain 修正步骤引用，design 探索证据进入收口。 */
/** v44：test-authoring 的环境档引用从 `*.env.ax` 改为 `*.env.axiom`——`.ax` 是设计稿专属后缀，测试档整体切走（扫描器同步只认新后缀，不兼容旧名）。 */
/** v45：design skill 补审美层——新增「审美定位」节（主题锚定、设计计划与相似需求自审、反默认清单、
 * 排版/结构/动效/文案规则、克制），并把项目根 DESIGN.md 升级为带最小结构契约的基调输入
 * （缺失时提案后回写，已存在只补缺）。补丁定位：完整度清单只管覆盖度下限，pattern 只管结构底座。 */
/** v46：DESIGN.md 正文改由系统提示词以 `<project_design>` 注入（16 KiB 上限），design skill 的
 * 「必须先 read」口径改为「以注入块为准，仅在未注入或被截断时 read」，避免每轮重复整读。 */
export const BUILTIN_SKILL_BODIES_VERSION = 46

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
- .specs/domain/spec-authoring.md（Spec 书写规范）：**若存在则先读**；新项目通常没有这份规范（它属于项目自己的资产），此时直接按本 Skill 执行步骤 5 的维度组织产出，不要因为规范缺失而停步，也不要在正文里引用不存在的规范文件。
- 相关 .docs/ 实现现状与代码（区分「长期约束」与「当前实现事实」）。

# 执行步骤

1. 若 .specs/domain/spec-authoring.md 存在则先读；不存在时跳过（新项目冷启动的常态），直接按第 5 步的维度组织。随后读既有 Domain Spec，确认目标功能的领域边界是否已有文档覆盖；撞名或重叠时修订既有文档或改用更具体的主题词，不改写他人文件。
2. 用只读工具核实 .docs/ 与代码，区分「已确认的领域事实」「需用户拍板的领域规则」；能查证的不问用户。
3. 写长期约束前先追溯来源：它来自业务意图、事故、外部约束，还是当前实现的偶然？最后一种不写成 Domain Spec 不变量；如必须保留，标为实现事实而不是领域规则。
4. 只问仓库回答不了的问题：领域概念边界、规则与不变量取舍、错误与失败语义、非功能性约束；每次一个问题，附推荐与权衡，不把实现工作混进提问轮。
5. 按 spec-authoring.md 组织 Domain Spec：核心概念、规则与不变量、状态模型、错误条件与失败语义、结果约束（安全/兼容/迁移等）。
6. 每条关键约束必须可客观判定满足/不满足；只描述「系统应该做什么、允许/不允许发生什么」，避免具体文件路径（受管目录引用除外）、技术选型、执行步骤等「怎么实现」内容——实现指导下沉到 Plan。数值阈值必须写清测量方法、limiter 和适用范围；无法解释的阈值标为待验证假设，不伪装成领域不变量。
7. 文件名用小写短横线主题词（如 sandbox-policy），输出到 .specs/domain/<topic>.md；如已有同名文档，修订而非覆盖。

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
- .specs/domain/spec-authoring.md (authoring conventions): **read it when present**. New projects usually lack it (it is the project's own asset) — then organize the document by step 5's dimensions instead of stopping or citing a file that does not exist.
- Relevant .docs/ implementation notes and code (separate "long-term constraints" from "current implementation facts").

# Execution steps

1. Read .specs/domain/spec-authoring.md when it exists; skip it otherwise (the cold-start norm for new projects) and organize by step 5's dimensions. Then read the existing Domain Specs; check whether the feature's domain boundary is already covered. On name collisions or overlap, revise the existing document or pick a more specific topic; never rewrite files owned by other documents.
2. Verify .docs/ and code with read-only tools; separate "confirmed domain facts" from "domain rules the user must decide". Anything verifiable should not be asked of the user.
3. Before writing a long-lived constraint, trace its source: business intent, an incident, an external constraint, or an accident of the current implementation? Never encode the last one as a Domain Spec invariant; when it must stay, mark it as an implementation fact rather than a domain rule.
4. Only ask what the repository cannot answer: domain concept boundaries, rule and invariant trade-offs, error and failure semantics, non-functional constraints. One question at a time with a recommendation and trade-offs; never mix implementation work into a questioning round.
5. Organize the Domain Spec per spec-authoring.md: core concepts, rules and invariants, state model, error conditions and failure semantics, result constraints (security/compatibility/migration etc.).
6. Every key constraint must be objectively decidable (met / not met); describe only "what the system must do and what may or may not happen". Avoid implementation content such as concrete file paths (except managed-directory references), technology choices and execution steps—implementation guidance belongs in the Plan. Numeric thresholds must state the measurement method, limiter and applicable range; a threshold you cannot explain is a hypothesis, not a domain invariant.
7. Use lowercase kebab-case topic words for the file name (e.g. sandbox-policy) and write to .specs/domain/<topic>.md; if a document with the same name exists, revise it instead of overwriting.

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

1. 先复述：用三句话写清目标、要解决的问题、预期的最小改动。不要等确认，先复述再提问；复述暴露误读时先纠正，再进入证据收集。
2. 先做证据收集：读相关 Domain Spec、.docs/ 与代码，区分「已确认的事实」「仍需用户拍板的产品意图」「范围/风险决策」「大概率不在范围内」。
3. 若事实已能从仓库查证，就不要向用户提问；只问产品意图、偏好、范围边界、风险容忍度这类仓库回答不了的问题。
4. 每次只问一个最高价值的问题，附上你的推荐与权衡，然后停下等回答；不把实现工作混进提问轮。
5. 逐步把结论落进 .specs/tasks/ 的 Task Spec：目标、范围、验收标准（每条必须可客观判定满足/不满足）、边界与失败语义、排除项。task-id 用小写短横线主题词（如 fix-login-timeout）；同一任务的 Plan（.plans/<task-id>.md）与后续引用复用同一 id，与既有 Spec 撞名时改用更具体的 id、不改写他人文件。
6. 验收草稿用四问自检：这个领域的专家会多做哪一步，而用户没要求？他们会从什么最原始的材料开始？他们会用什么具体方法或工具？除了你我，什么能证明结果是对的？只把答案落进验收标准或验证动作，不扩大范围。
7. 若需求触及长期不变量或业务边界，同步修订 .specs/domain/ 的 Domain Spec，并让 Task Spec 引用它，而不是在 Task Spec 里重复发明领域规则。
8. 收敛到无未决产品决策后，产出最终 Task Spec 并停止。

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

1. Restate first: state the goal, the problem and the expected smallest change in three sentences. Do not wait for confirmation; restate before asking. When the restatement exposes a misread, correct it before gathering evidence.
2. Gather evidence first: read the relevant Domain Specs, .docs/ and code; separate "confirmed facts", "product intent still requiring the user's decision", "scope/risk decisions", and "most likely out of scope".
3. If a fact can be verified from the repository, do not ask the user; only ask about product intent, preferences, scope boundaries and risk tolerance—the questions a repository cannot answer.
4. Ask exactly one highest-value question at a time with your recommendation and trade-offs, then stop and wait for the answer; never mix implementation work into a questioning round.
5. Gradually land conclusions into the Task Spec under .specs/tasks/: goal, scope, acceptance criteria (each objectively decidable as met / not met), boundary and failure semantics, exclusions. Use lowercase kebab-case topic words for the task-id (e.g. fix-login-timeout); the Plan (.plans/<task-id>.md) and later references of the same task reuse the same id; on name collisions with existing Specs use a more specific id and never rewrite files owned by others.
6. Self-check the acceptance draft with four questions: what would a domain expert do that the user did not ask for? What rawest material would they start from? Which concrete methods or tools would they use? Apart from you and the user, what proves the result is right? Fold only the answers into acceptance or verification actions; do not expand scope.
7. If the requirement touches long-lived invariants or business boundaries, revise the Domain Spec under .specs/domain/ in sync and have the Task Spec reference it, instead of re-inventing domain rules inside the Task Spec.
8. Once no pending product decisions remain, produce the final Task Spec and stop.

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

1. 在匹配表面复现：UI 走真实页面，CLI 跑真实命令，API 发真实请求。不能直接复现时，按候选假设合成触发条件、收紧条件或加插桩，并记录每轮观察；重复尝试已不再产生能区分假设的新信息时，停止复现循环，写明已尝试路径与最接近的可执行检查，不伪造证据。若会话已授予命令执行能力，用相关测试或命令辅助复现。
2. 二分假设：列出候选机制，每轮选择能最大削减问题空间的观测；拿到运行证据后再排除。不要从最可疑的代码位置直接改。
3. 若两个修复共享同一前提且都失败，停下：写下前提，找一个「前提为假就会不同」的观测，先测前提。
4. 根因分析：沿调用链定位根因，说明「为什么错」而不只是「哪里错」；对照 Domain Spec 判断是否违反了既有不变量。小 diff 高风险时，找出「为什么安全」的唯一事实，并用脚本或测试运行证明；证明不了就标 unproven。
5. 若根因暴露 Domain Spec 的结构性缺口（而非实现 bug），先在 .specs/domain/ 补约束，再让修复 Task Spec 引用它。
6. 修复前保留可重跑的失败复现：能写成测试时，在修复 Task Spec 中记录测试位置、输入与预期失败断言，交由 implement 按 RED→GREEN 落地；本阶段不修改产品或测试代码、不提交 git。不能写成测试时保留可重跑命令、输入与输出。生成修复 Task Spec：目标、范围、验收（引用失败证据）、回归风险。task-id 约定同 brainstorm（小写短横线主题词，撞名改用更具体的 id）。

# 产出物

- 复现证据（命令/测试/日志/截图路径）。
- .specs/tasks/<task-id>.md（修复 Task Spec）。
- 修复 Task Spec 的验收引用失败复现；无法复现时写明原因与最接近的可执行检查。
- 视情况修订 .specs/domain/*.md。

# 退出条件

根因明确、修复 Task Spec 完整且可验证；未复现或根因未证实必须显式标为待验证，不得宣称已定位。之后由主 Agent 决定调用 inspect_subagent 审查；不通过则回到本 Skill 继续完善。`,
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

1. Reproduce on the matching surface: UI on the real page, CLI with the real command, API with a real request. When direct reproduction fails, synthesize the trigger, tighten conditions or add instrumentation according to the candidate hypotheses, recording each observation. Stop the reproduction loop when repeated attempts no longer yield new information that distinguishes hypotheses; state what was tried and the closest executable check, and never fabricate evidence. If the session has command execution granted, use the relevant tests or commands to help reproduce.
2. Binary-search the hypotheses: list candidate mechanisms; each round pick the observation that cuts the most remaining problem space; eliminate only after runtime evidence. Do not start from the most suspicious code location.
3. When two fixes share one premise and both fail, stop: write the premise down and make an observation that would differ if the premise were false; test the premise first.
4. Root-cause analysis: trace the call chain to the root cause; explain "why it is wrong", not just "where it is wrong"; check against the Domain Spec whether an existing invariant was violated. For a small but risky diff, identify the one safety fact and prove it by running code; mark it unproven when you cannot.
5. If the root cause exposes a structural gap in the Domain Spec (rather than an implementation bug), add the constraint under .specs/domain/ first, then have the fix Task Spec reference it.
6. Preserve a rerunnable failing reproduction before the fix: when it can become a test, record its location, inputs and expected failing assertion in the fix Task Spec for implement to land through RED→GREEN; do not modify product or test code and do not commit to git in this phase. Otherwise keep the rerunnable command, input and output. Produce the fix Task Spec: goal, scope, acceptance (referencing the failure evidence), regression risk. Follow the brainstorm task-id convention (lowercase kebab-case topic words; on collisions use a more specific id).

# Outputs

- Reproduction evidence (command/test/log/screenshot path).
- .specs/tasks/<task-id>.md (fix Task Spec).
- The fix Task Spec acceptance references the failing reproduction; when reproduction is impossible, state why and name the closest executable check.
- Revised .specs/domain/*.md when applicable.

# Exit criteria

The root cause is clear and the fix Task Spec is complete and verifiable; an unreproduced symptom or unproven root cause must be explicitly marked as pending verification, never as located. Afterwards the main Agent decides to call inspect_subagent for review; if it fails, return to this Skill and keep refining.`,
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

1. 设计闸门：改动跨函数、模块或服务边界时，先写调用方用法，再写类型、签名、模块图；有多个合理形状时列 2 个并说明取舍。开放问题用原型验证，计划记录观察结果，不写「待定」。
2. 逐条映射 Task Spec 的验收标准到：证据类型（unit/live/perf）、验证命令或路径、通过判据。行为改动不能只有 unit 证据；没有 live 证据的验收标为「未覆盖」；性能验收写基线、测量方式和阈值来源。
3. 拆解实施步骤，说明顺序与依赖；风险最高或未知最多的步骤先做；标注关键风险与回滚/幂等语义。
4. 明确技术选型与边界，优先复用项目现有约定与已验证组件，不引入无必要的抽象。
5. 计划自检：每条验收都有证据；每个步骤都有检查；没有 Spec 依据的抽象或兼容层不进入计划。
6. 若实施路径发现 Task Spec 或 Domain Spec 有歧义/冲突，停下并回报，不擅自改写 Spec。

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

1. Design gate: when the change crosses a function, module or service boundary, write the caller's usage first, then the types, signatures and module map; when several shapes are valid, list two and state the trade-off. Settle open questions with prototypes and record the observed result in the Plan instead of "TBD".
2. Map each acceptance criterion of the Task Spec to: evidence kind (unit/live/perf), verification command or path, and pass predicate. A behavior change cannot rely on unit evidence alone; an acceptance without live evidence is marked "not covered"; performance acceptance states its baseline, measurement method and threshold source.
3. Decompose the implementation steps with ordering and dependencies; do the riskiest or most unknown step first; flag key risks and rollback/idempotency semantics.
4. Make technology choices and boundaries explicit; prefer reusing the project's existing conventions and proven components; introduce no unnecessary abstraction.
5. Plan self-check: every acceptance has evidence; every step has a check; abstractions or compatibility layers without a Spec basis do not enter the Plan.
6. If the implementation path reveals ambiguity or conflicts in the Task Spec or Domain Spec, stop and report back; never rewrite Specs on your own authority.

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

1. 多文件、多子任务或需要 fan-out 时，先写 throughput checkpoint：阻塞步骤、可并行工作流、共享可变状态、最小安全分解；共享写默认拆目标，不加锁；一个 worker 最好时写明原因。
2. 先减法：删除死代码、遗留兼容层、未用导出和冗余 guard，再添加新代码。先理解改动文件的现有约定（风格、导入、依赖），改动与周围代码一致。
3. 按 Plan 顺序逐个子步骤推进；每个子步骤：先写失败测试（RED）→ 跑测试确认失败 → 写最小实现（GREEN）→ 重构（保持测试通过）。测试不适用的改动（配置、样式、纯文档）以类型检查、构建或逐项自查作为该子步骤的验证动作。
4. 测试双检：破坏行为（错值、漏副作用、重复副作用）→ 测试必须失败；只改内部实现、可观察结果不变 → 测试必须仍然通过。期望值从需求推导，不从被测代码的运行结果抄。不满足就重写或删除。
5. 若实现中发现 Plan 有误、不可行或与实际代码结构冲突，停下回到 plan 修订，修订后重新通过 examine_subagent 检查再继续实现，不静默偏离 Plan；仅步骤顺序、命名这类无关紧要的微调可直接推进，并在验证证据中注明。
6. 遵循项目自身的硬约束与编码约定（如不可变边界、错误处理、输入验证）；不硬编码、不留调试残留；写操作按宿主的审批约定执行，不要试图绕过。
7. 完成证据用真实表面：UI 走真实流程，CLI 跑真实命令，API 读回写入值；typecheck/build 只是子步骤证据。无法验证时写 INCONCLUSIVE 并停止完成收口，由用户决定补充环境或调整验收；不写「应该没问题」。
8. 每完成一个子步骤跑相关测试；声明完成前重读改动，检查遗留调试代码、未用导入与风格不一致。记录验证证据（类型检查、测试、命令结果、真实表面路径），供 finish 阶段引用。

# 产出物

- 实现代码 + 测试（同目录 *.test.*）。
- 验证证据（测试/typecheck 结果 + 真实表面证据）。

# 退出条件

Plan 覆盖的验收中，适用测试的均有对应测试通过；测试不适用项已有 Plan 指定的类型检查、构建或逐项自查证据；typecheck 通过，行为测试的测试双检通过，真实表面证据齐全。任一验收只能标为 INCONCLUSIVE 时不得以完成状态退出。之后由主 Agent 决定调用 review_subagent 审查；不通过则回到本 Skill 继续修改。`,
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

1. For multi-file or multi-subtask work, or any fan-out, write the throughput checkpoint first: blocking steps, parallel workstreams, shared mutable state, and the smallest safe decomposition. Split shared write targets by default instead of adding a lock; when one worker is best, name why.
2. Subtract first: delete dead code, legacy compatibility layers, unused exports and redundant guards before adding code. Understand the existing conventions of the files being changed (style, imports, dependencies); keep changes consistent with the surrounding code.
3. Proceed sub-step by sub-step in Plan order; for each sub-step: write the failing test (RED) → run tests to confirm failure → write the minimal implementation (GREEN) → refactor (tests stay green). For changes where tests do not apply (config, styling, pure docs), use type checking, build, or item-by-item self-review as that sub-step's verification action.
4. Test the tests: break the behavior (wrong values, missing side effects, duplicated side effects) → the test must fail; change only the internals with the observable result unchanged → the test must still pass. Derive expected values from the requirement, never from a run of the code under test. Rewrite or delete a test that fails either check.
5. If implementation reveals the Plan to be wrong, infeasible, or conflicting with the actual code structure, stop and return to plan for revision, re-pass examine_subagent after revising, and only then continue implementing—never silently deviate from the Plan; only trivial adjustments (step ordering, naming) may proceed directly, noted in the verification evidence.
6. Follow the project's own hard constraints and coding conventions (e.g. immutability boundaries, error handling, input validation); no hardcoding, no leftover debug code; perform write operations under the host's approval conventions and never attempt to bypass them.
7. Verify on the real surface: UI through the real flow, CLI with the real command, API by reading back the written value; typecheck/build are sub-step evidence only. When verification is impossible, write INCONCLUSIVE and stop completion closeout; let the user decide whether to provide an environment or adjust acceptance instead of writing "should be fine".
8. Run the relevant tests after each sub-step; before declaring completion re-read the changes checking for leftover debug code, unused imports, and style inconsistencies. Record verification evidence (typecheck, tests, command results, real-surface paths) for the finish phase to reference.

# Outputs

- Implementation code + tests (*.test.* in the same directory).
- Verification evidence (test/typecheck results plus real-surface evidence).

# Exit criteria

For every acceptance criterion covered by the Plan where tests apply, the corresponding test passes; where tests do not apply, the Plan's typecheck, build or item-by-item review evidence exists. Typecheck passes, the test-the-tests check passes for behavioral tests, and real-surface evidence exists. If any acceptance can only be marked INCONCLUSIVE, do not exit as complete. Afterwards the main Agent decides to call review_subagent for review; if it fails, return to this Skill and keep fixing.`,
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
4. 汇总验证证据：typecheck、测试、必要命令结果，形成收口结论——全链路任务写明「依据哪份 Task Spec、受哪些 Domain Spec 约束、通过哪些验证」，简单任务写明「依据哪份用户请求、通过哪些验证」。收口摘要固定写：改了什么；已验证什么（命令/结果）；未验证或不确定什么；剩余风险；遗留项。
5. 长任务、离开场景或跨会话任务，记录决策轨迹：phase / decision / why / evidence / result；写进现有 run artifact 或 docs，不新增 Skill；收口总结附路径或 artifact 引用。
6. 若可用，review_subagent 对照「结论 vs 证据」审计收口摘要；没有运行证据的结论标为 inferred，不写成已验证。
7. 若本次改动影响用户可见行为且 tests/verify.md 存在，更新其 feature map、启动/驱动/证据说明；不存在时建议用户用 test-authoring 建立，不在 finish 阶段自行发明第二套测试系统。
8. 提交与推送：遵循系统提示词「# Git 分支规则」——先确认当前分支，严禁直接在 main 或 master 上提交推送；在任务分支上提交（分支前缀以该节为准、缺省 feat-，后缀用 task-id 或简短主题词；提交信息遵循项目自身的提交约定）并推送到远端同名分支，需要出站网络的命令按安全边界声明 network: true。除非用户明确要求不提交或另有分支安排。
9. 列出遗留项（未覆盖的边缘、后续建议），不擅自扩大范围。全部写操作与命令都按宿主的审批约定执行，不要试图绕过。

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
4. Summarize verification evidence: typecheck, tests, necessary command results, forming the closing conclusion—for full-chain tasks state "which Task Spec, constrained by which Domain Specs, verified by which checks"; for simple tasks state "which user request, verified by which checks". The closing summary always states: what changed; what was verified (command/result); what was not verified or is uncertain; residual risk; leftover items.
5. For long-running, unattended or cross-session tasks, keep a decision trail: phase / decision / why / evidence / result. Write it into the existing run artifact or docs, not a new Skill; link its path or artifact in the closing summary.
6. When available, have review_subagent audit the closing summary against the evidence. Conclusions without runtime evidence are marked inferred, never as verified.
7. When the change affects user-visible behavior and tests/verify.md exists, update its feature map, launch/drive/evidence notes. When it does not exist, suggest creating it through test-authoring instead of inventing a second test system inside finish.
8. Commit and push: follow the system prompt's "# Git branch rules"—confirm the current branch first; committing/pushing directly on main or master is strictly forbidden; commit on the task branch (branch prefix per that section, default feat-, suffix the task-id or a short topic; commit messages follow the project's own conventions) and push to the remote branch of the same name; commands needing outbound network declare network: true per the security boundary. Unless the user explicitly asked not to commit or arranged branches differently.
9. List leftover items (uncovered edges, follow-up suggestions) without expanding scope. All write operations and commands run under the host's approval conventions; never attempt to bypass them.

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
- 项目根 DESIGN.md（若存在）：品牌/视觉/交互基调与设计意图，**正文已注入 # 项目上下文 段的 <project_design> 块**（16 KiB 上限，超限带截断注记；索引条目仍以 role=design 出现）。直接以注入块为准，不要为获取基调重复整读；块被截断或需核对完整版本时再 read。缺失且用户未给基调时，按下述最小结构自拟，并随设计计划一起交用户确认——确认后可新建（写工具逐次审批）：① 受众与核心任务；② 视觉语言（4–6 个命名色含明暗、字体栈与 type scale、圆角/阴影层级、间距节奏）；③ 语气与文案规则；④ 本项目禁用的默认套路；⑤ 唯一视觉主角。已存在时只补缺、不覆盖用户既有内容；确认的新基调回写它。

# 唯一设计稿格式与迁移

- **.ax**（Axiom 自有格式，**新稿一律用它**）：节点是四级闭集——优先 component（真组件实例：name 必须命中组件清单、props 过契约校验），其次 symbol（**本稿局部组件**（1.4）：顶层 symbols 声明 props 契约与 body 原语子树，页内用普通 component 节点实例化——body 的文案位（text/label/supporting）与枚举位（icon.name，1.6）写 {$param: 参数名} 引用参数，实例用 props 传值——参数**全必填**：文案位参数契约写 string，枚举位参数契约写 { enum: [值域] }；body 只写 part/原语（禁 component 与 overlay，无嵌套 symbol）；body 节点 id 需全稿唯一且不含保留分隔符 ~s:；symbol 名不得与组件清单或注册表重名。画布按实例展开渲染、codegen 发射为真实局部组件——复用边界直达实现），再次 part（语义部件：只写语义与变体，尺寸与内边距由实现侧决定；部件走词表——statusTag / divider / bubble / banner / actionButton / mentionBadge，字段越界与非法变体都会报错），最后才是 frame / text / icon / rect / ellipse / path / image 原语。**重复结构（表格行、导航项、卡片、定价档）先抽 symbol 再逐实例传参——同型结构逐份重写原语会在完善度与一致性上双输**。硬规则：组件必须来自清单；文案用字符串或 {$mock}（展示）/ {$bind}（数据源），组件的 json 型 props（工具调用的 call/result、消息对象等）用**结构化** {$mock}——直接把对象/数组写进绑定，不要包成 JSON 字符串；页用 group / state 表达同一 UI 的多状态；除 overlay 外**禁止绝对定位**（位置用 flex 与锚点语义）；弹窗/抽屉背后的整页遮罩用 overlay 的 scrim: {fill}（如半透明色，遮罩铺满父级、由实现渲染成 backdrop，不要用半透明矩形手搭，同一页可叠多个带 scrim 的 overlay）；卡片/弹层的投影用 shadow: {color, offsetX, offsetY, blur}（color 是 token 或字面色，偏移与 blur 是 px 数值，blur 不为负），不要用叠加半透明矩形模拟；lineHeight 必须写 {unit:'multiplier'|'px', value}；尺寸只接受数值(px) / token / fill_container / fit_content；token 用 $名称 引用顶层已声明项；未知字段一律报错（校验 fail-closed，错稿不会进画布）。组件节点的 name 与 props 会额外与组件注册表核对（组件不在注册表、props 键/必填/值型与契约不符都会在读取时报错并列出可用项）——写稿当场暴露，不必等画布渲染红框。
- **.pen**（pen.dev 格式，**存量与互操作**）：仅作为一次性迁移输入，不进入画布与 design_query。要在这份稿上长期迭代时，先用 design_import 把它迁移成 .ax（一次性、需审批；目标已存在会被拒绝），此后以 .ax 为准。

# 审美定位

**三层分工**：用户 brief 与项目根 DESIGN.md 是审美的最高约束——其中指定的方向必须照做；下方「完整度清单」只保证覆盖度下限，不是视觉答案；「内置模式库」只提供结构底座——复制 pattern 后必须用本稿 token 重写视觉语言（圆角层级、阴影、色阶、字体），沿用其视觉常量会得到整齐的卡片模板相。

**先锚定主题，再谈视觉**：写稿前明确三件事——目标用户、这个界面要完成的主任务、所属行业与语汇。brief 与 DESIGN.md 都没给出时，先按这三项自拟一个具体提案交用户确认；不自拟就会落到默认模板。视觉选择从主题来（给孩子的工具与给分析师的仪表盘不共享同一套色/字/密度），不从「我常用的那套」来。

**先出设计计划，再写稿（Path A 强制）**：先给用户一段计划（或写入 DESIGN.md）——4–6 个命名色（含明暗两档）、字体角色与 type scale（1–2 个字族）、版式概念（对齐/密度/首屏结构）、一条差异原则（本稿相对同类产品不同的那一件事）。然后对照 brief/DESIGN.md 自审：换一个同行业的相似需求，这份计划会不会原样成立？会，说明它是默认而不是选择——改掉并说明改了什么。计划确认后才登记 tokens、写页面。

**反默认清单**：下列组合本身不是错，但它们是「不假思索的默认」；出现时必须说出为这个 brief 服务的具体理由，否则替换：
- 奶油色底 + 高对比衬线大标题 + 陶土/暖橙强调色；
- 近黑底 + 单一酸性绿或朱红点缀；
- 全大写 eyebrow 标签、A · B · C 中点串、WORD — fragment 破折号标签、等宽小字数据标签、链接/按钮尾部加 →；
- SaaS 卡片套件：内容全部切成同款圆角卡片、无视层级同一圆角与同一 soft shadow、渐变当装饰；
- 大数字 + 小标签 + 指标支撑 + 渐变强调的 Hero（除非指标本身就是主体内容）。

**排版**：1–2 个字族且角色清晰；字号/字重/行高走 $token 形成明确 type scale；正文行宽控制在 80 字符以内（衬线可略长、行高略大）；标题强调靠字号/字重/位置，不靠单词斜体、局部换色或全大写标签；不加无信息的 eyebrow。

**结构即信息**：编号、分隔线、边框、标签只在编码真实序列或分组时使用；完整度清单的数量下限是覆盖度要求，不是装饰许可。

**动效**：.ax 1.6 不表达动效；实现侧（mode=code）至多一个编排时刻（首屏载入或单次揭示），不做每段 fade-up、每卡 hover，尊重 reduced motion。

**文案**：用用户能理解的语言命名（「通知设置」，不是「webhook 配置」）；主动语态，CTA 写明结果（「保存更改」，不是「提交」）；同一动作全流程同名；错误说清发生了什么与怎么修，不道歉、不模糊；空态给出下一步动作而不是一句「暂无数据」；一句话只做一件事。

**克制**：全稿只保留一个视觉主角，其余保持安静；删到不影响理解为界。大胆只花在一个地方。

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

- **pattern 只定义结构，不定义视觉**：半径、阴影、色阶、字体必须重新落成本稿 token；直接沿用 pattern 的视觉常量会得到「审美定位」里点名的同款卡片套件。
- **KpiCard**：数据仪表盘的 KPI 行 / 落地页 Hero 下的指标（仅当指标本身是主体内容时使用）。props: label / value / delta
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

方案探索：方向未定时做 2–3 个独立 .ax 变体，保持页面 id/group/state/尺寸一致，截图或画布并列对比；每个元素必须服务核心流程。视觉验收用真实渲染截图，必要时像素对比，不只靠主观肉眼判断。

## Path A：从零生成

1. **读基调、出设计计划、登记 tokens**：先核对 <project_design> 注入块（即根 DESIGN.md 正文；未注入但文件存在、或块被截断时再 read；无则按「前置输入」的最小结构自拟，随计划交用户确认）；再按「审美定位」产出设计计划——4–6 个命名色、字体角色与 type scale、版式概念、一条差异原则，并对照 brief/DESIGN.md 自审、说明差异或改了什么；最后按三档登记 token——① DESIGN.md / 用户 brief 的视觉意图；② 项目已有的 token 来源（styles/tokens.css、theme 文件等，存在则复用）；③ 都没有时才用 Axiom 基线兜底。计划确认后才写页面；自加 token 需在稿顶层 tokens 登记并写明暗两档。
2. **产出页面清单**：每页给出 name、用途、对应的 the Completeness rubric 条目（管理后台 / 落地页 / 仪表盘三类之一，或自定）、关键分区列表、差异点（本页相对同类产品不同的那一件事，取自设计计划的差异原则）。先把清单交给用户确认或直接继续。
3. **逐页写 + 单页自查**：每写完一页（component / symbol / part / 原语 四级节点；重复结构先抽 symbol 再逐实例传参），立即 design_query mode=render 视觉自查——通过再下一页。**完整稿 300-800KB 单次写入必撞模型单轮预算，本路径明确豁免「合并为一次 apply_changes」的编辑路径限制**：一页一页写是预期行为，不是碎片化。
4. **整稿收口**：全部页面写完后 design_query mode=scan 全稿扫描（结构 + 离屏渲染 + 空白检测），按 fail/warn 修复重扫至全绿。
5. **对照 the Completeness rubric 自检**：通用最低线达标、所选产品类型页面集/分区集无缺失、关键交互页含三态；缺页/缺分区/密度不足显式补齐后再交付。同时对照「审美定位」的反默认清单逐项给出理由或替换，确认全稿只有一个视觉主角（其余保持安静）。

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

Path B 的视觉取舍同样受「审美定位」约束：新增或改样式不得引入第二套视觉体系——字体、圆角层级、阴影、色阶继续取稿级 token；不得顺手引入反默认清单里的默认组合；每页仍只保留一个视觉主角。

# 产出物

- 更新后的 .ax 设计稿。
- Path A 时先产出设计计划（基调来源 + 4–6 个命名色 + 字体角色与 type scale + 版式概念 + 差异原则）；经用户确认后回写项目根 DESIGN.md（无则按最小结构新建；写工具逐次审批）。
- 发生方案探索时：变体 .ax 路径、真实渲染截图或 compare 结果，以及采用/放弃理由；未发生时不产出。
- 必要时同步 .docs/ 实现现状说明（如新增了影响实现的组件）。

# 退出条件

画布渲染结果与用户意图一致、无新增解析诊断；全部修改已合入一次批量补丁并写后自查通过；整稿级改动已通过 mode=scan 扫描（无 fail 页）。**发生方案探索时**：2–3 个变体均有真实渲染证据与选择结论，原稿未被覆盖；无法取得的视觉证据标为未验证，不得宣称验收通过。**Path A 从零生成的额外要求**：与 the Completeness rubric 对账——通用最低线达标、所属产品类型页面集/分区集无缺失、关键交互页含空/加载/错误三态；设计计划已对照 brief/DESIGN.md 自审并说明差异原则或改了什么，基调来源已声明，反默认清单逐项有理由或已替换，全稿只有一个视觉主角。`,
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
- Root DESIGN.md when present: brand/visual/interaction baseline and design intent. **Its body is already injected as the <project_design> block under the # 项目上下文 section** (16 KiB cap with an explicit truncation note; the index entry remains under role=design). Use the injected block directly — do not re-read the whole file just to obtain the baseline; read it only when the block was truncated or you need to verify the full version. When it is absent and the user gave no baseline, draft the minimal structure below, present it with the design plan, and create the file after confirmation (write tools are approval-gated): ① audience and primary job; ② visual language (4–6 named colors with light/dark, type stack and scale, radius/shadow hierarchy, spacing rhythm); ③ tone and copy rules; ④ default patterns banned in this project; ⑤ the single visual protagonist. When it exists, fill gaps only — never overwrite the user's content; write confirmed baseline changes back to it.

# Sole design format and migration

- **.ax** (Axiom's native format — use it for all new work): nodes are a closed four-tier set — prefer component (real component instance: name must be in the component inventory, props must satisfy its contract), then symbol (**document-local component** (1.4): the top-level symbols map declares a props contract plus a primitive body subtree, instantiated in pages by ordinary component nodes — body text positions (text/label/supporting) and enum positions (icon.name, 1.6) reference params as {$param: name}, instances pass values via props, every param is **required**: text positions take string, enum positions take { enum: [domain] }; bodies carry parts/primitives only (no component, no overlay, no nesting); body node ids must be unique document-wide and free of the reserved separator ~s:; symbol names must not collide with the inventory or registry. The canvas renders instances by expansion and codegen emits real local components — the reuse boundary reaches the implementation), then part (semantic part: semantics and variant only, metrics live in the implementation; parts come from a vocabulary — statusTag / divider / bubble / banner / actionButton / mentionBadge — and unknown kinds, invalid variants or out-of-contract fields are errors), and only then the frame / text / icon / rect / ellipse / path / image primitives. **Repeated structures (table rows, nav items, cards, pricing tiers): author a symbol once and pass params per instance — rewriting identical primitive blocks by hand loses on both completeness and consistency.** Hard rules: components must come from the inventory; text is a literal or {$mock} (display) / {$bind} (data source), and a component's json-typed props (tool-call call/result, message objects, …) take a **structured** {$mock} — write the object/array into the binding, never as a JSON string; pages express multi-state UI via group / state; absolute positioning is forbidden outside overlay (use flex plus anchor semantics); the full-page scrim behind a modal or drawer is expressed as overlay scrim: {fill} (e.g. a translucent color — the scrim fills the parent and the implementation renders it as a backdrop; never hand-build it from a translucent rectangle, and multiple scrim overlays may stack on one page); card/modal elevation uses shadow: {color, offsetX, offsetY, blur} (color is a token or literal, offsets and blur are px numbers, blur is never negative) — never fake it with stacked translucent rectangles; lineHeight must be {unit:'multiplier'|'px', value}; sizes accept a number (px), a token, fill_container, or fit_content; tokens are referenced as $name and must be declared at the top level; unknown fields are errors (validation is fail-closed — an invalid document never reaches the canvas). Component nodes are additionally cross-checked against the component registry (unknown component, props keys, required props, literal value types): mismatches fail at read time with the available options listed — exposure happens while authoring, not at canvas render.
- **.pen** (pen.dev format, legacy and interop): one-time migration input, excluded from the canvas and design_query. To keep iterating on such a document, first migrate it with design_import (one-off, approval-gated; existing targets are refused), then work on the .ax. New design intent goes into .ax.

# Aesthetic direction

**Three layers**: the user brief and the root DESIGN.md are the highest aesthetic authority — a direction they specify must be executed as written; the completeness rubric below only sets a coverage floor, not a visual answer; the built-in pattern library supplies structure only — after copying a pattern, rewrite its visual language (radius hierarchy, shadow, color scale, type) from this document's tokens. Reusing pattern visual constants verbatim yields the uniform-card template look.

**Anchor the subject before discussing visuals**: before writing, settle three things — the target audience, the primary job this interface does, and the industry/vernacular. When neither the brief nor DESIGN.md provides them, propose a concrete subject/audience/job to the user for confirmation; without that proposal you will fall back to the template. Visual choices come from the subject (a tool for children and a dashboard for analysts share no palette, type, or density), not from "the set I always reach for".

**Plan before building (mandatory on Path A)**: first give the user a compact plan (or record it in DESIGN.md) — 4–6 named colors (light + dark), typeface roles and a type scale (one or two families), a layout concept (alignment/density/first-screen structure), and one differentiation principle (the one thing this design does differently from similar products). Then review the plan against the brief/DESIGN.md: would it hold unchanged for a similar brief in the same industry? If so it is a default rather than a choice — revise it and say what changed. Register tokens and write pages only after the plan is confirmed.

**Anti-default list**: these combinations are not wrong per se, but they are reflexive defaults; when one appears, either state the concrete reason it serves this brief or replace it:
- cream background + high-contrast serif display + terracotta/warm-clay accent;
- near-black background + a single acid-green or vermilion accent;
- tracked-out ALL-CAPS eyebrow labels, A · B · C middle-dot strings, WORD — fragment em-dash labels, monospace micro-labels, → appended to links/buttons;
- the SaaS-card kit: every chunk of content in an identical rounded card, one radius and one soft shadow regardless of hierarchy, gradient washes as decoration;
- a big number + small label + supporting stats + gradient-accent hero (unless the metric itself is the subject).

**Typography**: one or two families with clearly distinct roles; sizes, weights, and line-heights through $tokens with an explicit type scale; body line length under 80 characters (serifs may run slightly longer with more line-height); emphasize headlines by size, weight, and position — never by italicizing one word, recoloring a phrase, or ALL-CAPS labels; no uninformative eyebrows.

**Structure is information**: numbering, rules, borders, and labels only when they encode a real sequence or grouping; the quantity floors in the completeness rubric are coverage requirements, not a license to decorate.

**Motion**: .ax 1.6 does not express motion; on the implementation side (mode=code) allow at most one orchestrated moment (first load or a single reveal), no per-section fade-up or per-card hover, and respect reduced motion.

**Copy**: name things in the user's language ("notification settings", not "webhook config"); active voice; CTAs state the outcome ("Save changes", not "Submit"); one action keeps one name through the flow; errors say what happened and how to fix it, never apologize or stay vague; empty states offer the next step instead of "no data"; each element does one job.

**Restraint**: keep one visual protagonist per document and let everything else stay quiet; cut until removal would hurt comprehension. Spend boldness in one place.

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

- **Patterns define structure, not visuals**: radius, shadow, color scale, and type must be re-derived from this document's tokens; reusing pattern visual constants verbatim yields the uniform-card kit named in Aesthetic direction.
- **KpiCard**: data-dashboard KPI row / hero-side metrics (use only when the metric itself is the subject). props: label / value / delta
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

Design exploration: when the direction is open, build 2–3 independent .ax variants with matching page id/group/state/size, then compare them side by side by screenshot or canvas; every element must serve the core flow. Verify visuals with real rendered screenshots, using pixel comparison when needed rather than relying only on subjective eyeballing.

## Path A: from-zero generation

1. **Read the baseline, produce a design plan, register tokens**: start from the injected <project_design> block (the root DESIGN.md body; read the file only when it was not injected, was truncated, or you need the full version — if it is missing, draft the minimal structure from Required inputs and confirm it with the user together with the plan); then produce the plan required by Aesthetic direction — 4–6 named colors, typeface roles and scale, layout concept, one differentiation principle — review it against the brief/DESIGN.md, and state the difference or what changed; finally register tokens in three tiers — ① the DESIGN.md / user-brief intent; ② existing project token sources (styles/tokens.css, theme files) when present; ③ the Axiom baseline only as the last resort. Write pages only after the plan is confirmed; newly added tokens must be declared in the doc's top-level tokens with light + dark values.
2. **Draft a page inventory**: for each page provide name, purpose, the matching the Completeness rubric entry (admin console / landing / dashboard, or your own), key sections, and a differentiation point (the one thing this page does differently, taken from the plan's differentiation principle). Either confirm the inventory with the user first or proceed directly.
3. **Write per page + single-page self-check**: each page uses the four-tier node set (component / symbol / part / primitive; extract a symbol for repeated structures and pass params per instance); after each page, run design_query mode=render for a visual self-check — only move on once it passes. **A complete draft is 300-800 KB; a single write would blow the model's per-turn output budget, so this path explicitly opts out of the "merge into one apply_changes" rule from the edit path**: writing one page at a time is the expected behavior, not fragmentation.
4. **Document-level close**: once all pages are written, run design_query mode=scan across the whole doc (structure + offscreen render + blank detection); fix fail/warn issues and re-scan until green.
5. **Self-check against the Completeness rubric**: universal floor met, the chosen product-type page/section set has no missing entries, and key interactive pages cover the three states. Missing pages / sections / density gaps must be filled explicitly before delivery. Also walk the anti-default list in Aesthetic direction — justify or replace each hit — and confirm the document has exactly one visual protagonist while everything else stays quiet.

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

Path B is bound by Aesthetic direction too: new or changed styles must not introduce a second visual system — type, radius hierarchy, shadow, and color scale keep coming from document-level tokens; do not drift into a default from the anti-default list; each page keeps one visual protagonist.

# Outputs

- The updated .ax design document.
- On Path A, a design plan first (baseline source + 4–6 named colors + typeface roles and scale + layout concept + differentiation principle); after user confirmation, write it back to the root DESIGN.md (create it with the minimal structure when absent; write tools are approval-gated).
- When design exploration occurred: variant .ax paths, real rendered screenshots or compare results, and the reasons for adoption/rejection; none otherwise.
- .docs/ implementation notes when needed (e.g. a new component that affects implementation).

# Exit criteria

The canvas render matches the user's intent with no new parse diagnostics; all modifications were merged into a single batch patch and passed the post-write self-check; document-wide changes passed the mode=scan scan (no failed pages). **When design exploration occurred**: all 2–3 variants have real rendered evidence and a selection conclusion, and the original document was not overwritten; unavailable visual evidence is marked unverified and cannot be claimed as accepted. **Additional requirement for Path A from-zero generation**: reconcile against the the Completeness rubric — universal floor met, the chosen product-type page/section set has no missing entries, key interactive pages cover empty/loading/error; the design plan was reviewed against the brief/DESIGN.md with the differentiation principle or changes stated, the baseline source is declared, every anti-default hit is justified or replaced, and the document has one visual protagonist.`,
    },
  },  {
    name: 'test-authoring',
    'zh-CN': {
      description: '为工作区内指定功能编写可重放的自动化测试用例（tests/*.testspec.json 的测试点与用例）：先定测试点再写用例，用真实环境与真实接口构造数据，写 typed 断言与清理步骤。',
      body: `# 目的

把用户对某个功能的验收要求，收敛成工作区里**可重放的自动化测试用例**：先定测试点（testPoints），再写用例（cases），让回归由确定性 Runner 执行、不依赖模型。

# 何时进入

用户在测试页会话里要求为某功能 / 接口 / 流程编写或补全用例；或产品变更后既有用例的期待需要更新。只是想跑一遍看看，不需要本技能——直接在测试页点运行即可。

# 前置输入

- 目标功能的描述与**可客观判定的验收标准**（用户给的，或从需求文档与代码里读出的）。
- docs/ui-api-automation-usage.md：用例协议、字段与拒绝面（**Axiom 项目内的完整文档**：在 Axiom 仓库工作时先读它；新项目里通常不存在，此时以下节「协议最小字段集」为准，并把解析器的「需要修复」原因当作最终口径）。
- tests/environments/*.env.axiom（若存在）：本地 / 远程档、就绪探针、允许引用的 Secret 名（明文只存在宿主 Secret 里）。
- 既有 tests/ 用例与命名习惯：补充优先，不要另起一套命名。

# 协议最小字段集（离线可用）

完整字段与拒绝面见 docs/ui-api-automation-usage.md（位于 Axiom 项目内）；新项目读不到它时以本节字段集 + 解析器报错（JSON path + 原因）为准，不要凭印象写字段。

- 顶层：kind:"axiom.test"、version:9、id、name、target{}、testPoints[]（必填、至少一个）、cases[]、可选 hooks{beforeAll,beforeEach,afterEach,afterAll}（每条都是普通步骤）。
- target：webBaseUrl / apiBaseUrl（\${env.WEB_BASE_URL} / \${env.API_BASE_URL}，也接受 / 开头站内相对路径）、viewport{width,height}。
- testPoints[]：id / kind（new_feature | regression）/ title / acceptance。
- cases[]：id / name / verifies[]（指本文件 testPoints 的 id）/ steps[] / 可选 inputs[]（v5 数据行）。
- 数据行（v5）：cases[].inputs 是标量对象数组；同一用例按行展开（id 追加 -v1/-v2，name 追加行号），步骤里用 \${vars.行键} 引用行值；所有行必须共享同一组键，行值内只允许 \${env.*} / \${run.*}。
- 运行时凭据（v6）：敏感头的 {variable:"token", prefix:"Bearer "} 只接受同 case（或 beforeAll）内 extract 的 sensitive:true 变量；值不写进文件，宿主注入并按凭据脱敏，目标仍受环境同源/secretOrigins 边界约束。
- fixture 文件（v9）：JSON 请求体里的 {"file":"tests/fixtures/x.pem"} 由宿主在运行准备期读取工作区文件并替换为内容（只允许 tests/fixtures/ 相对路径；证书/密钥等文本夹具用，单次运行 ≤16 个 / ≤128 KiB）。
- 条件清理（v7）：步骤可加 whenProduced:"变量名"——运行时该变量未产出则整步记 skipped（共享 afterEach 引用只有部分 case 产出的变量时用）；清理删除配 expect:[{statusIn:[200,404]}] 容忍已删除。
- UI 动作：ui.navigate(url) / ui.click(locator) / ui.input(locator,value) / ui.select(locator,value) / ui.press(key) / ui.wait(expect,可选 locator/timeoutMs/extract) / ui.assert(expect,可选 locator/extract) / ui.screenshot(可选 name)。
- locator：{testId} 优先，其次 {role,name,exact?}。
- UiExpectation：exists / visible / enabled / textEquals / textContains / valueEquals / urlEquals / urlContains / count。
- API 步骤 api.request：method / url / query / headers（值可为 {secretId:"apitest.xxx"}，或 v6 的 {variable:"token", prefix:"Bearer "} 引用同 case 内 sensitive 抽取——登录令牌直接用于敏感头；authorization / cookie / x-api-key 等敏感头只能用这两种引用）/ body + bodyMode(json|text|form，仅 POST/PUT/PATCH/DELETE) / redirect(manual|same-origin) / virtualHost(host[:port]，按 Host 路由的反代目标；不改网络目的地) / expect[] / extract。
- 轮询 api.poll：method(GET|HEAD) / url / query / headers / virtualHost / redirect / expect[]（必填）/ intervalMs(500–30000) / timeoutMs(≤120000，整体窗口) / extract（仅在通过的那次尝试上提取）——等待配置下发、路由重建等最终一致窗口，别用固定 sleep 猜。
- 小睡 api.delay：durationMs(1–30000)；无副作用、不消耗审批，用于跨秒级时序边界。
- ApiExpectation：status / statusIn（多状态任一命中，v7）/ headerEquals / headerContains / headerExists / headerAbsent / bodyContains / bodyNotContains（正文不得包含，v8）/ jsonPointerExists / jsonPointerEquals / jsonPointerLengthEquals（数组长度）/ jsonPointerNumberAtLeast / jsonPointerNumberAtMost / maxElapsedMs。
- 占位符：\${env.NAME}（WEB_BASE_URL / API_BASE_URL，以及环境档声明的自定义大写变量）、\${vars.name}（前序 extract 产生）、\${run.id} / \${run.slug}（唯一测试数据标记）。
- 禁止字段：tabId、AX ref、截图像素、宿主绝对路径、Secret 明文、JS/shell 表达式、运行期 Artifact 路径——解析器 fail-closed 拒绝。

# 执行步骤

1. **先测试点**：把验收标准拆成逐个可判定的测试点，标 kind——new_feature（本次新增能力）或 regression（受影响的既有功能）。空泛的测试点（「功能正常」）不算点，改写成能被一条断言证明的说法。
2. **再写用例**：每个测试点至少一条用例，用例的 verifies 指向本文件 testPoints 里的 id；测试点无人认领或 verifies 悬空都会被判「需要修复」。
3. **认环境**：用例只写逻辑地址（如 \${env.API_BASE_URL}）与 Secret 引用名；真实地址在环境档或运行环境里。
4. **构造数据用真实接口**：前置构造写进用例步骤或 hooks，禁止用 mock / 桩数据顶替环境。
5. **控制面改动必须在数据面验证**：写清访问哪个地址、构造什么请求或页面操作、期望看到什么结果。
6. **清理**：清理步骤走产品的原生接口删掉自己造的数据，不要直接动被测数据库。
7. **收尾**：在测试页「重新扫描」确认校验通过；被判「需要修复」时按问题清单逐条改到通过，不要绕过。

# 回归证明

kind = regression 的用例必须交出失败证据；new_feature 用例至少要证明断言能区分对错。

1. 先让缺陷可执行：在修复前用同一路径复现。能写成测试就写；不能时保留可重跑命令、输入和输出。
2. 证明用例会失败：优先在已有的修复前环境或版本上运行同一路径，确认它因预期原因失败；恢复当前环境后重跑通过。不得为了制造失败而修改本会话的产品源码。没有可运行的修复前环境时，如实标记未证明，由用户决定提供环境或把该用例转为新增覆盖；不得宣称回归保护。
3. 断言必须能区分对错：至少一条断言在错误值、缺失副作用或重复副作用下会失败。只看状态码、只看元素存在、只断言自己构造的数据，不算。
4. 在会话回报中写清：失败证据（命令/日志/截图路径）、通过证据、无法证明的部分。

# 测试质量自检

- 破坏行为：返回错值、漏副作用、重复副作用 → 用例必须失败。
- 只改内部实现：可观察结果不变 → 用例必须仍然通过。
- 期望值从需求或验收标准推导，不从被测代码的运行结果抄。
- 每个测试点至少覆盖一个边界或失败路径；只有 happy path 的测试点需要说明为什么。
- verifies 必须与断言语义对应，不能只是形式上引用测试点。
- 不满足以上任一项时，重写或删除该用例，不要用“先绿再说”绕过。

# 项目验证契约（可选）

当项目需要重复验证、且当前没有可执行的启动/驱动说明时，读 tests/verify.md；不存在时经用户确认后创建。它是一份项目文档，不是新的 Skill，也不替代 TestSpec Runner。

Launch / Drive 优先引用 tests/environments/*.env.axiom 等既有环境档与项目命令，不复制成第二份真相；只补充环境档没有的信息。

契约保持短小，至少包含：

- Launch：从空数据目录启动到可用，包含迁移与种子数据；CLI 则构建一次，每次独立会话。
- Doctor：一个只读检查，确认进程、版本、端口、认证是否可用。
- Drive：真实 UI/CLI/API 的驱动方式，优先稳定定位（testId、role+name、命令、路由）。
- Evidence：截图、日志、响应、数据库读回值放在哪里；清理后证据必须保留。
- Cleanup：只清理本次启动的进程与数据，不按进程名杀，不删除证据。
- feature map：至少 3–5 个用户路径，每条写入入口、驱动方式、期望结果、Gotchas。

正式重放仍走 tests/*.testspec.json；契约只回答“怎么把应用跑起来并证明行为”。

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
- kind = regression 的用例有失败前证据；无法取得时不得宣称回归保护，需由用户确认提供修复前环境或转为新增覆盖后再收口；新增/修改用例至少一条断言会在错误行为下失败。
- 测试质量自检已执行，弱断言已重写或删除。
- 若项目存在 tests/verify.md，本次改动涉及的 feature map 已更新。
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
- tests/environments/*.env.axiom (if present): local / remote mode, readiness probe, allowed Secret names (plaintext lives only in host secrets).
- Existing tests/ cases and naming habits: extend rather than invent a second convention.

# Minimal protocol field set (works offline)

The full protocol lives in docs/ui-api-automation-usage.md (inside the Axiom repo). When a new project lacks it, rely on the field set below plus the parser's needs-repair reasons (JSON path + cause) — never invent field names.

- Top level: kind:"axiom.test", version:9, id, name, target{}, testPoints[] (required, at least one), cases[], optional hooks{beforeAll,beforeEach,afterEach,afterAll} (each entry is an ordinary step).
- target: webBaseUrl / apiBaseUrl (\${env.WEB_BASE_URL} / \${env.API_BASE_URL}, also site-relative paths starting with /), viewport{width,height}.
- testPoints[]: id / kind (new_feature | regression) / title / acceptance.
- cases[]: id / name / verifies[] (ids from this file's testPoints) / steps[].
- UI actions: ui.navigate(url) / ui.click(locator) / ui.input(locator,value) / ui.select(locator,value) / ui.press(key) / ui.wait(expect, optional locator/timeoutMs/extract) / ui.assert(expect, optional locator/extract) / ui.screenshot(optional name).
- locator: {testId} first, then {role,name,exact?}.
- UiExpectation: exists / visible / enabled / textEquals / textContains / valueEquals / urlEquals / urlContains / count.
- API step api.request: method / url / query / headers (values may be {secretId:"apitest.xxx"}, or v6 {variable:"token", prefix:"Bearer "} referencing a sensitive extraction in the same case — login tokens go straight into sensitive headers; sensitive headers such as authorization / cookie / x-api-key accept only these references) / body + bodyMode (json|text|form, POST/PUT/PATCH/DELETE only) / redirect (manual|same-origin) / virtualHost (host[:port] for Host-routed reverse proxies; the network destination is unchanged) / expect[] / extract.
- Poll step api.poll: method (GET|HEAD) / url / query / headers / virtualHost / redirect / expect[] (required) / intervalMs (500–30000) / timeoutMs (<=120000 overall window) / extract (only on the attempt that passes) — wait for eventual consistency (config push, route rebuild) instead of guessing with fixed sleeps.
- Delay step api.delay: durationMs (1–30000); no side effects, no approval, for crossing second-level timing boundaries.
- ApiExpectation: status / statusIn (any listed code matches, v7) / headerEquals / headerContains / headerExists / headerAbsent / bodyContains / bodyNotContains (text must be absent, v8) / jsonPointerExists / jsonPointerEquals / jsonPointerLengthEquals (array length) / jsonPointerNumberAtLeast / jsonPointerNumberAtMost / maxElapsedMs.
- Placeholders: \${env.NAME} (WEB_BASE_URL / API_BASE_URL only), \${vars.name} (from an earlier extract), \${run.id} / \${run.slug} (unique test-data markers).
- Forbidden fields: tabId, AX ref, screenshot pixels, host absolute paths, plaintext secrets, JS/shell expressions, runtime Artifact paths — the parser rejects them fail-closed.

# Execution steps

1. **Test points first**: split the acceptance criteria into individually checkable points, each tagged kind — new_feature or regression (existing behaviour affected by the change). Vague points (the feature works) are not points; rewrite them into claims a single assertion can prove.
2. **Then cases**: at least one case per test point, with the case verifies list pointing at this file testPoints ids; unclaimed test points and dangling references are both reported as needs repair.
3. **Know the environment**: cases carry logical addresses (e.g. \${env.API_BASE_URL}) and Secret reference names only; real addresses live in the environment file or run environment.
4. **Build data through real endpoints**: setup belongs in case steps or hooks; never substitute mock/stub data for the environment.
5. **Verify control-plane changes on the data plane**: state which address is hit, what request or page action is performed, and what result is expected.
6. **Cleanup**: remove the data you created through the product own API, never by touching the database under test.
7. **Finish**: rescan on the testing page and confirm validation passes; when a case is reported as needs repair, fix it item by item instead of working around.

# Regression proof

A kind = regression case must include failure evidence; a new_feature case must at least prove that its assertions can distinguish correct from incorrect behavior.

1. Make the defect executable first: reproduce it on the same path before the fix. Write it as a test when possible; otherwise keep the rerunnable command, input and output.
2. Prove the case can fail: prefer running the same path in an existing pre-fix environment or version and confirm it fails for the intended reason; restore the current environment and rerun to green. Never modify the product source in this session to manufacture a failure. When no runnable pre-fix environment exists, mark the proof as unavailable and let the user decide whether to provide one or downgrade the case to new coverage; never claim regression protection.
3. Assertions must distinguish right from wrong: at least one assertion must fail on a wrong value, a missing side effect or a duplicated side effect. A status code alone, an element merely existing, or an assertion on data the test built itself does not count.
4. In the session report, state the failure evidence (command/log/screenshot path), the passing evidence, and what could not be proven.

# Test quality self-check

- Break the behavior: wrong values, missing side effects, duplicated side effects → the case must fail.
- Change only the internals with the observable result unchanged → the case must still pass.
- Derive expected values from the requirement or acceptance criteria, never from a run of the code under test.
- Each test point covers at least one boundary or failure path; a happy-path-only point must explain why.
- The verifies entry must match the assertion semantics, not just reference the test point formally.
- When any item fails, rewrite or delete the case instead of working around it to get green.

# Project verification contract (optional)

When the project needs repeatable verification and has no executable launch/drive instructions, read tests/verify.md; when it is missing, create it after user confirmation. It is a project document, not a new Skill, and does not replace the TestSpec Runner.

For Launch / Drive, reference existing environment files such as tests/environments/*.env.axiom and project commands instead of copying them into a second source of truth; add only information missing from those files.

Keep the contract short and include at least:

- Launch: start from an empty data directory to a usable state, including migrations and seed data; for a CLI, build once and use an isolated session per drive.
- Doctor: one read-only check for process, version, port and auth usability.
- Drive: the real UI/CLI/API driving method, preferring stable selectors (testId, role+name, command, route).
- Evidence: where screenshots, logs, responses and database read-backs live; evidence must survive cleanup.
- Cleanup: remove only the processes and data started by this run; never kill by process name and never delete evidence.
- Feature map: at least 3–5 user paths, each with its entry point, driving method, expected result and Gotchas.

Formal replay still goes through tests/*.testspec.json; the contract only answers how to run the app and prove behavior.

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
- Every regression case carries pre-fix failure evidence. When it is unavailable, never claim regression protection; close out only after the user chooses to provide a pre-fix environment or downgrade the case to new coverage. Every new or changed case has at least one assertion that fails on incorrect behavior.
- The test quality self-check ran, and weak assertions were rewritten or deleted.
- When the project has tests/verify.md, its feature map was updated for this change.
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
