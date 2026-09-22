#!/usr/bin/env node
// Linux 产物 glibc 基线自检：扫描构建产物（AppDir / deb data 目录）内全部 ELF
// 的动态符号，取 GLIBC / GLIBCXX 符号版本上界——它就是产物可运行的最低系统要求
// （glibc/libstdc++ 不打入 AppImage，运行时用目标机的）。
//
// 用法：
//   node scripts/linux-glibc-baseline.mjs --appdir <dir> [--deb-data <dir>] [--min 2.36]
// 输出（stdout，供 Taskfile 捕获注入发布说明）：
//   baseline-glibc: 2.44
//   baseline-glibcxx: 3.4.30
//   files-scanned: 124
//   supported-note: glibc ≥ 2.44（滚动发行版：Arch / Tumbleweed / Fedora 最新）
// --min 指定兼容目标下限（如兼容通道断言 debian:12 的 2.36）：实际基线高于该值
// 即退出 1（产物无法在目标 glibc 运行——符号版本只升不降）。
//
// 依赖 binutils 的 readelf（构建机必备）。AppImage 与 AppDir 内容一致（后者是
// 打包源），扫 AppDir 即等价于扫 AppImage。

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const argValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const appdir = argValue('--appdir')
const debData = argValue('--deb-data')
const minBaseline = argValue('--min')
if (!appdir) {
  console.error('必须提供 --appdir（AppImage 打包源目录）')
  process.exit(2)
}

/** 递归收集目录内全部常规文件。 */
const collectFiles = (dir) => {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(dir)
  return out
}

/** readelf 探测 ELF 并收集 GLIBC/GLIBCXX 符号版本；非 ELF / 解析失败返回 null。 */
const elfSymbolVersions = (file) => {
  const result = spawnSync('readelf', ['--dyn-syms', '--wide', file], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0 || result.error) return null
  const glibc = new Set()
  const glibcxx = new Set()
  for (const match of result.stdout.matchAll(/(GLIBC(?:XX)?)_([0-9]+(?:\.[0-9]+)*)/gu)) {
    if (match[1] === 'GLIBC') glibc.add(match[2])
    else glibcxx.add(match[2])
  }
  if (glibc.size === 0 && glibcxx.size === 0 && !result.stdout.includes('Dynamic symbol')) return null
  return { glibc, glibcxx }
}

/** 版本号比较（降序取最大）。 */
const maxVersion = (versions) => {
  let best = null
  for (const version of versions) {
    if (best === null) {
      best = version
      continue
    }
    const a = version.split('.').map(Number)
    const b = best.split('.').map(Number)
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if ((a[i] ?? 0) > (b[i] ?? 0)) { best = version; break }
      if ((a[i] ?? 0) < (b[i] ?? 0)) break
    }
  }
  return best
}

const compareVersions = (left, right) => {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  }
  return 0
}

const allGlibc = new Set()
const allGlibcxx = new Set()
let scanned = 0
const roots = [appdir, debData].filter(Boolean)
for (const root of roots) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`目录不存在：${root}`)
    process.exit(2)
  }
  for (const file of collectFiles(root)) {
    const versions = elfSymbolVersions(file)
    if (!versions) continue
    scanned += 1
    for (const item of versions.glibc) allGlibc.add(item)
    for (const item of versions.glibcxx) allGlibcxx.add(item)
  }
}
if (scanned === 0) {
  console.error('未扫描到任何 ELF 文件（目录为空或 readelf 不可用）')
  process.exit(1)
}

const glibcBaseline = maxVersion(allGlibc)
const glibcxxBaseline = maxVersion(allGlibcxx)

/** 按基线给发行版支持说明（滚动基线 vs 固定发行版基线的两类文案）。 */
const supportedNote = (baseline) => {
  const known = [
    ['2.35', 'Ubuntu 22.04'],
    ['2.36', 'Debian 12 / Ubuntu 22.04+'],
    ['2.38', 'Ubuntu 23.10+'],
    ['2.39', 'Ubuntu 24.04 / Fedora 40+'],
    ['2.41', 'Fedora 43+'],
  ]
  for (const [version, label] of known) {
    if (compareVersions(baseline, version) <= 0) return `glibc ≥ ${baseline}（${label}）`
  }
  return `glibc ≥ ${baseline}（滚动发行版：Arch / openSUSE Tumbleweed / Fedora 最新）`
}

console.log(`baseline-glibc: ${glibcBaseline}`)
console.log(`baseline-glibcxx: ${glibcxxBaseline ?? '无'}`)
console.log(`files-scanned: ${scanned}`)
console.log(`supported-note: ${supportedNote(glibcBaseline)}`)

if (minBaseline !== undefined && compareVersions(glibcBaseline, minBaseline) > 0) {
  console.error(`基线 ${glibcBaseline} 高于目标 ${minBaseline}：产物无法在目标 glibc 运行（符号版本只升不降）——请改用 debian:12 容器基线构建（task build:linux:container）`)
  process.exit(1)
}
