#!/usr/bin/env node
// 生成 Tauri updater 标准静态清单 latest.json（v2 格式），发布链在 Release
// 资产就绪后调用。官网 axiom.amuluze.com 是唯一更新端点：清单同步到官网 /updates/latest.json，
// 同时作为 Release 资产留档；下载 URL 指向官网 /downloads/ 镜像，签名取自
// tauri build 产出的 .sig 文件全文。
//
// 用法：
//   node scripts/generate-latest-json.mjs --tag v0.2.6 \
//     --assets-dir <发布资产目录> --out <latest.json 输出路径> \
//     [--download-base https://axiom.amuluze.com/downloads] \
//     [--notes <更新说明>] [--notes-file <notes 文本文件>] [--notes-url <发布页>]
//   --notes-file 读取文件并保留 Markdown 换行结构（行内空白折叠为单空格），
//   截断到 4000 字符且落在行边界（发布链接取自 CHANGELOG 提取的 release notes）；
//   --notes 优先级高于 --notes-file。
//
// --tag 与 package.json 版本一致性由 release:tag / release:gate 前置校验，这里只做格式校验。
// 平台键与 updater_arch()（darwin_${arch}）一致；发布链按文件名架构后缀
// （Axiom_<v>_<arch>.app.tar.gz）识别平台，aarch64/x86_64 各入对应键。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 客户端设置页以 Markdown 渲染 notes：保留换行结构（标题/列表），只折叠行内
// 空白；上限放宽到 4000 字符且截断落在行边界，不把半个词条留给展示端。
const MAX_NOTES_CHARS = 4000

// 「安装说明（未签名构建）」附录只面向 GitHub Release 页的手动 DMG 安装读者；
// 自更新用户经签名替换安装，不存在 Gatekeeper/quarantine 步骤。本地发布与 CI
// 的无签名路径都会把该附录追加进 release notes，这里在清单生成时剥离。
const INSTALL_APPENDIX_HEADING = /^#{1,6}\s*安装说明/u
const THEMATIC_BREAK = /^(-{3,}|\*{3,}|_{3,})$/u

const stripInstallAppendix = (lines) => {
  const cut = lines.findIndex((line) => INSTALL_APPENDIX_HEADING.test(line))
  if (cut < 0) return lines
  let start = cut
  while (start > 0 && (lines[start - 1].trim() === '' || THEMATIC_BREAK.test(lines[start - 1].trim()))) {
    start -= 1
  }
  return lines.slice(0, start)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!key.startsWith('--')) {
      throw new Error(`无法识别的参数：${key}（应为 --key value 形式）`)
    }
    args[key.slice(2)] = argv[index + 1] ?? ''
  }
  return args
}

const normalizeNotes = (text) => {
  const lines = stripInstallAppendix(
    text.split(/\r?\n/u).map((raw) => raw.replace(/[ \t]+/gu, ' ').trim()),
  )
  // 连续空行压成单个空行（Keep a Changelog 分节间保留一个空行即可）。
  const kept = []
  for (const line of lines) {
    if (line.length === 0 && (kept.at(-1) ?? '') === '') continue
    kept.push(line)
  }
  let normalized = kept.join('\n').trim()
  if (normalized.length > MAX_NOTES_CHARS) {
    const cut = normalized.lastIndexOf('\n', MAX_NOTES_CHARS)
    normalized = `${normalized.slice(0, cut > 0 ? cut : MAX_NOTES_CHARS)}…`
  }
  return normalized
}

const args = parseArgs(process.argv.slice(2))
const {
  tag,
  'assets-dir': assetsDir,
  out,
  'download-base': downloadBase = 'https://axiom.amuluze.com/downloads',
  notes,
  'notes-file': notesFile,
  'notes-url': notesUrl,
} = args

// 平台条目共用：同名 .sig 必须存在且非空（minisign 签名全文进入 manifest 的
// signature 字段，JSON 转义后为单行字符串），url 指向官网下载镜像。
const appendPlatformEntry = (platforms, entries, assetsDir, downloadBase, platformKey, artifactName) => {
  const signatureName = `${artifactName}.sig`
  if (!entries.includes(signatureName)) {
    console.error(`缺少签名文件 ${signatureName}（tauri build 需以签名密钥构建）`)
    process.exit(1)
  }
  const signature = readFileSync(path.join(assetsDir, signatureName), 'utf8').trim()
  if (signature.length === 0) {
    console.error(`签名文件为空：${signatureName}`)
    process.exit(1)
  }
  platforms[platformKey] = {
    signature,
    url: `${downloadBase}/${artifactName}`,
  }
}

if (!tag || !/^v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`--tag 必须是合法的发布 tag（如 v0.2.6），收到：${tag}`)
  process.exit(2)
}
if (!assetsDir || !out) {
  console.error('必须提供 --assets-dir 与 --out')
  process.exit(2)
}
if (!/^https:\/\//.test(downloadBase)) {
  console.error(`--download-base 必须是 https 地址，收到：${downloadBase}`)
  process.exit(2)
}

// 附录剥离可能清空整个 notes（极端：正文只有安装说明），兜底回默认文案。
const normalizedNotes = normalizeNotes(
  notes || (notesFile ? readFileSync(notesFile, 'utf8') : '') || '本次更新包含改进与修复。',
)
const resolvedNotes = normalizedNotes.length > 0 ? normalizedNotes : '本次更新包含改进与修复。'

const version = tag.slice(1)

// 在资产目录中定位 updater 产物与同名 .sig：
// - macOS：.app.tar.gz（双架构发布含 _aarch64/_x86_64 两份，按后缀映射平台键；
//   单架构发布兼容历史命名）。
// - Windows：Tauri v2 NSIS updater 工件 <安装器>_x64-setup.exe.zip（createUpdaterArtifacts
//   开启时产出），平台键 windows-x86_64；裸 .exe 安装器不经 updater，不入清单。
// - Linux：.AppImage（tauri bundler 的 deb 惯例架构名 amd64），平台键 linux-x86_64 /
//   linux-aarch64；AppImage 更新包即安装包。至少要有一种平台的产物，单平台发布
//   （如 Linux-only）不因缺另一平台而失败。
const entries = readdirSync(assetsDir)

// 文件名架构后缀 → updater 平台键（Tauri v2 updater_arch() 为 darwin_${arch} /
// linux_${arch}；tauri bundler 的 Linux 架构名沿用 deb 惯例 amd64）。
const DARWIN_PLATFORM_KEYS = new Map([
  ['aarch64', 'darwin-aarch64'],
  ['x86_64', 'darwin-x86_64'],
])
const LINUX_PLATFORM_KEYS = new Map([
  ['amd64', 'linux-x86_64'],
  ['x86_64', 'linux-x86_64'],
  ['aarch64', 'linux-aarch64'],
])

// updater 工件 → 平台键（含文件名架构后缀提取）。
const UPDATER_ARTIFACTS = [
  {
    match: (name) => /\.app\.tar\.gz$/u.test(name),
    platformKey: (name) => {
      const arch = /_([0-9A-Za-z_]+)\.app\.tar\.gz$/u.exec(name)?.[1] ?? ''
      return DARWIN_PLATFORM_KEYS.get(arch) ?? null
    },
    describe: () => `.app.tar.gz（后缀：${[...DARWIN_PLATFORM_KEYS.keys()].map((suffix) => `_${suffix}`).join(' / ')}）`,
  },
  {
    match: (name) => /_x64-setup\.exe\.zip$/u.test(name),
    platformKey: () => 'windows-x86_64',
    describe: () => '_x64-setup.exe.zip（NSIS updater 工件）',
  },  {
    match: (name) => /\.AppImage$/u.test(name),
    platformKey: (name) => {
      const arch = /_([0-9A-Za-z_]+)\.AppImage$/u.exec(name)?.[1] ?? ''
      return LINUX_PLATFORM_KEYS.get(arch) ?? null
    },
    describe: () => `.AppImage（后缀：${[...LINUX_PLATFORM_KEYS.keys()].map((suffix) => `_${suffix}`).join(' / ')}）`,
  },
]

const updaterArtifacts = entries
  .filter((name) => UPDATER_ARTIFACTS.some((rule) => rule.match(name)))
  .sort()
if (updaterArtifacts.length === 0) {
  console.error(`资产目录缺少 updater 产物：${assetsDir}`)
  console.error(`实际内容：${entries.join(', ') || '（空）'}`)
  console.error(`期望形态：${UPDATER_ARTIFACTS.map((rule) => rule.describe()).join(' / ')}`)
  process.exit(1)
}

const platforms = {}
for (const artifactName of updaterArtifacts) {
  const rule = UPDATER_ARTIFACTS.find((candidate) => candidate.match(artifactName))
  const platformKey = rule.platformKey(artifactName)
  if (!platformKey) {
    console.error(`无法从文件名识别架构：${artifactName}`)
    console.error(`期望后缀：${[...DARWIN_PLATFORM_KEYS.keys()].map((suffix) => `_${suffix}`).join(' / ')}`)
    process.exit(1)
  }
  const signatureName = `${artifactName}.sig`
  if (!entries.includes(signatureName)) {
    console.error(`缺少签名文件 ${signatureName}（tauri build 需以签名密钥构建）`)
    process.exit(1)
  }
  // minisign 签名全文进入 manifest 的 signature 字段（JSON 转义后为单行字符串）。
  const signature = readFileSync(path.join(assetsDir, signatureName), 'utf8').trim()
  if (signature.length === 0) {
    console.error(`签名文件为空：${signatureName}`)
    process.exit(1)
  }
  platforms[platformKey] = {
    signature,
    url: `${downloadBase}/${artifactName}`,
  }
}

const manifest = {
  version,
  notes: resolvedNotes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
}
if (notesUrl) manifest.notes_url = notesUrl

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
const platformSummary = Object.entries(platforms)
  .map(([key, entry]) => `${key} → ${entry.url}`)
  .join(', ')
console.log(`Generated ${path.relative(root, out) || out} (${version}: ${platformSummary})`)
