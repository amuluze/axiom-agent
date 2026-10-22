import { useEffect, useState } from 'react'
import { useT } from '@/i18n'
import type { PendingTestStepApproval, TestStepApprover } from '@/agent/testing/approval/testStepApprover'

interface TestStepApprovalListProps {
  items: readonly PendingTestStepApproval[]
  onRespond: (key: string, approved: boolean) => void
}

/** 纯展示：待确认的测试写步骤。卡片只含动作、目标与站点，不含页面内容或输入原文。 */
export const TestStepApprovalList = ({ items, onRespond }: TestStepApprovalListProps) => {
  const { t } = useT()
  if (items.length === 0) {
    return <p className="testing-approval-empty">{t('testing.approval.empty')}</p>
  }
  return (
    <section aria-labelledby="testing-approval-title" className="testing-approval-list">
      <h2 id="testing-approval-title">{t('testing.approval.title')}</h2>
      <p className="testing-approval-hint">{t('testing.approval.hint')}</p>
      <ul>
        {items.map((item) => (
          <li key={item.key} className="testing-approval-item">
            <dl>
              <div>
                <dt>{t('testing.approval.action')}</dt>
                <dd>{item.card.actionLabel}</dd>
              </div>
              <div>
                <dt>{t('testing.approval.target')}</dt>
                <dd>{item.card.target}</dd>
              </div>
              <div>
                <dt>{t('testing.approval.origin')}</dt>
                <dd><code>{item.card.origin}</code></dd>
              </div>
            </dl>
            <div className="testing-approval-actions">
              <button type="button" onClick={() => onRespond(item.key, false)}>
                {t('testing.approval.deny')}
              </button>
              <button type="button" onClick={() => onRespond(item.key, true)}>
                {t('testing.approval.approve')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 订阅审批队列的容器：队列变化时刷新列表，决定通过 approver.respond 回到运行器。 */
export const TestStepApprovalPanel = ({ approver }: { approver: TestStepApprover }) => {
  const [items, setItems] = useState<PendingTestStepApproval[]>(() => approver.list())
  useEffect(() => approver.subscribe(() => setItems(approver.list())), [approver])
  return <TestStepApprovalList items={items} onRespond={(key, approved) => approver.respond(key, approved)} />
}
