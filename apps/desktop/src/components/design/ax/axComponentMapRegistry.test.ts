// @vitest-environment node
/**
 * 映射表 ↔ 组件注册表 的一致性（docs/ax-format.md §4.1 规则 1 的**编译期**兜底）。
 *
 * 为什么放在 `components/design/ax/`：映射表在 `agent/design`（不许反向依赖 components），
 * 注册表在这里。只有两边都能看见的测试才能核对「映射表指向的组件在注册表里真的存在、
 * props 与 fixture 名字都对得上」——这是升级路径最容易悄悄漂的地方（改个 props 名，
 * 升级产物就在画布上变成红框，而单测全绿）。
 */
import { describe, expect, it } from 'vitest'
import { AX_COMPONENT_REGISTRY } from './registry'
import {
  axDeferredPenComponentNames,
  axInstanceOfPenComponent,
  axMappedPenComponentNames,
  axMappedRegistryComponentNames,
} from '@/agent/design/axComponentMap'

/** 真实的稿里出现过的实例形态（含工具卡的两种文案形），用于把所有分支都走一遍。 */
const CONTEXTS = [
  { texts: [] },
  { texts: ['Read docs/implementation-plan.md', '2.1 KB'] },
  { texts: ['Edit apps/desktop/src/App.tsx', '+128', '−44'] },
  { texts: ['读完了', '2.1 KB'] },
]
const VARIANTS = [undefined, 'User', 'Agent', 'Bogus']

describe('升级映射表与组件注册表', () => {
  it('映射面覆盖的组件都在注册表里', () => {
    const targets = axMappedRegistryComponentNames()
    expect(targets.length).toBeGreaterThan(0)
    for (const name of targets) {
      expect(AX_COMPONENT_REGISTRY[name], `注册表缺组件 ${name}`).toBeDefined()
    }
  })

  it('实例给出的 props 键、词汇表 props 键与 fixture 名都在注册表契约内', () => {
    for (const penName of axMappedPenComponentNames()) {
      for (const variant of VARIANTS) {
        for (const context of CONTEXTS) {
          const result = axInstanceOfPenComponent(`component/${penName}`, { ...context, variant })
          if (!result || 'defer' in result) continue
          const entry = AX_COMPONENT_REGISTRY[result.component]
          expect(entry, `${penName} → ${result.component} 不在注册表`).toBeDefined()
          if (!entry) continue
          for (const key of Object.keys(result.props ?? {})) {
            expect(
              Object.hasOwn(entry.props, key),
              `${penName}: props.${key} 未在 ${result.component} 的注册表契约里声明`,
            ).toBe(true)
          }
          for (const key of Object.keys(result.decl.props ?? {})) {
            expect(
              Object.hasOwn(entry.props, key),
              `${penName}: 词汇表声明的 props.${key} 未在 ${result.component} 的注册表契约里声明`,
            ).toBe(true)
          }
          if (result.fixture !== undefined) {
            expect(
              Object.hasOwn(entry.fixtures, result.fixture),
              `${penName}: fixture「${result.fixture}」不在 ${result.component} 的 fixtures 里`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('延后清单里的组件名不与映射面重叠，且每条都仍能给出原因', () => {
    const mapped = new Set(axMappedPenComponentNames())
    for (const name of axDeferredPenComponentNames()) {
      expect(mapped.has(name), `${name} 同时出现在映射表与延后清单`).toBe(false)
      const result = axInstanceOfPenComponent(`component/${name}`, { texts: [] })
      // 延后项**不能**被映射表悄悄接住：必须返回 null（未登记）或 defer（登记但升不了）。
      expect(result === null || 'defer' in result, `${name} 出现在延后清单却被升级了`).toBe(true)
    }
  })
})
