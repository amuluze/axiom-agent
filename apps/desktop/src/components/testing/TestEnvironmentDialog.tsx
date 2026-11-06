import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Plus, Save, Trash2, X } from 'lucide-react'
import { createId } from '@/agent/core/id'
import {
  isPrivateOrLocalHost,
  parseEnvironmentRecipeJson,
} from '@/agent/testing/environment/environmentFile'
import type {
  EnvironmentApprovalMode,
  EnvironmentTlsTrust,
} from '@/agent/testing/environment/environmentFile'
import { createTestStepApprover } from '@/agent/testing/approval/testStepApprover'
import { useT } from '@/i18n'
import {
  deleteTestEnvironmentRecord,
  saveTestEnvironmentRecord,
  type SaveTestEnvironmentRecord,
  type TestEnvironmentRecord,
} from '@/platform/testEnvironments'
import { deleteApiTestSecret, hasApiTestSecret, saveApiTestSecret } from '@/platform/apiTestSecrets'
import { probeEnvironmentReadiness } from '@/platform/testEnvironmentProbe'
import type { EnvironmentReadiness } from '@/agent/testing/environment/readiness'
import type { EnvironmentFileEntry } from '@/stores/services/testEnvironmentFiles'
import { trapDialogFocus, useDialogFocus } from '../dialogFocus'
import { TestStepApprovalPanel } from './TestStepApprovalPanel'

/**
 * 测试环境配置弹窗。
 *
 * 形态由「一屏铺开所有字段」收敛为「先选类型、填一个地址、保存即验证」：
 * - 基础区只有 名称 + 服务地址（+ 可选的 Web/API 分离）与推导出的信任事实；
 * - 视口、证书校验、审批档、Headers、Secret、起停配方全部收进「高级」；
 * - 主按钮保存后立刻打一次就绪探针，把「跑起来才知道环境不通」提前到配置时。
 *
 * 环境只由用户手动搭建（dev server / compose / 已部署服务）；Axiom 不启动也不停止它。
 * `kind`（本地带配方 / 远程只读）仍是记录字段，但界面的「本地 / 远程」按地址派生——
 * 把两者混成一个开关会让 local 档的「禁止受信」约束变成推荐路径上的陷阱。
 */

interface TestEnvironmentDialogProps {
  open: boolean
  environments: TestEnvironmentRecord[]
  /** 工作区 `tests/environments/*.env.ax` 的扫描结果（环境档 → 运行环境的导入入口）。 */
  environmentFiles: readonly EnvironmentFileEntry[]
  selectedId: string | null
  disabled: boolean
  onSelect: (id: string | null) => void
  onChanged: (preferredId?: string) => Promise<void>
  onClose: () => void
}

interface EnvironmentDraft {
  id: string
  name: string
  webBaseUrl: string
  apiBaseUrl: string
  /** Web 与 API 是否分开填（同源时 API Base URL 跟随 Web Base URL）。 */
  splitEndpoints: boolean
  viewportWidth: string
  viewportHeight: string
  allowPrivateNetwork: boolean
  headersJson: string
  secretIdsJson: string
  /** 环境档的结构事实（自定义服务变量与 Secret 目标白名单）：表单不提供编辑入口，
   * 改动走环境档导入，但保存必须原样带回，否则一次「改个名字」就清空多服务拓扑。 */
  extraVarsJson: string
  secretOriginsJson: string
  tlsTrust: EnvironmentTlsTrust
  approvalMode: EnvironmentApprovalMode
}

const emptyDraft = (): EnvironmentDraft => ({
  id: createId('test-env'),
  name: '',
  webBaseUrl: '',
  apiBaseUrl: '',
  splitEndpoints: false,
  viewportWidth: '1280',
  viewportHeight: '800',
  allowPrivateNetwork: false,
  headersJson: '{}',
  secretIdsJson: '[]',
  extraVarsJson: '{}',
  secretOriginsJson: '[]',
  tlsTrust: 'system',
  approvalMode: 'per_step',
})

const draftOf = (environment: TestEnvironmentRecord): EnvironmentDraft => ({
  id: environment.id,
  name: environment.name,
  webBaseUrl: environment.webBaseUrl ?? '',
  apiBaseUrl: environment.apiBaseUrl ?? '',
  splitEndpoints: (environment.apiBaseUrl ?? '') !== (environment.webBaseUrl ?? ''),
  viewportWidth: environment.viewportWidth?.toString() ?? '',
  viewportHeight: environment.viewportHeight?.toString() ?? '',
  allowPrivateNetwork: environment.allowPrivateNetwork,
  headersJson: environment.headersJson,
  secretIdsJson: environment.secretIdsJson,
  extraVarsJson: environment.extraVarsJson,
  secretOriginsJson: environment.secretOriginsJson,
  tlsTrust: environment.tlsTrust,
  approvalMode: environment.approvalMode,
})

const hostOf = (value: string): string | null => {
  try {
    return new URL(value.trim()).hostname
  } catch {
    return null
  }
}

/** 界面语义的「本地 / 远程」由地址派生：回环与私网即本地，其余为远程。 */
const targetOf = (draft: EnvironmentDraft): 'local' | 'remote' => {
  const host = hostOf(draft.webBaseUrl) ?? hostOf(draft.apiBaseUrl)
  if (host === null) return 'local'
  return isPrivateOrLocalHost(host) ? 'local' : 'remote'
}

const isPrivateDraft = (draft: EnvironmentDraft): boolean => {
  const hosts = [hostOf(draft.webBaseUrl), hostOf(draft.apiBaseUrl)].filter((host): host is string => host !== null)
  return hosts.some(isPrivateOrLocalHost)
}

const parseAbsoluteUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username !== '' || parsed.password !== '') return null
    return parsed
  } catch {
    return null
  }
}

const optionalInteger = (value: string): number | undefined => {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error('invalid integer')
  return parsed
}

/** 只读展示：多服务变量（损坏 JSON 按空处理，展示层不抛错）。 */
const summarizeServiceVars = (json: string, emptyLabel: string): string => {
  try {
    const parsed: unknown = JSON.parse(json || '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyLabel
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([a], [b]) => a.localeCompare(b))
    return entries.length === 0 ? emptyLabel : entries.map(([name, value]) => `${name}=${value}`).join(' · ')
  } catch {
    return emptyLabel
  }
}

/** 只读展示：Secret 目标白名单。 */
const summarizeSecretOrigins = (json: string): string => {
  try {
    const parsed: unknown = JSON.parse(json || '[]')
    if (!Array.isArray(parsed)) return '—'
    const origins = parsed.filter((value): value is string => typeof value === 'string')
    return origins.length === 0 ? '—' : origins.join(' · ')
  } catch {
    return '—'
  }
}

/**
 * 只读展示：起停配方的命令。
 *
 * 配方命令不由宿主执行（首版边界），但必须看得见：本地 dev container 场景里
 * 「怎么把环境起起来」的唯一事实来源就是这份配方。
 */
const summarizeRecipeCommands = (recipeJson: string | null): readonly string[] => {
  if (recipeJson === null) return []
  const parsed = parseEnvironmentRecipeJson(recipeJson)
  if (!parsed.ok) return []
  const { start, stop, readiness } = parsed.recipe
  return [...start, ...readiness, ...stop]
}

const recordOf = (draft: EnvironmentDraft, base: TestEnvironmentRecord | undefined): TestEnvironmentRecord => {
  const web = draft.webBaseUrl.trim()
  const api = (draft.splitEndpoints ? draft.apiBaseUrl : draft.webBaseUrl).trim()
  let viewportWidth: number | null = null
  let viewportHeight: number | null = null
  try {
    viewportWidth = optionalInteger(draft.viewportWidth) ?? null
    viewportHeight = optionalInteger(draft.viewportHeight) ?? null
  } catch {
    viewportWidth = null
    viewportHeight = null
  }
  return {
    id: draft.id,
    name: draft.name.trim(),
    kind: base?.kind ?? 'remote',
    recipeJson: base?.recipeJson ?? null,
    webBaseUrl: web === '' ? null : web,
    apiBaseUrl: api === '' ? null : api,
    viewportWidth,
    viewportHeight,
    allowPrivateNetwork: draft.allowPrivateNetwork,
    headersJson: draft.headersJson,
    secretIdsJson: draft.secretIdsJson,
    extraVarsJson: draft.extraVarsJson,
    secretOriginsJson: draft.secretOriginsJson,
    tlsTrust: draft.tlsTrust,
    approvalMode: draft.approvalMode,
    createdAt: base?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
}

export const TestEnvironmentDialog = ({
  open,
  environments,
  environmentFiles,
  selectedId,
  disabled,
  onSelect,
  onChanged,
  onClose,
}: TestEnvironmentDialogProps) => {
  const { t } = useT()
  const identifier = useId()
  const titleId = `testing-env-title-${identifier}`
  const selected = environments.find((environment) => environment.id === selectedId)
  const [draft, setDraft] = useState<EnvironmentDraft>(() => selected ? draftOf(selected) : emptyDraft())
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secretId, setSecretId] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [secretStatus, setSecretStatus] = useState<string | null>(null)
  const [importingPath, setImportingPath] = useState<string | null>(null)
  const [recipeCopied, setRecipeCopied] = useState(false)
  const [probing, setProbing] = useState(false)
  /**
   * 探针结论按环境 id 归属：保存成功会让父级把新记录写回 props 并切换选中，这次
   * 「选择变化」不能把刚拿到的结论清掉（否则保存并验证的结果永远看不见）。
   */
  const [readiness, setReadiness] = useState<{ id: string; value: EnvironmentReadiness } | null>(null)
  const dialogRef = useDialogFocus<HTMLElement>(open)
  const probeControllerRef = useRef<AbortController | null>(null)
  const approver = useMemo(() => createTestStepApprover(), [])
  /**
   * 「新建环境」先 onSelect(null) 再进入编辑：受控父组件把选中项置空后，下面的
   * effect 会看到 selected 从记录变成空。若它无条件 setEditing(false)，创建表单
   * 刚挂上就被立刻收起（选中过环境时必现）。ref 记住这是主动新建，跳过重置。
   */
  const creatingRef = useRef(false)

  useEffect(() => {
    if (selected) {
      creatingRef.current = false
      setDraft(draftOf(selected))
      setEditing(false)
    } else if (!creatingRef.current) {
      setEditing(false)
    }
    setError(null)
    setSecretValue('')
    setSecretStatus(null)
    setReadiness((current) => (
      selected && current?.id === selected.id ? current : null
    ))
  }, [selected])

  // 关闭弹窗时中止在途探针：审批队列与 Rust 租约都绑定这一次运行。
  useEffect(() => {
    if (open) return
    probeControllerRef.current?.abort()
    probeControllerRef.current = null
    setProbing(false)
    // saving 可能在「保存→探针」链路里悬着；关闭后必须复位，否则下次打开按钮全是禁用的
    // （表现就是「只能新建，不能删除」）。
    setSaving(false)
    setEditing(false)
    setError(null)
  }, [open])

  useEffect(() => () => probeControllerRef.current?.abort(), [])

  const update = (field: keyof EnvironmentDraft, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  /** 地址变化时重算「私网访问」事实：它是安全边界，必须与地址一致而不是手勾。 */
  const updateAddress = (field: 'webBaseUrl' | 'apiBaseUrl', value: string): void => {
    setDraft((current) => {
      const next = { ...current, [field]: value }
      return { ...next, allowPrivateNetwork: isPrivateDraft(next) }
    })
  }

  const hasAddress = draft.webBaseUrl.trim() !== '' || draft.splitEndpoints && draft.apiBaseUrl.trim() !== ''
  const target = targetOf(draft)
  const privateAccess = isPrivateDraft(draft)
  const recipeCommands = summarizeRecipeCommands(selected?.recipeJson ?? null)
  const currentReadiness = readiness && readiness.id === (selected?.id ?? draft.id) ? readiness.value : null

  const startCreate = (): void => {
    creatingRef.current = true
    onSelect(null)
    setDraft(emptyDraft())
    setEditing(true)
    setError(null)
    setReadiness(null)
  }

  const applyLocalDefaults = (): void => {
    setDraft((current) => ({
      ...current,
      webBaseUrl: 'http://localhost:5173',
      apiBaseUrl: 'http://localhost:8080',
      splitEndpoints: true,
      allowPrivateNetwork: true,
    }))
  }

  const validate = (): { payload: SaveTestEnvironmentRecord } => {
    const name = draft.name.trim()
    if (name === '') throw new Error(t('testing.environment.nameRequired'))
    const web = draft.webBaseUrl.trim()
    const api = (draft.splitEndpoints ? draft.apiBaseUrl : web).trim()
    if (web === '' && api === '') throw new Error(t('testing.environment.addressRequired'))
    const webUrl = web === '' ? null : parseAbsoluteUrl(web)
    const apiUrl = api === '' ? null : parseAbsoluteUrl(api)
    if ((web !== '' && webUrl === null) || (api !== '' && apiUrl === null)) {
      throw new Error(t('testing.environment.invalidUrl'))
    }
    if (draft.tlsTrust === 'insecure') {
      // 与 Rust 同一判据的镜像：公网目标不允许跳过证书校验（宿主仍会二次校验）。
      const hosts = [webUrl?.hostname, apiUrl?.hostname].filter((host): host is string => host !== undefined)
      if (hosts.length === 0 || hosts.some((host) => !isPrivateOrLocalHost(host))) {
        throw new Error(t('testing.environment.quickInsecurePublic'))
      }
    }
    const viewportWidth = optionalInteger(draft.viewportWidth)
    const viewportHeight = optionalInteger(draft.viewportHeight)
    if (viewportWidth === undefined !== (viewportHeight === undefined)) {
      throw new Error(t('testing.environment.viewportPair'))
    }
    return {
      payload: {
        id: draft.id,
        name,
        // 编辑既有环境时必须带上它当前的档位与配方：表单里没有这两个字段，一旦省略，
        // Rust 侧按「缺省 remote / 无配方」写回，导入的 local 档就被静默降级。
        kind: selected?.kind ?? 'remote',
        recipeJson: selected?.recipeJson ?? null,
        ...(web === '' ? {} : { webBaseUrl: web }),
        ...(api === '' ? {} : { apiBaseUrl: api }),
        ...(viewportWidth !== undefined ? { viewportWidth } : {}),
        ...(viewportHeight !== undefined ? { viewportHeight } : {}),
        allowPrivateNetwork: draft.allowPrivateNetwork,
        headersJson: draft.headersJson,
        secretIdsJson: draft.secretIdsJson,
        extraVarsJson: draft.extraVarsJson,
        secretOriginsJson: draft.secretOriginsJson,
        tlsTrust: draft.tlsTrust,
        approvalMode: draft.approvalMode,
        updatedAt: Date.now(),
      },
    }
  }

  /** 保存后立刻打一次就绪探针：结论原样展示，不收敛成「环境不可用」。 */
  const verify = async (record: TestEnvironmentRecord): Promise<void> => {
    if (record.apiBaseUrl === null) {
      setReadiness(null)
      return
    }
    probeControllerRef.current?.abort()
    const controller = new AbortController()
    probeControllerRef.current = controller
    setProbing(true)
    setReadiness(null)
    try {
      const result = await probeEnvironmentReadiness({
        environment: record,
        runId: createId('env-probe'),
        approver,
        signal: controller.signal,
      })
      if (!controller.signal.aborted) setReadiness({ id: record.id, value: result.readiness })
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : t('testing.environment.verifyError'))
      }
    } finally {
      if (!controller.signal.aborted) setProbing(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const { payload } = validate()
      const saved = await saveTestEnvironmentRecord(payload)
      // 原生变更确认框被取消：保持编辑态，不当作已保存。
      if (!saved) return
      await onChanged(draft.id)
      setEditing(false)
      // 探针不阻塞保存：它可能停在审批/租约上，await 会让整个弹窗的按钮长期禁用
      // （用户会以「保存完就不能删了」的形式撞上）。结论到了再渲染。
      void verify(recordOf(draft, selected))
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== 'invalid integer'
        ? cause.message
        : t('testing.environment.invalid'))
    } finally {
      setSaving(false)
    }
  }

  const copyRecipeCommands = async (commands: readonly string[]): Promise<void> => {
    try {
      await navigator.clipboard.writeText(commands.join('\n'))
      setRecipeCopied(true)
    } catch {
      setError(t('testing.environment.recipeCopyFailed'))
    }
  }

  const remove = async (): Promise<void> => {
    if (!selected) return
    // 删除与探针互不影响：先中止在途探针（它绑定的是即将消失的环境）。
    probeControllerRef.current?.abort()
    probeControllerRef.current = null
    setProbing(false)
    setSaving(true)
    setError(null)
    try {
      const deleted = await deleteTestEnvironmentRecord(selected.id)
      // 宿主返回 false = 没删到（环境已不在 / 不属于当前工作区）。此时不能假装成功。
      if (!deleted) {
        setError(t('testing.environment.deleteMissing'))
        return
      }
      await onChanged()
      setEditing(false)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('testing.environment.deleteError'))
    } finally {
      setSaving(false)
    }
  }

  /**
   * 环境档 → 运行环境：档是唯一的结构事实来源，导入即把它写成一条环境记录。
   * 重复导入同一份档会更新同一条记录（id 复用档里的 id）。
   */
  const importFile = async (entry: EnvironmentFileEntry): Promise<void> => {
    const fileDraft = entry.draft
    if (!fileDraft) return
    setSaving(true)
    setError(null)
    setImportingPath(entry.path)
    try {
      const saved = await saveTestEnvironmentRecord({
        id: fileDraft.id,
        name: fileDraft.name,
        kind: fileDraft.kind,
        recipeJson: fileDraft.recipeJson,
        ...(fileDraft.webBaseUrl === undefined ? {} : { webBaseUrl: fileDraft.webBaseUrl }),
        ...(fileDraft.apiBaseUrl === undefined ? {} : { apiBaseUrl: fileDraft.apiBaseUrl }),
        ...(fileDraft.viewportWidth === undefined || fileDraft.viewportHeight === undefined
          ? {}
          : { viewportWidth: fileDraft.viewportWidth, viewportHeight: fileDraft.viewportHeight }),
        allowPrivateNetwork: fileDraft.allowPrivateNetwork,
        headersJson: fileDraft.headersJson,
        secretIdsJson: fileDraft.secretIdsJson,
        ...(fileDraft.extraVarsJson === undefined ? {} : { extraVarsJson: fileDraft.extraVarsJson }),
        ...(fileDraft.secretOriginsJson === undefined ? {} : { secretOriginsJson: fileDraft.secretOriginsJson }),
        ...(fileDraft.tlsTrust === undefined ? {} : { tlsTrust: fileDraft.tlsTrust }),
        ...(fileDraft.approvalMode === undefined ? {} : { approvalMode: fileDraft.approvalMode }),
        updatedAt: Date.now(),
      })
      if (!saved) return
      await onChanged(fileDraft.id)
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

  if (!open) return null

  /** 表单/删除只受保存约束；探针在跑时仍可编辑或删除（删除会先中止探针）。 */
  const busy = disabled || saving
  const typeLabel = target === 'local' ? t('testing.envbar.local') : t('testing.envbar.remote')

  return (
    <div className="approval-backdrop" role="presentation">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="testing-env-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
            return
          }
          trapDialogFocus(event, dialogRef.current)
        }}
      >
        <header className="testing-env-dialog__header">
          <div>
            <h2 id={titleId}>{t('testing.environment.dialogTitle')}</h2>
            <p>{t('testing.environment.dialogSubtitle')}</p>
          </div>
          <button type="button" className="testing-env-dialog__close" aria-label={t('testing.environment.close')} onClick={onClose}>
            <X size={14} aria-hidden />
          </button>
        </header>

        {/* 错误固定在头部下方：动作错误与导入错误都不能被滚出视口（否则表现为「点了没反应」）。 */}
        {error && (
          <p role="alert" className="testing-env-dialog__alert">{error}</p>
        )}

        <div className="testing-env-dialog__body">
          <aside className="testing-env-dialog__list" aria-label={t('testing.environment.list')}>
            <button
              type="button"
              className="testing-env-dialog__list-item testing-env-dialog__list-item--new"
              data-dialog-initial-focus
              disabled={disabled || saving}
              onClick={startCreate}
            >
              <Plus size={13} aria-hidden />
              {t('testing.environment.new')}
            </button>
            {environments.length === 0
              ? <p className="testing-env-dialog__list-empty">{t('testing.environment.listEmpty')}</p>
              : environments.map((environment) => {
                const host = hostOf(environment.webBaseUrl ?? environment.apiBaseUrl ?? '') ?? ''
                const kind = isPrivateOrLocalHost(host)
                  ? t('testing.envbar.local')
                  : t('testing.envbar.remote')
                return (
                  <button
                    key={environment.id}
                    type="button"
                    className={`testing-env-dialog__list-item${environment.id === selectedId ? ' is-active' : ''}`}
                    aria-current={environment.id === selectedId}
                    onClick={() => onSelect(environment.id)}
                  >
                    <strong>{environment.name}</strong>
                    <span>{kind}{host === '' ? '' : ` · ${host}`}</span>
                  </button>
                )
              })}
          </aside>

          <div className="testing-env-dialog__main">
            {editing || selected ? (
              <>
                {!hasAddress ? (
                  <fieldset className="testing-env-dialog__types">
                    <legend className="testing-view__visually-hidden">{t('testing.environment.typeLabel')}</legend>
                    <button
                      type="button"
                      className={`testing-env-dialog__type${target === 'local' ? ' is-active' : ''}`}
                      onClick={applyLocalDefaults}
                    >
                      <strong>{t('testing.environment.typeLocal')}</strong>
                      <span>{t('testing.environment.typeLocalHint')}</span>
                    </button>
                    <button
                      type="button"
                      className={`testing-env-dialog__type${target === 'remote' ? ' is-active' : ''}`}
                      onClick={() => setDraft((current) => ({ ...current, splitEndpoints: false }))}
                    >
                      <strong>{t('testing.environment.typeRemote')}</strong>
                      <span>{t('testing.environment.typeRemoteHint')}</span>
                    </button>
                  </fieldset>
                ) : (
                  <p className="testing-env-dialog__derived">
                    <span className="testing-env-dialog__badge">{typeLabel}</span>
                    {privateAccess && <span className="testing-env-dialog__badge">{t('testing.environment.derivedPrivate')}</span>}
                    <span className="testing-env-dialog__badge">{t('testing.environment.derivedProbe')}</span>
                  </p>
                )}

                <div className="testing-env-dialog__fields">
                  <label className="testing-view__field">
                    <span>{t('testing.environment.name')}</span>
                    <input
                      value={draft.name}
                      placeholder="beacon-local"
                      disabled={!editing || busy}
                      onChange={(event) => update('name', event.target.value)}
                    />
                  </label>
                  <label className="testing-view__field testing-env-dialog__field--wide">
                    <span>{t('testing.environment.address')}</span>
                    <input
                      className="testing-view__mono"
                      value={draft.webBaseUrl}
                      placeholder="http://localhost:5173"
                      disabled={!editing || busy}
                      onChange={(event) => updateAddress('webBaseUrl', event.target.value)}
                    />
                  </label>
                  <label className="testing-env-dialog__checkbox">
                    <input
                      type="checkbox"
                      checked={draft.splitEndpoints}
                      disabled={!editing || busy}
                      onChange={(event) => setDraft((current) => ({ ...current, splitEndpoints: event.target.checked }))}
                    />
                    <span>{t('testing.environment.splitEndpoints')}</span>
                  </label>
                  {draft.splitEndpoints && (
                    <label className="testing-view__field testing-env-dialog__field--wide">
                      <span>{t('testing.environment.apiBaseUrl')}</span>
                      <input
                        className="testing-view__mono"
                        value={draft.apiBaseUrl}
                        placeholder="http://localhost:8080"
                        disabled={!editing || busy}
                        onChange={(event) => updateAddress('apiBaseUrl', event.target.value)}
                      />
                    </label>
                  )}
                </div>

                <div className="testing-env-dialog__actions">
                  {editing ? (
                    <>
                      <button type="button" className="testing-view__primary" disabled={busy || draft.name.trim() === ''} onClick={() => void save()}>
                        <Save size={13} aria-hidden />
                        {saving ? t('testing.environment.saving') : t('testing.environment.saveAndVerify')}
                      </button>
                      <button
                        type="button"
                        className="testing-view__secondary"
                        disabled={busy}
                        onClick={() => {
                          creatingRef.current = false
                          setEditing(false)
                          if (!selected) onSelect(null)
                          setDraft(selected ? draftOf(selected) : emptyDraft())
                        }}
                      >
                        {t('testing.environment.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="testing-view__primary" disabled={busy} onClick={() => setEditing(true)}>
                        {t('testing.environment.edit')}
                      </button>
                      <button type="button" className="testing-view__secondary" disabled={busy || probing} onClick={() => void verify(recordOf(draft, selected))}>
                        {probing ? t('testing.environment.verifying') : t('testing.environment.verify')}
                      </button>
                      <button type="button" className="testing-view__danger" disabled={busy} onClick={() => void remove()}>
                        <Trash2 size={13} aria-hidden />
                        {t('testing.environment.delete')}
                      </button>
                    </>
                  )}
                </div>

                <p className="testing-env-dialog__hint">{t('testing.environment.verifyHint')}</p>

                {probing && <p className="testing-env-dialog__probe" role="status">{t('testing.environment.verifying')}</p>}
                {/* 审批卡只在探针在途时挂载：没有待确认步骤时不占一行空态。 */}
                {probing && <TestStepApprovalPanel approver={approver} />}
                {currentReadiness && (
                  <p
                    className={`testing-env-dialog__probe testing-env-dialog__probe--${currentReadiness.ready ? 'ok' : 'bad'}`}
                    role="status"
                  >
                    {currentReadiness.ready ? <CheckCircle2 size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}
                    {currentReadiness.ready
                      ? t('testing.environment.verifyReady', { reason: currentReadiness.reason })
                      : t('testing.environment.verifyFailed', { reason: currentReadiness.reason })}
                  </p>
                )}

                <details className="testing-env-dialog__advanced">
                  <summary>{t('testing.environment.advanced')}</summary>
                  <div className="testing-env-dialog__fields">
                    <label className="testing-view__field">
                      <span>{t('testing.environment.viewportWidth')}</span>
                      <input type="number" min={320} step={1} value={draft.viewportWidth} disabled={!editing || busy} onChange={(event) => update('viewportWidth', event.target.value)} />
                    </label>
                    <label className="testing-view__field">
                      <span>{t('testing.environment.viewportHeight')}</span>
                      <input type="number" min={240} step={1} value={draft.viewportHeight} disabled={!editing || busy} onChange={(event) => update('viewportHeight', event.target.value)} />
                    </label>
                    <label className="testing-env-dialog__checkbox">
                      <input
                        type="checkbox"
                        checked={draft.allowPrivateNetwork}
                        disabled={!editing || busy}
                        onChange={(event) => setDraft((current) => ({ ...current, allowPrivateNetwork: event.target.checked }))}
                      />
                      <span>{t('testing.environment.allowPrivateNetwork')}</span>
                    </label>
                    <label className="testing-view__field">
                      <span>{t('testing.environment.tlsTrust')}</span>
                      <select value={draft.tlsTrust} disabled={!editing || busy} onChange={(event) => setDraft((current) => ({ ...current, tlsTrust: event.target.value as EnvironmentTlsTrust }))}>
                        <option value="system">{t('testing.environment.tlsTrustSystem')}</option>
                        <option value="insecure">{t('testing.environment.tlsTrustInsecure')}</option>
                      </select>
                    </label>
                    <label className="testing-view__field">
                      <span>{t('testing.environment.approvalMode')}</span>
                      <select value={draft.approvalMode} disabled={!editing || busy} onChange={(event) => setDraft((current) => ({ ...current, approvalMode: event.target.value as EnvironmentApprovalMode }))}>
                        <option value="per_step">{t('testing.environment.approvalPerStep')}</option>
                        {/* 受信只对远程档开放（本地档的步骤可能改本机代码）——宿主侧也会拒。 */}
                        <option value="trusted" disabled={selected?.kind === 'local'}>
                          {t('testing.environment.approvalTrusted')}
                        </option>
                      </select>
                    </label>
                  </div>
                  <p className="testing-env-dialog__hint">
                    {draft.tlsTrust === 'insecure' ? t('testing.environment.tlsTrustHint') : ''}
                    {draft.approvalMode === 'trusted' ? t('testing.environment.approvalTrustedHint') : ''}
                  </p>
                  <div className="testing-env-dialog__json">
                    <label className="testing-view__field">
                      <span>{t('testing.environment.headersJson')}</span>
                      <textarea className="testing-view__mono" rows={3} spellCheck={false} value={draft.headersJson} disabled={!editing || busy} onChange={(event) => update('headersJson', event.target.value)} />
                    </label>
                    <label className="testing-view__field">
                      <span>{t('testing.environment.secretIdsJson')}</span>
                      <textarea className="testing-view__mono" rows={3} spellCheck={false} value={draft.secretIdsJson} disabled={!editing || busy} onChange={(event) => update('secretIdsJson', event.target.value)} />
                    </label>
                  </div>
                  {editing && (
                    <div className="testing-env-dialog__secret">
                      <label className="testing-view__field">
                        <span>{t('testing.environment.secretId')}</span>
                        <input value={secretId} disabled={busy} onChange={(event) => setSecretId(event.target.value)} placeholder="apitest.example-token" />
                      </label>
                      <label className="testing-view__field">
                        <span>{t('testing.environment.secretValue')}</span>
                        <input type="password" autoComplete="new-password" value={secretValue} disabled={busy} onChange={(event) => setSecretValue(event.target.value)} />
                      </label>
                      <button type="button" className="testing-view__secondary" disabled={busy || !secretId.trim()} onClick={() => void checkSecret()}>
                        {t('testing.environment.secretCheck')}
                      </button>
                      <button type="button" className="testing-view__secondary" disabled={busy || !secretId.trim() || !secretValue} onClick={() => void saveSecret()}>
                        {t('testing.environment.secretSave')}
                      </button>
                      <button type="button" className="testing-view__danger" disabled={busy || !secretId.trim()} onClick={() => void removeSecret()}>
                        {t('testing.environment.secretDelete')}
                      </button>
                      {secretStatus && <span role="status">{secretStatus}</span>}
                    </div>
                  )}
                  {selected && !editing && (
                    <div className="testing-env-dialog__facts">
                      <p>{t('testing.environment.mode')}{t(selected.kind === 'local' ? 'testing.environment.kindLocal' : 'testing.environment.kindRemote')}</p>
                      <p>{t('testing.environment.extraVars')}</p>
                      <code>{summarizeServiceVars(selected.extraVarsJson, t('testing.environment.extraVarsEmpty'))}</code>
                      <p>{t('testing.environment.secretOrigins')}</p>
                      <code>{summarizeSecretOrigins(selected.secretOriginsJson)}</code>
                    </div>
                  )}
                  {selected && recipeCommands.length > 0 && (
                    <div className="testing-env-dialog__facts">
                      <p>{t('testing.environment.recipeCommands')}</p>
                      <code className="testing-env-dialog__recipe">{recipeCommands.join('\n')}</code>
                      <p>{t('testing.environment.recipeCommandsHint')}</p>
                      <button type="button" className="testing-view__secondary" disabled={busy} onClick={() => void copyRecipeCommands(recipeCommands)}>
                        {t('testing.environment.recipeCopy')}
                      </button>
                      {recipeCopied && <span role="status">{t('testing.environment.recipeCopied')}</span>}
                    </div>
                  )}
                </details>

              </>
            ) : (
              <p className="testing-env-dialog__placeholder">{t('testing.environment.listHint')}</p>
            )}

            {/* 环境档导入与当前是否选中环境无关：它本身就是一条“建环境”的路径。 */}
            {environmentFiles.length > 0 && (
              <details className="testing-env-dialog__advanced">
                <summary>{t('testing.environment.filesCount', { count: environmentFiles.length })}</summary>
                <ul className="testing-env-dialog__files">
                  {environmentFiles.map((entry) => (
                    <li key={entry.path}>
                      <code>{entry.path}</code>
                      {entry.valid ? (
                        <>
                          <span className="testing-env-dialog__badge">
                            {t(entry.mode === 'local' ? 'testing.environment.kindLocal' : 'testing.environment.kindRemote')}
                          </span>
                          <button
                            type="button"
                            className="testing-view__secondary"
                            disabled={busy}
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
              </details>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
