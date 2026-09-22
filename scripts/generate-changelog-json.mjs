#!/usr/bin/env node
// 生成官网「版本更新记录」页数据源 changelog.json：从 CHANGELOG.md 提取各版本
// 条目并做**用户向简化**——仓库 CHANGELOG 面向开发者（长段落、重实现细节），
// 官网展示的是短句摘要。
//
// 简化规则（确定性，发布链自动执行）：
//   1. 章节 Added/Changed/Fixed/Security 映射为 新增/改进/修复/安全（其余 Keep a
//      Changelog 标准章节同样映射，未识别章节保留原名），空章节丢弃；
//   2. 条目剥离 markdown 修饰（加粗/链接/行内代码/标题行）与**括号注解**
//      （…（）…，如「（computer 工具，computer:control capability）」这类
//      能力/门控注记对用户无信息量），折叠空白；
//   3. 每条截断到 --max-chars（默认 40），优先在句读处截断；
//   4. 每章节最多 --max-items（默认 3）条，最多 --max-releases（默认 20）个版本。
//
// 用法：
//   node scripts/generate-changelog-json.mjs --changelog CHANGELOG.md --out changelog.json
// 发布链在 release job 内执行（checkout 的是 tag，自带该版本 CHANGELOG），
// 产物经 /updates/changelog.json 与 latest.json 同一卷暴露给官网。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SECTION_TITLES = {
  added: '新增',
  changed: '改进',
  fixed: '修复',
  security: '安全',
  deprecated: '弃用',
  removed: '移除',
}

const VERSION_HEADING_RE = /^## \[([^\]]+)\]\s*-\s*(\S+)/u
const SECTION_HEADING_RE = /^###\s+(.+)$/u

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

/** 剥离 markdown 修饰并折叠空白：加粗/行内代码去标记，链接保留文案。 */
function simplifyText(text) {
  // 括号注解是项目 CHANGELOG 最大的噪音源（如「（computer 工具，
  // computer:control capability，discover-gated）」），对官网用户无信息量，
  // 循环剥至无可嵌套为止。
  let stripped = text
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
  let previous
  do {
    previous = stripped
    stripped = stripped.replace(/（[^（）]*）|\([^()]*\)/gu, '')
  } while (stripped !== previous)
  return stripped.replace(/\s+/gu, ' ').trim()
}

/** 截断到 maxChars：句子结束符（。；！？）优先，退回句逗（，），均无则硬截，以 … 收尾。 */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const minimum = Math.floor(maxChars * 0.4)
  const sentenceStop = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('；'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
  )
  if (sentenceStop >= minimum) return slice.slice(0, sentenceStop + 1)
  const commaStop = slice.lastIndexOf('，')
  if (commaStop >= minimum) return slice.slice(0, commaStop + 1)
  return `${slice.trimEnd()}…`
}

const args = parseArgs(process.argv.slice(2))
const { changelog: changelogPath, out } = args
const maxItems = Number(args['max-items'] ?? 3)
// 官网展示力求简短：40 字符内一条（优先句读截断），详情以应用内为准。
const maxChars = Number(args['max-chars'] ?? 40)
const maxReleases = Number(args['max-releases'] ?? 20)

if (!changelogPath || !out) {
  console.error('必须提供 --changelog 与 --out')
  process.exit(2)
}
if (!Number.isInteger(maxItems) || maxItems < 1
  || !Number.isInteger(maxChars) || maxChars < 20
  || !Number.isInteger(maxReleases) || maxReleases < 1) {
  console.error('--max-items / --max-chars / --max-releases 必须是正整数')
  process.exit(2)
}

const content = readFileSync(changelogPath, 'utf8')
const releases = []
let currentVersion = null
for (const line of content.split('\n')) {
  const versionMatch = line.match(VERSION_HEADING_RE)
  if (versionMatch) {
    if (currentVersion && currentVersion.sections.length > 0) releases.push(currentVersion)
    currentVersion = { version: versionMatch[1].trim(), date: versionMatch[2].trim(), sections: [] }
    continue
  }
  if (!currentVersion) continue
  const sectionMatch = line.match(SECTION_HEADING_RE)
  if (sectionMatch) {
    const key = sectionMatch[1].trim().toLowerCase()
    currentVersion.sections.push({ title: SECTION_TITLES[key] ?? sectionMatch[1].trim(), items: [] })
    continue
  }
  const bullet = line.trim().startsWith('- ') ? line.trim().slice(2) : null
  if (bullet && currentVersion.sections.length > 0) {
    const section = currentVersion.sections[currentVersion.sections.length - 1]
    if (section.items.length < maxItems) {
      section.items.push(truncate(simplifyText(bullet), maxChars))
    }
  }
}
if (currentVersion && currentVersion.sections.length > 0) releases.push(currentVersion)

// 丢弃空章节；超出 maxReleases 的旧版本不输出
const trimmed = releases.slice(0, maxReleases).map((release) => ({
  ...release,
  sections: release.sections.filter((section) => section.items.length > 0),
}))

if (trimmed.length === 0) {
  console.error('CHANGELOG 中没有可解析的版本条目')
  process.exit(1)
}

const payload = {
  updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  releases: trimmed,
}
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(
  `Generated ${path.relative(root, out) || out}: ${trimmed.length} releases `
    + `(${trimmed[0].version} … ${trimmed[trimmed.length - 1].version})`,
)
