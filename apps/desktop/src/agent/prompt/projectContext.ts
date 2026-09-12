import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'

/**
 * AGENTS.md 读取的字节上限。超出部分尾部截断并标注，避免单个超大文件
 * 吃掉模型上下文预算。32 KiB 与内置工具结果的内联预算（256 KiB）相比
 * 仍是一个保守的项目约定量级。
 */
export const PROJECT_CONTEXT_MAX_BYTES = 32 * 1024

/** 注入提示词时使用的相对文件名（在授权工作区根目录内解析）。 */
export const AGENTS_MD_FILENAME = 'AGENTS.md'

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const truncate = (content: string): string => {
  if (byteLength(content) <= PROJECT_CONTEXT_MAX_BYTES) return content
  // 按字符逐段裁剪到字节预算内，避免在多字节字符中间截断产生乱码。
  let kept = ''
  for (const slice of content.split(/(?<=\n)/u)) {
    if (byteLength(kept + slice) > PROJECT_CONTEXT_MAX_BYTES) break
    kept += slice
  }
  const omitted = Math.max(0, content.length - kept.length)
  return `${kept}\n\n[AGENTS.md 已截断：省略了约 ${omitted} 个字符，完整内容见工作区根目录]`
}

/**
 * 读取授权工作区根目录下的 AGENTS.md，返回（可能截断后的）正文。
 *
 * 设计要点：
 * - 通过 {@link AgentEnvironment} 的 workspace 能力域读取，保持 agent 层
 *   不直接依赖 `@/platform/*`：宿主传入绑定了会话工作区的 environment，
 *   复用其已审计的路径作用域与 .gitignore/路径边界强制，不新增独立的
 *   文件系统入口。
 * - 全程 fail-soft：文件不存在、为空、读取失败或运行在非 Tauri 浏览器开发
 *   模式时返回 null，绝不阻断会话创建或提示词组装。
 * - monorepo 场景只加载根目录单文件；根 AGENTS.md 内部自行描述子目录索引，
 *   Axiom 不主动解析引用递归加载，避免路径遍历安全面扩大。
 */
export const loadProjectContext = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
): Promise<string | null> => {
  try {
    const result = await environment.workspace.readText(AGENTS_MD_FILENAME)
    const trimmed = result.content.trim()
    return trimmed.length > 0 ? truncate(trimmed) : null
  } catch {
    // 文件不存在、未授权工作区或读取失败时静默降级为无项目上下文。
    return null
  }
}

/**
 * 把 AGENTS.md 正文包装成提示词的一个 `# 项目上下文` 分节。无内容时返回 null，
 * 由 {@link buildSessionBasePrompt} 过滤，保持提示词最小化。
 */
export const buildProjectContextSection = (content: string | null): string | null =>
  content && content.length > 0 ? `# 项目上下文\n${content}` : null
