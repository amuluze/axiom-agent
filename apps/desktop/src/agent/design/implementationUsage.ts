/**
 * 实现 ↔ 设计结构对账的提取器（docs/ax-format.md §4.6.4「设计 ↔ 实现结构对账」，
 * P4 遗留项）：从实现源码（.ts/.tsx 文本）提取**注册表组件的使用情况**——
 * import 出现与 JSX 使用计数。与 `.ax` 稿的组件清单做双向 diff：
 * 稿有实无＝漏实现；实有稿无＝设计外实现。
 *
 * 纯词法提取（不引 TS/babel 解析器——运行时在 WebView，typescipt 包体积不可接受）：
 * 先用状态机把注释与字符串字面量替换成等长空白（行号保持，字符串里的
 * "<ApprovalCard" 与注释里的 import 不会误匹配），再对骨架文本做正则识别。
 * 这是**建议性核对**（与 scan 的 tokenParity 同口径）：泛型位置的大写标识符、
 * 模板字符串内嵌表达式中的罕见写法可能造成个位数误差，不产生 fail 判定。
 */

/** 单组件的使用计数（相对一份源码文件）。 */
export interface ComponentUsageEntry {
  /** import 语句中的具名导入次数（含 `A as B` 的别名）。 */
  imports: number
  /** JSX 元素使用次数（`<Name` 开标签；闭合标签与成员表达式不算）。 */
  jsxUses: number
}

/**
 * 剥离注释与字符串字面量：被剥离区域替换为等长空白（保留换行），返回骨架文本。
 * 支持块/行注释、单/双引号字符串、模板字面量（含 `${}` 内嵌代码的嵌套返回）。
 * 正则字面量与除号的歧义不处理（正则里出现大写 JSX 形态的概率可忽略，advisory）。
 */
export const stripCodeNoise = (source: string): string => {
  const chars = [...source]
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let state: State = 'code'
  // 模板字面量的 ${} 嵌套深度栈：template 态遇 ${ 压栈进入 code，code 态遇 } 弹栈回 template。
  const templateStack: State[] = []
  const blank = (index: number): void => {
    if (chars[index] !== '\n') chars[index] = ' '
  }
  for (let i = 0; i < chars.length; i += 1) {
    const current = chars[i] ?? ''
    const next = chars[i + 1] ?? ''
    if (state === 'code') {
      if (current === '/' && next === '/') {
        blank(i); blank(i + 1); state = 'line'; i += 1
      } else if (current === '/' && next === '*') {
        blank(i); blank(i + 1); state = 'block'; i += 1
      } else if (current === "'") {
        blank(i); state = 'single'
      } else if (current === '"') {
        blank(i); state = 'double'
      } else if (current === '`') {
        blank(i); state = 'template'
      }
      continue
    }
    if (state === 'line') {
      if (current === '\n') state = 'code'
      else blank(i)
      continue
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        blank(i); blank(i + 1); state = 'code'; i += 1
      } else blank(i)
      continue
    }
    // single/double/template 共用转义与结束判定；template 额外处理 ${ 嵌套。
    if (current === '\\') {
      blank(i)
      if (i + 1 < chars.length) blank(i + 1)
      i += 1
      continue
    }
    if (state === 'template' && current === '$' && next === '{') {
      blank(i); blank(i + 1)
      templateStack.push('template')
      state = 'code'
      i += 1
      continue
    }
    if (state === 'template' && current === '}' && templateStack.length > 0) {
      blank(i)
      templateStack.pop()
      state = 'template'
      continue
    }
    if (
      (state === 'single' && current === "'")
      || (state === 'double' && current === '"')
      || (state === 'template' && current === '`')
    ) {
      blank(i)
      state = 'code'
      continue
    }
    blank(i)
  }
  return chars.join('')
}

/** 具名 import 声明的识别（骨架文本上）：`import { A, B as C } from '…'`。 */
const NAMED_IMPORT_PATTERN = /import\s+(?:type\s+)?\{([^}]*)\}\s*from/g

/** JSX 开标签的识别：`<Name` 后随空白/`/`/`>`（大写开头；成员表达式与闭合标签不匹配）。 */
const JSX_OPEN_PATTERN = /<([A-Z][A-Za-z0-9_$]*)(?=[\s/>])/g

/**
 * 提取一份源码里目标组件名的使用计数。names 为注册表组件名集合（大小写敏感）；
 * `import { X as Y }` 的 JSX 使用（`<Y />`）经别名映射记到注册表本名 X 头上。
 */
export const extractComponentUsage = (
  source: string,
  names: readonly string[],
): Map<string, ComponentUsageEntry> => {
  const target = new Set(names)
  const result = new Map<string, ComponentUsageEntry>()
  const entryOf = (name: string): ComponentUsageEntry => {
    const existing = result.get(name)
    if (existing) return existing
    const created = { imports: 0, jsxUses: 0 }
    result.set(name, created)
    return created
  }
  // 别名 → 注册表本名：`import { Sidebar as SidePanel }` 后 JSX 写的是 <SidePanel/>。
  const aliasToCanonical = new Map<string, string>()
  const skeleton = stripCodeNoise(source)
  for (const match of skeleton.matchAll(NAMED_IMPORT_PATTERN)) {
    const clause = match[1] ?? ''
    for (const raw of clause.split(',')) {
      const identifiers = raw.trim().split(/\s+as\s+/)
      const canonical = identifiers[0]?.trim() ?? ''
      const alias = identifiers[1]?.trim() ?? ''
      if (canonical === '' || !target.has(canonical)) continue
      entryOf(canonical).imports += 1
      if (alias !== '') aliasToCanonical.set(alias, canonical)
    }
  }
  for (const match of skeleton.matchAll(JSX_OPEN_PATTERN)) {
    const name = match[1] ?? ''
    const canonical = aliasToCanonical.get(name) ?? (target.has(name) ? name : '')
    if (canonical !== '') entryOf(canonical).jsxUses += 1
  }
  return result
}
