import type { ArtifactReference } from '@/agent/core/types'
import { readArtifact, type ArtifactContent } from '@/platform/artifacts'
import { useState } from 'react'
import { useT } from '@/i18n'

const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const formatArtifactBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export const decodeArtifactText = (
  artifact: ArtifactReference,
  content: ArtifactContent,
  mismatchMessage: string,
): string => {
  if (content.contentHash !== artifact.contentHash || content.sizeBytes !== artifact.sizeBytes) {
    throw new Error(mismatchMessage)
  }
  const binary = atob(content.contentBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export const formatJsonArtifact = (value: string): string =>
  JSON.stringify(JSON.parse(value) as unknown, null, 2)

export const ArtifactPreview = ({ artifact }: { artifact: ArtifactReference }) => {
  const { t } = useT()
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const loaded = await readArtifact(artifact)
      if (loaded.contentHash !== artifact.contentHash || loaded.sizeBytes !== artifact.sizeBytes) {
        throw new Error(t('app.artifact.metadataMismatch'))
      }
      setContent(loaded)
      if (artifact.kind === 'text' || artifact.kind === 'json') {
        const decoded = decodeArtifactText(artifact, loaded, t('app.artifact.metadataMismatch'))
        setText(artifact.kind === 'json' ? formatJsonArtifact(decoded) : decoded)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setError(t('app.artifact.copyFailed'))
    }
  }

  const imageSupported = artifact.kind === 'image' && SAFE_IMAGE_TYPES.has(artifact.mediaType)

  return (
    <section aria-label={t('app.artifact.aria')} className="artifact-preview">
      <div className="artifact-summary">
        <div>
          <strong>{artifact.kind === 'json' ? t('app.artifact.kind.json') : artifact.kind === 'image' ? t('app.artifact.kind.image') : t('app.artifact.kind.text')} Artifact</strong>
          <span>{formatArtifactBytes(artifact.sizeBytes)} · SHA-256 {artifact.contentHash.slice(0, 12)}…</span>
        </div>
        {!content && !error && (
          <button disabled={loading} onClick={() => void load()} type="button">
            {loading ? t('app.artifact.verify') : t('app.artifact.viewFull')}
          </button>
        )}
        {error && <button onClick={() => void load()} type="button">{t('app.artifact.retry')}</button>}
      </div>
      {content?.recoveredFromTrash && (
        <p className="artifact-recovery" role="status">{t('app.artifact.recovered')}</p>
      )}
      {error && <p className="artifact-error" role="alert">{error}</p>}
      {text !== null && (
        <div className="artifact-text">
          <button onClick={() => void copy()} type="button">{copied ? t('app.artifact.copied') : t('app.artifact.copyFull')}</button>
          <pre>{text}</pre>
        </div>
      )}
      {content && imageSupported && (
        <img
          alt={t('app.artifact.imageAlt')}
          src={`data:${artifact.mediaType};base64,${content.contentBase64}`}
        />
      )}
      {content && artifact.kind === 'image' && !imageSupported && (
        <p className="artifact-error" role="alert">{t('app.artifact.imageUnsupported')}</p>
      )}
    </section>
  )
}
