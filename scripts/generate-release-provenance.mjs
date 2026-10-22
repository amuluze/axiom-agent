#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const parseArgs = (args) => {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    const value = args[index + 1]
    if (!name.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`参数无效：${name}`)
    }
    options[name.slice(2)] = value
    index += 1
  }
  return options
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const requireCommit = (value, label) => {
  if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new Error(`${label}不是完整 Git 提交哈希`)
  return value
}

const releaseSection = (changelog, version) => {
  const heading = `## [${version}]`
  const start = changelog.indexOf(heading)
  if (start < 0) throw new Error(`CHANGELOG 缺少 ${version} 分节`)
  const next = changelog.indexOf('\n## [', start + heading.length)
  return changelog.slice(start, next < 0 ? undefined : next)
}

const securityChanges = (section) => {
  const lines = section.split('\n')
  const changes = []
  let active = false
  for (const line of lines) {
    if (line.startsWith('### ')) {
      active = /^### (?:Security|安全|安全性)$/u.test(line.trim())
      continue
    }
    if (active && line.startsWith('- ')) changes.push(line.slice(2).trim())
  }
  return changes
}

const publicKeyMetadata = (configPath) => {
  const config = readJson(configPath)
  const encoded = process.env.TAURI_SIGNING_PUBLIC_KEY?.trim()
    || config?.plugins?.updater?.pubkey?.trim()
  if (!encoded) throw new Error('缺少 updater minisign 公钥')
  let decoded
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    throw new Error('updater minisign 公钥不是有效 base64')
  }
  const keyId = decoded.match(/minisign public key:\s*([0-9A-F]{16})/iu)?.[1]?.toUpperCase()
  if (!keyId) throw new Error('无法从 updater minisign 公钥提取 key ID')
  return { keyId, sha256: sha256(Buffer.from(decoded, 'utf8')) }
}

export const generateReleaseProvenance = ({
  assetsDirectory,
  changelogPath,
  outputPath,
  publicCommit,
  publicKeyConfigPath,
  sourceManifestPath,
}) => {
  const source = readJson(sourceManifestPath)
  if (source.schemaVersion !== 1 || typeof source.version !== 'string') {
    throw new Error('SOURCE_SNAPSHOT.json 契约无效')
  }
  const changelog = readFileSync(changelogPath, 'utf8')
  const outputName = basename(outputPath)
  const assets = readdirSync(assetsDirectory)
    .filter((name) => name !== outputName && name !== 'SHA256SUMS.txt')
    .sort()
    .map((name) => {
      const path = resolve(assetsDirectory, name)
      const stat = statSync(path)
      if (!stat.isFile()) throw new Error(`发布资产不是普通文件：${name}`)
      return {
        name,
        bytes: stat.size,
        sha256: sha256(readFileSync(path)),
      }
    })
  const generatedAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString()
  const payload = {
    schemaVersion: 1,
    version: source.version,
    generatedAt,
    sourceCommit: requireCommit(source.sourceCommit, '源提交'),
    publicCommit: requireCommit(publicCommit, '公开提交'),
    signingPublicKey: publicKeyMetadata(publicKeyConfigPath),
    changelog: {
      sha256: sha256(changelog),
      securityChanges: securityChanges(releaseSection(changelog, source.version)),
    },
    assets,
  }
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const assetsDirectory = resolve(ROOT, options['assets-dir'] ?? '')
  const changelogPath = resolve(ROOT, options.changelog ?? 'CHANGELOG.md')
  const outputPath = resolve(ROOT, options.out ?? '')
  const sourceManifestPath = resolve(ROOT, options['source-manifest'] ?? 'SOURCE_SNAPSHOT.json')
  const publicKeyConfigPath = resolve(
    ROOT,
    options['pubkey-config'] ?? 'apps/desktop/src-tauri/tauri.release.conf.json',
  )
  const publicCommit = options['public-commit'] ?? process.env.GITHUB_SHA ?? ''
  if (!options['assets-dir'] || !options.out) {
    throw new Error('必须提供 --assets-dir 与 --out')
  }
  for (const path of [assetsDirectory, changelogPath, sourceManifestPath, publicKeyConfigPath]) {
    if (!existsSync(path)) throw new Error(`输入不存在：${path}`)
  }
  const payload = generateReleaseProvenance({
    assetsDirectory,
    changelogPath,
    outputPath,
    publicCommit,
    publicKeyConfigPath,
    sourceManifestPath,
  })
  console.log(`Generated release provenance for v${payload.version}: ${outputPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
