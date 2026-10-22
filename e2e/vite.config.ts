import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * e2e 专用 dev server：加载真实前端源码（apps/desktop），只有一处替换——会话仓库。
 *
 * 原生会话仓库是 Rust 侧 SQLite（`session_repository.rs`），其契约由 cargo test
 * 与 `scripts/native-app-e2e.mjs` 覆盖。本套件验证 WebView 侧运行时与 UI 旅程
 * （模型流、工具调用、审批、工作区读写），运行在 Node 假宿主之上，因此把仓库
 * 替换为应用自带的 `MemorySessionRepository`。
 *
 * 替换经 virtual module 完成：不向 apps/desktop 落测试专用文件，产品代码也无需
 * 开测试分支——接缝只存在于 e2e 的 dev server 配置里。
 */
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const desktopRoot = resolve(repoRoot, 'apps/desktop')

const REPOSITORY_SEAM_ID = 'virtual:axiom-e2e-session-repository'
const REPOSITORY_SEAM_RESOLVED = `\0${REPOSITORY_SEAM_ID}`

const repositorySeam = (): Plugin => ({
  name: 'axiom-e2e-repository-seam',
  resolveId: (id) => (id === REPOSITORY_SEAM_ID ? REPOSITORY_SEAM_RESOLVED : null),
  load: (id) => {
    if (id !== REPOSITORY_SEAM_RESOLVED) return null
    return [
      "import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'",
      '',
      '/** 会话仓库接缝：返回内存仓库，避免依赖 Rust 侧 SQLite 命令。 */',
      'export const createSessionRepository = async () => new MemorySessionRepository()',
      '',
    ].join('\n')
  },
})

export default defineConfig({
  root: desktopRoot,
  base: './',
  plugins: [react(), repositorySeam()],
  resolve: {
    alias: [
      // 顺序敏感：仓库接缝必须排在 `@` 之前。
      { find: '@/persistence/createSessionRepository', replacement: REPOSITORY_SEAM_ID },
      { find: '@', replacement: resolve(desktopRoot, 'src') },
    ],
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1430,
    strictPort: true,
    fs: { allow: [repoRoot] },
    watch: { ignored: ['**/src-tauri/**', '**/e2e/**', '**/coverage/**', '**/.vite/**'] },
  },
})
