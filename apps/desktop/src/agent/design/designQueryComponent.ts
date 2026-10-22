import type { AgentToolResult } from '@/agent/core/types'
import {
  designComponentDetail,
  type DesignComponentDetail,
  type DesignComponentSummary,
} from '@/agent/design/componentInventoryHost'
import { truncateToByteBudget } from '@/agent/design/designQueryProjection'

/**
 * `.ax` component 模式（E5 切片）：单组件契约详单。
 *
 * 与具体稿件无关（file 可省）：先查注册表详单；详单接缝未注入时回落清单摘要，
 * 并显式说明缺 statics / fixture 形状，不假装完整。
 */
export const executeComponentMode = (
  name: string,
  inventory: readonly DesignComponentSummary[],
  maxBytes: number,
  detailProvider: (name: string) => DesignComponentDetail | null = designComponentDetail,
): AgentToolResult => {
  const available = inventory.map((entry) => entry.name).sort()
  const detail: DesignComponentDetail | null = detailProvider(name)
  if (!detail) {
    const summary = inventory.find((entry) => entry.name === name)
    if (!summary) {
      return {
        content: available.length > 0
          ? `design_query: component ${JSON.stringify(name)} not found in the component registry. Available: ${available.join(', ')}.`
          : `design_query: component ${JSON.stringify(name)} not found: the component inventory is empty (host seam not injected in this environment).`,
        details: { mode: 'component', found: false },
      }
    }
    // 有清单但详单接缝未注入：回萘认证过的摘要（无 statics/fixture 形状），不假装完整。
    const payload = {
      mode: 'component' as const,
      component: {
        summary,
        statics: [] as string[],
        fixtures: {} as Record<string, never>,
        note: '详单接缝未注入：无 statics 与 fixture 数据形状；props 契约以清单摘要为准',
      },
    }
    const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
    return {
      content,
      details: { mode: 'component', found: true, source: 'inventory-summary', truncated },
    }
  }
  const { content, truncated } = truncateToByteBudget(
    JSON.stringify({ mode: 'component' as const, component: detail }, null, 2),
    maxBytes,
  )
  return { content, details: { mode: 'component', found: true, truncated } }
}
