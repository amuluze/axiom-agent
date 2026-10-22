import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findWorkspaceFiles: vi.fn(),
  readWorkspaceText: vi.fn(),
}))

vi.mock('@/platform/workspace', () => mocks)

import { scanEnvironmentFiles } from './testEnvironmentFiles'

const environmentFile = (id: string, mode: 'local' | 'remote' = 'remote'): string => JSON.stringify({
  kind: 'axiom.test-env',
  version: 1,
  id,
  name: `${id} 环境`,
  mode,
  vars: { API_BASE_URL: 'https://staging.test/api' },
  secretNames: ['apitest.orders-token'],
  ...(mode === 'local'
    ? { recipe: { start: ['docker compose up -d'], readiness: ['curl -fsS https://staging.test/health'] } }
    : {}),
})

const scan = () => scanEnvironmentFiles('/ws', new AbortController().signal)

describe('scanEnvironmentFiles', () => {
  beforeEach(() => {
    mocks.findWorkspaceFiles.mockReset()
    mocks.readWorkspaceText.mockReset()
  })

  it('projects valid files into importable drafts and sorts by path', async () => {
    mocks.findWorkspaceFiles.mockResolvedValue({
      matches: [
        { path: 'tests/environments/zeta.env.ax', kind: 'file' },
        { path: 'tests/environments/alpha.env.ax', kind: 'file' },
        { path: 'tests/environments/notes.ax', kind: 'file' },
      ],
    })
    mocks.readWorkspaceText.mockImplementation(async (path: string) => ({
      content: environmentFile(path.includes('alpha') ? 'alpha' : 'zeta', path.includes('alpha') ? 'local' : 'remote'),
      truncated: false,
    }))

    const entries = await scan()
    expect(entries.map((entry) => entry.path)).toEqual([
      'tests/environments/alpha.env.ax',
      'tests/environments/zeta.env.ax',
    ])
    expect(entries[0]?.mode).toBe('local')
    expect(entries[0]?.draft).toMatchObject({
      id: 'alpha',
      name: 'alpha 环境',
      kind: 'local',
      apiBaseUrl: 'https://staging.test/api',
      secretIdsJson: JSON.stringify(['apitest.orders-token']),
    })
    expect(entries[0]?.draft?.recipeJson).toContain('docker compose up -d')
    expect(entries[1]?.draft?.recipeJson).toBeNull()
  })

  it('keeps invalid files out of the importable set with parser issues', async () => {
    mocks.findWorkspaceFiles.mockResolvedValue({
      matches: [{ path: 'tests/environments/broken.env.ax', kind: 'file' }],
    })
    mocks.readWorkspaceText.mockResolvedValue({ content: '{"kind":"axiom.test-env","version":1,"id":"x"}', truncated: false })

    const entries = await scan()
    expect(entries[0]?.valid).toBe(false)
    expect(entries[0]?.draft).toBeNull()
    expect(entries[0]?.issues.map((issue) => issue.path)).toContain('$.name')
  })

  it('treats a missing directory as no environment files and a truncated read as invalid', async () => {
    mocks.findWorkspaceFiles.mockRejectedValue(new Error('No such file or directory'))
    expect(await scan()).toEqual([])

    mocks.findWorkspaceFiles.mockResolvedValue({
      matches: [{ path: 'tests/environments/huge.env.ax', kind: 'file' }],
    })
    mocks.readWorkspaceText.mockResolvedValue({ content: '', truncated: true })
    const entries = await scan()
    expect(entries[0]?.valid).toBe(false)
    expect(entries[0]?.issues).toEqual([{ path: '$', message: '文件超过环境档读取上限' }])
  })

  it('invalidates every file that declares the same environment id', async () => {
    mocks.findWorkspaceFiles.mockResolvedValue({
      matches: [
        { path: 'tests/environments/a.env.ax', kind: 'file' },
        { path: 'tests/environments/b.env.ax', kind: 'file' },
      ],
    })
    mocks.readWorkspaceText.mockResolvedValue({ content: environmentFile('shared'), truncated: false })

    const entries = await scan()
    expect(entries.map((entry) => entry.valid)).toEqual([false, false])
    expect(entries[0]?.issues[0]?.message).toContain('重复')
  })

  it('fails closed when the environment file inventory is truncated', async () => {
    mocks.findWorkspaceFiles.mockResolvedValue({ matches: [], truncated: true })
    await expect(scan()).rejects.toThrow('测试环境档清单超过 100 个，扫描结果不完整')
    expect(mocks.readWorkspaceText).not.toHaveBeenCalled()
  })
})
