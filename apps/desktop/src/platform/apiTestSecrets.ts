import { invoke } from '@tauri-apps/api/core'

export const saveApiTestSecret = (key: string, value: string): Promise<void> =>
  invoke<void>('save_api_test_secret', { key, value })

export const hasApiTestSecret = (key: string): Promise<boolean> =>
  invoke<boolean>('has_api_test_secret', { key })

export const deleteApiTestSecret = (key: string): Promise<void> =>
  invoke<void>('delete_api_test_secret', { key })
