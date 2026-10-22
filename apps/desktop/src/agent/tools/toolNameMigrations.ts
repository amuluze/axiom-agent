export interface ToolNameMigration {
  currentName: string
  currentVersion: string
  previousName: string
  previousVersion: string
}

export const RUNTIME_TOOL_NAME_MIGRATIONS: Record<string, string> = {
  read_workspace_file: 'read',
  read_authorized_text: 'read',
  list_workspace: 'ls',
  search_workspace: 'grep',
  create_workspace_file: 'write',
  edit_workspace_file: 'edit',
  apply_workspace_changes: 'apply_changes',
  run_workspace_command: 'bash',
  run_command: 'bash',
  restore_workspace_trash: 'restore_trash',
  list_authorized_read_files: 'list_authorized_read_files',
  discover_agent_tools: 'discover_agent_tools',
  design_query: 'design_query',
  design_import: 'design_import',
}

// Each entry maps a persisted (name, version) pair to its current contract.
// `currentVersion` MUST equal the tool's live `runtimeVersion`; the restore
// check enforces this so a forgotten migration bump fails loudly instead of
// silently accepting a stale forward path. Every historical version of a tool
// gets its own direct entry — restore resolves a single hop, not a chain — so
// any older session can recover regardless of when it was persisted.
//
// When a tool's `runtimeVersion` is bumped, add a new entry for the previous
// version and update the prior entries' `currentVersion` only if you are also
// widening the contract. Bumping the version without adding an entry here is
// the exact drift this table exists to prevent.
export const RUNTIME_TOOL_COMPATIBILITY_MIGRATIONS: ToolNameMigration[] = [
  // api_request → v5：非 macOS 平台的「在场门」从静默放行改为宿主原生确认对话框
  // （macOS 行为不变：仍是手势 + 内容确认两层）；schema 不变，旧入参/恢复路径继续兼容。
  // 历史条目一律指向当前 live 版本——迁移表拒绝中间目标版本（单跳迁移）。
  { previousName: 'api_request', previousVersion: '4', currentName: 'api_request', currentVersion: '5' },
  // api_request → v4：带 Secret 的步骤签发租约前叠加原生内容确认，取消映射为 rejected；
  // schema 不变，旧入参/恢复路径继续兼容。
  { previousName: 'api_request', previousVersion: '3', currentName: 'api_request', currentVersion: '5' },
  { previousName: 'api_request', previousVersion: '2', currentName: 'api_request', currentVersion: '5' },
  { previousName: 'api_request', previousVersion: '1', currentName: 'api_request', currentVersion: '5' },
  // write → v12（父目录语义：缺失父目录在授权根内自动创建，见 task `write-parent-directory`；契约加宽，旧入参不变）。
  { previousName: 'write', previousVersion: '11', currentName: 'write', currentVersion: '12' },
  { previousName: 'write', previousVersion: '10', currentName: 'write', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '11', currentName: 'edit', currentVersion: '12' },
  { previousName: 'apply_changes', previousVersion: '9', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'restore_trash', previousVersion: '6', currentName: 'restore_trash', currentVersion: '7' },
  { previousName: 'bash', previousVersion: '25', currentName: 'bash', currentVersion: '26' },
  { previousName: 'design_import', previousVersion: '8', currentName: 'design_import', currentVersion: '9' },
  // write → v10 / edit → v11 / design_import → v8（完全访问档兑现）：
  // 写工具消费审批租约 tier，工作区外绝对路径在 Unrestricted 租约下真正可用
  // （此前仅 apply_changes/restore_trash 消费 tier，write/edit 恒被 Rust 拒绝）。
  // schema 不变，保护路径判定不变。
  { previousName: 'write', previousVersion: '9', currentName: 'write', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '10', currentName: 'edit', currentVersion: '12' },
  { previousName: 'design_import', previousVersion: '7', currentName: 'design_import', currentVersion: '9' },
  // design_query → v24（工具描述声明：无 .axiom/design/components.json 时清单来自 Axiom 宿主
  // 注册表，不得用于本项目稿与 codegen；输入 schema 与 details 字段不变）。
  { previousName: 'design_query', previousVersion: '23', currentName: 'design_query', currentVersion: '24' },
  // design_query → v23（scan 报告页级判定新增 `renderReason`：`render: 'skipped'` 现在带
  // 结构化原因 unavailable / no-size / interrupted，消费方不必读 issue 文案去猜「没验」；
  // 输入 schema 不变，既有 details 字段只增不改）。
  { previousName: 'design_query', previousVersion: '22', currentName: 'design_query', currentVersion: '24' },
  // design_query → v22（共享 Browser SetViewport 实现统一，输入与输出 schema 不变）。
  { previousName: 'design_query', previousVersion: '21', currentName: 'design_query', currentVersion: '24' },
  // design_query → v21（输入 schema 改为按 mode 判别的 anyOf，运行时兼容旧式省略 mode 入参）。
  { previousName: 'design_query', previousVersion: '20', currentName: 'design_query', currentVersion: '24' },
  // design_query → v20（契约扩展：.ax 1.5 slots——mode=component 详单新增 slots 段、
  // 读取路径核对 decl.slots；compare 新增可选 via='preview' 同引擎档（阈值 0.5%）。
  // 输入新增可选 via 字段，既有入参不变）。
  // design_query → v19（契约扩展：.ax 1.4 symbols——summary/page 返回 symbols 段、
  // node 可寻址 symbol body 子树、code 发射局部组件；输入 schema 不变）。
  { previousName: 'design_query', previousVersion: '19', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '18', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '17', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'write', previousVersion: '8', currentName: 'write', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '9', currentName: 'edit', currentVersion: '12' },
  { previousName: 'apply_changes', previousVersion: '8', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'restore_trash', previousVersion: '5', currentName: 'restore_trash', currentVersion: '7' },
  { previousName: 'design_import', previousVersion: '6', currentName: 'design_import', currentVersion: '9' },
  { previousName: 'explore_subagent', previousVersion: '15', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'review_subagent', previousVersion: '12', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'inspect_subagent', previousVersion: '10', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '10', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '14', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'review_subagent', previousVersion: '11', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'inspect_subagent', previousVersion: '9', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '9', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '12', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '13', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'review_subagent', previousVersion: '10', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'inspect_subagent', previousVersion: '8', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '8', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'review_subagent', previousVersion: '9', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'inspect_subagent', previousVersion: '7', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '7', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'write', previousVersion: '7', currentName: 'write', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '8', currentName: 'edit', currentVersion: '12' },
  { previousName: 'apply_changes', previousVersion: '7', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'restore_trash', previousVersion: '4', currentName: 'restore_trash', currentVersion: '7' },
  { previousName: 'bash', previousVersion: '22', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '21', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '20', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '19', currentName: 'bash', currentVersion: '26' },
  { previousName: 'design_import', previousVersion: '5', currentName: 'design_import', currentVersion: '9' },
  { previousName: 'design_query', previousVersion: '16', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '15', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'discover_agent_tools', previousVersion: '6', currentName: 'discover_agent_tools', currentVersion: '7' },
  { previousName: 'discover_agent_tools', previousVersion: '5', currentName: 'discover_agent_tools', currentVersion: '7' },
  { previousName: 'discover_agent_tools', previousVersion: '4', currentName: 'discover_agent_tools', currentVersion: '7' },
  { previousName: 'design_import', previousVersion: '4', currentName: 'design_import', currentVersion: '9' },
  { previousName: 'design_query', previousVersion: '14', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'bash', previousVersion: '18', currentName: 'bash', currentVersion: '26' },
  { previousName: 'restore_trash', previousVersion: '3', currentName: 'restore_trash', currentVersion: '7' },
  { previousName: 'apply_changes', previousVersion: '6', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'edit', previousVersion: '7', currentName: 'edit', currentVersion: '12' },
  { previousName: 'write', previousVersion: '6', currentName: 'write', currentVersion: '12' },
  { previousName: 'find', previousVersion: '5', currentName: 'find', currentVersion: '6' },
  { previousName: 'grep', previousVersion: '5', currentName: 'grep', currentVersion: '6' },
  { previousName: 'ls', previousVersion: '4', currentName: 'ls', currentVersion: '5' },
  { previousName: 'read', previousVersion: '7', currentName: 'read', currentVersion: '8' },
  // design_query → v4（契约扩展：mode=component 单组件详单 + scan 可选 tokensCss
  // 一致性报告 + 组件节点注册表核对——输入新增 component/tokensCss 可选字段）。
  // design_query → v5：render 失败原因透传——available:false 携带解析/挂载/光栅化/
  // 预算的具体 reason（不再一律归「no renderer available」），promptGuidelines 补
  // 「单次失败 ≠ 环境无渲染能力」引导；schema 不变，输出语义变化。
  // design_query → v6：新增 mode=reconcile（设计 ↔ 实现结构对账，输入新增可选
  // implementation 字段）——docs/ax-format.md §4.6.4 的 P4 遗留项；既有模式不变。
  // design_query → v7：扫描验证优化——① blank 误报防御：页面树有文本节点时
  // 「近乎空白」由 warning 降为 info（blankSparse，不影响页级全绿门禁），纯图形页
  // 仍 warning；② reconcile 文件收集上限 200→800（真实单仓源码含测试可达数百
  // 文件，过小使整目录对账必然触顶失真），guidelines 补 fileCapReached 收窄
  // roots 分批重跑的处置；③ 扫描渲染支持有界并发（offscreen 路径 3 lane，
  // native capture 保持串行防截图污染），判定与进度始终按页序，输出形状不变；
  // ④ 新增 mode=compare（设计页 ↔ 实现路由像素对拍，advisory：vendored
  // pixelmatch + 设计渲染/浏览器截图双源，输入新增 url/waitMs 可选字段）。
  // design_query → v8：感知 modelAcceptsImage——仅文本判定下 render 跳过光栅化、
  // scan 丢缩略图并给说明（产图工具服从同一能力判定）。
  // design_query → v9：说明文案收敛到与其它产图工具同一占位子串，并明确
  // 「模型能力所限 ≠ 环境无渲染能力」（Domain 不变量 6）。
  // 历史条目随 bump 统一改指 live v10（恢复查表要求 currentVersion === live）。
  { previousName: 'design_query', previousVersion: '13', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '12', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '11', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '1', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '2', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '3', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '4', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '5', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '6', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '7', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '10', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '9', currentName: 'design_query', currentVersion: '24' },
  { previousName: 'design_query', previousVersion: '8', currentName: 'design_query', currentVersion: '24' },
  // design_import → v2：租约改按 create_workspace_file 口径绑定编译产物（approvalLeaseInput）
  // ——v1 的租约绑定模型输入 {source,target}，与写通道消费侧失配，该工具从未能落盘；
  // schema 不变，属行为修复。
  // v1 条目原指 v2（恢复查表要求 currentVersion === live，指 v2 的会话无法恢复），
  // 随 design_query v4 同批修正为统一指 live。
  { previousName: 'design_import', previousVersion: '3', currentName: 'design_import', currentVersion: '9' },
  { previousName: 'design_import', previousVersion: '1', currentName: 'design_import', currentVersion: '9' },
  // design_import → v3（产物契约扩展：ref 实例升成 `component` 节点，返回体新增
  // upgradedComponents/deferredComponents 计数）——输入 schema 不变，属输出增强。
  { previousName: 'design_import', previousVersion: '2', currentName: 'design_import', currentVersion: '9' },
  // discover_agent_tools → v4
  { previousName: 'discover_agent_tools', previousVersion: '1', currentName: 'discover_agent_tools', currentVersion: '7' },
  { previousName: 'discover_agent_tools', previousVersion: '2', currentName: 'discover_agent_tools', currentVersion: '7' },
  { previousName: 'discover_agent_tools', previousVersion: '3', currentName: 'discover_agent_tools', currentVersion: '7' },

  // load_skill → v2：新增内置正文 Skill（builtinSkillBodies）双通道回退——项目未命中时
  // 返回内置正文（此前报未知技能）。schema 不变，属向后兼容的行为增强。
  // load_skill → v3：内置正文按能力自适应——未授予 subagent:review 时在返回正文后
  // 追加「按退出条件自查收口」能力说明，防止模型按正文调用不存在的审查工具。
  // load_skill → v4：能力说明重映射扩展——覆盖正文对 *_subagent 的两类句式（「何时
  // 进入」的通过条件与「由主 Agent 决定调用」的步骤），自查通过即视为满足进入条件。
  // load_skill → v5：promptGuidelines 中技能手动触发符从 `$name` 改为 `/name`，与
  // Composer 输入约定保持一致；schema 不变。
  // load_skill → v6：内置正文回退按 UI 语言解析 zh-CN/en 双语变体，并应用设置页
  // 保存的 per-language 用户覆写（promptLocalizationHost 执行期注入）。schema 不变。
  { previousName: 'load_skill', previousVersion: '1', currentName: 'load_skill', currentVersion: '6' },
  { previousName: 'load_skill', previousVersion: '2', currentName: 'load_skill', currentVersion: '6' },
  { previousName: 'load_skill', previousVersion: '3', currentName: 'load_skill', currentVersion: '6' },
  { previousName: 'load_skill', previousVersion: '4', currentName: 'load_skill', currentVersion: '6' },
  { previousName: 'load_skill', previousVersion: '5', currentName: 'load_skill', currentVersion: '6' },

  // explore_subagent → v10
  // v2：首次注册（discover-gated，不加入默认激活集）。
  // v3：预算/收口语义调整（未合入旧会话恢复路径前无实际影响）。
  // v4：新增 contextWindow 预算消费——估算 token 超窗口 fail-closed；补全迁移链，
  // 避免曾 discover 激活并持久化的旧会话在恢复时因无迁移路径被拒绝。
  // v5：normalizeScopeEntry 对规范化后为空的 `.`/`./` 拒绝（fail-closed），
  // 修复 scope 静默降级为全工作区的纵深防御绕过。
  // v6：Provider overflow 有总结时收口为 partial/context_limit（不再丢弃有效总结）；
  // 子会话诊断 type 标签归并到 parentRunUsage.diagnosticTypes；artifacts facade 封死。
  // v7：新增 breadth 参数（light/standard/thorough），映射到不同 child 预算。
  // v8：新增 maxOutputTokensPerRun 累计预算，跨轮 output token 超限 fail-closed。
  // v9：子会话 system prompt 强制中文输出（总结不随模型配置回退为英文）。
  // v10：子 Agent 只读工具集新增 web_search/web_fetch（与主 Agent 共享 web 只读
  // 能力，供探索时核对外部文档）；描述与子会话「允许的工具」段同步更新。
  // v11：子会话 system prompt 按 UI 语言解析 zh-CN/en 双语模板，并支持设置页按
  // 语言保存的用户覆写（promptLocalizationHost 执行期注入）。schema 不变。
  // explore_subagent → v12/v13 → v14（本轮）：**工具描述与子会话「允许的工具」段
  // 删除从未落地的 web_search/web_fetch**。v7 注释声称只读工具集新增了这两个 web
  // 工具，但 SUBAGENT_READONLY_TOOL_FACTORIES 从未包含它们（web/browser/ssh 已在
  // 2026-10-05 整体移除且明确不再进入 capability union）——文案回退后没跟上，
  // 子模型据此尝试调用不存在的工具、白耗轮次与预算。schema 不变，仅描述与提示词
  // 文本回归真实工具集。
  // review_subagent → v9 → v10 → v11、inspect/examine → v6 → v7 → v8 → v9：
  // 同批文案订正。
  // explore_subagent → v14 → v15、inspect/examine → v8 → v9 → v10、review → v11 → v12：
  // 子会话提示词的「允许的工具」段改为 {{TOOLS}} 占位符并从只读工厂表派生
  // （explore 原为内联静态文本，与 SUBAGENT_READONLY_TOOL_FACTORIES 形成第二事实源）。
  // schema 不变。
  // → v16（inspect/examine v11、review v13）：英文模板的工具说明改用英文 hint，
  // 不再在 `# Allowed tools` 下混入中文。schema 不变。
  { previousName: 'explore_subagent', previousVersion: '2', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '3', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '4', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '5', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '6', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '7', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '8', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '9', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '10', currentName: 'explore_subagent', currentVersion: '16' },
  { previousName: 'explore_subagent', previousVersion: '11', currentName: 'explore_subagent', currentVersion: '16' },

  // review_subagent → v2：新增可选 diff 参数——子 Agent 无 bash/git，父 Agent 经
  // diff 参数携带 git diff 全文，消除「只看改动后状态、看不到改了什么」的 diff 盲区。
  // schema 向后兼容（新增可选字段），行为增强。
  // review_subagent → v3：新增 breadth 档位（light/standard/thorough）+ details 结构化
  // verdict（pass/fail/unknown，partial 收口为 unknown）。inspect/examine 同批升级到 v2。
  // review_subagent → v4：diff 上限从 JS 字符数改为 UTF-8 字节口径（CJK diff 按
  // 字符数放行实际字节可达约 3 倍，吞掉子会话消息预算余量）；execute 层 scope 部分
  // 条目规范化失败从静默收窄改为 fail-closed 整体拒绝；审查 prompt 渲染 contextWindow。
  // inspect/examine 同批升级到 v3（共享后两项改动）。
  // → v5（inspect/examine v4）：软门禁收口提示——fail 判定在父工具结果前置回环
  // 指令（问题闭环前不进入 finish、用户显式接受风险是唯一越门路径），completed
  // 但格式漂移时提示通读全文。schema 不变，仅结果语义增强。
  // review_subagent → v6：无 diff 委派降级处理——子任务追加「当前状态基准」说明、
  // 会话有 workspace:execute 时父结果前置降级提醒（建议采集 diff 重新委派）。schema 不变。
  // → v7（inspect/examine v5）：子 Agent 只读工具集新增 web_search/web_fetch（与主
  // Agent 共享 web 只读能力）；inspect/examine 描述同步更新。schema 不变。
  // review_subagent → v8（inspect/examine v6）：子会话 system prompt 按 UI 语言
  // 解析 zh-CN/en 双语模板（en 模板 verdict 锚点 Verdict: pass/fail，解析器双语），
  // 并支持设置页按语言保存的用户覆写。schema 不变。
  { previousName: 'review_subagent', previousVersion: '1', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'review_subagent', previousVersion: '2', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'review_subagent', previousVersion: '3', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'review_subagent', previousVersion: '4', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'review_subagent', previousVersion: '5', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'review_subagent', previousVersion: '6', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'review_subagent', previousVersion: '7', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'review_subagent', previousVersion: '8', currentName: 'review_subagent', currentVersion: '13' },
  { previousName: 'inspect_subagent', previousVersion: '1', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'inspect_subagent', previousVersion: '2', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'inspect_subagent', previousVersion: '3', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'inspect_subagent', previousVersion: '4', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'inspect_subagent', previousVersion: '5', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'inspect_subagent', previousVersion: '6', currentName: 'inspect_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '1', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '2', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '3', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '4', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '5', currentName: 'examine_subagent', currentVersion: '11' },
  { previousName: 'examine_subagent', previousVersion: '6', currentName: 'examine_subagent', currentVersion: '11' },

  // read → v7：仅文本判定下的图片降级文案收敛到统一占位子串（UNSUPPORTED_IMAGE_NOTE），
  // 并明确「模型能力所限 ≠ 读取失败」（Domain 不变量 6）。schema 不变，输出语义变化。
  { previousName: 'read', previousVersion: '6', currentName: 'read', currentVersion: '8' },
  // browser → v8：screenshot 降级文案同上收敛。schema 不变，输出语义变化。
  // computer → v3：state/screenshot 两个产图点降级文案同上收敛。schema 不变。
  // v5：工作区外绝对路径读取从「未授权直接拒绝」改为按需原生授权确认
  // （仅本次运行允许/始终允许/拒绝，Rust 侧 file_access.rs 审批对话框 +
  // 持久注册表）；schema 不变，授权语义增强。
  // v6：读取面免审批（对齐 codex 全盘读语义）——绝对路径直接读取，敏感
  // 路径（凭据载体 + ~/.axiom）由 Rust 侧 sensitive_read_denied fail-closed
  // 拒绝；「文件授权」机制降级为引用列表（无安全职能）。
  { previousName: 'read_workspace_file', previousVersion: '1', currentName: 'read', currentVersion: '8' },
  { previousName: 'read_authorized_text', previousVersion: '1', currentName: 'read', currentVersion: '8' },
  { previousName: 'read', previousVersion: '2', currentName: 'read', currentVersion: '8' },
  { previousName: 'read', previousVersion: '3', currentName: 'read', currentVersion: '8' },
  { previousName: 'read', previousVersion: '4', currentName: 'read', currentVersion: '8' },
  { previousName: 'read', previousVersion: '5', currentName: 'read', currentVersion: '8' },

  // ls → v4 (formerly list_workspace)
  { previousName: 'list_workspace', previousVersion: '1', currentName: 'ls', currentVersion: '5' },
  { previousName: 'ls', previousVersion: '2', currentName: 'ls', currentVersion: '5' },
  { previousName: 'ls', previousVersion: '3', currentName: 'ls', currentVersion: '5' },

  // grep → v5 (formerly search_workspace)
  { previousName: 'search_workspace', previousVersion: '1', currentName: 'grep', currentVersion: '6' },
  { previousName: 'grep', previousVersion: '2', currentName: 'grep', currentVersion: '6' },
  { previousName: 'grep', previousVersion: '3', currentName: 'grep', currentVersion: '6' },
  { previousName: 'grep', previousVersion: '4', currentName: 'grep', currentVersion: '6' },

  // find → v5
  { previousName: 'find', previousVersion: '1', currentName: 'find', currentVersion: '6' },
  { previousName: 'find', previousVersion: '2', currentName: 'find', currentVersion: '6' },
  { previousName: 'find', previousVersion: '3', currentName: 'find', currentVersion: '6' },
  { previousName: 'find', previousVersion: '4', currentName: 'find', currentVersion: '6' },

  // write → v6 (formerly create_workspace_file)
  // v5：幂等键从路径+字节长度改为路径+内容 SHA-256，消除"同路径同字节数、内容不同"的碰撞
  // v6：结果 details 新增 diffAdded/diffRemoved/diffPreview——会话 UI 可展开查看改动
  // diff；schema 不变，仅输出语义增强（details 只进持久化/展示层，不回灌模型）。
  { previousName: 'create_workspace_file', previousVersion: '2', currentName: 'write', currentVersion: '12' },
  { previousName: 'write', previousVersion: '2', currentName: 'write', currentVersion: '12' },
  { previousName: 'write', previousVersion: '3', currentName: 'write', currentVersion: '12' },
  { previousName: 'write', previousVersion: '4', currentName: 'write', currentVersion: '12' },
  { previousName: 'write', previousVersion: '5', currentName: 'write', currentVersion: '12' },

  // edit → v7 (formerly edit_workspace_file)
  // v6：幂等键从路径+长度签名改为路径+规范化参数 SHA-256，消除长度碰撞
  // v7：结果 details 新增 diffAdded/diffRemoved/diffPreview（同 write v6）。
  { previousName: 'edit_workspace_file', previousVersion: '2', currentName: 'edit', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '2', currentName: 'edit', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '3', currentName: 'edit', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '4', currentName: 'edit', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '5', currentName: 'edit', currentVersion: '12' },
  { previousName: 'edit', previousVersion: '6', currentName: 'edit', currentVersion: '12' },

  // apply_changes → v6 (formerly apply_workspace_changes)
  // v5：结果 details 新增 diffAdded/diffRemoved/diffPreview（只覆盖 create-file/
  // patch-file 文本型操作，全非文本批次不带 diff 段）。
  { previousName: 'apply_workspace_changes', previousVersion: '2', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'apply_changes', previousVersion: '2', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'apply_changes', previousVersion: '3', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'apply_changes', previousVersion: '4', currentName: 'apply_changes', currentVersion: '10' },
  { previousName: 'apply_changes', previousVersion: '5', currentName: 'apply_changes', currentVersion: '10' },

  // restore_trash → v3 (formerly restore_workspace_trash)
  { previousName: 'restore_workspace_trash', previousVersion: '2', currentName: 'restore_trash', currentVersion: '7' },
  { previousName: 'restore_trash', previousVersion: '2', currentName: 'restore_trash', currentVersion: '7' },

  // browser → v2：新增 console 动作（读取页面 console 输出与运行时错误，
  // dev server 验证的主要观测面）；快照新增控件状态注记（[已禁用]/[已勾选]
  // 等）。schema 向后兼容（新增可选 limit 字段），行为增强。
  // browser → v3：新增 hover / wait（text+durationMs）/ find（服务端 AX 树
  // 关键词检索）三个动作；screenshot 增加可选 ref（元素区域裁剪截图）。对齐
  // zcode/ChatGPT 浏览器控制的节奏与检索原语；schema 向后兼容（新增动作与
  // 可选字段，旧会话恢复无需迁移即可读）。
  // browser → v4：新增 select_tab（切前台）、select_option（原生下拉按可见
  // 文本选择，focus+type-ahead+AX 值自校验）、upload_file（DOM.setFileInputFiles，
  // path 限授权工作区内防宿主文件外传）。schema 向后兼容（新增动作与可选字段）。
  // browser → v5：promptGuidelines 新增调度指引（视觉/交互验证优先内置
  // browser，排除 curl/web_fetch/computer 替代通道）。纯提示词语义增强，
  // schema 与动作集不变。
  // browser → v6：新增 dblclick / set_viewport（渲染视口覆盖，响应式验证）/
  // downloads / read_download（下载目录清单与受控文本读回——~/.axiom 对 read
  // 工具 deny，模型无法直读下载产物）。既有动作与语义不变，向后兼容。
  // browser → v7：downloads 返回文案修正——移除「文件路径可直接交给 read 工具读取」
  // 的误导指引（下载目录位于 ~/.axiom 数据根，对 read 工具是敏感拒绝路径，直读必被
  // 拒），改为只引导 read_download。schema 与动作集不变，纯输出文案修正。
  // 历史条目随 v7 bump 统一改指 live：此前各条目指向中间版本，而恢复查表要求
  // currentVersion === live（runtimeDependencyManifest.ts 的 toolMigration 校验），
  // 中间版本指向会让更早版本时代激活过 browser 的旧会话恢复被拒——与 design_query
  // 当年的统一修正同理（见上方注释）。

  // computer → v2：① 快照输出修正——passwordbox 的 AXValue 不再回显（原生
  // SecureTextField 通常不给明文，但 Electron/Qt 自绘 UI 的 a11y 实现不保证，
  // 防御性排除）；② stateToken 锚点放宽到最近两次 state 内有效（抗界面微动
  // 导致锚点立即失效，第三代起淘汰）；③ click_at 的右键/双击不再被 AXPress
  // 语义路径吞掉意图；④ 提示词治本——写文本到指定元素首选 set_value（AXValue
  // 直设无焦点依赖），type_text/key 定位为前台应用的键盘快捷路径（元素锚点
  // 仅先聚焦，schema 描述同步）。schema 不变，输出与行为语义变化。

  // bash → v13 (formerly run_workspace_command / run_command)
  // v9：安全守卫扩展——sudo 命令上下文边界、重定向到引号/变量/noclobber/命令替换目标
  // v10：重定向守卫扩展——`>&` 文件复制形式与 `exec {fd}>` 绝对路径封堵。
  // v11：新增 `network` 字段——声明命令是否需要出站网络，决定沙箱内单层审批或双层。
  // v12：重定向守卫放行 `/dev/null` 例外（空设备无文件写入，seatbelt 沙箱显式允许）。
  // v13（第一版，已回滚）：sudo 词边界扩展，未合入主干。
  // v13（第二版）：沙箱语义变更——network:true 命令改为「沙箱内 + 网络启用」
  // 执行（写仍限工作区），默认档放行本机回环；`network` 参数描述同步更新。
  // 两版 v13 的 schema 完全一致（command/cwd/timeout/network），旧会话残留的
  // 第一版 v13 经单跳迁移到 v14 即可恢复。
  // v14：输出新增可选「Sandbox denials」段落——命令被 seatbelt 拒绝的操作摘要
  // （含 network 提示），schema 不变。
  // v15：git clone/fetch/pull/push/ls-remote/submodule-update 等 VCS 网络命令在
  // NetworkRequired 沙箱内精确放行 ~/.ssh 与 ~/.config/git/credentials 读取，解决
  // git push 因无法读取 SSH 私钥而被 seatbelt deny 拦截的问题；schema 不变。
  // v16：沙箱后端平台化（macOS Seatbelt / Linux bubblewrap，docs/linux-support.md
  // §2）——审批卡片描述与沙箱降级警示文案去掉 "macOS Seatbelt" 专名，输出语义
  // 随平台变化；schema 不变。
  // v17：出网取消单独的二次原生确认——networkRequired 命令与沙箱级命令同为单层
  // 卡片审批（Rust 权威分类仍绑定 lease，执行档不变）；schema 不变，审批文案变化。
  // v18-v21：审批语义演进（特权会话授权、完全访问有界自动签发等，详见
  // docs/runtime-security-optimization.md 对应日期条目）。
  // v22：完全访问重定义为效率档——纯出网命令（声明 network、无特权）在
  // Automatic 下直接自动签发（旧语义逐次卡片 + 原生确认）；特权命令仍须会话
  // 授权覆盖，沙箱边界不变。promptGuidelines 同步，schema 不变。
  // v23：完全访问改为会话级模式；容器控制不再创建会话授权，每条命令均须逐次
  // 原生确认；模式切换使既有 Automatic 租约失效。schema 不变。
  // v24：原生确认整体退役——标准模式全档单层（仅审批卡片），「完全访问」不再有
  // 任何确认且命令不经 OS 沙箱（对齐 ChatGPT Full Access 的 danger-full-access）。
  // bash schema 的 network/vcsCredentials/containerControl 描述与 promptGuidelines
  // 同步改为「沙箱内定点放行」与「完全访问下这些声明无意义」。
  // v25：接受 Rust 权威返回的 Unrestricted 执行结果，并在模型输出与审计 details
  // 中显式记录实际执行边界；标准模式卡片同步为唯一一次确认。
  { previousName: 'bash', previousVersion: '24', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '23', currentName: 'bash', currentVersion: '26' },
  { previousName: 'run_workspace_command', previousVersion: '2', currentName: 'bash', currentVersion: '26' },
  { previousName: 'run_command', previousVersion: '2', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '17', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '2', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '3', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '4', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '5', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '6', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '7', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '8', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '9', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '10', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '11', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '12', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '13', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '14', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '15', currentName: 'bash', currentVersion: '26' },
  { previousName: 'bash', previousVersion: '16', currentName: 'bash', currentVersion: '26' },

  // ui_click / ui_input / ui_select → v2（输入加宽）：目标从「仅 ref」加宽为
  // 「locator 或 ref 二选一」——locator 先经只读 resolveLocator 通道解析出唯一候选的
  // ref 再执行写动作（零匹配/歧义以错误收口，不取第一个候选）。ref 形式与既有语义
  // 不变，旧会话的 v1 入参无需改写即可恢复，属向后兼容加宽。
  { previousName: 'ui_click', previousVersion: '1', currentName: 'ui_click', currentVersion: '2' },
  { previousName: 'ui_input', previousVersion: '1', currentName: 'ui_input', currentVersion: '2' },
  { previousName: 'ui_select', previousVersion: '1', currentName: 'ui_select', currentVersion: '2' },

  // ssh_hosts → v2：空主机消息指向新的「SSH」视图（侧栏导航），旧会话恢复需单跳迁移。
  // → v5：主机选择授权（SshHost，会话级可复用）与单次命令审批（SshCommand）拆成
  // 两个原生资源，清单只反映可复用选择授权；旧会话单跳迁到新契约。

  // ssh → v2：共享源文件 bashTool.ts 的审批语义变化（bash v17 出网取消二次原生
  // 确认）触发语义审计重绑；ssh 自身 schema/行为不变。
  // → v5：命令审批改绑独立的 SshCommand 资源，不再与可复用主机选择授权共用槽位。
]

export const migrateToolName = (name: string): string => RUNTIME_TOOL_NAME_MIGRATIONS[name] ?? name
