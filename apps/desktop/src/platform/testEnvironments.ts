import { invoke } from '@tauri-apps/api/core'
import { commands } from './bindings'
import type { EnvironmentMode } from '@/agent/testing/environment/environmentFile'

export interface TestEnvironmentRecord {
  id: string
  name: string
  /** 环境档类型：`local` 带起停配方，`remote` 只做只读校验（SQLite CHECK 保证取值）。 */
  kind: EnvironmentMode
  /** 起停与就绪配方的 JSON（T1-1 起由环境档导入写入），没有配方时为 null。 */
  recipeJson: string | null
  webBaseUrl: string | null
  apiBaseUrl: string | null
  viewportWidth: number | null
  viewportHeight: number | null
  allowPrivateNetwork: boolean
  headersJson: string
  secretIdsJson: string
  createdAt: number
  updatedAt: number
}

export interface SaveTestEnvironmentRecord {
  id: string
  name: string
  /** 缺省即 `remote`：不带该字段的调用方与升级前语义一致。 */
  kind?: EnvironmentMode
  recipeJson?: string | null
  webBaseUrl?: string
  apiBaseUrl?: string
  viewportWidth?: number
  viewportHeight?: number
  allowPrivateNetwork: boolean
  headersJson: string
  secretIdsJson: string
  updatedAt: number
}

export const saveTestEnvironmentRecord = (environment: SaveTestEnvironmentRecord): Promise<boolean> =>
  invoke<boolean>('save_test_environment_record', {
    environment: {
      ...environment,
      webBaseUrl: environment.webBaseUrl ?? null,
      apiBaseUrl: environment.apiBaseUrl ?? null,
      viewportWidth: environment.viewportWidth ?? null,
      viewportHeight: environment.viewportHeight ?? null,
      recipeJson: environment.recipeJson ?? null,
    },
  })

export const listTestEnvironmentRecords = async (): Promise<TestEnvironmentRecord[]> => {
  const records = await commands.listTestEnvironmentRecords()
  return records.map((record) => ({ ...record, kind: record.kind as EnvironmentMode }))
}

export const deleteTestEnvironmentRecord = (environmentId: string): Promise<boolean> =>
  invoke<boolean>('delete_test_environment_record', { environmentId })
