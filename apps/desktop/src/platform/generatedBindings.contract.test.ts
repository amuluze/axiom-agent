import { describe, expect, it } from 'vitest'
import { commands, type BrowserCommandRequest as GeneratedBrowserRequest } from './bindings'
import type {
  BrowserCommandRequest,
  BrowserCommandResponse,
  BrowserSpawnConfig,
} from './browserSession'
import type { BrowserCommandResponse as GeneratedBrowserResponse } from './bindings'

/**
 * 这组断言是「增量迁移到 specta」的守卫：
 * - 运行时确认高风险命令仍由 Rust 生成；
 * - 类型层确认 browser 动作判别值与手写 TS 镜像双向一致——Rust 新增动作而 TS 未同步，
 *   或 TS 保留了 Rust 已删除的动作，`npm run typecheck` 都会失败。
 */
type LocalAction = BrowserCommandRequest['action']
type GeneratedAction = GeneratedBrowserRequest['action']

const generatedToLocal: LocalAction = null as unknown as GeneratedAction
const localToGenerated: GeneratedAction = null as unknown as LocalAction
void generatedToLocal
void localToGenerated

type LocalStatus = Extract<BrowserCommandResponse, { type: 'status' }>
type GeneratedStatus = Extract<GeneratedBrowserResponse, { type: 'status' }>
const statusLocalToGenerated: GeneratedStatus = null as unknown as LocalStatus
void statusLocalToGenerated

type GeneratedEnsure = Extract<GeneratedBrowserRequest, { action: 'ensureRunning' }>['config']
const spawnConfigToGenerated: GeneratedEnsure = null as unknown as BrowserSpawnConfig
void spawnConfigToGenerated

describe('generated command bindings', () => {
  it('exports the high-risk command domains from Rust', () => {
    for (const name of [
      'listWorkspace',
      'readWorkspaceText',
      'browserCommand',
      'listTestEnvironmentRecords',
      'listTestRunRecords',
      'latestTestBatchRecord',
      'getTestRunRecord',
    ] as const) {
      expect(typeof commands[name]).toBe('function')
    }
  })
})
