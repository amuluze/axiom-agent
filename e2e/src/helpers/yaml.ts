import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { z } from 'zod'

/** 读取并通过 zod 契约校验用例文件：非法数据在测试进程启动阶段即失败。 */
export const loadYaml = <S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S> => {
  const parsed = schema.safeParse(parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    )
    throw new Error(`${path} 不符合 src/types/cases.ts 契约：\n${lines.join('\n')}`)
  }
  return parsed.data
}
