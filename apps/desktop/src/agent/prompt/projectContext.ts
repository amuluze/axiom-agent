import {
  AgentEnvironmentError,
  type AgentEnvironment,
} from '@/agent/environment/AgentEnvironment'

/**
 * AGENTS.md 注入的字节上限，对齐宿主单次 read 的输出字节上限
 * （Rust `MAX_READ_OUTPUT_BYTES`，`workspace_access.rs`）。取值依据是
 * **不制造比宿主更紧的第二道约束**：AGENTS.md 是项目索引文件（指向领域规范、
 * 架构边界、交接清单），定位职责要求全文进上下文；若这里的预算低于宿主上限，
 * 一份 64 KiB 的索引会在 `readWholeFile` 已读到 EOF 之后被本层再砍掉一半，
 * 且丢掉的正是「版本契约」「交接风险清单」这类最该被模型看到的章节。
 * 上限只兜住「单文件异常庞大」这一病态情形，且截断必须显式告知——索引被静默
 * 砍半比明确告诉模型「这里只加载了一部分」危险得多。
 */
export const PROJECT_CONTEXT_MAX_BYTES = 128 * 1024

/** 注入提示词时使用的相对文件名（在授权工作区根目录内解析）。 */
export const AGENTS_MD_FILENAME = 'AGENTS.md'

/**
 * 单次 read 的行数上限（对齐宿主 `MAX_READ_LIMIT`）。不传 limit 时宿主会退回
 * `DEFAULT_READ_LIMIT = 200` 行并静默截断——索引文件在 200 行之后的内容
 * （本仓恰是「版本契约」「交接风险清单」两节）会无声消失，故显式按页读完。
 */
const READ_PAGE_LINES = 1000

/** 分页上限：防止宿主对「超长首行」返回引导文案时逐行前进导致无界循环。 */
const MAX_READ_PAGES = 8

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

/**
 * 按宿主分页协议读完整份文件。
 *
 * `readText` 缺省只回前 200 行，且 `WorkspaceReadResult` 的 `truncated` /
 * `next_offset` 会如实报告是否还有后续——这里据此读到 EOF，而不是接受默认值
 * 造成的静默残缺。返回 `complete=false` 表示已达分页上限仍未读完。
 */
const readWholeFile = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
): Promise<{ content: string; readLines: number; totalLines: number | null; complete: boolean }> => {
  const pages: string[] = []
  let offset = 1
  let readLines = 0
  let totalLines: number | null = null
  let complete = false
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    const result = await environment.workspace.readText(AGENTS_MD_FILENAME, offset, READ_PAGE_LINES)
    totalLines = result.totalLines
    // 宿主对「请求范围的首行就超出输出字节预算」返回引导文案而非正文；它同样
    // 会报 truncated/next_offset，不额外识别，靠页数上限兜住。
    if (result.content.length > 0) pages.push(result.content)
    readLines += Math.max(0, result.endLine - result.startLine + 1)
    if (!result.truncated || result.nextOffset === undefined || result.nextOffset <= offset) {
      complete = true
      break
    }
    offset = result.nextOffset
  }
  return { content: pages.join('\n'), readLines, totalLines, complete }
}

const truncate = (content: string): string => {
  if (byteLength(content) <= PROJECT_CONTEXT_MAX_BYTES) return content
  // 按行边界贪心裁剪到字节预算内，避免在多字节字符中间截断产生乱码。
  let kept = ''
  for (const slice of content.split(/(?<=\n)/u)) {
    if (byteLength(kept + slice) > PROJECT_CONTEXT_MAX_BYTES) break
    kept += slice
  }
  const omitted = Math.max(0, content.length - kept.length)
  return `${kept}\n\n[AGENTS.md 已截断：省略了约 ${omitted} 个字符，完整内容见工作区根目录 AGENTS.md]`
}

/**
 * 根 `AGENTS.md` 的加载结果——三态而非二态。
 *
 * `absent` 与 `unavailable` 分开是刻意的：前者是「项目确实没有这份文件」，
 * 调用方据此清空镜像；后者是「原因不明，没读成」，调用方据此**保留上一份**，
 * 否则一次偶发错误就会让模型在一个 run 的时间里失去全部项目约定。
 */
export type ProjectContextLoad =
  /** 读到正文（可能已按字节预算截断并注记）。 */
  | { kind: 'content'; content: string }
  /** 文件确不存在或为空。 */
  | { kind: 'absent' }
  /** 读取失败，原因不明。 */
  | { kind: 'unavailable' }

/**
 * 读取授权工作区根目录下的 AGENTS.md，返回（可能截断后的）正文。
 *
 * 设计要点：
 * - 通过 {@link AgentEnvironment} 的 workspace 能力域读取，保持 agent 层
 *   不直接依赖 `@/platform/*`：宿主传入绑定了会话工作区的 environment，
 *   复用其已审计的路径作用域与路径边界强制，不新增独立的文件系统入口。
 * - **读到 EOF**：AGENTS.md 定位为项目索引文件（会话启动时全文进上下文，供模型
 *   快速查找与定位相关实现），只回前若干行会让索引后半段无声消失。
 * - 全程 fail-soft：文件不存在、为空、读取失败或运行在非 Tauri 浏览器开发
 *   模式时返回 null，绝不阻断会话创建或提示词组装。
 * - monorepo 场景只加载根目录单文件；根 AGENTS.md 内部自行描述子目录索引，
 *   Axiom 不主动解析引用递归加载，避免路径遍历安全面扩大。
 */
export const loadProjectContext = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
): Promise<ProjectContextLoad> => {
  try {
    const { content, readLines, totalLines, complete } = await readWholeFile(environment)
    const trimmed = content.trim()
    if (trimmed.length === 0) return { kind: 'absent' }
    // 宿主输出字节上限等异常情形下可能仍读不满：与字节截断一样显式告知，
    // 否则模型会把残缺索引当全集，据此断言「仓库里没有这段约定」。
    if (!complete) {
      const scope = totalLines === null ? `${readLines} 行` : `${readLines}/${totalLines} 行`
      return {
        kind: 'content',
        content: `${truncate(trimmed)}\n\n[AGENTS.md 未完整加载：本次只读到 ${scope}，完整内容见工作区根目录 AGENTS.md]`,
      }
    }
    return { kind: 'content', content: truncate(trimmed) }
  } catch (error) {
    // 「文件确实不存在」与「读取失败」必须区分：前者是正常状态（项目没写
    // AGENTS.md），后者若也当成不存在，一次偶发的 IPC/权限错误就会把整段正文
    // 从 live 提示词删掉，退化窗口横跨一整个 run。
    return error instanceof AgentEnvironmentError && error.code === 'not_found'
      ? { kind: 'absent' }
      : { kind: 'unavailable' }
  }
}

/**
 * 把 AGENTS.md 正文包装成提示词的一个 `# 项目上下文` 分节。无内容时返回 null，
 * 由 {@link buildSessionBasePrompt} 过滤，保持提示词最小化。
 */
export const buildProjectContextSection = (content: string | null): string | null =>
  content && content.length > 0 ? `# 项目上下文\n${content}` : null
