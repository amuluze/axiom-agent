import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'

const mocks = vi.hoisted(() => ({
  findWorkspaceFiles: vi.fn(),
  readWorkspaceText: vi.fn(),
}))

vi.mock('@/platform/workspace', () => mocks)

import { scanTestSpecs } from './testSpecIndex'

describe('scanTestSpecs', () => {
  beforeEach(() => {
    mocks.findWorkspaceFiles.mockReset()
    mocks.readWorkspaceText.mockReset()
  })

  it('sorts test files and projects valid protocol metadata', async () => {
    mocks.findWorkspaceFiles.mockResolvedValue({
      matches: [
        { path: 'tests/z.testspec.json', kind: 'file' },
        { path: 'tests/a.testspec.json', kind: 'file' },
        { path: 'tests/ignored.ax', kind: 'file' },
      ],
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => ({
      content: JSON.stringify({
        kind: 'axiom.test',
        version: 1,
        id: path.includes('/a.') ? 'alpha' : 'zeta',
        name: path.includes('/a.') ? 'Alpha' : 'Zeta',
        target: {},
        cases: [{
          id: 'case-one',
          name: 'Case',
          steps: [
            { id: 'screen', action: 'ui.screenshot' },
            { id: 'request', action: 'api.request', method: 'GET', url: 'https://example.test' },
          ],
        }],
      }),
      truncated: false,
    }))

    const entries = await scanTestSpecs('/repo', new AbortController().signal)

    expect(entries.map((entry) => entry.path)).toEqual(['tests/a.testspec.json', 'tests/z.testspec.json'])
    expect(entries[0]).toMatchObject({
      valid: true,
      caseCount: 1,
      stepCount: 2,
      uiStepCount: 1,
      apiStepCount: 1,
    })
  })

  it('keeps invalid files in the index with validation issues', async () => {
    mocks.findWorkspaceFiles.mockResolvedValue({ matches: [{ path: 'tests/bad.testspec.json', kind: 'file' }] })
    mocks.readWorkspaceText.mockResolvedValue({ content: '{', truncated: false })

    const entries = await scanTestSpecs('/repo', new AbortController().signal)

    expect(entries[0]).toMatchObject({ valid: false, issues: [{ path: '$', message: 'JSON 解析失败' }] })
  })

  it('treats an absent tests directory as an empty index', async () => {
    // 宿主对不存在的相对路径返回结构化空结果（find_workspace_files 短路），不是错误。
    mocks.findWorkspaceFiles.mockResolvedValue({ matches: [], truncated: false })
    await expect(scanTestSpecs('/repo', new AbortController().signal)).resolves.toEqual([])
  })

  it('propagates host failures instead of guessing from message text', async () => {
    mocks.findWorkspaceFiles.mockRejectedValue(new Error('permission denied'))
    await expect(scanTestSpecs('/repo', new AbortController().signal))
      .rejects.toThrow('permission denied')
  })

  it('keeps the legacy string-error host working while it lacks the envelope', async () => {
    // 迁移兼容：未升级宿主的 not_found 只能从文案识别（新宿主返回空结果或信封）。
    mocks.findWorkspaceFiles.mockRejectedValue(new Error('failed to resolve workspace path: No such file or directory'))
    await expect(scanTestSpecs('/repo', new AbortController().signal)).resolves.toEqual([])
  })

  it('never swallows a structured error even when its message mentions not found', async () => {
    mocks.findWorkspaceFiles.mockRejectedValue(
      new AgentEnvironmentError('not_authorized', 'workspace not found in authorized roots'),
    )
    await expect(scanTestSpecs('/repo', new AbortController().signal))
      .rejects.toBeInstanceOf(AgentEnvironmentError)
  })

  it('fails closed when the workspace file inventory is truncated', async () => {
    mocks.findWorkspaceFiles.mockResolvedValue({ matches: [], truncated: true })
    await expect(scanTestSpecs('/repo', new AbortController().signal))
      .rejects.toThrow('测试用例清单超过 200 个，扫描结果不完整')
    expect(mocks.readWorkspaceText).not.toHaveBeenCalled()
  })
})
