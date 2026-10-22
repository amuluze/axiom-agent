#!/usr/bin/env node
// TS 导入边界审计：把 AGENTS.md 的分层约定变成机器门禁。
//
// 规则（只约束值级导入；类型导入允许作为接缝契约存在）：
//   1. agent/ 不得值级依赖 @/platform、@/stores、@/components、@/persistence；
//   2. 除 platform/ 外，任何 src 文件不得值级导入 @tauri-apps/*；
//   3. 测试、fixtures 与 testSupport 不参与（允许 vi.mock / 夹具）；
//   4. platform/ 自身允许 @tauri-apps/* 与其它层。
//
// 仅解析静态 import/export-from；动态 import() 由调用点评审覆盖（当前 agent/
// 无跨层动态导入）。规则失败必须改代码，不允许注释绕过。

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'apps/desktop/src')

const sourceFiles = (directory) => {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(target))
    else if (/\.tsx?$/u.test(entry.name)) files.push(target)
  }
  return files
}

const relative = (file) => path.relative(sourceRoot, file).split(path.sep).join('/')
const isIgnored = (file) => (
  /\.test\.(ts|tsx)$/u.test(file)
  || /(^|\/)__fixtures__(\/|$)/u.test(file)
  || /(^|\/)testSupport(\/|$)/u.test(file)
)

const isTypeOnlySpecifiers = (clause) => {
  const trimmed = clause.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  const entries = trimmed
    .slice(1, -1)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.length > 0 && entries.every((entry) => /^type\s+/u.test(entry))
}

/** 返回 [{ specifier, typeOnly, statement }]；覆盖 import 与 export ... from。 */
const collectModuleSpecifiers = (source) => {
  const results = []
  const pattern = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(pattern)) {
    const [, kind, clause, specifier] = match
    const typeOnly = /^\s*type\s+/u.test(clause) || isTypeOnlySpecifiers(clause)
    results.push({
      specifier,
      typeOnly,
      statement: `${kind} ${clause.trim().slice(0, 120)} from '${specifier}'`,
    })
  }
  // side-effect import：import '@/x'
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/gu)) {
    results.push({ specifier: match[1], typeOnly: false, statement: `import '${match[1]}'` })
  }
  return results
}

const rules = [
  {
    label: 'agent/ 不得值级依赖 @/platform',
    applies: (file) => relative(file).startsWith('agent/'),
    matches: (specifier) => specifier.startsWith('@/platform'),
  },
  {
    label: 'agent/ 不得值级依赖 @/stores',
    applies: (file) => relative(file).startsWith('agent/'),
    matches: (specifier) => specifier.startsWith('@/stores'),
  },
  {
    label: 'agent/ 不得值级依赖 @/components',
    applies: (file) => relative(file).startsWith('agent/'),
    matches: (specifier) => specifier.startsWith('@/components'),
  },
  {
    label: 'agent/ 不得值级依赖 @/persistence',
    applies: (file) => relative(file).startsWith('agent/'),
    matches: (specifier) => specifier.startsWith('@/persistence'),
  },
  {
    label: '只有 platform/ 可以值级导入 @tauri-apps/*',
    applies: (file) => !relative(file).startsWith('platform/'),
    matches: (specifier) => specifier.startsWith('@tauri-apps/'),
  },
]

const findings = []
for (const file of sourceFiles(sourceRoot)) {
  if (isIgnored(file)) continue
  const source = readFileSync(file, 'utf8')
  for (const { specifier, typeOnly, statement } of collectModuleSpecifiers(source)) {
    if (typeOnly) continue
    for (const rule of rules) {
      if (!rule.applies(file) || !rule.matches(specifier)) continue
      findings.push(`${relative(file)}: ${rule.label} → ${statement}`)
    }
  }
}

if (findings.length > 0) {
  console.error(`import-boundary: ${findings.length} 处违规`)
  for (const finding of findings) console.error(`  ✗ ${finding}`)
  console.error('修复方式：把值级依赖改为类型导入，或经既有接缝（AgentEnvironment / ProviderHost / platform re-export）访问。')
  process.exit(1)
}

console.log('import-boundary: ok（agent 值级隔离 + @tauri-apps 仅 platform）')
