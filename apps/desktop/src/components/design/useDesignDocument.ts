/**
 * 单个设计稿（`.pen` 或 `.ax`）的加载/订阅（DesignView 单稿画布与对比视图共用）。
 *
 * 职责：读取（带 known_sha256 轮询短路）、notify 事件驱动 + 10s 慢轮询兜底、
 * 迟到响应守卫、内容换代时清理图片资产缓存。每调用一次对应一个文件的订阅，
 * 对比视图按列各挂一个实例——订阅生命周期与列的挂载/卸载对齐。
 * 画布编辑（§11 无限画布）额外消费 rawJson（原始 JSON 文本，供补丁式写回）
 * 与 markWritten（本地写盘成功后同步 sha256，轮询短路 + 防自回声重采纳）。
 *
 * `.ax`（Axiom 自有格式，docs/ax-format.md）走同一订阅链，三处差别：
 * 1. 解析经 `parseAxDocument` 严格校验后投影为 `PenDocument`（复用画布渲染器）；
 * 2. **不返回 rawJson**——`.ax` 的作者是 LLM，画布是评审面，不接入手工编辑层，
 *    因此这里不提供补丁写回所需原文（结构上杜绝 `.ax` 被手势通道改写）；
 * 3. 校验失败给带节点路径的诊断清单（fail-closed，错稿不进画布）。
 *
 * 4. **编辑期坏稿暂缓（last-good hold）**：作者是 LLM，多补丁写稿的中间态在盘上
 *    就是非法的——每次落盘都触发重读，若把每个中间态的校验错误立即铺满画布，
 *    用户看到的是编辑过程里不停闪烁的红色报错。因此坏稿按信号暂缓：`authorActive`
 *    （任一会话在运行，见 `useAuthorActive`）期间保持上一版合法渲染、错误挂起，
 *    作者收笔即呈现（那才是评审面该看见的最终态）；无作者在写时只给一个短暂
 *    静默窗（外部编辑的连发保存不闪错），窗停仍坏才呈现。合法中间态不受影响，
 *    依旧实时上画布。挂起的错误不丢弃——暂缓的是「呈现时机」，不是校验本身。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PenDocument } from '@/agent/design/penParser'
import { useAgentStore } from '@/stores/agentStore'
import {
  onDesignDocumentChanged,
  readDesignDocument,
  unwatchDesignDocument,
  watchDesignDocument,
  writeDesignDocument,
} from '@/platform/designDocument'
import { decodeBase64ToBytes, encodeUtf8ToBase64 } from '@/platform/base64'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import { useT } from '@/i18n'
import { parsePenDocumentAsync } from './penParseAsync'
import { invalidatePenAssetCache } from './penImageFill'

/** `.ax` 扩展名判定（大小写不敏感）。 */
export const isAxPath = (path: string): boolean => /\.ax$/i.test(path)

/**
 * `.ax` 校验失败时的展示文本：带节点路径逐条列出，模型与用户都据此定位。
 * 首行给出总数，避免长列表把关键信息挤到看不见。
 */
const formatAxErrors = (diagnostics: { level: string; message: string; path?: string }[]): string => {
  const errors = diagnostics.filter((item) => item.level === 'error')
  if (errors.length === 0) return '.ax 校验失败'
  const lines = errors.slice(0, 20).map((item) => `- ${item.path ?? '?'}: ${item.message}`)
  if (errors.length > lines.length) lines.push(`- …（共 ${errors.length} 处）`)
  return [`.ax 校验失败（${errors.length} 处）：`, ...lines].join('\n')
}

/** 慢轮询兜底：事件丢失（挂起/missed notify）时的自愈频率，常态被 sha 短路吃掉。 */
export const POLL_INTERVAL_MS = 10_000
/** 变更事件防抖：一次保存可能产生多个 notify 事件，聚合为一次重读。 */
export const CHANGE_DEBOUNCE_MS = 120
/**
 * 非编辑期坏稿的静默窗：外部编辑（IDE/pen.dev 手改）也可能短暂写出坏稿，
 * 连发保存期间不闪错误；窗停内容仍坏才呈现。
 */
export const TRANSIENT_ERROR_SETTLE_MS = 4_000

export interface UseDesignDocumentOptions {
  /**
   * 作者可能正在写稿（任一会话运行中，`useAuthorActive`）。true 期间坏稿一律
   * 暂缓呈现（保持上一版合法渲染），收笔（false 翻转）时挂起的坏稿立即呈现。
   */
  authorActive?: boolean
}

export interface LoadedDesignDocument {
  path: string
  document: PenDocument | null
  /** 服务器返回的原始 JSON 文本（与 document 同源）；读取失败时为 null。 */
  rawJson: string | null
  parseError: string | null
  sha256: string
  syncedAt: number
  /** 读取通道失败（不存在/超限/未授权）；与 parseError 区分：未拿到内容 vs 内容坏。 */
  loadError: string | null
}

/** 整页删除的结果：失败时 message 已是可直接展示的文本。 */
export interface DesignPageDeletionResult {
  ok: boolean
  message: string | null
}

export interface DesignDocumentSubscription {
  loaded: LoadedDesignDocument | null
  /**
   * 存在被暂缓的坏稿（画布此刻显示的是上一版合法内容或加载态）。
   * 状态栏据此给中性提示（非报错样式）；作者收笔或静默窗到期后归零。
   */
  holding: boolean
  /** 挂起坏稿的错误文本（供提示的 hover 查看原因；未挂起时为 null）。 */
  heldError: string | null
  /**
   * 本地写盘成功后同步新 sha256（不重读文件）：下一次轮询被 known_sha256
   * 短路，且画布以 sha 判定「外部变更」时不会把自己的写回误判为他改。
   */
  markWritten: (sha256: string) => void
  /** 立即重读（画布写盘失败/CAS 冲突时从磁盘收回权威内容）。 */
  reload: () => void
  /**
   * 整页删除（`.ax` 评审面唯一的写操作，docs/design-canvas.md 第十六轮）：
   * 读盘权威内容 → 摘除该页（保序最小 diff）→ 本地过 `.ax` 校验（fail-closed，
   * 手势通道也不落坏稿）→ CAS 写回 → 本地采纳新投影（不等 watch 回声）。
   * `.pen` 的删除走画布编辑层（raw 补丁 + undo），不经此通道。
   */
  deletePage: (pageId: string) => Promise<DesignPageDeletionResult>
}

/**
 * 任一会话在运行（作者可能正在写设计稿）：编辑期坏稿暂缓的信号源。
 * 取「任一」而非「激活会话」——侧栏快捷发送的后台会话同样可能改这份稿。
 */
export const useAuthorActive = (): boolean =>
  useAgentStore((state) => state.sessions.some((session) => session.status === 'running'))

const decodeContent = (base64: string): string => {
  const bytes = decodeBase64ToBytes(base64)
  return new TextDecoder('utf-8').decode(bytes)
}

export const useDesignDocument = (
  path: string | null,
  options: UseDesignDocumentOptions = {},
): DesignDocumentSubscription => {
  const { t } = useT()
  const [loaded, setLoaded] = useState<LoadedDesignDocument | null>(null)
  const loadedRef = useRef<LoadedDesignDocument | null>(null)
  loadedRef.current = loaded
  // 加载序号：迟到响应（切换文件/连发轮询）不再覆盖更新的结果。
  const loadTokenRef = useRef(0)
  // 编辑期坏稿暂缓（文件头注 4）：lastGood 是最近一次采纳的合法内容（坏稿呈现后
  // 仍保留，作者下一轮再写坏时画布能退回上一版）；held 是待呈现的坏稿。
  const lastGoodRef = useRef<LoadedDesignDocument | null>(null)
  const heldRef = useRef<LoadedDesignDocument | null>(null)
  const [holding, setHolding] = useState(false)
  const [heldError, setHeldError] = useState<string | null>(null)
  const settleTimerRef = useRef(0)
  const authorActiveRef = useRef(options.authorActive ?? false)
  authorActiveRef.current = options.authorActive ?? false

  const clearSettleTimer = useCallback(() => {
    window.clearTimeout(settleTimerRef.current)
  }, [])

  const surfaceHeld = useCallback(() => {
    clearSettleTimer()
    const held = heldRef.current
    if (!held) return
    heldRef.current = null
    setHolding(false)
    setHeldError(null)
    setLoaded(held)
  }, [clearSettleTimer])

  // 采纳一次读取结果：合法内容无条件实时上画布（编辑中间态只要合法就跟随）；
  // 坏稿按「作者是否在写 / 是否有上一版」决定立即呈现或暂缓（文件头注 4）。
  const adopt = useCallback(
    (payload: LoadedDesignDocument) => {
      if (payload.document !== null) {
        lastGoodRef.current = payload
        if (heldRef.current) {
          heldRef.current = null
          setHolding(false)
          setHeldError(null)
        }
        clearSettleTimer()
        setLoaded(payload)
        return
      }
      const editing = authorActiveRef.current
      const lastGood = lastGoodRef.current?.path === payload.path ? lastGoodRef.current : null
      if (!editing && !lastGood) {
        // 打开即坏稿且无作者在写：这是评审面必须看见的最终态，立即呈现（原行为）。
        setLoaded(payload)
        return
      }
      heldRef.current = payload
      setHolding(true)
      setHeldError(payload.parseError ?? payload.loadError)
      if (lastGood) {
        // 画布若停在上一轮呈现的坏稿上（作者又开始一轮新编辑），退回上一版合法
        // 内容；syncedAt 保持「刚对过盘」的语义（读是真实发生过的）。
        setLoaded({ ...lastGood, syncedAt: payload.syncedAt })
      }
      if (!editing) {
        // 无作者在写的坏稿（外部编辑抖动）：静默窗内不闪错误，窗停仍坏才呈现。
        clearSettleTimer()
        settleTimerRef.current = window.setTimeout(() => surfaceHeld(), TRANSIENT_ERROR_SETTLE_MS)
      }
    },
    [clearSettleTimer, surfaceHeld],
  )

  const markWritten = useCallback(
    (sha256: string) => {
      setLoaded((current) =>
        current ? { ...current, sha256, syncedAt: Date.now(), loadError: null } : current,
      )
    },
    [],
  )

  const load = useCallback(async (target: string): Promise<void> => {
    loadTokenRef.current += 1
    const token = loadTokenRef.current
    try {
      const known = loadedRef.current?.path === target ? loadedRef.current.sha256 : undefined
      const content = await readDesignDocument(target, known)
      if (loadTokenRef.current !== token) return
      if (content.unchanged) {
        // 轮询短路：sha256 一致，Rust 未回传内容，仅刷新同步时间。
        setLoaded((current) =>
          current && current.path === target
            ? { ...current, syncedAt: Date.now(), loadError: null }
            : current,
        )
        return
      }
      if (loadedRef.current?.path === target && loadedRef.current.sha256 === content.sha256) return
      // 内容换代：资产常与 .pen 同批改写，清掉图片填充缓存让新渲染重新取图。
      invalidatePenAssetCache()
      const rawText = decodeContent(content.contentBase64)
      // 空/空白设计稿先于解析器收口：解析器只会给出「JSON Parse error: Unexpected EOF」
      // 这类技术性错误（截图里的那条），对用户与模型都没有下一步动作可言。这里给一条
      // **可执行**提示（让助手生成骨架 / 删除后重扫），两种格式共用一条判定。
      if (rawText.trim().length === 0) {
        adopt({
          path: target,
          document: null,
          rawJson: null,
          parseError: t('app.design.emptyFile'),
          sha256: content.sha256,
          syncedAt: Date.now(),
          loadError: null,
        })
        return
      }
      // `.ax`：严格校验（fail-closed）后投影为画布视图模型；不保留原文（见文件头注 2）。
      if (isAxPath(target)) {
        const parsed = parseAxDocument(rawText)
        if (loadTokenRef.current !== token) return
        const projection = parsed.document
          ? projectAxToPenDocument(parsed.document, target).document
          : null
        adopt({
          path: target,
          document: projection,
          rawJson: null,
          parseError: parsed.error ?? (projection ? null : formatAxErrors(parsed.diagnostics)),
          sha256: content.sha256,
          syncedAt: Date.now(),
          loadError: null,
        })
        return
      }
      // 解析可能在大文档下异步（worker）；期间序号变化则丢弃本次结果。
      const parsed = await parsePenDocumentAsync(rawText, target)
      if (loadTokenRef.current !== token) return
      adopt({
        path: target,
        document: parsed.document,
        rawJson: rawText,
        parseError: parsed.error,
        sha256: content.sha256,
        syncedAt: Date.now(),
        loadError: null,
      })
    } catch (error) {
      if (loadTokenRef.current !== token) return
      const message = error instanceof Error ? error.message : String(error)
      // 失败也要落一条（哪怕之前没成功过）：否则列/画布只剩空态，错误无从可见。
      setLoaded((current) =>
        current && current.path === target
          ? { ...current, loadError: message }
          : {
              path: target,
              document: null,
              rawJson: null,
              parseError: null,
              sha256: '',
              syncedAt: Date.now(),
              loadError: message,
            },
      )
    }
  }, [adopt, t])

  useEffect(() => {
    if (!path) {
      setLoaded(null)
      return undefined
    }
    // 换文件先清空：旧内容挂在新文件名下会误导（对比列各自独立，无跨列残留）。
    // 挂起/上一版同样按文件归属，跨文件一律作废。
    clearSettleTimer()
    lastGoodRef.current = null
    heldRef.current = null
    setHolding(false)
    setHeldError(null)
    setLoaded(null)
    void load(path)
    // 事件驱动为主：watch 当前文件，变更事件防抖后重读；轮询降为慢速兜底。
    // watcher 注册失败（如平台事件不可用）仅影响实时性，轮询仍会兜住。
    void watchDesignDocument(path).catch(() => undefined)
    const timer = window.setInterval(() => void load(path), POLL_INTERVAL_MS)
    let debounceTimer = 0
    let cancelled = false
    const unlisten = onDesignDocumentChanged(({ path: changed }) => {
      if (changed !== path) return
      window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(() => {
        if (!cancelled) void load(path)
      }, CHANGE_DEBOUNCE_MS)
    })
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(debounceTimer)
      clearSettleTimer()
      void unlisten.then((dispose) => dispose())
      void unwatchDesignDocument(path).catch(() => undefined)
    }
  }, [path, load, clearSettleTimer])

  // 作者收笔（运行翻转）：挂起的坏稿就是这一轮的最终态，评审面必须看见；
  // 作者开写：撤掉静默窗——编辑期无论挂起多久都不落错误（由本效果收口呈现）。
  useEffect(() => {
    if (options.authorActive) {
      clearSettleTimer()
      return
    }
    surfaceHeld()
  }, [options.authorActive, clearSettleTimer, surfaceHeld])

  // 稳定身份：画布把它串进编辑回调的依赖里，避免每渲染重建订阅链。
  const reload = useCallback(() => {
    if (path) void load(path)
  }, [path, load])

  const deletePage = useCallback(
    async (pageId: string): Promise<DesignPageDeletionResult> => {
      const target = path
      const current = loadedRef.current
      const unavailable = t('app.design.canvas.deletePageUnavailable')
      if (!target || !current || current.path !== target || !isAxPath(target)) {
        return { ok: false, message: unavailable }
      }
      try {
        // 读盘权威内容（不带 known——删除始终需要完整字节）。CAS 预检：删除绑定
        // 「用户看到的那一版」，盘上比画布采纳的新（Agent/pen.dev 刚保存过）时
        // 旧快照不能盖上去——提示刷新重试，不静默覆盖。
        const baseline = await readDesignDocument(target)
        if (baseline.sha256 !== current.sha256) {
          return { ok: false, message: t('app.design.canvas.deletePageStale') }
        }
        const rawText = decodeContent(baseline.contentBase64)
        const raw: unknown = JSON.parse(rawText)
        const record = raw && typeof raw === 'object' ? (raw as { pages?: unknown }) : null
        const pages = Array.isArray(record?.pages) ? record.pages : null
        const index = pages
          ? pages.findIndex((page) =>
              typeof page === 'object' && page !== null && (page as { id?: unknown }).id === pageId,
            )
          : -1
        if (!pages || index < 0) return { ok: false, message: unavailable }
        pages.splice(index, 1)
        // 保序最小 diff：只摘除该页的行，键序/缩进/尾换行保持文件原样——页级
        // 手势不该把整份稿重排成规范序（git diff 应只剩「少了这一页」）。
        const source = `${JSON.stringify(raw, null, 2)}${rawText.endsWith('\n') ? '\n' : ''}`
        // fail-closed：手势通道同样不落坏稿——摘除后整稿过一遍 `.ax` 校验再写。
        const parsed = parseAxDocument(source)
        if (!parsed.document) {
          return { ok: false, message: parsed.error ?? formatAxErrors(parsed.diagnostics) }
        }
        const written = await writeDesignDocument(target, encodeUtf8ToBase64(source), current.sha256)
        // 本地采纳新投影：不等 watch 回声（写盘 sha 已同步，下一次轮询被短路）；
        // bump 加载序号作废在途读取，避免旧内容迟到覆盖删除结果。
        const projection = projectAxToPenDocument(parsed.document, target).document
        loadTokenRef.current += 1
        setLoaded({
          path: target,
          document: projection,
          rawJson: null,
          parseError: null,
          sha256: written.sha256,
          syncedAt: Date.now(),
          loadError: null,
        })
        return { ok: true, message: null }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message }
      }
    },
    [path, t],
  )

  return { loaded, holding, heldError, markWritten, reload, deletePage }
}
