import { describe, expect, it } from 'vitest'
import { extractComponentUsage, stripCodeNoise } from './implementationUsage'

describe('stripCodeNoise（注释与字符串剥离）', () => {
  it('注释与字符串替换为等长空白，代码与换行保留', () => {
    const source = [
      "const a = 'x <ApprovalCard y' // <ApprovalCard 注释",
      '/* 块注释 <Sidebar */ const b = 1',
      'const c = `模板 <Composer`',
    ].join('\n')
    const stripped = stripCodeNoise(source)
    expect(stripped).toHaveLength(source.length)
    expect(stripped).not.toContain('ApprovalCard')
    expect(stripped).not.toContain('Sidebar')
    expect(stripped).not.toContain('Composer')
    // 代码部分保留：标识符与结构仍在。
    expect(stripped).toContain('const a =')
    expect(stripped).toContain('const b = 1')
    expect(stripped.split('\n')).toHaveLength(3)
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: 测试样例刻意把 ${ 片段写进普通字符串，验证剥离器对模板嵌套的处理
  it('模板字面量的 ${} 内嵌代码回到 code 态（可被提取），模板主体仍剥离', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上——fixture 本身就要包含 ${ 形态
    const source = 'const t = `外层 <Foo ${<Bar /> } 尾`'
    const stripped = stripCodeNoise(source)
    expect(stripped).toContain('<Bar')
    expect(stripped).not.toContain('<Foo')
  })

  it('转义字符不提前终止字符串', () => {
    const source = "const s = 'it\\'s <Foo'; <Bar />"
    const stripped = stripCodeNoise(source)
    expect(stripped).toContain('<Bar')
    expect(stripped).not.toContain('<Foo')
  })
})

describe('extractComponentUsage（实现源码的组件使用提取）', () => {
  const NAMES = ['ApprovalCard', 'Sidebar', 'Composer', 'ResultChip']

  it('import 具名与 JSX 开标签计数；字符串/注释里的不算', () => {
    const source = [
      "import { ApprovalCard, Sidebar as SidePanel } from '@/components'",
      'export const A = () => (',
      '  <SidePanel>',
      '    <ApprovalCard command="npm test" />',
      '    <ApprovalCard command="ls" />',
      '  </SidePanel>',
      ')',
      "// 迷惑项：<ApprovalCard />",
      "const decoy = '<ApprovalCard>'",
    ].join('\n')
    const usage = extractComponentUsage(source, NAMES)
    expect(usage.get('ApprovalCard')).toEqual({ imports: 1, jsxUses: 2 })
    // 别名导入：import 记本名，JSX 用别名也经映射记到本名。
    expect(usage.get('Sidebar')).toEqual({ imports: 1, jsxUses: 1 })
    expect(usage.has('SidePanel')).toBe(false)
    expect(usage.has('Composer')).toBe(false)
  })

  it('闭合标签与成员表达式不算使用；小写元素不参与', () => {
    const source = [
      'export const A = () => (',
      '  <ApprovalCard>',
      '    <ApprovalCard.Header />',
      '  </ApprovalCard>',
      ')',
    ].join('\n')
    const usage = extractComponentUsage(source, NAMES)
    expect(usage.get('ApprovalCard')).toEqual({ imports: 0, jsxUses: 1 })
  })

  it('目标名之外的大写组件不计', () => {
    const usage = extractComponentUsage('export const A = () => <UnknownThing />', NAMES)
    expect(usage.size).toBe(0)
  })
})
