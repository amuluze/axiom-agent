import type { AgentTool, AgentToolResult } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { parseAxDocument } from '@/agent/design/axParser'
import {
  designComponentInventory,
  type DesignComponentSummary,
} from '@/agent/design/componentInventoryHost'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_SCAN_THUMBNAIL_BYTES,
  MAX_IMAGE_MAX_BYTES,
  executeAxCodeMode,
  executeAxCompareMode,
  executeAxNodeMode,
  executeAxPageMode,
  executeAxReconcileMode,
  executeAxRenderMode,
  executeAxSummaryMode,
  executeComponentMode,
  executePenMode,
  executeScan,
  isAxFile,
  isDesignFile,
  type AxModeContext,
} from '@/agent/design/designQueryModes'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath, optionalInteger } from './workspaceToolUtils'

const DEFAULT_MAX_BYTES = 16384
const MAX_MAX_BYTES = 65536

/** base64 → UTF-8 文本（agent 层不依赖 platform/base64，浏览器/Node 双环境） */
const decodeBase64ToText = (base64: string): string => {
  const binary =
    typeof atob === 'function'
      ? atob(base64)
      : Buffer.from(base64, 'base64').toString('binary')
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

export interface DesignQueryOptions {
  /** 组件清单来源；缺省用宿主接缝（应用启动处注入的注册表摘要）。 */
  componentInventory?: () => DesignComponentSummary[]
}

export const createDesignQueryTool = (
  environment: AgentEnvironment,
  options: DesignQueryOptions = {},
): AgentTool => ({
  name: 'design_query',
  label: 'design_query',
  promptSnippet: '查询设计稿（.ax/.pen）的页面与子树；.ax 另返回「已解析的规格 + 组件清单」，无需整读文件。',
  promptGuidelines: [
    'file 为授权工作区相对路径（.ax 或 .pen）；page 传页名或 1 起始序号，nodeId 精确定位子树。',
    '不传 page/nodeId 时返回摘要（页清单 + 组件清单 + token 清单）——先看摘要再按页/子树取细节。',
    '.ax 的返回已解析：token 给出明暗两档字面值、组件给出真实源码路径与 props 契约；直接据此写实现，不必猜。',
    '写 component 节点前先用 mode=component 查该组件的详单（props 契约 + statics + fixture 数据形状）：json 型 props 的结构化 $mock 照 fixture 形状写，缺隐式前提（如 assistant 消息的 toolCalls）会在渲染期抛错。',
    '.ax 的组件节点会与组件注册表核对：组件不在注册表、props 键/必填/值型与契约不符都会在读取时报错（写稿当场暴露，不必等画布渲染红框）；按报错列出的可用项自修。',
    'mode=render 返回该页的 PNG（作为图像内容块）：写完设计稿后用它自查「画出来的和想要的是否一致」。',
    '当前模型不支持图片输入时，render/scan 会降级为文字说明（不产图片内容块，render 也不再光栅化）——这是模型能力所限，不是环境没有渲染能力。',
    'render 返回 available:false 只说明该次渲染失败（reason 给出解析/挂载/光栅化/预算的具体原因），不代表环境无渲染能力——按 reason 修复（如超预算调大 imageMaxBytes）后重试即可；不要把一次失败当成环境永久不可用而跳过视觉自查。',
    'mode=scan 逐页扫描整份稿（结构检查 + 逐页离屏渲染 + 空白检测），返回逐页判定与问题清单——多页改动或整稿完成后跑一遍，按 fail/warn 页的 issues 修复后重扫直到全绿。可选 tokensCss 传实现样式表路径（如 apps/desktop/src/styles/tokens.css），报告附带 token ↔ CSS 变量的一致性清单（建议性）。',
    'mode=code 返回该页的 TSX 骨架：组件节点是恒等映射（props 已校验），原语映射到 CSS 变量；unresolved 列出需要人工接线的部分，据此再补数据与交互。',
    'mode=reconcile 做「设计 ↔ 实现」结构对账（advisory）：传 implementation（实现文件或目录，workspace 相对）后双向 diff——missingInImplementation 是稿有实无（漏实现，按报告的页名补实现或改稿），extraInImplementation 是实有稿无（可据此反向把实现新用的组件补进设计稿）；实现落地后跑一遍验证还原完整度。报告 fileCapReached=true 时结论只覆盖已扫文件集：把 implementation 收窄到未覆盖的子目录分批重跑，不要据被截断的报告直接判定组件漏实现。',
    'mode=compare 做「设计页 ↔ 实现路由」的像素对拍（advisory）：先用 bash 起 dev server，再传 page + url，工具内部按设计页尺寸截屏并输出差异占比与 bounds。设计侧 WKWebView、实现侧隔离 Chromium 有字体光栅化基线噪声（文本页常见 1-3% 微差）——warn 时按 bounds 定位差异区域核对，再决定改稿还是改实现，不要追求 0% 差异。',
    'mode=scan 的 blank 判定有误报防御：页面树有文本节点时近乎空白降为 info（稀疏文本页常见形态，不影响全绿门禁）；收到 info 用 mode=render 单页渲染确认即可，不要当成待修复问题。',
    '按子树操作，不要用 read 整读设计稿；写坏 JSON 时再次调用本工具按 parse error 自修。',
  ],
  runtimeVersion: '9',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'design_query:invalid'
    const mode = typeof input.mode === 'string' ? input.mode : ''
    const file = typeof input.file === 'string' ? input.file : ''
    const page = typeof input.page === 'number' ? String(input.page) : typeof input.page === 'string' ? input.page : ''
    const nodeId = typeof input.nodeId === 'string' ? input.nodeId : ''
    const component = typeof input.component === 'string' ? input.component : ''
    // mode 进 key：同一 file+page 的 scan/render/page/component 结果形状不同，不能互为幂等回放。
    // reconcile 的 implementation（string | string[]）归一成排序拼接——同稿不同实现集是不同对账。
    const implementation = Array.isArray(input.implementation)
      ? input.implementation.filter((item): item is string => typeof item === 'string').sort().join('|')
      : typeof input.implementation === 'string' ? input.implementation : ''
    // compare 的 url/waitMs 同理进 key；条件追加保证既有 key 形状不变（回放兼容）。
    const url = typeof input.url === 'string' ? input.url : ''
    const waitMs = typeof input.waitMs === 'number' ? String(input.waitMs) : ''
    return `design_query:${file}:${mode}:${page}:${nodeId}:${component}:${implementation}`
      + `${url !== '' ? `:${url}` : ''}${waitMs !== '' ? `:${waitMs}` : ''}`
  },
  description:
    'Query a design document (.ax or .pen, workspace-relative) without reading the whole file. '
    + 'For .ax: summary returns pages plus the component inventory (name → real source path, props contract) and token list; '
    + 'page/node return the authored tree with tokens resolved to light/dark literals and the components used by that page; '
    + 'mode=component returns one component\'s full contract (props, statics, fixture data shapes) so structured $mock values can be authored without reading source; '
    + 'component nodes are cross-checked against the component registry at read time (unknown component/props/type mismatches fail here, not at canvas render). '
    + 'mode=render emits the page as a PNG image block for visual self-check; when the active model does not accept image input, render and scan degrade to text-only results (no image blocks, no rasterization) — that is a model-capability limit, not a missing renderer; '
    + 'mode=scan verifies every page renders (structure checks + offscreen render + blank detection, per-page verdicts and issue list; optional tokensCss adds a token ↔ CSS variable parity report); '
    + 'mode=code emits a TSX skeleton for the page (component nodes map 1:1, primitives map to CSS variables; unresolved items are listed); '
    + 'mode=reconcile cross-checks the design against implementation source files/directories (implementation argument): components in the .ax missing from the implementation are leaks, registry components used in code but absent from the .ax are design-out-of-sync leads (advisory); '
    + 'mode=compare pixel-diffs a design page against an implementation route (page + url, advisory): renders the design page, captures the route via the browser capability at the page\'s viewport, and reports the mismatch ratio with a bounding box (cross-engine font rasterization adds baseline noise; magnitude and bounds are the signal). '
    + 'For .pen: the resolved JSON subtree (legacy import format). Output is capped by the byte budget and truncation is always explicit. '
    + 'Parse failures return the parser diagnostics so the model can repair malformed JSON.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Workspace-relative design path (e.g. .pen/axiom.ax or .pen/axiom.pen). Optional only for mode=component.',
      },
      mode: {
        type: 'string',
        description: 'Optional for .ax: summary (pages + component inventory), page (fully resolved page spec), node, component (one component\'s contract detail), render (the page as a PNG image block for visual self-check), code (generated TSX skeleton), reconcile (design ↔ implementation structural cross-check; requires implementation), compare (pixel-level design ↔ implementation-route visual diff; requires page + url; needs the browser capability), or scan (per-page render verification: structure checks + offscreen render + blank detection with per-page verdicts). Inferred when omitted.',
      },
      implementation: {
        description: 'Implementation roots for mode=reconcile: a workspace-relative .ts/.tsx file, a directory (recursively collecting .ts/.tsx, skipping node_modules/dist etc.), or an array of either.',
      },
      url: {
        type: 'string',
        description: 'mode=compare 的实现路由 URL（http/https，含 localhost，至多 2048 字符）——dev server 起好后传页面路由，工具内部经浏览器能力按设计页尺寸截屏对拍。',
      },
      waitMs: {
        type: 'number',
        description: 'mode=compare 截屏前的等待毫秒数（1-15000，默认 800）——异步数据/动画页面酌情调大。',
      },
      component: {
        type: 'string',
        description: 'Component registry name for mode=component (see the inventory in summary).',
      },
      tokensCss: {
        type: 'string',
        description: 'Workspace-relative implementation stylesheet for mode=scan (e.g. apps/desktop/src/styles/tokens.css); adds an advisory token ↔ CSS variable parity report.',
      },
      imageMaxBytes: {
        type: 'number',
        description: `PNG budget for mode render (default ${DEFAULT_IMAGE_MAX_BYTES}) or per-thumbnail budget for mode scan (default ${DEFAULT_SCAN_THUMBNAIL_BYTES}); range 1024-${MAX_IMAGE_MAX_BYTES}.`,
      },
      page: {
        description: 'Page name or 1-based page index. Omit with nodeId to list pages.',
      },
      nodeId: {
        type: 'string',
        description: 'Node id to locate a subtree (searched across pages and reusable components).',
      },
      maxBytes: {
        type: 'number',
        description: `Output byte budget (1-${MAX_MAX_BYTES}), default ${DEFAULT_MAX_BYTES}.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input)
      || !hasOnlyKeys(input, ['file', 'page', 'nodeId', 'maxBytes', 'mode', 'imageMaxBytes', 'component', 'tokensCss', 'implementation', 'url', 'waitMs'])) {
      return { ok: false, error: 'Arguments must be an object with only file, page, nodeId, maxBytes, mode, imageMaxBytes, component, tokensCss, implementation, url, and waitMs.' }
    }
    if (input.mode !== undefined
      && input.mode !== 'summary' && input.mode !== 'page'
      && input.mode !== 'node' && input.mode !== 'render' && input.mode !== 'code'
      && input.mode !== 'scan' && input.mode !== 'component' && input.mode !== 'reconcile'
      && input.mode !== 'compare') {
      return { ok: false, error: 'mode must be summary, page, node, component, render, code, reconcile, compare, or scan.' }
    }
    // implementation 只属于 reconcile；reconcile 时必填（string 或非空 string 数组），
    // 且每项都是不带 .. 的 workspace 相对路径。
    if (input.implementation !== undefined && input.mode !== 'reconcile') {
      return { ok: false, error: 'implementation is only valid with mode=reconcile.' }
    }
    if (input.mode === 'reconcile') {
      const roots = Array.isArray(input.implementation)
        ? input.implementation
        : [input.implementation]
      if (roots.length === 0 || roots.some((item) => typeof item !== 'string' || !item.trim())) {
        return { ok: false, error: 'mode=reconcile requires implementation: a non-empty string or array of non-empty strings.' }
      }
      for (const root of roots) {
        if (typeof root !== 'string' || !isSafeRelativePath(root, true)) {
          return { ok: false, error: 'implementation entries must be workspace-relative paths without "..".' }
        }
      }
      if (!isAxFile(String(input.file ?? '')) || !isSafeRelativePath(String(input.file ?? ''), false)) {
        return { ok: false, error: 'mode=reconcile requires file to be a workspace-relative .ax document (the reconciliation works on the .ax component layer).' }
      }
      if (input.page !== undefined || input.nodeId !== undefined
        || input.imageMaxBytes !== undefined || input.tokensCss !== undefined || input.component !== undefined) {
        return { ok: false, error: 'mode=reconcile takes only file, implementation (and optionally maxBytes).' }
      }
      if (!optionalInteger(input.maxBytes, 1, MAX_MAX_BYTES)) {
        return { ok: false, error: `maxBytes must be an integer between 1 and ${MAX_MAX_BYTES}.` }
      }
      return { ok: true, value: input }
    }
    if (input.component !== undefined) {
      if (input.mode !== 'component') {
        return { ok: false, error: 'component is only valid with mode=component.' }
      }
      if (typeof input.component !== 'string' || !input.component.trim()) {
        return { ok: false, error: 'component must be a non-empty component name when mode=component.' }
      }
    }
    if (input.mode === 'component' && typeof input.component !== 'string') {
      return { ok: false, error: 'mode=component requires a component name.' }
    }
    if (input.tokensCss !== undefined) {
      if (input.mode !== 'scan') {
        return { ok: false, error: 'tokensCss is only valid with mode=scan.' }
      }
      if (typeof input.tokensCss !== 'string' || !isSafeRelativePath(input.tokensCss, false)) {
        return { ok: false, error: 'tokensCss must be a workspace-relative stylesheet path.' }
      }
    }
    // url/waitMs 只属于 compare；compare 需要 .ax 稿 + page + url，
    // 且不接受其余模式的专用参数。
    if (input.url !== undefined) {
      if (input.mode !== 'compare') {
        return { ok: false, error: 'url is only valid with mode=compare.' }
      }
      if (
        typeof input.url !== 'string'
        || !(input.url.startsWith('http://') || input.url.startsWith('https://'))
        || input.url.length > 2048
      ) {
        return { ok: false, error: 'url must be an http(s) URL of at most 2048 characters.' }
      }
    }
    if (input.waitMs !== undefined) {
      if (input.mode !== 'compare') {
        return { ok: false, error: 'waitMs is only valid with mode=compare.' }
      }
      if (!optionalInteger(input.waitMs, 1, 15000)) {
        return { ok: false, error: 'waitMs must be an integer between 1 and 15000.' }
      }
    }
    if (input.mode === 'compare') {
      if (typeof input.url !== 'string' || !input.url.trim()) {
        return { ok: false, error: 'mode=compare requires url (the implementation route to capture).' }
      }
      if (input.page === undefined) {
        return { ok: false, error: 'mode=compare requires a page (name or 1-based index).' }
      }
      if (!isAxFile(String(input.file ?? '')) || !isSafeRelativePath(String(input.file ?? ''), false)) {
        return { ok: false, error: 'mode=compare requires file to be a workspace-relative .ax document.' }
      }
      if (input.nodeId !== undefined || input.imageMaxBytes !== undefined || input.tokensCss !== undefined
        || input.implementation !== undefined || input.component !== undefined) {
        return { ok: false, error: 'mode=compare takes only file, page, url, waitMs (and optionally maxBytes).' }
      }
      if (!optionalInteger(input.maxBytes, 1, MAX_MAX_BYTES)) {
        return { ok: false, error: `maxBytes must be an integer between 1 and ${MAX_MAX_BYTES}.` }
      }
      return { ok: true, value: input }
    }
    // file 仅在 mode=component 下可省（组件契约与具体稿件无关）；其余模式必填。
    if (input.mode === 'component' && input.file === undefined) {
      if (input.page !== undefined || input.nodeId !== undefined || input.imageMaxBytes !== undefined) {
        return { ok: false, error: 'mode=component takes only component (and optionally maxBytes).' }
      }
      if (!optionalInteger(input.maxBytes, 1, MAX_MAX_BYTES)) {
        return { ok: false, error: `maxBytes must be an integer between 1 and ${MAX_MAX_BYTES}.` }
      }
      return { ok: true, value: input }
    }
    if (typeof input.file !== 'string' || !isDesignFile(input.file) || !isSafeRelativePath(input.file, false)) {
      return { ok: false, error: 'file must be a workspace-relative path ending in .ax or .pen.' }
    }
    if ((input.mode === 'render' || input.mode === 'code') && input.page === undefined) {
      return { ok: false, error: 'mode render/code requires a page (name or 1-based index).' }
    }
    if (!optionalInteger(input.imageMaxBytes, 1024, MAX_IMAGE_MAX_BYTES)) {
      return { ok: false, error: `imageMaxBytes must be an integer between 1024 and ${MAX_IMAGE_MAX_BYTES}.` }
    }
    if (
      input.page !== undefined
      && typeof input.page !== 'string'
      && !optionalInteger(input.page, 1, Number.MAX_SAFE_INTEGER)
    ) {
      return { ok: false, error: 'page must be a page name string or a 1-based integer index.' }
    }
    if (input.nodeId !== undefined && (typeof input.nodeId !== 'string' || !input.nodeId.trim())) {
      return { ok: false, error: 'nodeId must be a non-empty string when provided.' }
    }
    if (!optionalInteger(input.maxBytes, 1, MAX_MAX_BYTES)) {
      return { ok: false, error: `maxBytes must be an integer between 1 and ${MAX_MAX_BYTES}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input)) throw new Error('Invalid design_query arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const inventory = options.componentInventory?.() ?? designComponentInventory()
    const maxBytesForInput = typeof input.maxBytes === 'number' ? input.maxBytes : DEFAULT_MAX_BYTES

    // ── component：单组件契约详单（与具体稿件无关，file 可省）────────────────
    // 写 component 节点前查一次：props 契约 + statics + fixture 数据形状——
    // json 型 props 的结构化 $mock 照 fixture 形状写，不必读组件源码反推隐式前提。
    if (input.mode === 'component') {
      return executeComponentMode(
        typeof input.component === 'string' ? input.component : '',
        inventory,
        maxBytesForInput,
      )
    }

    if (typeof input.file !== 'string') throw new Error('Invalid design_query arguments.')
    const document = await environment.design.readDocument(input.file)
    const source = decodeBase64ToText(document.contentBase64)

    // ── scan：两种格式共用的逐页渲染验证（结构检查 + 离屏渲染 + 空白检测） ────
    if (input.mode === 'scan') {
      // 可选的实现样式表：读取失败不阻断扫描，报告里带原因（建议性核对不假装成功）。
      let tokensCss: { file: string; content: string } | { file: string; error: string } | undefined
      if (typeof input.tokensCss === 'string') {
        try {
          const css = await environment.workspace.readText(input.tokensCss)
          tokensCss = { file: input.tokensCss, content: css.content }
        } catch (error) {
          tokensCss = { file: input.tokensCss, error: error instanceof Error ? error.message : String(error) }
        }
      }
      return executeScan(source, {
        file: input.file,
        page: typeof input.page === 'number'
          ? input.page
          : typeof input.page === 'string' ? input.page : undefined,
        maxBytes: typeof input.maxBytes === 'number' ? input.maxBytes : undefined,
        imageMaxBytes: typeof input.imageMaxBytes === 'number' ? input.imageMaxBytes : undefined,
        modelAcceptsImage: context.modelAcceptsImage,
      }, document.sha256, {
        componentInventory: inventory,
        ...(tokensCss !== undefined ? { tokensCss } : {}),
      })
    }

    // ── `.ax`（自有格式）：三层读取 —— 摘要 / 页（已解析规格）/ 子树 ──────────
    if (isAxFile(input.file)) {
      // 注册表核对：有清单时传给解析器（组件名/props 键/必填/值型在读取时报错）。
      const parsed = parseAxDocument(source, inventory.length > 0 ? { componentInventory: inventory } : {})
      if (!parsed.document) {
        const detail = parsed.error
          ?? parsed.diagnostics
            .filter((item) => item.level === 'error')
            .map((item) => `- ${item.path ?? '?'}: ${item.message}`)
            .join('\n')
        return {
          content: `design_query: failed to validate ${input.file}:\n${detail}`,
          details: { file: input.file, sha256: document.sha256, parsed: false },
        }
      }
      const modeContext: AxModeContext = {
        file: input.file,
        sha256: document.sha256,
        source,
        axDoc: parsed.document,
        diagnostics: parsed.diagnostics,
        inventory,
        maxBytes: maxBytesForInput,
        modelAcceptsImage: context.modelAcceptsImage,
      }

      // mode 缺省推断：nodeId 优先（精确定位），其次 url（compare 的专属入参），
      // 再次 page，否则 summary。
      const mode = typeof input.mode === 'string'
        ? input.mode
        : input.nodeId !== undefined ? 'node'
        : input.url !== undefined ? 'compare'
        : input.page !== undefined ? 'page'
        : 'summary'

      if (mode === 'summary') return executeAxSummaryMode(modeContext)
      if (mode === 'render') {
        return executeAxRenderMode(modeContext, input.page as string | number, typeof input.imageMaxBytes === 'number' ? input.imageMaxBytes : undefined)
      }
      if (mode === 'code') return executeAxCodeMode(modeContext, input.page as string | number)
      if (mode === 'reconcile') {
        const roots = Array.isArray(input.implementation)
          ? input.implementation.filter((item): item is string => typeof item === 'string')
          : typeof input.implementation === 'string' ? [input.implementation] : []
        return executeAxReconcileMode(modeContext, environment, roots)
      }
      if (mode === 'compare') {
        return executeAxCompareMode(modeContext, environment, {
          page: input.page as string | number,
          url: typeof input.url === 'string' ? input.url : '',
          ...(typeof input.waitMs === 'number' ? { waitMs: input.waitMs } : {}),
        })
      }
      if (mode === 'node') {
        return executeAxNodeMode(modeContext, typeof input.nodeId === 'string' ? input.nodeId : '')
      }
      return executeAxPageMode(modeContext, input.page as string | number)
    }

    // ── `.pen`（导入源）：解析后的子树 JSON（legacy 读取口径） ─────────────────
    return executePenMode(
      { file: input.file, sha256: document.sha256, source },
      {
        page: typeof input.page === 'number' || typeof input.page === 'string' ? input.page : undefined,
        nodeId: typeof input.nodeId === 'string' ? input.nodeId : undefined,
        maxBytes: typeof input.maxBytes === 'number' ? input.maxBytes : undefined,
      },
    )
  },
})

export const designQueryTool = createDesignQueryTool(desktopAgentEnvironment)
