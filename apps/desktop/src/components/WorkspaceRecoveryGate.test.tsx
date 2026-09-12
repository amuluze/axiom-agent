import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceRecoveryNotice } from './WorkspaceRecoveryGate'
import { WorkspaceRecoveryGate } from './WorkspaceRecoveryGate'

describe('WorkspaceRecoveryNotice', () => {
  it('presents the blocked transaction and only offers a safe retry', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceRecoveryNotice
        busy={false}
        error={null}
        issue={{
          message: 'workspace recovery conflict: created file changed: conflict.txt',
          workspace: '/workspace/project',
          recoveryId: 'recovery-conflict',
          recoveryPath: '/app-data/workspace-changes/group/recovery-conflict',
        }}
        onRetry={() => undefined}
      />,
    )

    expect(markup).toContain('工作区恢复需要处理')
    expect(markup).toContain('/workspace/project')
    expect(markup).toContain('recovery-conflict')
    expect(markup).toContain('created file changed: conflict.txt')
    expect(markup).toContain('我已处理冲突，重试恢复')
    expect(markup).not.toMatch(/<button[^>]*>[^<]*(?:丢弃|跳过)/u)
  })
})

describe('WorkspaceRecoveryGate', () => {
  it('renders children directly outside the Tauri runtime', () => {
    const html = renderToStaticMarkup(
      <WorkspaceRecoveryGate><span>本地 Vite 预览</span></WorkspaceRecoveryGate>,
    )
    expect(html).toContain('本地 Vite 预览')
    expect(html).not.toContain('正在检查工作区恢复状态')
  })
})
