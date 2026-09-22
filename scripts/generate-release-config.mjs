#!/usr/bin/env node
// 生成 Tauri 条件构建配置：
//   - macOS（默认）：apps/desktop/src-tauri/tauri.ci.conf.json（克隆 tauri.release.conf.json）
//   - Linux（--platform linux）：apps/desktop/src-tauri/tauri.linux.ci.conf.json（克隆 tauri.linux.release.conf.json）
//   - updater 可用时：注入签名公钥（TAURI_SIGNING_PUBLIC_KEY > 配置内已提交的
//     plugins.updater.pubkey），保留 bundle.createUpdaterArtifacts 与 plugins.updater
//   - updater 不可用时：移除 bundle.createUpdaterArtifacts 与 plugins.updater，
//     避免「createUpdaterArtifacts 无插件配置」「空公钥」导致构建/启动失败
//
// 注意：tauri-plugin-updater 常驻编译（lib.rs 按配置存在与否条件注册），因此
// 不能再像早期那样以 Cargo.toml 判断 updater 是否可用——判定来源只有公钥与签名私钥。
// Linux updater 仅 AppImage 支持自更新（Tauri v2 限制）；minisign 密钥与 macOS
// 同一把，latest.json 的 linux-x86_64 键即由本配置产出的 .AppImage/.sig 提供。
//
// 用法：node scripts/generate-release-config.mjs [--force-updater] [--force-no-updater] [--platform <macos|linux>]
// 决策优先级：--force 参数 > 环境变量 UPDATER_ENABLED=true/false > 自动检测
// （配置内已提交公钥非空且环境存在 TAURI_SIGNING_PRIVATE_KEY）。
// 本地发布链（release:local / build:dmg / build:linux）走自动检测；也可显式传
// UPDATER_ENABLED 与 TAURI_SIGNING_PUBLIC_KEY 固定行为。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const platformIndex = args.indexOf('--platform')
const platform = platformIndex >= 0 ? args[platformIndex + 1] : 'macos'
if (!['macos', 'linux'].includes(platform)) {
  console.error(`--platform 仅支持 macos/linux，收到：${platform}`)
  process.exit(2)
}
const CONFIG_SRC = path.join(
  root,
  'apps/desktop/src-tauri',
  platform === 'linux' ? 'tauri.linux.release.conf.json' : 'tauri.release.conf.json',
)
const CONFIG_OUT = path.join(
  root,
  'apps/desktop/src-tauri',
  platform === 'linux' ? 'tauri.linux.ci.conf.json' : 'tauri.ci.conf.json',
)

const forceUpdater = args.includes('--force-updater')
const forceNoUpdater = args.includes('--force-no-updater')
if (forceUpdater && forceNoUpdater) {
  console.error('--force-updater 与 --force-no-updater 不能同时使用')
  process.exit(2)
}

/** tauri.release.conf.json 内已提交的 updater 公钥（公钥可入库，非敏感）。 */
function committedPubkey(config) {
  return config?.plugins?.updater?.pubkey?.trim() ?? ''
}

/** 解析可用公钥：环境注入优先于配置内提交值。 */
function resolvePubkey(config) {
  const fromEnv = process.env.TAURI_SIGNING_PUBLIC_KEY?.trim() ?? ''
  return fromEnv || committedPubkey(config)
}

function resolveUpdaterEnabled(config) {
  if (forceUpdater) return true
  if (forceNoUpdater) return false
  if (process.env.UPDATER_ENABLED !== undefined) {
    return process.env.UPDATER_ENABLED === 'true'
  }
  // 自动检测：公钥已提交 + 本地具备签名私钥（tauri build 打 updater 产物时需要）。
  return committedPubkey(config) !== '' && process.env.TAURI_SIGNING_PRIVATE_KEY !== undefined
}

const base = JSON.parse(readFileSync(CONFIG_SRC, 'utf8'))
const updaterEnabled = resolveUpdaterEnabled(base)
if (updaterEnabled) {
  const pubkey = resolvePubkey(base)
  if (pubkey === '') {
    console.error(
      'updater 已启用但缺少签名公钥：请设置 TAURI_SIGNING_PUBLIC_KEY，或在 '
        + 'tauri.release.conf.json 的 plugins.updater.pubkey 提交公钥',
    )
    process.exit(2)
  }
  if (!base.plugins?.updater?.endpoints?.length) {
    console.error(`updater 已启用但 ${path.basename(CONFIG_SRC)} 未配置 plugins.updater.endpoints`)
    process.exit(2)
  }
  base.plugins.updater.pubkey = pubkey
} else {
  delete base.bundle.createUpdaterArtifacts
  delete base.plugins?.updater
  if (base.plugins && Object.keys(base.plugins).length === 0) delete base.plugins
}
writeFileSync(CONFIG_OUT, JSON.stringify(base, null, 2) + '\n')
console.log(
  `Generated ${path.relative(root, CONFIG_OUT)} (updater=${updaterEnabled ? 'enabled' : 'disabled'})`,
)
