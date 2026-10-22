import { useEffect, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { createId } from '@/agent/core/id'
import { useT } from '@/i18n'
import {
  deleteTestEnvironmentRecord,
  saveTestEnvironmentRecord,
  type TestEnvironmentRecord,
} from '@/platform/testEnvironments'
import { deleteApiTestSecret, hasApiTestSecret, saveApiTestSecret } from '@/platform/apiTestSecrets'
import type { EnvironmentFileEntry } from '@/stores/services/testEnvironmentFiles'

interface TestEnvironmentPanelProps {
  environments: TestEnvironmentRecord[]
  /** 工作区 `tests/environments/*.env.ax` 的扫描结果（环境档 → 运行环境的导入入口）。 */
  environmentFiles: readonly EnvironmentFileEntry[]
  selectedId: string | null
  disabled: boolean
  onSelect: (id: string | null) => void
  onChanged: (preferredId?: string) => Promise<void>
}

interface EnvironmentDraft {
  id: string
  name: string
  webBaseUrl: string
  apiBaseUrl: string
  viewportWidth: string
  viewportHeight: string
  allowPrivateNetwork: boolean
  headersJson: string
  secretIdsJson: string
}

const emptyDraft = (): EnvironmentDraft => ({
  id: createId('test-env'),
  name: '',
  webBaseUrl: '',
  apiBaseUrl: '',
  viewportWidth: '1280',
  viewportHeight: '800',
  allowPrivateNetwork: false,
  headersJson: '{}',
  secretIdsJson: '[]',
})

const draftOf = (environment: TestEnvironmentRecord): EnvironmentDraft => ({
  id: environment.id,
  name: environment.name,
  webBaseUrl: environment.webBaseUrl ?? '',
  apiBaseUrl: environment.apiBaseUrl ?? '',
  viewportWidth: environment.viewportWidth?.toString() ?? '',
  viewportHeight: environment.viewportHeight?.toString() ?? '',
  allowPrivateNetwork: environment.allowPrivateNetwork,
  headersJson: environment.headersJson,
  secretIdsJson: environment.secretIdsJson,
})

const optionalInteger = (value: string): number | undefined => {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error('invalid integer')
  return parsed
}

export const TestEnvironmentPanel = ({
  environments,
  environmentFiles,
  selectedId,
  disabled,
  onSelect,
  onChanged,
}: TestEnvironmentPanelProps) => {
  const { t } = useT()
  const selected = environments.find((environment) => environment.id === selectedId)
  const [draft, setDraft] = useState<EnvironmentDraft>(() => selected ? draftOf(selected) : emptyDraft())
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secretId, setSecretId] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [secretStatus, setSecretStatus] = useState<string | null>(null)
  const [importingPath, setImportingPath] = useState<string | null>(null)

  useEffect(() => {
    if (selected) setDraft(draftOf(selected))
    setEditing(false)
    setError(null)
    setSecretValue('')
    setSecretStatus(null)
  }, [selected])

  const update = (field: keyof EnvironmentDraft, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const startCreate = (): void => {
    onSelect(null)
    setDraft(emptyDraft())
    setEditing(true)
    setError(null)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const viewportWidth = optionalInteger(draft.viewportWidth)
      const viewportHeight = optionalInteger(draft.viewportHeight)
      if (viewportWidth === undefined !== (viewportHeight === undefined)) {
        throw new Error(t('testing.environment.viewportPair'))
      }
      const saved = await saveTestEnvironmentRecord({
        id: draft.id,
        name: draft.name.trim(),
        // 编辑既有环境时必须带上它当前的档位与配方：保存表单里没有这两个字段，
        // 一旦省略，Rust 侧会按「缺省 remote / 无配方」写回，导入的 local 档
        // 就被静默降级、配方被抹掉（1b 提供面板内编辑前的唯一保护）。
        kind: selected?.kind ?? 'remote',
        recipeJson: selected?.recipeJson ?? null,
        ...(draft.webBaseUrl.trim() ? { webBaseUrl: draft.webBaseUrl.trim() } : {}),
        ...(draft.apiBaseUrl.trim() ? { apiBaseUrl: draft.apiBaseUrl.trim() } : {}),
        ...(viewportWidth !== undefined ? { viewportWidth } : {}),
        ...(viewportHeight !== undefined ? { viewportHeight } : {}),
        allowPrivateNetwork: draft.allowPrivateNetwork,
        headersJson: draft.headersJson,
        secretIdsJson: draft.secretIdsJson,
        updatedAt: Date.now(),
      })
      // 原生变更确认框被取消：保持编辑态，不当作已保存。
      if (!saved) return
      await onChanged(draft.id)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== 'invalid integer'
        ? cause.message
        : t('testing.environment.invalid'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      await deleteTestEnvironmentRecord(selected.id)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('testing.environment.deleteError'))
    } finally {
      setSaving(false)
    }
  }

  /**
   * 环境档 → 运行环境：档是唯一的结构事实来源，导入即把它写成一条环境记录。
   * 重复导入同一份档会更新同一条记录（id 复用档里的 id），因此可以放心反复执行。
   */
  const importFile = async (entry: EnvironmentFileEntry): Promise<void> => {
    const draft = entry.draft
    if (!draft) return
    setSaving(true)
    setError(null)
    setImportingPath(entry.path)
    try {
      const saved = await saveTestEnvironmentRecord({
        id: draft.id,
        name: draft.name,
        kind: draft.kind,
        recipeJson: draft.recipeJson,
        ...(draft.webBaseUrl === undefined ? {} : { webBaseUrl: draft.webBaseUrl }),
        ...(draft.apiBaseUrl === undefined ? {} : { apiBaseUrl: draft.apiBaseUrl }),
        ...(draft.viewportWidth === undefined || draft.viewportHeight === undefined
          ? {}
          : { viewportWidth: draft.viewportWidth, viewportHeight: draft.viewportHeight }),
        allowPrivateNetwork: draft.allowPrivateNetwork,
        headersJson: draft.headersJson,
        secretIdsJson: draft.secretIdsJson,
        updatedAt: Date.now(),
      })
      if (!saved) return
      await onChanged(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('testing.environment.importError'))
    } finally {
      setImportingPath(null)
      setSaving(false)
    }
  }

  const nextSecretIds = (id: string, present: boolean): string => {
    const parsed: unknown = JSON.parse(draft.secretIdsJson)
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      throw new Error(t('testing.environment.secretIdsInvalid'))
    }
    const ids = new Set(parsed)
    if (present) ids.add(id)
    else ids.delete(id)
    return JSON.stringify([...ids].sort())
  }

  const saveSecret = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const id = secretId.trim()
      const secretIdsJson = nextSecretIds(id, true)
      await saveApiTestSecret(id, secretValue)
      setDraft((current) => ({ ...current, secretIdsJson }))
      setSecretValue('')
      setSecretStatus(t('testing.environment.secretSaved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('testing.environment.secretError'))
    } finally {
      setSaving(false)
    }
  }

  const checkSecret = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      setSecretStatus(await hasApiTestSecret(secretId.trim())
        ? t('testing.environment.secretExists')
        : t('testing.environment.secretMissing'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('testing.environment.secretError'))
    } finally {
      setSaving(false)
    }
  }

  const removeSecret = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const id = secretId.trim()
      const secretIdsJson = nextSecretIds(id, false)
      await deleteApiTestSecret(id)
      setDraft((current) => ({ ...current, secretIdsJson }))
      setSecretValue('')
      setSecretStatus(t('testing.environment.secretDeleted'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('testing.environment.secretError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="testing-view__environment" aria-label={t('testing.environment.title')}>
      <div className="testing-view__environment-toolbar">
        <label>
          <span>{t('testing.environment.title')}</span>
          <select
            value={selectedId ?? ''}
            disabled={disabled || saving}
            onChange={(event) => onSelect(event.target.value || null)}
          >
            <option value="">{t('testing.environment.none')}</option>
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>{environment.name}</option>
            ))}
          </select>
        </label>
        <button type="button" className="testing-view__secondary" disabled={disabled || saving} onClick={startCreate}>
          <Plus size={13} aria-hidden="true" />
          {t('testing.environment.new')}
        </button>
        {selected && !editing && (
          <button type="button" className="testing-view__secondary" disabled={disabled || saving} onClick={() => setEditing(true)}>
            {t('testing.environment.edit')}
          </button>
        )}
      </div>

      {environmentFiles.length > 0 && (
        <section className="testing-view__environment-files" aria-label={t('testing.environment.files')}>
          <span className="testing-view__environment-files-title">{t('testing.environment.files')}</span>
          <ul>
            {environmentFiles.map((entry) => (
              <li key={entry.path}>
                <code>{entry.path}</code>
                {entry.valid ? (
                  <>
                    <span className="testing-view__chip">
                      {t(entry.mode === 'local' ? 'testing.environment.kindLocal' : 'testing.environment.kindRemote')}
                    </span>
                    <button
                      type="button"
                      className="testing-view__secondary"
                      disabled={disabled || saving}
                      onClick={() => void importFile(entry)}
                    >
                      {importingPath === entry.path
                        ? t('testing.environment.importing')
                        : t('testing.environment.import')}
                    </button>
                  </>
                ) : (
                  <span className="testing-view__environment-error">
                    {t('testing.index.invalid')}：{entry.issues[0]?.path} {entry.issues[0]?.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(editing || selected) && (
        <div className="testing-view__environment-form">
          <label>
            <span>{t('testing.environment.name')}</span>
            <input value={draft.name} disabled={!editing || disabled || saving} onChange={(event) => update('name', event.target.value)} />
          </label>
          <label>
            <span>{t('testing.environment.webBaseUrl')}</span>
            <input value={draft.webBaseUrl} disabled={!editing || disabled || saving} onChange={(event) => update('webBaseUrl', event.target.value)} />
          </label>
          <label>
            <span>{t('testing.environment.apiBaseUrl')}</span>
            <input value={draft.apiBaseUrl} disabled={!editing || disabled || saving} onChange={(event) => update('apiBaseUrl', event.target.value)} />
          </label>
          <label>
            <span>{t('testing.environment.viewportWidth')}</span>
            <input type="number" value={draft.viewportWidth} disabled={!editing || disabled || saving} onChange={(event) => update('viewportWidth', event.target.value)} />
          </label>
          <label>
            <span>{t('testing.environment.viewportHeight')}</span>
            <input type="number" value={draft.viewportHeight} disabled={!editing || disabled || saving} onChange={(event) => update('viewportHeight', event.target.value)} />
          </label>
          <label className="testing-view__environment-checkbox">
            <input
              type="checkbox"
              checked={draft.allowPrivateNetwork}
              disabled={!editing || disabled || saving}
              onChange={(event) => setDraft((current) => ({ ...current, allowPrivateNetwork: event.target.checked }))}
            />
            <span>{t('testing.environment.allowPrivateNetwork')}</span>
          </label>
          <label>
            <span>{t('testing.environment.headersJson')}</span>
            <textarea value={draft.headersJson} disabled={!editing || disabled || saving} onChange={(event) => update('headersJson', event.target.value)} />
          </label>
          <label>
            <span>{t('testing.environment.secretIdsJson')}</span>
            <textarea value={draft.secretIdsJson} disabled={!editing || disabled || saving} onChange={(event) => update('secretIdsJson', event.target.value)} />
          </label>
          {editing && (
            <div className="testing-view__secret-editor">
              <label>
                <span>{t('testing.environment.secretId')}</span>
                <input value={secretId} disabled={disabled || saving} onChange={(event) => setSecretId(event.target.value)} placeholder="apitest.example-token" />
              </label>
              <label>
                <span>{t('testing.environment.secretValue')}</span>
                <input type="password" autoComplete="new-password" value={secretValue} disabled={disabled || saving} onChange={(event) => setSecretValue(event.target.value)} />
              </label>
              <button type="button" className="testing-view__secondary" disabled={disabled || saving || !secretId.trim()} onClick={() => void checkSecret()}>
                {t('testing.environment.secretCheck')}
              </button>
              <button type="button" className="testing-view__secondary" disabled={disabled || saving || !secretId.trim() || !secretValue} onClick={() => void saveSecret()}>
                {t('testing.environment.secretSave')}
              </button>
              <button type="button" className="testing-view__danger" disabled={disabled || saving || !secretId.trim()} onClick={() => void removeSecret()}>
                {t('testing.environment.secretDelete')}
              </button>
              {secretStatus && <span role="status">{secretStatus}</span>}
            </div>
          )}
          {editing && (
            <button type="button" className="testing-view__primary" disabled={disabled || saving || !draft.name.trim()} onClick={() => void save()}>
              <Save size={13} aria-hidden="true" />
              {saving ? t('testing.environment.saving') : t('testing.environment.save')}
            </button>
          )}
          {selected && !editing && (
            <p className="testing-view__environment-mode">
              {`${t('testing.environment.mode')}${t(
                selected.kind === 'local' ? 'testing.environment.kindLocal' : 'testing.environment.kindRemote',
              )}`}
              {selected.recipeJson === null ? '' : ` · ${t('testing.environment.recipeConfigured')}`}
            </p>
          )}
          {selected && !editing && (
            <button type="button" className="testing-view__danger" disabled={disabled || saving} onClick={() => void remove()}>
              <Trash2 size={13} aria-hidden="true" />
              {t('testing.environment.delete')}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="testing-view__environment-error">{error}</p>}
    </section>
  )
}
