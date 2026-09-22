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
  // discover_agent_tools → v4
  { previousName: 'discover_agent_tools', previousVersion: '1', currentName: 'discover_agent_tools', currentVersion: '4' },
  { previousName: 'discover_agent_tools', previousVersion: '2', currentName: 'discover_agent_tools', currentVersion: '4' },
  { previousName: 'discover_agent_tools', previousVersion: '3', currentName: 'discover_agent_tools', currentVersion: '4' },

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
  { previousName: 'explore_subagent', previousVersion: '2', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '3', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '4', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '5', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '6', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '7', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '8', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '9', currentName: 'explore_subagent', currentVersion: '11' },
  { previousName: 'explore_subagent', previousVersion: '10', currentName: 'explore_subagent', currentVersion: '11' },

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
  { previousName: 'review_subagent', previousVersion: '1', currentName: 'review_subagent', currentVersion: '8' },
  { previousName: 'review_subagent', previousVersion: '2', currentName: 'review_subagent', currentVersion: '8' },
  { previousName: 'review_subagent', previousVersion: '3', currentName: 'review_subagent', currentVersion: '8' },
  { previousName: 'review_subagent', previousVersion: '4', currentName: 'review_subagent', currentVersion: '8' },
  { previousName: 'review_subagent', previousVersion: '5', currentName: 'review_subagent', currentVersion: '8' },
  { previousName: 'review_subagent', previousVersion: '6', currentName: 'review_subagent', currentVersion: '8' },
  { previousName: 'review_subagent', previousVersion: '7', currentName: 'review_subagent', currentVersion: '8' },
  { previousName: 'inspect_subagent', previousVersion: '1', currentName: 'inspect_subagent', currentVersion: '6' },
  { previousName: 'inspect_subagent', previousVersion: '2', currentName: 'inspect_subagent', currentVersion: '6' },
  { previousName: 'inspect_subagent', previousVersion: '3', currentName: 'inspect_subagent', currentVersion: '6' },
  { previousName: 'inspect_subagent', previousVersion: '4', currentName: 'inspect_subagent', currentVersion: '6' },
  { previousName: 'inspect_subagent', previousVersion: '5', currentName: 'inspect_subagent', currentVersion: '6' },
  { previousName: 'examine_subagent', previousVersion: '1', currentName: 'examine_subagent', currentVersion: '6' },
  { previousName: 'examine_subagent', previousVersion: '2', currentName: 'examine_subagent', currentVersion: '6' },
  { previousName: 'examine_subagent', previousVersion: '3', currentName: 'examine_subagent', currentVersion: '6' },
  { previousName: 'examine_subagent', previousVersion: '4', currentName: 'examine_subagent', currentVersion: '6' },
  { previousName: 'examine_subagent', previousVersion: '5', currentName: 'examine_subagent', currentVersion: '6' },

  // read → v6 (formerly read_workspace_file / read_authorized_text)
  // v5：工作区外绝对路径读取从「未授权直接拒绝」改为按需原生授权确认
  // （仅本次运行允许/始终允许/拒绝，Rust 侧 file_access.rs 审批对话框 +
  // 持久注册表）；schema 不变，授权语义增强。
  // v6：读取面免审批（对齐 codex 全盘读语义）——绝对路径直接读取，敏感
  // 路径（凭据载体 + ~/.axiom）由 Rust 侧 sensitive_read_denied fail-closed
  // 拒绝；「文件授权」机制降级为引用列表（无安全职能）。
  { previousName: 'read_workspace_file', previousVersion: '1', currentName: 'read', currentVersion: '6' },
  { previousName: 'read_authorized_text', previousVersion: '1', currentName: 'read', currentVersion: '6' },
  { previousName: 'read', previousVersion: '2', currentName: 'read', currentVersion: '6' },
  { previousName: 'read', previousVersion: '3', currentName: 'read', currentVersion: '6' },
  { previousName: 'read', previousVersion: '4', currentName: 'read', currentVersion: '6' },
  { previousName: 'read', previousVersion: '5', currentName: 'read', currentVersion: '6' },

  // ls → v4 (formerly list_workspace)
  { previousName: 'list_workspace', previousVersion: '1', currentName: 'ls', currentVersion: '4' },
  { previousName: 'ls', previousVersion: '2', currentName: 'ls', currentVersion: '4' },
  { previousName: 'ls', previousVersion: '3', currentName: 'ls', currentVersion: '4' },

  // grep → v5 (formerly search_workspace)
  { previousName: 'search_workspace', previousVersion: '1', currentName: 'grep', currentVersion: '5' },
  { previousName: 'grep', previousVersion: '2', currentName: 'grep', currentVersion: '5' },
  { previousName: 'grep', previousVersion: '3', currentName: 'grep', currentVersion: '5' },
  { previousName: 'grep', previousVersion: '4', currentName: 'grep', currentVersion: '5' },

  // find → v5
  { previousName: 'find', previousVersion: '1', currentName: 'find', currentVersion: '5' },
  { previousName: 'find', previousVersion: '2', currentName: 'find', currentVersion: '5' },
  { previousName: 'find', previousVersion: '3', currentName: 'find', currentVersion: '5' },
  { previousName: 'find', previousVersion: '4', currentName: 'find', currentVersion: '5' },

  // write → v6 (formerly create_workspace_file)
  // v5：幂等键从路径+字节长度改为路径+内容 SHA-256，消除"同路径同字节数、内容不同"的碰撞
  // v6：结果 details 新增 diffAdded/diffRemoved/diffPreview——会话 UI 可展开查看改动
  // diff；schema 不变，仅输出语义增强（details 只进持久化/展示层，不回灌模型）。
  { previousName: 'create_workspace_file', previousVersion: '2', currentName: 'write', currentVersion: '6' },
  { previousName: 'write', previousVersion: '2', currentName: 'write', currentVersion: '6' },
  { previousName: 'write', previousVersion: '3', currentName: 'write', currentVersion: '6' },
  { previousName: 'write', previousVersion: '4', currentName: 'write', currentVersion: '6' },
  { previousName: 'write', previousVersion: '5', currentName: 'write', currentVersion: '6' },

  // edit → v7 (formerly edit_workspace_file)
  // v6：幂等键从路径+长度签名改为路径+规范化参数 SHA-256，消除长度碰撞
  // v7：结果 details 新增 diffAdded/diffRemoved/diffPreview（同 write v6）。
  { previousName: 'edit_workspace_file', previousVersion: '2', currentName: 'edit', currentVersion: '7' },
  { previousName: 'edit', previousVersion: '2', currentName: 'edit', currentVersion: '7' },
  { previousName: 'edit', previousVersion: '3', currentName: 'edit', currentVersion: '7' },
  { previousName: 'edit', previousVersion: '4', currentName: 'edit', currentVersion: '7' },
  { previousName: 'edit', previousVersion: '5', currentName: 'edit', currentVersion: '7' },
  { previousName: 'edit', previousVersion: '6', currentName: 'edit', currentVersion: '7' },

  // apply_changes → v5 (formerly apply_workspace_changes)
  // v5：结果 details 新增 diffAdded/diffRemoved/diffPreview（只覆盖 create-file/
  // patch-file 文本型操作，全非文本批次不带 diff 段）。
  { previousName: 'apply_workspace_changes', previousVersion: '2', currentName: 'apply_changes', currentVersion: '5' },
  { previousName: 'apply_changes', previousVersion: '2', currentName: 'apply_changes', currentVersion: '5' },
  { previousName: 'apply_changes', previousVersion: '3', currentName: 'apply_changes', currentVersion: '5' },
  { previousName: 'apply_changes', previousVersion: '4', currentName: 'apply_changes', currentVersion: '5' },

  // restore_trash → v3 (formerly restore_workspace_trash)
  { previousName: 'restore_workspace_trash', previousVersion: '2', currentName: 'restore_trash', currentVersion: '3' },
  { previousName: 'restore_trash', previousVersion: '2', currentName: 'restore_trash', currentVersion: '3' },

  // browser → v2：新增 console 动作（读取页面 console 输出与运行时错误，
  // dev server 验证的主要观测面）；快照新增控件状态注记（[已禁用]/[已勾选]
  // 等）。schema 向后兼容（新增可选 limit 字段），行为增强。
  { previousName: 'browser', previousVersion: '1', currentName: 'browser', currentVersion: '2' },

  // browser → v3：新增 hover / wait（text+durationMs）/ find（服务端 AX 树
  // 关键词检索）三个动作；screenshot 增加可选 ref（元素区域裁剪截图）。对齐
  // zcode/ChatGPT 浏览器控制的节奏与检索原语；schema 向后兼容（新增动作与
  // 可选字段，旧会话恢复无需迁移即可读）。
  { previousName: 'browser', previousVersion: '2', currentName: 'browser', currentVersion: '3' },

  // browser → v4：新增 select_tab（切前台）、select_option（原生下拉按可见
  // 文本选择，focus+type-ahead+AX 值自校验）、upload_file（DOM.setFileInputFiles，
  // path 限授权工作区内防宿主文件外传）。schema 向后兼容（新增动作与可选字段）。
  { previousName: 'browser', previousVersion: '3', currentName: 'browser', currentVersion: '4' },

  // browser → v5：promptGuidelines 新增调度指引（视觉/交互验证优先内置
  // browser，排除 curl/web_fetch/computer 替代通道）。纯提示词语义增强，
  // schema 与动作集不变。
  { previousName: 'browser', previousVersion: '4', currentName: 'browser', currentVersion: '5' },

  // browser → v6：新增 dblclick / set_viewport（渲染视口覆盖，响应式验证）/
  // downloads / read_download（下载目录清单与受控文本读回——~/.axiom 对 read
  // 工具 deny，模型无法直读下载产物）。既有动作与语义不变，向后兼容。
  { previousName: 'browser', previousVersion: '5', currentName: 'browser', currentVersion: '6' },

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
  { previousName: 'run_workspace_command', previousVersion: '2', currentName: 'bash', currentVersion: '17' },
  { previousName: 'run_command', previousVersion: '2', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '2', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '3', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '4', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '5', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '6', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '7', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '8', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '9', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '10', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '11', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '12', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '13', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '14', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '15', currentName: 'bash', currentVersion: '17' },
  { previousName: 'bash', previousVersion: '16', currentName: 'bash', currentVersion: '17' },

  // ssh_hosts → v2：空主机消息指向新的「SSH」视图（侧栏导航），旧会话恢复需单跳迁移。
  { previousName: 'ssh_hosts', previousVersion: '1', currentName: 'ssh_hosts', currentVersion: '2' },

  // ssh → v2：共享源文件 bashTool.ts 的审批语义变化（bash v17 出网取消二次原生
  // 确认）触发语义审计重绑；ssh 自身 schema/行为不变。
  { previousName: 'ssh', previousVersion: '1', currentName: 'ssh', currentVersion: '2' },
]

export const migrateToolName = (name: string): string => RUNTIME_TOOL_NAME_MIGRATIONS[name] ?? name
