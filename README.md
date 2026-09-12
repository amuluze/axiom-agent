<h1 align="center">Axiom</h1>

<p align="center">
  <strong>本地优先的 macOS 桌面端编程 Agent</strong><br/>
  <sub>A local-first coding agent for macOS · first-party runtime · your data never leaves your machine</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Rust-1.96-DEA584?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
</p>

---

## 为什么是 Axiom

大多数编码 Agent 把「循环」外包给框架、把「上下文」同步到云端。Axiom 反其道而行——模型循环、工具协议、会话状态机、持久化边界**全部第一方实现**，数据**全部留在本机**：

- 🔒 **本地优先**：会话、审计链、密钥、工具结果全部存在本机（SQLite + 内容寻址存储）；API Key 只进 Rust 独占密钥表，WebView 拿不到明文。
- 🧠 **自研运行时**：不依赖任何 Agent 框架——流式模型循环、deferred tools、上下文压缩、重启恢复都是自己写的，行为可预测、边界可审计。
- 🛡️ **受控执行**：工作区显式授权 + 写操作逐次审批 diff + 任意命令跑在 macOS seatbelt 沙箱内；安全边界靠运行时强制，不靠提示词自觉。
- 🌳 **完整会话树**：多会话并行、分支、Checkpoint 回滚、崩溃恢复，全部随会话持久化。

## 核心能力

| 领域 | 能力 |
|---|---|
| 模型接入 | OpenAI / Anthropic 兼容端点，流式文本 / Thinking / Tool Call |
| 内置工具 | read / write / edit / apply_changes / bash（沙箱化）/ web 检索与抓取 |
| 系统操控 | 浏览器自动化（CDP）、macOS 电脑控制（辅助功能）、SSH 远程执行 |
| 安全边界 | 工作区授权、逐次审批租赁、seatbelt 沙箱、凭据脱敏、密钥隔离 |
| 会话控制 | 分支树、Checkpoint、上下文自动压缩、重启完整性恢复 |
| 扩展 | `AGENTS.md` 项目上下文、`.axiom/skills` 技能、SDD 工作流、审查 SubAgent |

## 快速开始

**下载安装**（Apple Silicon）：

👉 [axiom.amuluze.com](https://axiom.amuluze.com) —— Developer ID 签名、已公证，支持应用内自更新。

**从源码运行**（macOS 12+ / Node 22+ / npm 10+ / [rustup](https://rustup.rs)）：

```bash
git clone https://github.com/amuluze/axiom-agent.git
cd axiom-agent
npm install

# 桌面开发模式（原生命令全开）
npm run tauri -- dev

# 浏览器 Demo 模式（确定性 Transport，无需 API Key）
npm run dev
```

首次启动后在 **设置 → 模型** 填入 API Key（仅存本机 SQLite 密钥表），选择工作区即可开始。

## 开发

```bash
npm run check        # 提交前完整检查：typecheck + 单测 + Rust + 构建
npm run test         # vitest 单元测试
npm run lint:ts      # Biome lint
npm run lint:rust    # cargo clippy（-D warnings）
```

工具链由 `rust-toolchain.toml` 自动固定，无需手动管理 Rust 版本；提交前请确保 `npm run check` 通过。

## 安全模型一览

- 工作区授权只存在于当前进程，重启清空；恢复仅接受注册表登记过的路径
- 写操作强制串行 + 逐次审批，审批精确绑定实际执行的命令，崩溃后不重放
- bash 全命令在 seatbelt 沙箱内执行：凭据目录 deny、网络分档放行、输出脱敏
- 沙箱拒绝可观测：模型能看到「被拒了什么」并自我修正，而不是反复撞墙
- 密钥永不出 Rust：WebView 只持有 Secret ID，模型上下文不接触明文

## 参与贡献

Issue 与 PR 均欢迎。涉及安全边界（授权 / 审批 / 沙箱 / 密钥）的改动请在 PR 中说明对应的运行时强制机制如何联动。

**安全漏洞请勿公开披露**，请通过 [SECURITY.md](SECURITY.md) 的私下渠道报告。

## 许可

[MIT](LICENSE) © amuluze
