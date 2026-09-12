import { create } from 'zustand'
import {
  onSshSessionEvent,
  onSshUploadEvent,
  sshCommand,
  type RemoteDirEntry,
  type SshHostDraft,
  type SshHostEntry,
} from '@/platform/sshSession'

/**
 * SSH 主机与会话状态（P0 主机 CRUD 投影 + P1 会话状态投影）。
 *
 * 主机数据权威在 Rust 注册表（~/.axiom/ssh/hosts.json），store 只持有命令
 * 回传的全量列表——CRUD 成功后整体替换，避免本地 diff 漂移。会话权威在
 * Rust 进程托管（SshSessionState），store 投影 per-host 连接状态：openSession
 * ack → connecting，首包数据 → connected，done 事件 → closed。事件订阅由
 * `ensureSshEvents` 惰性启动一次（面板 useEffect 调用），错误由面板展示
 * （非 Tauri 环境下命令失败是常态，面板以错误态呈现并保留空列表）。
 */

export type SshSessionPhase = 'connecting' | 'connected' | 'closed' | 'failed'

/** 进行中的上传投影（done 即清除；failed 保留 error 供页脚展示）。 */
export interface SshUploadProjection {
  name: string
  transferred: number
  total: number
  error?: string
}

interface SshStoreState {
  hosts: SshHostEntry[]
  /** 主机列表加载态：idle 未加载过 / loading / ready / error。 */
  listStatus: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** per-host 会话投影（hostId → 阶段）；缺省 = 无会话记录（未连接）。 */
  sessions: Record<string, SshSessionPhase>
  /** per-host 上传投影（hostId → 进度）；done 即清除。 */
  uploads: Record<string, SshUploadProjection>
  /** 用户主动断开的主机集合：done 事件据此区分「主动断开」与「意外掉线」。 */
  userClosedHosts: Record<string, true>
  /** 意外掉线的主机（页脚据此展示「重连」入口）。 */
  unexpectedCloses: Record<string, true>
  /** 终端面板当前选中的主机（HostBar 值；主机行点击时同步设置）。 */
  activeHostId: string | null
  /**
   * per-host 最近一次成功列目录的结果（SFTP 文件浏览器投影）。
   * 带所属路径标签：失败/导航中时面板据此判断缓存是否匹配当前路径——
   * 不匹配一律不渲染，杜绝「A 目录的列表挂在 B 路径下」的陈旧内容
   * （曾导致列目录静默失败后界面停留在空/错列表，看起来像按钮失灵）。
   */
  dirs: Record<string, { path: string; entries: RemoteDirEntry[] }>
  /** per-host 当前浏览的远程路径（SFTP 面板定位）。 */
  currentDir: Record<string, string>
  /** per-host 目录列表加载态（SFTP 面板头部 spinner）。 */
  dirsLoading: Record<string, boolean>
  /** per-host 最近一次列目录失败原因（SFTP 面板错误行；成功即清除）。 */
  dirError: Record<string, string | null>
  loadHosts: () => Promise<void>
  saveHost: (draft: SshHostDraft, id?: string | null) => Promise<void>
  deleteHost: (id: string) => Promise<void>
  setActiveHostId: (hostId: string | null) => void
  refreshSessions: () => Promise<void>
  uploadFile: (hostId: string, remoteDir: string) => Promise<void>
  loadDir: (hostId: string, path: string) => Promise<void>
  makeDir: (hostId: string, path: string) => Promise<void>
  uploadFolder: (hostId: string, remoteDir: string) => Promise<void>
  setCurrentDir: (hostId: string, path: string) => void
  openSession: (hostId: string, cols: number, rows: number) => Promise<void>
  writeSession: (hostId: string, data: string) => Promise<void>
  resizeSession: (hostId: string, cols: number, rows: number) => Promise<void>
  closeSession: (hostId: string) => Promise<void>
  cancelUpload: (hostId: string) => Promise<void>
  resumeUpload: (hostId: string) => Promise<void>
  markSessionConnecting: (hostId: string) => void
  markSessionConnected: (hostId: string) => void
  markSessionClosed: (hostId: string) => void
  handleSessionDone: (hostId: string, exitCode?: number | null) => void
  clearUnexpectedClose: (hostId: string) => void
  markUploadStart: (hostId: string, name: string, total: number) => void
  markUploadProgress: (hostId: string, transferred: number) => void
  markUploadDone: (hostId: string) => void
  markUploadFailed: (hostId: string, error: string) => void
  /** 上传终态后刷新当前浏览目录（新文件/文件夹立即可见）。 */
  refreshDirAfterUpload: (hostId: string) => void
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const useSshStore = create<SshStoreState>((set, get) => ({
  hosts: [],
  listStatus: 'idle',
  error: null,
  sessions: {},
  uploads: {},
  userClosedHosts: {},
  unexpectedCloses: {},
  activeHostId: null,
  dirs: {},
  currentDir: {},
  dirsLoading: {},
  dirError: {},

  loadHosts: async () => {
    set({ listStatus: 'loading', error: null })
    try {
      const response = await sshCommand({ action: 'listHosts' })
      if (response.type !== 'hosts') throw new Error('SSH 主机列表响应类型不符合预期')
      set({ hosts: response.hosts, listStatus: 'ready' })
    } catch (error) {
      set({ listStatus: 'error', error: toErrorMessage(error) })
    }
  },

  saveHost: async (draft, id = null) => {
    try {
      const response = await sshCommand({ action: 'saveHost', id, ...draft })
      if (response.type !== 'hosts') throw new Error('SSH 主机保存响应类型不符合预期')
      set({ hosts: response.hosts, error: null, listStatus: 'ready' })
    } catch (error) {
      set({ error: toErrorMessage(error) })
      throw error
    }
  },

  deleteHost: async (id) => {
    try {
      const response = await sshCommand({ action: 'deleteHost', id })
      if (response.type !== 'hosts') throw new Error('SSH 主机删除响应类型不符合预期')
      set((state) => {
        // 删除主机同时清掉其会话投影与活动选中，避免悬空引用。
        const sessions = { ...state.sessions }
        delete sessions[id]
        return {
          hosts: response.hosts,
          sessions,
          activeHostId: state.activeHostId === id ? null : state.activeHostId,
          error: null,
          listStatus: 'ready',
        }
      })
    } catch (error) {
      set({ error: toErrorMessage(error) })
      throw error
    }
  },

  setActiveHostId: (activeHostId) => set({ activeHostId }),

  refreshSessions: async () => {
    try {
      const response = await sshCommand({ action: 'listSessions' })
      if (response.type !== 'sessions') return
      // 合并非覆盖：活跃会话置 connected，其余保留既有投影（连接失败/未连接
      // 是设计稿主机行的常态展示，不应被轮询清空——与侧栏「已连接」口径一致）。
      const sessions: Record<string, SshSessionPhase> = { ...get().sessions }
      for (const session of response.sessions) {
        sessions[session.hostId] = 'connected'
      }
      set({ sessions })
    } catch {
      // 非 Tauri 环境/通道失败时保持现有投影不变。
    }
  },

  uploadFile: async (hostId, remoteDir) => {
    // 触发即返回：上传生命周期（start/progress/done/failed）由事件驱动投影。
    const response = await sshCommand({ action: 'uploadFile', hostId, remoteDir })
    if (response.type !== 'ack') throw new Error('SSH 上传响应类型不符合预期')
  },

  loadDir: async (hostId, path) => {
    set((state) => ({ dirsLoading: { ...state.dirsLoading, [hostId]: true } }))
    try {
      const response = await sshCommand({ action: 'listFiles', hostId, path })
      if (response.type !== 'files') throw new Error('SSH 目录列表响应类型不符合预期')
      set((state) => ({
        dirs: { ...state.dirs, [hostId]: { path: response.path, entries: response.entries } },
        currentDir: { ...state.currentDir, [hostId]: response.path },
        dirError: { ...state.dirError, [hostId]: null },
        error: null,
      }))
    } catch (error) {
      // 失败不清 dirs：面板按缓存路径标签判断不匹配即不渲染（渲染层负责
      // 把 dirError 显示为错误行 + 重试，而非静默停留旧内容）。
      set((state) => ({ dirError: { ...state.dirError, [hostId]: toErrorMessage(error) } }))
    } finally {
      set((state) => ({ dirsLoading: { ...state.dirsLoading, [hostId]: false } }))
    }
  },

  makeDir: async (hostId, path) => {
    try {
      await sshCommand({ action: 'makeDir', hostId, path })
      set({ error: null })
    } catch (error) {
      set({ error: toErrorMessage(error) })
      throw error
    }
  },

  uploadFolder: async (hostId, remoteDir) => {
    // 触发即返回：目录上传与单文件同走事件投影（逐文件 Start/Progress/Done）。
    const response = await sshCommand({ action: 'uploadFolder', hostId, remoteDir })
    if (response.type !== 'ack') throw new Error('SSH 目录上传响应类型不符合预期')
  },

  setCurrentDir: (hostId, path) =>
    set((state) => ({ currentDir: { ...state.currentDir, [hostId]: path } })),

  openSession: async (hostId, cols, rows) => {
    set((state) => ({ sessions: { ...state.sessions, [hostId]: 'connecting' } }))
    try {
      const response = await sshCommand({ action: 'openSession', hostId, cols, rows })
      if (response.type !== 'ack') throw new Error('SSH 连接响应类型不符合预期')
    } catch (error) {
      // 打开失败：投影回落为 failed（主机行「连接失败」态），错误文案进终端
      // 面板显示（store.error 不覆盖主机 CRUD 错误通道）。
      set((state) => ({ sessions: { ...state.sessions, [hostId]: 'failed' } }))
      throw error
    }
  },

  writeSession: async (hostId, data) => {
    await sshCommand({ action: 'writeSession', hostId, data })
  },

  resizeSession: async (hostId, cols, rows) => {
    await sshCommand({ action: 'resizeSession', hostId, cols, rows })
  },

  closeSession: async (hostId) => {
    // 断开是 best-effort：会话可能已自行退出（命令层报「未激活」），一律视为
    // 成功——状态回落由 finally 与 Rust done 事件共同保证。
    set((state) => ({ userClosedHosts: { ...state.userClosedHosts, [hostId]: true } }))
    try {
      await sshCommand({ action: 'closeSession', hostId })
    } catch {
      // 忽略命令层错误
    } finally {
      set((state) => ({ sessions: { ...state.sessions, [hostId]: 'closed' } }))
    }
  },

  cancelUpload: async (hostId) => {
    try {
      await sshCommand({ action: 'cancelUpload', hostId })
    } catch {
      // 取消是 best-effort：传输线程的 cancelled 事件会跟进收尾。
    }
  },

  resumeUpload: async (hostId) => {
    await sshCommand({ action: 'resumeUpload', hostId })
  },

  markSessionConnecting: (hostId) =>
    set((state) => ({ sessions: { ...state.sessions, [hostId]: 'connecting' } })),

  markSessionConnected: (hostId) => {
    // 仅 connecting → connected 单向转换：closed 不被迟到数据事件复活，
    // 无会话记录（undefined）不凭空创建投影。
    if (get().sessions[hostId] !== 'connecting') return
    set((state) => ({ sessions: { ...state.sessions, [hostId]: 'connected' } }))
  },

  markSessionClosed: (hostId) => {
    // failed 是终态：迟到的 done 事件不得把「连接失败」改写回已断开。
    const current = get().sessions[hostId]
    if (current === 'closed' || current === 'failed' || current === undefined) return
    set((state) => ({ sessions: { ...state.sessions, [hostId]: 'closed' } }))
  },

  /**
   * done 事件统一入口：用户主动断开 → 平静回落；从未连上就退出（认证失败 /
   * 主机拒绝 / 网络不可达，ssh 进程以非零码快速退出）→「连接失败」；连接过
   * 的会话退出视为意外掉线，页脚展示「重连」入口（openSession 成功时同步清除）。
   */
  handleSessionDone: (hostId, exitCode = null) => {
    const { userClosedHosts } = get()
    const userClosed = Boolean(userClosedHosts[hostId])
    if (userClosed) {
      set((state) => {
        const next = { ...state.userClosedHosts }
        delete next[hostId]
        return { userClosedHosts: next }
      })
      get().markSessionClosed(hostId)
      return
    }
    const phase = get().sessions[hostId]
    if (phase === 'connecting' && exitCode != null && exitCode !== 0) {
      set((state) => ({ sessions: { ...state.sessions, [hostId]: 'failed' } }))
      return
    }
    if (phase === 'connected' || phase === 'connecting') {
      set((state) => ({ unexpectedCloses: { ...state.unexpectedCloses, [hostId]: true } }))
    }
    get().markSessionClosed(hostId)
  },

  clearUnexpectedClose: (hostId) =>
    set((state) => {
      if (!state.unexpectedCloses[hostId]) return state
      const unexpectedCloses = { ...state.unexpectedCloses }
      delete unexpectedCloses[hostId]
      return { unexpectedCloses }
    }),

  markUploadStart: (hostId, name, total) =>
    set((state) => ({
      uploads: { ...state.uploads, [hostId]: { name, transferred: 0, total } },
    })),

  markUploadProgress: (hostId, transferred) =>
    set((state) => {
      const current = state.uploads[hostId]
      if (!current) return state
      return {
        uploads: { ...state.uploads, [hostId]: { ...current, transferred } },
      }
    }),

  markUploadDone: (hostId) =>
    set((state) => {
      if (!state.uploads[hostId]) return state
      const uploads = { ...state.uploads }
      delete uploads[hostId]
      return { uploads }
    }),

  markUploadFailed: (hostId, error) =>
    set((state) => {
      const current = state.uploads[hostId]
      if (!current) return state
      return {
        uploads: { ...state.uploads, [hostId]: { ...current, error } },
      }
    }),

  /**
   * 上传终态（完成/失败/取消）后刷新当前浏览目录：完成让新文件/文件夹立即
   * 可见；失败/取消时先前文件可能已部分落盘（文件夹上传在第 N 个文件失败），
   * 列表同样要如实反映。从未浏览过的主机没有列表可刷新，跳过。
   */
  refreshDirAfterUpload: (hostId) => {
    const dir = get().currentDir[hostId]
    if (!dir) return
    void get().loadDir(hostId, dir)
  },
}))

/** 会话/上传事件订阅单例：驱动 sessions 投影的完整状态机（首包数据 →
 * connected，done → handleSessionDone 区分主动断开/意外掉线）与上传投影
 * （终态刷新当前浏览目录，新文件立即可见）；终端字节流的渲染由终端组件
 * 自订阅（本单例不搬数据，避免双份解码）。 */
let eventsEnsured = false
export const ensureSshEvents = (): (() => void) | undefined => {
  if (eventsEnsured) return undefined
  eventsEnsured = true
  void onSshSessionEvent((event) => {
    const store = useSshStore.getState()
    // 首包数据即视为握手完成（connecting → connected）；上传按钮与状态列
    // 都依赖该转换，缺了会永远停在「连接中」。
    if (event.data) store.markSessionConnected(event.hostId)
    if (event.done) store.handleSessionDone(event.hostId, event.exitCode ?? null)
  }).catch(() => {
    // 非 Tauri 环境订阅失败：保留未订阅状态，下次调用重试。
    eventsEnsured = false
  })
  void onSshUploadEvent((event) => {
    const store = useSshStore.getState()
    switch (event.phase) {
      case 'start':
        store.markUploadStart(event.hostId, event.name, event.totalBytes)
        break
      case 'progress':
        store.markUploadProgress(event.hostId, event.transferredBytes)
        break
      case 'done':
        store.markUploadDone(event.hostId)
        store.refreshDirAfterUpload(event.hostId)
        break
      case 'cancelled':
        // 取消后 Rust 侧保留续传材料；投影标记错误文案引导用户续传。
        store.markUploadFailed(event.hostId, '已取消，可续传')
        store.refreshDirAfterUpload(event.hostId)
        break
      case 'failed':
        store.markUploadFailed(event.hostId, event.error)
        store.refreshDirAfterUpload(event.hostId)
        break
    }
  }).catch(() => {
    eventsEnsured = false
  })
  return undefined
}

/** 创建时的状态快照（含原始 actions）：测试注入 mock action 后可完整还原。 */
const INITIAL_STATE_SNAPSHOT = useSshStore.getState()

/** 测试专用：复位事件订阅单例，让下一段 ensureSshEvents 重新注册。 */
export const resetSshEventsForTests = (): void => {
  eventsEnsured = false
}

/** 测试专用：把 store 复位到未加载态并还原原始 actions（见各 *.test.ts）。 */
export const resetSshStoreForTests = (): void => {
  useSshStore.setState({
    ...INITIAL_STATE_SNAPSHOT,
    hosts: [],
    listStatus: 'idle',
    error: null,
    sessions: {},
    uploads: {},
    userClosedHosts: {},
    unexpectedCloses: {},
    activeHostId: null,
  dirs: {},
  currentDir: {},
  dirsLoading: {},
  dirError: {},
  })
}
