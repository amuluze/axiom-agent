// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkForAppUpdateNow: vi.fn(),
  installPendingUpdate: vi.fn(),
  relaunchAfterUpdate: vi.fn(),
  openExternalUrl: vi.fn(),
}))

vi.mock('@/stores/services/updaterService', () => ({
  checkForAppUpdateNow: mocks.checkForAppUpdateNow,
  installPendingUpdate: mocks.installPendingUpdate,
  relaunchAfterUpdate: mocks.relaunchAfterUpdate,
}))

vi.mock('@/platform/webAccess', () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

import { AboutSection } from './AboutSection'
import { useUiStore, type UpdatePhase } from '@/stores/uiStore'

const setUpdaterState = (patch: {
  updatePhase?: UpdatePhase
  availableUpdate?: { version: string; notes: string | null; pubDate: string | null } | null
  updateProgress?: { downloadedBytes: number; totalBytes: number | null } | null
  updateMessage?: string | null
}) => {
  useUiStore.setState({
    updatePhase: patch.updatePhase ?? 'idle',
    availableUpdate: patch.availableUpdate ?? null,
    updateProgress: patch.updateProgress ?? null,
    updateMessage: patch.updateMessage ?? null,
  })
}

beforeEach(() => {
  setUpdaterState({})
  mocks.checkForAppUpdateNow.mockReset()
  mocks.installPendingUpdate.mockReset()
  mocks.relaunchAfterUpdate.mockReset()
  mocks.openExternalUrl.mockReset()
  mocks.openExternalUrl.mockResolvedValue(undefined)
  // 组件以 void promise().catch() 消费服务；默认给成功实现避免 unhandled。
  mocks.checkForAppUpdateNow.mockResolvedValue('disabled')
  mocks.installPendingUpdate.mockResolvedValue(undefined)
  mocks.relaunchAfterUpdate.mockResolvedValue(undefined)
})

afterEach(() => {
  setUpdaterState({})
})

describe('AboutSection 版本展示', () => {
  it('展示应用名与浏览器 dev 兜底版本号', async () => {
    render(<AboutSection />)
    // jsdom 无 __TAURI_INTERNALS__，getRuntimeInfo 走浏览器兜底。
    await waitFor(() => expect(screen.getByLabelText('当前版本').textContent).toContain('browser-dev'))
    // 闭源边界：对外链接只有官网（当前版本与底部说明各一处），不出现任何 GitHub 入口。
    const websiteLinks = screen.getAllByText(/axiom\.amuluze\.com/)
    expect(websiteLinks.length).toBeGreaterThanOrEqual(2)
    expect(document.body.textContent).not.toContain('github.com')
  })
})

describe('AboutSection 更新状态', () => {
  it('默认态显示自动检查说明与检查按钮', () => {
    render(<AboutSection />)
    expect(screen.getByRole('status', { name: '更新状态' }).textContent)
      .toContain('自动检查会在启动后进行')
    const checkButton = screen.getByRole('button', { name: /检查更新/ })
    fireEvent.click(checkButton)
    expect(mocks.checkForAppUpdateNow).toHaveBeenCalledTimes(1)
  })

  it('发现新版本时展示安装按钮并携带版本号', () => {
    setUpdaterState({
      availableUpdate: { version: '0.3.0', notes: '新增自更新', pubDate: null },
    })
    render(<AboutSection />)
    expect(screen.getByRole('status', { name: '更新状态' }).textContent)
      .toContain('发现新版本 v0.3.0')
    const install = screen.getByRole('button', { name: /下载并安装 v0.3.0/ })
    fireEvent.click(install)
    expect(mocks.installPendingUpdate).toHaveBeenCalledTimes(1)
  })

  it('ready 态展示重启按钮', () => {
    setUpdaterState({ updatePhase: 'ready' })
    render(<AboutSection />)
    const relaunch = screen.getByRole('button', { name: /重启 Axiom 完成更新/ })
    fireEvent.click(relaunch)
    expect(mocks.relaunchAfterUpdate).toHaveBeenCalledTimes(1)
  })

  it('下载中展示进度条与已下载字节', () => {
    setUpdaterState({
      updatePhase: 'downloading',
      updateProgress: { downloadedBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 },
    })
    render(<AboutSection />)
    expect(screen.getByLabelText('下载进度').getAttribute('value')).toBe('25')
    expect(screen.getByText(/5\.0 MB \/ 25%/)).toBeTruthy()
    // 下载中禁用手动检查重入。
    expect((screen.getByRole('button', { name: /检查更新/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disabled 态透出原因文案', () => {
    setUpdaterState({
      updatePhase: 'disabled',
      updateMessage: '当前构建未启用自更新（开发模式或无签名凭据），请从官网下载新版本',
    })
    render(<AboutSection />)
    expect(screen.getByRole('status', { name: '更新状态' }).textContent)
      .toContain('未启用自更新')
  })

  it('检查动作失败时展示错误信息', async () => {
    mocks.checkForAppUpdateNow.mockRejectedValue(new Error('网络不可达'))
    render(<AboutSection />)
    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('网络不可达'))
  })
})

describe('AboutSection 更新内容 changelog', () => {
  it('以 Markdown 渲染更新说明，标题/列表/加粗解析为结构化元素', () => {
    setUpdaterState({
      availableUpdate: {
        version: '0.3.0',
        notes: '### Added\n\n- **多工作区并行**：写锁分片。\n- 审批收件箱。',
        pubDate: '2026-09-01T00:00:00Z',
      },
    })
    render(<AboutSection />)
    const region = screen.getByLabelText('更新内容')
    // `###`/`**` 解析为结构化元素而不是字面符号。
    expect(screen.getByRole('heading', { name: 'Added' })).toBeTruthy()
    expect(region.querySelectorAll('li').length).toBe(2)
    expect(region.querySelector('strong')?.textContent).toBe('多工作区并行')
    expect(region.textContent).not.toContain('###')
    expect(region.textContent).not.toContain('**')
    // 发布日期独立展示，底部有官网完整更新记录入口。
    expect(region.textContent).toContain('发布于')
    expect(screen.getByRole('button', { name: /查看完整更新记录/ })).toBeTruthy()
  })

  it('notes 为 null 时展示兜底文案', () => {
    setUpdaterState({
      availableUpdate: { version: '0.3.0', notes: null, pubDate: null },
    })
    render(<AboutSection />)
    expect(screen.getByLabelText('更新内容').textContent).toContain('本次更新包含改进与修复。')
  })

  it('不渲染 notes 携带的内嵌 HTML', () => {
    setUpdaterState({
      availableUpdate: {
        version: '0.3.0',
        notes: '更新说明 <img src=x onerror="alert(1)">',
        pubDate: null,
      },
    })
    render(<AboutSection />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByLabelText('更新内容').textContent).toContain('更新说明')
  })

  it('归一化真实清单噪音：空 Security 分节与安装说明附录不出现在卡片中', () => {
    // 复刻 v0.3.0 官网 latest.json 的真实形态：CHANGELOG 空 Security 分节 +
    // release:local 追加的手动安装附录（对自更新路径有误导）。
    setUpdaterState({
      availableUpdate: {
        version: '0.3.0',
        notes: [
          '### Added',
          '',
          '- **帮助入口改为下拉菜单**：窗口右上角帮助按钮改为「圆圈 + ?」。',
          '',
          '### Fixed',
          '',
          '- **changelog 改 Markdown 渲染**：更新说明经 Markdown 渲染。',
          '',
          '### Security',
          '',
          '---',
          '',
          '## 安装说明（未签名构建）',
          '',
          '本版本为 adhoc 签名、未公证。首次打开会被 Gatekeeper 拦截，需移除 quarantine 属性：',
          '',
          '1. 校验完整性：`shasum -a 256 -c SHA256SUMS.txt --ignore-missing`',
          '2. 挂载 DMG，将 Axiom.app 拖入 /Applications',
        ].join('\n'),
        pubDate: '2026-09-03T00:00:00Z',
      },
    })
    render(<AboutSection />)
    const region = screen.getByLabelText('更新内容')
    // 三个有效分节正常解析，噪音分节/附录/分隔线不出现。
    expect(screen.getByRole('heading', { name: 'Added' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Fixed' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Security' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '安装说明（未签名构建）' })).toBeNull()
    expect(region.textContent).not.toContain('quarantine')
    expect(region.textContent).not.toContain('Gatekeeper')
    expect(region.querySelector('hr')).toBeNull()
    expect(region.querySelectorAll('li').length).toBe(2)
  })
})
