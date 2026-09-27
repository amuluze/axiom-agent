/**
 * `.ax` 组件节点的宿主（docs/ax-format.md §4.1）：把 `component` 节点渲染成**真实组件**。
 *
 * 流程：查注册表 →（缺失即显式报错，不降级）→ 解析 props（fixture + 节点覆盖，
 * `$mock`/`$bind` 绑定在预览态取 fixture 值）→ 校验契约 → store 绑定组件套预览 Provider
 * （数据来自 fixture、动作 no-op）→ 渲染，外层套错误边界（一个组件炸掉不拖垮整页）。
 *
 * 明确不做：`slot` 的内容不由宿主注入（真组件的插槽契约因组件而异，属后续工作）；
 * 存在 slot 时渲染在一个标注容器里，保证内容可见、可选中、且**被标记为未映射**。
 */
import type { ComponentType } from 'react'
import type { ReactNode } from 'react'
import type { PenComponentNode } from '@/agent/design/penParser'
import PenNodeView from '../PenNodeView'
import CanvasErrorBoundary from '../CanvasErrorBoundary'
import { DesignPreviewProvider, DesignStorePreviewProvider, NOOP_PREVIEW_ACTIONS } from './previewContext'
import type { DesignStoreSlices } from './previewContext'
import {
  AX_COMPONENT_REGISTRY,
  axComponentNames,
  axFixtureOf,
  axPreviewValueOf,
  validateAxProps,
} from './registry'
import type { AxComponentEntry } from './registry'
import type { PenDocument, PenThemeMode } from '@/agent/design/penParser'
import { useT } from '@/i18n'

/** `.ax` 节点里的绑定值（`{$mock}` / `{$bind}`）；mock 可以是结构化值（1.1 起）。 */
const bindingOf = (value: unknown): { kind: 'mock'; value: unknown } | { kind: 'bind'; target: string } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1) return null
  const key = keys[0]
  if (key === '$mock' && Object.hasOwn(record, '$mock')) return { kind: 'mock', value: record.$mock }
  if (key === '$bind' && typeof record.$bind === 'string') return { kind: 'bind', target: record.$bind }
  return null
}

/**
 * props 解析：**presentational** 用 fixture 打底、节点覆盖；**store-bound** 的 fixture
 * 是「预览态数据」而不是 props（它的数据经 Provider 注入组件内部），因此只取节点 props。
 * 绑定值在预览态取字面量（`$mock`）或占位文本（`$bind` 指向真实数据源，预览态渲染成
 * `{字段}`，让人一眼看出这是绑定而非字面量）。
 */
const resolveProps = (
  entry: AxComponentEntry,
  fixture: string | undefined,
  props: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  // 只解析**可被作者声明**的 props（fixture 打底 + 节点覆盖）；statics 在**契约校验之后**
  // 才合并——它们是回调句柄（预览态 no-op），不该按契约字段校验，否则会被判成未声明字段。
  const resolved: Record<string, unknown> =
    entry.kind === 'store-bound' ? {} : { ...axFixtureOf(entry, fixture) }
  for (const [field, value] of Object.entries(props ?? {})) {
    const binding = bindingOf(value)
    if (!binding) {
      resolved[field] = value
      continue
    }
    if (binding.kind === 'mock') {
      // mock 值原样进 props：字符串是文案 mock，对象/数组是 json 型 props 的结构化 mock
      // （工具调用的 call/result、消息对象等）。宿主不做 JSON 里外翻转。
      resolved[field] = binding.value
      continue
    }
    resolved[field] = field in resolved ? resolved[field] : `{${binding.target}}`
  }
  return resolved
}

const errorBox = (className: string, headline: string, detail: string): ReactNode => (
  <div className={`ax-component-error ${className}`} role="alert">
    <span className="ax-component-error__headline">{headline}</span>
    <span className="ax-component-error__detail">{detail}</span>
  </div>
)

const AxComponentHost = ({
  node,
  document,
  themeMode,
}: {
  node: PenComponentNode
  document: PenDocument
  themeMode: PenThemeMode
}): ReactNode => {
  const { t } = useT()
  const entry = AX_COMPONENT_REGISTRY[node.name]
  // 规则 1 的运行时兜底：`.ax` 里声明的组件名必须命中注册表。
  if (!entry) {
    return errorBox(
      'is-missing',
      t('app.design.component.missing', { name: node.name }),
      t('app.design.component.known', { names: axComponentNames().join('、') }),
    )
  }
  const props = resolveProps(entry, node.fixture, node.props)
  const validation = validateAxProps(entry, props)
  if (!validation.ok) {
    return errorBox(
      'is-invalid',
      t('app.design.component.invalidProps', { name: node.name }),
      validation.errors.map((item) => `${item.field}: ${item.message}`).join('；'),
    )
  }
  const Component = entry.component as ComponentType<Record<string, unknown>>
  const componentProps = { ...(entry.statics ?? {}), ...props }
  const preview = axPreviewValueOf(entry, node.fixture)
  // 多 store 切片预览（Sidebar/Composer 形态）：与命名字段 preview 各自套 Provider。
  const storePreview: DesignStoreSlices | null = entry.kind === 'store-bound'
    ? entry.storePreview?.(axFixtureOf(entry, node.fixture)) ?? null
    : null
  const rendered = (
    <CanvasErrorBoundary
      title={t('app.design.component.renderError', { name: node.name })}
      retryLabel={t('app.design.canvas.retry')}
    >
      <Component {...componentProps} />
    </CanvasErrorBoundary>
  )
  const wrapped = storePreview
    ? <DesignStorePreviewProvider value={storePreview}>{rendered}</DesignStorePreviewProvider>
    : rendered
  const slot = (node.children ?? []).length > 0
    ? (
      <div className="ax-component-slot" title={t('app.design.component.slotNote')}>
        {(node.children ?? []).map((child) => (
          <PenNodeView key={child.id} node={child} document={document} themeMode={themeMode} />
        ))}
      </div>
    )
    : null
  return (
    <div className="ax-component" data-ax-component={node.name}>
      {preview
        ? (
          <DesignPreviewProvider value={{ ...NOOP_PREVIEW_ACTIONS, ...preview }}>
            {wrapped}
          </DesignPreviewProvider>
        )
        : wrapped}
      {slot}
    </div>
  )
}

export default AxComponentHost
