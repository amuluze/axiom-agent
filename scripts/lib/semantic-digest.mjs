// 语义版本契约的 semanticDigest 计算（单一实现）。
// 与 apps/desktop/src/agent/runtime/runtimeSemanticVersions.test.ts 的
// semanticSourceDigest 逐字节一致：对 sourceFiles 排序后逐个 `文件路径\0内容\0` 累积。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 计算一组源文件的语义指纹（sha256）。sourceFiles 为相对 apps/desktop 的路径。
 * @param {string[]} sourceFiles
 * @param {string} appBase apps/desktop 绝对路径
 * @returns {string}
 */
export const semanticSourceDigest = (sourceFiles, appBase) => {
  const digest = createHash('sha256')
  for (const sourceFile of sourceFiles.slice().sort()) {
    digest.update(sourceFile)
    digest.update('\0')
    digest.update(readFileSync(path.join(appBase, sourceFile), 'utf8').replace(/\r\n/gu, '\n'))
    digest.update('\0')
  }
  return digest.digest('hex')
}
