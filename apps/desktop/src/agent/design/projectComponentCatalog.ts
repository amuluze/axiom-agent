import { validateProjectPreviewUrl, type ProjectDesignPreview } from './projectPreview'
import type { DesignComponentDetail, DesignComponentSummary } from './componentInventoryHost'

export const PROJECT_COMPONENT_CATALOG_PATH = '.axiom/design/components.json'
export const MAX_PROJECT_CATALOG_BYTES = 1024 * 1024

export interface ProjectComponentCatalog {
  version: 1
  preview?: ProjectDesignPreview
  components: DesignComponentDetail[]
}

export interface CatalogReader {
  list(path?: string, limit?: number): Promise<{ entries: { name: string; kind: string }[]; truncated: boolean }>
  readText(path: string, offset?: number, limit?: number): Promise<{ content: string; truncated: boolean; sha256?: string; nextOffset?: number }>
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Za-z0-9_]*$/.test(value)

const relativePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.startsWith('/')
  && !/[\\\u0000-\u001f:]/.test(value) && value.split('/').every((part) => part !== '..' && part !== '')

const stringsOf = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') && new Set(value).size === value.length

export const parseProjectComponentCatalog = (source: string): ProjectComponentCatalog => {
  if (new TextEncoder().encode(source).length > MAX_PROJECT_CATALOG_BYTES) throw new Error('项目组件目录超过 1 MiB 上限')
  const root = objectOf(JSON.parse(source))
  if (!root || root.version !== 1 || !Array.isArray(root.components) || root.components.length === 0 || root.components.length > 200
    || Object.keys(root).some((key) => !['version', 'components', 'preview'].includes(key))) {
    throw new Error('项目组件目录必须是 version=1 的 components 数组（最多 200 项）')
  }
  const names = new Set<string>()
  const components = root.components.map((value): DesignComponentDetail => {
    const entry = objectOf(value)
    if (!entry || Object.keys(entry).some((key) => !['name', 'framework', 'kind', 'sourcePath', 'sourceSha256', 'importSource', 'exportName', 'props', 'statics', 'fixtures', 'notes', 'defaultSlot', 'previewAdapter'].includes(key))) {
      throw new Error('项目组件条目含未知字段')
    }
    if (!identifier(entry.name) || names.has(entry.name)) throw new Error('项目组件名称必须是唯一的 PascalCase 标识符')
    names.add(entry.name)
    if (!relativePath(entry.sourcePath) || !/\.(tsx?|jsx?|vue)$/.test(entry.sourcePath)) throw new Error(`${entry.name}: sourcePath 必须是工作区内源码路径`)
    const framework = entry.framework ?? 'react'
    if (!['react', 'vue'].includes(String(framework)) || (entry.sourcePath.endsWith('.vue') !== (framework === 'vue')) || (framework === 'vue' && entry.exportName !== 'default')) throw new Error(`${entry.name}: 框架与源码契约不一致`)
    if (typeof entry.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceSha256)) throw new Error(`${entry.name}: sourceSha256 无效，请重新生成目录`)
    if (typeof entry.importSource !== 'string' || !relativePath(entry.importSource.replace(/^@\//, ''))
      || !(entry.importSource.startsWith('@/') || entry.importSource.startsWith('./'))) {
      throw new Error(`${entry.name}: importSource 必须是 @/ 或 ./ 开头的项目模块路径`)
    }
    if (entry.exportName !== 'default' && !identifier(entry.exportName)) throw new Error(`${entry.name}: exportName 无效`)
    if (entry.kind !== 'presentational' && entry.kind !== 'store-bound') throw new Error(`${entry.name}: kind 无效`)
    if (!Array.isArray(entry.props) || !stringsOf(entry.statics) || entry.statics.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
      throw new Error(`${entry.name}: props/statics 无效`)
    }
    if (entry.defaultSlot !== undefined && typeof entry.defaultSlot !== 'boolean') throw new Error(`${entry.name}: defaultSlot 无效`)
    let previewAdapter: DesignComponentSummary['previewAdapter']
    if (entry.previewAdapter !== undefined) {
      const adapter = objectOf(entry.previewAdapter)
      if (entry.kind !== 'store-bound' || !adapter || Object.keys(adapter).some((key) => !['sourcePath', 'sourceSha256', 'exportName', 'defaultSlot'].includes(key))
        || !relativePath(adapter.sourcePath) || !/\.(tsx?|jsx?|vue)$/.test(adapter.sourcePath)
        || adapter.sourcePath.endsWith('.vue') !== (framework === 'vue')
        || typeof adapter.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(adapter.sourceSha256)
        || (adapter.exportName !== 'default' && !identifier(adapter.exportName)) || (framework === 'vue' && adapter.exportName !== 'default')
        || (adapter.defaultSlot !== undefined && typeof adapter.defaultSlot !== 'boolean')) throw new Error(`${entry.name}: 无效的预览适配器契约`)
      previewAdapter = { sourcePath: adapter.sourcePath, sourceSha256: adapter.sourceSha256, exportName: String(adapter.exportName), ...(adapter.defaultSlot ? { defaultSlot: true } : {}) }
    }
    const fields = new Set<string>(entry.statics)
    const props = entry.props.map((value) => {
      const field = objectOf(value)
      if (!field || typeof field.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)
        || fields.has(field.name) || !['string', 'number', 'boolean', 'json'].includes(String(field.type))
        || typeof field.required !== 'boolean' || typeof field.description !== 'string'
        || Object.keys(field).some((key) => !['name', 'type', 'required', 'description'].includes(key))) {
        throw new Error(`${entry.name}: 重复或无效的属性契约`)
      }
      fields.add(field.name)
      return { name: field.name, type: String(field.type), required: field.required, description: field.description }
    })
    const fixtures = objectOf(entry.fixtures)
    if (!fixtures || Object.keys(fixtures).length > 100 || (entry.notes !== undefined && typeof entry.notes !== 'string')) {
      throw new Error(`${entry.name}: fixtures/notes 无效`)
    }
    for (const [name, value] of Object.entries(fixtures)) {
      const fixture = objectOf(value)
      if (!name || !fixture || (!previewAdapter && Object.keys(fixture).some((key) => !props.some((field) => field.name === key)))) {
        throw new Error(`${entry.name}: fixture ${name} 含未声明属性`)
      }
      if (previewAdapter) continue
      for (const field of props) {
        if (!Object.hasOwn(fixture, field.name)) {
          if (field.required && entry.kind === 'presentational') throw new Error(`${entry.name}: fixture ${name} 缺少 ${field.name}`)
          continue
        }
        if (field.type !== 'json' && typeof fixture[field.name] !== field.type) throw new Error(`${entry.name}: fixture ${name}.${field.name} 类型不符`)
      }
    }
    const fixtureValues = fixtures as Record<string, Record<string, unknown>>
    // 插槽契约（.ax 1.5）：目录侧只有 default 具名插槽（defaultSlot），派生为
    // `{ default: { prop: 'children' } }` 与 .ax decl.slots 同词汇——prop 字段仅
    // React 注入路径消费（Vue 走 defaultSlot 布尔），读取路径核对 decl.slots 用。
    const slotContract = entry.defaultSlot ? { default: { prop: 'children' } } : undefined
    const summary: DesignComponentSummary = {
      name: entry.name,
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      sourceSha256: entry.sourceSha256,
      importSource: entry.importSource,
      exportName: String(entry.exportName),
      origin: 'project',
      ...(entry.defaultSlot ? { defaultSlot: true, slots: slotContract } : {}),
      ...(previewAdapter ? { previewAdapter } : {}),
      framework: framework === 'vue' ? 'vue' : 'react',
      props,
      fixtures: Object.keys(fixtures),
      fixtureProps: entry.kind === 'presentational'
        ? Object.fromEntries(Object.entries(fixtureValues).map(([name, value]) => [name, Object.keys(value)])) : {},
      ...(typeof entry.notes === 'string' ? { notes: entry.notes } : {}),
    }
    return { summary, statics: entry.statics, fixtures: fixtureValues, ...(slotContract ? { slots: slotContract } : {}) }
  })
  let preview: ProjectDesignPreview | undefined
  if (root.preview !== undefined) {
    const specification = objectOf(root.preview)
    if (!specification || Object.keys(specification).some((key) => key !== 'url')) throw new Error('无效的项目预览契约')
    preview = { url: validateProjectPreviewUrl(specification.url), catalogSha256: '' }
  }
  return { version: 1, components, ...(preview ? { preview } : {}) }
}

export const loadProjectComponentCatalog = async (reader: CatalogReader): Promise<ProjectComponentCatalog | null> => {
  for (const [directory, name] of [['.', '.axiom'], ['.axiom', 'design'], ['.axiom/design', 'components.json']]) {
    const listing = await reader.list(directory, 1000)
    if (listing.truncated) throw new Error(`项目组件目录发现被截断：${directory}`)
    const entry = listing.entries.find((entry) => entry.name === name)
    if (!entry) return null
    if (entry.kind !== (name === 'components.json' ? 'file' : 'directory')) throw new Error(`项目组件目录路径不可为链接或其它类型：${name}`)
  }
  const chunks: string[] = []
  let offset = 1
  let digest: string | undefined
  let bytes = 0
  for (;;) {
    const read = await reader.readText(PROJECT_COMPONENT_CATALOG_PATH, offset, 1000)
    if (offset === 1) digest = read.sha256
    else if (read.sha256 !== digest) throw new Error('项目组件目录在分段读取期间发生变更，请重试')
    chunks.push(read.content)
    bytes += new TextEncoder().encode(read.content).length + 1
    if (bytes > MAX_PROJECT_CATALOG_BYTES) throw new Error('项目组件目录超过 1 MiB 上限')
    if (!read.truncated) break
    if (read.nextOffset === undefined || read.nextOffset <= offset || chunks.length >= 100) throw new Error('项目组件目录读取不完整，请缩小 fixture 或重新生成目录')
    offset = read.nextOffset
  }
  const catalog = parseProjectComponentCatalog(chunks.join('\n'))
  if (catalog.preview) {
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('项目预览需要完整的目录 SHA-256')
    catalog.preview.catalogSha256 = digest
  }
  for (const component of catalog.components) {
    const source = await reader.readText(component.summary.sourcePath, 1, 1)
    const adapter = component.summary.previewAdapter
    if (adapter && (await reader.readText(adapter.sourcePath, 1, 1)).sha256 !== adapter.sourceSha256) throw new Error(`${component.summary.name}: 预览适配器已变更，请重新生成`)
    if (source.sha256 !== component.summary.sourceSha256) throw new Error(`${component.summary.name}: 源码已变更，项目组件目录已过期，请重新生成`)
  }
  return catalog
}
