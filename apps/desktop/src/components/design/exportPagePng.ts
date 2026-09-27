/**
 * 设计画布 PNG 导出（docs/design-canvas.md §7 v0.3）。
 *
 * 光栅化走「DOM → 内联样式快照 → SVG foreignObject → canvas → PNG」：
 * 不引入 html2canvas 之类依赖，也不自研 flexbox 布局数学（§5 D2 的备选取舍）。
 * 已知保真度边界：SVG 以 <img> 载入时是隔离文档，**不继承应用的 @font-face**
 * ——文本按系统字体栈渲染，与画布可能略有出入（设计稿字体栈本身多为系统字体，
 * 影响通常为回退差异）；导出的是当前页，不含画布平移缩放。
 */

/** 内联快照要剥掉的属性：画布自身的选中态标记不应进入导出。 */
const STRIPPED_ATTRIBUTES = ['data-selected-id', 'data-testid']

/**
 * 需要固化的 CSS 属性（渲染子集需要的布局/绘制/文本面）。
 * 不用「全量拷贝 computed style」：jsdom 的 CSSStyleDeclaration 不可迭代（跨环境
 * 不可移植），且 2855 节点的页面 × 每节点数百属性会让 SVG 快照体积爆炸。
 */
const INLINED_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-self', 'justify-content', 'order', 'gap',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'box-shadow', 'opacity',
  // 环（ellipse innerRadius）用 radial-gradient 蒙版挖内圈，不内联就导出成实心圆盘。
  'mask-image', 'mask-size', 'mask-position', 'mask-repeat',
  '-webkit-mask-image', '-webkit-mask-size', '-webkit-mask-position', '-webkit-mask-repeat',
  'overflow', 'overflow-x', 'overflow-y', 'box-sizing',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-transform',
  'text-decoration-line', 'white-space', 'overflow-wrap', 'word-break', 'vertical-align',
] as const

/**
 * 递归把计算样式写进克隆子树：SVG foreignObject 不加载外部样式表，
 * 所有类样式必须落到元素的 style 上才能被渲染。
 */
const inlineComputedStyles = (source: Element, clone: Element): void => {
  const computed = window.getComputedStyle(source)
  const target = clone as HTMLElement
  for (const property of INLINED_PROPERTIES) {
    const value = computed.getPropertyValue(property)
    if (value) target.style.setProperty(property, value)
  }
  const sourceChildren = source.children
  const cloneChildren = clone.children
  for (let index = 0; index < sourceChildren.length; index += 1) {
    const cloneChild = cloneChildren[index]
    if (cloneChild) inlineComputedStyles(sourceChildren[index]!, cloneChild)
  }
}

const stripAttributes = (root: Element): void => {
  for (const name of STRIPPED_ATTRIBUTES) root.removeAttribute(name)
  for (const child of root.children) stripAttributes(child)
}

export interface SvgMarkupInput {
  serializedHtml: string
  width: number
  height: number
  background: string
}

/** 纯字符串拼装：foreignObject 包住 XHTML 快照，背景色画在容器上。 */
export const buildSvgMarkup = ({ serializedHtml, width, height, background }: SvgMarkupInput): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + `<foreignObject width="100%" height="100%">`
  + `<div xmlns="http://www.w3.org/1999/xhtml" `
  + `style="width:${width}px;height:${height}px;background:${background};position:relative;overflow:hidden">`
  + serializedHtml
  + '</div></foreignObject></svg>'

/** 克隆 + 内联样式 + 序列化为 XHTML（供 foreignObject 使用）。 */
export const serializeWithInlineStyles = (element: HTMLElement): string => {
  const clone = element.cloneNode(true) as HTMLElement
  // 导出快照不应带上画布的 transform（平移/缩放）与选中态。
  clone.style.transform = 'none'
  stripAttributes(clone)
  inlineComputedStyles(element, clone)
  return new XMLSerializer().serializeToString(clone)
}

export interface PagePngOptions {
  /** 画布背景（导出图不能是透明底或棋盘格）。 */
  background: string
  /** 设备像素倍率：默认 2，保证 Retina 下文字清晰。 */
  scale?: number
}

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('SVG 载入失败（XML 解析失败或被 CSP 拦截）'))
    image.src = src
  })

/**
 * 画布读回失败的归因：SecurityError 在这里的根因几乎必然是 WebKit 对「绘制含
 * foreignObject 的 SVG」的画布污染策略（changeset 195614 起，blob:/data: 一律），
 * 与 CSP/跨域无关——把可执行结论（走原生截图路径）写进错误信息，而不是让
 * 「光栅化失败：SecurityError」这类裸消息留给排查者。
 */
const withCanvasReadHint = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : String(error)
  if (/security|insecure|tainted/i.test(message)) {
    return new Error(
      `${message}——WebKit 对绘制含 foreignObject 的 SVG 一律污染画布，本管线在 WKWebView 不可用（需走原生截图路径）`,
    )
  }
  return error instanceof Error ? error : new Error(message)
}

/**
 * 把页面元素光栅化为 PNG base64（不含 data URL 前缀，直接供 Rust 侧解码）。
 * 失败向上抛：导出是用户发起的显式动作，静默失败不如报错。
 */
export const renderPageToPngBase64 = async (
  element: HTMLElement,
  { background, scale = 2 }: PagePngOptions,
): Promise<string> => {
  const { base64 } = await renderPageToPngWithStats(element, { background, scale })
  return base64
}

export interface PngPixelStats {
  /** 实际采样的像素数。 */
  samples: number
  /** 采样中去重颜色（RGBA）数。 */
  distinctColors: number
  /** 占比最高颜色的份额（0–1）——「渲染结果近乎空白」的判据。 */
  topColorFraction: number
}

export interface PagePngWithStats {
  base64: string
  stats: PngPixelStats
}

/**
 * 采样像素统计（扫描验证的空白判定用）：线性等步长抽样，把样本数收敛到约 16k
 * ——1180×780 的 2× 画布有 367 万像素，全量 getImageData 逐点统计没有必要。
 * data URL 同源不污染画布，getImageData 可用；无 2d 上下文（jsdom）向上抛，
 * 由调用方决定降级。
 */
export const sampleCanvasPixels = (canvas: HTMLCanvasElement): PngPixelStats => {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建画布上下文')
  const total = canvas.width * canvas.height
  const stride = Math.max(1, Math.floor(total / 16384))
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  const counts = new Map<number, number>()
  let samples = 0
  for (let offset = 0; offset < data.length; offset += stride * 4) {
    const key = (data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!
    counts.set(key, (counts.get(key) ?? 0) + 1)
    samples += 1
  }
  let topColor = 0
  for (const count of counts.values()) topColor = Math.max(topColor, count)
  return {
    samples,
    distinctColors: counts.size,
    topColorFraction: samples > 0 ? topColor / samples : 1,
  }
}

/**
 * 光栅化并同趟产出像素统计（与 renderPageToPngBase64 同一管线；canvas 还在手上，
 * 不做二次图片解码）。扫描验证逐页调用它——统计与缩略图来自同一次绘制。
 */
export const renderPageToPngWithStats = async (
  element: HTMLElement,
  { background, scale = 2 }: PagePngOptions,
): Promise<PagePngWithStats> => {
  const width = element.offsetWidth
  const height = element.offsetHeight
  if (width <= 0 || height <= 0) throw new Error('当前页面没有可导出的尺寸')
  let markup: string
  try {
    markup = buildSvgMarkup({
      serializedHtml: serializeWithInlineStyles(element),
      width,
      height,
      background,
    })
  } catch (error) {
    throw new Error(
      `DOM 快照序列化失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // blob: 在 CSP img-src 白名单内（data: 亦可，但 blob 免去巨串 URL 编码开销）。
  const blobUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = await loadImage(blobUrl)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布上下文')
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    let base64: string
    try {
      const stats = sampleCanvasPixels(canvas)
      const dataUrl = canvas.toDataURL('image/png')
      const comma = dataUrl.indexOf(',')
      if (comma < 0) throw new Error('PNG 编码失败')
      base64 = dataUrl.slice(comma + 1)
      return { base64, stats }
    } catch (error) {
      // 读回阶段（getImageData/toDataURL）：SecurityError 即 WebKit 画布污染。
      throw withCanvasReadHint(error)
    }
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
