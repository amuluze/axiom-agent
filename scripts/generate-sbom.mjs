import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputArgument = process.argv.find((argument) => argument.startsWith('--output-dir='))
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== outputArgument)

if (unknownArguments.length > 0) {
  throw new Error(`unknown arguments: ${unknownArguments.join(', ')}`)
}

const outputDirectory = path.resolve(root, outputArgument?.slice('--output-dir='.length) || 'artifacts/sbom')
const relativeOutput = path.relative(root, outputDirectory)
if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
  throw new Error('SBOM output directory must stay inside the repository')
}

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const cycloneDxPath = path.join(outputDirectory, `axiom-${packageJson.version}.cdx.json`)
const spdxPath = path.join(outputDirectory, `axiom-${packageJson.version}.spdx.json`)

mkdirSync(outputDirectory, { recursive: true })

const result = spawnSync('syft', [
  'scan', `dir:${root}`,
  '--quiet',
  '--base-path', root,
  '--source-name', 'Axiom',
  '--source-version', packageJson.version,
  '--exclude', './.git/**',
  '--exclude', './node_modules/**',
  '--exclude', './apps/desktop/node_modules/**',
  '--exclude', './apps/desktop/dist/**',
  '--exclude', './apps/desktop/src-tauri/target/**',
  '--exclude', './artifacts/**',
  '--output', `cyclonedx-json=${cycloneDxPath}`,
  '--output', `spdx-json=${spdxPath}`,
], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

if (result.error) {
  throw new Error(`unable to run syft: ${result.error.message}; install it with: brew install syft`)
}
if (result.status !== 0) {
  throw new Error(`syft failed: ${(result.stderr || result.stdout).trim()}`)
}

const normalizePaths = (value) => {
  if (typeof value === 'string') return value.split(root).join('')
  if (Array.isArray(value)) return value.map(normalizePaths)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePaths(item)]))
  }
  return value
}

const cycloneDx = normalizePaths(JSON.parse(readFileSync(cycloneDxPath, 'utf8')))
const spdx = normalizePaths(JSON.parse(readFileSync(spdxPath, 'utf8')))

if (cycloneDx.bomFormat !== 'CycloneDX' || !Array.isArray(cycloneDx.components) || cycloneDx.components.length === 0) {
  throw new Error('generated CycloneDX SBOM is invalid or empty')
}
if (!String(spdx.spdxVersion).startsWith('SPDX-') || !Array.isArray(spdx.packages) || spdx.packages.length === 0) {
  throw new Error('generated SPDX SBOM is invalid or empty')
}
const serializedCycloneDx = `${JSON.stringify(cycloneDx)}\n`
const serializedSpdx = `${JSON.stringify(spdx)}\n`
if (serializedCycloneDx.includes(os.homedir()) || serializedSpdx.includes(os.homedir())) {
  throw new Error('generated SBOM contains an absolute user path')
}

writeFileSync(cycloneDxPath, serializedCycloneDx)
writeFileSync(spdxPath, serializedSpdx)

const checksums = [cycloneDxPath, spdxPath]
  .map((file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${path.basename(file)}`)
  .join('\n')
writeFileSync(path.join(outputDirectory, 'SHA256SUMS'), `${checksums}\n`, { mode: 0o600 })

console.log([
  'SBOM generation passed',
  `cyclonedx-components=${cycloneDx.components.length}`,
  `spdx-packages=${spdx.packages.length}`,
  `output=${relativeOutput}`,
].join(' '))
