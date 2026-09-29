<h1 align="center">Axiom</h1>

<p align="center">
  <strong>本地优先的全栈工程 Agent</strong><br />
  <sub>设计 → 开发 → 部署，在同一受控边界内闭环</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.1-7c3aed?style=flat-square" alt="Version 0.6.1" />
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 19" />
  <img src="https://img.shields.io/badge/Rust-1.96-DEA584?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

---

## 项目简介

**Axiom**（Tauri 2 · React 19 · TypeScript · SQLite）是一款本地优先的全栈工程 Agent：模型循环、工具协议、会话状态机与持久化边界全部第一方实现，会话与密钥全部留在本机；设计（`.ax` 设计稿与画布）、开发（规范驱动工作流）与部署（通过 SSH 连接远程服务器，快速部署相关服务）共用同一套工作区授权、逐次审批与可恢复事务边界，中间产物不必跨工具搬运。

## 核心亮点

| 领域 | 能力 |
|---|---|
| 自研运行时 | 流式模型循环、上下文压缩、重启恢复 |
| 内置工具 | read / write / 批量 Patch / bash / ssh |
| 安全边界 | 工作区授权、逐次审批 diff、seatbelt 沙箱、密钥不出 Rust |
| 会话 | 分支树、Checkpoint、SQLite 审计链 |
| 设计即代码 | `.ax` 画布实时投影、TSX 骨架生成 |
| 远程部署 | 在 `~/.ssh/config` 别名或主机注册表的目标主机上执行 SSH 命令，逐命令审批、凭据脱敏 |

## 快速开始

下载（签名 + 公证 + 应用内自更新）：**[axiom.amuluze.com](https://axiom.amuluze.com)**；或从源码构建（macOS 12+ / Node 22+ / Rust 1.96）：

```bash
git clone https://github.com/amuluze/axiom-agent.git
cd axiom-agent && npm install
npm run tauri -- dev   # 桌面开发模式
npm run dev            # 浏览器 Demo 模式，无需 API Key
```

## 参与贡献

**仅接受 Issue，不接受 PR。** 研发在上游私有仓库进行，本仓库随发布从上游同步导出，PR 无法回合上游、将被直接关闭；欢迎通过 Issue 反馈 Bug 与功能建议。安全漏洞请经 [SECURITY.md](SECURITY.md) 私下报告。

## 许可

[MIT](LICENSE) © 2026 amuluze
