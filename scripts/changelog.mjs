// Keep a Changelog 风格 CHANGELOG.md 的 release notes 提取/校验工具。
// 适配 Axiom 的 Keep a Changelog 格式（## [version] 分节）。
//
// 用法：
//   node scripts/changelog.mjs extract --tag v0.1.0 --changelog CHANGELOG.md [--output release-notes.md]
//   node scripts/changelog.mjs validate --tag v0.1.0 --changelog CHANGELOG.md
//
// 纯 Node 实现（无第三方依赖）；extract/validate 的纯函数可被单测直接 import。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 从标题行解析版本号："## [0.1.0] - 未发布" → "0.1.0"。
 * 非版本分节（如 "## [Unreleased]" 仍会解析出 "Unreleased"）由调用方按需忽略。
 */
export function parseVersionFromHeading(line) {
  const match = line.match(/^##\s*\[([^\]]+)\]/)
  return match ? match[1] : null
}

/**
 * 提取指定 tag 的 release notes 正文。
 * 定位 "## [<version>]" 分节，采集到下一个 "## " 分节前；返回 trim 后的正文。
 * 条目不存在或正文为空时返回 null。
 */
export function extractReleaseNotes({ tag, changelog }) {
  const version = tag.replace(/^v/, '')
  const content = readFileSync(changelog, 'utf8')
  const lines = content.split('\n')
  let inSection = false
  const captured = []
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inSection) break
      if (parseVersionFromHeading(line) === version) {
        inSection = true
        continue
      }
    }
    if (inSection) captured.push(line)
  }
  if (!inSection) return null
  const text = captured.join('\n').trim()
  return text.length > 0 ? text : null
}

/** 校验 tag 在 CHANGELOG 中存在且非空。 */
export function validateReleaseNotes({ tag, changelog }) {
  return extractReleaseNotes({ tag, changelog }) !== null
}

function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const options = { tag: null, changelog: null, output: null }
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--tag':
        options.tag = args[++i]
        break
      case '--changelog':
        options.changelog = args[++i]
        break
      case '--output':
        options.output = args[++i]
        break
      default:
        console.error(`unknown argument: ${args[i]}`)
        process.exit(2)
    }
  }
  if (!options.tag || !options.changelog) {
    console.error(
      'usage: node scripts/changelog.mjs <extract|validate> --tag vX.Y.Z --changelog CHANGELOG.md [--output <file>]',
    )
    process.exit(2)
  }

  const changelog = path.resolve(root, options.changelog)

  if (command === 'validate') {
    if (validateReleaseNotes({ tag: options.tag, changelog })) {
      console.log(`Validated changelog entry: ${options.tag}`)
      process.exit(0)
    }
    console.error(`Missing or empty changelog entry for ${options.tag}`)
    process.exit(1)
  }

  if (command === 'extract') {
    const notes = extractReleaseNotes({ tag: options.tag, changelog })
    if (notes === null) {
      console.error(`Missing or empty changelog entry for ${options.tag}`)
      process.exit(1)
    }
    if (options.output) {
      writeFileSync(path.resolve(root, options.output), `${notes}\n`)
      console.log(`Extracted changelog entry: ${options.tag} -> ${options.output}`)
    } else {
      process.stdout.write(`${notes}\n`)
    }
    process.exit(0)
  }

  console.error(`unknown command: ${command}`)
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
