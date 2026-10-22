/**
 * `.ax` 组件节点的宿主（docs/ax-format.md §4.1）：把 `component` 节点渲染成**真实组件**。
 *
 * 流程：查注册表 →（缺失即显式报错，不降级）→ 解析 props（fixture + 节点覆盖，
 * `$mock`/`$bind` 绑定在预览态取 fixture 值）→ 校验契约 → store 绑定组件套预览 Provider
 * （数据来自 fixture、动作 no-op）→ 渲染，外层套错误边界（一个组件炸掉不拖垮整页）。
 *
 * 插槽（1.5）：节点 `slot` 内容按注册表插槽契约注入真实 prop（default → children
 * 即 JSX children），内容独立套错误边界；契约不符显式报错框——契约缺失本应在写稿期
 * 被解析器拦下（decl.slots fail-closed），这里只是渲染期兜底，不做静默降级。
 */
import { resolveComponentProps } from '@/agent/design/componentInstance'
import type { ComponentType } from 'react'
import type { ReactNode } from 'react'
import { AX_DEFAULT_SLOT_NAME } from '@/agent/design/axSchema'
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
import type { PenDocument, PenThemeMode } from '@/agent/design/penParser'
import { useT } from '@/i18n'

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
  if (document.projectComponents) {
    const external = document.projectComponents.find((entry) => entry.summary.name === node.name)
    return errorBox('is-external', t('app.design.component.projectPreview', { name: node.name }),
      external ? `${external.summary.sourcePath} · ${t('app.design.component.projectPreviewHint')}` : t('app.design.component.missing', { name: node.name }))
  }
  const entry = AX_COMPONENT_REGISTRY[node.name]
  // 规则 1 的运行时兜底：`.ax` 里声明的组件名必须命中注册表。
  if (!entry) {
    return errorBox(
      'is-missing',
      t('app.design.component.missing', { name: node.name }),
      t('app.design.component.known', { names: axComponentNames().join('、') }),
    )
  }
  const props = resolveComponentProps(entry.kind, axFixtureOf(entry, node.fixture), node.props, node.variant)
  const validation = validateAxProps(entry, props)
  if (!validation.ok) {
    return errorBox(
      'is-invalid',
      t('app.design.component.invalidProps', { name: node.name }),
      validation.errors.map((item) => `${item.field}: ${item.message}`).join('；'),
    )
  }
  const Component = entry.component as ComponentType<Record<string, unknown>>
  // 插槽接线（1.5）：slot 内容按注册表契约注入真实 prop；default → children 即 JSX
  // children。契约不符渲染期兜底报错（写稿期已由解析器按 decl.slots 拦下），内容
  // 独立套错误边界——一个插槽子树炸掉不拖垮组件本身。
  const slotChildren = node.children ?? []
  const slotContract = entry.slots?.[AX_DEFAULT_SLOT_NAME]
  const slotInjection = slotChildren.length > 0 && slotContract
    ? (
      <CanvasErrorBoundary
        title={t('app.design.component.renderError', { name: node.name })}
        retryLabel={t('app.design.canvas.retry')}
      >
        {slotChildren.map((child) => (
          <PenNodeView key={child.id} node={child} document={document} themeMode={themeMode} />
        ))}
      </CanvasErrorBoundary>
    )
    : null
  const slotMismatch = slotChildren.length > 0 && !slotContract
    ? errorBox(
      'is-slot',
      t('app.design.component.slotNote'),
      `${node.name}: ${Object.keys(entry.slots ?? {}).join(', ') || '—'}`,
    )
    : null
  const componentProps = {
    ...(entry.statics ?? {}),
    ...props,
    ...(slotInjection && slotContract ? { [slotContract.prop]: slotInjection } : {}),
  }
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
      <Component key={node.fixture ?? 'default'} {...componentProps} />
    </CanvasErrorBoundary>
  )
  const wrapped = storePreview
    ? <DesignStorePreviewProvider value={storePreview}>{rendered}</DesignStorePreviewProvider>
    : rendered
  return (
    <div className={`ax-component${entry.previewFrame === 'dialog' ? ' ax-component--dialog' : ''}`} data-ax-component={node.name}>
      {preview
        ? (
          <DesignPreviewProvider value={{ ...NOOP_PREVIEW_ACTIONS, ...preview }}>
            {wrapped}
          </DesignPreviewProvider>
        )
        : wrapped}
      {slotMismatch}
    </div>
  )
}

export default AxComponentHost
