import type { ArtifactReference } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { decodeArtifactText, formatArtifactBytes, formatJsonArtifact } from './ArtifactPreview'

const artifact: ArtifactReference = {
  id: `sha256:${'a'.repeat(64)}`,
  kind: 'text',
  mediaType: 'text/plain;charset=utf-8',
  relativePath: `artifacts/sha256/aa/${'a'.repeat(64)}`,
  contentHash: 'a'.repeat(64),
  sizeBytes: 5,
  createdAt: 1,
}

describe('ArtifactPreview helpers', () => {
  it('verifies metadata before decoding UTF-8 content', () => {
    expect(decodeArtifactText(artifact, {
      contentBase64: 'aGVsbG8=',
      contentHash: artifact.contentHash,
      sizeBytes: 5,
      recoveredFromTrash: false,
    }, 'mismatch')).toBe('hello')
    expect(() => decodeArtifactText(artifact, {
      contentBase64: 'aGVsbG8=',
      contentHash: 'b'.repeat(64),
      sizeBytes: 5,
      recoveredFromTrash: false,
    }, 'mismatch')).toThrow('mismatch')
  })

  it('formats JSON and byte sizes deterministically', () => {
    expect(formatJsonArtifact('{"nested":{"ok":true}}')).toBe(`{\n  "nested": {\n    "ok": true\n  }\n}`)
    expect(formatArtifactBytes(512)).toBe('512 B')
    expect(formatArtifactBytes(2048)).toBe('2.0 KiB')
  })
})
