<h1 align="center">Axiom</h1>

<p align="center">
  <strong>A Local-First, Full-Stack Engineering Agent</strong><br />
  <sub>Design → develop → deploy, closed inside one controlled boundary</sub>
</p>

<p align="center">
  <a href="https://github.com/amuluze/axiom-agent/stargazers"><img src="https://img.shields.io/github/stars/amuluze/axiom-agent?style=flat-square&color=7c3aed" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/version-0.6.1-7c3aed?style=flat-square" alt="Version 0.6.1" />
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 19" />
  <img src="https://img.shields.io/badge/Rust-1.96-DEA584?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://axiom.amuluze.com/axiom-desktop.png" width="900" alt="Axiom desktop screenshot" />
</p>

---

## Overview

**Axiom** is a local-first, full-stack engineering agent built on Tauri 2, React 19, TypeScript, and SQLite. The model loop, tool protocol, session state machine, and persistence boundary are all first-party — no off-the-shelf agent runtime, no cloud sync: sessions, audit chains, and API keys stay on your machine (SQLite + content-addressed storage under `~/.axiom/`).

Design (`.ax` design files and the canvas), development (spec-driven workflows and SubAgent gates), and deployment (connecting to remote servers over SSH to quickly deploy services) share one controlled boundary — workspace authorization, per-action approval, recoverable transactions — so artifacts never have to hop between tools.

> Axiom is in early iteration at `0.6.1`.

## Highlights

| Area | What you get |
|---|---|
| First-party runtime | Streaming model loop, rich message protocol, context compaction, restart recovery |
| Built-in tools | read / write / batch patch / bash / ssh; deferred tools; results >256 KiB offloaded to content-addressed storage |
| Security boundary | Explicit workspace authorization, per-action diff approval, seatbelt sandbox by default, credential redaction, secrets never leave Rust |
| Sessions | Branch tree, retry-as-new-branch, checkpoints, SQLite audit chain |
| Design as code | First-party `.ax` format with a live canvas projection; `.ax` → TSX skeletons, pixel-level visual diffing |
| Remote deployment | One-shot SSH commands on hosts from `~/.ssh/config` or the Axiom host registry — per-command approval, credential-redacted output |

## Getting Started

Download (Developer ID signed, notarized, self-updating): **[axiom.amuluze.com](https://axiom.amuluze.com)**

From source (macOS 12+ / Node.js 22+ / Rust 1.96 via [rustup](https://rustup.rs)):

```bash
git clone https://github.com/amuluze/axiom-agent.git
cd axiom-agent && npm install
npm run tauri -- dev   # desktop dev mode (native commands enabled)
npm run dev            # browser demo mode, no API key needed
```

`npm run check` is the full pre-commit gate (typecheck + tests + build + Rust).

## Contributing

**Issues only — pull requests are not accepted.** Development happens in a private upstream repository; this repo is the public distribution and feedback channel, re-exported from upstream on every release, so PRs cannot be merged back and will be closed without review. Bug reports, feature requests, and discussions are welcome as issues.

Please report security vulnerabilities privately via [SECURITY.md](SECURITY.md) — not in public issues.

## License

[MIT](LICENSE) © 2026 amuluze. The website is the only public channel for installers and updates; this repository is the source and artifact archive.
