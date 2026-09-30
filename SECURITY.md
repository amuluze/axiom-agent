# Security Policy / 安全政策

## Supported Versions / 支持的版本

| Version / 版本 | Status / 支持状态 |
|---|---|
| Latest release / 最新 release | ✅ |

## Reporting a Vulnerability / 报告漏洞

**Please do not report security vulnerabilities through public GitHub issues.**
**请勿通过公开 Issue 报告安全漏洞。**

Axiom's security boundary depends on runtime mechanisms (workspace grants, per-action approval leases, seatbelt/bwrap sandboxing, and credential isolation). Undisclosed bypass paths are especially valuable to attackers. Please report privately through GitHub's "Report a vulnerability" flow (Security tab → Report a vulnerability). Reports stay private until a fix ships.
Axiom 的安全模型依赖工作区授权、审批租赁、seatbelt/bwrap 沙箱与密钥隔离等运行时强制机制，未公开披露的绕过路径尤其有价值。请通过 GitHub 的「私下漏洞报告」（仓库 Security 标签页 → Report a vulnerability）私下报告，报告内容默认保密直到修复发布。

Please include / 报告请尽量包含:

- Impact scope (which tool / which security boundary) / 影响范围（哪个工具 / 哪条安全边界）
- Reproduction steps or proof of concept / 复现步骤或概念验证
- Your severity assessment and possible fix direction / 你评估的严重程度与可能的修复方向

We will acknowledge receipt as soon as possible and credit reporters in the CHANGELOG after the fix ships.
我们会在收到后尽快响应，并在修复发布后的 CHANGELOG 中致谢。