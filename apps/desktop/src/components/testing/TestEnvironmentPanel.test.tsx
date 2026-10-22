// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saveTestEnvironmentRecord: vi.fn(),
  deleteTestEnvironmentRecord: vi.fn(),
  saveApiTestSecret: vi.fn(),
  hasApiTestSecret: vi.fn(),
  deleteApiTestSecret: vi.fn(),
}))

vi.mock('@/platform/testEnvironments', () => ({
  saveTestEnvironmentRecord: mocks.saveTestEnvironmentRecord,
  deleteTestEnvironmentRecord: mocks.deleteTestEnvironmentRecord,
}))
vi.mock('@/platform/apiTestSecrets', () => ({
  saveApiTestSecret: mocks.saveApiTestSecret,
  hasApiTestSecret: mocks.hasApiTestSecret,
  deleteApiTestSecret: mocks.deleteApiTestSecret,
}))

import { TestEnvironmentPanel } from './TestEnvironmentPanel'

describe('TestEnvironmentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.saveTestEnvironmentRecord.mockResolvedValue(true)
    mocks.deleteTestEnvironmentRecord.mockResolvedValue(true)
    mocks.saveApiTestSecret.mockResolvedValue(undefined)
    mocks.hasApiTestSecret.mockResolvedValue(true)
    mocks.deleteApiTestSecret.mockResolvedValue(undefined)
  })

  it('creates a persisted environment with URLs and viewport', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined)
    render(
      <TestEnvironmentPanel
        environments={[]}
        environmentFiles={[]}
        selectedId={null}
        disabled={false}
        onSelect={vi.fn()}
        onChanged={onChanged}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '新建环境' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '本地开发' } })
    fireEvent.change(screen.getByLabelText('Web Base URL'), { target: { value: 'http://localhost:5173' } })
    fireEvent.click(screen.getByRole('button', { name: '保存环境' }))

    await waitFor(() => expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalled())
    expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledWith(expect.objectContaining({
      name: '本地开发',
      webBaseUrl: 'http://localhost:5173',
      viewportWidth: 1280,
      viewportHeight: 800,
      headersJson: '{}',
      secretIdsJson: '[]',
      allowPrivateNetwork: false,
    }))
    expect(onChanged).toHaveBeenCalledWith(expect.stringMatching(/^test-env-/))
  })

  it('stores an API test secret without reading the plaintext back', async () => {
    render(
      <TestEnvironmentPanel
        environments={[]}
        environmentFiles={[]}
        selectedId={null}
        disabled={false}
        onSelect={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '新建环境' }))
    fireEvent.change(screen.getByLabelText('Secret ID'), { target: { value: 'apitest.orders-token' } })
    fireEvent.change(screen.getByLabelText('Secret 值'), { target: { value: 'top-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Secret' }))

    await waitFor(() => expect(mocks.saveApiTestSecret).toHaveBeenCalledWith('apitest.orders-token', 'top-secret'))
    expect(screen.getByLabelText('Secret 值')).toHaveValue('')
    expect(screen.getByLabelText('允许的 Secret ID JSON')).toHaveValue('["apitest.orders-token"]')
    expect(screen.getByRole('status')).toHaveTextContent('Secret 已保存并加入当前环境')
  })

  it('imports a valid environment file as a persisted environment', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined)
    const draft = {
      id: 'local-shop',
      name: '本地开发环境',
      kind: 'local' as const,
      recipeJson: '{"start":["docker compose up -d"],"stop":[],"readiness":["curl -fsS http://127.0.0.1:5173/health"],"timeoutMs":120000}',
      webBaseUrl: 'http://127.0.0.1:5173',
      apiBaseUrl: 'http://127.0.0.1:9/api',
      viewportWidth: 1280,
      viewportHeight: 800,
      allowPrivateNetwork: true,
      headersJson: '{}',
      secretIdsJson: '["apitest.orders-token"]',
    }
    render(
      <TestEnvironmentPanel
        environments={[]}
        environmentFiles={[{
          path: 'tests/environments/local.env.ax',
          valid: true,
          fileId: 'local-shop',
          name: '本地开发环境',
          mode: 'local',
          issues: [],
          draft,
        }]}
        selectedId={null}
        disabled={false}
        onSelect={vi.fn()}
        onChanged={onChanged}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '导入为运行环境' }))

    await waitFor(() => expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledTimes(1))
    expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledWith({
      ...draft,
      updatedAt: expect.any(Number),
    })
    expect(onChanged).toHaveBeenCalledWith('local-shop')
  })

  it('keeps the imported mode and recipe when editing an environment from the form', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined)
    render(
      <TestEnvironmentPanel
        environments={[{
          id: 'local-shop',
          name: '本地开发环境',
          kind: 'local',
          recipeJson: '{"start":["docker compose up -d"],"stop":[],"readiness":["curl -fsS http://127.0.0.1:5173/health"],"timeoutMs":120000}',
          webBaseUrl: 'http://127.0.0.1:5173',
          apiBaseUrl: 'http://127.0.0.1:9/api',
          viewportWidth: null,
          viewportHeight: null,
          allowPrivateNetwork: true,
          headersJson: '{}',
          secretIdsJson: '[]',
          createdAt: 1,
          updatedAt: 2,
        }]}
        environmentFiles={[]}
        selectedId="local-shop"
        disabled={false}
        onSelect={vi.fn()}
        onChanged={onChanged}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '本地开发环境（改）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存环境' }))

    await waitFor(() => expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledTimes(1))
    // 表单里没有档位/配方字段：省略它们会让导入的 local 档被静默降级成 remote 并抹掉配方。
    expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledWith(expect.objectContaining({
      id: 'local-shop',
      name: '本地开发环境（改）',
      kind: 'local',
      recipeJson: expect.stringContaining('docker compose up -d'),
    }))
  })

  it('keeps needs-repair files out of the import path and shows the selected mode', () => {
    render(
      <TestEnvironmentPanel
        environments={[{
          id: 'env-1',
          name: '远程环境',
          kind: 'remote',
          recipeJson: null,
          webBaseUrl: null,
          apiBaseUrl: 'https://staging.test/api',
          viewportWidth: null,
          viewportHeight: null,
          allowPrivateNetwork: false,
          headersJson: '{}',
          secretIdsJson: '[]',
          createdAt: 1,
          updatedAt: 2,
        }]}
        environmentFiles={[{
          path: 'tests/environments/broken.env.ax',
          valid: false,
          fileId: null,
          name: null,
          mode: null,
          issues: [{ path: '$.mode', message: '只允许 local 或 remote' }],
          draft: null,
        }]}
        selectedId="env-1"
        disabled={false}
        onSelect={vi.fn()}
        onChanged={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: '导入为运行环境' })).toBeNull()
    expect(screen.getByText(/需要修复：\$\.mode 只允许 local 或 remote/)).toBeTruthy()
    expect(screen.getByText(/档位：远程（只读校验）/)).toBeTruthy()
  })
})
