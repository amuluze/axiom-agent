import { describe, expect, it, vi } from 'vitest'
import { loadProjectComponentCatalog, parseProjectComponentCatalog } from './projectComponentCatalog'

const entry = () => ({ name: 'Button', kind: 'presentational', sourcePath: 'src/Button.tsx', sourceSha256: 'a'.repeat(64), importSource: '@/Button', exportName: 'default',
  props: [{ name: 'label', type: 'string', required: true, description: 'string' }], statics: ['onClick'], fixtures: { ready: { label: '保存' } } })
const source = (components: unknown[] = [entry()]) => JSON.stringify({ version: 1, components })

describe('项目组件目录', () => {
  it('形成独立项目契约，保留导出与 fixture，不合并内置组件', () => {
    const catalog = parseProjectComponentCatalog(source())
    expect(catalog.components[0]).toMatchObject({ summary: { name: 'Button', origin: 'project', exportName: 'default', fixtureProps: { ready: ['label'] } }, statics: ['onClick'] })
  })

  it('拒绝越界路径、未知字段、重复名称与 fixture 类型漂移', () => {
    for (const override of [{ sourcePath: '../outside.tsx' }, { importSource: 'https://host/code' }, { fixtures: { ready: { label: 3 } } }, { fixtures: { ready: {} } }, { script: 'eval' }]) {
      expect(() => parseProjectComponentCatalog(JSON.stringify({ version: 1, components: [{ ...entry(), ...override }] }))).toThrow()
    }
    expect(() => parseProjectComponentCatalog(source([entry(), entry()]))).toThrow()
    expect(() => parseProjectComponentCatalog(source([]))).toThrow()
  })

  it('只有目录不存在才回退，损坏或截断不会静默使用内置契约', async () => {
    const list = vi.fn(async () => ({ entries: [], truncated: false }))
    const readText = vi.fn(async () => ({ content: source(), truncated: false, sha256: 'a'.repeat(64) }))
    expect(await loadProjectComponentCatalog({ list, readText })).toBeNull()
    expect(readText).not.toHaveBeenCalled()
    list.mockResolvedValue({ entries: [], truncated: true })
    await expect(loadProjectComponentCatalog({ list, readText })).rejects.toThrow('截断')
  })

  it('拒绝链接目录，完整目录才读取固定相对路径', async () => {
    const list = vi.fn(async (path?: string) => ({ entries: [{ name: path === '.' ? '.axiom' : path === '.axiom' ? 'design' : 'components.json', kind: path === '.axiom/design' ? 'file' : 'directory' }], truncated: false }))
    const readText = vi.fn(async () => ({ content: source(), truncated: false, sha256: 'a'.repeat(64) }))
    expect((await loadProjectComponentCatalog({ list, readText }))?.components).toHaveLength(1)
    expect(readText).toHaveBeenCalledWith('.axiom/design/components.json', 1, 1000)
    readText.mockResolvedValueOnce({ content: source(), truncated: false, sha256: 'a'.repeat(64) })
    readText.mockResolvedValueOnce({ content: '', truncated: true, sha256: 'b'.repeat(64) })
    await expect(loadProjectComponentCatalog({ list, readText })).rejects.toThrow('过期')
    list.mockResolvedValueOnce({ entries: [{ name: '.axiom', kind: 'symlink' }], truncated: false })
    await expect(loadProjectComponentCatalog({ list, readText })).rejects.toThrow('链接')
  })
})


it('Vue SFC 必须显式登记框架与 default 导出，保留事件回调契约', () => {
  const vue = { ...entry(), framework: 'vue', sourcePath: 'src/Button.vue' }
  expect(parseProjectComponentCatalog(source([vue])).components[0]?.summary.framework).toBe('vue')
  expect(() => parseProjectComponentCatalog(source([{ ...vue, framework: 'react' }]))).toThrow('框架')
  expect(() => parseProjectComponentCatalog(source([{ ...vue, exportName: 'Button' }]))).toThrow('框架')
})


it('store 适配器允许独立快照并校验路径、框架和源码指纹', async () => {
  const adapter = { sourcePath: 'src/Preview.tsx', sourceSha256: 'b'.repeat(64), exportName: 'Preview', defaultSlot: true }
  const manifest = source([{ ...entry(), kind: 'store-bound', previewAdapter: adapter, fixtures: { ready: { state: { count: 2 } } } }])
  expect(parseProjectComponentCatalog(manifest).components[0]?.summary.previewAdapter).toEqual(adapter)
  for (const override of [{ sourcePath: '../outside.tsx' }, { sourcePath: 'src/Preview.vue' }, { sourceSha256: 'bad' }]) {
    expect(() => parseProjectComponentCatalog(source([{ ...entry(), kind: 'store-bound', previewAdapter: { ...adapter, ...override } }]))).toThrow('适配器')
  }
  const list = vi.fn(async (path?: string) => ({ entries: [{ name: path === '.' ? '.axiom' : path === '.axiom' ? 'design' : 'components.json', kind: path === '.axiom/design' ? 'file' : 'directory' }], truncated: false }))
  const readText = vi.fn(async (path: string) => ({ content: path.endsWith('components.json') ? manifest : '', truncated: false, sha256: 'a'.repeat(64) }))
  await expect(loadProjectComponentCatalog({ list, readText })).rejects.toThrow('适配器已变更')
})
