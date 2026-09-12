import { useEffect, useState, type FormEvent } from 'react'
import { ChevronLeft, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { ensureSshEvents, useSshStore } from '@/stores/sshStore'
import type { SshHostEntry } from '@/platform/sshSession'
import { useT } from '@/i18n'

/**
 * SSH 主机管理面板（SshView 左栏，对齐设计稿「Axiom — SSH」主机管理列）：
 * 返回行（onBack 由宿主 SshView 传入）+ 主机列表 + 内联新增/编辑表单。
 * 主机数据权威在 Rust 注册表（~/.axiom/ssh/hosts.json），本组件只经
 * sshStore 驱动 ssh_command。状态列投影 Rust 会话托管状态（sessions）：
 * 已连接 / 连接中 / 连接失败 / 未连接；点击主机行选中该主机，右侧终端
 * 面板自动连接。删除直接生效（主机条目重建成本低，不做二次确认）。
 */

export interface SshHostsPanelProps {
  /** 返回上一视图（SshView 的退出动作）；缺省不渲染返回行。 */
  onBack?: () => void
}

interface FormState {
  name: string
  hostname: string
  port: string
  username: string
  /** 非空 = 保存/替换密码；空 = 不改动（清除经 clearPassword 显式表达）。 */
  password: string
  clearPassword: boolean
  /** 私钥绝对路径（非密，可回填展示）；空串 = 清除。 */
  privateKeyPath: string
}

const EMPTY_FORM: FormState = {
  name: '',
  hostname: '',
  port: '22',
  username: '',
  password: '',
  clearPassword: false,
  privateKeyPath: '',
}

const formStateOfHost = (host: SshHostEntry): FormState => ({
  name: host.name,
  hostname: host.hostname,
  port: String(host.port),
  username: host.username,
  password: '',
  clearPassword: false,
  privateKeyPath: host.privateKeyPath ?? '',
})

export const SshHostsPanel = ({ onBack }: SshHostsPanelProps) => {
  const { t } = useT()
  const hosts = useSshStore((state) => state.hosts)
  const listStatus = useSshStore((state) => state.listStatus)
  const error = useSshStore((state) => state.error)
  const sessions = useSshStore((state) => state.sessions)
  const loadHosts = useSshStore((state) => state.loadHosts)
  const saveHost = useSshStore((state) => state.saveHost)
  const deleteHost = useSshStore((state) => state.deleteHost)
  const refreshSessions = useSshStore((state) => state.refreshSessions)
  const setActiveHostId = useSshStore((state) => state.setActiveHostId)

  /** 编辑中的主机 id；null = 新增，undefined = 表单关闭。 */
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void loadHosts()
    ensureSshEvents()
    void refreshSessions()
  }, [loadHosts, refreshSessions])

  const openCreate = (): void => {
    setForm(EMPTY_FORM)
    setFormError(null)
    setEditingId(null)
  }

  const openEdit = (host: SshHostEntry): void => {
    setForm(formStateOfHost(host))
    setFormError(null)
    setEditingId(host.id)
  }

  const closeForm = (): void => {
    setEditingId(undefined)
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    // 端口在前端先行拦截（Rust 侧仍权威校验），无效时不发起请求。
    const port = Number.parseInt(form.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setFormError(t('app.sshView.hosts.form.portError'))
      return
    }
    // 私钥路径先行校验（Rust 侧仍权威校验）：非空必须是绝对路径。
    const privateKeyPath = form.privateKeyPath.trim()
    if (privateKeyPath && !privateKeyPath.startsWith('/')) {
      setFormError(t('app.sshView.hosts.form.privateKeyError'))
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await saveHost(
        {
          name: form.name,
          hostname: form.hostname,
          port,
          username: form.username,
          // 未勾选清除且未输入新密码 → 不改动（字段缺省）。
          ...(form.clearPassword ? { password: '' } : form.password ? { password: form.password } : {}),
          // 私钥路径非密可回填，始终提交：空串 = 清除，非空 = 设置。
          privateKeyPath,
        },
        editingId,
      )
      closeForm()
    } catch {
      // 字段校验失败留在表单态，错误由 store.error 展示。
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (host: SshHostEntry): Promise<void> => {
    try {
      await deleteHost(host.id)
    } catch {
      // 删除失败错误已写入 store.error。
    }
  }

  return (
    <section className="sshview__hosts" aria-label={t('app.sshView.hosts.aria')}>
      {onBack && (
        <div className="sshview__hosts-back">
          <button
            type="button"
            className="sshview__hosts-back-btn"
            aria-label={t('app.sshView.hosts.backAria')}
            title={t('app.sshView.hosts.backTitle')}
            onClick={onBack}
          >
            <ChevronLeft size={14} aria-hidden />
            {t('app.sshView.hosts.back')}
          </button>
        </div>
      )}
      <div className="sshview__hosts-head">
        <span className="sshview__hosts-title">{t('app.sshView.hosts.title')}</span>
        <button
          type="button"
          className="sshview__hosts-add"
          onClick={openCreate}
          disabled={saving}
        >
          <Plus size={12} aria-hidden />
          {t('app.sshView.hosts.add')}
        </button>
      </div>

      {error && editingId === undefined && (
        <div className="sshview__error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void loadHosts()}>{t('app.sshView.hosts.errorRetry')}</button>
        </div>
      )}

      {editingId !== undefined && (
        <form className="sshview__form" onSubmit={(event) => void handleSubmit(event)}>
          {(formError ?? error) && (
            <div className="sshview__error" role="alert">
              <span>{formError ?? error}</span>
            </div>
          )}
          <label className="sshview__form-field">
            <span>{t('app.sshView.hosts.form.name')}</span>
            <input
              value={form.name}
              placeholder={t('app.sshView.hosts.form.namePlaceholder')}
              autoFocus
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="sshview__form-field">
            <span>{t('app.sshView.hosts.form.hostname')}</span>
            <input
              value={form.hostname}
              placeholder={t('app.sshView.hosts.form.hostnamePlaceholder')}
              onChange={(event) => setForm((current) => ({ ...current, hostname: event.target.value }))}
            />
          </label>
          <div className="sshview__form-row">
            <label className="sshview__form-field">
              <span>{t('app.sshView.hosts.form.port')}</span>
              <input
                value={form.port}
                inputMode="numeric"
                onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))}
              />
            </label>
            <label className="sshview__form-field">
              <span>{t('app.sshView.hosts.form.username')}</span>
              <input
                value={form.username}
                placeholder={t('app.sshView.hosts.form.usernamePlaceholder')}
                onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
              />
            </label>
          </div>
          <label className="sshview__form-field">
            <span>{t('app.sshView.hosts.form.password')}</span>
            <input
              type="password"
              value={form.password}
              placeholder={
                editingId && hosts.find((entry) => entry.id === editingId)?.secretId
                  ? t('app.sshView.hosts.form.passwordKept')
                  : t('app.sshView.hosts.form.passwordOnConnect')
              }
              autoComplete="off"
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            />
          </label>
          <label className="sshview__form-field">
            <span>{t('app.sshView.hosts.form.privateKey')}</span>
            <input
              value={form.privateKeyPath}
              placeholder={t('app.sshView.hosts.form.privateKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) =>
                setForm((current) => ({ ...current, privateKeyPath: event.target.value }))
              }
            />
          </label>
          {editingId && hosts.find((entry) => entry.id === editingId)?.secretId && (
            <label className="sshview__form-clear">
              <input
                type="checkbox"
                checked={form.clearPassword}
                onChange={(event) =>
                  setForm((current) => ({ ...current, clearPassword: event.target.checked }))
                }
              />
              <span>{t('app.sshView.hosts.form.clearPassword')}</span>
            </label>
          )}
          <div className="sshview__form-actions">
            <button type="button" className="sshview__form-cancel" onClick={closeForm}>
              {t('app.sshView.hosts.form.cancel')}
            </button>
            <button type="submit" className="sshview__form-submit" disabled={saving}>
              {saving ? t('app.sshView.hosts.form.submitting') : t('app.sshView.hosts.form.submit')}
            </button>
          </div>
        </form>
      )}

      {listStatus === 'idle' || listStatus === 'loading' ? (
        <div className="sshview__hint">{t('app.sshView.hosts.loading')}</div>
      ) : (
        hosts.length === 0
        && editingId === undefined && (
          <div className="sshview__empty">
            <Server size={34} strokeWidth={1.5} />
            <div className="sshview__empty-title">{t('app.sshView.hosts.empty.title')}</div>
            <div className="sshview__empty-hint">{t('app.sshView.hosts.empty.hint')}</div>
          </div>
        )
      )}

      {hosts.length > 0 && (
        <ul className="sshview__hosts-list">
          {hosts.map((host) => {
            const phase = sessions[host.id]
            return (
              <li key={host.id} className="sshview__host-row">
                <button
                  type="button"
                  className="sshview__host-open"
                  aria-label={t('app.sshView.hosts.row.openAria', { name: host.name })}
                  title={t('app.sshView.hosts.row.openTitle', { name: host.name })}
                  onClick={() => setActiveHostId(host.id)}
                >
                  <span className="sshview__host-name">{host.name}</span>
                  <span className="sshview__host-addr">
                    {host.username}@{host.hostname}:{host.port}
                  </span>
                </button>
                <span
                  className={`sshview__host-status${
                    phase === 'connected'
                      ? ' sshview__host-status--connected'
                      : phase === 'connecting'
                        ? ' sshview__host-status--connecting'
                        : phase === 'failed'
                          ? ' sshview__host-status--failed'
                          : ''
                  }`}
                >
                  {phase === 'connected'
                    ? t('app.sshView.hosts.status.connected')
                    : phase === 'connecting'
                      ? t('app.sshView.hosts.status.connecting')
                      : phase === 'failed'
                        ? t('app.sshView.hosts.status.failed')
                        : t('app.sshView.hosts.status.idle')}
                </span>
                <button
                  type="button"
                  className="sshview__host-action"
                  aria-label={t('app.sshView.hosts.row.editAria', { name: host.name })}
                  onClick={() => openEdit(host)}
                >
                  <Pencil size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  className="sshview__host-action sshview__host-action--danger"
                  aria-label={t('app.sshView.hosts.row.deleteAria', { name: host.name })}
                  onClick={() => void handleDelete(host)}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="sshview__hosts-footer">
        <span className="sshview__hosts-count">{t('app.sshView.hosts.footer.count', { count: hosts.length })}</span>
      </div>
    </section>
  )
}
