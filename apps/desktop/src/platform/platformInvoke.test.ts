import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./environment', () => ({ isTauriRuntime: mocks.isTauriRuntime }))

import {
  deleteSecret,
  hasSecret,
  loadProviderSecretCleanupIntent,
  migrateSecret,
  persistProviderSecretCleanupIntent,
  saveSecret,
} from './secrets'
import {
  listAuthorizedReadFiles,
  readAuthorizedText,
  revokeAuthorizedReadFile,
  selectAndAuthorizeReadFile,
} from './authorizedFiles'
import {
  getArtifactStorageStats,
  readArtifact,
  reconcileArtifacts,
  trashArtifacts,
  writeToolResultArtifact,
} from './artifacts'
import { getRuntimeInfo } from './runtimeInfo'

beforeEach(() => {
  mocks.isTauriRuntime.mockReturnValue(true)
  mocks.invoke.mockReset()
})

describe('platform secrets (Keychain IPC)', () => {
  it('forwards key/value payloads to the native secret commands', async () => {
    mocks.invoke.mockResolvedValueOnce(undefined)
    await saveSecret('provider.anthropic.key', 'sk-secret')
    expect(mocks.invoke).toHaveBeenCalledWith('save_secret', { key: 'provider.anthropic.key', value: 'sk-secret' })

    mocks.invoke.mockResolvedValueOnce(true)
    await expect(hasSecret('k')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('has_secret', { key: 'k' })

    mocks.invoke.mockResolvedValueOnce(true)
    await expect(migrateSecret('old', 'new')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('migrate_secret', { sourceKey: 'old', targetKey: 'new' })

    mocks.invoke.mockResolvedValueOnce(undefined)
    await deleteSecret('k')
    expect(mocks.invoke).toHaveBeenCalledWith('delete_secret', { key: 'k' })

    mocks.invoke.mockResolvedValueOnce(['a'])
    await expect(loadProviderSecretCleanupIntent()).resolves.toEqual(['a'])
    expect(mocks.invoke).toHaveBeenCalledWith('load_provider_secret_cleanup_intent')

    mocks.invoke.mockResolvedValueOnce(undefined)
    await persistProviderSecretCleanupIntent(['a', 'b'])
    expect(mocks.invoke).toHaveBeenCalledWith('persist_provider_secret_cleanup_intent', { sourceSecretIds: ['a', 'b'] })
  })

  it('refuses to run outside the desktop runtime', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(saveSecret('k', 'v')).rejects.toThrow('仅在 Axiom 桌面应用中可用')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('platform authorized files', () => {
  it('forwards read authorization IPC calls', async () => {
    mocks.invoke.mockResolvedValueOnce([])
    await expect(listAuthorizedReadFiles()).resolves.toEqual([])
    expect(mocks.invoke).toHaveBeenCalledWith('list_authorized_read_files')

    mocks.invoke.mockResolvedValueOnce(true)
    await expect(revokeAuthorizedReadFile('/a.ts')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('revoke_authorized_read_file', { path: '/a.ts' })

    mocks.invoke.mockResolvedValueOnce({ file: { path: '/a.ts', name: 'a.ts', sizeBytes: 1 }, content: 'x' })
    await expect(readAuthorizedText('/a.ts')).resolves.toMatchObject({ content: 'x' })
    expect(mocks.invoke).toHaveBeenCalledWith('read_authorized_text', { path: '/a.ts' })
  })

  it('returns null when the native file picker is cancelled', async () => {
    // 选择与授权合并为单个 Rust 侧命令：WebView 不再传递任何路径。
    mocks.invoke.mockResolvedValueOnce(null)
    await expect(selectAndAuthorizeReadFile()).resolves.toBeNull()
    expect(mocks.invoke).toHaveBeenCalledWith('pick_and_authorize_read_file')
  })

  it('authorizes via the Rust-side picker command without passing a path', async () => {
    mocks.invoke.mockResolvedValueOnce({ path: '/selected/a.ts', name: 'a.ts', sizeBytes: 3 })
    await expect(selectAndAuthorizeReadFile()).resolves.toEqual({ path: '/selected/a.ts', name: 'a.ts', sizeBytes: 3 })
    expect(mocks.invoke).toHaveBeenCalledWith('pick_and_authorize_read_file')
  })
})

describe('platform artifacts (content-addressed storage IPC)', () => {
  it('detects JSON artifact kinds and forwards write requests', async () => {
    mocks.invoke.mockResolvedValueOnce({ kind: 'artifact', contentHash: 'h', sizeBytes: 2 })
    await writeToolResultArtifact({ runId: 'r', toolCallId: 'c', toolName: 'ls', content: '{}' })
    expect(mocks.invoke).toHaveBeenCalledWith('write_artifact', {
      request: expect.objectContaining({ kind: 'json', mediaType: 'application/json', encoding: 'utf8' }),
    })

    mocks.invoke.mockResolvedValueOnce({ kind: 'artifact', contentHash: 'h2', sizeBytes: 3 })
    await writeToolResultArtifact({ runId: 'r', toolCallId: 'c', toolName: 'ls', content: 'plain' })
    expect(mocks.invoke).toHaveBeenCalledWith('write_artifact', {
      request: expect.objectContaining({ kind: 'text', mediaType: 'text/plain;charset=utf-8' }),
    })
  })

  it('forwards read/trash/reconcile/stats requests', async () => {
    mocks.invoke.mockResolvedValueOnce({ contentBase64: 'x', contentHash: 'h', sizeBytes: 1, recoveredFromTrash: false })
    const artifactRef = {
      id: 'a-1',
      kind: 'text' as const,
      mediaType: 'text/plain;charset=utf-8',
      relativePath: 'a.txt',
      contentHash: 'h',
      sizeBytes: 1,
      createdAt: 1,
    }
    await readArtifact(artifactRef)
    expect(mocks.invoke).toHaveBeenCalledWith('read_artifact', { request: { contentHash: 'h' } })

    mocks.invoke.mockResolvedValueOnce(2)
    await expect(trashArtifacts(['a', 'b'])).resolves.toBe(2)
    expect(mocks.invoke).toHaveBeenCalledWith('trash_artifacts', { request: { contentHashes: ['a', 'b'] } })

    mocks.invoke.mockResolvedValueOnce({ restored: 0, trashed: 0, purged: 0 })
    await reconcileArtifacts([])
    expect(mocks.invoke).toHaveBeenCalledWith('reconcile_artifacts', { request: { referencedHashes: [] } })

    mocks.invoke.mockResolvedValueOnce({ activeCount: 1, activeBytes: 2, trashCount: 3, trashBytes: 4 })
    await expect(getArtifactStorageStats()).resolves.toEqual({ activeCount: 1, activeBytes: 2, trashCount: 3, trashBytes: 4 })
  })

  it('short-circuits trashing an empty hash list without invoking Rust', async () => {
    await expect(trashArtifacts([])).resolves.toBe(0)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('platform runtime info', () => {
  it('reads native runtime info when hosted by Tauri', async () => {
    mocks.isTauriRuntime.mockReturnValue(true)
    mocks.invoke.mockResolvedValueOnce({ appName: 'Axiom', appVersion: '0.1.0', operatingSystem: 'macos', architecture: 'aarch64' })
    await expect(getRuntimeInfo()).resolves.toEqual({
      appName: 'Axiom', appVersion: '0.1.0', operatingSystem: 'macos', architecture: 'aarch64',
    })
    expect(mocks.invoke).toHaveBeenCalledWith('get_runtime_info')
  })

  it('falls back to browser demo metadata outside the desktop runtime', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(getRuntimeInfo()).resolves.toMatchObject({ appName: 'Axiom', appVersion: 'browser-dev' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
