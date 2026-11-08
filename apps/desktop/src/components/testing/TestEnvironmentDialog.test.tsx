// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saveTestEnvironmentRecord: vi.fn(),
  deleteTestEnvironmentRecord: vi.fn(),
  saveApiTestSecret: vi.fn(),
  hasApiTestSecret: vi.fn(),
  deleteApiTestSecret: vi.fn(),
  probeEnvironmentReadiness: vi.fn(),
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
vi.mock('@/platform/testEnvironmentProbe', () => ({
  probeEnvironmentReadiness: mocks.probeEnvironmentReadiness,
}))

import { TestEnvironmentDialog } from './TestEnvironmentDialog'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'

const RECORD: TestEnvironmentRecord = {
  id: 'env-1',
  name: '远程环境',
  kind: 'remote',
  recipeJson: null,
  webBaseUrl: 'https://staging.test',
  apiBaseUrl: null,
  viewportWidth: null,
  viewportHeight: null,
  allowPrivateNetwork: false,
  headersJson: '{}',
  secretIdsJson: '[]',
  extraVarsJson: '{}',
  secretOriginsJson: '[]',
  tlsTrust: 'system',
  approvalMode: 'per_step',
  createdAt: 1,
  updatedAt: 2,
}

const LOCAL_RECORD: TestEnvironmentRecord = {
  ...RECORD,
  id: 'beacon-local',
  name: 'Beacon 本地容器',
  kind: 'local',
  recipeJson: JSON.stringify({
    start: ['docker compose -f compose.dev.yaml up -d'],
    stop: ['docker compose -f compose.dev.yaml down'],
    readiness: ['curl -fsS http://127.0.0.1:18080/ready'],
    timeoutMs: 120_000,
  }),
  webBaseUrl: 'http://127.0.0.1:18080',
  apiBaseUrl: 'http://127.0.0.1:18080',
  allowPrivateNetwork: true,
}

const renderDialog = (overrides: Partial<Parameters<typeof TestEnvironmentDialog>[0]> = {}) => {
  const onChanged = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(
    <TestEnvironmentDialog
      open
      environments={[]}
      environmentFiles={[]}
      selectedId={null}
      disabled={false}
      onSelect={vi.fn()}
      onChanged={onChanged}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onChanged, onClose }
}

describe('TestEnvironmentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.saveTestEnvironmentRecord.mockResolvedValue(true)
    mocks.deleteTestEnvironmentRecord.mockResolvedValue(true)
    mocks.saveApiTestSecret.mockResolvedValue(undefined)
    mocks.hasApiTestSecret.mockResolvedValue(true)
    mocks.deleteApiTestSecret.mockResolvedValue(undefined)
    mocks.probeEnvironmentReadiness.mockResolvedValue({
      readiness: { ready: true, verdict: 'ready', reason: '环境就绪：GET http://localhost:8080/ 返回 200（3 ms）', status: 200, elapsedMs: 3 },
      probe: { method: 'GET', url: 'http://localhost:8080/' },
      probes: [],
    })
  })

  /** 受控宿主：保存后把记录写回 props，模拟真实页面的 onChanged → 选中新环境。 */
  const renderControlledDialog = () => {
    const onChanged = vi.fn()
    const Controlled = () => {
      const [environments, setEnvironments] = useState<TestEnvironmentRecord[]>([])
      const [selectedId, setSelectedId] = useState<string | null>(null)
      return (
        <TestEnvironmentDialog
          open
          environments={environments}
          environmentFiles={[]}
          selectedId={selectedId}
          disabled={false}
          onSelect={setSelectedId}
          onChanged={async (preferredId?: string) => {
            onChanged(preferredId)
            const payload = mocks.saveTestEnvironmentRecord.mock.calls.at(-1)?.[0] as
              | (TestEnvironmentRecord & { recipeJson?: string | null })
              | undefined
            if (!payload) return
            const record: TestEnvironmentRecord = {
              id: payload.id,
              name: payload.name,
              kind: payload.kind ?? 'remote',
              recipeJson: payload.recipeJson ?? null,
              webBaseUrl: payload.webBaseUrl ?? null,
              apiBaseUrl: payload.apiBaseUrl ?? null,
              viewportWidth: payload.viewportWidth ?? null,
              viewportHeight: payload.viewportHeight ?? null,
              allowPrivateNetwork: payload.allowPrivateNetwork,
              headersJson: payload.headersJson,
              secretIdsJson: payload.secretIdsJson,
              extraVarsJson: payload.extraVarsJson ?? '{}',
              secretOriginsJson: payload.secretOriginsJson ?? '[]',
              tlsTrust: payload.tlsTrust ?? 'system',
              approvalMode: payload.approvalMode ?? 'per_step',
              createdAt: 1,
              updatedAt: 2,
            }
            setEnvironments([record])
            setSelectedId(preferredId ?? record.id)
          }}
          onClose={vi.fn()}
        />
      )
    }
    render(<Controlled />)
    return { onChanged }
  }

  it('creates a local environment from the recommended preset and verifies the connection', async () => {
    const { onChanged } = renderControlledDialog()

    fireEvent.click(screen.getByRole('button', { name: '新建环境' }))
    fireEvent.click(screen.getByRole('button', { name: /本地（推荐）/ }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '本地开发' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并验证连接' }))

    await waitFor(() => expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalled())
    expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledWith(expect.objectContaining({
      name: '本地开发',
      kind: 'remote',
      webBaseUrl: 'http://localhost:5173',
      apiBaseUrl: 'http://localhost:8080',
      viewportWidth: 1280,
      viewportHeight: 800,
      // 私网访问按地址派生，用户不必手勾。
      allowPrivateNetwork: true,
      headersJson: '{}',
      secretIdsJson: '[]',
      extraVarsJson: '{}',
      secretOriginsJson: '[]',
      tlsTrust: 'system',
      approvalMode: 'per_step',
    }))
    expect(onChanged).toHaveBeenCalledWith(expect.stringMatching(/^test-env-/))
    // 保存后立刻探针：结论原样展示，而不是等到跑一次才知道环境不通。
    await waitFor(() => expect(mocks.probeEnvironmentReadiness).toHaveBeenCalled())
    expect(await screen.findByText(/连接正常：环境就绪/)).toBeInTheDocument()
  })

  it('surfaces a failed verification without undoing the saved environment', async () => {
    mocks.probeEnvironmentReadiness.mockResolvedValue({
      readiness: {
        ready: false,
        verdict: 'unreachable',
        reason: '连接失败：环境没起来或地址不对',
        status: null,
        elapsedMs: 0,
      },
      probe: { method: 'GET', url: 'http://localhost:8080/' },
      probes: [],
    })
    renderControlledDialog()

    fireEvent.click(screen.getByRole('button', { name: '新建环境' }))
    fireEvent.click(screen.getByRole('button', { name: /本地（推荐）/ }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '本地开发' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并验证连接' }))

    expect(await screen.findByText(/连接未通过：连接失败/)).toBeInTheDocument()
    expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledTimes(1)
  })

  it('stores an API test secret without reading the plaintext back', async () => {
    renderDialog()

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
    const { onChanged } = renderDialog({
      environmentFiles: [{
        path: 'tests/environments/local.env.axiom',
        valid: true,
        fileId: 'local-shop',
        name: '本地开发环境',
        mode: 'local',
        issues: [],
        draft,
      }],
    })

    fireEvent.click(screen.getByRole('button', { name: '导入为运行环境' }))

    await waitFor(() => expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledTimes(1))
    expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledWith({
      ...draft,
      updatedAt: expect.any(Number),
    })
    expect(onChanged).toHaveBeenCalledWith('local-shop')
  })

  it('keeps the imported mode and recipe when editing an environment from the form', async () => {
    renderDialog({
      environments: [LOCAL_RECORD],
      selectedId: LOCAL_RECORD.id,
    })

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '本地开发环境（改）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并验证连接' }))

    await waitFor(() => expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledTimes(1))
    // 表单里没有档位/配方字段：省略它们会让导入的 local 档被静默降级成 remote 并抹掉配方。
    expect(mocks.saveTestEnvironmentRecord).toHaveBeenCalledWith(expect.objectContaining({
      id: 'beacon-local',
      name: '本地开发环境（改）',
      kind: 'local',
      recipeJson: expect.stringContaining('docker compose -f compose.dev.yaml up -d'),
    }))
  })

  it('deletes the selected environment and closes the dialog', async () => {
    const { onChanged, onClose } = renderDialog({ environments: [RECORD], selectedId: RECORD.id })

    fireEvent.click(screen.getByRole('button', { name: '删除环境' }))

    await waitFor(() => expect(mocks.deleteTestEnvironmentRecord).toHaveBeenCalledWith('env-1'))
    expect(onChanged).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the dialog open and explains when nothing was deleted', async () => {
    mocks.deleteTestEnvironmentRecord.mockResolvedValue(false)
    const { onClose } = renderDialog({ environments: [RECORD], selectedId: RECORD.id })

    fireEvent.click(screen.getByRole('button', { name: '删除环境' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('环境已不存在')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps editing and deleting available while a probe is still pending', async () => {
    // 保存后的探针可能停在审批/租约上；它不能把整个弹窗的按钮锁死（否则表现为「只能新建，不能删除」）。
    mocks.probeEnvironmentReadiness.mockReturnValue(new Promise(() => {}))
    renderControlledDialog()

    fireEvent.click(screen.getByRole('button', { name: '新建环境' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '本地开发' } })
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://localhost:5173' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并验证连接' }))

    const remove = await screen.findByRole('button', { name: '删除环境' })
    await waitFor(() => expect(remove).toBeEnabled())
    expect(screen.getByRole('button', { name: '编辑' })).toBeEnabled()
  })

  it('shows the start/stop recipe commands so a local dev container can be started by hand', () => {
    renderDialog({ environments: [LOCAL_RECORD], selectedId: LOCAL_RECORD.id })

    // 配方命令必须看得见：本地 dev container 场景里「怎么把环境起起来」的唯一
    // 事实来源就是这份配方，看不见它用户就只能去翻档文件。
    const recipe = document.querySelector('.testing-env-dialog__recipe')
    expect(recipe?.textContent).toContain('docker compose -f compose.dev.yaml up -d')
    expect(recipe?.textContent).toContain('docker compose -f compose.dev.yaml down')
    expect(recipe?.textContent).toContain('curl -fsS http://127.0.0.1:18080/ready')
    expect(screen.getByRole('button', { name: '复制命令' })).toBeTruthy()
  })

  it('refuses to skip certificate verification for a public address', async () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '新建环境' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'staging' } })
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://staging.example.com' } })
    fireEvent.change(screen.getByLabelText('证书校验'), { target: { value: 'insecure' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并验证连接' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('跳过证书校验只允许用于回环或私网地址'))
    expect(mocks.saveTestEnvironmentRecord).not.toHaveBeenCalled()
  })

  it('keeps needs-repair files out of the import path and shows the selected mode', () => {
    renderDialog({
      environments: [RECORD],
      selectedId: RECORD.id,
      environmentFiles: [{
        path: 'tests/environments/broken.env.axiom',
        valid: false,
        fileId: null,
        name: null,
        mode: null,
        issues: [{ path: '$.mode', message: '只允许 local 或 remote' }],
        draft: null,
      }],
    })

    expect(screen.queryByRole('button', { name: '导入为运行环境' })).toBeNull()
    expect(screen.getByText(/需要修复：\$\.mode 只允许 local 或 remote/)).toBeTruthy()
    expect(screen.getByText(/档位：远程（只读校验）/)).toBeTruthy()
  })

  it('keeps the create form open after the parent clears the selection', () => {
    // 受控父组件里「新建环境」会把 selectedId 置空；清空引起的 effect 若无条件
    // 退出编辑，创建表单会立刻消失（选中过环境时必现，非受控 mock 不会暴露）。
    const Controlled = () => {
      const [selectedId, setSelectedId] = useState<string | null>(RECORD.id)
      return (
        <TestEnvironmentDialog
          open
          environments={[RECORD]}
          environmentFiles={[]}
          selectedId={selectedId}
          disabled={false}
          onSelect={setSelectedId}
          onChanged={vi.fn().mockResolvedValue(undefined)}
          onClose={vi.fn()}
        />
      )
    }
    render(<Controlled />)

    fireEvent.click(screen.getByRole('button', { name: '新建环境' }))

    expect(screen.getByLabelText('名称')).toBeEnabled()
    expect(screen.getByLabelText('名称')).toHaveValue('')
    // 名称为空时不能保存，但表单本身必须仍在编辑态（保存按钮存在即说明表单没被收起）。
    expect(screen.getByRole('button', { name: '保存并验证连接' })).toBeDisabled()
  })
})
