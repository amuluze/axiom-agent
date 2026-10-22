import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { emitAxPageToTsx } from '@/agent/design/emitPage'
import type { AxDocument } from '@/agent/design/axSchema'
import { parseAxDocument } from '@/agent/design/axParser'
import { designDraftsAvailable, readDesignDraft } from './designDraftFixtures'
import { axComponentDetailOf, axComponentInventorySummary } from './registry'

/**
 * 编译门禁的路径锚点：本文件在 apps/desktop/src/components/design/ax/ 下。
 * 一律用 import.meta.dirname 上溯，不依赖 process.cwd()——cwd 由 vitest 启动
 * 位置决定（IDE「运行全部测试」/ 仓库根直接跑 npx vitest 都不是 apps/desktop），
 * 而 cwd 漂移会让 ts.readConfigFile 返回 `{config:{}}`（**空对象不是 undefined，
 * 不抛错**）→ parseJsonConfigFileContent 从空 raw 起步产出 TypeScript 默认选项
 * → 无 jsx 无 paths，四个 checkGenerated 调用点全部报出误导性的 TS17004 + TS2307，
 * 看上去像生成物坏了。同目录 axRegistryCrossCheck.test.ts 已为样稿做过同样的
 * dirname 锚定（其注释记录过「少一级解析到 apps/.pen/，守门用例静默空转」）。
 */
const PACKAGE_ROOT = resolve(import.meta.dirname, '../../../..')

const checkGenerated = (sources: string[]): string[] => {
  const configPath = resolve(PACKAGE_ROOT, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  // 读不到配置不是「降级继续」，是门禁失效——直抛，否则错误会以生成物的名义误导。
  if (config.error) {
    throw new Error(`readConfigFile(${configPath}) 失败：${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`)
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_ROOT)
  if (parsed.errors.length > 0) {
    throw new Error(`parseJsonConfigFileContent(${configPath}) 失败：${parsed.errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('; ')}`)
  }
  // 兜底护栏：门禁的两个前提开关必须真的生效——即便将来配置读取再次退化，
  // 也要在这里以「门禁没生效」报错，而不是以「生成物不合法」误导。
  if (parsed.options.jsx === undefined || parsed.options.paths?.['@/*'] === undefined) {
    throw new Error(`tsconfig ${configPath} 未生效 jsx/paths：jsx=${String(parsed.options.jsx)} paths=${JSON.stringify(parsed.options.paths)}`)
  }
  const files = new Map(sources.map((source, index) => [resolve(PACKAGE_ROOT, `src/GeneratedDesignContract${index}.tsx`), source]))
  const host = ts.createCompilerHost(parsed.options)
  const original = host.getSourceFile
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = files.get(name)
    return source === undefined ? original(name, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TSX)
  }
  const program = ts.createProgram([...files.keys()], parsed.options, host)
  return ts.getPreEmitDiagnostics(program)
    .filter((item) => !item.file || files.has(item.file.fileName))
    .map((item) => `${item.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`)
}

describe('emitAxPageToTsx 真实实现契约', () => {
  it('fixture 驱动组件、属性覆盖与必填回调生成代码通过 strict 类型检查', () => {
    const resultDetail = axComponentDetailOf('ResultChip')!
    const actionsDetail = axComponentDetailOf('MessageActions')!
    const document: AxDocument = {
      ax: '1.3', tokens: {}, components: { ResultChip: {}, MessageActions: {} },
      pages: [{ id: 'compiled', name: 'Compiled', width: 1180, height: 780, tree: [
        { id: 'result', kind: 'component', name: 'ResultChip', fixture: 'completed' },
        { id: 'actions', kind: 'component', name: 'MessageActions', fixture: 'agent-message', props: { text: { $mock: "a'b\n<c>" } } },
        { id: 'bound', kind: 'component', name: 'ResultChip', props: { message: { $bind: 'session.result' } } },
      ] }],
    }
    const result = emitAxPageToTsx(document, 'compiled', {
      componentImports: {
        ResultChip: { from: '@/components/session/ResultChip' },
        MessageActions: { from: '@/components/session/MessageActions' },
      },
      componentDetails: { ResultChip: resultDetail, MessageActions: actionsDetail },
    })!
    expect(result.code).toContain('message={{')
    expect(result.code).toContain("onBranch={bindings['actions.onBranch']}")
    expect(result.code).toContain("message={bindings['bound.message']}")
    expect(result.unresolved.filter((item) => item.kind === 'component(callback)')).toHaveLength(4)
    expect(result.code).toContain("width: '100%'")
    expect(result.code).not.toContain("width: '1180px'")
    expect(checkGenerated([result.code])).toEqual([])
  }, 60_000)

  it.skipIf(!designDraftsAvailable)('仓库 Axiom 设计稿通过组件清单校验，全部页面的生成代码可编译', () => {
    const inventory = axComponentInventorySummary()
    const parsed = parseAxDocument(readDesignDraft('axiom.ax'), { componentInventory: inventory })
    expect(parsed.diagnostics.filter((item) => item.level === 'error')).toEqual([])
    if (!parsed.document) throw new Error(parsed.error ?? 'invalid design document')
    const options = {
      componentImports: Object.fromEntries(inventory.map((entry) => [entry.name, { from: `@/${entry.sourcePath.replace(/\.tsx?$/, '')}` }])),
      componentDetails: Object.fromEntries(inventory.map((entry) => [entry.name, axComponentDetailOf(entry.name)!])),
    }
    // native-components.ax 与 symbol-showcase.ax 已并入 .pen/axiom.ax（2026-10-11
    // 三稿合一），不再单独读取：对应页面与 symbol 均由 parsed.document 覆盖。
    // symbol 展示页的局部组件发射（typed props + 参数表达式 + 实例引用）仍由
    // 下面这行锁死类型正确性。
    const showcaseResult = emitAxPageToTsx(parsed.document, 'p-dashboard', options)!
    expect(showcaseResult.code).toContain('const TableRow = ({ col1, col2, col3, col4 }: { col1: string; col2: string; col3: string; col4: string }) => (')
    expect(showcaseResult.counts.symbols).toBe(13)
    // 官网稿（`.pen/axiom-website.ax`，1.4 起带 9 个 symbol）：整稿全页生成代码同样过
    // strict 编译。它不在 `design:verify` 的正式页面覆盖内（那份是 axiom-implementation.ax），
    // 在此之前没有任何自动门禁看护——抽 symbol 这类结构重构只能靠一次性对拍，这条用例
    // 把它纳入「改坏就红」的范围，同时锁住 symbol 发射的类型正确性。
    const website = parseAxDocument(readDesignDraft('axiom-website.ax'), { componentInventory: inventory })
    expect(website.diagnostics.filter((item) => item.level === 'error')).toEqual([])
    if (!website.document) throw new Error(website.error ?? 'invalid website design document')
    // 稿覆盖面：axiom.ax（主稿）——2026-10-11 三稿合一后，它同时承载设计总览、
    // 原生组件状态样例与 symbol 展示页；外加 axiom-website.ax（官网稿）。
    // 对拍门禁 `design:verify:axiom` 与 `npm run audit:design-axiom` 的稿件输入现同为
    // .pen/axiom.ax（.axiom/design/verification.json 的 file 字段），其受检页面是
    // axiom.ax 中带实现路由的子集。
    const sources = [parsed.document, website.document].flatMap((document) => document.pages.map((page) => emitAxPageToTsx(document, page.id, options)!.code))
    expect(checkGenerated([...sources, showcaseResult.code])).toEqual([])
  }, 120_000)

  it('新增六个原生组件的全部 fixture 生成代码通过真实 strict 编译', () => {
    const names = ['WindowActions', 'SettingsNavigation', 'SettingsTopBar', 'FeedbackDialog', 'SummaryInstructionsDialog', 'BuiltinPromptEditorDialog']
    const inventory = axComponentInventorySummary().filter((entry) => names.includes(entry.name))
    const options = {
      componentImports: Object.fromEntries(inventory.map((entry) => [entry.name, { from: `@/${entry.sourcePath.replace(/\.tsx?$/, '')}` }])),
      componentDetails: Object.fromEntries(inventory.map((entry) => [entry.name, axComponentDetailOf(entry.name)!])),
    }
    const doc: AxDocument = { ax: '1.3', tokens: {}, components: Object.fromEntries(names.map((name) => [name, {}])), pages: [{ id: 'native', tree: inventory.flatMap((entry) => entry.fixtures.map((fixture) => ({ id: `${entry.name}-${fixture}`, kind: 'component' as const, name: entry.name, fixture }))) }] }
    expect(checkGenerated([emitAxPageToTsx(doc, 'native', options)!.code])).toEqual([])
  }, 60_000)

  it('slots 契约直译：PausedBanner 的 slot 内容发射为 children 并移出 unresolved', () => {
    const bannerDetail = axComponentDetailOf('PausedBanner')!
    expect(bannerDetail.slots).toEqual({ default: { prop: 'children' } })
    const document: AxDocument = {
      ax: '1.5', tokens: {}, components: { PausedBanner: { slots: { default: { prop: 'children' } } } },
      pages: [{ id: 'slotted', width: 800, height: 600, tree: [
        { id: 'b1', kind: 'component', name: 'PausedBanner', fixture: 'default',
          slot: [{ id: 's1', kind: 'text', text: '队列已暂停：2 条待发', wrap: 'nowrap' }] },
      ] }],
    }
    const result = emitAxPageToTsx(document, 'slotted', {
      componentImports: { PausedBanner: { from: '@/components/session/PausedBanner' } },
      componentDetails: { PausedBanner: bannerDetail },
    })!
    expect(result.unresolved.some((item) => item.kind === 'component(slot)')).toBe(false)
    expect(result.code).toContain('<PausedBanner')
    expect(result.code).toContain('队列已暂停：2 条待发')
    // 插槽内容进真实 children 生成物，过 strict 编译。
    expect(checkGenerated([result.code])).toEqual([])
  }, 60_000)

  it('缺少契约与未映射插槽必须报告，不静默生成 children', () => {
    const doc: AxDocument = {
      ax: '1.3', tokens: {}, components: { ResultChip: {} },
      pages: [{ id: 'p', tree: [{ id: 'c', kind: 'component', name: 'ResultChip', slot: [
        { id: 'slot', kind: 'text', text: 'slot', wrap: 'nowrap' },
      ] }] }],
    }
    const result = emitAxPageToTsx(doc, 'p')!
    expect(result.unresolved.some((item) => item.kind === 'component(slot)')).toBe(true)
    expect(result.unresolved.some((item) => item.reason.includes('完整契约'))).toBe(true)
    expect(result.code).not.toContain('>slot<')
  })
})
