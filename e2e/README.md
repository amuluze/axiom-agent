# Axiom E2E

Axiom WebView 端到端集成测试框架（TypeScript + Playwright），结构对齐
`licensor/e2e`：用例是数据（`*.cases.yaml`）、规格是约束（`*.spec.yaml`）、
runner 是执行体（`*.runner.ts`），三者由 zod 契约与 `check-suite` 门禁绑定。

## 被测系统

被测对象是**真实前端**（`apps/desktop` 源码）+ **真实 TS Agent Runtime**，
运行在 Chromium 里，宿主边界（Rust 侧 Tauri 命令）由 e2e 自带的 **Node 假宿主**
替代：

- `e2e/src/host/bridge.ts`：经 `page.addInitScript` 在应用代码之前注入
  `window.__TAURI_INTERNALS__`，使 `isTauriRuntime()` 为真——前端因此走完整桌面
  路径（工作区授权、审批租约、模型 HTTP 流），而不是浏览器 demo 降级分支。
- `e2e/src/host/commands.ts`：命令面实现（运行时信息、工作区注册表、审批模式与
  租约、密钥、Artifact、脚本化模型流、工作区读写与文件枚举、命令执行，以及测试页
  旅程：测试索引读取、测试运行记录、UI 读/写步骤与步骤租约、浏览器标签页）。未实现的命令 fail-loud。
- `e2e/src/host/server.ts`：命令面 `/invoke` + 事件面 `/events`（SSE，回投
  `axiom:model-stream` / `axiom:workspace-command`）+ 控制面 `/control/*`。
- `e2e/src/host/model.ts`：脚本化模型响应（Anthropic Messages 帧，逐字对齐
  `AnthropicCompatibleTransport`），用例可精确控制每一轮输出（文本、工具调用）。

**已知接缝**：会话仓库被替换为应用自带的 `MemorySessionRepository`
（`e2e/vite.config.ts` 的 virtual module）。原生 SQLite 仓库的契约由
`cargo test` 与 `scripts/native-app-e2e.mjs` 覆盖；本套件聚焦 WebView 侧运行时与
UI 旅程，因此不重复实现 Rust SQL 行协议。接缝只存在于 e2e 的 dev server 配置里，
不触碰产品代码。

## 快速开始

```bash
cd e2e
npm install                        # 首次；Playwright 浏览器如缺失则 npx playwright install chromium
npm run validate                   # 零副作用自检：typecheck + 三件套配对 + 用例清单
npm test                           # integration + e2e（自动起 e2e 专用 dev server :1430）
npm run test:integration
npm run test:e2e
npx playwright show-report
```

> **`npm run validate` 绿 ≠ 用例通过**。validate 只校验「用例数据 ↔ zod 契约 ↔ spec 规则」
> 三向一致；真实通过必须 `npm test`。提交前的唯一绿灯条件是 `npm test` 全绿。

> **跑测试前确认 `apps/desktop/coverage/` 不存在**。该目录被 .gitignore 排除，
> 但若本地残留（vitest 历史产物），e2e dev server 的文件监听会扫描它并在
> 数十秒内触发数百次整页 reload，把内存态会话拦腰斩断——表现为大量用例
> 「找不到输入框 / 找不到按钮」。`vite.config.ts` 的 `watch.ignored` 已排除
> 该路径，但清理磁盘是更确定的姿势。

或在仓库根目录：

```bash
npm run e2e:validate
npm run e2e:test
npm run e2e:dev        # 单独起 e2e dev server（调试用）
task e2e:test
```

### 运行环境限制（重要）

Chromium 启动时必须打开 IOKit `RootDomainUserClient` 与查询 DNS 配置服务，默认
sandbox profile 均拒——因此在 Axiom 自身的 OS 沙箱（macOS seatbelt）内直接跑本
套件会在浏览器初始化阶段崩溃。两种做法：

```bash
# ① 普通终端（默认路径）
cd e2e && npm test

# ② 让 Axiom 的沙箱放行 Chromium（以 Axiom 进程环境声明；默认关闭）
AXIOM_SANDBOX_ALLOW_CHROMIUM=1 npm run tauri -- dev
# 之后在 Axiom 的 bash 工具里可以跑：cd e2e && npm test
```

放行面精确到 `iokit-user-client-class "RootDomainUserClient"` 与 mach-lookup
`com.apple.SystemConfiguration.DNSConfiguration` 两类，不含任何 I/O 写权限，
语义见 `.specs/domain/agent-execution-boundary.md` 不变量 8。
`playwright.config.ts` 已置 `launchOptions.chromiumSandbox: false`（本套件的隔离边界由外层环境提供）。

## 编写用例

每个 runner 三件套同名：

- `*.cases.yaml` — 测什么：case id、业务描述、输入、`verifies`；结构受
  `src/types/cases.ts` 的 zod 契约约束。
- `*.runner.ts` — 怎么测：用 fixtures 驱动页面与假宿主，断言并注册清理。
- `*.spec.yaml` — feature / business_rules / groups；`npm run check-suite` 校验
  groups ↔ cases 双向引用、`verifies` 指向已声明规则、每条规则至少被一个用例覆盖。

目录分层：

| 目录 | 职责 |
| --- | --- |
| `integration/` | 单一界面的黑盒契约（应用壳启动、工作区授权、测试页运行旅程） |
| `e2e/` | 跨界面旅程（发送 → 流式 → 工具调用 → 审批） |
| `src/host/` | 假 Tauri 宿主（桥接脚本、命令面、事件面、控制面、模型脚本） |
| `src/fixtures/` | Playwright fixtures：`app`（注入桥接的页面）、`host`（控制面客户端）、`server`、`runId` |
| `src/types/` | cases/spec 的 zod 契约 |
| `scripts/` | `validate-suite.ts` 框架自检 |
| `topology/` | 环境结构事实（URL）；秘密与覆盖走 `.env` |

## Fixtures 与约定

- **`app`**：已完成桥接注入、种子 Provider、首屏加载的页面；`waitForReady()` 等待
  输入框出现（未落入初始化回退分支）。
- **`host`**：控制面客户端——`seedWorkspace()`（预置原生选择器将返回的目录，
  可带文件）、`script()`（脚本化接下来若干轮模型响应）、`decideApproval()`（允许/拒绝
  当前待审批）、`snapshot()`（宿主状态：调用记录、审批记录、工作区、密钥）。
- **`server`**：worker 级假宿主（回环随机端口），状态在用例间天然隔离。
- **`runId`**：worker 级前缀，动态资源命名沿用 licensor 的纪律。
- **审批策略**：`E2E_APPROVAL_POLICY=hold`（默认，用例显式裁决）/
  `auto`（宿主自动签发，覆盖免审批模式）/ `deny`（一律拒绝，覆盖 fail-closed）。
- **用例间 host 状态隔离**：控制面提供 `/control/reset` 端点（`host.reset()`），
  清空运行时累积的 `turns` / `calls` / `approvals` / `approved` / `denied` /
  `artifacts` / `cancelled` / `pickQueue` / `testRuns` / `testTargets` /
  `testStepLeases`。**保留** `workspaces` / `activeWorkspacePath` / `secrets` /
  `leases`（这些由用例显式 setup）；因此需要干净注册表的套件必须在用例结束时
  自行撤销授权（见 `integration/testing/testing.runner.ts` 的 `afterEach`）。
  推荐用法：在用例 `sendPrompt` 之前调 `host.reset()` 并记下
  `baseline = snapshot.calls.length`，断言时取 `snapshot.calls.slice(baseline)`
  作为本用例增量（delta）。这避免同 worker 内更早用例的 lease 签发记录
  污染「拒绝路径未签发租约」类断言。
- **Provider 种子**：`src/fixtures/index.ts` 在页面加载前写入
  `axiom.provider.config.v1` / `axiom.provider.profiles.v1`，指向脚本化
  `custom-anthropic-compatible` profile——等价于 licensor 的 `stack:up` seed。
  同一脚本还打开浏览器能力开关（`axiom.browser.config.v1`），测试页运行需要目标
  Browser Tab；该开关关闭时 `browser_command` 的 spawn 类动作 fail-closed。

## 报告

Playwright 内置 HTML 报告（`test-results/`、`playwright-report/`，均不入库）：

```bash
npx playwright show-report
```
