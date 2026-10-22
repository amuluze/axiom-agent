import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 文档路径白名单跨语言审计。
 *
 * TS 的 `DOC_ROOTS` / `ROOT_DOC_FILES`（提示词与 DocsView 的发现面）与 Rust
 * `docs_access.rs::is_workspace_document_path`（读写命令的 fail-closed 白名单）
 * 是两份手写清单。任何一侧新增/删除目录或根文件，都必须让本审计报错——否则
 * 会出现「页面能看到但保存被 Rust 拒绝」或「Rust 允许但 UI 永不展示」的静默漂移。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_DOCS_PATH = 'apps/desktop/src/agent/prompt/projectDocs.ts'
const PROJECT_AGENTS_PATH = 'apps/desktop/src/agent/prompt/projectAgents.ts'
const DOCS_ACCESS_PATH = 'apps/desktop/src-tauri/src/docs_access.rs'

const readText = (relativePath) => readFile(path.join(root, relativePath), 'utf8')

const sorted = (values) => [...values].sort()
const assertSameSet = (actual, expected, label) => {
  assert.deepEqual(sorted(new Set(actual)), sorted(new Set(expected)), `${label} drifted`)
}

const capture = (source, pattern, label) => {
  const match = source.match(pattern)
  assert.ok(match, `${label} not found`)
  return match[1]
}

const quotedValues = (source) => [...source.matchAll(/"([^"]+)"/gu)].map((match) => match[1])

const parseTypeScript = (projectDocs, projectAgents) => {
  const rootsBlock = capture(
    projectDocs,
    /export const DOC_ROOTS[\s\S]*?=\s*\[([\s\S]*?)\n\]/u,
    'DOC_ROOTS',
  )
  const docRoots = [...rootsBlock.matchAll(
    /dir:\s*'([^']+)'\s*,\s*role:\s*'([^']+)'/gu,
  )].map((match) => ({ dir: match[1], role: match[2] }))
  assert.ok(docRoots.length > 0, 'DOC_ROOTS must not be empty')
  assert.equal(
    new Set(docRoots.map((entry) => entry.dir)).size,
    docRoots.length,
    'DOC_ROOTS contains duplicate directories',
  )

  const rootFilesBlock = capture(
    projectDocs,
    /export const ROOT_DOC_FILES[\s\S]*?=\s*\[([\s\S]*?)\n\]/u,
    'ROOT_DOC_FILES',
  )
  const rootFiles = [...rootFilesBlock.matchAll(/file:\s*'([^']+)'/gu)].map((match) => match[1])
  assert.ok(rootFiles.length > 0, 'ROOT_DOC_FILES must not be empty')
  assert.equal(new Set(rootFiles).size, rootFiles.length, 'ROOT_DOC_FILES contains duplicates')

  const agentsRoot = capture(
    projectAgents,
    /export const AGENTS_ROOT_PATH\s*=\s*'([^']+)'/u,
    'AGENTS_ROOT_PATH',
  )
  const nestedAgentsPattern = capture(
    projectAgents,
    /export const NESTED_AGENTS_PATTERN\s*=\s*'([^']+)'/u,
    'NESTED_AGENTS_PATTERN',
  )
  assert.equal(
    path.posix.basename(nestedAgentsPattern),
    agentsRoot,
    'NESTED_AGENTS_PATTERN must discover the same AGENTS.md file as AGENTS_ROOT_PATH',
  )
  return { docRoots, rootFiles, agentsRoot, nestedAgentsPattern }
}

const parseRust = (docsAccess) => {
  const rootFilesBlock = capture(
    docsAccess,
    /const ROOT_DOC_FILES:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\];/u,
    'Rust ROOT_DOC_FILES',
  )
  const rootFiles = quotedValues(rootFilesBlock)
  assert.ok(rootFiles.length > 0, 'Rust ROOT_DOC_FILES must not be empty')

  const matchStart = docsAccess.indexOf('match (first.as_str(), second.as_str())')
  assert.ok(matchStart >= 0, 'Rust whitelist match block not found')
  const matchEnd = docsAccess.indexOf('// 嵌套 AGENTS.md', matchStart)
  assert.ok(matchEnd > matchStart, 'Rust whitelist match block end not found')
  const matchBlock = docsAccess.slice(matchStart, matchEnd)
  const docRoots = [...matchBlock.matchAll(
    /\(\s*"([^"]+)"\s*,\s*(?:"([^"]+)"|_)\s*\)/gu,
  )].map((match) => (match[2] === undefined ? match[1] : `${match[1]}/${match[2]}`))
  assert.ok(docRoots.length > 0, 'Rust whitelist must contain managed directories')
  assert.equal(new Set(docRoots).size, docRoots.length, 'Rust whitelist contains duplicate directories')
  assert.match(
    matchBlock,
    /return\s+is_markdown_name\(name\)/u,
    'Rust managed directories must only accept Markdown documents',
  )
  assert.match(
    docsAccess,
    /fn is_markdown_name\([\s\S]*?ends_with\("\.md"\)/u,
    'Rust is_markdown_name must enforce the .md extension',
  )

  const nestedAgents = docsAccess.match(/name\s*==\s*"([^"]+)"/u)?.[1]
  assert.ok(nestedAgents, 'Rust nested AGENTS.md whitelist rule not found')
  return { rootFiles, docRoots, nestedAgents }
}

const audit = ({
  projectDocs,
  projectAgents,
  docsAccess,
}) => {
  const ts = parseTypeScript(projectDocs, projectAgents)
  const rust = parseRust(docsAccess)

  assertSameSet(
    rust.docRoots,
    ts.docRoots.map((entry) => entry.dir),
    'TS DOC_ROOTS and Rust managed directories',
  )
  assertSameSet(
    rust.rootFiles,
    [ts.agentsRoot, ...ts.rootFiles],
    'TS root documents (+ AGENTS.md) and Rust root document files',
  )
  assert.equal(
    rust.nestedAgents,
    ts.agentsRoot,
    'TS and Rust nested AGENTS.md filename',
  )
  return { ts, rust }
}

const selfTest = (sources) => {
  assert.throws(
    () => audit({
      ...sources,
      projectDocs: sources.projectDocs.replace("  { dir: '.docs', role: 'doc' },\n", ''),
    }),
    /managed directories drifted/u,
    'audit must reject a TS DOC_ROOTS deletion',
  )
  assert.throws(
    () => audit({
      ...sources,
      docsAccess: sources.docsAccess.replace('(".docs", _)', '(".notes", _)'),
    }),
    /managed directories drifted/u,
    'audit must reject a Rust managed-directory rename',
  )
  assert.throws(
    () => audit({
      ...sources,
      docsAccess: sources.docsAccess.replace(
        '["AGENTS.md", "DESIGN.md"]',
        '["AGENTS.md"]',
      ),
    }),
    /root document files drifted/u,
    'audit must reject a Rust root-document deletion',
  )
  console.log('docs path audit self-test passed')
}

const sources = {
  projectDocs: await readText(PROJECT_DOCS_PATH),
  projectAgents: await readText(PROJECT_AGENTS_PATH),
  docsAccess: await readText(DOCS_ACCESS_PATH),
}

const { ts, rust } = audit(sources)
console.log(
  `docs path audit passed managed-roots=${ts.docRoots.length} root-files=${ts.rootFiles.length + 1} nested-agents=${ts.agentsRoot}`,
)
assert.equal(rust.docRoots.length, ts.docRoots.length)
if (process.argv.includes('--self-test')) selfTest(sources)
