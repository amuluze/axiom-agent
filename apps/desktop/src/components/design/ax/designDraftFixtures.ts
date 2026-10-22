/**
 * 私仓设计稿（`.pen/`）的测试访问口，同时给出「稿件是否在场」的判据。
 *
 * `.pen/` 不随公开镜像导出（export-public 的导出面只有 apps/desktop 与少量根级文件），
 * 公开快照里依赖真稿的套件因此必须显式 skip（vitest 报告可见），私仓恒在、恒在执行。
 * 判据取**目录**而非具体稿件：路径写错时目录仍在、用例照常红，不会退化成
 * 「静默空转、绿灯毫无含义」（本目录 axRegistryCrossCheck 曾踩过这个坑）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 本文件在 apps/desktop/src/components/design/ax/ 下，到仓库根上溯 6 级。 */
const DESIGN_DRAFTS_ROOT = resolve(import.meta.dirname, '../../../../../../.pen')

export const designDraftsAvailable = existsSync(DESIGN_DRAFTS_ROOT)

export const readDesignDraft = (name: string): string =>
  readFileSync(resolve(DESIGN_DRAFTS_ROOT, name), 'utf8')
