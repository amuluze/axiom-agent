import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      // istanbul：真实源级分支插桩（v8 的分支数据是 esbuild 合成近似，可信度低）。
      provider: 'istanbul',
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/__fixtures__/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/agent/tools/__fixtures__/**',
      ],
      // 覆盖率门禁：行覆盖 80%（达标），其余维度按当前基线防退化（istanbul 真实源级数据）。
      thresholds: {
        lines: 80,
        statements: 77,
        functions: 78,
        branches: 69,
        // components 交互 UI 覆盖弱于核心逻辑，目录级阈值防止被全局聚合稀释（istanbul 基线
        // 65.3%/51.7%，按防退化设下限）。
        'src/components/**': {
          lines: 60,
          statements: 63,
          functions: 62,
          branches: 50,
        },
      },
    },
  },
})
