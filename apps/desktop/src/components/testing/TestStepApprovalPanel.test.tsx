import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TestStepApprovalList } from './TestStepApprovalPanel'

const item = {
  key: 'run-1:apply',
  actor: { kind: 'testStep' as const, testRunId: 'run-1', stepId: 'apply' },
  card: { actionLabel: '点击 role=button 名称「应用」', origin: 'https://shop.test', target: 'role=button 名称「应用」' },
}

describe('TestStepApprovalList', () => {
  it('shows an empty state when nothing awaits approval', () => {
    const markup = renderToStaticMarkup(<TestStepApprovalList items={[]} onRespond={vi.fn()} />)
    expect(markup).toContain('当前没有等待确认的测试步骤')
    expect(markup).not.toContain('允许执行')
  })

  it('renders the card fields and both decisions for each pending step', () => {
    const markup = renderToStaticMarkup(<TestStepApprovalList items={[item]} onRespond={vi.fn()} />)
    expect(markup).toContain('点击 role=button 名称「应用」')
    expect(markup).toContain('https://shop.test')
    expect(markup).toContain('允许执行')
    expect(markup).toContain('拒绝')
  })

  it('never renders typed input values, because the card only carries summaries', () => {
    const markup = renderToStaticMarkup(
      <TestStepApprovalList
        items={[{ ...item, card: { ...item.card, actionLabel: '在 textbox 输入 9 个字符' } }]}
        onRespond={vi.fn()}
      />,
    )
    expect(markup).toContain('输入 9 个字符')
    expect(markup).not.toContain('SHOPAIM10')
  })
})
