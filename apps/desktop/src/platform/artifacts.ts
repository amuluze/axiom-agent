import type {
  ArtifactKind,
  ArtifactReference,
  ToolResultArtifactRequest,
} from '@/agent/core/types'
import { invoke } from '@tauri-apps/api/core'
import { decodeBase64ToBytes } from './base64'

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

export const writeJsonArtifact = async (content: string): Promise<ArtifactReference> => {
  JSON.parse(content)
  return invoke<ArtifactReference>('write_artifact', {
    request: {
      content,
      encoding: 'utf8',
      kind: 'json',
      mediaType: 'application/json',
      createdAt: Date.now(),
    },
  })
}

export const IMAGE_ARTIFACT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type ImageArtifactMediaType = (typeof IMAGE_ARTIFACT_MEDIA_TYPES)[number]

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export interface ImageArtifactRequest {
  contentBase64: string
  /** 入参来自工具结果等外部数据，故以运行时守卫收窄而非信任静态类型。 */
  mediaType: string
}

const isImageMediaType = (value: string): value is ImageArtifactMediaType =>
  (IMAGE_ARTIFACT_MEDIA_TYPES as readonly string[]).includes(value)

/**
 * 写入图片 Artifact。TS 侧只做格式与体积的快速失败；图片魔数（伪造扩展名/MIME）
 * 仍由 Rust `validate_media` 权威校验，前端校验不构成信任依据。
 */
export const writeImageArtifact = async (request: ImageArtifactRequest): Promise<ArtifactReference> => {
  const { contentBase64, mediaType } = request
  if (!isImageMediaType(mediaType)) throw new Error('不支持的图片类型')
  if (contentBase64.length === 0 || contentBase64.length % 4 !== 0 || !BASE64_PATTERN.test(contentBase64)) {
    throw new Error('图片内容不是合法的 Base64')
  }
  const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0
  if ((contentBase64.length / 4) * 3 - padding > MAX_ARTIFACT_BYTES) throw new Error('图片超过 8 MiB 安全上限')
  return invoke<ArtifactReference>('write_artifact', {
    request: {
      content: contentBase64,
      encoding: 'base64',
      kind: 'image',
      mediaType,
      createdAt: Date.now(),
    },
  })
}

export const readArtifact = (artifact: ArtifactReference): Promise<ArtifactContent> =>
  invoke<ArtifactContent>('read_artifact', {
    request: { contentHash: artifact.contentHash },
  })

/** 按内容 hash 读取 UTF-8 文本 Artifact（测试运行计划快照等）。 */
export const readArtifactText = async (contentHash: string): Promise<string> => {
  const content = await invoke<ArtifactContent>('read_artifact', {
    request: { contentHash },
  })
  return new TextDecoder().decode(decodeBase64ToBytes(content.contentBase64))
}

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
