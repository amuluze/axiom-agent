import type { DesignComponentDetail, DesignComponentSummary } from '@/agent/design/componentInventoryHost'
import type { AxDiagnostic, AxDocument, AxNode } from '@/agent/design/axSchema'
import { collectTokenRefs } from '@/agent/design/designQueryProjection'

/**
 * `.ax` 各 mode 的共享上下文：分发层装配一次，mode 实现只读。
 * `source` 供 render 模式重走解析渲染链（与画布同一入口）。
 */
export interface AxModeContext {
  projectBrowserCommand?: import('@/platform/projectDesignPreview').ProjectPreviewBrowserCommand
  workspacePath?: string
  file: string
  sha256: string
  source: string
  axDoc: AxDocument
  diagnostics: readonly AxDiagnostic[]
  inventory: readonly DesignComponentSummary[]
  /**
   * 组件清单的来源：`project`（工作区 .axiom/design/components.json）或 `host`（无项目
   * 目录时回落的 Axiom 宿主注册表）。`host` 时清单**不属于本项目**，summary 必须显式
   * 标注，否则模型会把宿主组件写进本项目稿与 codegen。
   */
  componentInventorySource?: 'project' | 'host'
  componentDetail?: (name: string) => DesignComponentDetail | null
  projectPreview?: import('./projectPreview').ProjectDesignPreview
  projectComponents?: DesignComponentDetail[]
  maxBytes: number
  /**
   * 当前模型是否接受图片输入（由 toolExecution 从 model.input 推导后透传）。
   * 显式 false 时产图 mode 必须降级为文字说明——目录外自定义模型一律按 false
   * 传（见 ProviderRegistry.resolveModel），不把模型读不懂的图塞进请求。
   */
  modelAcceptsImage?: boolean
}

/** 组件名清单 → 注册表摘要子集（page/node/render 模式的「该页组件契约」）。 */
export const inventoryOf = (
  inventory: readonly DesignComponentSummary[],
  names: readonly string[],
): DesignComponentSummary[] => inventory.filter((entry) => names.includes(entry.name))

/** 子树引用到的 token → 明暗两档字面值（`.ax` 读取路径「全解析」承诺的落点）。 */
export const tokensOf = (
  axDoc: AxDocument,
  tree: readonly AxNode[],
): Record<string, { light: string; dark: string }> => {
  const names = new Set<string>()
  collectTokenRefs(tree, names)
  const out: Record<string, { light: string; dark: string }> = {}
  for (const name of [...names].sort()) {
    const token = axDoc.tokens[name]
    if (!token) continue
    const value = token.$value
    out[name] = typeof value === 'string' ? { light: value, dark: value } : { light: value.light, dark: value.dark }
  }
  return out
}

/** 页定位（页名字符串或 1 起始序号）→ 0 起始下标；未命中返回 -1。 */
export const axPageIndex = (axDoc: AxDocument, pageInput: string | number): number =>
  typeof pageInput === 'number'
    ? pageInput - 1
    : axDoc.pages.findIndex((page) => page.name === pageInput || page.id === pageInput)
