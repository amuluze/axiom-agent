import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const command = process.argv[2]
const commandArguments = process.argv.slice(3)

if (!command) throw new Error('a command is required')

const toolchainConfig = readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8')
const toolchain = toolchainConfig.match(/^channel\s*=\s*"([^"]+)"/mu)?.[1]
if (!toolchain) throw new Error('rust-toolchain.toml must define a channel')

const cargoResult = spawnSync('rustup', ['which', '--toolchain', toolchain, 'cargo'], {
  cwd: root,
  encoding: 'utf8',
})
if (cargoResult.status !== 0) {
  throw new Error(
    `Rust ${toolchain} is unavailable; install the toolchain declared in rust-toolchain.toml`,
  )
}

const toolchainBin = path.dirname(cargoResult.stdout.trim())
// Windows 上 npm/pnpm 等是 .cmd shim：CreateProcess 不认，且 Node 安全策略
// （CVE-2024-27980）要求 .cmd/.bat 必须经 shell 启动；rustup/cargo 是真 .exe。
const isWindowsNpmShim =
  process.platform === 'win32' && ['npm', 'npx', 'pnpm', 'yarn'].includes(command)
const resolvedCommand = isWindowsNpmShim ? `${command}.cmd` : command
const result = spawnSync(resolvedCommand, commandArguments, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: `${toolchainBin}${path.delimiter}${process.env.PATH ?? ''}`,
    RUSTUP_TOOLCHAIN: toolchain,
  },
  stdio: 'inherit',
  shell: isWindowsNpmShim,
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
