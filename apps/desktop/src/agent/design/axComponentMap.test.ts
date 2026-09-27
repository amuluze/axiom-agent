// @vitest-environment node
/**
 * `.pen → .ax` 组件升级映射表的单测（docs/ax-format.md §6 P1）。
 *
 * 三件事在这里锁死：
 * 1. **识别**：`component/X · Variant` 的解析（实例来源由 `penParser` 记在
 *    `refComponentName` 上，本表只认这个名字，不认几何/命名习惯）；
 * 2. **反推 props 的边界**：工具卡的 path/字节数/增删行数都从稿里的文案反推——
 *    反推不出来必须 `defer`（回落 primitive），**不许**发一张内容错的卡；
 * 3. **映射面可枚举**：登记项要么给出实例，要么给出「升不了的原因」，两者都带目标
 *    组件名，注册表侧的一致性核对因此可以自动化（见 components/design/ax 下的用例）。
 */
import { describe, expect, it } from 'vitest'
import {
  AX_DEFERRED_PEN_COMPONENTS,
  axDeferReasonOfPenComponent,
  axInstanceOfPenComponent,
  axMappedPenComponentNames,
  axMappedRegistryComponentNames,
  penComponentIdentityOf,
} from './axComponentMap'

describe('penComponentIdentityOf', () => {
  it('解析 `component/<名> · <变体>`，语言后缀也是变体', () => {
    expect(penComponentIdentityOf('component/Sidebar · zh-CN')).toEqual({ name: 'Sidebar', variant: 'zh-CN' })
    expect(penComponentIdentityOf('component/Message Actions · Agent')).toEqual({ name: 'Message Actions', variant: 'Agent' })
    expect(penComponentIdentityOf('component/Approval Card')).toEqual({ name: 'Approval Card' })
  })

  it('非组件命名一律不认（普通 frame 的 name 不在映射面上）', () => {
    expect(penComponentIdentityOf('Sidebar')).toBeNull()
    expect(penComponentIdentityOf('Task List')).toBeNull()
    expect(penComponentIdentityOf('component/')).toBeNull()
  })
})

describe('axInstanceOfPenComponent', () => {
  it('审批卡：store 绑定组件用 fixture 提供预览态数据，节点自身不带 props', () => {
    const instance = axInstanceOfPenComponent('component/Approval Card', { texts: [] })
    expect(instance).toEqual({ component: 'ApprovalCard', decl: { props: {} }, fixture: 'pending-command' })
  })

  it('消息操作行：变体决定 role 与 fixture', () => {
    expect(axInstanceOfPenComponent('component/Message Actions · User', { texts: [] })).toMatchObject({
      component: 'MessageActions',
      props: { role: { $mock: 'user' } },
      fixture: 'user-message',
    })
    expect(axInstanceOfPenComponent('component/Message Actions · Agent', { texts: [] })).toMatchObject({
      props: { role: { $mock: 'assistant' } },
      fixture: 'agent-message',
    })
  })

  it('消息操作行：未登记的变体返回 null（不猜 role）', () => {
    expect(axInstanceOfPenComponent('component/Message Actions · Bogus', { texts: [] })).toBeNull()
    expect(axInstanceOfPenComponent('component/Message Actions', { texts: [] })).toBeNull()
  })

  it('工具卡（读）：标题取 path、右侧文案取字节数，合成 call/result', () => {
    const instance = axInstanceOfPenComponent('component/Tool Call Read', {
      texts: ['Read docs/implementation-plan.md', '2.1 KB'],
    })
    expect(instance).not.toBeNull()
    if (!instance || 'defer' in instance) throw new Error('预期升级成功')
    expect(instance.component).toBe('ToolCallCard')
    const props = instance.props as Record<string, { $mock: Record<string, unknown> }>
    expect(props.toolName).toEqual({ $mock: 'read' })
    // 标题与字节数必须**来自稿里**：真组件按 args.path 渲染 `Read <path>`、
    // 按 details.sizeBytes 渲染 `2.1 KB` —— 与稿同形是这条映射成立的判据。
    const call = props.call?.$mock as { toolCalls: { arguments: { path: string } }[] }
    expect(call.toolCalls[0]?.arguments.path).toBe('docs/implementation-plan.md')
    const result = props.result?.$mock as { details: Record<string, number> }
    expect(result.details.sizeBytes).toBe(Math.round(2.1 * 1024))
  })

  it('工具卡（编辑）：`+128` / `−44` 取成增删行数', () => {
    const instance = axInstanceOfPenComponent('component/Tool Call Edit', {
      texts: ['Edit apps/desktop/src/App.tsx', '+128', '−44'],
    })
    if (!instance || 'defer' in instance) throw new Error('预期升级成功')
    const props = instance.props as Record<string, { $mock: Record<string, unknown> }>
    expect(props.toolName).toEqual({ $mock: 'edit' })
    const editResult = props.result as { $mock: { details: Record<string, number> } }
    expect(editResult.$mock.details).toEqual({
      diffAdded: 128,
      diffRemoved: 44,
    })
  })

  it('工具卡：标题不合 `<动词> <路径>` 形时 defer（宁可留 primitive，不发内容错的卡）', () => {
    const instance = axInstanceOfPenComponent('component/Tool Call Read', { texts: ['读完了', '2.1 KB'] })
    expect(instance).not.toBeNull()
    expect(instance && 'defer' in instance).toBe(true)
    if (!instance || !('defer' in instance)) throw new Error('预期 defer')
    expect(instance.component).toBe('ToolCallCard')
    expect(instance.defer).toContain('读完了')
  })
})

describe('映射面与延后清单', () => {
  it('两个清单互不相交（一个组件不能既升级又延后）', () => {
    const deferred = new Set(Object.keys(AX_DEFERRED_PEN_COMPONENTS))
    expect(axMappedPenComponentNames().filter((name) => deferred.has(name))).toEqual([])
  })

  it('延后项都带非空原因', () => {
    for (const [name, reason] of Object.entries(AX_DEFERRED_PEN_COMPONENTS)) {
      expect(reason.length, `${name} 的原因太短`).toBeGreaterThan(10)
      expect(axDeferReasonOfPenComponent(`component/${name}`)).toBe(reason)
    }
  })

  it('映射面覆盖的注册表组件名可枚举（供注册表一致性用例核对）', () => {
    // Sidebar/Composer 升级后映射面覆盖 5 个注册表组件（多 store 切片接缝落地）。
    expect(axMappedRegistryComponentNames())
      .toEqual(['ApprovalCard', 'Composer', 'MessageActions', 'Sidebar', 'ToolCallCard'])
  })
})
