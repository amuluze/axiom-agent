import type { TestAuthoringCheck } from '@/stores/services/testAuthoringCheck'
import { useT } from '@/i18n'

/**
 * 测试页 authoring 区（F2 之后的展示切片）：
 * - 为本功能写用例：瞬时意图进用户消息；
 * - 会话产物核对：机械核对本会话写入的用例文件是否落盘且能解析。
 *
 * 发送/核对副作用仍由 TestingView 的 handlers 承担。
 */

export interface AuthoringPanelProps {
  feature: string
  onFeatureChange: (value: string) => void
  sending: boolean
  sent: boolean
  canRequest: boolean
  onRequest: () => void
  checking: boolean
  canCheck: boolean
  check: TestAuthoringCheck | null
  onCheck: () => void
}

export const AuthoringPanel = ({
  feature,
  onFeatureChange,
  sending,
  sent,
  canRequest,
  onRequest,
  checking,
  canCheck,
  check,
  onCheck,
}: AuthoringPanelProps) => {
  const { t } = useT()
  return (
    <>
      <section className="testing-view__authoring" aria-labelledby="testing-authoring-request-title">
        <div className="testing-view__panel-title">
          <div>
            <h2 id="testing-authoring-request-title">{t('testing.authoring.requestTitle')}</h2>
            <code>{t('testing.authoring.requestSubtitle')}</code>
          </div>
        </div>
        <div className="testing-view__authoring-controls">
          <input
            value={feature}
            aria-label={t('testing.authoring.requestPlaceholder')}
            placeholder={t('testing.authoring.requestPlaceholder')}
            disabled={sending}
            onChange={(event) => onFeatureChange(event.target.value)}
          />
          <button
            type="button"
            className="testing-view__chip testing-view__chip--primary"
            disabled={!canRequest || feature.trim() === '' || sending}
            onClick={onRequest}
          >
            {sending ? t('testing.authoring.requestSending') : t('testing.authoring.requestSend')}
          </button>
        </div>
        {sent && <p role="status">{t('testing.authoring.requestSent')}</p>}
      </section>

      <section className="testing-view__authoring" aria-labelledby="testing-authoring-title">
        <div className="testing-view__panel-title">
          <div>
            <h2 id="testing-authoring-title">{t('testing.authoring.title')}</h2>
            <code>{t('testing.authoring.subtitle')}</code>
          </div>
          <button
            type="button"
            className="testing-view__chip"
            disabled={!canCheck || checking}
            onClick={onCheck}
          >
            {checking ? t('testing.authoring.checking') : t('testing.authoring.check')}
          </button>
        </div>
        {check && (
          <div className="testing-view__authoring-result">
            {check.declared.length === 0 ? (
              <p className="testing-view__card-note">{t('testing.authoring.none')}</p>
            ) : (
              <>
                <p>
                  {t('testing.authoring.summary', {
                    declared: check.declared.length,
                    valid: check.valid.length,
                    missing: check.missing.length,
                    invalid: check.invalid.length,
                  })}
                </p>
                <ul className="testing-view__rows">
                  {check.missing.map((path) => (
                    <li key={`missing-${path}`} className="testing-view__row">
                      <span className="testing-view__badge">{t('testing.authoring.missing')}</span>
                      <code>{path}</code>
                    </li>
                  ))}
                  {check.invalid.map((item) => (
                    <li key={`invalid-${item.path}`} className="testing-view__row">
                      <span className="testing-view__badge">{t('testing.authoring.invalid')}</span>
                      <code>{item.path}</code>
                      <span>{item.issues[0]?.path} {item.issues[0]?.message}</span>
                    </li>
                  ))}
                  {check.failed.map((path) => (
                    <li key={`failed-${path}`} className="testing-view__row">
                      <span className="testing-view__badge">{t('testing.authoring.failed')}</span>
                      <code>{path}</code>
                    </li>
                  ))}
                  {check.valid.map((item) => (
                    <li key={`valid-${item.path}`} className="testing-view__row">
                      <span className="testing-view__badge">{t('testing.status.passed')}</span>
                      <code>{item.path}</code>
                      <span>{t('testing.authoring.validCases', { count: item.caseCount })}</span>
                      {item.testPointCount === 0 && (
                        <span className="testing-view__badge">{t('testing.authoring.noTestPoints')}</span>
                      )}
                      {(item.unverifiedCaseIds?.length ?? 0) > 0 && (
                        <span className="testing-view__badge">
                          {t('testing.authoring.unverifiedCases', { count: item.unverifiedCaseIds.length })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {check.untouched.length > 0 && (
                  <p className="testing-view__card-note">
                    {t('testing.authoring.untouched', { count: check.untouched.length })}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </>
  )
}
