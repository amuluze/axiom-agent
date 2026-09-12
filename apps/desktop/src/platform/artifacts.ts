import type {
  ArtifactKind,
  ArtifactReference,
  ToolResultArtifactRequest,
} from '@/agent/core/types'
import { invoke } from '@tauri-apps/api/core'

export interface ArtifactContent {
  contentBase64: string
  contentHash: string
  sizeBytes: number
  recoveredFromTrash: boolean
}

export interface ArtifactReconcileResult {
  restored: number
  trashed: number
  purged: number
}

export interface ArtifactGcResult {
  reconciled: ArtifactReconcileResult
  activeBytesBefore: number
  activeBytesAfter: number
}

export interface ArtifactStorageStats {
  activeCount: number
  activeBytes: number
  trashCount: number
  trashBytes: number
}

const detectTextKind = (content: string): { kind: ArtifactKind; mediaType: string } => {
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed === 'object' && parsed !== null) {
      return { kind: 'json', mediaType: 'application/json' }
    }
  } catch {
    // Plain text remains a text artifact.
  }
  return { kind: 'text', mediaType: 'text/plain;charset=utf-8' }
}

export const writeToolResultArtifact = async (
  request: ToolResultArtifactRequest,
): Promise<ArtifactReference> => {
  const detected = detectTextKind(request.content)
  return invoke<ArtifactReference>('write_artifact', {
    request: {
      content: request.content,
      encoding: 'utf8',
      kind: detected.kind,
      mediaType: detected.mediaType,
      createdAt: Date.now(),
    },
  })
}

export const readArtifact = (artifact: ArtifactReference): Promise<ArtifactContent> =>
  invoke<ArtifactContent>('read_artifact', {
    request: { contentHash: artifact.contentHash },
  })

export const trashArtifacts = (contentHashes: string[]): Promise<number> =>
  contentHashes.length === 0
    ? Promise.resolve(0)
    : invoke<number>('trash_artifacts', { request: { contentHashes } })

export const reconcileArtifacts = (referencedHashes: string[]): Promise<ArtifactReconcileResult> =>
  invoke<ArtifactReconcileResult>('reconcile_artifacts', {
    request: { referencedHashes },
  })

/**
 * 归档清理（GC）：Rust 侧以权威引用集（全部消息 + 恢复点 manifest + 审计 diff 包）回收
 * 未引用 Artifact。只读的引用收集在 Rust 完成，前端无需传引用集。
 */
export const gcArtifacts = (): Promise<ArtifactGcResult> =>
  invoke<ArtifactGcResult>('gc_artifacts')

export const getArtifactStorageStats = (): Promise<ArtifactStorageStats> =>
  invoke<ArtifactStorageStats>('get_artifact_storage_stats')
