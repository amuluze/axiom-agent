/**
 * 画布编辑的纯函数层（docs/design-canvas.md §11 无限画布）。
 *
 * 编辑目标是**原始 JSON 树**而非解析产物 PenDocument：解析器是有损投影
 * （丢未知字段、展开 ref、剔除 enabled:false），整树序列化会破坏文件。所有
 * 编辑都收敛为对 raw 树的「字段补丁」（DesignEditPatch），只触碰用户改动的
 * 字段——未识别字段、组件定义、descendants 覆写全部原样保留。
 *
 * ref 实例内部节点在 raw 树里不存在（渲染时的子树来自组件定义克隆）：
 * 按 id 定位会命中组件定义本体，直接改会波及全部实例——collectRefNodeIds
 * 把这类 id 交给画布做只读拦截。
 */

/** 原始 JSON 树里的定位路径：对象键（'children' 等）与数组下标交替。 */
export type RawJsonPath = (string | number)[]

export interface DesignEditPatch {
  path: RawJsonPath
  /** 变更前的值（undefined = 原本不存在），供撤销与失败回滚。 */
  before: unknown
  /** 变更后的值（undefined = 删除该位置：数组 splice / 对象 delete）。 */
  after: unknown
}

interface RawRecord {
  [key: string]: unknown
}

const isRawRecord = (value: unknown): value is RawRecord =>
  typeof value === 'object' && value !== null

/** 在原始树里按节点 id 定位（与 findPenNode 同序：先命中先返回）。 */
export const findRawNodePath = (root: unknown, nodeId: string): RawJsonPath | null => {
  if (!isRawRecord(root)) return null
  if (root.id === nodeId) return []
  const children = root.children
  if (!Array.isArray(children)) return null
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!isRawRecord(child)) continue
    const hit = findRawNodePath(child, nodeId)
    if (hit) return ['children', index, ...hit]
  }
  return null
}

/** 按路径读值；容器缺失返回 undefined（与「字段不存在」同形，调用方先定位再读）。 */
export const readAtRaw = (root: unknown, path: RawJsonPath): unknown => {
  let current: unknown = root
  for (const segment of path) {
    if (!isRawRecord(current) && !Array.isArray(current)) return undefined
    current = (current as RawRecord)[segment as string]
  }
  return current
}

/**
 * 把补丁应用到原始树（原地变更）。after=undefined 表示删除：数组下标走
 * splice、对象键走 delete。任一段不可达即返回 false 且**不产生半应用**——
 * 调用方在应用前已用 findRawNodePath 校验过，这里是坏数据兜底。
 */
export const applyPatchToRaw = (root: unknown, patch: DesignEditPatch): boolean => {
  const { path, after } = patch
  if (path.length === 0) return false
  let container: unknown = root
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]
    if (!isRawRecord(container) && !Array.isArray(container)) return false
    container = (container as RawRecord)[segment as string]
  }
  const last = path[path.length - 1]
  if (Array.isArray(container)) {
    if (typeof last !== 'number') return false
    if (after === undefined) {
      if (last < 0 || last >= container.length) return false
      container.splice(last, 1)
      return true
    }
    if (last < 0 || last > container.length) return false
    container[last] = after
    return true
  }
  if (isRawRecord(container) && typeof last === 'string') {
    if (after === undefined) {
      if (!(last in container)) return false
      delete container[last]
      return true
    }
    container[last] = after
    return true
  }
  return false
}

/**
 * 依序应用一组补丁；全部成功返回 true，任一失败会**回滚已应用的部分**
 * （按 before 逆序还原），保证树不被半改。
 */
export const applyPatchesToRaw = (root: unknown, patches: DesignEditPatch[]): boolean => {
  const applied: DesignEditPatch[] = []
  for (const patch of patches) {
    if (applyPatchToRaw(root, patch)) {
      applied.push(patch)
    } else {
      for (const done of applied.reverse()) {
        applyPatchToRaw(root, { path: done.path, before: done.after, after: done.before })
      }
      return false
    }
  }
  return true
}

/** 收集原始树里全部 ref 节点的 id（含组件定义内部的 ref）。 */
export const collectRefNodeIds = (root: unknown): Set<string> => {
  const result = new Set<string>()
  const visit = (value: unknown): void => {
    if (!isRawRecord(value)) return
    if (value.type === 'ref' && typeof value.id === 'string') result.add(value.id)
    if (Array.isArray(value.children)) for (const child of value.children) visit(child)
  }
  visit(root)
  return result
}

/** 写回序列化：2 空格缩进（与 pen.dev 产出一致），保持 git diff 可读。 */
export const serializePenRaw = (raw: unknown): string => JSON.stringify(raw, null, 2)
