import { useState } from 'react'
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  CirclePause,
  FileCode,
  LoaderCircle,
  OctagonX,
} from 'lucide-react'
import type { TestRunStatus } from '@/platform/testRuns'
import type { SpecCaseRow } from '@/stores/services/testSpecDetail'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'

/**
 * 测试页的展示型行/状态组件（F2 切片）。
 *
 * 只消费 props 与 i18n/store 的只读/动作原语；运行、扫描与选择状态仍由
 * TestingView 持有。空态保留「用例文件是唯一事实来源」的起草入口。
 */

export const statusKey = (status: TestRunStatus): string => `testing.status.${status}`

/** 状态 → 表格/步骤行的图标（设计稿：circle-check / octagon-x / circle-alert / ban / circle-pause / loader-circle）。 */
export const StatusIcon = ({ status, size = 14 }: { status: TestRunStatus; size?: number }) => {
  switch (status) {
    case 'passed':
      return <CheckCircle2 size={size} className="testing-view__icon--pass" aria-hidden />
    case 'failed':
      return <OctagonX size={size} className="testing-view__icon--fail" aria-hidden />
    case 'error':
    case 'interrupted':
      return <CircleAlert size={size} className="testing-view__icon--fail" aria-hidden />
    case 'rejected':
      return <Ban size={size} className="testing-view__icon--warn" aria-hidden />
    case 'skipped':
    case 'waiting_approval':
    case 'queued':
      return <CirclePause size={size} className="testing-view__icon--warn" aria-hidden />
    case 'running':
    case 'canceled':
    default:
      return <LoaderCircle size={size} className="testing-view__icon--running" aria-hidden />
  }
}

/** 状态胶囊（设计稿 Shared42/Shared84：soft 底 + pill + 实色文字）。 */
export const StatusPill = ({ status }: { status: TestRunStatus }) => {
  const { t } = useT()
  const tone = status === 'passed'
    ? 'pass'
    : status === 'failed' || status === 'error' || status === 'interrupted'
      ? 'fail'
      : status === 'running'
        ? 'running'
        : 'warn'
  return <span className={`testing-view__pill testing-view__pill--${tone}`}>{t(statusKey(status))}</span>
}

/** 用例表行（tsCases mn4NM 行）：状态图标 + 名称/断言副行 + 状态胶囊 + 展开箭头。 */
export const SpecCaseTableRow = ({ row, status }: { row: SpecCaseRow; status: TestRunStatus | null }) => {
  const { t } = useT()
  return (
    <li className="testing-view__row">
      <span className="testing-view__row-icon">
        {status
          ? <StatusIcon status={status} />
          : <FileCode size={14} className="testing-view__icon--idle" aria-hidden />}
      </span>
      <span className="testing-view__row-main">
        <strong>{row.name}</strong>
        <span>
          {row.assertSummary
            ? t('testing.cases.assertPrefix', { text: row.assertSummary })
            : t('testing.cases.stepCount', { count: row.stepCount })}
        </span>
      </span>
      {status
        ? <StatusPill status={status} />
        : <span className="testing-view__pill testing-view__pill--idle">{t('testing.cases.notRun')}</span>}
      <span className="testing-view__row-duration">
        {t(`testing.cases.caseType.${row.type}`)}
      </span>
    </li>
  )
}

/** 空态（tsEmpt）：居中卡片——用例文件是唯一事实来源，起草走左侧会话；可预填骨架指令。 */
export const TestingEmptyState = ({
  hasWorkspace,
  scanning,
  error,
  onRescan,
}: {
  hasWorkspace: boolean
  scanning: boolean
  error?: string | null
  onRescan: () => void
}) => {
  const { t } = useT()
  const addWorkspace = useAgentStore((state) => state.addWorkspace)
  const [name, setName] = useState('checkout')
  const [creating, setCreating] = useState(false)

  const addSpecFile = async (): Promise<void> => {
    const file = name.trim().replace(/\.test\.ax$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'checkout'
    setCreating(true)
    try {
      const created = await useAgentStore.getState().createNewSession()
      if (!created) return
      useUiStore.getState().requestComposerInsertion(t('testing.empty.skeletonPrompt', { file }))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="testing-view testing-view--empty">
      <div className="testing-view__empty-card">
        <h1>{t('testing.index.title')}</h1>
        {error && <div role="alert" className="testing-view__error">{error}</div>}
        {hasWorkspace ? (
          <>
            <p>{t('testing.empty.description')}</p>
            <form
              className="testing-view__empty-add"
              onSubmit={(event) => {
                event.preventDefault()
                void addSpecFile()
              }}
            >
              <label>
                <span>{t('testing.empty.nameLabel')}</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="checkout"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button type="submit" className="testing-view__chip" disabled={creating}>
                {creating ? t('testing.empty.creating') : t('testing.empty.add')}
              </button>
            </form>
            <pre className="testing-view__empty-snippet">{t('testing.empty.snippet')}</pre>
          </>
        ) : (
          <p>{t('testing.index.noWorkspace')}</p>
        )}
        <div className="testing-view__empty-actions">
          {hasWorkspace ? (
            <button type="button" className="testing-view__chip" disabled={scanning} onClick={onRescan}>
              {t('testing.index.rescan')}
            </button>
          ) : (
            <button type="button" className="testing-view__chip testing-view__chip--primary" onClick={() => { void addWorkspace() }}>
              {t('testing.empty.addWorkspace')}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
