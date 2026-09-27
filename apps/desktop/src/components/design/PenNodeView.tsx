/**
 * .pen 节点 → React 渲染映射（docs/design-canvas.md D3）。
 *
 * 尺寸语义：fill_container 在父布局主轴上取 flex '1 1 0%'，交叉轴取 100%；
 * absolute 节点脱离 flex 流，按 x/y 定位。token 引用统一映射为
 * var(--token)，由画布容器（或节点级主题覆写）注入的自定义属性解析。
 */
import type { CSSProperties, ReactNode } from 'react'
import { memo, useEffect, useState } from 'react'
import type {
  PenDocument,
  PenGradientStop,
  PenNodeUnion,
  PenPaint,
  PenPerSideStrokeWidth,
  PenSize,
  PenThemeMode,
} from '@/agent/design/penParser'
import { tokenToCss } from '@/agent/design/penParser'
import { resolvePenIcon, resolvePenIconLazy } from './penIcons'
import type { LucideIcon } from 'lucide-react'
import { usePenImageFill } from './penImageFill'
import AxComponentHost from './ax/AxComponentHost'
import { axPartClassNames, axPartSpecOf } from '@/agent/design/axParts'

interface RenderContext {
  document: PenDocument
  themeMode: PenThemeMode
}

/**
 * .pen 的 sizing 值带可选兜底参数：`fill_container` / `fill_container(1180)` /
 * `fit_content` / `fit_content(baseline)`。括号里是「内容撑不开时的兜底尺寸」提示，
 * 布局语义仍是同一个 sizing——只做精确匹配会把 `fill_container(840)` 当字面量写进
 * width，整条声明无效（组件展示区那 8 处就是这样丢掉宽度的）。
 * `hug_content` 是早期 .pen 文件里 fit_content 的旧别名（open-pencil 的导入器
 * 同样把它归到 fit_content），一并认下，免得老稿子整条宽度声明失效。
 */
const isFill = (size: unknown): boolean =>
  typeof size === 'string' && (size === 'fill_container' || size.startsWith('fill_container('))

const isFit = (size: unknown): boolean =>
  typeof size === 'string'
  && (size === 'fit_content' || size.startsWith('fit_content(')
    || size === 'hug_content' || size.startsWith('hug_content('))

const pxValue = (value: number | string): string => {
  if (typeof value === 'number') return `${value}px`
  return tokenToCss(value)
}

const paintToCss = (paint: PenPaint | undefined): string | undefined => {
  if (!paint) return undefined
  if (paint.kind === 'gradient') return paint.css
  // image 填充走 usePenImageFill 的异步资产通道，不在这里映射。
  if (paint.kind === 'image') return undefined
  // solid 的 value 必须是字符串；坏数据（解析遗漏的形状）降级为无填充而非渲染期抛错。
  return typeof paint.value === 'string' ? tokenToCss(paint.value) : undefined
}

/**
 * 描边映射。.pen 的 strokeWidth 有两种形态：数值（四边同宽）与逐边对象
 * （`{"bottom":1}`，设计稿用它画分隔线）。逐边对象不能回落成四边全描——
 * 那会让分隔线变成方框（反馈弹窗/顶栏/页脚都靠它画上下边框）。
 */
const applyStroke = (
  style: CSSProperties,
  width: number | PenPerSideStrokeWidth | undefined,
  stroke: string,
): void => {
  if (width === undefined) {
    style.border = `1px solid ${stroke}`
    return
  }
  if (typeof width === 'number') {
    style.border = `${width}px solid ${stroke}`
    return
  }
  // 逐边形态：只画声明的边（其余显式 none，避免与节点上其它边框声明叠加）。
  const sideValue = (value: number | string | undefined): string =>
    value === undefined
      ? 'none'
      : `${typeof value === 'number' ? `${value}px` : tokenToCss(value)} solid ${stroke}`
  style.borderTop = sideValue(width.top)
  style.borderRight = sideValue(width.right)
  style.borderBottom = sideValue(width.bottom)
  style.borderLeft = sideValue(width.left)
}

/**
 * `path` 的填充：CSS 渐变串在 SVG `fill` 里无效，需要重建 SVG 渐变定义。
 * linear 的角度按 CSS 约定换算（0deg 指向上、90deg 指向右）成 objectBoundingBox
 * 坐标上的 x1/y1→x2/y2；radial/angular 在 path 上罕见，退化为首个色标实色。
 */
type PathFill =
  | { kind: 'color'; value: string }
  | { kind: 'linear'; stops: PenGradientStop[]; x1: number; y1: number; x2: number; y2: number }

const pathFillOf = (paint: PenPaint | undefined): PathFill | undefined => {
  if (!paint) return undefined
  if (paint.kind === 'solid') return { kind: 'color', value: tokenToCss(paint.value) }
  if (paint.kind !== 'gradient') return undefined
  const first = paint.stops[0]
  if (!first) return undefined
  if (paint.gradientType !== 'linear') return { kind: 'color', value: first.color }
  // CSS 角 A → 方向向量 (sinA, -cosA)（y 轴向下），渐变线取到覆盖整个包围盒。
  const angle = ((180 + paint.rotation) * Math.PI) / 180
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const length = Math.abs(sin) + Math.abs(cos)
  return {
    kind: 'linear',
    stops: paint.stops,
    x1: 0.5 - (sin * length) / 2,
    y1: 0.5 + (cos * length) / 2,
    x2: 0.5 + (sin * length) / 2,
    y2: 0.5 - (cos * length) / 2,
  }
}

/** 图片填充 mode → background-size 映射（fill 为 .pen 默认）。 */
const imageModeStyle = (mode: string | undefined): CSSProperties => {
  switch (mode) {
    case 'fit':
      return { backgroundSize: 'contain', backgroundRepeat: 'no-repeat' }
    case 'stretch':
      return { backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' }
    case 'tile':
      return { backgroundSize: 'auto', backgroundRepeat: 'repeat' }
    default:
      return { backgroundSize: 'cover', backgroundRepeat: 'no-repeat' }
  }
}

/** 节点级主题覆写：把对应模式的全量 token 作为自定义属性注入本子树。 */
const themeOverrideStyle = (
  document: PenDocument,
  mode: PenThemeMode | undefined,
): CSSProperties | undefined => {
  if (!mode) return undefined
  const vars = document.modeVariables[mode]
  const style: Record<string, string> = {}
  for (const [name, value] of Object.entries(vars)) {
    style[`--${name}`] = value
  }
  return style as CSSProperties
}

const sizeStyle = (
  node: { width?: PenSize; height?: PenSize },
  parentLayout: 'vertical' | 'horizontal' | undefined,
): CSSProperties => {
  const style: CSSProperties = {}
  const mainAxisIsWidth = parentLayout !== 'vertical'
  if (node.width !== undefined) {
    if (isFill(node.width)) {
      if (mainAxisIsWidth) style.flex = '1 1 0%'
      else style.width = '100%'
    } else if (!isFit(node.width)) {
      style.width = pxValue(node.width)
    }
  }
  if (node.height !== undefined) {
    if (isFill(node.height)) {
      if (mainAxisIsWidth) style.height = '100%'
      else style.flex = '1 1 0%'
    } else if (!isFit(node.height)) {
      style.height = pxValue(node.height)
    }
  }
  return style
}

const normalizeJustify = (value: string): string =>
  value === 'space_between' ? 'space-between' : value

/**
 * lucide 图标字形：静态词表命中即同步渲染；未命中（模型新写了词表外的合法
 * lucide 图标名）异步走懒加载兜底（完整命名空间 kebab→Pascal 查找，一次性独立
 * chunk），解析成功后替换首帧的虚线占位——查不到的占位才是真正的「未知图标」。
 */
const PenIconGlyph = ({ name, size }: { name: string | undefined; size: number }) => {
  const staticIcon = resolvePenIcon(name)
  const [lazyIcon, setLazyIcon] = useState<LucideIcon | null>(null)
  useEffect(() => {
    setLazyIcon(null)
    if (staticIcon || name === undefined) return
    let cancelled = false
    void resolvePenIconLazy(name).then((icon) => {
      if (!cancelled && icon) setLazyIcon(icon)
    })
    return () => {
      cancelled = true
    }
  }, [name, staticIcon])
  const Icon = staticIcon ?? lazyIcon
  if (Icon) return <Icon size={size} strokeWidth={1.75} aria-hidden />
  return (
    <span
      className="pen-node__icon-missing"
      title={name ? `未知图标：${name}` : undefined}
      aria-hidden
    />
  )
}

const PenNodeView = memo(function PenNodeView({
  node,
  document,
  themeMode,
  parentLayout,
}: {
  node: PenNodeUnion
  document: PenDocument
  themeMode: PenThemeMode
  parentLayout?: 'vertical' | 'horizontal'
}): ReactNode {
  // hook 必须在所有早退分支之前（同 key 节点重解析后类型可能变化，hook 顺序须稳定）；
  // 非 image 填充时传 undefined，hook 内部短路。
  const imageFill = usePenImageFill(
    document.fileName,
    'fill' in node && node.fill?.kind === 'image' ? node.fill : undefined,
  )

  if (node.type === 'unknown') {
    return (
      <div
        className="pen-node__placeholder"
        style={{ ...sizeStyle(node, parentLayout), position: 'relative' }}
        data-pen-id={node.id}
        title={node.name ? `${node.name}（${node.originalType}）` : node.originalType}
      >
        {node.name ?? node.originalType}
      </div>
    )
  }

  // `.ax` 的组件实例：交给宿主渲染真实组件（宿主内部做注册表解析、props 校验、
  // 预览态 Provider 与错误边界）。必须在通用字段访问之前分发——组件节点没有 fill/
  // width/theme 这些 frame 字段。
  if (node.type === 'component') {
    return <AxComponentHost node={node} document={document} themeMode={themeMode} />
  }

  // `.ax` 的语义部件：按词表映射到**真实实现的元素与类名**（见 agent/design/axParts）——
  // 画布上看到的就是实现的样子，而不是照规范另画一遍。评审面不生成可交互控件：
  // 需要交互语义的部件（如按钮）在画布内一律以中性元素渲染，类名相同、视觉一致。
  if (node.type === 'part') {
    const spec = axPartSpecOf(node.part)
    if (!spec) {
      return (
        <div className="pen-node__placeholder" data-pen-id={node.id} title={`未登记的部件：${node.part}`}>
          {`part:${node.part}`}
        </div>
      )
    }
    const classNames = axPartClassNames(spec, node.variant)
      .filter((name) => name !== spec.textClassName)
      .join(' ')
    const inline: CSSProperties = {
      position: 'relative',
      boxSizing: 'border-box',
      display: spec.className === 'session__divider' ? undefined : 'flex',
      alignItems: spec.className === 'session__divider' ? undefined : 'center',
      gap: spec.className === 'session__divider' ? undefined : '6px',
    }
    const text = node.label !== undefined
      ? (spec.textClassName
        ? <span className={spec.textClassName}>{node.label}</span>
        : node.label)
      : null
    const content = (
      <>
        {node.icon ? <span className="ax-part__icon" aria-hidden>{node.icon}</span> : null}
        {text}
        {node.count !== undefined ? <span className="ax-part__count">{node.count}</span> : null}
      </>
    )
    // 元素标签：divider 用 div，其余用 span（非交互）；类名与实现一致。
    return spec.className === 'session__divider'
      ? <div className={classNames} data-pen-id={node.id} style={inline} />
      : <span className={classNames} data-pen-id={node.id} style={inline}>{content}</span>
  }

  if (node.refMissing) {
    return (
      <div
        className="pen-node__placeholder"
        style={{ ...sizeStyle(node, parentLayout), position: 'relative' }}
        data-pen-id={node.id}
        title={node.name ?? '缺失的组件引用'}
      >
        {node.name ?? 'ref'}
      </div>
    )
  }

  const effectiveMode = node.theme?.mode ?? themeMode
  const context: RenderContext = { document, themeMode: effectiveMode }
  const sizes = sizeStyle(node, parentLayout)
  const baseStyle: CSSProperties = {
    ...themeOverrideStyle(document, node.theme?.mode),
    ...sizes,
    // pen 的布局引擎按声明尺寸摆放节点（fit_content 取内容尺寸、fill_container 在
    // 主轴均分剩余空间），没有 CSS 那个「空间不够就等比压缩子项」的语义。CSS 默认
    // flex-shrink:1 会把文本盒子压扁——两行文本被挤进 1.6 行，第二行直接画到下面
    // 兄弟节点上。fill_container 的均分已在 sizeStyle 里声明 flex，不做兜底。
    ...(sizes.flex === undefined ? { flexShrink: 0 } : {}),
    position: node.layoutPosition === 'absolute' ? 'absolute' : 'relative',
  }
  if (node.layoutPosition === 'absolute') {
    if (node.x !== undefined) baseStyle.left = node.x
    if (node.y !== undefined) baseStyle.top = node.y
  }
  const fill = paintToCss(node.fill)
  if (fill) baseStyle.background = fill
  if (imageFill.dataUrl) {
    // data URL 仅含 base64 字符集，无引号/括号注入面。
    baseStyle.backgroundImage = `url(${imageFill.dataUrl})`
    baseStyle.backgroundPosition = 'center'
    Object.assign(baseStyle, imageModeStyle(node.fill?.kind === 'image' ? node.fill.mode : undefined))
  } else if (imageFill.rejected) {
    // 远程图片被拒绝的占位纹理（自带常量，无加载）；解析期诊断条可见原因。
    baseStyle.background =
      'repeating-linear-gradient(45deg, transparent, transparent 8px, rgba(127,127,127,0.15) 8px, rgba(127,127,127,0.15) 16px)'
  }
  const stroke = paintToCss(node.stroke)
  if (stroke) applyStroke(baseStyle, node.strokeWidth, stroke)
  if (node.cornerRadius !== undefined) {
    // cornerRadius 三态：数值（四角同值）、token，以及 [tl,tr,br,bl] 数组
    // （.pen schema 的四角半径），数组此前落到 tokenToCss 被整条丢弃。
    baseStyle.borderRadius = Array.isArray(node.cornerRadius)
      ? node.cornerRadius.map((value) => pxValue(value)).join(' ')
      : typeof node.cornerRadius === 'number'
        ? `${node.cornerRadius}px`
        : tokenToCss(node.cornerRadius)
  }
  if (node.opacity !== undefined) baseStyle.opacity = node.opacity
  if (node.shadow) {
    baseStyle.boxShadow = `${node.shadow.x}px ${node.shadow.y}px ${node.shadow.blur}px ${tokenToCss(node.shadow.color)}`
  }

  const children = node.children?.map((child) => (
    <PenNodeView
      key={child.id}
      node={child}
      document={context.document}
      themeMode={context.themeMode}
      parentLayout={node.type === 'frame' ? node.layout : undefined}
    />
  ))

  switch (node.type) {
    case 'frame':
      return (
        <div
          className="pen-node pen-node--frame"
          data-pen-id={node.id}
          style={{
            ...baseStyle,
            display: 'flex',
            flexDirection: node.layout === 'vertical' ? 'column' : 'row',
            gap: node.gap !== undefined ? pxValue(node.gap) : undefined,
            // 防御：坏数据（解析遗漏/ref 覆写透传的非数组 padding）不崩渲染。
            padding: Array.isArray(node.padding)
              ? node.padding.map((value) => pxValue(value)).join(' ')
              : undefined,
            justifyContent: node.justifyContent
              ? normalizeJustify(node.justifyContent)
              : undefined,
            alignItems: node.alignItems ?? undefined,
            overflow: node.clip ? 'hidden' : undefined,
            minWidth: 0,
            minHeight: 0,
            boxSizing: 'border-box',
          }}
        >
          {children}
        </div>
      )
    case 'text': {
      const textStyle: CSSProperties = {
        ...baseStyle,
        whiteSpace: 'pre-wrap',
        margin: 0,
        boxSizing: 'border-box',
      }
      // 文本节点的 fill 是**字色**（.pen 语义，与 icon 的 fill 同源）。此前它随
      // baseStyle 落到 background：每个文本都渲染成一块自己的字色实心方块，而字
      // 形仍用继承色——整页看起来就是「一堆色块 + 看不清的字」。
      delete textStyle.background
      delete textStyle.backgroundImage
      const textFill = node.fill
      if (textFill?.kind === 'gradient') {
        // 渐变字（website.pen 的 Title Line 2）：用 background-clip:text 抠出字形。
        textStyle.backgroundImage = textFill.css
        textStyle.backgroundClip = 'text'
        textStyle.color = 'transparent'
        textStyle.WebkitTextFillColor = 'transparent'
      } else if (fill) {
        textStyle.color = fill
      }
      if (node.fontSize !== undefined) textStyle.fontSize = pxValue(node.fontSize)
      if (node.fontWeight !== undefined) {
        // 字重同理可能带 token（数值字面量直接透传）。
        textStyle.fontWeight =
          typeof node.fontWeight === 'number'
            ? node.fontWeight
            : (tokenToCss(node.fontWeight) as CSSProperties['fontWeight'])
      }
      if (node.fontFamily) {
        // axiom.pen 的 fontFamily 全部写作 $font-ui / $font-mono / $font-display：
        // 必须映射为 var(--token)（字面量如 "Inter, sans-serif" 原样透传）——
        // 直接赋值会让浏览器拿到字面量 "$font-ui" 而静默回退默认字体。
        textStyle.fontFamily = tokenToCss(node.fontFamily)
      }
      if (node.lineHeight !== undefined) {
        // .pen 的数值 lineHeight 是**字体倍数**而非 px（实测 axiom.pen 全为
        // 1.35–1.6、website.pen 为 1.25–1.8）：按 px 输出会把文本盒子压成
        // `1.35px`，文字互相重叠、所在 flex 列整体塌陷，整页只剩色块。
        // 数值原样透传（CSS 无单位即倍数），字符串既可能是 token 也可能是
        // 显式单位（'20px'）——交给 tokenToCss 原样保留。
        textStyle.lineHeight =
          typeof node.lineHeight === 'number' ? node.lineHeight : tokenToCss(node.lineHeight)
      }
      if (node.letterSpacing !== undefined) {
        textStyle.letterSpacing = typeof node.letterSpacing === 'number'
          ? `${node.letterSpacing}px`
          : tokenToCss(node.letterSpacing)
      }
      if (node.textAlign) textStyle.textAlign = node.textAlign as CSSProperties['textAlign']
      // textGrowth 语义（对齐参考实现的 text-node：`auto` 只按 maxIntrinsicWidth 排一次
      // 版，不自动换行、只认显式 \n；fixed-width/-height 才按声明宽度换行）。缺省即
      // auto：此前一律 pre-wrap，于是 auto 文本在窄容器里被折行，整列比设计稿更高，
      // 多出来的行溢出到相邻兄弟节点上（会话页的消息区就是这么压住 Composer 的）。
      if (node.textGrowth === undefined || node.textGrowth === 'auto') {
        textStyle.whiteSpace = 'nowrap'
      }
      // 兼容早期 .pen 的历史写法（auto_width / auto_height）。
      if (node.textGrowth === 'auto_width') {
        textStyle.whiteSpace = 'pre'
        textStyle.width = 'fit-content'
        textStyle.flex = '0 0 auto'
        delete textStyle.height
      } else if (node.textGrowth === 'auto_height') {
        textStyle.whiteSpace = 'pre'
        if (textStyle.height !== undefined) delete textStyle.height
        textStyle.minHeight = 0
      }
      return (
        <div className="pen-node pen-node--text" data-pen-id={node.id} style={textStyle}>
          {node.content}
        </div>
      )
    }
    case 'icon': {
      const iconSize = typeof node.fontSize === 'number' ? node.fontSize : 16
      const wrapperStyle: CSSProperties = {
        ...baseStyle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxSizing: 'border-box',
      }
      if (node.fill) {
        // 设计稿中 icon 以 fill 表达前景色，lucide 用 currentColor 绘制。
        wrapperStyle.color = fill
        delete wrapperStyle.background
        delete wrapperStyle.backgroundImage
      }
      return (
        <div className="pen-node pen-node--icon" data-pen-id={node.id} style={wrapperStyle}>
          <PenIconGlyph name={node.icon} size={iconSize} />
        </div>
      )
    }
    case 'ellipse': {
      // innerRadius > 0 是**环**（实测 axiom.pen 的预算进度环：angular 渐变 +
      // innerRadius 0.58 = 46% 进度）。实心圆盘会把这个指示器画成一块色斑：
      // 用 radial-gradient 蒙版挖出内圈（closest-side 保证非正圆也贴合）。
      const innerRadius = typeof node.innerRadius === 'number' ? node.innerRadius : 0
      const ring = innerRadius > 0
      // 1.5% 的过渡带做抗锯齿（硬切边在小尺寸环上有锯齿）；百分比取两位小数，
      // 避免 0.58*100-1.5 直接进 CSS 变成 56.49999999999999%。
      const holeEnd = ring ? Math.round(innerRadius * 100) : 0
      const holeStart = Math.round((holeEnd - 1.5) * 100) / 100
      const ringStyle: CSSProperties = ring
        ? {
            maskImage: `radial-gradient(closest-side, transparent ${holeStart}%, #000 ${holeEnd}%)`,
            WebkitMaskImage: `radial-gradient(closest-side, transparent ${holeStart}%, #000 ${holeEnd}%)`,
          }
        : {}
      return (
        <div
          className="pen-node pen-node--ellipse"
          data-pen-id={node.id}
          style={{
            ...baseStyle,
            ...ringStyle,
            borderRadius: '50%',
            boxSizing: 'border-box',
            flexShrink: 0,
          }}
        />
      )
    }
    case 'path': {
      // .pen 的 path = SVG 路径 + viewBox（website.pen 的图形标记）。渲染为内联
      // SVG（而非 css mask）：SVG 标记内自洽，PNG 导出的 foreignObject 快照不依赖
      // 外部/数据 URL 子资源。viewBox 缺失时用节点自身尺寸兜底。
      const pathStyle: CSSProperties = { ...baseStyle }
      // fill 是路径填充（SVG fill 属性），stroke 是路径描边，二者都不是盒背景/边框。
      delete pathStyle.background
      delete pathStyle.backgroundImage
      delete pathStyle.border
      delete pathStyle.borderTop
      delete pathStyle.borderRight
      delete pathStyle.borderBottom
      delete pathStyle.borderLeft
      const box = node.viewBox ?? [
        0,
        0,
        typeof node.width === 'number' ? node.width : 100,
        typeof node.height === 'number' ? node.height : 100,
      ]
      const fillPaint = pathFillOf(node.fill)
      const strokePaint = paintToCss(node.stroke)
      const gradientId = `pen-path-grad-${node.id}`
      return (
        <svg
          className="pen-node pen-node--path"
          data-pen-id={node.id}
          style={pathStyle}
          viewBox={box.join(' ')}
          preserveAspectRatio="none"
          aria-hidden
        >
          {fillPaint?.kind === 'linear' && (
            <defs>
              <linearGradient
                id={gradientId}
                x1={fillPaint.x1}
                y1={fillPaint.y1}
                x2={fillPaint.x2}
                y2={fillPaint.y2}
              >
                {fillPaint.stops.map((stop) => (
                  <stop
                    key={`${stop.color}-${stop.position}`}
                    offset={`${Math.round(stop.position * 100)}%`}
                    stopColor={stop.color}
                  />
                ))}
              </linearGradient>
            </defs>
          )}
          <path
            d={node.geometry ?? ''}
            fill={fillPaint?.kind === 'linear' ? `url(#${gradientId})` : (fillPaint?.value ?? 'none')}
            stroke={strokePaint}
            strokeWidth={strokePaint ? (typeof node.strokeWidth === 'number' ? node.strokeWidth : 1) : undefined}
          />
        </svg>
      )
    }
    case 'rectangle':
      return (
        <div
          className="pen-node pen-node--rectangle"
          data-pen-id={node.id}
          style={{ ...baseStyle, boxSizing: 'border-box' }}
        />
      )
    default:
      return null
  }
})

export default PenNodeView
