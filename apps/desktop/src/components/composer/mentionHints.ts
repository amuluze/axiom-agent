/**
 * 手动引用候选的副标题：省略到「父目录末两段」，避免完整绝对路径挤占候选行
 * ——工作区检索候选的副标题是扩展名 /「目录」，两者视觉体量需要一致。
 * 无父目录（纯文件名）时返回空串，调用方按「无副标题」渲染。
 */
export const compactParentHint = (filePath: string, segments = 2): string => {
  const parts = filePath.replace(/\/+$/u, '').split('/').filter((part) => part.length > 0)
  if (parts.length <= 1) return ''
  const parent = parts.slice(0, -1)
  const tail = parent.slice(-segments)
  return `${parent.length > segments ? '…/' : '/'}${tail.join('/')}`
}
