import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ArtifactReference } from '@/agent/core/types'
import {
  ArtifactPreview,
  decodeArtifactText,
  formatArtifactBytes,
  formatJsonArtifact,
} from './ArtifactPreview'

const baseArtifact = (overrides: Partial<ArtifactReference> = {}): ArtifactReference => ({
  id: 'a1',
  kind: 'text',
  mediaType: 'text/plain',
  relativePath: 'output.txt',
  contentHash: 'a'.repeat(64),
  sizeBytes: 1024,
  createdAt: 0,
  ...overrides,
})

describe('formatArtifactBytes', () => {
  it('formats below 1 KiB as bytes', () => {
    expect(formatArtifactBytes(512)).toBe('512 B')
  })

  it('formats 1 KiB – 1 MiB as KiB', () => {
    expect(formatArtifactBytes(1024 * 5)).toBe('5.0 KiB')
  })

  it('formats above 1 MiB as MiB', () => {
    expect(formatArtifactBytes(1024 * 1024 * 2)).toBe('2.0 MiB')
  })

  it('returns "0 B" for zero bytes', () => {
    expect(formatArtifactBytes(0)).toBe('0 B')
  })
})

describe('decodeArtifactText', () => {
  it('decodes a valid base64 UTF-8 string', () => {
    const text = 'hello Axiom'
    const base64 = Buffer.from(text, 'utf-8').toString('base64')
    const artifact: ArtifactReference = {
      ...baseArtifact(),
      contentHash: 'b'.repeat(64),
      sizeBytes: Buffer.byteLength(text, 'utf-8'),
    }
    const content = {
      contentBase64: base64,
      contentHash: 'b'.repeat(64),
      sizeBytes: Buffer.byteLength(text, 'utf-8'),
    }
    expect(decodeArtifactText(artifact, content, 'mismatch')).toBe(text)
  })

  it('throws when the content hash differs from the artifact reference', () => {
    expect(() => decodeArtifactText(
      baseArtifact({ contentHash: 'a'.repeat(64), sizeBytes: 5 }),
      { contentBase64: 'aGVsbG8=', contentHash: 'b'.repeat(64), sizeBytes: 5 },
      'mismatch',
    )).toThrow('mismatch')
  })

  it('throws when the sizeBytes differ', () => {
    expect(() => decodeArtifactText(
      baseArtifact({ contentHash: 'a'.repeat(64), sizeBytes: 10 }),
      { contentBase64: 'aGVsbG8=', contentHash: 'a'.repeat(64), sizeBytes: 5 },
      'mismatch',
    )).toThrow('mismatch')
  })
})

describe('formatJsonArtifact', () => {
  it('pretty-prints a JSON string with 2-space indent', () => {
    expect(formatJsonArtifact('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
  })
})

describe('ArtifactPreview SSR', () => {
  it('renders the text artifact summary with kind label and SHA-256 prefix', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      artifact: baseArtifact({ kind: 'text', sizeBytes: 2048, contentHash: 'a'.repeat(64) }),
    }))
    expect(html).toContain('文本 Artifact')
    expect(html).toContain('2.0 KiB')
    expect(html).toContain('SHA-256')
    expect(html).toContain('校验并查看完整内容')
  })

  it('renders the JSON artifact label', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      artifact: baseArtifact({ kind: 'json' }),
    }))
    expect(html).toContain('JSON Artifact')
  })

  it('renders the image artifact label', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      artifact: baseArtifact({ kind: 'image', mediaType: 'image/png' }),
    }))
    expect(html).toContain('图片 Artifact')
  })

  it('uses the artifact-preview CSS class and aria-label', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      artifact: baseArtifact(),
    }))
    expect(html).toContain('artifact-preview')
    expect(html).toContain('aria-label="完整工具结果 Artifact"')
  })
})